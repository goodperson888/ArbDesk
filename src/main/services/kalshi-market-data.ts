import type { Direction, OrderBookLevel } from '../../shared/types'
import type { ReadOnlyOutcomeQuote, ReadOnlyVenueSource, ReadOnlyVenueStatus, ReadOnlyWindowQuote } from '../platforms/read-only-types'
import type { ResolutionFingerprint } from '../platforms/contracts'
import type { KalshiCredentials } from './kalshi-credential-store'
import { kalshiHeaders } from './kalshi-auth'
import WebSocket from 'ws'
import type { KalshiPageCaptureSource } from './kalshi-page-capture'

// The shared production host is the most reliable public market-data route in
// regions where external-api.kalshi.com is filtered. Kalshi documents both
// hosts as equivalent production Trade API endpoints.
const API = 'https://api.elections.kalshi.com/trade-api/v2'
const REFRESH_CACHE_MS = 15_000
const REQUEST_TIMEOUT_MS = 6_000
// Keep the public REST fan-out bounded: query the two known BTC series once,
// then read at most a small rollover set of orderbooks.
const MAX_CANDIDATES = 4
const BTC_SERIES = ['KXBTC15M'] as const
const WS_URL = 'wss://api.elections.kalshi.com/trade-api/ws/v2'

type KalshiStreamState = 'NOT_STARTED' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR' | 'NO_CREDENTIALS'

interface KalshiMarket {
  ticker?: string
  market_ticker?: string
  marketTicker?: string
  event_ticker?: string
  market_type?: string
  marketType?: string
  title?: string
  subtitle?: string
  yes_sub_title?: string
  no_sub_title?: string
  rules_primary?: string
  open_time?: string
  close_time?: string
  openTime?: string
  closeTime?: string
  status?: string
}

interface KalshiMarketsResponse { markets?: KalshiMarket[] }
interface KalshiOrderbookResponse {
  orderbook_fp?: { yes_dollars?: Array<[string, string]>; no_dollars?: Array<[string, string]> }
  orderbook?: { yes_dollars?: Array<[string, string]>; no_dollars?: Array<[string, string]> }
}
interface KalshiMultipleOrderbooksResponse {
  orderbooks?: Array<{ ticker?: string; orderbook_fp?: KalshiOrderbookResponse['orderbook_fp']; orderbook?: KalshiOrderbookResponse['orderbook'] }>
}

interface Candidate {
  market: KalshiMarket
  ticker: string
  yesDirection: Direction
  startTime: number
  endTime: number
  durationMinutes: 5 | 15
}

function timestamp(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Date.parse(String(value ?? ''))
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed < 10_000_000_000 ? Math.round(parsed * 1_000) : Math.round(parsed)
}

function durationFromText(text: string, startTime: number, endTime: number): 5 | 15 | undefined {
  const match = text.match(/(?:^|\D)(5|15)\s*(?:m|min|minute|分钟|分)(?:\D|$)/i)
  const direct = match ? Number(match[1]) : Math.round((endTime - startTime) / 60_000)
  return direct === 5 || direct === 15 ? direct : undefined
}

function directionFromText(text: string): Direction | undefined {
  if (/(?:\bup\b|\bhigher\b|\babove\b|\brise\w*\b|\bincrease\w*\b|\bpositive\b|上涨|上升)/i.test(text)) return 'UP'
  if (/(?:\bdown\b|\blower\b|\bbelow\b|\bfall\w*\b|\bdecrease\w*\b|\bnegative\b|下跌|下降)/i.test(text)) return 'DOWN'
  return undefined
}

export function parseKalshiCandidate(market: KalshiMarket): Candidate | undefined {
  const ticker = (market.ticker ?? market.market_ticker ?? market.marketTicker)?.trim()
  const startTime = timestamp(market.open_time ?? market.openTime)
  const endTime = timestamp(market.close_time ?? market.closeTime)
  const marketStatus = String(market.status ?? 'open').toLowerCase()
  if (!ticker || !startTime || !endTime || endTime <= startTime || !['open', 'active'].includes(marketStatus)) return undefined
  if ((market.market_type ?? market.marketType) && (market.market_type ?? market.marketType) !== 'binary') return undefined
  const text = [ticker, market.title, market.subtitle, market.yes_sub_title, market.no_sub_title, market.rules_primary].filter(Boolean).join(' ')
  if (!/\bBTC\b|KXBTC|BITCOIN|比特币/i.test(text)) return undefined
  const durationMinutes = durationFromText(text, startTime, endTime)
  // KXBTC15M is a binary “above target” contract: YES is the UP outcome even
  // when a regional API omits the title/subtitle fields.
  const yesDirection = directionFromText(text) ?? (/^KXBTC(?:5|15)M[-_]/i.test(ticker) ? 'UP' : undefined)
  // Kalshi currently exposes the rolling BTC 15-minute series here. Keep the
  // parser strict so an unrelated/legacy 5-minute payload cannot reappear in
  // the board as a phantom cycle.
  if (durationMinutes !== 15 || !yesDirection) return undefined
  return { market, ticker, yesDirection, startTime, endTime, durationMinutes }
}

function decimalPrice(value: string): number | undefined {
  const price = Number(value)
  return Number.isFinite(price) && price > 0 && price < 1 ? price : undefined
}

function complementLevels(levels: Array<[string, string]> | undefined): OrderBookLevel[] {
  return (levels ?? []).flatMap(([priceRaw, sizeRaw]) => {
    const price = decimalPrice(priceRaw)
    const size = Number(sizeRaw)
    if (price === undefined || !Number.isFinite(size) || size <= 0) return []
    return [{ price: (1 - price).toFixed(4), size: String(size) }]
  }).sort((left, right) => Number(left.price) - Number(right.price))
}

function quote(direction: Direction, outcomeId: string, levels: OrderBookLevel[], receivedAt: number): ReadOnlyOutcomeQuote | undefined {
  const best = levels[0]
  if (!best) return undefined
  return { direction, outcomeId, bestAsk: best.price, askSize: best.size, levels, receivedAt }
}

function resolution(candidate: Candidate): ResolutionFingerprint {
  return {
    asset: 'BTC/USD', startTime: candidate.startTime, endTime: candidate.endTime,
    baselineSource: 'KALSHI:MARKET_RULE', settlementSource: 'KALSHI:MARKET_RULE',
    observationMethod: candidate.market.rules_primary?.slice(0, 300) || 'Kalshi market contract rule',
    comparisonOperator: 'GTE', tieOutcome: 'UP', voidRule: 'Kalshi market contract rule',
    staleDataRule: 'Kalshi market status and orderbook timestamp', timezone: 'UTC',
    ruleVersion: 'kalshi-btc-direction-contract-v1',
    evidenceUrl: `https://kalshi.com/markets/${candidate.ticker}`
  }
}

export class KalshiMarketData implements ReadOnlyVenueSource {
  readonly venueId = 'KALSHI'
  private monitoringEnabled = true
  private status: ReadOnlyVenueStatus = { connectionState: 'DISCONNECTED', message: '尚未连接 Kalshi 公共 API', marketCount: 0 }
  private snapshot: ReadOnlyWindowQuote[] = []
  private lastRefreshAt = 0
  private inFlight?: Promise<ReadOnlyWindowQuote[]>
  private listeners = new Set<() => void>()
  private stream?: WebSocket
  private streamKey = ''
  private streamState: KalshiStreamState = 'NOT_STARTED'
  private streamLastActivityAt?: number
  private streamMessageCount = 0
  private streamLastError?: string
  private reconnectTimer?: NodeJS.Timeout
  private candidates = new Map<string, Candidate>()
  private pageContexts = new Map<string, { candidate: Candidate; outcomes: Partial<Record<Direction, ReadOnlyOutcomeQuote>> }>()
  private pageStartPromise?: Promise<void>
  private proxyUrl = ''
  private proxyAgent?: import('undici').ProxyAgent

  constructor(
    private readonly credentialsProvider?: () => Promise<KalshiCredentials | undefined>,
    private readonly pageCapture?: KalshiPageCaptureSource
  ) {
    pageCapture?.onResponse((event) => this.ingest(event.body, event.receivedAt, 'REST'))
    pageCapture?.onWebSocketFrame((event) => this.ingest(event.payload, event.receivedAt, 'WebSocket'))
  }

  getStatus(): ReadOnlyVenueStatus { return { ...this.status } }
  getLatestWindows(): ReadOnlyWindowQuote[] { return this.snapshot }
  onMarketData(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  configureProxy(proxyUrl: string): void {
    const normalized = proxyUrl.trim()
    if (normalized === this.proxyUrl) return
    const previous = this.proxyAgent
    this.proxyAgent = undefined
    this.proxyUrl = normalized
    if (previous) void previous.close().catch(() => undefined)
  }

  setMonitoringEnabled(enabled: boolean): void {
    if (this.monitoringEnabled === enabled) return
    this.monitoringEnabled = enabled
    if (!enabled) {
      this.stopPageCapture()
      this.status = { connectionState: 'DISCONNECTED', message: 'Kalshi 监控已暂停，不会主动请求市场数据', marketCount: 0 }
      this.emit()
    }
  }

  async openPageCapture(): Promise<void> { await this.pageCapture?.start(true) }
  stopPageCapture(): void {
    this.pageCapture?.stop()
    this.pageContexts.clear()
    this.snapshot = []
    this.lastRefreshAt = 0
    this.closeStream()
    this.emit()
  }
  getPageCaptureStatus() { return this.pageCapture?.getStatus() ?? { state: 'IDLE' as const, message: 'Kalshi 页面拦截未启用' } }

  async fetchWindows(signal?: AbortSignal): Promise<ReadOnlyWindowQuote[]> {
    if (!this.monitoringEnabled) return []
    if (this.snapshot.length && Date.now() - this.lastRefreshAt < REFRESH_CACHE_MS) return this.snapshot
    if (this.inFlight) return await this.inFlight
    this.inFlight = this.load(signal)
    try { return await this.inFlight } finally { this.inFlight = undefined }
  }

  credentialsChanged(): void {
    this.closeStream()
  }

  private async load(signal?: AbortSignal): Promise<ReadOnlyWindowQuote[]> {
    try {
      const seriesResults = await Promise.allSettled(BTC_SERIES.map((series) =>
        this.fetchJson<KalshiMarketsResponse>(`${API}/markets?series_ticker=${series}&status=open&limit=100`, signal)
      ))
      const responses = seriesResults.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
      if (responses.length === 0) {
        const failure = seriesResults.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        throw failure?.reason instanceof Error ? failure.reason : new Error('Kalshi BTC 系列目录不可用')
      }
      const failedSeries = seriesResults.filter((result) => result.status === 'rejected').length
      const candidates = responses.flatMap((response) => response.markets ?? [])
        .map(parseKalshiCandidate).filter((value): value is Candidate => Boolean(value))
        .sort((left, right) => left.startTime - right.startTime || left.ticker.localeCompare(right.ticker)).slice(0, MAX_CANDIDATES)
      this.candidates = new Map(candidates.map((candidate) => [candidate.ticker, candidate]))
      void this.ensureStream(candidates)
      // Kalshi exposes a bulk public orderbook endpoint. Use one bounded call
      // for the candidate set instead of one request per market ticker.
      let books = new Map<string, KalshiOrderbookResponse['orderbook_fp']>()
      try {
        const orderbookResponse = await this.fetchJson<KalshiMultipleOrderbooksResponse>(
          `${API}/markets/orderbooks?tickers=${candidates.map((candidate) => encodeURIComponent(candidate.ticker)).join(',')}&depth=100`, signal
        )
        books = new Map((orderbookResponse.orderbooks ?? []).map((entry) => [
          String(entry.ticker ?? ''), entry.orderbook_fp ?? entry.orderbook ?? {}
        ]))
      } catch {
        // Some Kalshi gateways still expose only the single-ticker public
        // orderbook route. Retry at most the four current candidates, rather
        // than failing the whole venue or polling every listed market.
        const fallbackResults = await Promise.allSettled(candidates.map(async (candidate) => ({
          ticker: candidate.ticker,
          response: await this.fetchJson<KalshiOrderbookResponse>(`${API}/markets/${encodeURIComponent(candidate.ticker)}/orderbook?depth=100`, signal)
        })))
        books = new Map(fallbackResults.flatMap((result) => result.status === 'fulfilled'
          ? [[result.value.ticker, result.value.response.orderbook_fp ?? result.value.response.orderbook ?? {}] as const]
          : []))
      }
      if (books.size === 0) throw new Error('Kalshi 当前候选盘口不可用')
      const receivedAt = Date.now()
      const windows = candidates.map((candidate): ReadOnlyWindowQuote | undefined => {
        const orderbook = books.get(candidate.ticker)
        if (!orderbook) return undefined
        const yesAsk = complementLevels(orderbook.no_dollars)
        const noAsk = complementLevels(orderbook.yes_dollars)
        const noDirection: Direction = candidate.yesDirection === 'UP' ? 'DOWN' : 'UP'
        const outcomes: Partial<Record<Direction, ReadOnlyOutcomeQuote>> = {
          [candidate.yesDirection]: quote(candidate.yesDirection, `${candidate.ticker}:YES`, yesAsk, receivedAt),
          [noDirection]: quote(noDirection, `${candidate.ticker}:NO`, noAsk, receivedAt)
        }
        if (!outcomes.UP || !outcomes.DOWN) return undefined
        return {
          venueId: 'KALSHI', marketId: candidate.ticker, asset: 'BTC/USD', durationMinutes: candidate.durationMinutes,
          startTime: candidate.startTime, endTime: candidate.endTime, feeVerified: false,
          resolution: resolution(candidate), outcomes
        }
      })
      this.snapshot = windows.filter((value): value is ReadOnlyWindowQuote => Boolean(value))
      this.lastRefreshAt = Date.now()
      if (!this.snapshot.length) void this.startPageCapture()
      this.status = {
        connectionState: 'CONNECTED', marketCount: this.snapshot.length, updatedAt: this.lastRefreshAt,
        message: this.snapshot.length
          ? `Kalshi 公共 API 已连接；发现 ${this.snapshot.length} 个 BTC 15m 双向盘口（只读）${failedSeries ? `；${failedSeries}个系列暂不可用` : ''}；${this.streamSummary()}`
          : `Kalshi 公共 API 已连接，但当前没有可匹配的 BTC 15m 市场；${this.streamSummary()}`
      }
      this.emit()
      return this.snapshot
    } catch (error) {
      void this.startPageCapture()
      this.status = { ...this.status, connectionState: 'DISCONNECTED', message: `Kalshi 读取失败：${error instanceof Error ? error.message : String(error)}`, updatedAt: Date.now() }
      this.emit()
      return this.snapshot
    }
  }

  private async fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const mergedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response
    if (this.proxyUrl) {
      const { ProxyAgent, fetch: proxyFetch } = await import('undici')
      this.proxyAgent ??= new ProxyAgent(this.proxyUrl)
      response = await proxyFetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'ArbDesk/0.1' }, signal: mergedSignal, dispatcher: this.proxyAgent
      }) as unknown as Response
    } else {
      response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'ArbDesk/0.1' }, signal: mergedSignal })
    }
    if (!response.ok) throw new Error(`Kalshi HTTP ${response.status}`)
    return await response.json() as T
  }

  private emit(): void { for (const listener of this.listeners) listener() }

  private streamSummary(now = Date.now()): string {
    const age = this.streamLastActivityAt === undefined ? '无活动' : `最近活动 ${Math.max(0, Math.round((now - this.streamLastActivityAt) / 1_000))} 秒前`
    const error = this.streamLastError ? `；原因 ${this.streamLastError.slice(0, 160)}` : ''
    return `原生WS ${this.streamState}·${age}·消息 ${this.streamMessageCount}${error}`
  }

  ingest(payload: string, receivedAt = Date.now(), transport = '页面'): void {
    if (!this.monitoringEnabled) return
    let parsed: unknown
    try { parsed = JSON.parse(payload) } catch { return }
    if (transport === 'WebSocket') {
      for (const [ticker, context] of this.pageContexts) {
        const outcomes = { ...context.outcomes }
        let observed = false
        for (const direction of ['UP', 'DOWN'] as const) {
          const outcome = outcomes[direction]
          if (!outcome || (outcome.observedAt ?? outcome.receivedAt) >= receivedAt) continue
          outcomes[direction] = { ...outcome, observedAt: receivedAt }
          observed = true
        }
        if (observed) this.pageContexts.set(ticker, { ...context, outcomes })
      }
    }
    const queue: unknown[] = [parsed]
    let visited = 0
    while (queue.length && visited < 12_000) {
      const current = queue.shift()
      if (!current || typeof current !== 'object') continue
      if (Array.isArray(current)) { queue.push(...current); continue }
      visited += 1
      const item = current as Record<string, unknown>
      const tickerFromFrame = String(item.market_ticker ?? item.ticker ?? '')
      const streamedCandidate = this.candidates.get(tickerFromFrame)
      if (streamedCandidate) {
        const yesDirection = streamedCandidate.yesDirection
        const noDirection: Direction = yesDirection === 'UP' ? 'DOWN' : 'UP'
        const yesAsk = decimalPrice(String(item.yes_ask_dollars ?? item.yesAskDollars ?? ''))
        const yesBid = decimalPrice(String(item.yes_bid_dollars ?? item.yesBidDollars ?? ''))
        const yesAskSize = Number(item.yes_ask_size_fp ?? item.yesAskSizeFp)
        const yesBidSize = Number(item.yes_bid_size_fp ?? item.yesBidSizeFp)
        const streamedOutcomes: Partial<Record<Direction, ReadOnlyOutcomeQuote>> = {}
        if (yesAsk !== undefined && yesAskSize > 0) streamedOutcomes[yesDirection] = quote(yesDirection, `${tickerFromFrame}:YES`, [{ price: yesAsk.toFixed(4), size: String(yesAskSize) }], receivedAt)
        if (yesBid !== undefined && yesBidSize > 0) streamedOutcomes[noDirection] = quote(noDirection, `${tickerFromFrame}:NO`, [{ price: (1 - yesBid).toFixed(4), size: String(yesBidSize) }], receivedAt)
        const previous = this.pageContexts.get(tickerFromFrame)
        this.pageContexts.set(tickerFromFrame, { candidate: streamedCandidate, outcomes: { ...(previous?.outcomes ?? {}), ...streamedOutcomes } })
      }
      const candidate = parseKalshiCandidate({
        ...(item as unknown as KalshiMarket),
        status: String(item.status ?? 'open') === 'open' ? 'open' : String(item.status ?? 'open')
      })
      if (candidate) {
        const outcomes: Partial<Record<Direction, ReadOnlyOutcomeQuote>> = {}
        const yesDirection = candidate.yesDirection
        const noDirection: Direction = yesDirection === 'UP' ? 'DOWN' : 'UP'
        const yesAsk = decimalPrice(String(item.yes_ask_dollars ?? item.yesAskDollars ?? ''))
        const noAsk = decimalPrice(String(item.no_ask_dollars ?? item.noAskDollars ?? ''))
        const yesSize = Number(item.yes_ask_size_fp ?? item.yesAskSizeFp)
        const noSize = Number(item.no_ask_size_fp ?? item.noAskSizeFp)
        if (yesAsk !== undefined && yesSize > 0) outcomes[yesDirection] = quote(yesDirection, `${candidate.ticker}:YES`, [{ price: yesAsk.toFixed(4), size: String(yesSize) }], receivedAt)
        if (noAsk !== undefined && noSize > 0) outcomes[noDirection] = quote(noDirection, `${candidate.ticker}:NO`, [{ price: noAsk.toFixed(4), size: String(noSize) }], receivedAt)
        const orderbook = (item.orderbook_fp ?? item.orderbook) as { yes_dollars?: Array<[string, string]>; no_dollars?: Array<[string, string]> } | undefined
        if (orderbook) {
          outcomes[yesDirection] ??= quote(yesDirection, `${candidate.ticker}:YES`, complementLevels(orderbook.no_dollars), receivedAt)
          outcomes[noDirection] ??= quote(noDirection, `${candidate.ticker}:NO`, complementLevels(orderbook.yes_dollars), receivedAt)
        }
        const previous = this.pageContexts.get(candidate.ticker)
        this.pageContexts.set(candidate.ticker, { candidate, outcomes: { ...(previous?.outcomes ?? {}), ...outcomes } })
      }
      queue.push(...Object.values(item))
    }
    this.rebuildPageSnapshot(transport, receivedAt)
  }

  /**
   * Kalshi's authenticated WebSocket sends control-layer ping frames even
   * when a ticker value is unchanged. They are valid evidence that the stream
   * is alive, but do not carry a JSON ticker payload for `ingest()` to parse.
   */
  observeStreamActivity(receivedAt = Date.now()): void {
    if (!this.monitoringEnabled) return
    let changed = false
    const refresh = (outcomes: Partial<Record<Direction, ReadOnlyOutcomeQuote>>): Partial<Record<Direction, ReadOnlyOutcomeQuote>> => {
      const next = { ...outcomes }
      for (const direction of ['UP', 'DOWN'] as const) {
        const outcome = next[direction]
        if (!outcome || (outcome.observedAt ?? outcome.receivedAt) >= receivedAt) continue
        next[direction] = { ...outcome, observedAt: receivedAt }
        changed = true
      }
      return next
    }
    this.snapshot = this.snapshot.map((window) => ({ ...window, outcomes: refresh(window.outcomes) }))
    for (const [ticker, context] of this.pageContexts) {
      this.pageContexts.set(ticker, { ...context, outcomes: refresh(context.outcomes) })
    }
    if (!changed) return
    this.status = { ...this.status, connectionState: 'CONNECTED', updatedAt: receivedAt, message: `Kalshi ticker WebSocket 保活在线；最近流观测 ${new Date(receivedAt).toLocaleTimeString('zh-CN', { hour12: false })}` }
    this.emit()
  }

  private rebuildPageSnapshot(transport: string, receivedAt: number): void {
    const now = Date.now()
    this.snapshot = [...this.pageContexts.values()]
      .filter((context) => context.candidate.endTime > now - 60_000 && context.outcomes.UP && context.outcomes.DOWN)
      .map((context): ReadOnlyWindowQuote => ({
        venueId: 'KALSHI', marketId: context.candidate.ticker, asset: 'BTC/USD', durationMinutes: context.candidate.durationMinutes,
        startTime: context.candidate.startTime, endTime: context.candidate.endTime, feeVerified: false,
        resolution: resolution(context.candidate), outcomes: context.outcomes
      }))
      .sort((left, right) => left.startTime - right.startTime || left.durationMinutes - right.durationMinutes)
    if (!this.snapshot.length) return
    this.lastRefreshAt = receivedAt
    this.status = { connectionState: 'CONNECTED', marketCount: this.snapshot.length, updatedAt: receivedAt, message: `Kalshi ${transport} 被动行情已解析；${this.snapshot.length} 个 BTC 15m 双向盘口，未额外请求接口；${this.streamSummary(receivedAt)}` }
    this.emit()
  }

  private async startPageCapture(): Promise<void> {
    if (!this.pageCapture || this.pageStartPromise) return await this.pageStartPromise
    this.pageStartPromise = this.pageCapture.start(false)
    try { await this.pageStartPromise } catch { /* REST remains the fallback */ } finally { this.pageStartPromise = undefined }
  }

  private async ensureStream(candidates: Candidate[]): Promise<void> {
    if (!this.credentialsProvider || candidates.length === 0) {
      this.streamState = candidates.length === 0 ? 'NOT_STARTED' : 'NO_CREDENTIALS'
      return
    }
    let credentials: KalshiCredentials | undefined
    try { credentials = await this.credentialsProvider() } catch (error) {
      this.streamState = 'ERROR'
      this.streamLastError = error instanceof Error ? error.message : String(error)
      return
    }
    if (!credentials) {
      this.streamState = 'NO_CREDENTIALS'
      return
    }
    const key = candidates.map((candidate) => candidate.ticker).join(',')
    if (this.stream && this.stream.readyState === WebSocket.OPEN && this.streamKey === key) return
    if (this.streamKey === key && this.stream && this.stream.readyState === WebSocket.CONNECTING) return
    this.closeStream(false)
    this.streamKey = key
    this.streamState = 'CONNECTING'
    this.streamLastError = undefined
    const socket = new WebSocket(WS_URL, { headers: kalshiHeaders(credentials, 'GET', '/trade-api/ws/v2') })
    this.stream = socket
    socket.once('open', () => {
      if (this.stream !== socket) return
      this.streamState = 'CONNECTED'
      this.streamLastActivityAt = Date.now()
      socket.send(JSON.stringify({ id: 1, cmd: 'subscribe', params: { channels: ['ticker'], market_tickers: candidates.map((candidate) => candidate.ticker) } }))
      this.status = { ...this.status, message: `${this.status.message}；Kalshi ticker WebSocket 已连接；${this.streamSummary()}` }
      this.emit()
    })
    socket.on('message', (raw) => {
      if (this.stream !== socket) return
      this.streamLastActivityAt = Date.now()
      this.streamMessageCount += 1
      try { this.applyTicker(JSON.parse(String(raw))) } catch { /* ignore malformed service frames */ }
    })
    socket.on('ping', () => {
      if (this.stream === socket) this.observeStreamActivity(Date.now())
    })
    socket.once('close', () => {
      if (this.stream !== socket) return
      this.stream = undefined
      this.streamState = 'DISCONNECTED'
      this.status = { ...this.status, message: `${this.status.message}；WebSocket 已断开，保留 REST 盘口` }
      this.emit()
      if (!this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = undefined
          void this.ensureStream(candidates)
        }, 5_000)
        this.reconnectTimer.unref()
      }
    })
    socket.once('error', (error) => {
      if (this.stream !== socket) return
      this.streamState = 'ERROR'
      this.streamLastError = error instanceof Error ? error.message : String(error)
      this.status = { ...this.status, message: `${this.status.message}；WebSocket 错误：${this.streamLastError.slice(0, 160)}` }
      this.emit()
    })
  }

  private applyTicker(event: unknown): void {
    if (!event || typeof event !== 'object') return
    const value = event as { type?: string; msg?: Record<string, unknown> }
    if (value.type !== 'ticker' || !value.msg) return
    const ticker = String(value.msg.market_ticker ?? '')
    const candidate = this.candidates.get(ticker)
    if (!candidate) return
    const yesAsk = decimalPrice(String(value.msg.yes_ask_dollars ?? ''))
    const yesBid = decimalPrice(String(value.msg.yes_bid_dollars ?? ''))
    const yesAskSize = Number(value.msg.yes_ask_size_fp)
    const yesBidSize = Number(value.msg.yes_bid_size_fp)
    const receivedAt = Date.now()
    const yesDirection = candidate.yesDirection
    const noDirection: Direction = yesDirection === 'UP' ? 'DOWN' : 'UP'
    const current = this.snapshot.find((window) => window.marketId === ticker)
    if (!current) return
    const nextOutcomes = { ...current.outcomes }
    for (const direction of ['UP', 'DOWN'] as const) {
      const outcome = nextOutcomes[direction]
      if (outcome) nextOutcomes[direction] = { ...outcome, observedAt: receivedAt }
    }
    if (yesAsk !== undefined && yesAskSize > 0) nextOutcomes[yesDirection] = quote(yesDirection, `${ticker}:YES`, [{ price: yesAsk.toFixed(4), size: String(yesAskSize) }], receivedAt)
    if (yesBid !== undefined && yesBidSize > 0) nextOutcomes[noDirection] = quote(noDirection, `${ticker}:NO`, [{ price: (1 - yesBid).toFixed(4), size: String(yesBidSize) }], receivedAt)
    if (!nextOutcomes.UP || !nextOutcomes.DOWN) return
    this.snapshot = this.snapshot.map((window) => window.marketId === ticker ? { ...window, outcomes: nextOutcomes } : window)
    this.status = { ...this.status, updatedAt: receivedAt, message: `Kalshi ticker WebSocket 已更新 ${ticker}` }
    this.emit()
  }

  private closeStream(clearKey = true): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const socket = this.stream
    this.stream = undefined
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
    if (clearKey) this.streamKey = ''
  }
}
