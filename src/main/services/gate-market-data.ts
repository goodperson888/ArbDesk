import type { Direction, OrderBookLevel } from '../../shared/types'
import type { ReadOnlyOutcomeQuote, ReadOnlyVenueSource, ReadOnlyVenueStatus, ReadOnlyWindowQuote } from '../platforms/read-only-types'
import type { GatePageCaptureSource } from './gate-page-capture'

interface GateMarketContext {
  marketId: string
  asset: 'BTC/USD'
  durationMinutes: 5 | 15
  startTime: number
  endTime: number
  outcomes: Partial<Record<Direction, ReadOnlyOutcomeQuote>>
  /** Token IDs learned from the event catalogue, including sides with no quote yet. */
  catalogOutcomeIds?: Partial<Record<Direction, string>>
}

interface GatePipelineStats {
  rawBookFrames: number
  mappedBookFrames: number
  unmappedBookFrames: number
  lastRawBookAt?: number
  lastMappedBookAt?: number
  lastQuoteUpdateAt?: number
  restBookResponses: number
  restBookHashes: number
  restBookDirections: number
  websocketHashes: number
  websocketHashMatches: number
  restAssetIds: Set<string>
  websocketAids: number
  websocketAidMatches: number
  websocketMarketKeys: number
  websocketMarketKeyMatches: number
}

interface GateBookHashBinding {
  marketId: string
  direction: Direction
  endTime: number
}

interface GateSubscriptionPair {
  tokens: string[]
  bestAsks: Map<string, number>
  books: Map<string, { levels: OrderBookLevel[]; receivedAt: number }>
  updatedAt: number
}

type JsonRecord = Record<string, unknown>

const MAX_WALK_OBJECTS = 12_000

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() :
    typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined
}

function firstValue(source: JsonRecord, keys: string[]): unknown {
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key]
  return undefined
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  if (parsed < 10_000_000_000) return Math.round(parsed * 1_000)
  if (parsed > 10_000_000_000_000) return Math.round(parsed / 1_000)
  return Math.round(parsed)
}

function durationMinutes(source: JsonRecord, startTime?: number, endTime?: number): 5 | 15 | undefined {
  const raw = firstValue(source, ['durationMinutes', 'duration_min', 'duration', 'period', 'interval', 'cycle', 'timeframe', 'slug', 'event_name', 'question'])
  const text = String(raw ?? '').toLowerCase()
  const match = text.match(/(?:^|\D)(5|15)\s*(?:m|min|minute|分)/)
  const direct = Number(raw)
  const inferred = startTime && endTime ? Math.round((endTime - startTime) / 60_000) : undefined
  const value = match ? Number(match[1]) : direct === 5 || direct === 15 ? direct : inferred
  return value === 5 || value === 15 ? value : undefined
}

function asset(source: JsonRecord): 'BTC/USD' | undefined {
  const raw = firstValue(source, ['asset', 'underlying', 'underlyingAsset', 'symbol', 'crypto', 'coin', 'base', 'event_name', 'question', 'slug', 'title', 'name'])
  return /BTC(?:\/|_|-)?(?:USD|USDT)?/i.test(String(raw ?? '')) ? 'BTC/USD' : undefined
}

function direction(source: JsonRecord, fallback?: string): Direction | undefined {
  const index = Number(firstValue(source, ['index', 'outcomeIndex', 'outcome_index']))
  if (index === 1) return 'UP'
  if (index === 2) return 'DOWN'
  const raw = String(firstValue(source, ['direction', 'outcome', 'side', 'type', 'name', 'label', 'title']) ?? fallback ?? '').toUpperCase()
  if (/\b(?:UP|CALL|RISE|HIGHER|BULL|LONG)\b|涨|上漲|上涨|看涨|升/.test(raw)) return 'UP'
  if (/\b(?:DOWN|PUT|FALL|LOWER|BEAR|SHORT)\b|跌|下跌|看跌|下降|降/.test(raw)) return 'DOWN'
  return undefined
}

function decimal(value: unknown): string | undefined {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) return undefined
  return parsed.toString()
}

/**
 * Gate's event catalogue exposes the two WebSocket asset IDs even when one
 * side has no asks yet (its catalogue price is commonly exactly 1). Keep the
 * IDs independently from the price quotes so the first live orderbook update
 * can still be attached to the correct UP/DOWN outcome.
 */
function catalogOutcomeIds(source: JsonRecord): Partial<Record<Direction, string>> {
  const market = Array.isArray(source.markets) ? record(source.markets[0]) : undefined
  const idsFrom = (target?: JsonRecord): Partial<Record<Direction, string>> => {
    if (!target) return {}
    const tokenList = firstValue(target, ['clob_token_ids', 'clobTokenIds', 'tokenIds', 'token_ids'])
    const tokens = Array.isArray(tokenList) ? tokenList.map(stringValue) : []
    return {
      UP: tokens[0] ?? stringValue(firstValue(target, ['clob_token_id0', 'clobTokenId0', 'token_id0'])),
      DOWN: tokens[1] ?? stringValue(firstValue(target, ['clob_token_id1', 'clobTokenId1', 'token_id1']))
    }
  }
  // Some Gate responses put `markets[0]` beside the IDs while other releases
  // put the IDs on the event root. Prefer the nested market, then fill gaps
  // from the root rather than losing a side when the shapes are mixed.
  const nested = idsFrom(market)
  const root = idsFrom(source)
  const up = nested.UP ?? root.UP
  const down = nested.DOWN ?? root.DOWN
  return { UP: up, DOWN: down }
}

function level(value: unknown): OrderBookLevel | undefined {
  if (Array.isArray(value)) {
    const price = decimal(value[0])
    const size = Number(value[1])
    return price && Number.isFinite(size) && size > 0 ? { price, size: String(size) } : undefined
  }
  const item = record(value)
  if (!item) return undefined
  const price = decimal(firstValue(item, ['price', 'p', 'rate']))
  const size = Number(firstValue(item, ['size', 'quantity', 'qty', 'amount', 'volume', 'q']))
  return price && Number.isFinite(size) && size > 0 ? { price, size: String(size) } : undefined
}

function askLevels(source: JsonRecord): OrderBookLevel[] {
  const raw = firstValue(source, [
    'asks', 'ask', 'a', 'sell', 'sells', 'sellOrders', 'sell_orders',
    'askLevels', 'ask_levels', 'offers', 'orderBookAsks', 'order_book_asks'
  ])
  const nested = record(raw)
  const values = Array.isArray(raw)
    ? raw
    : Array.isArray(nested?.asks) ? nested.asks
      : Array.isArray(nested?.levels) ? nested.levels
        : []
  return values.map(level).filter((value): value is OrderBookLevel => Boolean(value)).sort((left, right) => Number(left.price) - Number(right.price))
}

function isExplicitEmptyBookFrame(source: JsonRecord): boolean {
  return Array.isArray(source.a) && Array.isArray(source.b) && source.a.length === 0 && source.b.length === 0
}

function hasZeroAskUpdate(source: JsonRecord): boolean {
  if (!Array.isArray(source.a)) return false
  return source.a.some((value) => {
    if (Array.isArray(value)) return Number(value[1]) === 0
    const item = record(value)
    return item ? Number(firstValue(item, ['size', 's', 'quantity', 'qty', 'amount', 'volume', 'q'])) === 0 : false
  })
}

function outcomeQuote(source: JsonRecord, fallbackDirection: string | undefined, receivedAt: number): ReadOnlyOutcomeQuote | undefined {
  const parsedDirection = direction(source, fallbackDirection)
  if (!parsedDirection) return undefined
  const levels = askLevels(source)
  const bestAsk = levels[0]?.price ?? decimal(firstValue(source, ['bestAsk', 'best_ask', 'askPrice', 'ask_price', 'sellPrice', 'sell_price', 'price']))
  const askSize = levels[0]?.size ?? stringValue(firstValue(source, ['askSize', 'ask_size', 'availableQuantity', 'available_quantity', 'quantity', 'qty', 'size']))
  if (!bestAsk || !askSize || Number(askSize) <= 0) return undefined
  const outcomeId = stringValue(firstValue(source, ['outcomeId', 'outcome_id', 'contractId', 'contract_id', 'symbolId', 'symbol_id', 'tokenId', 'token_id', 'assetId', 'asset_id', 'aid', 'id'])) ?? parsedDirection
  return { direction: parsedDirection, outcomeId, bestAsk, askSize, levels, receivedAt }
}

function marketId(source: JsonRecord): string | undefined {
  return stringValue(firstValue(source, ['marketId', 'market_id', 'marketID', 'eventId', 'event_id', 'eventID', 'contractGroupId', 'contract_group_id', 'contractId', 'contract_id', 'id']))
}

function timeRange(source: JsonRecord): { startTime: number; endTime: number } | undefined {
  const startTime = timestamp(firstValue(source, ['startTime', 'start_time', 'eventStart', 'event_start', 'startTimestamp', 'start_timestamp', 'game_start_time', 'beginTime', 'begin_time', 'beginAt', 'begin_at', 'openTime', 'open_time', 'startedAt', 'startAt', 'start_date']))
  const endTime = timestamp(firstValue(source, ['endTime', 'end_time', 'eventEnd', 'event_end', 'endTimestamp', 'end_timestamp', 'expireTime', 'expire_time', 'expirationTime', 'expiration_time', 'settlementTime', 'settlement_time', 'settleTime', 'settle_time', 'deadline', 'endsAt', 'endAt', 'end_date']))
  return startTime && endTime && endTime > startTime ? { startTime, endTime } : undefined
}

function childOutcomeSources(source: JsonRecord): Array<{ value: JsonRecord; fallback?: string }> {
  const result: Array<{ value: JsonRecord; fallback?: string }> = []
  for (const key of ['outcomes', 'contracts', 'selections', 'symbols', 'options']) {
    const values = source[key]
    if (Array.isArray(values)) {
      for (const value of values) {
        const parsed = record(value)
        if (parsed) result.push({ value: parsed })
      }
    }
  }
  for (const key of ['up', 'down', 'call', 'put', 'UP', 'DOWN']) {
    const parsed = record(source[key])
    if (parsed) result.push({ value: parsed, fallback: key })
  }
  return result
}

interface GateParseContext {
  pageUrl?: string
  sourceUrl?: string
}

function urlContext(context: GateParseContext): { duration?: 5 | 15; marketId?: string; isBtc?: boolean; outcomeDirection?: Direction; pageOutcomeDirection?: Direction } {
  const raw = `${context.pageUrl ?? ''}\n${context.sourceUrl ?? ''}`
  const durationMatch = raw.match(/btc(?:[-_]?up[-_]?down)?[-_](5|15)m/i)
  const duration = durationMatch ? Number(durationMatch[1]) as 5 | 15 : undefined
  const isBtc = /btc/i.test(raw)
  const parsedUrl = (value?: string): URL | undefined => {
    try { return value ? new URL(value) : undefined } catch { return undefined }
  }
  const source = parsedUrl(context.sourceUrl)
  const page = parsedUrl(context.pageUrl)
  const marketId = source?.searchParams.get('event_id') ?? source?.searchParams.get('eventId') ??
    page?.searchParams.get('eventId') ?? page?.searchParams.get('event_id') ?? undefined
  // Only the REST request URL's outcome parameter identifies the returned
  // book. The page's selected outcome must not be applied to both compact
  // WebSocket asset streams.
  const rawOutcome = source?.searchParams.get('outcome') ?? source?.searchParams.get('side') ??
    source?.searchParams.get('direction') ?? source?.searchParams.get('result') ?? undefined
  const outcomeDirection = rawOutcome ? direction({}, rawOutcome) : undefined
  const rawPageOutcome = page?.searchParams.get('outcome') ?? page?.searchParams.get('side') ??
    page?.searchParams.get('direction') ?? page?.searchParams.get('result') ?? undefined
  const pageOutcomeDirection = rawPageOutcome ? direction({}, rawPageOutcome) : undefined
  return { duration, marketId, isBtc, outcomeDirection, pageOutcomeDirection }
}

export function parseGateMarketObject(source: JsonRecord, receivedAt: number, context: GateParseContext = {}): GateMarketContext | undefined {
  const pageContext = urlContext(context)
  const fallbackMarketKey = stringValue(firstValue(source, ['market', 'mk']))
  const id = marketId(source) ?? pageContext.marketId ?? fallbackMarketKey
  let range = timeRange(source)
  const parsedAsset = asset(source) ?? (pageContext.isBtc ? 'BTC/USD' : undefined)
  const parsedDuration = durationMinutes(source, range?.startTime, range?.endTime) ?? pageContext.duration
  // Some Gate deployments expose the event id and prices in a WebSocket
  // frame, while the time range only exists in the page route. Infer the
  // currently aligned slot only in that explicit BTC 5m/15m page context;
  // never manufacture a market from an unqualified price frame.
  if (!range && parsedDuration && pageContext.isBtc && (pageContext.duration || pageContext.marketId)) {
    const slotMs = parsedDuration * 60_000
    const startTime = Math.floor(receivedAt / slotMs) * slotMs
    range = { startTime, endTime: startTime + slotMs }
  }
  if (!id || !range || !parsedAsset || !parsedDuration) return undefined
  if (Math.abs(range.endTime - range.startTime - parsedDuration * 60_000) > 1_000) {
    range = { startTime: range.endTime - parsedDuration * 60_000, endTime: range.endTime }
  }
  const outcomes: Partial<Record<Direction, ReadOnlyOutcomeQuote>> = {}
  const catalogTokens = catalogOutcomeIds(source)
  const upPrice = decimal(firstValue(source, ['bullish', 'best_ask', 'outcome_price0']))
  const downPrice = decimal(firstValue(source, ['bearish', 'best_ask_token1', 'outcome_price1']))
  if (upPrice) outcomes.UP = { direction: 'UP', outcomeId: catalogTokens.UP ?? 'UP', bestAsk: upPrice, askSize: '0', levels: [], receivedAt }
  if (downPrice) outcomes.DOWN = { direction: 'DOWN', outcomeId: catalogTokens.DOWN ?? 'DOWN', bestAsk: downPrice, askSize: '0', levels: [], receivedAt }
  const gateMarket = Array.isArray(source.markets) ? record(source.markets[0]) : undefined
  if (gateMarket) {
    const marketTokens = catalogOutcomeIds(source)
    const gateUp = decimal(firstValue(gateMarket, ['best_ask', 'outcome_price0']))
    const gateDown = decimal(firstValue(gateMarket, ['best_ask_token1', 'outcome_price1']))
    if (gateUp) outcomes.UP = { direction: 'UP', outcomeId: marketTokens.UP ?? 'UP', bestAsk: gateUp, askSize: '0', levels: [], receivedAt }
    if (gateDown) outcomes.DOWN = { direction: 'DOWN', outcomeId: marketTokens.DOWN ?? 'DOWN', bestAsk: gateDown, askSize: '0', levels: [], receivedAt }
  }
  for (const candidate of childOutcomeSources(source)) {
    const quote = outcomeQuote(candidate.value, candidate.fallback, receivedAt)
    if (quote) outcomes[quote.direction] = quote
  }
  // Gate's /event-contract/book response carries the direction only in the
  // request query while its body carries the actual asset_id and asks. Apply
  // the URL direction only to an object that contains a book, never to nested
  // price/size rows walked later.
  const direct = outcomeQuote(source, askLevels(source).length ? pageContext.outcomeDirection : undefined, receivedAt)
  if (direct) outcomes[direct.direction] = direct
  return { marketId: id, asset: parsedAsset, durationMinutes: parsedDuration, ...range, outcomes, catalogOutcomeIds: catalogTokens }
}

function walk(value: unknown, visitor: (value: JsonRecord) => void): void {
  const queue: unknown[] = [value]
  let head = 0
  let visited = 0
  // Do not use Array.shift() here: a busy Gate WebSocket stream can make
  // this parser visit thousands of nodes, and shift() repeatedly moves the
  // remaining queue. A head cursor keeps traversal linear.
  while (head < queue.length && visited < MAX_WALK_OBJECTS) {
    const current = queue[head++]
    if (!current || typeof current !== 'object') continue
    visited += 1
    if (Array.isArray(current)) {
      queue.push(...current)
      continue
    }
    const parsed = current as JsonRecord
    visitor(parsed)
    queue.push(...Object.values(parsed))
  }
}

function toWindow(context: GateMarketContext): ReadOnlyWindowQuote | undefined {
  if (!context.outcomes.UP || !context.outcomes.DOWN) return undefined
  return {
    venueId: 'GATE',
    marketId: context.marketId,
    asset: context.asset,
    durationMinutes: context.durationMinutes,
    startTime: context.startTime,
    endTime: context.endTime,
    feeVerified: false,
    resolution: {
      asset: context.asset,
      startTime: context.startTime,
      endTime: context.endTime,
      baselineSource: 'CHAINLINK:BTC/USD_START_TARGET',
      settlementSource: 'CHAINLINK:BTC/USD_TWAP',
      observationMethod: 'Gate event contract start target versus Chainlink BTC/USD TWAP at expiry',
      comparisonOperator: 'GTE',
      tieOutcome: 'UP',
      voidRule: 'Gate event contract specification',
      staleDataRule: 'Gate event contract specification',
      timezone: 'UTC',
      ruleVersion: 'gate-event-contract-chainlink-twap-v1',
      evidenceUrl: 'https://www.gate.com/trade-events'
    },
    outcomes: context.outcomes
  }
}

export class GateMarketData implements ReadOnlyVenueSource {
  readonly venueId = 'GATE'
  private monitoringEnabled = true
  private status: ReadOnlyVenueStatus = { connectionState: 'NOT_CONFIGURED', message: '等待 Gate 单页面被动行情', marketCount: 0 }
  private contexts = new Map<string, GateMarketContext>()
  private outcomeToMarket = new Map<string, { marketId: string; direction: Direction }>()
  /** REST /book asset IDs are the same compact `aid` used by Gate's WS. */
  private assetIdToMarket = new Map<string, GateBookHashBinding | null>()
  private bookHashToMarket = new Map<string, GateBookHashBinding>()
  /** A market key is usable only when it has been observed for one side. */
  private marketKeyToMarket = new Map<string, GateBookHashBinding | null>()
  /** Gate's live WS uses one shared `mk` for both outcomes. Keep its market
   * binding separate from the older directional market-key map. */
  private websocketMarketToMarket = new Map<string, { marketId: string; endTime: number }>()
  private websocketMarketTokens = new Map<string, Partial<Record<Direction, string>>>()
  private subscriptionTokensByMarket = new Map<string, GateSubscriptionPair>()
  private snapshot: ReadOnlyWindowQuote[] = []
  private startPromise?: Promise<void>
  private capturedAccount: { openOrderCount?: number; positionCount?: number; updatedAt?: number } = {}
  private listeners = new Set<() => void>()
  private pipelineStats = new Map<5 | 15, GatePipelineStats>()
  private lastPipelineOnlyEmitAt = 0

  constructor(
    private readonly pageCapture: GatePageCaptureSource,
    private readonly options: { autoStartPageCapture?: boolean } = {}
  ) {
    pageCapture.onResponse((event) => this.ingest(event.body, event.receivedAt, 'REST', event.url, event.pageUrl))
    pageCapture.onWebSocketFrame((event) => {
      if (event.direction === 'SENT') this.captureOrderbookSubscription(event.payload, event.pageUrl, event.receivedAt)
      if (event.direction !== 'SENT') this.ingest(event.payload, event.receivedAt, 'WebSocket', event.url, event.pageUrl)
    })
    pageCapture.onStatus((captureStatus) => {
      this.status = {
        connectionState: captureStatus.state === 'CONNECTED' ? 'CONNECTED' : captureStatus.state === 'IDLE' ? 'NOT_CONFIGURED' : 'DISCONNECTED',
        message: `${captureStatus.message}${this.snapshot.length ? `；已形成 ${this.snapshot.length} 个 BTC 5m/15m 可比较盘口` : '；等待页面返回完整双向盘口'}`,
        marketCount: this.snapshot.length,
        updatedAt: captureStatus.updatedAt
      }
      this.emit()
    })
  }

  getStatus(): ReadOnlyVenueStatus { return { ...this.status } }
  getLatestWindows(): ReadOnlyWindowQuote[] { return this.snapshot }
  getCapturedAccountSnapshot(): { openOrderCount?: number; positionCount?: number; updatedAt?: number } { return { ...this.capturedAccount } }
  onMarketData(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  setMonitoringEnabled(enabled: boolean): void {
    if (this.monitoringEnabled === enabled) return
    this.monitoringEnabled = enabled
    if (!enabled) this.stopPageCapture()
  }

  async openPageCapture(): Promise<void> { await this.pageCapture.start(true) }
  stopPageCapture(): void {
    this.pageCapture.stop()
    this.contexts.clear()
    this.outcomeToMarket.clear()
    this.assetIdToMarket.clear()
    this.bookHashToMarket.clear()
    this.marketKeyToMarket.clear()
    this.websocketMarketToMarket.clear()
    this.websocketMarketTokens.clear()
    this.subscriptionTokensByMarket.clear()
    this.pipelineStats.clear()
    this.snapshot = []
    this.emit()
  }
  getPageCaptureStatus() { return this.pageCapture.getStatus() }

  async fetchWindows(): Promise<ReadOnlyWindowQuote[]> {
    if (!this.monitoringEnabled) return []
    this.pruneExpiredContexts(Date.now())
    const captureState = this.pageCapture.getStatus().state
    if (this.options.autoStartPageCapture === false && captureState !== 'CONNECTED' && captureState !== 'STARTING') {
      this.status = {
        ...this.status,
        connectionState: 'NOT_CONFIGURED',
        message: 'Gate 被动页面未启动；点击“打开 Gate 页面”后开始监听',
        marketCount: this.snapshot.length
      }
      return this.snapshot
    }
    if (!this.startPromise) this.startPromise = this.pageCapture.start(false).finally(() => { this.startPromise = undefined })
    await this.startPromise
    return this.snapshot
  }

  ingest(payload: string, receivedAt = Date.now(), transport = '页面', sourceUrl = '', pageUrl = ''): void {
    if (!this.monitoringEnabled) return
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      return
    }
    this.captureAccountCounts(parsed, sourceUrl, receivedAt)
    const streamContext = transport === 'WebSocket' ? urlContext({ pageUrl, sourceUrl }) : {}
    let changed = transport === 'WebSocket'
      ? this.refreshObservedAt(streamContext.duration, streamContext.marketId, receivedAt)
      : false
    let observedPipeline = false
    const frameDuration = transport === 'WebSocket' ? urlContext({ pageUrl, sourceUrl }).duration : undefined
    const restDuration = transport === 'REST' ? urlContext({ pageUrl, sourceUrl }).duration : undefined
    const isBookRest = transport === 'REST' && /\/event-contract\/book(?:$|\?)/i.test(sourceUrl)
    walk(parsed, (item) => {
      const restHash = isBookRest ? stringValue(firstValue(item, ['hash', 'book_hash', 'orderbook_hash'])) : undefined
      const requestDirection = urlContext({ pageUrl, sourceUrl }).outcomeDirection
      const hasRestBookPayload = isBookRest && (restHash !== undefined ||
        firstValue(item, ['asset_id', 'assetId', 'asks', 'bids']) !== undefined)
      if (restDuration && hasRestBookPayload) {
        const stats = this.pipelineStats.get(restDuration) ?? this.newPipelineStats()
        stats.restBookResponses += 1
        if (restHash) stats.restBookHashes += 1
        if (requestDirection) stats.restBookDirections += 1
        const restAssetId = stringValue(firstValue(item, ['asset_id', 'assetId']))
        if (restAssetId) {
          stats.restAssetIds.add(restAssetId)
          while (stats.restAssetIds.size > 128) stats.restAssetIds.delete(stats.restAssetIds.values().next().value!)
        }
        this.pipelineStats.set(restDuration, stats)
      }
      const market = parseGateMarketObject(item, receivedAt, { pageUrl, sourceUrl })
      if (market) {
        const marketKey = stringValue(firstValue(item, ['market', 'market_id', 'marketId', 'mk']))
        const bookHash = restHash
        if (bookHash && requestDirection) {
          this.bookHashToMarket.set(bookHash, { marketId: market.marketId, direction: requestDirection, endTime: market.endTime })
          while (this.bookHashToMarket.size > 128) {
            const oldest = this.bookHashToMarket.keys().next().value
            if (oldest) this.bookHashToMarket.delete(oldest)
            else break
          }
        }
        if (marketKey && requestDirection) {
          const binding = { marketId: market.marketId, direction: requestDirection, endTime: market.endTime }
          const existing = this.marketKeyToMarket.get(marketKey)
          if (existing === undefined) this.marketKeyToMarket.set(marketKey, binding)
          else if (existing && (existing.marketId !== binding.marketId || existing.direction !== binding.direction)) this.marketKeyToMarket.set(marketKey, null)
          while (this.marketKeyToMarket.size > 128) {
            const oldest = this.marketKeyToMarket.keys().next().value
            if (oldest) this.marketKeyToMarket.delete(oldest)
            else break
          }
        }
        const restAssetId = isBookRest ? stringValue(firstValue(item, ['asset_id', 'assetId'])) : undefined
        if (restAssetId && requestDirection) {
          const binding = { marketId: market.marketId, direction: requestDirection, endTime: market.endTime }
          const existing = this.assetIdToMarket.get(restAssetId)
          // A single asset ID is normally one outcome. If Gate returns the
          // same ID for both sides, mark it ambiguous and let hash/mk mapping
          // win instead of guessing a direction.
          if (existing && existing.marketId === binding.marketId && existing.direction !== binding.direction) {
            this.assetIdToMarket.set(restAssetId, null)
          } else {
            this.assetIdToMarket.set(restAssetId, binding)
          }
          while (this.assetIdToMarket.size > 128) {
            const oldest = this.assetIdToMarket.keys().next().value
            if (oldest) this.assetIdToMarket.delete(oldest)
            else break
          }
        }
        const previous = this.contexts.get(market.marketId)
        this.contexts.set(market.marketId, previous ? {
          ...previous,
          ...market,
          outcomes: { ...previous.outcomes, ...market.outcomes },
          catalogOutcomeIds: { ...previous.catalogOutcomeIds, ...market.catalogOutcomeIds }
        } : market)
        for (const quote of Object.values(market.outcomes)) {
          if (quote) this.outcomeToMarket.set(quote.outcomeId, { marketId: market.marketId, direction: quote.direction })
        }
        // The catalogue token IDs are authoritative even when the catalogue
        // has no valid ask on one side (Gate often reports 1.0 there). This is
        // what lets compact WebSocket `aid` updates provide the first depth.
        const catalogTokens = market.catalogOutcomeIds ?? {}
        for (const [direction, outcomeId] of Object.entries(catalogTokens) as Array<[Direction, string | undefined]>) {
          if (outcomeId) this.outcomeToMarket.set(outcomeId, { marketId: market.marketId, direction })
        }
        changed = true
      }
      const explicitTokenId = stringValue(firstValue(item, [
        'tokenId', 'token_id', 'clobTokenId', 'clob_token_id', 'assetId', 'asset_id',
        'symbolId', 'symbol_id', 'outcomeId', 'outcome_id', 'contractTokenId', 'contract_token_id', 'aid'
      ]))
      // Gate's event socket has used market_id for the individual outcome
      // token in some page releases. Only accept it when it matches a token
      // learned from the event catalogue, so an event id cannot be confused
      // with an outcome id.
      const possibleMarketTokenId = stringValue(firstValue(item, ['marketId', 'market_id', 'id']))
      const tokenId = explicitTokenId ?? (possibleMarketTokenId && this.outcomeToMarket.has(possibleMarketTokenId) ? possibleMarketTokenId : undefined)
      const tokenContext = tokenId
        ? this.outcomeToMarket.get(tokenId) ?? this.inferSubscribedTokenContext(tokenId, pageUrl, item, receivedAt)
        : undefined
      const bookHash = stringValue(firstValue(item, ['h', 'hash', 'book_hash', 'orderbook_hash']))
      const hashContext = bookHash ? this.bookHashToMarket.get(bookHash) : undefined
      const marketKey = stringValue(firstValue(item, ['mk', 'market', 'market_id', 'marketId']))
      const marketKeyContext = marketKey ? this.marketKeyToMarket.get(marketKey) ?? undefined : undefined
      const assetIdContext = explicitTokenId ? this.assetIdToMarket.get(explicitTokenId) ?? undefined : undefined
      const hasBookFields = item.a !== undefined || item.b !== undefined || item.asks !== undefined || item.bids !== undefined
      // The hash belongs to this exact book update and is authoritative when
      // present; an aid cache can survive a round rotation or be recycled by
      // Gate, so it is only a fallback when the frame has no hash.
      let resolvedTokenContext = hashContext ?? tokenContext ?? assetIdContext ?? marketKeyContext
      if (!resolvedTokenContext && marketKey && explicitTokenId && hasBookFields) {
        resolvedTokenContext = this.inferWebsocketMarketTokenContext(marketKey, explicitTokenId, item)
      }
      if (explicitTokenId && hashContext) {
        this.outcomeToMarket.set(explicitTokenId, { marketId: hashContext.marketId, direction: hashContext.direction })
      }
      if (frameDuration && explicitTokenId && hasBookFields) {
        const stats = this.pipelineStats.get(frameDuration) ?? this.newPipelineStats()
        stats.rawBookFrames += 1
        stats.lastRawBookAt = receivedAt
        if (bookHash) {
          stats.websocketHashes += 1
          if (hashContext) stats.websocketHashMatches += 1
        }
        stats.websocketAids += 1
        // Count only a real outcome binding. `restAssetIds` is kept for
        // diagnostics, but membership alone does not tell us the market or
        // direction and used to make this counter look healthy while frames
        // were still being dropped as unmapped.
        if (tokenContext || assetIdContext) stats.websocketAidMatches += 1
        if (marketKey) {
          stats.websocketMarketKeys += 1
          if (marketKeyContext) stats.websocketMarketKeyMatches += 1
          else if (this.websocketMarketToMarket.has(marketKey)) stats.websocketMarketKeyMatches += 1
        }
        if (resolvedTokenContext) {
          stats.mappedBookFrames += 1
          stats.lastMappedBookAt = receivedAt
        } else {
          stats.unmappedBookFrames += 1
        }
        this.pipelineStats.set(frameDuration, stats)
        observedPipeline = true
      }
      if (resolvedTokenContext) {
        const context = this.contexts.get(resolvedTokenContext.marketId)
        if (marketKey && context) {
          this.websocketMarketToMarket.set(marketKey, { marketId: context.marketId, endTime: context.endTime })
          const token = tokenId ?? explicitTokenId
          if (token) {
            const tokens = this.websocketMarketTokens.get(marketKey) ?? {}
            tokens[resolvedTokenContext.direction] = token
            this.websocketMarketTokens.set(marketKey, tokens)
          }
        }
        const levels = askLevels(item)
        if (context && levels.length) {
          context.outcomes[resolvedTokenContext.direction] = {
            direction: resolvedTokenContext.direction, outcomeId: tokenId ?? explicitTokenId!, bestAsk: levels[0].price, askSize: levels[0].size,
            levels, receivedAt
          }
          if (frameDuration) this.notePipelineQuoteUpdate(frameDuration, receivedAt)
          changed = true
        } else if (context && context.outcomes[resolvedTokenContext.direction] && isExplicitEmptyBookFrame(item)) {
          // Gate sends incremental order-book frames with empty `a`/`b`
          // arrays when no ask level changed. They are still live updates;
          // retain the last known ask while advancing freshness so a quiet
          // side is not incorrectly marked stale after the global 8s cutoff.
          context.outcomes[resolvedTokenContext.direction] = {
            ...context.outcomes[resolvedTokenContext.direction]!,
            receivedAt
          }
          if (frameDuration) this.notePipelineQuoteUpdate(frameDuration, receivedAt)
          changed = true
        } else if (context && hasZeroAskUpdate(item)) {
          // A zero-size ask is a deletion, not a heartbeat. Be conservative
          // when only a delta is available: remove the cached quote instead
          // of presenting an old price/depth as fresh.
          delete context.outcomes[resolvedTokenContext.direction]
          changed = true
        }
      }
      const id = marketId(item)
      if (!id) return
      const context = this.contexts.get(id)
      if (!context) return
      const quote = outcomeQuote(item, undefined, receivedAt)
      if (!quote) return
      context.outcomes[quote.direction] = quote
      changed = true
    })
    if (!changed) {
      if (observedPipeline && receivedAt - this.lastPipelineOnlyEmitAt >= 500) {
        this.lastPipelineOnlyEmitAt = receivedAt
        this.status = {
          ...this.status,
          connectionState: 'CONNECTED',
          updatedAt: receivedAt,
          message: `Gate WebSocket 原始帧在线但尚未形成新盘口；${this.pipelineStatusMessage(Date.now())}`
        }
        this.emit()
      }
      return
    }
    const now = Date.now()
    this.pruneExpiredContexts(now)
    this.snapshot = [...this.contexts.values()]
      .filter((context) => context.endTime > now)
      .map(toWindow)
      .filter((value): value is ReadOnlyWindowQuote => Boolean(value))
      .sort((left, right) => left.startTime - right.startTime || left.durationMinutes - right.durationMinutes)
    this.status = {
      connectionState: 'CONNECTED',
      message: `Gate ${transport}被动行情已解析；${this.snapshot.length} 个 BTC 5m/15m 双向盘口；${this.pipelineStatusMessage(now)}；未额外请求接口`,
      marketCount: this.snapshot.length,
      updatedAt: receivedAt
    }
    this.emit()
  }

  private pruneExpiredContexts(now: number): void {
    let changed = false
    for (const [marketId, context] of this.contexts) {
      if (context.endTime > now) continue
      this.contexts.delete(marketId)
      for (const quote of Object.values(context.outcomes)) {
        if (quote && this.outcomeToMarket.get(quote.outcomeId)?.marketId === marketId) this.outcomeToMarket.delete(quote.outcomeId)
      }
      for (const outcomeId of Object.values(context.catalogOutcomeIds ?? {})) {
        if (outcomeId && this.outcomeToMarket.get(outcomeId)?.marketId === marketId) this.outcomeToMarket.delete(outcomeId)
      }
      for (const [bookHash, binding] of this.bookHashToMarket) {
        if (binding.marketId === marketId) this.bookHashToMarket.delete(bookHash)
      }
      for (const [assetId, binding] of this.assetIdToMarket) {
        if (binding?.marketId === marketId) this.assetIdToMarket.delete(assetId)
      }
      for (const [marketKey, binding] of this.marketKeyToMarket) {
        if (binding?.marketId === marketId) this.marketKeyToMarket.delete(marketKey)
      }
      for (const [marketKey, binding] of this.websocketMarketToMarket) {
        if (binding.marketId === marketId) {
          this.websocketMarketToMarket.delete(marketKey)
          this.websocketMarketTokens.delete(marketKey)
        }
      }
      this.subscriptionTokensByMarket.delete(marketId)
      changed = true
    }
    if (!changed) return
    this.snapshot = this.snapshot.filter((window) => window.endTime > now)
    this.status = {
      ...this.status,
      marketCount: this.snapshot.length,
      message: this.snapshot.length > 0
        ? this.status.message
        : `${this.pageCapture.getStatus().message}；上一轮已结束，等待当前轮次盘口`
    }
    this.emit()
  }

  private emit(): void { for (const listener of this.listeners) listener() }

  private refreshObservedAt(duration: 5 | 15 | undefined, marketId: string | undefined, observedAt: number): boolean {
    if (!duration) return false
    let changed = false
    for (const context of this.contexts.values()) {
      if (context.durationMinutes !== duration || (marketId && context.marketId !== marketId)) continue
      for (const direction of ['UP', 'DOWN'] as const) {
        const quote = context.outcomes[direction]
        if (!quote || (quote.observedAt ?? quote.receivedAt) >= observedAt) continue
        context.outcomes[direction] = { ...quote, observedAt }
        changed = true
      }
    }
    return changed
  }

  private pipelineStatusMessage(now: number): string {
    return ([5, 15] as const).map((duration) => {
      const stats = this.pipelineStats.get(duration)
      const rawAge = stats?.lastRawBookAt === undefined ? '无' : `${((Math.max(0, now - stats.lastRawBookAt)) / 1_000).toFixed(1)}秒`
      const mappedAge = stats?.lastMappedBookAt === undefined ? '无' : `${((Math.max(0, now - stats.lastMappedBookAt)) / 1_000).toFixed(1)}秒`
      const quoteAge = stats?.lastQuoteUpdateAt === undefined ? '无' : `${((Math.max(0, now - stats.lastQuoteUpdateAt)) / 1_000).toFixed(1)}秒`
      const rest = stats ? `REST hash ${stats.restBookHashes}/${stats.restBookResponses}·方向${stats.restBookDirections}` : 'REST hash 无'
      const ws = stats ? `WS h ${stats.websocketHashes}·命中${stats.websocketHashMatches} / aid ${stats.websocketAids}·命中${stats.websocketAidMatches} / mk ${stats.websocketMarketKeys}·命中${stats.websocketMarketKeyMatches}` : 'WS h 无'
      return `${duration}m 原始WS ${rawAge} / 映射${mappedAge} / 盘口${quoteAge} / 未映射${stats?.unmappedBookFrames ?? 0} / ${rest} / ${ws}`
    }).join('；')
  }

  private notePipelineQuoteUpdate(duration: 5 | 15, receivedAt: number): void {
    const stats = this.pipelineStats.get(duration) ?? this.newPipelineStats()
    stats.lastQuoteUpdateAt = receivedAt
    this.pipelineStats.set(duration, stats)
  }

  private newPipelineStats(): GatePipelineStats {
    return {
      rawBookFrames: 0, mappedBookFrames: 0, unmappedBookFrames: 0,
      restBookResponses: 0, restBookHashes: 0, restBookDirections: 0,
      websocketHashes: 0, websocketHashMatches: 0,
      restAssetIds: new Set<string>(), websocketAids: 0, websocketAidMatches: 0,
      websocketMarketKeys: 0, websocketMarketKeyMatches: 0
    }
  }

  private inferWebsocketMarketTokenContext(marketKey: string, tokenId: string, item: JsonRecord): { marketId: string; direction: Direction } | undefined {
    const binding = this.websocketMarketToMarket.get(marketKey)
    const context = binding ? this.contexts.get(binding.marketId) : undefined
    if (!binding || !context || context.endTime <= Date.now()) return undefined
    const knownTokens = this.websocketMarketTokens.get(marketKey) ?? {}
    if (knownTokens.UP === tokenId) return { marketId: binding.marketId, direction: 'UP' }
    if (knownTokens.DOWN === tokenId) return { marketId: binding.marketId, direction: 'DOWN' }
    const knownDirection = (Object.entries(knownTokens) as Array<[Direction, string | undefined]>).find(([, knownToken]) => Boolean(knownToken && knownToken !== tokenId))?.[0]
    const levels = askLevels(item)
    const bestAsk = Number(levels[0]?.price)
    const upAsk = Number(context.outcomes.UP?.bestAsk)
    const downAsk = Number(context.outcomes.DOWN?.bestAsk)
    let inferredDirection: Direction | undefined
    if (Number.isFinite(bestAsk) && Number.isFinite(upAsk) && Number.isFinite(downAsk)) {
      const upDistance = Math.abs(bestAsk - upAsk)
      const downDistance = Math.abs(bestAsk - downAsk)
      if (Math.min(upDistance, downDistance) <= 0.05 && Math.abs(upDistance - downDistance) >= 0.02) {
        inferredDirection = upDistance < downDistance ? 'UP' : 'DOWN'
      }
    }
    if (!inferredDirection && knownDirection) inferredDirection = knownDirection === 'UP' ? 'DOWN' : 'UP'
    if (!inferredDirection) return undefined
    this.outcomeToMarket.set(tokenId, { marketId: binding.marketId, direction: inferredDirection })
    const tokens = this.websocketMarketTokens.get(marketKey) ?? {}
    tokens[inferredDirection] = tokenId
    this.websocketMarketTokens.set(marketKey, tokens)
    return { marketId: binding.marketId, direction: inferredDirection }
  }

  private captureOrderbookSubscription(payload: string, pageUrl: string | undefined, receivedAt: number): void {
    let message: JsonRecord | undefined
    try { message = record(JSON.parse(payload)) } catch { return }
    if (!message || !/orderbook/i.test(String(message.channel ?? ''))) return
    const event = String(message.event ?? '').toLowerCase()
    if (event !== 'subscribe' && event !== 'unsubscribe') return
    const tokens = Array.isArray(message.payload) ? message.payload.map(stringValue).filter((value): value is string => Boolean(value)) : []
    if (!tokens.length) return
    if (event === 'unsubscribe') {
      for (const token of tokens) {
        for (const [marketId, pair] of this.subscriptionTokensByMarket) {
          if (!pair.tokens.includes(token)) continue
          pair.tokens = pair.tokens.filter((candidate) => candidate !== token)
          if (!pair.tokens.length) this.subscriptionTokensByMarket.delete(marketId)
          const mapping = this.outcomeToMarket.get(token)
          if (mapping?.marketId === marketId) this.outcomeToMarket.delete(token)
        }
      }
      return
    }
    const marketId = urlContext({ pageUrl }).marketId
    if (!marketId) return
    const pair = this.subscriptionTokensByMarket.get(marketId) ?? {
      tokens: [], bestAsks: new Map<string, number>(), books: new Map<string, { levels: OrderBookLevel[]; receivedAt: number }>(), updatedAt: receivedAt
    }
    for (const token of tokens) if (!pair.tokens.includes(token)) pair.tokens.push(token)
    pair.tokens = pair.tokens.slice(-2)
    pair.updatedAt = receivedAt
    this.subscriptionTokensByMarket.set(marketId, pair)
    const selectedDirection = urlContext({ pageUrl }).pageOutcomeDirection
    if (selectedDirection) {
      const oppositeDirection: Direction = selectedDirection === 'UP' ? 'DOWN' : 'UP'
      if (pair.tokens[0]) this.outcomeToMarket.set(pair.tokens[0], { marketId, direction: selectedDirection })
      if (pair.tokens[1]) this.outcomeToMarket.set(pair.tokens[1], { marketId, direction: oppositeDirection })
    }
    while (this.subscriptionTokensByMarket.size > 32) {
      const oldest = this.subscriptionTokensByMarket.keys().next().value
      if (oldest) this.subscriptionTokensByMarket.delete(oldest)
      else break
    }
  }

  private inferSubscribedTokenContext(tokenId: string, pageUrl: string, item: JsonRecord, receivedAt: number): { marketId: string; direction: Direction } | undefined {
    const marketId = urlContext({ pageUrl }).marketId
    if (!marketId) return undefined
    const pair = this.subscriptionTokensByMarket.get(marketId)
    if (!pair?.tokens.includes(tokenId)) return undefined
    const currentLevels = askLevels(item)
    const bestAsk = Number(currentLevels[0]?.price)
    if (Number.isFinite(bestAsk)) {
      pair.bestAsks.set(tokenId, bestAsk)
      pair.books.set(tokenId, { levels: currentLevels, receivedAt })
    }
    for (const sibling of pair.tokens) {
      if (sibling === tokenId) continue
      const siblingContext = this.outcomeToMarket.get(sibling)
      if (siblingContext?.marketId !== marketId) continue
      const inferred = { marketId, direction: siblingContext.direction === 'UP' ? 'DOWN' as const : 'UP' as const }
      this.outcomeToMarket.set(tokenId, inferred)
      return inferred
    }
    const context = this.contexts.get(marketId)
    const upAsk = Number(context?.outcomes.UP?.bestAsk)
    const downAsk = Number(context?.outcomes.DOWN?.bestAsk)
    if (!Number.isFinite(bestAsk) || !Number.isFinite(upAsk) || !Number.isFinite(downAsk)) return undefined
    if (pair.tokens.length === 2) {
      const [firstToken, secondToken] = pair.tokens
      const firstAsk = pair.bestAsks.get(firstToken)
      const secondAsk = pair.bestAsks.get(secondToken)
      if (firstAsk !== undefined && secondAsk !== undefined) {
        const directDistances = [Math.abs(firstAsk - upAsk), Math.abs(secondAsk - downAsk)]
        const swappedDistances = [Math.abs(firstAsk - downAsk), Math.abs(secondAsk - upAsk)]
        const directTotal = directDistances[0] + directDistances[1]
        const swappedTotal = swappedDistances[0] + swappedDistances[1]
        const direct = directTotal < swappedTotal
        const winningDistances = direct ? directDistances : swappedDistances
        if (Math.max(...winningDistances) <= 0.05 && Math.abs(directTotal - swappedTotal) >= 0.005) {
          const firstMapping = { marketId, direction: direct ? 'UP' as const : 'DOWN' as const }
          const secondMapping = { marketId, direction: direct ? 'DOWN' as const : 'UP' as const }
          this.outcomeToMarket.set(firstToken, firstMapping)
          this.outcomeToMarket.set(secondToken, secondMapping)
          for (const [mappedToken, mapping] of [[firstToken, firstMapping], [secondToken, secondMapping]] as const) {
            const book = pair.books.get(mappedToken)
            if (!book?.levels.length) continue
            context!.outcomes[mapping.direction] = {
              direction: mapping.direction, outcomeId: mappedToken,
              bestAsk: book.levels[0].price, askSize: book.levels[0].size,
              levels: book.levels, receivedAt: book.receivedAt
            }
          }
          return tokenId === firstToken ? firstMapping : secondMapping
        }
      }
    }
    const upDistance = Math.abs(bestAsk - upAsk)
    const downDistance = Math.abs(bestAsk - downAsk)
    const closest = Math.min(upDistance, downDistance)
    // Gate REST and the forwarded CLOB socket are not sampled atomically.
    // Accept at most five ticks of drift and require a clear two-tick lead;
    // otherwise wait for another frame instead of guessing the outcome.
    if (closest > 0.05 || Math.abs(upDistance - downDistance) < 0.02) return undefined
    const inferred = { marketId, direction: upDistance < downDistance ? 'UP' as const : 'DOWN' as const }
    this.outcomeToMarket.set(tokenId, inferred)
    return inferred
  }

  private captureAccountCounts(payload: unknown, sourceUrl: string, receivedAt: number): void {
    const path = (() => { try { return new URL(sourceUrl).pathname.toLowerCase() } catch { return '' } })()
    const countNamedArray = (pattern: RegExp): number | undefined => {
      let found: number | undefined
      walk(payload, (item) => {
        if (found !== undefined) return
        for (const [key, value] of Object.entries(item)) {
          if (pattern.test(key) && Array.isArray(value)) { found = value.length; return }
        }
      })
      return found
    }
    if (/position|holding/.test(path)) {
      this.capturedAccount.positionCount = countNamedArray(/position|holding|data|list/i)
      this.capturedAccount.updatedAt = receivedAt
    }
    if (/order|entrust/.test(path) && !/order.?book|depth/.test(path)) {
      this.capturedAccount.openOrderCount = countNamedArray(/order|entrust|data|list/i)
      this.capturedAccount.updatedAt = receivedAt
    }
  }
}
