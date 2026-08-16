import type { Direction, MarketDuration, OrderBookLevel } from '../../shared/types'

const GAMMA_API = 'https://gamma-api.polymarket.com'
const CLOB_API = 'https://clob.polymarket.com'
const POLYMARKET_WEB = 'https://polymarket.com'
const CLOB_MARKET_STREAM = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'

interface GammaMarket {
  active?: boolean
  closed?: boolean
  acceptingOrders?: boolean
  outcomes?: string | string[]
  clobTokenIds?: string | string[]
  feesEnabled?: boolean
  feeSchedule?: { rate?: number }
}

interface GammaEvent {
  markets?: GammaMarket[]
}

interface ClobBook {
  timestamp?: string
  min_order_size?: string
  asks?: Array<{ price: string; size: string }>
}

interface FeeRateResponse {
  base_fee?: number
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

export interface PolymarketOutcomeQuote {
  direction: Direction
  tokenId: string
  bestAsk: string
  askSize: string
  levels: OrderBookLevel[]
  receivedAt: number
  feeRate: string
  minOrderSize: string
}

export interface PolymarketWindowQuote {
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

function parseStringArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms)
}

function eventTimestamp(value: string | number | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now()
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
  const receivedAt = eventTimestamp(event.timestamp)
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
      const bestAsk = update.best_ask || levels[0]?.price || current.bestAsk
      const bestLevel = levels.find((level) => level.price === bestAsk) ?? levels[0]
      outcomes[direction] = {
        ...current,
        bestAsk,
        askSize: bestLevel?.size ?? current.askSize,
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
  private lastError = '尚未连接 Polymarket 公共 API'
  private proxyUrl = ''
  private proxyAgent?: import('undici').ProxyAgent
  private marketSocket?: InstanceType<typeof import('undici').WebSocket>
  private socketAssets = ''
  private socketHeartbeat?: NodeJS.Timeout
  private socketReconnect?: NodeJS.Timeout
  private latestWindows: PolymarketWindowQuote[] = []
  private listeners = new Set<() => void>()

  constructor(private readonly options: { enableStreaming?: boolean } = {}) {}

  onMarketData(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getLatestWindows(): PolymarketWindowQuote[] {
    return this.latestWindows
  }

  configureProxy(proxyUrl: string): void {
    const normalized = proxyUrl.trim()
    if (normalized === this.proxyUrl) return
    const previous = this.proxyAgent
    this.proxyAgent = undefined
    this.proxyUrl = normalized
    this.closeMarketStream()
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
    try {
      const results = await Promise.all(windows.map((window) => this.fetchWindow(window)))
      this.latestWindows = results
      void this.ensureMarketStream(results.flatMap((window) => Object.values(window.outcomes).map((outcome) => outcome!.tokenId)))
      this.connected = true
      this.lastError = `公共盘口已连接，正在建立实时流；REST更新 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
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
      const socket = new WebSocket(CLOB_MARKET_STREAM, this.proxyAgent ? { dispatcher: this.proxyAgent } : undefined)
      this.marketSocket = socket
      socket.addEventListener('open', () => {
        if (this.marketSocket !== socket) return
        socket.send(JSON.stringify({ assets_ids: normalized, type: 'market', custom_feature_enabled: true }))
        this.connected = true
        this.lastError = `CLOB实时盘口流已连接（${normalized.length}个 outcome）`
        this.socketHeartbeat = setInterval(() => {
          if (socket.readyState === socket.OPEN) socket.send('PING')
        }, 10_000)
        this.socketHeartbeat.unref()
      })
      socket.addEventListener('message', (message) => {
        const raw = String(message.data)
        if (raw === 'PONG') return
        try {
          const parsed = JSON.parse(raw) as MarketStreamEvent | MarketStreamEvent[]
          let changed = false
          for (const event of Array.isArray(parsed) ? parsed : [parsed]) {
            const next = applyPolymarketStreamEvent(this.latestWindows, event)
            changed ||= next !== this.latestWindows
            this.latestWindows = next
          }
          if (!changed) return
          this.lastError = `CLOB实时盘口流已连接，最近推送 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
          this.emitMarketData()
        } catch {
          // Ignore non-JSON service messages; the REST fallback remains active.
        }
      })
      socket.addEventListener('close', () => {
        if (this.marketSocket !== socket) return
        this.marketSocket = undefined
        if (this.socketHeartbeat) clearInterval(this.socketHeartbeat)
        this.socketHeartbeat = undefined
        this.lastError = 'CLOB实时流已断开，使用REST兜底并准备重连'
        this.scheduleReconnect(key)
      })
      socket.addEventListener('error', () => {
        if (this.marketSocket === socket) this.lastError = 'CLOB实时流连接异常，REST兜底仍可用'
      })
    } catch (error) {
      this.lastError = `CLOB实时流建立失败，使用REST兜底：${error instanceof Error ? error.message : String(error)}`
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
    if (socket && socket.readyState < socket.CLOSING) socket.close()
    if (clearAssets) this.socketAssets = ''
  }

  private async fetchWindow(window: { durationMinutes: 5 | 15; startTime: number; endTime: number }): Promise<PolymarketWindowQuote> {
    const startSeconds = Math.floor(window.startTime / 1_000)
    const slug = `btc-updown-${window.durationMinutes}m-${startSeconds}`
    const event = await this.fetchJson<GammaEvent>(`${GAMMA_API}/events/slug/${slug}`)
    const market = event.markets?.find((candidate) => candidate.active !== false && candidate.closed !== true)
      ?? event.markets?.[0]
    if (!market) throw new Error(`${slug} 未返回市场`)

    const outcomes = parseStringArray(market.outcomes)
    const tokenIds = parseStringArray(market.clobTokenIds)
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

    const feeRate = market.feeSchedule?.rate ?? (market.feesEnabled === false ? 0 : 0.07)
    const [up, down, reference] = await Promise.all([
      this.fetchOutcome('UP', upToken, feeRate),
      this.fetchOutcome('DOWN', downToken, feeRate),
      this.fetchReference(window).catch(() => undefined)
    ])
    return {
      durationMinutes: window.durationMinutes,
      startTime: window.startTime,
      endTime: window.endTime,
      baselinePrice: reference?.baselinePrice,
      indexPrice: reference?.indexPrice,
      indexReceivedAt: reference?.indexReceivedAt,
      outcomes: {
        ...(up ? { UP: up } : {}),
        ...(down ? { DOWN: down } : {})
      }
    }
  }

  private async fetchOutcome(direction: Direction, tokenId: string, feeRate: number): Promise<PolymarketOutcomeQuote | undefined> {
    const [book, liveFeeRate] = await Promise.all([
      this.fetchJson<ClobBook>(`${CLOB_API}/book?token_id=${encodeURIComponent(tokenId)}`),
      this.fetchJson<FeeRateResponse>(`${CLOB_API}/fee-rate?token_id=${encodeURIComponent(tokenId)}`)
        .then((response) => Number(response.base_fee) / 10_000)
        .catch(() => feeRate)
    ])
    const levels = (book.asks ?? [])
      .map((level) => ({ price: String(level.price), size: String(level.size) }))
      .filter((level) => Number(level.price) > 0 && Number(level.size) > 0)
      .sort((left, right) => Number(left.price) - Number(right.price))
    const best = levels[0]
    if (!best) return undefined
    const apiTimestamp = Number(book.timestamp)
    return {
      direction,
      tokenId,
      bestAsk: best.price,
      askSize: best.size,
      levels,
      receivedAt: Number.isFinite(apiTimestamp) && apiTimestamp > 0 ? apiTimestamp : Date.now(),
      feeRate: Number.isFinite(liveFeeRate) && liveFeeRate >= 0 ? String(liveFeeRate) : '0.07',
      minOrderSize: String(book.min_order_size || '1')
    }
  }

  private async fetchReference(window: { durationMinutes: 5 | 15; startTime: number; endTime: number }): Promise<{
    baselinePrice?: string
    indexPrice?: string
    indexReceivedAt?: number
  }> {
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
    const [price, history] = await Promise.all([
      this.fetchJson<CryptoPriceResponse>(`${POLYMARKET_WEB}/api/crypto/crypto-price?${query}`),
      this.fetchJson<CryptoPricePoint[]>(`${POLYMARKET_WEB}/api/crypto/price-history?${historyQuery}`)
    ])
    const latest = (Array.isArray(history) ? history : [])
      .filter((point) => Number(point.value) > 0 && Number(point.timestamp) > 0)
      .sort((left, right) => Number(right.timestamp) - Number(left.timestamp))[0]
    const current = Number(price.closePrice) > 0
      ? { value: Number(price.closePrice), timestamp: Number(price.timestamp) }
      : latest
    return {
      baselinePrice: Number(price.openPrice) > 0 ? String(price.openPrice) : undefined,
      indexPrice: Number(current?.value) > 0 ? String(current?.value) : undefined,
      indexReceivedAt: Number(current?.timestamp) > 0 ? Number(current?.timestamp) : undefined
    }
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
