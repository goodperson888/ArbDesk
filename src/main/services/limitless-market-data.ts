import type { Direction, OrderBookLevel } from '../../shared/types'
import type { ReadOnlyOutcomeQuote, ReadOnlyVenueSource, ReadOnlyVenueStatus, ReadOnlyWindowQuote } from '../platforms/read-only-types'
import { io, type Socket } from 'socket.io-client'
import { createHmac } from 'node:crypto'

const API = 'https://api.limitless.exchange'
const DISCOVERY_CACHE_MS = 15_000
const SNAPSHOT_CACHE_MS = 4_000
const REST_BOOK_AUDIT_MS = 30_000
const REQUEST_TIMEOUT_MS = 6_000
const COLLATERAL_SCALE = 1_000_000

interface LimitlessMarket {
  id?: number
  slug?: string
  title?: string
  startAt?: string
  expirationTimestamp?: number
  tradeType?: string
  automationType?: string
  tokens?: { yes?: string; no?: string }
  venue?: { exchange?: string; adapter?: string | null }
  collateralToken?: { address?: string; decimals?: number; symbol?: string }
  metadata?: {
    minutesDeadline?: number
    chainlinkDataStream?: {
      pair?: string
      feedId?: string
      toleranceSeconds?: number
    }
  }
  priceOracleMetadata?: {
    ticker?: string
    chainlinkFeedId?: string
    chainlinkPair?: string
    chainlinkStreamUrl?: string
  }
}

export interface LimitlessPreparationCandidate {
  marketId: string
  outcomeId: string
  direction: Direction
  bestAsk: string
  availableQuantity: string
  exchangeAddress: string
  collateralAddress: string
  collateralDecimals: number
}

interface LimitlessMarketsResponse {
  data?: LimitlessMarket[]
}

interface LimitlessLevel {
  price?: number | string
  size?: number | string
}

interface LimitlessBook {
  asks?: LimitlessLevel[]
  bids?: LimitlessLevel[]
  tokenId?: string
  minSize?: string
}

function validLevel(level: LimitlessLevel): boolean {
  return Number(level.price) > 0 && Number(level.price) < 1 && Number(level.size) > 0
}

function normalizeSize(value: number | string | undefined): string {
  return String(Number(value ?? 0) / COLLATERAL_SCALE)
}

function yesAsks(book: LimitlessBook): OrderBookLevel[] {
  return (book.asks ?? [])
    .filter(validLevel)
    .map((level) => ({ price: String(level.price), size: normalizeSize(level.size) }))
    .sort((left, right) => Number(left.price) - Number(right.price))
}

function noAsks(book: LimitlessBook): OrderBookLevel[] {
  return (book.bids ?? [])
    .filter(validLevel)
    .map((level) => ({ price: (1 - Number(level.price)).toFixed(6).replace(/0+$/, '').replace(/\.$/, ''), size: normalizeSize(level.size) }))
    .sort((left, right) => Number(left.price) - Number(right.price))
}

function outcome(direction: Direction, outcomeId: string, levels: OrderBookLevel[], receivedAt: number): ReadOnlyOutcomeQuote | undefined {
  const best = levels[0]
  if (!best) return undefined
  return { direction, outcomeId, bestAsk: best.price, askSize: best.size, levels, receivedAt }
}

function parseMarket(market: LimitlessMarket, book: LimitlessBook, receivedAt: number): ReadOnlyWindowQuote | undefined {
  const duration = Number(market.metadata?.minutesDeadline)
  const startTime = Date.parse(market.startAt ?? '')
  const endTime = Number(market.expirationTimestamp)
  const ticker = market.priceOracleMetadata?.ticker?.toUpperCase()
  if (ticker !== 'BTC' || (duration !== 5 && duration !== 15) || !Number.isFinite(startTime) || !Number.isFinite(endTime)) return undefined
  if (!market.slug || !market.tokens?.yes || !market.tokens.no) return undefined
  const up = outcome('UP', market.tokens.yes, yesAsks(book), receivedAt)
  const down = outcome('DOWN', market.tokens.no, noAsks(book), receivedAt)
  if (!up && !down) return undefined
  const feedId = market.metadata?.chainlinkDataStream?.feedId ?? market.priceOracleMetadata?.chainlinkFeedId ?? 'unknown'
  const pair = market.metadata?.chainlinkDataStream?.pair ?? market.priceOracleMetadata?.chainlinkPair ?? 'BTC/USD'
  return {
    venueId: 'LIMITLESS', marketId: market.slug, asset: 'BTC/USD', durationMinutes: duration,
    startTime, endTime, feeVerified: false,
    resolution: {
      asset: 'BTC/USD', startTime, endTime, baselineSource: `CHAINLINK:${feedId}`,
      settlementSource: `CHAINLINK:${feedId}`, observationMethod: `${pair} exact timestamp; next tick within ${market.metadata?.chainlinkDataStream?.toleranceSeconds ?? 5}s`,
      comparisonOperator: 'GTE', tieOutcome: 'UP', voidRule: 'Long outage: manual closest Chainlink price',
      staleDataRule: 'Next Chainlink price within tolerance, otherwise manual closest price', timezone: 'UTC',
      ruleVersion: 'limitless-lumy-chainlink-v2', evidenceUrl: `https://limitless.exchange/markets/${market.slug}`
    },
    outcomes: { ...(up ? { UP: up } : {}), ...(down ? { DOWN: down } : {}) }
  }
}

export class LimitlessMarketData implements ReadOnlyVenueSource {
  readonly venueId = 'LIMITLESS'
  private monitoringEnabled = true
  private status: ReadOnlyVenueStatus = { connectionState: 'DISCONNECTED', message: '尚未连接 Limitless 公共 API', marketCount: 0 }
  private discovery?: { fetchedAt: number; markets: LimitlessMarket[] }
  private snapshot?: { fetchedAt: number; windows: ReadOnlyWindowQuote[] }
  private inFlight?: Promise<ReadOnlyWindowQuote[]>
  private lastRestBookAt = 0
  private socket?: Socket
  private socketTokenId = ''
  private subscribedSlugs = ''
  private activeSubscriptionKey = ''
  private listeners = new Set<() => void>()

  constructor(private readonly options: {
    enableStreaming?: boolean
    hmacCredentialsProvider?: () => Promise<{ tokenId: string; tokenSecret: string } | undefined>
    socketFactory?: (url: string, options: Parameters<typeof io>[1]) => Socket
  } = {}) {}

  getStatus(): ReadOnlyVenueStatus {
    return { ...this.status }
  }

  getLatestWindows(): ReadOnlyWindowQuote[] {
    return this.snapshot?.windows ?? []
  }

  getPreparationCandidate(): LimitlessPreparationCandidate | undefined {
    const windows = this.snapshot?.windows ?? []
    for (const window of windows) {
      const market = this.discovery?.markets.find((candidate) => candidate.slug === window.marketId)
      const quote = window.outcomes.UP ?? window.outcomes.DOWN
      const exchangeAddress = market?.venue?.exchange
      const collateralAddress = market?.collateralToken?.address
      if (!market?.slug || !quote || !exchangeAddress || !collateralAddress) continue
      return {
        marketId: market.slug,
        outcomeId: quote.outcomeId,
        direction: quote.direction,
        bestAsk: quote.bestAsk,
        availableQuantity: quote.askSize,
        exchangeAddress,
        collateralAddress,
        collateralDecimals: Number.isInteger(market.collateralToken?.decimals) ? Number(market.collateralToken?.decimals) : 6
      }
    }
    return undefined
  }

  onMarketData(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setMonitoringEnabled(enabled: boolean): void {
    if (this.monitoringEnabled === enabled) return
    this.monitoringEnabled = enabled
    if (!enabled) {
      this.socket?.disconnect()
      this.socket = undefined
      this.snapshot = undefined
      this.status = { connectionState: 'DISCONNECTED', message: 'Limitless 监控已暂停，不会主动请求市场数据', marketCount: 0 }
      for (const listener of this.listeners) listener()
    }
  }

  credentialsChanged(): void {
    const socket = this.socket
    this.socket = undefined
    this.socketTokenId = ''
    this.activeSubscriptionKey = ''
    socket?.close()
  }

  async fetchWindows(signal?: AbortSignal): Promise<ReadOnlyWindowQuote[]> {
    if (!this.monitoringEnabled) return []
    const now = Date.now()
    const discoveryFresh = Boolean(this.discovery && now - this.discovery.fetchedAt < DISCOVERY_CACHE_MS)
    if (this.snapshot && (this.socket?.connected ? discoveryFresh : now - this.snapshot.fetchedAt < SNAPSHOT_CACHE_MS)) return this.snapshot.windows
    if (this.inFlight) return await this.inFlight
    this.inFlight = this.load(signal)
    try {
      return await this.inFlight
    } finally {
      this.inFlight = undefined
    }
  }

  private async load(signal?: AbortSignal): Promise<ReadOnlyWindowQuote[]> {
    try {
      const now = Date.now()
      let markets = this.discovery?.markets
      if (!markets || now - (this.discovery?.fetchedAt ?? 0) >= DISCOVERY_CACHE_MS) {
        const response = await this.fetchJson<LimitlessMarketsResponse>(`${API}/markets/active?limit=25&page=1&tradeType=clob&automationType=lumy`, signal)
        markets = response.data ?? []
        this.discovery = { fetchedAt: now, markets }
      }
      const candidates = markets
        .filter((market) => market.tradeType === 'clob' && market.automationType === 'lumy')
        .filter((market) => market.priceOracleMetadata?.ticker?.toUpperCase() === 'BTC')
        .filter((market) => [5, 15].includes(Number(market.metadata?.minutesDeadline)))
        .filter((market) => Number(market.expirationTimestamp) > now && Date.parse(market.startAt ?? '') < now + 16 * 60_000)
        .sort((left, right) => Date.parse(left.startAt ?? '') - Date.parse(right.startAt ?? ''))
        .slice(0, 4)
      const hmacCredentials = await this.options.hmacCredentialsProvider?.()
      this.ensureMarketStream(candidates, hmacCredentials)
      const current = new Map((this.snapshot?.windows ?? []).map((window) => [window.marketId, window]))
      const shouldAuditAllBooks = !this.socket?.connected || now - this.lastRestBookAt >= REST_BOOK_AUDIT_MS
      const booksToFetch = candidates.filter((market) => Boolean(market.slug) && (shouldAuditAllBooks || !current.has(market.slug!)))
      const results = await Promise.allSettled(booksToFetch.map(async (market) => {
        if (!market.slug) return undefined
        const book = await this.fetchJson<LimitlessBook>(`${API}/markets/${encodeURIComponent(market.slug)}/orderbook`, signal)
        return parseMarket(market, book, Date.now())
      }))
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) current.set(result.value.marketId, result.value)
      }
      if (shouldAuditAllBooks) this.lastRestBookAt = Date.now()
      const windows = candidates.flatMap((market) => market.slug && current.has(market.slug) ? [current.get(market.slug)!] : [])
      this.snapshot = { fetchedAt: Date.now(), windows }
      this.status = {
        connectionState: 'CONNECTED', marketCount: windows.length, updatedAt: Date.now(),
        message: this.socket?.connected
          ? `WebSocket实时盘口已连接（${windows.length}个 BTC 5m/15m 市场）；REST每15秒发现轮次、每30秒校准盘口`
          : `REST行情已连接（${windows.length}个市场），WebSocket正在连接；断线期间最多每5秒刷新盘口`
      }
      return windows
    } catch (error) {
      this.status = { ...this.status, connectionState: 'DISCONNECTED', message: `Limitless读取失败：${error instanceof Error ? error.message : String(error)}` }
      throw error
    }
  }

  private ensureMarketStream(markets: LimitlessMarket[], hmacCredentials?: { tokenId: string; tokenSecret: string }): void {
    if (this.options.enableStreaming === false || !this.monitoringEnabled) return
    const slugs = markets.map((market) => market.slug).filter((slug): slug is string => Boolean(slug)).sort()
    const nextKey = slugs.join(',')
    this.subscribedSlugs = nextKey
    if (this.socket && this.socketTokenId === (hmacCredentials?.tokenId ?? '')) {
      if (this.socket.connected && nextKey !== this.activeSubscriptionKey) {
        this.socket.emit('subscribe_market_prices', { marketSlugs: slugs })
        this.activeSubscriptionKey = nextKey
      }
      return
    }
    if (this.socket) {
      const staleSocket = this.socket
      this.socket = undefined
      staleSocket.close()
    }
    this.socketTokenId = hmacCredentials?.tokenId ?? ''
    const createSocket = this.options.socketFactory ?? ((url, options) => io(url, options))
    const hmacHeaders = hmacCredentials ? this.websocketAuthHeaders(hmacCredentials) : undefined
    const socket = createSocket('wss://ws.limitless.exchange/markets', {
      transports: ['websocket'], reconnection: true, reconnectionAttempts: Infinity,
      ...(hmacHeaders ? { extraHeaders: hmacHeaders } : {})
    })
    this.socket = socket
    socket.on('connect', () => {
      if (this.socket !== socket || !this.monitoringEnabled) return
      const wanted = this.subscribedSlugs ? this.subscribedSlugs.split(',') : []
      if (wanted.length > 0) {
        socket.emit('subscribe_market_prices', { marketSlugs: wanted })
        this.activeSubscriptionKey = this.subscribedSlugs
      }
      socket.emit('subscribe_market_lifecycle')
      this.status = {
        connectionState: 'CONNECTED', marketCount: this.snapshot?.windows.length ?? 0, updatedAt: Date.now(),
        message: `WebSocket实时盘口已连接（${wanted.length}个市场${this.socketTokenId ? '，HMAC身份已认证' : '，公开模式'}）；REST只做轮次发现和30秒校准`
      }
      this.emitMarketData()
    })
    socket.on('orderbookUpdate', (event: { marketSlug?: string; orderbook?: LimitlessBook }) => {
      if (this.socket !== socket || !this.monitoringEnabled || !event.marketSlug || !event.orderbook) return
      const market = this.discovery?.markets.find((candidate) => candidate.slug === event.marketSlug)
      const parsed = market ? parseMarket(market, event.orderbook, Date.now()) : undefined
      if (!parsed) return
      const windows = [...(this.snapshot?.windows ?? []).filter((window) => window.marketId !== parsed.marketId), parsed]
        .sort((left, right) => left.startTime - right.startTime || left.durationMinutes - right.durationMinutes)
      this.snapshot = { fetchedAt: Date.now(), windows }
      this.status = {
        connectionState: 'CONNECTED', marketCount: windows.length, updatedAt: Date.now(),
        message: `WebSocket实时盘口已连接，最近推送 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
      }
      this.emitMarketData()
    })
    socket.on('marketCreated', () => {
      if (!this.monitoringEnabled) return
      this.discovery = undefined
    })
    socket.on('marketResolved', (event: { slug?: string }) => {
      if (!this.monitoringEnabled || !event.slug || !this.snapshot) return
      this.snapshot = { fetchedAt: Date.now(), windows: this.snapshot.windows.filter((window) => window.marketId !== event.slug) }
      this.discovery = undefined
      this.emitMarketData()
    })
    socket.on('disconnect', () => {
      if (this.socket !== socket) return
      this.activeSubscriptionKey = ''
      this.status = {
        ...this.status, connectionState: this.snapshot ? 'CONNECTED' : 'DISCONNECTED',
        message: 'WebSocket已断开，正在自动重连；REST低频兜底仍启用'
      }
      this.emitMarketData()
    })
    socket.on('connect_error', (error: Error) => {
      if (this.socket !== socket) return
      this.status = { ...this.status, message: `WebSocket连接异常，使用REST兜底：${error.message}` }
    })
  }

  private emitMarketData(): void {
    for (const listener of this.listeners) listener()
  }

  private websocketAuthHeaders(credentials: { tokenId: string; tokenSecret: string }): Record<string, string> {
    const timestamp = new Date().toISOString()
    const message = `${timestamp}\nGET\n/socket.io/?EIO=4&transport=websocket\n`
    const signature = createHmac('sha256', Buffer.from(credentials.tokenSecret, 'base64'))
      .update(message)
      .digest('base64')
    return {
      'lmts-api-key': credentials.tokenId,
      'lmts-timestamp': timestamp,
      'lmts-signature': signature
    }
  }

  private async fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'ArbDesk/0.1' }, signal: combined })
    if (!response.ok) throw new Error(`${new URL(url).hostname} HTTP ${response.status}`)
    return await response.json() as T
  }
}
