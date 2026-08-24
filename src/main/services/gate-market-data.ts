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

function outcomeQuote(source: JsonRecord, fallbackDirection: string | undefined, receivedAt: number): ReadOnlyOutcomeQuote | undefined {
  const parsedDirection = direction(source, fallbackDirection)
  if (!parsedDirection) return undefined
  const levels = askLevels(source)
  const bestAsk = levels[0]?.price ?? decimal(firstValue(source, ['bestAsk', 'best_ask', 'askPrice', 'ask_price', 'sellPrice', 'sell_price', 'price']))
  const askSize = levels[0]?.size ?? stringValue(firstValue(source, ['askSize', 'ask_size', 'availableQuantity', 'available_quantity', 'quantity', 'qty', 'size']))
  if (!bestAsk || !askSize || Number(askSize) <= 0) return undefined
  const outcomeId = stringValue(firstValue(source, ['outcomeId', 'outcome_id', 'contractId', 'contract_id', 'symbolId', 'symbol_id', 'tokenId', 'token_id', 'assetId', 'asset_id', 'id'])) ?? parsedDirection
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

function urlContext(context: GateParseContext): { duration?: 5 | 15; marketId?: string; isBtc?: boolean } {
  const raw = `${context.pageUrl ?? ''}\n${context.sourceUrl ?? ''}`
  const durationMatch = raw.match(/btc(?:[-_]?up[-_]?down)?[-_](5|15)m/i)
  const duration = durationMatch ? Number(durationMatch[1]) as 5 | 15 : undefined
  const isBtc = /btc/i.test(raw)
  try {
    const page = new URL(context.pageUrl ?? context.sourceUrl ?? '')
    const marketId = page.searchParams.get('eventId') ?? page.searchParams.get('event_id') ?? undefined
    return { duration, marketId, isBtc }
  } catch {
    return { duration, isBtc }
  }
}

export function parseGateMarketObject(source: JsonRecord, receivedAt: number, context: GateParseContext = {}): GateMarketContext | undefined {
  const pageContext = urlContext(context)
  const id = marketId(source) ?? pageContext.marketId
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
  const tokenList = firstValue(source, ['clob_token_ids', 'clobTokenIds', 'tokenIds', 'token_ids'])
  const tokenIds = Array.isArray(tokenList) ? tokenList.map(stringValue) : []
  const upPrice = decimal(firstValue(source, ['bullish', 'best_ask', 'outcome_price0']))
  const downPrice = decimal(firstValue(source, ['bearish', 'best_ask_token1', 'outcome_price1']))
  if (upPrice) outcomes.UP = { direction: 'UP', outcomeId: tokenIds[0] ?? 'UP', bestAsk: upPrice, askSize: '0', levels: [], receivedAt }
  if (downPrice) outcomes.DOWN = { direction: 'DOWN', outcomeId: tokenIds[1] ?? 'DOWN', bestAsk: downPrice, askSize: '0', levels: [], receivedAt }
  const gateMarket = Array.isArray(source.markets) ? record(source.markets[0]) : undefined
  if (gateMarket) {
    const gateTokenList = firstValue(gateMarket, ['clob_token_ids', 'clobTokenIds', 'tokenIds', 'token_ids'])
    const marketTokens = Array.isArray(gateTokenList) ? gateTokenList.map(stringValue) : []
    const gateUp = decimal(firstValue(gateMarket, ['best_ask', 'outcome_price0']))
    const gateDown = decimal(firstValue(gateMarket, ['best_ask_token1', 'outcome_price1']))
    if (gateUp) outcomes.UP = { direction: 'UP', outcomeId: marketTokens[0] ?? stringValue(gateMarket.clob_token_id0) ?? 'UP', bestAsk: gateUp, askSize: '0', levels: [], receivedAt }
    if (gateDown) outcomes.DOWN = { direction: 'DOWN', outcomeId: marketTokens[1] ?? stringValue(gateMarket.clob_token_id1) ?? 'DOWN', bestAsk: gateDown, askSize: '0', levels: [], receivedAt }
  }
  for (const candidate of childOutcomeSources(source)) {
    const quote = outcomeQuote(candidate.value, candidate.fallback, receivedAt)
    if (quote) outcomes[quote.direction] = quote
  }
  const direct = outcomeQuote(source, undefined, receivedAt)
  if (direct) outcomes[direct.direction] = direct
  return { marketId: id, asset: parsedAsset, durationMinutes: parsedDuration, ...range, outcomes }
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
  private snapshot: ReadOnlyWindowQuote[] = []
  private startPromise?: Promise<void>
  private capturedAccount: { openOrderCount?: number; positionCount?: number; updatedAt?: number } = {}
  private listeners = new Set<() => void>()

  constructor(
    private readonly pageCapture: GatePageCaptureSource,
    private readonly options: { autoStartPageCapture?: boolean } = {}
  ) {
    pageCapture.onResponse((event) => this.ingest(event.body, event.receivedAt, 'REST', event.url, event.pageUrl))
    pageCapture.onWebSocketFrame((event) => this.ingest(event.payload, event.receivedAt, 'WebSocket', event.url, event.pageUrl))
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
    let changed = false
    walk(parsed, (item) => {
      const market = parseGateMarketObject(item, receivedAt, { pageUrl, sourceUrl })
      if (market) {
        const previous = this.contexts.get(market.marketId)
        this.contexts.set(market.marketId, previous ? { ...previous, ...market, outcomes: { ...previous.outcomes, ...market.outcomes } } : market)
        for (const quote of Object.values(market.outcomes)) {
          if (quote) this.outcomeToMarket.set(quote.outcomeId, { marketId: market.marketId, direction: quote.direction })
        }
        changed = true
      }
      const explicitTokenId = stringValue(firstValue(item, [
        'tokenId', 'token_id', 'clobTokenId', 'clob_token_id', 'assetId', 'asset_id',
        'symbolId', 'symbol_id', 'outcomeId', 'outcome_id', 'contractTokenId', 'contract_token_id'
      ]))
      // Gate's event socket has used market_id for the individual outcome
      // token in some page releases. Only accept it when it matches a token
      // learned from the event catalogue, so an event id cannot be confused
      // with an outcome id.
      const possibleMarketTokenId = stringValue(firstValue(item, ['marketId', 'market_id', 'id']))
      const tokenId = explicitTokenId ?? (possibleMarketTokenId && this.outcomeToMarket.has(possibleMarketTokenId) ? possibleMarketTokenId : undefined)
      const tokenContext = tokenId ? this.outcomeToMarket.get(tokenId) : undefined
      if (tokenContext) {
        const context = this.contexts.get(tokenContext.marketId)
        const levels = askLevels(item)
        if (context && levels.length) {
          context.outcomes[tokenContext.direction] = {
            direction: tokenContext.direction, outcomeId: tokenId!, bestAsk: levels[0].price, askSize: levels[0].size,
            levels, receivedAt
          }
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
    if (!changed) return
    const now = Date.now()
    this.pruneExpiredContexts(now)
    this.snapshot = [...this.contexts.values()]
      .filter((context) => context.endTime > now)
      .map(toWindow)
      .filter((value): value is ReadOnlyWindowQuote => Boolean(value))
      .sort((left, right) => left.startTime - right.startTime || left.durationMinutes - right.durationMinutes)
    this.status = {
      connectionState: 'CONNECTED',
      message: `Gate ${transport}被动行情已解析；${this.snapshot.length} 个 BTC 5m/15m 双向盘口，未额外请求接口`,
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
