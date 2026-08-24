import type { Direction, MarketDuration, OrderBookLevel } from '../../shared/types'

const GAMMA_API = 'https://gamma-api.polymarket.com'
const CLOB_API = 'https://clob.polymarket.com'
const POLYMARKET_WEB = 'https://polymarket.com'
const CLOB_MARKET_STREAM = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'
const POLYMARKET_RTDS_STREAM = 'wss://ws-live-data.polymarket.com'
const RTDS_TWAP_STALE_MS = 15_000
const REFERENCE_REST_FALLBACK_MS = 15_000

interface WebSocketLike {
  readonly readyState: number
  readonly OPEN: number
  readonly CLOSING: number
  send(data: string): void
  close(): void
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void
}

interface PolymarketMarketDataOptions {
  enableStreaming?: boolean
  webSocketFactory?: (url: string, options?: { dispatcher?: import('undici').ProxyAgent }) => WebSocketLike
  referenceRestFallbackMs?: number
}

interface GammaMarket {
  id?: string | number
  slug?: string
  conditionId?: string
  condition_id?: string
  active?: boolean
  closed?: boolean
  acceptingOrders?: boolean
  outcomes?: unknown
  clobTokenIds?: unknown
  clob_token_ids?: unknown
  tokenIds?: unknown
  tokens?: unknown
}

interface GammaEvent {
  markets?: GammaMarket[]
}

interface ClobBook {
  timestamp?: string
  min_order_size?: string
  asks?: Array<{ price: string; size: string }>
}

interface ClobMarketDetails {
  fd?: {
    r?: number
    e?: number
    to?: boolean
  }
}

interface CryptoPriceResponse {
  openPrice?: number
  closePrice?: number | null
  timestamp?: number
}

interface CryptoPricePoint {
  timestamp?: number
  value?: number
}

interface PolymarketTwapStreamEvent {
  topic?: string
  type?: string
  payload?: {
    symbol?: string
    value?: string | number
    full_accuracy_value?: string
    timestamp?: string | number
    window_s?: number
    windowSeconds?: number
  }
}

export interface PolymarketTwapQuote {
  value: string
  observedAt: number
  receivedAt: number
  windowSeconds: 60
}

export interface PolymarketOutcomeQuote {
  direction: Direction
  tokenId: string
  bestAsk: string
  askSize: string
  levels: OrderBookLevel[]
  receivedAt: number
  feeRate: string
  feeExponent: string
  minOrderSize: string
}

export interface PolymarketWindowQuote {
  conditionId?: string
  durationMinutes: MarketDuration
  startTime: number
  endTime: number
  baselinePrice?: string
  indexPrice?: string
  indexReceivedAt?: number
  outcomes: Partial<Record<Direction, PolymarketOutcomeQuote>>
}

interface MarketStreamEvent {
  event_type?: string
  asset_id?: string
  timestamp?: string | number
  min_order_size?: string
  asks?: Array<{ price?: string; size?: string }>
  best_ask?: string
  price_changes?: Array<{
    asset_id?: string
    price?: string
    size?: string
    side?: string
    best_ask?: string
  }>
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (!value) return []
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map((item) => {
      if (typeof item === 'string' || typeof item === 'number') return String(item)
      if (item && typeof item === 'object') {
        const candidate = item as Record<string, unknown>
        return String(candidate.tokenId ?? candidate.token_id ?? candidate.id ?? '')
      }
      return ''
    }).filter(Boolean) : []
  } catch {
    return []
  }
}

function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms)
}

function normalizeSourceTimestamp(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || !value || value <= 0) return undefined
  return value < 10_000_000_000 ? value * 1_000 : value
}

function formatE18(value: string | undefined): string | undefined {
  if (!value || !/^-?\d+$/.test(value)) return undefined
  const parsed = BigInt(value)
  const negative = parsed < 0n
  const absolute = negative ? -parsed : parsed
  const whole = absolute / 10n ** 18n
  const fraction = (absolute % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

export function parsePolymarketTwapEvent(raw: string, receivedAt = Date.now()): PolymarketTwapQuote | undefined {
  if (raw === 'PONG') return undefined
  let event: PolymarketTwapStreamEvent
  try {
    event = JSON.parse(raw) as PolymarketTwapStreamEvent
  } catch {
    return undefined
  }
  const payload = event.payload
  const windowSeconds = Number(payload?.window_s ?? payload?.windowSeconds)
  if (event.type !== 'update' || windowSeconds !== 60 || payload?.symbol?.toLowerCase() !== 'btc/usd') return undefined
  const value = formatE18(payload.full_accuracy_value) ?? String(payload.value ?? '')
  const observedAt = normalizeSourceTimestamp(Number(payload.timestamp))
  if (!(Number(value) > 0) || !observedAt) return undefined
  return { value, observedAt, receivedAt, windowSeconds: 60 }
}

export function applyPolymarketStreamEvent(
  windows: PolymarketWindowQuote[],
  event: MarketStreamEvent
): PolymarketWindowQuote[] {
  if (event.event_type !== 'book' && event.event_type !== 'price_change') return windows
  const updates = event.event_type === 'price_change'
    ? event.price_changes ?? []
    : event.asset_id ? [{
        asset_id: event.asset_id,
        best_ask: event.best_ask,
        price: undefined,
        size: undefined,
        side: undefined
      }] : []
  if (updates.length === 0) return windows

  let changed = false
  const receivedAt = Date.now()
  const next = windows.map((window) => {
    let windowChanged = false
    const outcomes = { ...window.outcomes }
    for (const direction of ['UP', 'DOWN'] as const) {
      const current = outcomes[direction]
      if (!current) continue
      const update = updates.find((candidate) => candidate.asset_id === current.tokenId)
      if (!update) continue
      let levels = current.levels
      if (event.event_type === 'book' && event.asset_id === current.tokenId) {
        levels = (event.asks ?? [])
          .map((level) => ({ price: String(level.price ?? ''), size: String(level.size ?? '') }))
          .filter((level) => Number(level.price) > 0 && Number(level.size) > 0)
          .sort((left, right) => Number(left.price) - Number(right.price))
      } else if (event.event_type === 'price_change' && update.side?.toUpperCase() === 'SELL' && update.price) {
        const byPrice = new Map(levels.map((level) => [level.price, level]))
        if (Number(update.size) > 0) byPrice.set(update.price, { price: update.price, size: String(update.size) })
        else byPrice.delete(update.price)
        levels = [...byPrice.values()].sort((left, right) => Number(left.price) - Number(right.price))
      }
      const eventBestAsk = Number(update.best_ask) > 0 ? update.best_ask : undefined
      // 定盘/流动性撤走时，流推送的空盘本身就是权威状态：旧最优价只留作
      // 展示参考，挂单量必须归零。否则幽灵价会带着旧数量一直显得"新鲜"。
      const asksCleared = levels.length === 0 && (
        event.event_type === 'book' ||
        update.side?.toUpperCase() === 'SELL'
      )
      const bestAsk = eventBestAsk ?? levels[0]?.price ?? current.bestAsk
      const bestLevel = levels.find((level) => level.price === bestAsk) ?? levels[0]
      outcomes[direction] = {
        ...current,
        bestAsk,
        askSize: bestLevel?.size ?? (asksCleared ? '0' : current.askSize),
        levels,
        receivedAt,
        minOrderSize: event.min_order_size || current.minOrderSize
      }
      windowChanged = true
      changed = true
    }
    return windowChanged ? { ...window, outcomes } : window
  })
  return changed ? next : windows
}

export class PolymarketMarketData {
  private connected = false
  private monitoringEnabled = true
  private lastError = '尚未连接 Polymarket 公共 API'
  private proxyUrl = ''
  private proxyAgent?: import('undici').ProxyAgent
  private marketSocket?: WebSocketLike
  private marketStreamConnected = false
  private socketAssets = ''
  private socketHeartbeat?: NodeJS.Timeout
  private socketReconnect?: NodeJS.Timeout
  private twapSocket?: WebSocketLike
  private twapStreamConnected = false
  private twapHeartbeat?: NodeJS.Timeout
  private twapReconnect?: NodeJS.Timeout
  private twapReconnectAttempt = 0
  private latestTwap?: PolymarketTwapQuote
  private discoveryDetail = ''
  private referenceCache = new Map<string, {
    baselinePrice?: string
    indexPrice?: string
    indexReceivedAt?: number
    lastRestAttemptAt: number
  }>()
  private latestWindows: PolymarketWindowQuote[] = []
  // Remember the resolved Polymarket slot for the lifetime of the matching
  // MEXC window. This prevents repeating a known 404 exact slug every refresh.
  private slugStartCache = new Map<string, number>()
  private listeners = new Set<() => void>()

  constructor(private readonly options: PolymarketMarketDataOptions = {}) {}

  onMarketData(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getLatestWindows(): PolymarketWindowQuote[] {
    return this.latestWindows
  }

  setMonitoringEnabled(enabled: boolean): void {
    if (this.monitoringEnabled === enabled) return
    this.monitoringEnabled = enabled
    if (!enabled) {
      this.closeMarketStream()
      this.closeTwapStream()
      this.latestWindows = []
      this.connected = false
      this.lastError = 'Polymarket 监控已暂停，不会主动请求市场数据'
      this.emitMarketData()
    }
  }

  async confirmOutcomeQuote(tokenId: string, maximumAgeMs = 500): Promise<void> {
    if (!this.monitoringEnabled) throw new Error('Polymarket监控已暂停，不能复核盘口')
    let matchedDirection: Direction | undefined
    let current: PolymarketOutcomeQuote | undefined
    for (const window of this.latestWindows) {
      for (const [direction, outcome] of Object.entries(window.outcomes) as Array<[Direction, PolymarketOutcomeQuote | undefined]>) {
        if (outcome?.tokenId !== tokenId) continue
        matchedDirection = direction
        current = outcome
        break
      }
      if (current) break
    }
    if (!current || !matchedDirection) throw new Error('Polymarket所选盘口已失效')
    if (Date.now() - current.receivedAt <= maximumAgeMs) return

    const refreshed = await this.fetchOutcome(matchedDirection, tokenId, {
      rate: Number(current.feeRate),
      exponent: Number(current.feeExponent)
    })
    if (!refreshed) throw new Error('Polymarket所选盘口当前没有可买卖价')
    this.latestWindows = this.latestWindows.map((window) => ({
      ...window,
      outcomes: Object.fromEntries(Object.entries(window.outcomes).map(([direction, outcome]) => [
        direction,
        outcome?.tokenId === tokenId ? refreshed : outcome
      ])) as Partial<Record<Direction, PolymarketOutcomeQuote>>
    }))
    this.emitMarketData()
  }

  configureProxy(proxyUrl: string): void {
    const normalized = proxyUrl.trim()
    if (normalized === this.proxyUrl) return
    const previous = this.proxyAgent
    this.proxyAgent = undefined
    this.proxyUrl = normalized
    this.closeMarketStream()
    this.closeTwapStream()
    if (previous) void previous.close().catch(() => undefined)
  }

  getStatus(): { connected: boolean; message: string } {
    return { connected: this.connected, message: this.lastError }
  }

  async testConnection(): Promise<{ connected: boolean; message: string }> {
    try {
      await Promise.all([
        this.fetchJson<unknown>(`${GAMMA_API}/markets?limit=1&active=true&closed=false`),
        this.fetchJson<unknown>(`${CLOB_API}/time`)
      ])
      this.connected = true
      this.lastError = `Gamma与CLOB公共接口均已连接，测试时间 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
      return this.getStatus()
    } catch (error) {
      this.connected = false
      this.lastError = `公共 API 测试失败：${error instanceof Error ? error.message : String(error)}`
      throw new Error(this.lastError)
    }
  }

  async fetchWindows(windows: Array<{ durationMinutes: 5 | 15; startTime: number; endTime: number }>): Promise<PolymarketWindowQuote[]> {
    if (!this.monitoringEnabled) return []
    try {
      this.pruneReferenceCache(windows)
      // A missing/expired slot must not hide the other duration.  In
      // particular, MEXC's 15m event can start on a 5m boundary while
      // Polymarket's rolling 15m slug is aligned to a 15m boundary. Keep the
      // requests bounded inside fetchWindow and retain
      // every successful market from this refresh.
      const settled = await Promise.allSettled(windows.map((window) => this.fetchWindow(window)))
      const results = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
      if (results.length === 0) {
        const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        throw failure?.reason instanceof Error ? failure.reason : new Error('没有发现可用 Polymarket 市场')
      }
      this.latestWindows = results
      void this.ensureMarketStream(results.flatMap((window) => Object.values(window.outcomes).map((outcome) => outcome!.tokenId)))
      void this.ensureTwapStream()
      this.connected = true
      const failedCount = settled.length - results.length
      const failures = settled.flatMap((result, index) => result.status === 'rejected'
        ? [`${windows[index].durationMinutes}m: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
        : [])
      this.discoveryDetail = failedCount ? `${failedCount}个槽位暂未匹配（${failures.join('；')}）` : ''
      this.updateStreamingStatus(`REST市场发现 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`)
      return results
    } catch (error) {
      this.connected = false
      this.lastError = `公共 API 不可用：${error instanceof Error ? error.message : String(error)}`
      throw error
    }
  }

  private emitMarketData(): void {
    for (const listener of this.listeners) listener()
  }

  private referenceKey(window: { durationMinutes: number; startTime: number; endTime: number }): string {
    return `${window.durationMinutes}:${window.startTime}:${window.endTime}`
  }

  private pruneReferenceCache(windows: Array<{ durationMinutes: 5 | 15; startTime: number; endTime: number }>): void {
    const active = new Set(windows.map((window) => this.referenceKey(window)))
    const activeSlotKeys = new Set(active)
    // A fallback market has its own resolved start/end key. Retain that
    // reference entry too, otherwise every refresh would redo the same REST
    // reference lookup even though the slot resolution itself is cached.
    for (const window of windows) {
      const resolvedStart = this.slugStartCache.get(this.referenceKey(window))
      if (resolvedStart === undefined || resolvedStart * 1_000 === window.startTime) continue
      active.add(this.referenceKey({
        durationMinutes: window.durationMinutes,
        startTime: resolvedStart * 1_000,
        endTime: (resolvedStart + window.durationMinutes * 60) * 1_000
      }))
    }
    for (const key of this.referenceCache.keys()) if (!active.has(key)) this.referenceCache.delete(key)
    for (const key of this.slugStartCache.keys()) if (!activeSlotKeys.has(key)) this.slugStartCache.delete(key)
  }

  private updateStreamingStatus(detail?: string): void {
    const clob = this.marketStreamConnected ? 'CLOB实时盘口在线' : 'CLOB使用REST兜底'
    const twap = this.twapStreamConnected ? 'Chainlink 60秒TWAP实时流在线' : 'TWAP使用15秒REST兜底'
    this.lastError = `${clob}；${twap}${detail ? `；${detail}` : ''}${this.discoveryDetail ? `；${this.discoveryDetail}` : ''}`
  }

  private async ensureMarketStream(assetIds: string[]): Promise<void> {
    if (this.options.enableStreaming === false || assetIds.length === 0) return
    const normalized = [...new Set(assetIds)].sort()
    const key = normalized.join(',')
    if (this.socketAssets === key && this.marketSocket && this.marketSocket.readyState <= 1) return
    this.closeMarketStream(false)
    this.socketAssets = key
    try {
      const { WebSocket } = await import('undici')
      if (this.socketAssets !== key) return
      this.proxyAgent ??= this.proxyUrl ? new (await import('undici')).ProxyAgent(this.proxyUrl) : undefined
      const createSocket = this.options.webSocketFactory ?? ((url, options) => new WebSocket(url, options) as unknown as WebSocketLike)
      const socket = createSocket(CLOB_MARKET_STREAM, this.proxyAgent ? { dispatcher: this.proxyAgent } : undefined)
      this.marketSocket = socket
      socket.addEventListener('open', () => {
        if (this.marketSocket !== socket) return
        socket.send(JSON.stringify({ assets_ids: normalized, type: 'market', custom_feature_enabled: true }))
        this.connected = true
        this.marketStreamConnected = true
        this.updateStreamingStatus(`${normalized.length}个 outcome`)
        this.socketHeartbeat = setInterval(() => {
          if (socket.readyState === socket.OPEN) socket.send('PING')
        }, 5_000)
        this.socketHeartbeat.unref()
      })
      socket.addEventListener('message', (message) => {
        const raw = String(message.data)
        if (raw === 'PONG') {
          const receivedAt = Date.now()
          this.latestWindows = this.latestWindows.map((window) => ({
            ...window,
            outcomes: Object.fromEntries(Object.entries(window.outcomes).map(([direction, outcome]) => [
              direction,
              outcome ? { ...outcome, receivedAt } : outcome
            ])) as Partial<Record<Direction, PolymarketOutcomeQuote>>
          }))
          this.updateStreamingStatus('CLOB心跳正常')
          this.emitMarketData()
          return
        }
        try {
          const parsed = JSON.parse(raw) as MarketStreamEvent | MarketStreamEvent[]
          let changed = false
          for (const event of Array.isArray(parsed) ? parsed : [parsed]) {
            const next = applyPolymarketStreamEvent(this.latestWindows, event)
            changed ||= next !== this.latestWindows
            this.latestWindows = next
          }
          if (!changed) return
          this.updateStreamingStatus(`CLOB最近推送 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`)
          this.emitMarketData()
        } catch {
          // Ignore non-JSON service messages; the REST fallback remains active.
        }
      })
      socket.addEventListener('close', () => {
        if (this.marketSocket !== socket) return
        this.marketSocket = undefined
        this.marketStreamConnected = false
        if (this.socketHeartbeat) clearInterval(this.socketHeartbeat)
        this.socketHeartbeat = undefined
        this.updateStreamingStatus('CLOB已断开，准备重连')
        this.scheduleReconnect(key)
      })
      socket.addEventListener('error', () => {
        if (this.marketSocket === socket) this.updateStreamingStatus('CLOB连接异常')
      })
    } catch (error) {
      this.marketStreamConnected = false
      this.updateStreamingStatus(`CLOB建立失败：${error instanceof Error ? error.message : String(error)}`)
      this.scheduleReconnect(key)
    }
  }

  private scheduleReconnect(key: string): void {
    if (this.options.enableStreaming === false || this.socketAssets !== key || this.socketReconnect) return
    this.socketReconnect = setTimeout(() => {
      this.socketReconnect = undefined
      if (this.socketAssets === key) void this.ensureMarketStream(key.split(','))
    }, 1_500)
    this.socketReconnect.unref()
  }

  private closeMarketStream(clearAssets = true): void {
    if (this.socketHeartbeat) clearInterval(this.socketHeartbeat)
    if (this.socketReconnect) clearTimeout(this.socketReconnect)
    this.socketHeartbeat = undefined
    this.socketReconnect = undefined
    const socket = this.marketSocket
    this.marketSocket = undefined
    this.marketStreamConnected = false
    if (socket && socket.readyState < socket.CLOSING) socket.close()
    if (clearAssets) this.socketAssets = ''
  }

  private async ensureTwapStream(): Promise<void> {
    if (this.options.enableStreaming === false || (this.twapSocket && this.twapSocket.readyState <= 1)) return
    try {
      const { WebSocket } = await import('undici')
      if (this.twapSocket && this.twapSocket.readyState <= 1) return
      this.proxyAgent ??= this.proxyUrl ? new (await import('undici')).ProxyAgent(this.proxyUrl) : undefined
      const createSocket = this.options.webSocketFactory ?? ((url, options) => new WebSocket(url, options) as unknown as WebSocketLike)
      const socket = createSocket(POLYMARKET_RTDS_STREAM, this.proxyAgent ? { dispatcher: this.proxyAgent } : undefined)
      this.twapSocket = socket
      socket.addEventListener('open', () => {
        if (this.twapSocket !== socket) return
        socket.send(JSON.stringify({
          action: 'subscribe',
          subscriptions: [{
            topic: 'crypto_prices_twap_sixty',
            type: 'update',
            filters: '{"symbol":"btc/usd"}'
          }]
        }))
        this.twapStreamConnected = true
        this.twapReconnectAttempt = 0
        this.updateStreamingStatus('RTDS订阅 BTC/USD 60秒TWAP')
        this.twapHeartbeat = setInterval(() => {
          if (socket.readyState === socket.OPEN) socket.send('PING')
        }, 5_000)
        this.twapHeartbeat.unref()
      })
      socket.addEventListener('message', (message) => {
        if (this.twapSocket !== socket) return
        const quote = parsePolymarketTwapEvent(String(message.data ?? ''))
        if (!quote || (this.latestTwap && quote.observedAt < this.latestTwap.observedAt)) return
        this.latestTwap = quote
        this.latestWindows = this.latestWindows.map((window) => {
          const key = this.referenceKey(window)
          const cached = this.referenceCache.get(key)
          if (cached) this.referenceCache.set(key, {
            ...cached,
            indexPrice: quote.value,
            indexReceivedAt: quote.observedAt
          })
          return { ...window, indexPrice: quote.value, indexReceivedAt: quote.observedAt }
        })
        this.updateStreamingStatus(`TWAP最近观测 ${new Date(quote.observedAt).toLocaleTimeString('zh-CN', { hour12: false })}`)
        this.emitMarketData()
      })
      socket.addEventListener('close', () => {
        if (this.twapSocket !== socket) return
        this.twapSocket = undefined
        this.twapStreamConnected = false
        if (this.twapHeartbeat) clearInterval(this.twapHeartbeat)
        this.twapHeartbeat = undefined
        this.updateStreamingStatus('RTDS已断开，准备退避重连')
        this.scheduleTwapReconnect()
      })
      socket.addEventListener('error', () => {
        if (this.twapSocket === socket) this.updateStreamingStatus('RTDS连接异常，REST兜底仍启用')
      })
    } catch (error) {
      this.twapStreamConnected = false
      this.updateStreamingStatus(`RTDS建立失败：${error instanceof Error ? error.message : String(error)}`)
      this.scheduleTwapReconnect()
    }
  }

  private scheduleTwapReconnect(): void {
    if (this.options.enableStreaming === false || this.twapReconnect || this.twapSocket) return
    const delay = Math.min(30_000, 1_500 * 2 ** this.twapReconnectAttempt)
    this.twapReconnectAttempt = Math.min(this.twapReconnectAttempt + 1, 5)
    this.twapReconnect = setTimeout(() => {
      this.twapReconnect = undefined
      void this.ensureTwapStream()
    }, delay)
    this.twapReconnect.unref()
  }

  private closeTwapStream(): void {
    if (this.twapHeartbeat) clearInterval(this.twapHeartbeat)
    if (this.twapReconnect) clearTimeout(this.twapReconnect)
    this.twapHeartbeat = undefined
    this.twapReconnect = undefined
    const socket = this.twapSocket
    this.twapSocket = undefined
    this.twapStreamConnected = false
    if (socket && socket.readyState < socket.CLOSING) socket.close()
  }

  private async fetchWindow(window: { durationMinutes: 5 | 15; startTime: number; endTime: number }): Promise<PolymarketWindowQuote> {
    const requestedStartSeconds = Math.floor(window.startTime / 1_000)
    const slotKey = this.referenceKey(window)
    const cachedStart = this.slugStartCache.get(slotKey)
    const now = Date.now()
    const startCandidates: number[] = []
    if (cachedStart !== undefined && cachedStart * 1_000 + window.durationMinutes * 60_000 > now) {
      startCandidates.push(cachedStart)
    }
    if (window.durationMinutes !== 15 || window.endTime > now) startCandidates.push(requestedStartSeconds)
    // Polymarket creates 15m markets on quarter-hour UTC boundaries. MEXC's
    // rolling event feed can expose a different boundary, and a just-created
    // market may be keyed by the current quarter-hour rather than MEXC's
    // start. Keep discovery bounded to the containing and current quarter.
    if (window.durationMinutes === 15) {
      const quarterStart = Math.floor(requestedStartSeconds / 900) * 900
      if (quarterStart * 1_000 + 900_000 > now) startCandidates.push(quarterStart)
      const currentStart = Math.floor(now / 900_000) * 900
      if (currentStart * 1_000 + 900_000 > now) startCandidates.push(currentStart)
    }
    let event: GammaEvent | undefined
    let resolvedStartSeconds = requestedStartSeconds
    let lastError: unknown
    // Hard cap discovery at three slugs per duration (cached/requested,
    // containing quarter-hour, and current quarter-hour).
    for (const candidateStartSeconds of [...new Set(startCandidates)].slice(0, 3)) {
      const slug = `btc-updown-${window.durationMinutes}m-${candidateStartSeconds}`
      try {
        const candidate = await this.fetchJson<GammaEvent>(`${GAMMA_API}/events/slug/${slug}`)
        const available = candidate.markets?.some((market) => market.active !== false && market.closed !== true && market.acceptingOrders !== false)
        if (!candidate.markets?.length || !available) throw new Error(`${slug} 未返回可交易市场`)
        event = candidate
        resolvedStartSeconds = candidateStartSeconds
        this.slugStartCache.set(slotKey, candidateStartSeconds)
        break
      } catch (error) {
        lastError = error
      }
    }
    // Gamma also exposes the child market directly. This is a single,
    // bounded fallback for a 15m event whose parent-event response is empty
    // or temporarily inconsistent; normal refreshes still use one event
    // request per candidate and do not add traffic.
    if (!event && window.durationMinutes === 15) {
      const fallbackStart = [...new Set(startCandidates)].at(-1)
      if (fallbackStart !== undefined) {
        const fallbackSlug = `btc-updown-15m-${fallbackStart}`
        try {
          const market = await this.fetchJson<GammaMarket>(`${GAMMA_API}/markets/slug/${fallbackSlug}`)
          if (market && (market.conditionId || market.condition_id)) {
            event = { markets: [market] }
            resolvedStartSeconds = fallbackStart
            this.slugStartCache.set(slotKey, fallbackStart)
          } else {
            throw new Error(`${fallbackSlug} market-slug 未返回 conditionId`)
          }
        } catch (error) {
          lastError = error
        }
      }
    }
    if (!event) throw lastError instanceof Error ? lastError : new Error('Polymarket 市场发现失败')
    const slug = `btc-updown-${window.durationMinutes}m-${resolvedStartSeconds}`
    const market = event.markets?.find((candidate) => candidate.active !== false && candidate.closed !== true && candidate.acceptingOrders !== false)
    if (!market) throw new Error(`${slug} 未返回可交易市场`)

    const outcomes = parseStringArray(market.outcomes)
    const tokenIds = parseStringArray(market.clobTokenIds ?? market.clob_token_ids ?? market.tokenIds ?? market.tokens)
    if (outcomes.length !== tokenIds.length || outcomes.length < 2) {
      throw new Error(`${slug} 的 outcome token 数据不完整`)
    }
    const tokenByDirection = new Map<Direction, string>()
    outcomes.forEach((outcome, index) => {
      const normalized = outcome.trim().toUpperCase()
      if (normalized === 'UP' || normalized === 'DOWN') tokenByDirection.set(normalized, tokenIds[index])
    })
    const upToken = tokenByDirection.get('UP')
    const downToken = tokenByDirection.get('DOWN')
    if (!upToken || !downToken) throw new Error(`${slug} 没有 UP/DOWN token`)

    const conditionId = market.conditionId ?? market.condition_id
    if (!conditionId) throw new Error(`${slug} 缺少 Polymarket conditionId，无法验证手续费`)
    const feeDetails = await this.fetchJson<ClobMarketDetails>(
      `${CLOB_API}/clob-markets/${encodeURIComponent(conditionId)}`
    )
    const fee = {
      rate: Number(feeDetails.fd?.r ?? 0),
      exponent: Number(feeDetails.fd?.e ?? 0)
    }
    if (!Number.isFinite(fee.rate) || fee.rate < 0 || !Number.isFinite(fee.exponent) || fee.exponent < 0) {
      throw new Error(`${slug} 返回了无效的 Polymarket V2 手续费参数`)
    }
    const resolvedWindow = resolvedStartSeconds === requestedStartSeconds
      ? window
      : {
          durationMinutes: window.durationMinutes,
          startTime: resolvedStartSeconds * 1_000,
          endTime: (resolvedStartSeconds + window.durationMinutes * 60) * 1_000
        }
    const [up, down, reference] = await Promise.all([
      this.fetchOutcome('UP', upToken, fee),
      this.fetchOutcome('DOWN', downToken, fee),
      this.fetchReference(resolvedWindow).catch(() => undefined)
    ])
    return {
      conditionId,
      durationMinutes: window.durationMinutes,
      startTime: resolvedWindow.startTime,
      endTime: resolvedWindow.endTime,
      baselinePrice: reference?.baselinePrice,
      indexPrice: reference?.indexPrice,
      indexReceivedAt: reference?.indexReceivedAt,
      outcomes: {
        ...(up ? { UP: up } : {}),
        ...(down ? { DOWN: down } : {})
      }
    }
  }

  private async fetchOutcome(
    direction: Direction,
    tokenId: string,
    fee: { rate: number; exponent: number }
  ): Promise<PolymarketOutcomeQuote | undefined> {
    const book = await this.fetchJson<ClobBook>(`${CLOB_API}/book?token_id=${encodeURIComponent(tokenId)}`)
    const levels = (book.asks ?? [])
      .map((level) => ({ price: String(level.price), size: String(level.size) }))
      .filter((level) => Number(level.price) > 0 && Number(level.size) > 0)
      .sort((left, right) => Number(left.price) - Number(right.price))
    const best = levels[0]
    if (!best) return undefined
    return {
      direction,
      tokenId,
      bestAsk: best.price,
      askSize: best.size,
      levels,
      receivedAt: Date.now(),
      feeRate: Number.isFinite(fee.rate) && fee.rate >= 0 ? String(fee.rate) : '0.07',
      feeExponent: Number.isFinite(fee.exponent) && fee.exponent >= 0 ? String(fee.exponent) : '1',
      minOrderSize: String(book.min_order_size || '1')
    }
  }

  private async fetchReference(window: { durationMinutes: 5 | 15; startTime: number; endTime: number }): Promise<{
    baselinePrice?: string
    indexPrice?: string
    indexReceivedAt?: number
  }> {
    const now = Date.now()
    const key = this.referenceKey(window)
    const cached = this.referenceCache.get(key)
    const latestTwap = this.latestTwap && now - this.latestTwap.observedAt <= RTDS_TWAP_STALE_MS
      ? this.latestTwap
      : undefined
    if (cached?.baselinePrice && latestTwap) {
      const next = {
        ...cached,
        indexPrice: latestTwap.value,
        indexReceivedAt: latestTwap.observedAt
      }
      this.referenceCache.set(key, next)
      return next
    }
    const fallbackInterval = this.options.referenceRestFallbackMs ?? REFERENCE_REST_FALLBACK_MS
    if (cached && now - cached.lastRestAttemptAt < fallbackInterval) {
      return latestTwap
        ? { ...cached, indexPrice: latestTwap.value, indexReceivedAt: latestTwap.observedAt }
        : cached
    }
    this.referenceCache.set(key, { ...cached, lastRestAttemptAt: now })
    const variant = window.durationMinutes === 5 ? 'fiveminute' : 'fifteenminute'
    const query = new URLSearchParams({
      symbol: 'BTC',
      eventStartTime: new Date(window.startTime).toISOString(),
      variant,
      endDate: new Date(window.endTime).toISOString(),
      twapEnabled: 'true',
      twapLookbackSeconds: '60'
    })
    const historyQuery = new URLSearchParams({
      symbol: 'BTC',
      eventStartTime: new Date(window.startTime).toISOString(),
      variant,
      endDate: new Date(window.endTime).toISOString()
    })
    const price = await this.fetchJson<CryptoPriceResponse>(`${POLYMARKET_WEB}/api/crypto/crypto-price?${query}`)
    let latest: CryptoPricePoint | undefined
    if (!(Number(price.closePrice) > 0)) {
      const history = await this.fetchJson<CryptoPricePoint[]>(`${POLYMARKET_WEB}/api/crypto/price-history?${historyQuery}`)
      latest = (Array.isArray(history) ? history : [])
        .filter((point) => Number(point.value) > 0 && Number(point.timestamp) > 0)
        .sort((left, right) => Number(right.timestamp) - Number(left.timestamp))[0]
    }
    const current = Number(price.closePrice) > 0
      ? { value: Number(price.closePrice), timestamp: Number(price.timestamp) }
      : latest
    const restObservedAt = Number(current?.value) > 0 ? normalizeSourceTimestamp(current?.timestamp) : undefined
    const freshestTwap = this.latestTwap && now - this.latestTwap.observedAt <= RTDS_TWAP_STALE_MS &&
      (!restObservedAt || this.latestTwap.observedAt >= restObservedAt)
      ? this.latestTwap
      : undefined
    const result = {
      baselinePrice: Number(price.openPrice) > 0 ? String(price.openPrice) : cached?.baselinePrice,
      indexPrice: freshestTwap?.value ?? (Number(current?.value) > 0 ? String(current?.value) : cached?.indexPrice),
      indexReceivedAt: freshestTwap?.observedAt ?? restObservedAt ?? cached?.indexReceivedAt,
      lastRestAttemptAt: now
    }
    this.referenceCache.set(key, result)
    return result
  }

  private async fetchJson<T>(url: string): Promise<T> {
    let response: Response
    if (this.proxyUrl) {
      const { ProxyAgent, fetch: proxyFetch } = await import('undici')
      this.proxyAgent ??= new ProxyAgent(this.proxyUrl)
      response = await proxyFetch(url, {
        dispatcher: this.proxyAgent,
        headers: { accept: 'application/json', 'user-agent': 'ArbDesk/0.1' },
        signal: timeoutSignal(6_000)
      }) as unknown as Response
    } else {
      response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'ArbDesk/0.1' },
        signal: timeoutSignal(6_000)
      })
    }
    if (!response.ok) throw new Error(`${new URL(url).hostname} HTTP ${response.status}`)
    return await response.json() as T
  }
}
