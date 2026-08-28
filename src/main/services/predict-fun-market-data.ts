import type { Direction, OrderBookLevel, PredictFunPageCaptureStatus } from '../../shared/types'
import type { ReadOnlyOutcomeQuote, ReadOnlyVenueSource, ReadOnlyVenueStatus, ReadOnlyWindowQuote } from '../platforms/read-only-types'
import WebSocket, { type ClientOptions, type RawData } from 'ws'
import type { PredictFunCapturedResponse, PredictFunPageCaptureSource } from './predict-fun-page-capture'

const MAINNET_API = 'https://api.predict.fun'
const DISCOVERY_CACHE_MS = 15_000
const SNAPSHOT_CACHE_MS = 4_000
const REST_BOOK_AUDIT_MS = 30_000
const REQUEST_TIMEOUT_MS = 6_000

interface PredictOutcome {
  id?: string
  name?: string
  index?: number
  indexSet?: number
  onChainId?: string
  bestAsk?: { price?: number; size?: number } | null
}

interface PredictMarket {
  id?: number
  feeRateBps?: number
  tradingStatus?: string
  decimalPrecision?: number
  isNegRisk?: boolean
  isYieldBearing?: boolean
  outcomes?: PredictOutcome[]
}

export interface PredictFunPreparationCandidate {
  marketId: string
  outcomeId: string
  direction: Direction
  bestAsk: string
  availableQuantity: string
  feeRateBps: number
  isNegRisk: boolean
  isYieldBearing: boolean
}

export interface PredictFunTradingMetadata {
  feeRateBps: number
  isNegRisk: boolean
  isYieldBearing: boolean
}

interface PredictVariant {
  type?: string
  priceFeedProvider?: string
  priceFeedId?: string
  priceFeedSymbol?: string
}

interface PredictCategory {
  slug?: string
  startsAt?: string
  endsAt?: string
  status?: string
  marketVariant?: string
  resolutionProvider?: string
  description?: string
  variantData?: PredictVariant
  markets?: PredictMarket[]
}

interface PredictCategoriesResponse {
  success?: boolean
  data?: PredictCategory[]
}

interface PredictBookResponse {
  success?: boolean
  data?: {
    marketId?: number
    updateTimestampMs?: number
    asks?: Array<[number, number]>
    bids?: Array<[number, number]>
  }
}

interface PredictStreamMessage {
  type?: string
  requestId?: number
  topic?: string
  data?: unknown
  success?: boolean
  error?: { code?: string; message?: string }
}

interface PredictGraphqlMarketDataEntry {
  marketId?: string
  priceFeedProvider?: string
  priceFeedId?: string
  priceFeedSymbol?: string
}

interface PredictGraphqlCategory {
  id?: string
  slug?: string
  startsAt?: string
  endsAt?: string
  status?: string
  marketVariant?: string
  resolutionProvider?: string
  description?: string
  marketData?: PredictGraphqlMarketDataEntry[] | PredictGraphqlMarketDataEntry
  outcomes?: { edges?: Array<{ node?: PredictOutcome }> } | PredictOutcome[]
  markets?: { edges?: Array<{ node?: PredictGraphqlMarket }> } | PredictGraphqlMarket[]
}

interface PredictGraphqlMarket {
  id?: string | number
  decimalPrecision?: number
  takerFeeBps?: number
  feeRateBps?: number
  isNegRisk?: boolean
  isYieldBearing?: boolean
  isTradingEnabled?: boolean
  tradingStatus?: string
  status?: string
  categorySlug?: string
  marketVariant?: string
  variantData?: PredictVariant
  outcomes?: { edges?: Array<{ node?: PredictOutcome }> } | PredictOutcome[]
  category?: PredictGraphqlCategory
}

function isCryptoCategory(category: PredictGraphqlCategory): boolean {
  const variant = String(category.marketVariant ?? '').toUpperCase()
  if (/CRYPTO.?UP.?DOWN/.test(variant)) return true
  const text = `${category.slug ?? ''} ${category.description ?? ''}`.toUpperCase()
  if (text.includes('BTC') && /UP.?DOWN|HIGHER.?LOWER|RISE.?FALL/.test(text)) return true
  const feeds = Array.isArray(category.marketData) ? category.marketData : category.marketData ? [category.marketData] : []
  return feeds.some((feed) => /BTC(?:USD|USDT)?/i.test(String(feed.priceFeedSymbol ?? '')))
}

function marketDataEntries(category: PredictGraphqlCategory): PredictGraphqlMarketDataEntry[] {
  if (!category.marketData) return []
  return Array.isArray(category.marketData) ? category.marketData : [category.marketData]
}

interface PredictGraphqlCaptureHints {
  requestSlugs: string[]
  requestMarketIds: string[]
  operationName?: string
}

function isNonMarketGraphqlOperation(operationName: string | undefined): boolean {
  return /match|event|log|activity|comment|notification|history|order|position/i.test(String(operationName ?? ''))
}

function hasCompleteGraphqlOutcomes(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const raw = value as { edges?: Array<{ node?: unknown }>; [key: string]: unknown }
  const outcomes = Array.isArray(value)
    ? value
    : Array.isArray(raw.edges)
      ? raw.edges.map((edge) => edge?.node).filter(Boolean)
      : []
  if (outcomes.length < 2) return false
  const directions = new Set(outcomes.map((outcome) => {
    if (!outcome || typeof outcome !== 'object') return undefined
    const item = outcome as PredictOutcome
    return predictOutcomeDirection(item)
  }).filter(Boolean))
  return directions.has('UP') && directions.has('DOWN')
}

function categoriesFromGraphql(body: unknown, hints?: PredictGraphqlCaptureHints): PredictCategory[] {
  const markets = new Map<string, { market: PredictGraphqlMarket; category: PredictGraphqlCategory }>()
  const visited = new Set<object>()
  const walk = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || depth > 10 || visited.has(value)) return
    visited.add(value)
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, depth + 1)
      return
    }
    const candidate = value as PredictGraphqlMarket & PredictGraphqlCategory & Record<string, unknown>
    if (isCryptoCategory(candidate)) {
      const marketNodes = Array.isArray(candidate.markets)
        ? candidate.markets
        : candidate.markets?.edges?.flatMap((edge) => edge.node ? [edge.node] : []) ?? []
      for (const node of marketNodes) {
        if (node.id) markets.set(String(node.id), { market: node, category: candidate })
      }
      // A few page GraphQL operations return the rolling category together
      // with marketData.marketId but omit the nested `markets` connection.
      // Keep that response useful by creating a display-only market shell;
      // a later response carrying outcomes/fees is merged into this context.
      if (marketNodes.length === 0) {
        const marketData = marketDataEntries(candidate).find((entry) => /^\d+$/.test(String(entry.marketId ?? '')))
        if (marketData?.marketId) {
          markets.set(String(marketData.marketId), {
            category: candidate,
            market: {
              id: Number(marketData.marketId),
              tradingStatus: candidate.status,
              status: candidate.status,
              outcomes: Array.isArray(candidate.outcomes)
                ? candidate.outcomes
                : candidate.outcomes?.edges?.flatMap((edge) => edge.node ? [edge.node] : [])
            }
          })
        }
      }
    }
    if (candidate.id && candidate.category && isCryptoCategory(candidate.category) &&
      !Array.isArray(candidate.outcomes) && Array.isArray(candidate.outcomes?.edges)) {
      markets.set(String(candidate.id), { market: candidate, category: candidate.category })
      return
    }
    // Predict's official Market shape is also used by newer page GraphQL
    // responses: the market is standalone and references its rolling category
    // through categorySlug instead of embedding a category object. The
    // official market id is the same id carried by predictOrderbook/{marketId}.
    if (candidate.id && candidate.categorySlug && /btc-updown-(?:5|15)m-\d+/i.test(candidate.categorySlug)) {
      const category: PredictGraphqlCategory = {
        slug: candidate.categorySlug,
        status: candidate.tradingStatus ?? candidate.status,
        marketVariant: candidate.marketVariant ?? candidate.variantData?.type,
        marketData: {
          marketId: String(candidate.id),
          priceFeedProvider: candidate.variantData?.priceFeedProvider,
          priceFeedId: candidate.variantData?.priceFeedId,
          priceFeedSymbol: candidate.variantData?.priceFeedSymbol
        }
      }
      if (isCryptoCategory(category)) markets.set(String(candidate.id), { market: candidate, category })
    }
    const requestSlug = hints?.requestSlugs.find((slug) => /^btc-updown-(?:5|15)m-\d+$/i.test(slug))
    const requestTargetsMarket = !hints || hints.requestMarketIds.length === 0 || hints.requestMarketIds.includes(String(candidate.id))
    // Some page versions only expose the current market through
    // GetMatchEventLog. Treat that response as a directory source only when
    // it contains both directional outcomes; account/order/activity payloads
    // without a complete market shape remain excluded.
    const operationLooksNonMarket = isNonMarketGraphqlOperation(hints?.operationName)
    const completeOutcomes = hasCompleteGraphqlOutcomes(candidate.outcomes)
    if (candidate.id && candidate.outcomes && requestSlug && requestTargetsMarket && (!operationLooksNonMarket || completeOutcomes)) {
      const category: PredictGraphqlCategory = {
        slug: requestSlug,
        status: candidate.tradingStatus ?? candidate.status,
        marketVariant: 'CRYPTO_UP_DOWN',
        marketData: { marketId: String(candidate.id), priceFeedSymbol: 'BTCUSDT' }
      }
      markets.set(String(candidate.id), { market: candidate, category })
    }
    for (const [key, entry] of Object.entries(candidate)) {
      if (key === 'timeseries' || key === 'assetOhlc' || key === 'statistics' || key === 'description') continue
      walk(entry, depth + 1)
    }
  }
  walk(body, 0)
  return [...markets.values()].flatMap(({ market, category }) => {
    // The page's GraphQL Market.id is not guaranteed to be the numeric ID
    // used by the orderbook topic. Crypto categories expose that transport ID
    // explicitly as marketData.marketId; prefer it when present so
    // predictOrderbook/{marketId} maps to the same market the page publishes.
    const marketDataList = marketDataEntries(category)
    const marketData = marketDataList.find((entry) => String(entry.marketId) === String(market.id)) ??
      (marketDataList.length === 1 ? marketDataList[0] : undefined)
    const marketId = Number(marketData?.marketId ?? market.id)
    if (!category || !Number.isFinite(marketId)) return []
    return [{
      slug: category.slug ?? category.id,
      startsAt: category.startsAt,
      endsAt: category.endsAt,
      status: category.status,
      marketVariant: category.marketVariant ?? 'CRYPTO_UP_DOWN',
      resolutionProvider: category.resolutionProvider,
      description: category.description,
      variantData: {
        type: category.marketVariant,
        priceFeedProvider: marketData?.priceFeedProvider,
        priceFeedId: marketData?.priceFeedId,
        priceFeedSymbol: marketData?.priceFeedSymbol
      },
      markets: [{
        id: marketId,
        feeRateBps: market.feeRateBps ?? market.takerFeeBps,
        isNegRisk: market.isNegRisk,
        isYieldBearing: market.isYieldBearing,
        tradingStatus: market.tradingStatus ?? (market.isTradingEnabled !== false && market.status === 'REGISTERED' ? 'OPEN' : market.status),
        decimalPrecision: market.decimalPrecision,
        outcomes: Array.isArray(market.outcomes)
          ? market.outcomes
          : market.outcomes?.edges?.flatMap((edge) => edge.node ? [edge.node] : []) ?? [
          { name: 'Up', onChainId: `predict-page:${marketId}:up` },
          { name: 'Down', onChainId: `predict-page:${marketId}:down` }
          ]
      }]
    }]
  })
}

// Keep only field names from market-like GraphQL objects. This gives us a
// factual schema fingerprint in diagnostics without persisting response
// values, authentication material, or large page payloads.
function graphqlMarketSchemaFingerprints(body: unknown): string[] {
  const fingerprints = new Set<string>()
  const visited = new Set<object>()
  const relevant = new Set([
    'id', 'marketId', 'categorySlug', 'slug', 'tradingStatus', 'status',
    'marketVariant', 'variantData', 'marketData', 'outcomes', 'markets',
    'startsAt', 'endsAt'
  ])
  const walk = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || depth > 10 || visited.has(value) || fingerprints.size >= 3) return
    visited.add(value)
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, depth + 1)
      return
    }
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    const looksLikeMarket = keys.some((key) => ['categorySlug', 'marketId', 'marketVariant', 'variantData', 'marketData', 'outcomes', 'markets'].includes(key)) &&
      keys.some((key) => ['id', 'marketId', 'slug', 'categorySlug'].includes(key))
    if (looksLikeMarket) {
      const safeKeys = keys.filter((key) => relevant.has(key)).sort()
      if (safeKeys.length > 0) fingerprints.add(safeKeys.join('+'))
    }
    for (const entry of Object.values(record)) walk(entry, depth + 1)
  }
  walk(body, 0)
  return [...fingerprints]
}

function levelsFromBook(book: PredictBookResponse, fallback: PredictOutcome | undefined): OrderBookLevel[] {
  const asks = (book.data?.asks ?? [])
    .filter(([price, quantity]) => price > 0 && price < 1 && quantity > 0)
    .map(([price, quantity]) => ({ price: String(price), size: String(quantity) }))
    .sort((left, right) => Number(left.price) - Number(right.price))
  if (asks.length > 0) return asks
  const best = fallback?.bestAsk
  return best && Number(best.price) > 0 && Number(best.size) > 0
    ? [{ price: String(best.price), size: String(best.size) }]
    : []
}

function noLevelsFromYesBook(book: PredictBookResponse, fallback: PredictOutcome | undefined, precision: number): OrderBookLevel[] {
  const factor = 10 ** precision
  const levels = (book.data?.bids ?? [])
    .filter(([price, quantity]) => price > 0 && price < 1 && quantity > 0)
    .map(([price, quantity]) => ({ price: String(Math.round((1 - price) * factor) / factor), size: String(quantity) }))
    .sort((left, right) => Number(left.price) - Number(right.price))
  if (levels.length > 0) return levels
  const best = fallback?.bestAsk
  return best && Number(best.price) > 0 && Number(best.size) > 0
    ? [{ price: String(best.price), size: String(best.size) }]
    : []
}

function outcome(direction: Direction, source: PredictOutcome | undefined, levels: OrderBookLevel[], receivedAt: number, observedAt = receivedAt): ReadOnlyOutcomeQuote | undefined {
  const best = levels[0]
  if (!source?.onChainId || !best) return undefined
  return { direction, outcomeId: source.onChainId, bestAsk: best.price, askSize: best.size, levels, receivedAt, observedAt }
}

function assetSymbol(category: PredictCategory): string {
  return (category.variantData?.priceFeedSymbol ?? `${category.slug ?? ''} ${category.description ?? ''}`)
    .toUpperCase().replace(/[/_-]/g, '')
}

function receivedAtFromBook(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  // A few page/API versions label a Unix-seconds timestamp as
  // updateTimestampMs. Normalize it before the board's freshness check.
  return parsed < 100_000_000_000 ? parsed * 1_000 : parsed
}

function categoryTimestamp(value: unknown): number {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed < 100_000_000_000 ? parsed * 1_000 : parsed
  }
  return Date.parse(String(value ?? ''))
}

function categoryWindowTimes(category: PredictCategory | undefined): { startTime: number; endTime: number } | undefined {
  if (!category) return undefined
  const startsAt = categoryTimestamp(category.startsAt)
  const endsAt = categoryTimestamp(category.endsAt)
  if (Number.isFinite(startsAt) && Number.isFinite(endsAt) && endsAt > startsAt) return { startTime: startsAt, endTime: endsAt }
  // Some page GraphQL payloads omit startsAt/endsAt but retain the canonical
  // rolling slug (btc-updown-{5m|15m}-{unixStart}). Derive the window from
  // that stable identifier instead of discarding an otherwise valid market.
  const match = /(?:^|-)btc-updown-(5|15)m-(\d{9,})/i.exec(String(category.slug ?? ''))
  if (!match) return undefined
  const startTime = Number(match[2]) * 1_000
  const endTime = startTime + Number(match[1]) * 60_000
  return Number.isFinite(startTime) ? { startTime, endTime } : undefined
}

/**
 * A passive page can publish an orderbook before its GraphQL directory query
 * finishes. The page URL itself is an authoritative rolling category slug;
 * bind the observed websocket marketId to that slug so the first live frame
 * is not discarded. This fallback is display-only (synthetic outcome IDs);
 * API-key trading continues to use official market metadata.
 */
function contextFromPassivePageUrl(pageUrl: string | undefined, marketId: string): { category: PredictCategory; market: PredictMarket } | undefined {
  if (!pageUrl || !/^\d+$/.test(marketId)) return undefined
  let pathname = ''
  try { pathname = new URL(pageUrl).pathname } catch { return undefined }
  const match = /\/market\/(btc-updown-(5|15)m-(\d+))(?:$|\/)/i.exec(pathname)
  if (!match) return undefined
  const duration = Number(match[2])
  const start = Number(match[3])
  if (!Number.isFinite(start) || (duration !== 5 && duration !== 15)) return undefined
  const categorySlug = match[1]
  const numericMarketId = Number(marketId)
  return {
    category: {
      slug: categorySlug,
      startsAt: new Date(start * 1_000).toISOString(),
      endsAt: new Date((start + duration * 60) * 1_000).toISOString(),
      status: 'OPEN', marketVariant: 'CRYPTO_UP_DOWN',
      variantData: { type: 'CRYPTO_UP_DOWN', priceFeedSymbol: 'BTCUSDT' }
    },
    market: {
      id: numericMarketId, tradingStatus: 'OPEN', decimalPrecision: 2,
      outcomes: [
        { name: 'Up', index: 1, onChainId: `predict-page:${marketId}:up` },
        { name: 'Down', index: 2, onChainId: `predict-page:${marketId}:down` }
      ]
    }
  }
}

function contextFromRollingDuration(duration: 5 | 15, marketId: string, now: number): { category: PredictCategory; market: PredictMarket } {
  const slotSeconds = duration * 60
  const start = Math.floor(now / (slotSeconds * 1_000)) * slotSeconds
  const categorySlug = `btc-updown-${duration}m-${start}`
  return {
    category: {
      slug: categorySlug,
      startsAt: new Date(start * 1_000).toISOString(),
      endsAt: new Date((start + slotSeconds) * 1_000).toISOString(),
      status: 'OPEN', marketVariant: 'CRYPTO_UP_DOWN',
      variantData: { type: 'CRYPTO_UP_DOWN', priceFeedSymbol: 'BTCUSDT' }
    },
    market: {
      id: Number(marketId), tradingStatus: 'OPEN', decimalPrecision: 2,
      outcomes: [
        { name: 'Up', index: 1, onChainId: `predict-page:${marketId}:up` },
        { name: 'Down', index: 2, onChainId: `predict-page:${marketId}:down` }
      ]
    }
  }
}

function durationFromCategory(category: PredictCategory | undefined): 5 | 15 | undefined {
  const window = categoryWindowTimes(category)
  if (!window) return undefined
  const duration = Math.round((window.endTime - window.startTime) / 60_000)
  return duration === 5 || duration === 15 ? duration : undefined
}

function isOpenStatus(value: string | undefined): boolean {
  return !value || ['OPEN', 'ACTIVE', 'LIVE', 'TRADING', 'REGISTERED'].includes(value.toUpperCase())
}

function predictOutcomeDirection(outcome: PredictOutcome): Direction | undefined {
  if (outcome.indexSet === 1) return 'UP'
  if (outcome.indexSet === 2) return 'DOWN'
  if (outcome.index === 1) return 'UP'
  if (outcome.index === 2) return 'DOWN'
  const name = String(outcome.name ?? '').trim().toUpperCase()
  if (/^(?:UP|YES|RISE|HIGHER|涨|上漲|上涨|升)$/.test(name)) return 'UP'
  if (/^(?:DOWN|NO|FALL|LOWER|跌|下跌|下降|降)$/.test(name)) return 'DOWN'
  return undefined
}

function selectCandidates(categories: PredictCategory[], now: number): Array<{ category: PredictCategory; market: PredictMarket }> {
  return categories
    // Older page/API responses omit marketVariant. The rolling BTC slug is a
    // safe second signal and keeps those markets from being discarded before
    // their actual order book is inspected.
    .filter((category) => {
      const variantText = `${category.marketVariant ?? ''} ${category.slug ?? ''} ${category.description ?? ''} ${category.variantData?.type ?? ''} ${category.variantData?.priceFeedSymbol ?? ''}`
      const window = categoryWindowTimes(category)
      const duration = window ? Math.round((window.endTime - window.startTime) / 60_000) : 0
      const cryptoSignal = /CRYPTO.?UP.?DOWN|BTC.?UP.?DOWN|BTC(?:USD|USDT)?/i.test(variantText)
      return isOpenStatus(category.status) && cryptoSignal && (duration === 5 || duration === 15)
    })
    .filter((category) => /BTC(?:USD|USDT|UPDOWN)?/.test(assetSymbol(category)))
    .filter((category) => {
      const window = categoryWindowTimes(category)
      return Boolean(window && window.endTime > now && window.startTime < now + 16 * 60_000)
    })
    .flatMap((category) => (category.markets ?? [])
      .filter((market) => isOpenStatus(market.tradingStatus))
      .map((market) => ({ category, market })))
    .sort((left, right) => categoryTimestamp(left.category.startsAt) - categoryTimestamp(right.category.startsAt))
    .slice(0, 4)
}

function mergeCapturedCategory(previous: PredictCategory | undefined, incoming: PredictCategory): PredictCategory {
  if (!previous) return incoming
  const previousMarkets = new Map((previous.markets ?? []).filter((market) => market.id).map((market) => [String(market.id), market]))
  const markets = (incoming.markets ?? []).map((market) => {
    const old = market.id ? previousMarkets.get(String(market.id)) : undefined
    return old ? {
      ...old,
      ...market,
      outcomes: market.outcomes ?? old.outcomes
    } : market
  })
  return {
    ...previous,
    ...incoming,
    startsAt: incoming.startsAt ?? previous.startsAt,
    endsAt: incoming.endsAt ?? previous.endsAt,
    status: incoming.status ?? previous.status,
    marketVariant: incoming.marketVariant ?? previous.marketVariant,
    resolutionProvider: incoming.resolutionProvider ?? previous.resolutionProvider,
    description: incoming.description ?? previous.description,
    variantData: { ...(previous.variantData ?? {}), ...(incoming.variantData ?? {}) },
    markets: markets.length > 0 ? markets : previous.markets
  }
}

function parseCategory(category: PredictCategory, market: PredictMarket, book: PredictBookResponse, receivedAt: number, observedAt = receivedAt): ReadOnlyWindowQuote | undefined {
  const window = categoryWindowTimes(category)
  const startTime = window?.startTime ?? Number.NaN
  const endTime = window?.endTime ?? Number.NaN
  const duration = Math.round((endTime - startTime) / 60_000)
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || (duration !== 5 && duration !== 15) || !market.id) return undefined
  // The public page localizes outcome names (for example 涨/跌 on zh-CN),
  // while the stable GraphQL outcome index remains 1=UP and 2=DOWN.
  // Prefer that index and retain multilingual names for older responses.
  const upSource = market.outcomes?.find((candidate) => predictOutcomeDirection(candidate) === 'UP')
  const downSource = market.outcomes?.find((candidate) => predictOutcomeDirection(candidate) === 'DOWN')
  const precision = Number.isInteger(market.decimalPrecision) ? Number(market.decimalPrecision) : 2
  const up = outcome('UP', upSource, levelsFromBook(book, upSource), receivedAt, observedAt)
  const down = outcome('DOWN', downSource, noLevelsFromYesBook(book, downSource, precision), receivedAt, observedAt)
  if (!up && !down) return undefined
  const feedId = category.variantData?.priceFeedId ?? 'unknown'
  const feedSymbol = category.variantData?.priceFeedSymbol ?? 'BTCUSDT'
  return {
    venueId: 'PREDICT_FUN', marketId: String(market.id), asset: 'BTC/USD', durationMinutes: duration,
    startTime, endTime, feeRateBps: Number(market.feeRateBps ?? 0), feeVerified: false,
    resolution: {
      asset: 'BTC/USD', startTime, endTime, baselineSource: `CHAINLINK:${feedId}`,
      settlementSource: `CHAINLINK:${feedId}`, observationMethod: `${feedSymbol} 5m candle close immediately before end`,
      comparisonOperator: 'GT', tieOutcome: 'SPLIT', voidRule: 'Unavailable Chainlink data: consensus of reliable sources',
      staleDataRule: 'Fallback to consensus of reliable sources', timezone: 'UTC',
      ruleVersion: 'predict-crypto-up-down-chainlink-v1', evidenceUrl: `https://predict.fun/market/${market.id}`
    },
    outcomes: { ...(up ? { UP: up } : {}), ...(down ? { DOWN: down } : {}) }
  }
}

export class PredictFunMarketData implements ReadOnlyVenueSource {
  readonly venueId = 'PREDICT_FUN'
  private monitoringEnabled = true
  private status: ReadOnlyVenueStatus = { connectionState: 'NOT_CONFIGURED', message: '等待官方 API Key 或 Predict.fun 单页面被动行情', marketCount: 0 }
  private discovery?: { fetchedAt: number; categories: PredictCategory[] }
  private snapshot?: { fetchedAt: number; windows: ReadOnlyWindowQuote[] }
  private inFlight?: Promise<ReadOnlyWindowQuote[]>
  private lastRestBookAt = 0
  private socket?: WebSocket
  private socketApiKey = ''
  private desiredTopics = new Set<string>()
  private activeTopics = new Set<string>()
  private marketContexts = new Map<string, { category: PredictCategory; market: PredictMarket }>()
  private reconnectTimer?: NodeJS.Timeout
  private reconnectAttempt = 0
  private requestId = 0
  private pendingSubscriptions = new Map<number, { method: 'subscribe' | 'unsubscribe'; topic: string }>()
  private listeners = new Set<() => void>()
  // Passive-page diagnostics are counters only; they do not trigger requests
  // and make it possible to distinguish "no book frames" from "book frames
  // received but not mapped/parsed" in the UI status line.
  private passiveFrameCount = 0
  private passiveOrderbookFrameCount = 0
  private passiveMappedFrameCount = 0
  private passiveUnmappedFrameCount = 0
  private passivePageBoundFrameCount = 0
  private passiveParseRejectedCount = 0
  private passiveGraphqlResponseCount = 0
  private passiveGraphqlMappedCount = 0
  private passiveMarketDetailCount = 0
  private passiveLastMarketPath = ''
  private passiveLastGraphqlSchema = ''
  private passiveLastGraphqlOperation = ''
  private passiveLastGraphqlSlugs = ''
  private passiveLastReason = ''
  private lastPassiveDiagnosticNotifyAt = 0
  private lastDirectoryAt = 0

  constructor(
    private readonly apiKeyProvider: () => Promise<string | undefined>,
    private readonly apiBase = MAINNET_API,
    private readonly options: {
      enableStreaming?: boolean
      autoStartPageCapture?: boolean
      webSocketUrl?: string
      webSocketFactory?: (url: string, options: ClientOptions) => WebSocket
      pageCapture?: PredictFunPageCaptureSource
    } = {}
  ) {
    options.pageCapture?.onResponse((event) => this.ingestCapturedResponse(event))
    options.pageCapture?.onWebSocketFrame((event) => this.ingestCapturedWebSocketFrame(event.payload, event.pageUrl, event.receivedAt))
    options.pageCapture?.onStatus((captureStatus) => {
      if (this.socketApiKey) return
      const parsedSuffix = (this.snapshot?.windows.length ?? 0) > 0
        ? `；已形成 ${this.snapshot?.windows.length ?? 0} 个可比较盘口`
        : this.marketContexts.size > 0
          ? `；已识别 ${this.marketContexts.size} 个 BTC 5m/15m 市场，等待页面盘口推送`
          : ''
      this.status = {
        connectionState: captureStatus.state === 'CONNECTED' ? 'CONNECTED' : captureStatus.state === 'IDLE' ? 'NOT_CONFIGURED' : 'DISCONNECTED',
        message: `${captureStatus.message}${this.passiveDiagnosticsSuffix()}${parsedSuffix}`,
        marketCount: this.snapshot?.windows.length ?? 0,
        updatedAt: captureStatus.updatedAt
      }
      this.emitMarketData()
    })
  }

  getStatus(): ReadOnlyVenueStatus {
    return { ...this.status }
  }

  getLatestWindows(): ReadOnlyWindowQuote[] {
    return this.snapshot?.windows ?? []
  }

  getPreparationCandidate(): PredictFunPreparationCandidate | undefined {
    const windows = this.snapshot?.windows ?? []
    for (const window of windows) {
      const context = this.marketContexts.get(window.marketId)
      const quote = window.outcomes.UP ?? window.outcomes.DOWN
      if (!context || !quote) continue
      return {
        marketId: window.marketId,
        outcomeId: quote.outcomeId,
        direction: quote.direction,
        bestAsk: quote.bestAsk,
        availableQuantity: quote.askSize,
        feeRateBps: Number(context.market.feeRateBps ?? window.feeRateBps ?? 0),
        isNegRisk: Boolean(context.market.isNegRisk),
        isYieldBearing: Boolean(context.market.isYieldBearing)
      }
    }
    return undefined
  }

  getTradingMetadata(marketId: string): PredictFunTradingMetadata | undefined {
    const context = this.marketContexts.get(String(marketId))
    if (!context) return undefined
    return {
      feeRateBps: Number(context.market.feeRateBps ?? 0),
      isNegRisk: Boolean(context.market.isNegRisk),
      isYieldBearing: Boolean(context.market.isYieldBearing)
    }
  }

  onMarketData(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setMonitoringEnabled(enabled: boolean): void {
    if (this.monitoringEnabled === enabled) return
    this.monitoringEnabled = enabled
    if (!enabled) {
      this.stopPageCapture()
      this.status = { connectionState: 'DISCONNECTED', message: 'Predict.fun 监控已暂停，不会主动请求市场数据', marketCount: 0 }
      this.emitMarketData()
    }
  }

  credentialsChanged(): void {
    this.closeMarketStream()
    this.socketApiKey = ''
    this.discovery = undefined
    this.snapshot = undefined
    this.lastRestBookAt = 0
  }

  async openPageCapture(): Promise<void> {
    await this.options.pageCapture?.start(true)
  }

  stopPageCapture(): void {
    this.options.pageCapture?.stop()
    // Keep official API mode untouched. In no-key mode the page is the only
    // source, so remove its old snapshot immediately instead of showing stale
    // opportunities after the user releases the Chromium page.
    if (!this.socketApiKey) {
      this.discovery = undefined
      this.snapshot = undefined
      this.marketContexts.clear()
      this.emitMarketData()
    }
  }

  getPageCaptureStatus(): PredictFunPageCaptureStatus {
    const captureStatus = this.options.pageCapture?.getStatus()
    if (captureStatus) return { ...captureStatus, message: this.status.message }
    return {
      state: 'IDLE',
      message: '当前版本未启用 Predict.fun 网页被动行情'
    }
  }

  async fetchWindows(signal?: AbortSignal): Promise<ReadOnlyWindowQuote[]> {
    if (!this.monitoringEnabled) return []
    const now = Date.now()
    const discoveryFresh = Boolean(this.discovery && now - this.discovery.fetchedAt < DISCOVERY_CACHE_MS)
    if (this.snapshot && (this.socket?.readyState === WebSocket.OPEN ? discoveryFresh : now - this.snapshot.fetchedAt < SNAPSHOT_CACHE_MS)) return this.snapshot.windows
    if (this.inFlight) return await this.inFlight
    this.inFlight = this.load(signal)
    try {
      return await this.inFlight
    } finally {
      this.inFlight = undefined
    }
  }

  private async load(signal?: AbortSignal): Promise<ReadOnlyWindowQuote[]> {
    const apiKey = (await this.apiKeyProvider())?.trim()
    if (!apiKey) {
      this.closeMarketStream()
      const captureStatusBeforeStart = this.options.pageCapture?.getStatus()
      if (this.options.autoStartPageCapture !== false || (captureStatusBeforeStart && (captureStatusBeforeStart.state === 'CONNECTED' || captureStatusBeforeStart.state === 'STARTING'))) {
        await this.options.pageCapture?.start(false)
      }
      const captureStatus = this.options.pageCapture?.getStatus()
      const windows = this.snapshot?.windows ?? []
      this.status = {
        connectionState: captureStatus?.state === 'CONNECTED' ? 'CONNECTED' : captureStatus?.state === 'STARTING' ? 'DISCONNECTED' : 'NOT_CONFIGURED',
        message: this.options.autoStartPageCapture === false && (!captureStatus || captureStatus.state === 'IDLE')
          ? '未配置主网 API Key；点击“打开 Predict.fun 页面”后开始监听'
          : captureStatus?.message ?? '未配置主网 API Key；点击“打开 Predict.fun 页面”后开始监听',
        marketCount: windows.length,
        updatedAt: captureStatus?.updatedAt
      }
      return windows
    }
    try {
      const now = Date.now()
      let categories = this.discovery?.categories
      if (!categories || now - (this.discovery?.fetchedAt ?? 0) >= DISCOVERY_CACHE_MS) {
        const response = await this.fetchJson<PredictCategoriesResponse>(
          `${this.apiBase}/v1/categories?first=50&status=OPEN&marketVariant=CRYPTO_UP_DOWN`, apiKey, signal
        )
        categories = response.data ?? []
        this.discovery = { fetchedAt: now, categories }
      }
      const candidates = selectCandidates(categories, now)
      this.ensureMarketStream(candidates, apiKey)
      const current = new Map((this.snapshot?.windows ?? []).map((window) => [window.marketId, window]))
      const shouldAuditAllBooks = this.socket?.readyState !== WebSocket.OPEN || now - this.lastRestBookAt >= REST_BOOK_AUDIT_MS
      const booksToFetch = candidates.filter(({ market }) => Boolean(market.id) && (shouldAuditAllBooks || !current.has(String(market.id))))
      const results = await Promise.allSettled(booksToFetch.map(async ({ category, market }) => {
        if (!market.id) return undefined
        const book = await this.fetchJson<PredictBookResponse>(`${this.apiBase}/v1/markets/${market.id}/orderbook`, apiKey, signal)
        const observedAt = Date.now()
        return parseCategory(category, market, book, receivedAtFromBook(book.data?.updateTimestampMs, observedAt), observedAt)
      }))
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) current.set(result.value.marketId, result.value)
      }
      if (shouldAuditAllBooks) this.lastRestBookAt = Date.now()
      const windows = candidates.flatMap(({ market }) => market.id && current.has(String(market.id)) ? [current.get(String(market.id))!] : [])
      this.snapshot = { fetchedAt: Date.now(), windows }
      this.status = {
        connectionState: 'CONNECTED', marketCount: windows.length, updatedAt: Date.now(),
        message: this.socket?.readyState === WebSocket.OPEN
          ? `WebSocket实时盘口已连接（${windows.length}个 BTC 5m/15m 市场）；REST每15秒发现轮次、每30秒校准盘口`
          : `REST行情已连接（${windows.length}个市场），WebSocket正在连接；断线期间最多每5秒刷新盘口`
      }
      return windows
    } catch (error) {
      this.status = { ...this.status, connectionState: 'DISCONNECTED', message: `Predict.fun读取失败：${error instanceof Error ? error.message : String(error)}` }
      throw error
    }
  }

  private ensureMarketStream(candidates: Array<{ category: PredictCategory; market: PredictMarket }>, apiKey: string): void {
    if (this.options.enableStreaming === false || !this.monitoringEnabled) return
    this.marketContexts = new Map(candidates.flatMap((context) => context.market.id ? [[String(context.market.id), context]] : []))
    this.desiredTopics = new Set([...this.marketContexts.keys()].flatMap((marketId) => [
      `predictOrderbook/${marketId}`,
      `predictTradingStatus/${marketId}`,
      `predictMarketStatus/${marketId}`
    ]))
    if (this.socket && this.socketApiKey === apiKey) {
      if (this.socket.readyState === WebSocket.OPEN) this.syncSubscriptions()
      return
    }
    this.closeMarketStream()
    this.socketApiKey = apiKey
    this.openMarketStream()
  }

  private openMarketStream(): void {
    if (!this.socketApiKey || this.options.enableStreaming === false || !this.monitoringEnabled || this.reconnectTimer) return
    const createSocket = this.options.webSocketFactory ?? ((url, options) => new WebSocket(url, options))
    const socket = createSocket(this.options.webSocketUrl ?? 'wss://ws.predict.fun/ws', {
      headers: { 'x-api-key': this.socketApiKey, 'user-agent': 'ArbDesk/0.1' }
    })
    this.socket = socket
    socket.on('open', () => {
      if (this.socket !== socket) return
      this.reconnectAttempt = 0
      this.activeTopics.clear()
      this.syncSubscriptions()
      this.status = {
        connectionState: 'CONNECTED', marketCount: this.snapshot?.windows.length ?? 0, updatedAt: Date.now(),
        message: `WebSocket实时盘口已连接（${this.marketContexts.size}个市场）；REST只做轮次发现和30秒校准`
      }
      this.emitMarketData()
    })
    socket.on('message', (data: RawData) => this.handleStreamMessage(socket, data))
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.activeTopics.clear()
      this.status = {
        ...this.status, connectionState: this.snapshot ? 'CONNECTED' : 'DISCONNECTED',
        message: 'WebSocket已断开，按退避策略重连；REST低频兜底仍启用'
      }
      this.emitMarketData()
      this.scheduleReconnect()
    })
    socket.on('error', (error: Error) => {
      if (this.socket !== socket) return
      this.status = { ...this.status, message: `WebSocket连接异常，使用REST兜底：${error.message}` }
    })
  }

  private handleStreamMessage(socket: WebSocket, raw: RawData): void {
    if (this.socket !== socket) return
    let message: PredictStreamMessage
    try {
      message = JSON.parse(raw.toString()) as PredictStreamMessage
    } catch {
      return
    }
    this.handleStreamPayload(message, true, undefined, Date.now())
  }

  private handleStreamPayload(message: PredictStreamMessage, officialSocket: boolean, pageUrl?: string, observedAt = Date.now()): void {
    if (!officialSocket) this.passiveFrameCount += 1
    if (message.type === 'R' && officialSocket) {
      const pending = typeof message.requestId === 'number' ? this.pendingSubscriptions.get(message.requestId) : undefined
      if (typeof message.requestId === 'number') this.pendingSubscriptions.delete(message.requestId)
      if (message.success === false) {
        if (pending?.method === 'subscribe') this.activeTopics.delete(pending.topic)
        this.status = { ...this.status, message: `WebSocket订阅失败：${message.error?.code ?? 'unknown'} ${message.error?.message ?? ''}`.trim() }
      }
      return
    }
    if (message.type !== 'M' || !message.topic) return
    if (message.topic === 'heartbeat') {
      if (officialSocket) this.sendStreamRequest({ method: 'heartbeat', data: message.data })
      return
    }
    const orderbookMatch = /(?:predict)?order[._:/-]?book[/:](\d+)$|^(\d+)[/:](?:predict)?order[._:/-]?book$/i.exec(message.topic)
    const parsedData = typeof message.data === 'string'
      ? (() => { try { return JSON.parse(message.data) as unknown } catch { return undefined } })()
      : message.data
    const dataRecord = parsedData && typeof parsedData === 'object' ? parsedData as Record<string, unknown> : undefined
    const nestedBook = dataRecord?.orderbook && typeof dataRecord.orderbook === 'object'
      ? dataRecord.orderbook as Record<string, unknown>
      : dataRecord?.orderBook && typeof dataRecord.orderBook === 'object'
        ? dataRecord.orderBook as Record<string, unknown>
        : undefined
    const bookRecord = nestedBook ? { ...dataRecord, ...nestedBook } : dataRecord
    const dataMarketId = bookRecord?.marketId ?? bookRecord?.market_id ?? bookRecord?.id ?? dataRecord?.marketId ?? dataRecord?.market_id
    const hasBookData = Array.isArray(bookRecord?.asks) || Array.isArray(bookRecord?.bids) ||
      Array.isArray(bookRecord?.yes) || Array.isArray(bookRecord?.no)
    const resolvedMarketId = orderbookMatch?.[1] ?? orderbookMatch?.[2] ??
      (dataMarketId !== undefined && (hasBookData || /order|book/i.test(message.topic)) ? String(dataMarketId) : undefined)
    const looksLikeOrderbook = Boolean(orderbookMatch) || /order|book/i.test(message.topic)
    if (!officialSocket && looksLikeOrderbook) this.passiveOrderbookFrameCount += 1
    if (!officialSocket && looksLikeOrderbook && !resolvedMarketId) {
      this.passiveUnmappedFrameCount += 1
      this.passiveLastReason = '盘口帧没有 marketId'
      this.notifyPassiveDiagnostics()
    }
    if (resolvedMarketId && bookRecord) {
      let context = this.marketContexts.get(resolvedMarketId)
      if (!context && !officialSocket) {
        const pageContext = contextFromPassivePageUrl(pageUrl, resolvedMarketId)
        const pageDuration = durationFromCategory(pageContext?.category)
        // The 15m page also streams the rolling 5m book. At each 5m boundary
        // the new 5m marketId can arrive before its directory response. Use
        // the expired 5m context as an explicit rotation signal; keep the
        // page's own 15m context as the default for all other frames.
        const hasActiveFifteenMinute = pageDuration === 15 && [...this.marketContexts.values()].some((candidate) =>
          durationFromCategory(candidate.category) === 15 && (categoryWindowTimes(candidate.category)?.endTime ?? 0) > Date.now()
        )
        const expiredFiveMinute = hasActiveFifteenMinute
          ? [...this.marketContexts.values()]
            .filter((candidate) => durationFromCategory(candidate.category) === 5)
            .find((candidate) => (categoryWindowTimes(candidate.category)?.endTime ?? Infinity) <= Date.now() + 15_000)
          : undefined
        if (expiredFiveMinute) {
          context = contextFromRollingDuration(5, resolvedMarketId, Date.now())
          this.passivePageBoundFrameCount += 1
        } else if (pageContext) {
          context = pageContext
          this.passivePageBoundFrameCount += 1
        }
        if (context) {
          this.marketContexts.set(resolvedMarketId, context)
          this.lastDirectoryAt = Date.now()
        }
      }
      if (!context) {
        if (!officialSocket) {
          this.passiveUnmappedFrameCount += 1
          const directoryIds = [...this.marketContexts.keys()].slice(0, 8).join(',') || '空'
          const directoryAge = this.lastDirectoryAt ? `${Math.max(0, Math.round((Date.now() - this.lastDirectoryAt) / 1_000))}秒前更新` : '尚未建立'
          this.passiveLastReason = `盘口 marketId ${resolvedMarketId} 不在当前目录（目录 ${directoryIds}，${directoryAge}）`
          this.notifyPassiveDiagnostics()
        }
        return
      }
      const book = { success: true, data: bookRecord as PredictBookResponse['data'] }
      const parsed = parseCategory(context.category, context.market, book, receivedAtFromBook(book.data?.updateTimestampMs, observedAt), observedAt)
      if (!parsed) {
        if (!officialSocket) {
          this.passiveParseRejectedCount += 1
          this.passiveLastReason = `marketId ${resolvedMarketId} 的时间/方向/盘口字段未通过解析`
          this.notifyPassiveDiagnostics()
        }
        return
      }
      if (!officialSocket) this.passiveMappedFrameCount += 1
      const windows = [...(this.snapshot?.windows ?? []).filter((window) => window.marketId !== parsed.marketId), parsed]
        .sort((left, right) => left.startTime - right.startTime || left.durationMinutes - right.durationMinutes)
      this.snapshot = { fetchedAt: Date.now(), windows }
      this.status = {
        connectionState: 'CONNECTED', marketCount: windows.length, updatedAt: Date.now(),
        message: officialSocket
          ? `官方WebSocket实时盘口已连接，最近推送 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
          : `网页单页面被动盘口已接收，最近推送 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}；${this.passiveDiagnosticsSuffix().replace(/^；/, '')}；未额外请求接口`
      }
      this.emitMarketData()
      return
    }
    const lifecycleMatch = /^predict(?:Trading|Market)Status[/:](\d+)$/i.exec(message.topic)
    if (lifecycleMatch && message.data && typeof message.data === 'object') {
      const status = String((message.data as { tradingStatus?: string; status?: string }).tradingStatus ?? (message.data as { status?: string }).status ?? '')
      if (status === 'CLOSED') {
        this.discovery = undefined
        if (this.snapshot) this.snapshot = { fetchedAt: Date.now(), windows: this.snapshot.windows.filter((window) => window.marketId !== lifecycleMatch[1]) }
        this.emitMarketData()
      }
    }
  }

  private ingestCapturedResponse(event: PredictFunCapturedResponse): void {
    if (!this.monitoringEnabled) return
    const { url, body: rawBody, receivedAt } = event
    let body: unknown
    try {
      body = JSON.parse(rawBody) as unknown
    } catch {
      return
    }
    let path: string
    try {
      path = new URL(url).pathname
    } catch {
      return
    }
    if (path.includes('/v1/categories')) {
      const response = body as PredictCategoriesResponse
      if (!Array.isArray(response.data)) return
      this.discovery = { fetchedAt: receivedAt, categories: response.data }
      const candidates = selectCandidates(response.data, receivedAt)
      const activeContextExists = [...this.marketContexts.values()].some(({ category }) => categoryTimestamp(category.endsAt) > receivedAt)
      if (candidates.length === 0 && activeContextExists) {
        this.status = {
          connectionState: 'CONNECTED', marketCount: this.snapshot?.windows.length ?? 0, updatedAt: receivedAt,
          message: '网页单页面收到非当前轮次目录；保留仍有效的 BTC 盘口上下文'
        }
        this.emitMarketData()
        return
      }
      this.mergePassiveMarketContexts(candidates, receivedAt)
      this.lastDirectoryAt = receivedAt
      if (this.snapshot) {
        const wanted = new Set(this.marketContexts.keys())
        this.snapshot = { fetchedAt: receivedAt, windows: this.snapshot.windows.filter((window) => wanted.has(window.marketId)) }
      }
      this.status = {
        connectionState: 'CONNECTED', marketCount: this.snapshot?.windows.length ?? 0, updatedAt: receivedAt,
        message: candidates.length > 0
          ? `网页单页面已捕获市场目录（${candidates.length}个 BTC 5m/15m 候选）；等待网页盘口`
          : '网页单页面已收到市场目录，但没有匹配当前 BTC 5m/15m：可能是页面登录/地区限制或市场字段仍在轮换'
      }
      this.emitMarketData()
      return
    }
    const isGraphql = path.endsWith('/graphql')
    const isMarketDetail = /(?:^|\/)markets\/\d+$/i.test(path)
    if (/(?:^|\/)markets(?:\/|$)/i.test(path)) this.passiveLastMarketPath = path
    if (isGraphql || isMarketDetail) {
      if (isGraphql) this.passiveGraphqlResponseCount += 1
      if (isMarketDetail) this.passiveMarketDetailCount += 1
      if (event.operationName) this.passiveLastGraphqlOperation = event.operationName
      if (event.requestSlugs?.length) this.passiveLastGraphqlSlugs = event.requestSlugs.join(',')
      const fingerprints = graphqlMarketSchemaFingerprints(body)
      if (fingerprints.length > 0) this.passiveLastGraphqlSchema = fingerprints.join(' | ')
      const pageSlug = (() => {
        try { return new URL(event.pageUrl ?? '').pathname.match(/\/market\/(btc-updown-(?:5|15)m-\d+)/i)?.[1] } catch { return undefined }
      })()
      const requestSlugs = event.requestSlugs?.length ? event.requestSlugs : pageSlug ? [pageSlug] : []
      const capturedCategories = categoriesFromGraphql(body, {
        requestSlugs,
        requestMarketIds: event.requestMarketIds ?? [],
        operationName: event.operationName
      })
      if (capturedCategories.length === 0) {
        this.passiveLastReason = fingerprints.length > 0
          ? 'GraphQL 已收到市场结构，但没有形成 BTC 5m/15m 目录'
          : 'GraphQL 响应中没有发现市场目录字段'
        this.notifyPassiveDiagnostics()
        return
      }
      if (isGraphql) this.passiveGraphqlMappedCount += 1
      const categoriesBySlug = new Map((this.discovery?.categories ?? []).map((category) => [category.slug, category]))
      for (const category of capturedCategories) {
        const key = category.slug ?? category.description ?? `category:${category.startsAt ?? ''}:${category.endsAt ?? ''}`
        categoriesBySlug.set(key, mergeCapturedCategory(categoriesBySlug.get(key), category))
      }
      const categories = [...categoriesBySlug.values()]
      this.discovery = { fetchedAt: receivedAt, categories }
      const candidates = selectCandidates(categories, receivedAt)
      // Some page versions put a usable bestAsk directly on GraphQL
      // outcomes but never open a WebSocket. Materialize those quotes so the
      // UI can show the market instead of reporting "无市场" while the page
      // itself is publishing prices through GraphQL.
      const embeddedWindows = candidates.flatMap(({ category, market }) => {
        const parsed = parseCategory(category, market, { success: true, data: {} }, receivedAt, receivedAt)
        return parsed && Object.keys(parsed.outcomes).length > 0 ? [parsed] : []
      })
      if (embeddedWindows.length > 0) {
        const current = new Map((this.snapshot?.windows ?? []).map((window) => [window.marketId, window]))
        for (const window of embeddedWindows) current.set(window.marketId, window)
        this.snapshot = { fetchedAt: receivedAt, windows: [...current.values()].sort((left, right) => left.startTime - right.startTime || left.durationMinutes - right.durationMinutes) }
      }
      const activeContextExists = [...this.marketContexts.values()].some(({ category }) => categoryTimestamp(category.endsAt) > receivedAt)
      if (candidates.length === 0 && activeContextExists) {
        this.status = {
          connectionState: 'CONNECTED', marketCount: this.snapshot?.windows.length ?? 0, updatedAt: receivedAt,
          message: '网页单页面收到非当前轮次 GraphQL 数据；保留仍有效的 BTC 盘口上下文'
        }
        this.emitMarketData()
        return
      }
      this.mergePassiveMarketContexts(candidates, receivedAt)
      this.lastDirectoryAt = receivedAt
      if (this.snapshot) {
        const wanted = new Set(this.marketContexts.keys())
        this.snapshot = { fetchedAt: receivedAt, windows: this.snapshot.windows.filter((window) => wanted.has(window.marketId)) }
      }
      this.status = {
        connectionState: 'CONNECTED', marketCount: this.snapshot?.windows.length ?? 0, updatedAt: receivedAt,
        message: candidates.length > 0
          ? `网页单页面已捕获${isGraphql ? '新版 GraphQL' : 'REST Market'}市场目录（${candidates.length}个 BTC 5m/15m 候选）；等待页面盘口推送`
          : '网页单页面已捕获 GraphQL，但没有匹配当前 BTC 5m/15m：页面可能只返回历史/其他资产市场'
      }
      this.emitMarketData()
      return
    }
    const orderbookMatch = /^\/v1\/markets\/(\d+)\/orderbook$/.exec(path)
    if (!orderbookMatch) return
    const context = this.marketContexts.get(orderbookMatch[1])
    if (!context) return
    const book = body as PredictBookResponse
    const parsed = parseCategory(context.category, context.market, book, receivedAtFromBook(book.data?.updateTimestampMs, receivedAt), receivedAt)
    if (parsed) this.applyCapturedWindow(parsed, receivedAt)
  }

  private ingestCapturedWebSocketFrame(rawPayload: string, pageUrl?: string, observedAt = Date.now()): void {
    if (!this.monitoringEnabled) return
    let message: PredictStreamMessage
    try {
      message = JSON.parse(rawPayload) as PredictStreamMessage
    } catch {
      return
    }
    this.handleStreamPayload(message, false, pageUrl, observedAt)
  }

  private mergePassiveMarketContexts(candidates: Array<{ category: PredictCategory; market: PredictMarket }>, now: number): void {
    const merged = new Map(this.marketContexts)
    for (const context of candidates) {
      if (context.market.id) merged.set(String(context.market.id), context)
    }
    for (const [marketId, context] of merged) {
      const endTime = categoryWindowTimes(context.category)?.endTime
      if (endTime !== undefined && endTime <= now) merged.delete(marketId)
    }
    this.marketContexts = merged
  }

  private passiveDiagnosticsSuffix(): string {
    const graphql = this.passiveGraphqlResponseCount > 0
      ? `；GraphQL目录 ${this.passiveGraphqlMappedCount}/${this.passiveGraphqlResponseCount}${this.passiveLastGraphqlOperation ? `，操作 ${this.passiveLastGraphqlOperation}` : ''}${this.passiveLastGraphqlSlugs ? `，slug ${this.passiveLastGraphqlSlugs}` : ''}${this.passiveLastGraphqlSchema ? `，字段 ${this.passiveLastGraphqlSchema}` : ''}`
      : ''
    const marketDetail = this.passiveMarketDetailCount > 0
      ? `；REST市场详情 ${this.passiveMarketDetailCount}${this.passiveLastMarketPath ? `（${this.passiveLastMarketPath}）` : ''}`
      : this.passiveLastMarketPath ? `；REST市场路径 ${this.passiveLastMarketPath}` : ''
    if (this.passiveFrameCount === 0) return `${graphql}${marketDetail}；页面尚未收到可解析的 WebSocket 帧`
    const reason = this.passiveLastReason ? `，最近原因：${this.passiveLastReason}` : ''
    return `${graphql}${marketDetail}；页面帧 ${this.passiveFrameCount}（盘口 ${this.passiveOrderbookFrameCount}、映射 ${this.passiveMappedFrameCount}、页面绑定 ${this.passivePageBoundFrameCount}、未映射 ${this.passiveUnmappedFrameCount}、解析失败 ${this.passiveParseRejectedCount}${reason}）`
  }

  private notifyPassiveDiagnostics(): void {
    const now = Date.now()
    if (now - this.lastPassiveDiagnosticNotifyAt < 1_000) return
    this.lastPassiveDiagnosticNotifyAt = now
    this.status = {
      ...this.status,
      connectionState: this.status.connectionState === 'NOT_CONFIGURED' ? 'CONNECTED' : this.status.connectionState,
      message: `网页被动盘口诊断${this.passiveDiagnosticsSuffix()}`,
      updatedAt: now
    }
    this.emitMarketData()
  }

  private applyCapturedWindow(parsed: ReadOnlyWindowQuote, receivedAt: number): void {
    const windows = [...(this.snapshot?.windows ?? []).filter((window) => window.marketId !== parsed.marketId), parsed]
      .sort((left, right) => left.startTime - right.startTime || left.durationMinutes - right.durationMinutes)
    this.snapshot = { fetchedAt: receivedAt, windows }
    this.status = {
      connectionState: 'CONNECTED', marketCount: windows.length, updatedAt: receivedAt,
      message: `网页单页面被动盘口已接收（${windows.length}个市场）；${this.passiveDiagnosticsSuffix().replace(/^；/, '')}；没有额外调用内部接口`
    }
    this.emitMarketData()
  }

  private syncSubscriptions(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    for (const topic of this.activeTopics) {
      if (!this.desiredTopics.has(topic)) {
        this.sendSubscriptionRequest('unsubscribe', topic)
        this.activeTopics.delete(topic)
      }
    }
    for (const topic of this.desiredTopics) {
      if (this.activeTopics.has(topic)) continue
      this.sendSubscriptionRequest('subscribe', topic)
      this.activeTopics.add(topic)
    }
  }

  private sendStreamRequest(payload: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload))
  }

  private sendSubscriptionRequest(method: 'subscribe' | 'unsubscribe', topic: string): void {
    const requestId = ++this.requestId
    this.pendingSubscriptions.set(requestId, { method, topic })
    this.sendStreamRequest({ method, requestId, params: [topic] })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.socketApiKey || this.options.enableStreaming === false || !this.monitoringEnabled) return
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt, 5))
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.openMarketStream()
    }, delay)
    this.reconnectTimer.unref()
  }

  private closeMarketStream(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const socket = this.socket
    this.socket = undefined
    this.activeTopics.clear()
    this.pendingSubscriptions.clear()
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
  }

  private emitMarketData(): void {
    for (const listener of this.listeners) listener()
  }

  private async fetchJson<T>(url: string, apiKey: string, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'ArbDesk/0.1', 'x-api-key': apiKey }, signal: combined
    })
    if (!response.ok) throw new Error(`${new URL(url).hostname} HTTP ${response.status}`)
    return await response.json() as T
  }
}
