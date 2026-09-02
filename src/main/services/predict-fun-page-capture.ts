import { app, BrowserWindow, shell } from 'electron'
import Decimal from 'decimal.js'
import type { CDPSession, Page } from 'playwright-core'
import type { PredictFunPageCaptureStatus } from '../../shared/types'
import type { FingerprintBrowserRuntime } from './fingerprint-browser-runtime'

export type { PredictFunPageCaptureStatus } from '../../shared/types'

const PAGE_START_TIMEOUT_MS = 20_000
// The page is anchored to the current 15m URL, but the 5m market IDs exposed
// by that page rotate every five minutes. Reload once at the 5m boundary so
// its GraphQL directory and WebSocket subscriptions advance together. This is
// a page-owned refresh, not an additional application API poll.
const PAGE_ROLL_INTERVAL_MS = 5 * 60_000
const PAGE_ROLL_SETTLE_MS = 1_250
const MIN_PAGE_ORDER_REMAINING_MS = 60_000

function currentPredictMarketUrl(durationMinutes: 5 | 15, now = Date.now()): string {
  const slotSeconds = durationMinutes * 60
  const slot = Math.floor(now / (slotSeconds * 1_000)) * slotSeconds
  return `https://predict.fun/zh-cn/market/btc-updown-${durationMinutes}m-${slot}`
}

/**
 * A connected Predict.fun tab can still be sitting on a settled historical
 * market.  Treat that as unavailable for page execution: navigating to a new
 * round would change the market/token IDs already present in the comparison,
 * which is unsafe after the first leg has been submitted.
 */
function isCurrentPredictMarketUrl(rawUrl: string, durationMinutes: 5 | 15, now = Date.now()): boolean {
  const match = rawUrl.match(new RegExp(`/market/btc-updown-${durationMinutes}m-(\\d+)`, 'i'))
  if (!match) return false
  const start = Number(match[1]) * 1_000
  if (!Number.isFinite(start)) return false
  const end = start + durationMinutes * 60_000
  // Allow a small clock/route skew around a freshly rotated page, but never
  // consider a settled page executable.
  return now < end + 15_000 && Math.abs(start - now) <= durationMinutes * 60_000
}

export interface PredictFunCapturedResponse {
  url: string
  body: string
  receivedAt: number
  pageUrl?: string
  operationName?: string
  requestSlugs?: string[]
  requestMarketIds?: string[]
}

export interface PredictFunCapturedWebSocketFrame {
  url: string
  payload: string
  receivedAt: number
  /** URL of the page that owned the frame; binds the rolling slug to marketId. */
  pageUrl?: string
}

export interface PredictFunPageOrderIntent {
  marketId: string
  outcomeId: string
  direction: 'UP' | 'DOWN'
  quantity: string
  limitPrice: string
  clientOrderId: string
  startTime: number
  durationMinutes: 5 | 15
  allowSubmit: boolean
}

export interface PredictFunPageOrderResponse {
  status: number
  body: string
}

export interface PredictFunPageOrderFill {
  orderId: string
  orderHash?: string
  status: 'FILLED' | 'REJECTED'
  filledQuantity: string
  grossFilledQuantity?: string
  feeQuantity?: string
  averagePrice?: string
  filledAt: number
  source: 'WALLET_WEBSOCKET' | 'ACCOUNT_EVENT_LOG' | 'ACCOUNT_POSITION'
  message?: string
}

interface PredictFunPendingPageOrder {
  orderId: string
  marketId: string
  direction: 'UP' | 'DOWN'
  submittedAt: number
}

export type PredictFunOrderTraceKind = 'REQUEST' | 'RESPONSE' | 'WEBSOCKET'

export interface PredictFunOrderTraceEntry {
  sequence: number
  kind: PredictFunOrderTraceKind
  endpoint: string
  method?: string
  direction?: 'SENT' | 'RECEIVED'
  status?: number
  resourceType?: string
  bodyFormat?: 'JSON' | 'FORM' | 'TEXT' | 'EMPTY'
  bodyBytes?: number
  requestFields?: string[]
  responseFields?: string[]
  operationName?: string
  /** JSON preview with credential-like values redacted; never replayable. */
  bodyPreview?: string
  pageUrl?: string
  receivedAt: number
}

export interface PredictFunOrderCaptureSummary {
  capturing: boolean
  traceEntryCount: number
  requestCount: number
  responseCount: number
  webSocketCount: number
  message: string
}

export interface PredictFunPageCaptureSource {
  getStatus(): PredictFunPageCaptureStatus
  onResponse(listener: (event: PredictFunCapturedResponse) => void): () => void
  onWebSocketFrame(listener: (event: PredictFunCapturedWebSocketFrame) => void): () => void
  onStatus(listener: (status: PredictFunPageCaptureStatus) => void): () => void
  canExecutePageOrders?(durationMinutes?: 5 | 15): boolean
  executePageOrder?(intent: PredictFunPageOrderIntent): Promise<PredictFunPageOrderResponse>
  waitForPageOrderFill?(orderId: string, timeoutMs?: number): Promise<PredictFunPageOrderFill | undefined>
  startOrderCapture?(): PredictFunOrderCaptureSummary
  stopOrderCapture?(): PredictFunOrderCaptureSummary
  clearOrderCapture?(): PredictFunOrderCaptureSummary
  getOrderCaptureSummary?(): PredictFunOrderCaptureSummary
  getOrderTrace?(): PredictFunOrderTraceEntry[]
  start(show?: boolean): Promise<void>
  stop(): void
}

interface CdpResponseReceived {
  requestId?: string
  type?: string
  response?: { url?: string; mimeType?: string; status?: number }
}

interface CdpRequestWillBeSent {
  requestId?: string
  type?: string
  request?: { url?: string; method?: string; postData?: string }
}

interface PredictGraphqlRequestMetadata {
  operationName?: string
  slugs: string[]
  marketIds: string[]
}

function graphqlRequestMetadata(postData: string | undefined): PredictGraphqlRequestMetadata | undefined {
  if (!postData) return undefined
  try {
    const body = JSON.parse(postData) as unknown
    const operations = Array.isArray(body) ? body : [body]
    const slugs = new Set<string>()
    const marketIds = new Set<string>()
    let operationName: string | undefined
    const walk = (value: unknown, parentKey = '', depth = 0): void => {
      if (depth > 8 || value === null || value === undefined) return
      if (typeof value === 'string' || typeof value === 'number') {
        if (/^(?:category)?slug$/i.test(parentKey) && /^btc-updown-(?:5|15)m-\d+$/i.test(String(value))) slugs.add(String(value))
        if (/^marketId$/i.test(parentKey) && /^\d+$/.test(String(value))) marketIds.add(String(value))
        return
      }
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry, parentKey, depth + 1)
        return
      }
      if (typeof value !== 'object') return
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) walk(entry, key, depth + 1)
    }
    for (const operation of operations) {
      if (!operation || typeof operation !== 'object') continue
      const record = operation as Record<string, unknown>
      if (!operationName && typeof record.operationName === 'string') operationName = record.operationName
      walk(record.variables)
    }
    return { operationName, slugs: [...slugs], marketIds: [...marketIds] }
  } catch {
    return undefined
  }
}

interface CdpWebSocketCreated {
  requestId?: string
  url?: string
}

interface CdpWebSocketFrame {
  requestId?: string
  response?: { opcode?: number; payloadData?: string }
  request?: { opcode?: number; payloadData?: string }
}

interface PredictPageMarketMetadata {
  pageUrl: string
  categorySlug: string
  marketId: string
  outcomeIds: string[]
}

function isPredictHost(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase()
    return hostname === 'predict.fun' || hostname.endsWith('.predict.fun')
  } catch {
    return false
  }
}

function isPredictOrderUrl(rawUrl: string): boolean {
  if (!isPredictHost(rawUrl)) return false
  try {
    const path = new URL(rawUrl).pathname
    return /(?:order|trade|graphql)/i.test(path)
  } catch {
    return false
  }
}

function isLikelyPredictOrderRequest(rawUrl: string, method: string | undefined, postData: string | undefined): boolean {
  if (String(method ?? '').toUpperCase() !== 'POST' || !isPredictOrderUrl(rawUrl)) return false
  try {
    const path = new URL(rawUrl).pathname
    if (/\/v1\/orders(?:\/|$)/i.test(path)) return true
  } catch {
    // Fall through to the GraphQL body check.
  }
  // GraphQL is also used for reads. Only capture mutations whose operation or
  // payload contains an order/trade verb so the trace is useful and bounded.
  return /\/graphql(?:$|\?)/i.test(rawUrl) && /mutation/i.test(postData ?? '') && /(order|trade|buy|place|create)/i.test(postData ?? '')
}

/**
 * Classify the small set of follow-up reads that can contain an actual
 * fill/position amount. These remain separately tagged in the trace so the
 * order receipt can be distinguished from broad diagnostic traffic.
 */
function isLikelyPredictFillReadbackRequest(rawUrl: string, method: string | undefined, operationName: string | undefined): boolean {
  if (!isPredictHost(rawUrl) || !['GET', 'POST'].includes(String(method ?? 'GET').toUpperCase())) return false
  let path = ''
  try { path = new URL(rawUrl).pathname } catch { return false }
  if (/\/v1\/(?:orders?|fills?|trades?|positions?|portfolio|account)(?:\/|$)/i.test(path)) return true
  if (!/\/graphql(?:$|\?)/i.test(path)) return false
  const operation = String(operationName ?? '')
  if (/(?:create|place|submit|cancel|amend|update).*order|order.*(?:mutation|create|place|submit|cancel|amend|update)/i.test(operation)) return false
  return /(?:order|fill|trade|position|portfolio|account|balance)/i.test(operation) && !/mutation/i.test(operation)
}

function traceEndpoint(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    url.search = ''
    url.hash = ''
    if (url.hostname.toLowerCase() === 'privy.predict.fun') {
      url.pathname = url.pathname.replace(/\/wallets\/[^/]+/i, '/wallets/[REDACTED]')
    }
    return url.toString()
  } catch {
    return rawUrl
  }
}

function traceBody(body: string | undefined): { format: PredictFunOrderTraceEntry['bodyFormat']; bytes: number; fields: string[]; operationName?: string; preview?: string } {
  if (!body) return { format: 'EMPTY', bytes: 0, fields: [] }
  try {
    const parsed = JSON.parse(body) as unknown
    const fields = new Set<string>()
    let operationName: string | undefined
    const sensitive = (key: string): boolean => /authorization|cookie|secret|signature|private|password|csrf|xsrf|jwt|bearer|session|credential|apikey|accesskey|auth/i.test(key.replace(/[-_]/g, ''))
    const redactText = (value: string): string => value
      // Wallet WebSocket topics embed a live JWT after the slash. Treat any
      // JWT-shaped value as a credential even when the surrounding field is
      // named `topic` rather than `token`.
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]')
    const redact = (value: unknown, key = ''): unknown => {
      if (sensitive(key)) return '[REDACTED]'
      if (Array.isArray(value)) return value.map((child) => redact(child))
      if (typeof value === 'string') return redactText(value)
      if (!value || typeof value !== 'object') return value
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => {
        const field = key ? `${key}.${childKey}` : childKey
        fields.add(field)
        if (!operationName && /^(operationname|operation)$/i.test(childKey) && typeof child === 'string') operationName = child
        return [childKey, redact(child, childKey)]
      }))
    }
    const redacted = JSON.stringify(redact(parsed))
    return { format: 'JSON', bytes: body.length, fields: [...fields].sort(), operationName, preview: redacted.length > 24_000 ? `${redacted.slice(0, 24_000)}…[TRUNCATED]` : redacted }
  } catch {
    return { format: 'TEXT', bytes: body.length, fields: [], preview: `[NON_JSON_BODY_OMITTED bytes=${body.length}]` }
  }
}

function decimalFromWei(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined
  const integer = BigInt(value)
  const whole = integer / 1_000_000_000_000_000_000n
  const fraction = (integer % 1_000_000_000_000_000_000n).toString().padStart(18, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

function readableOrderFailure(data: Record<string, unknown>): string {
  const candidates: unknown[] = [data.message, data.reason, data.error, data.details]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      for (const key of ['message', 'reason', 'error', 'code']) {
        const nested = record[key]
        if (typeof nested === 'string' && nested.trim()) return nested.trim()
      }
    }
  }
  return 'Predict.fun 撮合失败，平台未产生持仓'
}

/** Parse the private wallet event that is emitted after Predict.fun settles a
 * page-created order. This is passive readback from the already-open page and
 * does not issue another HTTP request. */
export function parsePredictPageOrderFillEvent(payload: string, receivedAt = Date.now()): PredictFunPageOrderFill | undefined {
  try {
    const root = JSON.parse(payload) as Record<string, unknown>
    const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : undefined
    if (!data) return undefined
    const orderId = typeof data.orderId === 'string' || typeof data.orderId === 'number' ? String(data.orderId) : ''
    if (!orderId) return undefined
    const eventType = String(data.type ?? '')
    const timestamp = typeof data.timestamp === 'number' && Number.isFinite(data.timestamp) ? data.timestamp : receivedAt
    if (/^orderTransaction(?:Failed|Failure|Error)$/i.test(eventType)) {
      return {
        orderId,
        orderHash: typeof data.orderHash === 'string' ? data.orderHash : undefined,
        status: 'REJECTED',
        filledQuantity: '0',
        filledAt: timestamp,
        source: 'WALLET_WEBSOCKET',
        message: readableOrderFailure(data)
      }
    }
    if (eventType !== 'orderTransactionSuccess') return undefined
    const details = data.details && typeof data.details === 'object' ? data.details as Record<string, unknown> : undefined
    const fill = data.fill && typeof data.fill === 'object' ? data.fill as Record<string, unknown> : undefined
    const fee = data.fee && typeof data.fee === 'object' ? data.fee as Record<string, unknown> : undefined
    const displayedQuantity = details && (typeof details.quantityFilled === 'string' || typeof details.quantityFilled === 'number')
      ? String(details.quantityFilled)
      : undefined
    // The wallet event exposes the gross matched shares in quantityFilled and
    // the fee separately. Predict.fun charges the taker fee in shares, so the
    // hedgeable exposure is gross minus a SHARES fee, not quantityFilled.
    const grossFilledQuantity = decimalFromWei(fill?.executedSizeWei) ?? displayedQuantity
    if (!grossFilledQuantity || new Decimal(grossFilledQuantity).lte(0)) return undefined
    const feeQuantity = String(fee?.type ?? '').toUpperCase() === 'SHARES'
      ? decimalFromWei(fee?.amountWei)
      : undefined
    const netFilled = Decimal.max(0, new Decimal(grossFilledQuantity).sub(feeQuantity ?? 0))
    if (netFilled.lte(0)) return undefined
    const averagePrice = decimalFromWei(fill?.executedPriceWei) ??
      (details && (typeof details.price === 'string' || typeof details.price === 'number') ? String(details.price) : undefined)
    return {
      orderId,
      orderHash: typeof data.orderHash === 'string' ? data.orderHash : undefined,
      status: 'FILLED',
      filledQuantity: netFilled.toString(),
      grossFilledQuantity,
      feeQuantity,
      averagePrice,
      filledAt: timestamp,
      source: 'WALLET_WEBSOCKET'
    }
  } catch {
    return undefined
  }
}

export function parsePredictAccountEventFills(body: string, receivedAt = Date.now()): PredictFunPageOrderFill[] {
  try {
    const root = JSON.parse(body) as unknown
    const totals = new Map<string, { amountWei: bigint; weightedPrice: bigint; filledAt: number; seen: Set<string> }>()
    const walk = (value: unknown, depth = 0): void => {
      if (depth > 10 || value === null || value === undefined) return
      if (Array.isArray(value)) {
        for (const child of value) walk(child, depth + 1)
        return
      }
      if (typeof value !== 'object') return
      const record = value as Record<string, unknown>
      if (record.event === 'MATCH_SUCCESS' && record.order && typeof record.order === 'object') {
        const order = record.order as Record<string, unknown>
        const orderId = typeof order.id === 'string' || typeof order.id === 'number' ? String(order.id) : ''
        const amountText = typeof record.amountFilled === 'string' ? record.amountFilled : ''
        const priceText = typeof record.priceExecuted === 'string' ? record.priceExecuted : ''
        if (orderId && /^\d+$/.test(amountText) && BigInt(amountText) > 0n) {
          const timestamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
          const eventKey = typeof record.transactionHash === 'string'
            ? `${record.transactionHash}:${amountText}`
            : `${String(record.timestamp ?? '')}:${amountText}:${priceText}`
          const total = totals.get(orderId) ?? { amountWei: 0n, weightedPrice: 0n, filledAt: 0, seen: new Set<string>() }
          if (!total.seen.has(eventKey)) {
            const amountWei = BigInt(amountText)
            const priceWei = /^\d+$/.test(priceText) ? BigInt(priceText) : 0n
            total.amountWei += amountWei
            total.weightedPrice += amountWei * priceWei
            total.filledAt = Math.max(total.filledAt, Number.isFinite(timestamp) ? timestamp : receivedAt)
            total.seen.add(eventKey)
            totals.set(orderId, total)
          }
        }
      }
      for (const child of Object.values(record)) walk(child, depth + 1)
    }
    walk(root)
    return [...totals.entries()].map(([orderId, total]) => ({
      orderId,
      status: 'FILLED' as const,
      filledQuantity: decimalFromWei(total.amountWei.toString())!,
      averagePrice: total.amountWei > 0n ? decimalFromWei((total.weightedPrice / total.amountWei).toString()) : undefined,
      filledAt: total.filledAt || receivedAt,
      source: 'ACCOUNT_EVENT_LOG'
    }))
  } catch {
    return []
  }
}

export interface PredictFunAccountPosition {
  marketId: string
  direction?: 'UP' | 'DOWN'
  shares: string
  averagePrice?: string
}

/** Parse actual position edges without trusting totalCount. Predict.fun has
 * been observed returning totalCount=0 while the edges array contains the
 * newly created position. */
export function parsePredictAccountPositions(body: string): PredictFunAccountPosition[] {
  try {
    const root = JSON.parse(body) as unknown
    const positions: PredictFunAccountPosition[] = []
    const walk = (value: unknown, depth = 0): void => {
      if (depth > 12 || value === null || value === undefined) return
      if (Array.isArray(value)) { for (const child of value) walk(child, depth + 1); return }
      if (typeof value !== 'object') return
      const record = value as Record<string, unknown>
      const node = record.node && typeof record.node === 'object' ? record.node as Record<string, unknown> : undefined
      const market = node?.market && typeof node.market === 'object' ? node.market as Record<string, unknown> : undefined
      const outcome = node?.outcome && typeof node.outcome === 'object' ? node.outcome as Record<string, unknown> : undefined
      const shares = typeof node?.shares === 'string' || typeof node?.shares === 'number' ? String(node.shares) : ''
      const marketId = typeof market?.id === 'string' || typeof market?.id === 'number' ? String(market.id) : ''
      if (marketId && shares) {
        const normalizedShares = /^\d+$/.test(shares) && new Decimal(shares).gte('1000000000000')
          ? decimalFromWei(shares)!
          : shares
        if (new Decimal(normalizedShares).gt(0)) {
          const index = Number(outcome?.index)
          const name = String(outcome?.name ?? '').toUpperCase()
          positions.push({
            marketId,
            direction: index === 1 || /^(UP|YES|涨|上涨)$/.test(name)
              ? 'UP'
              : index === 2 || /^(DOWN|NO|跌|下跌)$/.test(name) ? 'DOWN' : undefined,
            shares: normalizedShares,
            averagePrice: typeof node?.averageBuyPriceUsd === 'string' || typeof node?.averageBuyPriceUsd === 'number'
              ? new Decimal(String(node.averageBuyPriceUsd)).gt(0) ? String(node.averageBuyPriceUsd) : undefined
              : undefined
          })
        }
      }
      for (const child of Object.values(record)) walk(child, depth + 1)
    }
    walk(root)
    return positions.filter((position, index, all) => all.findIndex((candidate) =>
      candidate.marketId === position.marketId && candidate.direction === position.direction && candidate.shares === position.shares) === index)
  } catch {
    return []
  }
}

function parsePredictCreateOrderId(body: string): string | undefined {
  try {
    const root = JSON.parse(body) as { data?: { createOrder?: { order?: { id?: unknown } } } }
    const id = root.data?.createOrder?.order?.id
    return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined
  } catch {
    return undefined
  }
}

function isUsefulResponse(rawUrl: string): boolean {
  if (!isPredictHost(rawUrl)) return false
  try {
    const url = new URL(rawUrl)
    const path = url.pathname
    return path.includes('/v1/categories') || /(?:^|\/)markets(?:\/|$)/i.test(path) ||
      /(?:^|\/)(?:orderbooks?|books?|prices?|quotes?|market-data|events?)(?:\/|$)/i.test(path) ||
      path.endsWith('/graphql')
  } catch {
    return false
  }
}

function isMarketDiagnosticRequest(rawUrl: string, operationName: string | undefined): boolean {
  if (!isUsefulResponse(rawUrl)) return false
  let path = ''
  try { path = new URL(rawUrl).pathname } catch { return false }
  if (!path.endsWith('/graphql')) return true
  const operation = String(operationName ?? '')
  if (!operation) return false
  if (/portfolio|account|balance|position|wallet|auth|user|order/i.test(operation)) return false
  return /market|match|event|category|book|price|quote/i.test(operation)
}

export class PredictFunPageCapture implements PredictFunPageCaptureSource {
  private window?: BrowserWindow
  private fingerprintPage?: Page
  private fingerprintSession?: CDPSession
  private fingerprintSecondaryPage?: Page
  private fingerprintSecondarySession?: CDPSession
  private fingerprintSocketUrls = new Map<string, string>()
  private fingerprintStartPromise?: Promise<void>
  private startPromise?: Promise<void>
  private stopping = false
  private destroying = false
  private status: PredictFunPageCaptureStatus = { state: 'IDLE', message: 'Predict.fun 网页被动行情尚未启动' }
  private socketUrls = new Map<string, string>()
  private socketPageUrls = new Map<string, string>()
  private graphqlRequests = new Map<string, PredictGraphqlRequestMetadata>()
  private orderRequestIds = new Set<string>()
  private fillReadbackRequestIds = new Set<string>()
  private marketDiagnosticRequestIds = new Set<string>()
  /** Requests seen during the explicit diagnostic capture that are not one of
   * the already-classified order/market requests.  This is deliberately
   * bounded by the 200-entry trace ring and is never enabled by normal
   * monitoring. */
  private allCaptureRequestIds = new Set<string>()
  private orderCapturing = false
  private orderCaptureArmed = false
  private orderTrace: PredictFunOrderTraceEntry[] = []
  private orderTraceSequence = 0
  private pageOrderFills = new Map<string, PredictFunPageOrderFill>()
  private pageOrderFillWaiters = new Map<string, Set<(fill: PredictFunPageOrderFill) => void>>()
  private pendingPageOrders = new Map<string, PredictFunPendingPageOrder>()
  private responseCount = 0
  private webSocketFrameCount = 0
  private lastCaptureAt?: number
  private lastStatusNotifyAt = 0
  private loadedRollSlot?: number
  private lastPageRollAt?: number
  private rollPromise?: Promise<void>
  private rollTimer?: NodeJS.Timeout
  private fingerprintRollSlot?: number
  private fingerprintRollPromise?: Promise<void>
  private fingerprintRollTimer?: NodeJS.Timeout
  private responseListeners = new Set<(event: PredictFunCapturedResponse) => void>()
  private frameListeners = new Set<(event: PredictFunCapturedWebSocketFrame) => void>()
  private statusListeners = new Set<(status: PredictFunPageCaptureStatus) => void>()

  constructor(private readonly fingerprintRuntime?: FingerprintBrowserRuntime) {
    app.once('before-quit', () => {
      this.stopping = true
      this.window?.destroy()
    })
  }

  getStatus(): PredictFunPageCaptureStatus {
    return { ...this.status }
  }

  canExecutePageOrders(durationMinutes?: 5 | 15): boolean {
    if (durationMinutes !== undefined && durationMinutes !== 5 && durationMinutes !== 15) return false
    // Both the app-owned hidden window and the attached fingerprint page use
    // the same logged-in DOM flow.  The fingerprint path never copies cookies
    // or replays a captured request; it clicks the live page and waits for the
    // resulting CreateOrder response on that page's CDP session.
    if (this.status.state !== 'CONNECTED') return false
    const page = durationMinutes === 5 && this.fingerprintSecondaryPage && !this.fingerprintSecondaryPage.isClosed()
      ? this.fingerprintSecondaryPage
      : this.fingerprintPage && !this.fingerprintPage.isClosed()
        ? this.fingerprintPage
      : this.window && !this.window.isDestroyed()
        ? undefined
        : undefined
    if (durationMinutes !== undefined) {
      const rawUrl = page
        ? page.url()
        : this.window && !this.window.isDestroyed()
          ? this.window.webContents.getURL()
          : ''
      if (!isCurrentPredictMarketUrl(rawUrl, durationMinutes)) return false
      const start = Number(rawUrl.match(new RegExp(`/market/btc-updown-${durationMinutes}m-(\\d+)`, 'i'))?.[1] ?? 0) * 1_000
      if (!start || start + durationMinutes * 60_000 - Date.now() < MIN_PAGE_ORDER_REMAINING_MS) return false
    }
    const pageSession = page === this.fingerprintSecondaryPage ? this.fingerprintSecondarySession : this.fingerprintSession
    return Boolean((this.window && !this.window.isDestroyed()) || (page && pageSession))
  }

  startOrderCapture(): PredictFunOrderCaptureSummary {
    this.orderCapturing = true
    this.orderCaptureArmed = false
    this.orderRequestIds.clear()
    this.fillReadbackRequestIds.clear()
    this.marketDiagnosticRequestIds.clear()
    this.allCaptureRequestIds.clear()
    this.orderTrace = []
    this.orderTraceSequence = 0
    return this.getOrderCaptureSummary()
  }

  stopOrderCapture(): PredictFunOrderCaptureSummary {
    this.orderCapturing = false
    this.orderCaptureArmed = false
    this.orderRequestIds.clear()
    this.fillReadbackRequestIds.clear()
    this.marketDiagnosticRequestIds.clear()
    this.allCaptureRequestIds.clear()
    return this.getOrderCaptureSummary()
  }

  clearOrderCapture(): PredictFunOrderCaptureSummary {
    this.orderCapturing = false
    this.orderCaptureArmed = false
    this.orderRequestIds.clear()
    this.fillReadbackRequestIds.clear()
    this.marketDiagnosticRequestIds.clear()
    this.allCaptureRequestIds.clear()
    this.orderTrace = []
    this.orderTraceSequence = 0
    return this.getOrderCaptureSummary()
  }

  getOrderCaptureSummary(): PredictFunOrderCaptureSummary {
    return {
      capturing: this.orderCapturing,
      traceEntryCount: this.orderTrace.length,
      requestCount: this.orderTrace.filter((entry) => entry.kind === 'REQUEST').length,
      responseCount: this.orderTrace.filter((entry) => entry.kind === 'RESPONSE').length,
      webSocketCount: this.orderTrace.filter((entry) => entry.kind === 'WEBSOCKET').length,
      message: this.orderCapturing
        ? '正在采集 Predict.fun 全量接口元数据（仅限手动诊断，最多保留最近 200 条，字段自动脱敏）'
        : this.orderTrace.length
          ? 'Predict.fun 行情/下单链路已停止采集；可导出脱敏元数据'
          : '尚未采集 Predict.fun 行情/下单链路'
    }
  }

  getOrderTrace(): PredictFunOrderTraceEntry[] {
    return this.orderTrace.map((entry) => {
      const resanitized = entry.bodyPreview ? traceBody(entry.bodyPreview).preview : undefined
      return {
        ...entry,
        endpoint: traceEndpoint(entry.endpoint),
        requestFields: entry.requestFields ? [...entry.requestFields] : undefined,
        responseFields: entry.responseFields ? [...entry.responseFields] : undefined,
        bodyPreview: resanitized
      }
    })
  }

  async waitForPageOrderFill(orderId: string, timeoutMs = 8_000): Promise<PredictFunPageOrderFill | undefined> {
    const existing = this.pageOrderFills.get(orderId)
    if (existing) return { ...existing }
    return await new Promise<PredictFunPageOrderFill | undefined>((resolve) => {
      const listeners = this.pageOrderFillWaiters.get(orderId) ?? new Set<(fill: PredictFunPageOrderFill) => void>()
      let timer: NodeJS.Timeout
      const finish = (fill?: PredictFunPageOrderFill): void => {
        clearTimeout(timer)
        listeners.delete(onFill)
        if (listeners.size === 0) this.pageOrderFillWaiters.delete(orderId)
        resolve(fill ? { ...fill } : undefined)
      }
      const onFill = (fill: PredictFunPageOrderFill): void => finish(fill)
      listeners.add(onFill)
      this.pageOrderFillWaiters.set(orderId, listeners)
      timer = setTimeout(() => finish(), Math.max(250, timeoutMs))
      timer.unref()
      // Close the tiny race between checking the cache and registering the
      // waiter if the wallet event arrived in that interval.
      const raced = this.pageOrderFills.get(orderId)
      if (raced) finish(raced)
    })
  }

  private rememberPageOrderFill(fill: PredictFunPageOrderFill): void {
    const existing = this.pageOrderFills.get(fill.orderId)
    const sourcePriority = (source: PredictFunPageOrderFill['source']): number =>
      source === 'ACCOUNT_EVENT_LOG' ? 1 : source === 'ACCOUNT_POSITION' ? 2 : 3
    const selected = !existing ||
      (fill.status === 'FILLED' && existing.status === 'REJECTED') ||
      (fill.status === existing.status && sourcePriority(fill.source) > sourcePriority(existing.source)) ||
      (fill.status === existing.status && sourcePriority(fill.source) === sourcePriority(existing.source) && Number(fill.filledQuantity) >= Number(existing.filledQuantity))
      ? fill
      : existing
    this.pageOrderFills.set(fill.orderId, selected)
    for (const listener of this.pageOrderFillWaiters.get(fill.orderId) ?? []) listener(selected)
    if (this.pageOrderFills.size > 100) {
      const oldest = [...this.pageOrderFills.entries()].sort((a, b) => a[1].filledAt - b[1].filledAt).slice(0, this.pageOrderFills.size - 100)
      for (const [orderId] of oldest) this.pageOrderFills.delete(orderId)
    }
  }

  private ingestPageOrderFillResponse(body: string, receivedAt: number): void {
    for (const fill of parsePredictAccountEventFills(body, receivedAt)) this.rememberPageOrderFill(fill)
    const positions = parsePredictAccountPositions(body)
    if (positions.length > 0) {
      for (const pending of this.pendingPageOrders.values()) {
        const position = positions.find((candidate) => candidate.marketId === pending.marketId &&
          (!candidate.direction || candidate.direction === pending.direction))
        if (!position) continue
        this.rememberPageOrderFill({
          orderId: pending.orderId,
          status: 'FILLED',
          filledQuantity: position.shares,
          averagePrice: position.averagePrice,
          filledAt: receivedAt,
          source: 'ACCOUNT_POSITION'
        })
      }
    }
    const cutoff = receivedAt - 2 * 60_000
    for (const [orderId, pending] of this.pendingPageOrders) {
      if (pending.submittedAt < cutoff || this.pageOrderFills.has(orderId)) this.pendingPageOrders.delete(orderId)
    }
  }

  private rememberPendingPageOrder(body: string, intent: PredictFunPageOrderIntent, submittedAt: number): void {
    const orderId = parsePredictCreateOrderId(body)
    if (!orderId) return
    this.pendingPageOrders.set(orderId, {
      orderId,
      marketId: intent.marketId,
      direction: intent.direction,
      submittedAt
    })
  }

  private pushOrderTrace(entry: Omit<PredictFunOrderTraceEntry, 'sequence'>): void {
    if (!this.orderCapturing) return
    this.orderTrace.push({ sequence: ++this.orderTraceSequence, ...entry })
    if (this.orderTrace.length > 200) this.orderTrace.splice(0, this.orderTrace.length - 200)
  }

  /**
   * Submit through the logged-in Predict.fun page without copying its
   * cookies or replaying a captured request. The page owns the session and
   * Chromium emits the real order request; an uncertain response is surfaced
   * to the execution machine and is never retried automatically.
   */
  async executePageOrder(intent: PredictFunPageOrderIntent): Promise<PredictFunPageOrderResponse> {
    if (!this.canExecutePageOrders(intent.durationMinutes)) throw new Error('Predict.fun 页面未就绪；请先打开已登录的 5m/15m 单页面')
    if (this.fingerprintPage && !this.fingerprintPage.isClosed() && this.fingerprintSession) {
      return await this.executeFingerprintPageOrder(intent)
    }
    const window = this.window!
    const targetUrl = currentPredictMarketUrl(intent.durationMinutes, intent.startTime)
    let currentStart = Number(window.webContents.getURL().match(new RegExp(`/market/btc-updown-${intent.durationMinutes}m-(\\d+)`, 'i'))?.[1] ?? 0) * 1_000
    if (!currentStart || Math.abs(currentStart - intent.startTime) > 60_000) {
      await window.loadURL(targetUrl)
      await new Promise<void>((resolve) => setTimeout(resolve, PAGE_ROLL_SETTLE_MS))
      currentStart = intent.startTime
    }
    if (currentStart + intent.durationMinutes * 60_000 - Date.now() < MIN_PAGE_ORDER_REMAINING_MS) {
      throw new Error('Predict.fun 当前盘剩余不足 60 秒，未操作订单；请等待下一盘')
    }
    const quantity = Number(intent.quantity)
    const price = Number(intent.limitPrice)
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0 || price >= 1) {
      throw new Error('Predict.fun 页面下单数量或价格无效，未操作订单')
    }
    const cost = (quantity * price).toFixed(2)
    const prepared = await this.runPageOrderDom(window, intent, cost, false)
    if (!prepared) throw new Error('Predict.fun 页面未识别买入控件或金额输入，未操作订单')
    if (!intent.allowSubmit) return { status: 200, body: JSON.stringify({ status: 'prepared' }) }

    const debug = window.webContents.debugger
    const requestIds = new Set<string>()
    const orderStartedAt = Date.now()
    const responsePromise = new Promise<PredictFunPageOrderResponse>((resolve, reject) => {
      let settled = false
      const finish = (value: PredictFunPageOrderResponse | Error): void => {
        if (settled) return
        settled = true
        debug.removeListener('message', onMessage)
        clearTimeout(timer)
        value instanceof Error ? reject(value) : resolve(value)
      }
      const timer = setTimeout(() => finish(new Error('已点击 Predict.fun 买入，但 8 秒内没有捕获订单响应；订单状态不明，禁止重试')), 8_000)
      const onMessage = async (_event: unknown, method: string, rawParams: unknown): Promise<void> => {
        const params = rawParams as { requestId?: string; request?: { url?: string; method?: string; postData?: string }; response?: { url?: string; status?: number } }
        if (method === 'Network.requestWillBeSent' && params.requestId && params.request?.method?.toUpperCase() === 'POST' && isPredictOrderUrl(params.request.url ?? '')) {
          const url = params.request.url ?? ''
          const postData = params.request.postData ?? ''
          // Predict.fun currently sends most reads through GraphQL as POST.
          // Only retain a GraphQL request when its operation is a mutation
          // that contains an order/trade verb; this prevents a normal market
          // directory response from being mistaken for an order receipt.
          if (/\/graphql(?:$|\?)/i.test(url) && (!/mutation/i.test(postData) || !/(order|trade|buy|place|create)/i.test(postData))) return
          requestIds.add(params.requestId)
          return
        }
        if (method !== 'Network.responseReceived' || !params.requestId || !requestIds.has(params.requestId)) return
        requestIds.delete(params.requestId)
        try {
          const result = await debug.sendCommand('Network.getResponseBody', { requestId: params.requestId }) as { body?: string; base64Encoded?: boolean }
          const body = result.base64Encoded ? Buffer.from(result.body ?? '', 'base64').toString('utf8') : (result.body ?? '')
          if (!/order|trade|filled|success|error/i.test(body)) return
          this.rememberPendingPageOrder(body, intent, orderStartedAt)
          finish({ status: Number(params.response?.status ?? 0), body })
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      }
      debug.on('message', onMessage)
      void this.runPageOrderDom(window, intent, cost, true).catch((error) => finish(error instanceof Error ? error : new Error(String(error))))
    })
    const response = await responsePromise
    // The passive source keeps the 15m page as its long-lived stream. A 5m
    // page click temporarily reuses the same hidden Chromium window, then
    // returns it to the current 15m page so monitoring resumes without a
    // second renderer. Keep the 5m wallet socket alive briefly so the passive
    // orderTransactionSuccess fill can be consumed before navigation.
    if (intent.durationMinutes === 5 && this.window === window && !window.isDestroyed()) {
      const restoreTimer = setTimeout(() => {
        if (this.window === window && !window.isDestroyed()) void window.loadURL(currentPredictMarketUrl(15)).catch(() => undefined)
      }, 10_000)
      restoreTimer.unref()
    }
    return response
  }

  private async executeFingerprintPageOrder(intent: PredictFunPageOrderIntent): Promise<PredictFunPageOrderResponse> {
    const page = intent.durationMinutes === 5 && this.fingerprintSecondaryPage && !this.fingerprintSecondaryPage.isClosed()
      ? this.fingerprintSecondaryPage
      : this.fingerprintPage
    const session = page === this.fingerprintSecondaryPage ? this.fingerprintSecondarySession : this.fingerprintSession
    if (!page || page.isClosed() || !session) throw new Error('Predict.fun 指纹浏览器页面未就绪；未操作订单')
    if (this.fingerprintRollPromise) await this.fingerprintRollPromise
    const targetUrl = currentPredictMarketUrl(intent.durationMinutes, intent.startTime)
    let currentStart = Number(page.url().match(new RegExp(`/market/btc-updown-${intent.durationMinutes}m-(\\d+)`, 'i'))?.[1] ?? 0) * 1_000
    if (!currentStart || Math.abs(currentStart - intent.startTime) > 60_000) {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_START_TIMEOUT_MS })
      await page.waitForTimeout(PAGE_ROLL_SETTLE_MS)
      currentStart = intent.startTime
    }
    if (currentStart + intent.durationMinutes * 60_000 - Date.now() < MIN_PAGE_ORDER_REMAINING_MS) {
      throw new Error('Predict.fun 当前盘剩余不足 60 秒，未操作订单；请等待下一盘')
    }
    const quantity = Number(intent.quantity)
    const price = Number(intent.limitPrice)
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0 || price >= 1) {
      throw new Error('Predict.fun 页面下单数量或价格无效，未操作订单')
    }
    const cost = (quantity * price).toFixed(2)
    await this.assertFingerprintPageOrderReady(page)
    const prepared = await this.runFingerprintOrderDom(page, intent, cost, false)
    if (!prepared) throw new Error('Predict.fun 页面未识别买入控件或金额输入，未操作订单')

    const requestIds = new Set<string>()
    const orderStartedAt = Date.now()
    const knownFillIds = new Set(this.pageOrderFills.keys())
    const responsePromise = new Promise<PredictFunPageOrderResponse>((resolve, reject) => {
      let settled = false
      const finish = (value: PredictFunPageOrderResponse | Error): void => {
        if (settled) return
        settled = true
        session.removeListener('Network.requestWillBeSent', onRequest)
        session.removeListener('Network.responseReceived', onResponse)
        clearTimeout(timer)
        value instanceof Error ? reject(value) : resolve(value)
      }
      const timer = setTimeout(() => {
        // Page-mode orders can complete through the embedded wallet websocket
        // without a visible CreateOrder HTTP response. Prefer a newly observed
        // fill over reporting an uncertain order, but never reuse an older fill.
        const recentFill = [...this.pageOrderFills.values()]
          .filter((fill) => !knownFillIds.has(fill.orderId) && fill.filledAt >= orderStartedAt - 2_000)
          .sort((a, b) => b.filledAt - a.filledAt)[0]
        if (recentFill) {
          const requested = Number(intent.quantity)
          const filled = Number(recentFill.filledQuantity)
          finish({
            status: 200,
            body: JSON.stringify({
              status: recentFill.status === 'REJECTED'
                ? 'REJECTED'
                : Number.isFinite(requested) && filled >= requested ? 'FILLED' : 'PARTIAL',
              orderId: recentFill.orderId,
              orderHash: recentFill.orderHash,
              filledQuantity: recentFill.filledQuantity,
              grossFilledQuantity: recentFill.grossFilledQuantity,
              feeQuantity: recentFill.feeQuantity,
              averagePrice: recentFill.averagePrice,
              source: recentFill.source,
              message: recentFill.message
            })
          })
          return
        }
        finish(new Error('已点击 Predict.fun 买入，但 8 秒内没有捕获订单响应或钱包成交回报；订单状态不明，禁止重试'))
      }, 8_000)
      const onRequest = (raw: unknown): void => {
        const params = raw as CdpRequestWillBeSent
        if (!params.requestId || params.request?.method?.toUpperCase() !== 'POST') return
        if (isLikelyPredictOrderRequest(params.request.url ?? '', params.request.method, params.request.postData)) requestIds.add(params.requestId)
      }
      const onResponse = async (raw: unknown): Promise<void> => {
        const params = raw as CdpResponseReceived
        if (!params.requestId || !requestIds.has(params.requestId)) return
        requestIds.delete(params.requestId)
        try {
          const result = await session.send('Network.getResponseBody', { requestId: params.requestId }) as { body?: string; base64Encoded?: boolean }
          const body = result.base64Encoded ? Buffer.from(result.body ?? '', 'base64').toString('utf8') : (result.body ?? '')
          if (!/order|trade|filled|success|error/i.test(body)) return
          this.rememberPendingPageOrder(body, intent, orderStartedAt)
          finish({ status: Number(params.response?.status ?? 0), body })
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      }
      session.on('Network.requestWillBeSent', onRequest)
      session.on('Network.responseReceived', onResponse)
      void this.runFingerprintOrderDom(page, intent, cost, true).catch((error) => finish(error instanceof Error ? error : new Error(String(error))))
    })
    const response = await responsePromise
    if (intent.durationMinutes === 5 && page === this.fingerprintPage && !page.isClosed()) {
      const restoreTimer = setTimeout(() => {
        if (this.fingerprintPage === page && !page.isClosed()) void page.goto(currentPredictMarketUrl(15)).catch(() => undefined)
      }, 10_000)
      restoreTimer.unref()
    }
    return response
  }

  private async assertFingerprintPageOrderReady(page: Page): Promise<void> {
    const reason = await page.evaluate(() => {
      const visible = (node: Element): boolean => {
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      }
      const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim()
      const body = normalize(document.body?.innerText ?? '')
      const loginVisible = [...document.querySelectorAll('button,a')].some((node) => visible(node) && /^(?:登录|注册|登录\s*或\s*注册|Log in|Sign up)$/i.test(normalize(node.textContent ?? '')))
      const amountButtons = [...document.querySelectorAll('button')].filter((node) => visible(node) && /^\$\s*\d+(?:[,.]\d+)?\s*(?:赢|Win)(?:\s|$)/i.test(normalize(node.textContent ?? '')))
      const disabledAmount = amountButtons.some((node) => {
        const style = getComputedStyle(node)
        return (node as HTMLButtonElement).disabled || style.pointerEvents === 'none'
      })
      if (loginVisible && disabledAmount) return 'Predict.fun 页面未登录或钱包未连接；请在指纹浏览器完成登录并连接钱包后再测试，当前未操作订单'
      if (/登录\s*或\s*注册|Log in|Sign up/i.test(body) && disabledAmount) return 'Predict.fun 页面需要登录或连接钱包；当前下单控件已禁用，未操作订单'
      return ''
    })
    if (reason) throw new Error(reason)
  }

  private async runFingerprintOrderDom(page: Page, intent: PredictFunPageOrderIntent, cost: string, submit: boolean): Promise<boolean> {
    return await page.evaluate(async ({ direction, cost, submit, startTime, durationMinutes, minRemainingMs }) => {
      const visible = (node: Element | null): boolean => {
        if (!node) return false
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      }
      const text = (node: Element): string => (node.textContent ?? '').trim().replace(/\s+/g, ' ')
      const getButtons = (): HTMLButtonElement[] => [...document.querySelectorAll('button')].filter((node): node is HTMLButtonElement => visible(node))
      const clickText = (matcher: RegExp, exact = false): boolean => {
        const found = getButtons().filter((button) => (exact ? matcher.test(text(button)) : matcher.test(text(button))))
        const target = found.at(-1)
        if (!target || target.disabled) return false
        target.click()
        return true
      }
      const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
      const pageStart = Number(location.pathname.match(new RegExp(`/market/btc-updown-${durationMinutes}m-(\\d+)`, 'i'))?.[1] ?? 0) * 1_000
      if (!pageStart || Math.abs(pageStart - startTime) > 1_000 || pageStart + durationMinutes * 60_000 - Date.now() < minRemainingMs) return false
      clickText(/^(?:买入|Buy)$/, true)
      const editButtons = (): HTMLButtonElement[] => getButtons().filter((button) => /^(?:编辑|Edit)$/.test(text(button)))
      const mainEdit = editButtons().at(-1)
      if (mainEdit) { mainEdit.click(); await wait(180) }
      const isAmountInput = (node: Element): boolean => {
        if (!visible(node)) return false
        const element = node as HTMLInputElement
        const placeholder = (node.getAttribute('placeholder') ?? '').toLowerCase()
        const aria = (node.getAttribute('aria-label') ?? '').toLowerCase()
        if (/search|搜索/.test(`${placeholder}${aria}`)) return false
        const descriptors = `${element.type ?? ''} ${node.getAttribute('inputmode') ?? ''} ${placeholder} ${aria}`
        return node.tagName === 'TEXTAREA' || node.getAttribute('contenteditable') === 'true' || /number|decimal|amount|cost|金额|数量/.test(descriptors) || !placeholder
      }
      let input = [...document.querySelectorAll('input,textarea,[contenteditable="true"]')].find(isAmountInput) as HTMLInputElement | HTMLTextAreaElement | HTMLElement | undefined
      if (!input) {
        const rowEdit = editButtons()[0]
        if (rowEdit) rowEdit.click()
        await wait(180)
        input = [...document.querySelectorAll('input,textarea,[contenteditable="true"]')].find(isAmountInput) as HTMLInputElement | HTMLTextAreaElement | HTMLElement | undefined
      }
      if (!input) return false
      if ('value' in input) {
        const element = input as HTMLInputElement | HTMLTextAreaElement
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, cost)
      } else input.textContent = cost
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      const save = getButtons().find((button) => /^(?:保存|Save)$/.test(text(button)))
      if (!save || save.disabled) return false
      save.click()
      await wait(160)
      const directionPattern = direction === 'UP' ? /^(?:上涨|涨|Up)(?:\s|$)/i : /^(?:下跌|跌|Down)(?:\s|$)/i
      if (!clickText(directionPattern)) return false
      if (!submit) return true
      // Predict.fun renders rolling/animated digits as extra descendants of the
      // amount button. Match the stable prefix instead of requiring the whole
      // textContent to be an exact amount label.
      const quickAmounts = getButtons().filter((button) => button.classList.contains('otb') && /^\$\s*\d+(?:[,.]\d+)?/i.test(text(button)))
      const firstShortcut = quickAmounts[0]
      if (!firstShortcut || firstShortcut.disabled) return false
      firstShortcut.click()
      return true
    }, {
      direction: intent.direction,
      cost,
      submit,
      startTime: intent.startTime,
      durationMinutes: intent.durationMinutes,
      minRemainingMs: MIN_PAGE_ORDER_REMAINING_MS
    })
  }

  private async runPageOrderDom(window: BrowserWindow, intent: PredictFunPageOrderIntent, cost: string, submit: boolean): Promise<boolean> {
    return await window.webContents.executeJavaScript(`(async () => {
      const visible = (node) => {
        if (!node) return false
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      }
      const text = (node) => (node.innerText || node.textContent || '').trim().replace(/\\s+/g, ' ')
      const getButtons = () => [...document.querySelectorAll('button')].filter(visible)
      const clickText = (matcher, exact = false) => {
        const found = getButtons().filter((button) => matcher.test(text(button)))
        const target = found[found.length - 1]
        if (!target) return false
        if (target.disabled) return false
        target.click()
        return true
      }
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      // Predict.fun 1-Tap flow: edit the first shortcut, save it, select the
      // outcome, then click that first shortcut. There is no separate final
      // submit button in this mode.
      clickText(/^(?:买入|Buy)$/, true)
      const editButtons = () => getButtons().filter((button) => /^(?:编辑|Edit)$/.test(text(button)))
      const mainEdit = editButtons().at(-1)
      if (mainEdit) {
        mainEdit.click()
        await wait(180)
      }
      const isAmountInput = (node) => {
        if (!visible(node)) return false
        const placeholder = (node.getAttribute('placeholder') || '').toLowerCase()
        const aria = (node.getAttribute('aria-label') || '').toLowerCase()
        if (/search|搜索/.test(placeholder + aria)) return false
        const descriptors = (node.type || '') + ' ' + (node.getAttribute('inputmode') || '') + ' ' + placeholder + ' ' + aria
        return node.tagName === 'TEXTAREA' || node.getAttribute('contenteditable') === 'true' || /number|decimal|amount|cost|金额|数量/.test(descriptors) || !placeholder
      }
      let input = [...document.querySelectorAll('input,textarea,[contenteditable="true"]')].filter(isAmountInput)[0]
      if (!input) {
        const rowEdit = editButtons()[0]
        if (rowEdit) rowEdit.click()
        await wait(180)
        input = [...document.querySelectorAll('input,textarea,[contenteditable="true"]')].filter(isAmountInput)[0]
      }
      if (!input) return false
      {
        const value = ${JSON.stringify(cost)}
        if ('value' in input) {
          const setter = Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set
          setter?.call(input, value)
        } else input.textContent = value
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
      const save = getButtons().find((button) => /^(?:保存|Save)$/.test(text(button)))
      if (!save || save.disabled) return false
      save.click()
      await wait(160)
      const directionPattern = ${JSON.stringify(intent.direction === 'UP')}
        ? /^(?:上涨|涨|Up)(?:\\s|$)/i
        : /^(?:下跌|跌|Down)(?:\\s|$)/i
      if (!clickText(directionPattern)) return false
      if (!${submit ? 'true' : 'false'}) return true
      // Predict.fun renders rolling/animated digits as extra descendants of the
      // amount button. Match the stable prefix instead of requiring the whole
      // textContent to be an exact amount label.
      const quickAmounts = getButtons().filter((button) => button.classList.contains('otb') && /^\$\s*\d+(?:[,.]\d+)?/i.test(text(button)))
      const firstShortcut = quickAmounts[0]
      if (!firstShortcut || firstShortcut.disabled) return false
      firstShortcut.click()
      return true
    })()`, true)
  }

  onResponse(listener: (event: PredictFunCapturedResponse) => void): () => void {
    this.responseListeners.add(listener)
    return () => this.responseListeners.delete(listener)
  }

  onWebSocketFrame(listener: (event: PredictFunCapturedWebSocketFrame) => void): () => void {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  onStatus(listener: (status: PredictFunPageCaptureStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  async start(show = false): Promise<void> {
    if (this.fingerprintRuntime?.isConfigured()) {
      if (this.fingerprintPage && !this.fingerprintPage.isClosed() && this.fingerprintSession) {
        await this.refreshFingerprintForCurrentRoll(this.fingerprintPage)
        this.scheduleNextFingerprintRoll(this.fingerprintPage)
        if (show) await this.fingerprintPage.bringToFront()
        return
      }
      if (this.fingerprintStartPromise) {
        await this.fingerprintStartPromise
        if (show) await this.fingerprintPage?.bringToFront()
        return
      }
      this.fingerprintStartPromise = this.createFingerprintPage(show)
      try { await this.fingerprintStartPromise } finally { this.fingerprintStartPromise = undefined }
      return
    }
    if (this.window && !this.window.isDestroyed()) {
      await this.refreshForCurrentRoll(this.window)
      if (show) {
        this.window.show()
        this.window.focus()
      }
      return
    }
    if (this.startPromise) {
      await this.startPromise
      if (show) this.open()
      return
    }
    this.startPromise = this.createWindow(show)
    try {
      await this.startPromise
    } finally {
      this.startPromise = undefined
    }
  }

  stop(): void {
    if (this.fingerprintPage || this.fingerprintSession || this.fingerprintStartPromise) {
      void this.fingerprintSession?.detach().catch(() => undefined)
      void this.fingerprintSecondarySession?.detach().catch(() => undefined)
      this.fingerprintSession = undefined
      this.fingerprintSecondarySession = undefined
      this.fingerprintSocketUrls.clear()
      if (this.fingerprintRollTimer) clearTimeout(this.fingerprintRollTimer)
      this.fingerprintRollTimer = undefined
      this.fingerprintRollPromise = undefined
      this.fingerprintRollSlot = undefined
      this.fingerprintPage = undefined
      this.fingerprintSecondaryPage = undefined
      this.setStatus('IDLE', 'Predict.fun 指纹浏览器页面监听已停止；页面本身未关闭')
      return
    }
    const window = this.window
    if (!window || window.isDestroyed()) return
    this.destroying = true
    if (this.rollTimer) clearTimeout(this.rollTimer)
    this.rollTimer = undefined
    window.destroy()
  }

  open(): void {
    if (this.fingerprintPage && !this.fingerprintPage.isClosed()) {
      void this.fingerprintPage.bringToFront()
      return
    }
    if (!this.window || this.window.isDestroyed()) {
      void this.start(true)
      return
    }
    this.window.show()
    this.window.focus()
  }

  private async createWindow(show: boolean): Promise<void> {
    this.setStatus('STARTING', '正在启动单个 Predict.fun 网页；只监听网页自身请求')
    const window = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 900,
      minHeight: 640,
      show,
      title: 'Predict.fun · ArbDesk 被动行情',
      backgroundColor: '#020617',
      webPreferences: {
        partition: 'persist:predict-fun-arbdesk',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // This window is a hidden passive network source. Allow Chromium to
        // throttle page timers when it is not visible; CDP network events and
        // the WebSocket remain available while reducing idle CPU/heat.
        backgroundThrottling: true
      }
    })
    this.window = window
    const startupTimeout = setTimeout(() => {
      if (this.window === window && this.status.state === 'STARTING') {
        this.setStatus(
          'DISCONNECTED',
          'Predict.fun 页面 20 秒内未完成加载；扫描流程未被阻塞。请打开该单页面检查网络或完成人机验证，加载成功后会自动恢复监听'
        )
      }
    }, PAGE_START_TIMEOUT_MS)
    startupTimeout.unref()
    window.webContents.setAudioMuted(true)
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url)
      return { action: 'deny' }
    })
    window.on('close', (event) => {
      if (this.stopping || this.destroying) return
      event.preventDefault()
      window.hide()
    })
    window.on('closed', () => {
      clearTimeout(startupTimeout)
      if (this.rollTimer) clearTimeout(this.rollTimer)
      this.rollTimer = undefined
      if (this.window === window) this.window = undefined
      this.socketUrls.clear()
      this.socketPageUrls.clear()
      const wasDestroying = this.destroying
      this.destroying = false
      this.setStatus(wasDestroying ? 'IDLE' : 'DISCONNECTED', wasDestroying ? 'Predict.fun 网页监听已停止；页面资源已释放' : 'Predict.fun 网页监听窗口已关闭')
    })
    window.webContents.on('did-finish-load', () => {
      clearTimeout(startupTimeout)
      this.setStatus('CONNECTED', this.captureStatusMessage())
      void this.capturePageMarketMetadata(window)
      setTimeout(() => {
        if (this.window === window && !window.isDestroyed()) void this.capturePageMarketMetadata(window)
      }, PAGE_ROLL_SETTLE_MS).unref()
    })
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame) return
      clearTimeout(startupTimeout)
      this.setStatus('DISCONNECTED', `Predict.fun 页面加载失败（${errorCode}）：${errorDescription} · ${validatedUrl}`)
    })
    this.attachDebugger(window, !show)
    const initialRollSlot = Math.floor(Date.now() / PAGE_ROLL_INTERVAL_MS)
    void this.loadCurrentRollPair(window)
      .then(() => {
        this.loadedRollSlot = initialRollSlot
        this.lastPageRollAt = Date.now()
        this.scheduleNextRoll(window)
      })
      .catch((error) => {
        clearTimeout(startupTimeout)
        this.setStatus('DISCONNECTED', `Predict.fun 页面无法打开：${error instanceof Error ? error.message : String(error)}`)
      })
  }

  private async createFingerprintPage(show: boolean): Promise<void> {
    this.setStatus('STARTING', '正在接管已登录的 Predict.fun 指纹浏览器页面；只监听页面自身请求')
    let page: Page
    try {
      page = await this.fingerprintRuntime!.attach('PREDICT_FUN', {
        hosts: ['predict.fun'], createIfMissing: true, startupUrl: currentPredictMarketUrl(15),
        urlPattern: /\/market\/btc-updown-(?:5|15)m-\d+/i
      })
    } catch (error) {
      this.setStatus('DISCONNECTED', `Predict.fun 指纹浏览器接管失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    this.fingerprintPage = page
    page.on('close', () => {
      if (this.fingerprintPage !== page) return
      void this.fingerprintSession?.detach().catch(() => undefined)
      void this.fingerprintSecondarySession?.detach().catch(() => undefined)
      this.fingerprintSession = undefined
      this.fingerprintSecondarySession = undefined
      this.fingerprintPage = undefined
      this.fingerprintSecondaryPage = undefined
      this.fingerprintSocketUrls.clear()
      if (this.fingerprintRollTimer) clearTimeout(this.fingerprintRollTimer)
      this.fingerprintRollTimer = undefined
      this.fingerprintRollPromise = undefined
      this.fingerprintRollSlot = undefined
      this.setStatus('DISCONNECTED', 'Predict.fun 指纹浏览器页面已关闭')
    })
    try {
      const session = await page.context().newCDPSession(page)
      this.fingerprintSession = session
      await session.send('Network.enable')
      session.on('Network.requestWillBeSent', (raw) => {
        const event = raw as CdpRequestWillBeSent
        const url = event.request?.url ?? ''
        const graphqlMetadata = event.requestId && isPredictHost(url) && url.includes('/graphql')
          ? graphqlRequestMetadata(event.request?.postData)
          : undefined
        if (event.requestId && graphqlMetadata) this.graphqlRequests.set(event.requestId, graphqlMetadata)
        if (event.requestId && isLikelyPredictOrderRequest(url, event.request?.method, event.request?.postData)) {
          this.orderCaptureArmed = true
          this.orderRequestIds.add(event.requestId)
          const body = traceBody(event.request?.postData)
          this.pushOrderTrace({ kind: 'REQUEST', endpoint: traceEndpoint(url), method: String(event.request?.method ?? 'POST').toUpperCase(), resourceType: event.type, bodyFormat: body.format, bodyBytes: body.bytes, requestFields: body.fields, operationName: body.operationName, bodyPreview: body.preview, pageUrl: traceEndpoint(page.url()), receivedAt: Date.now() })
        }
        if (this.orderCapturing && event.requestId && isPredictHost(url) && ['XHR', 'Fetch'].includes(event.type ?? '') &&
          !isLikelyPredictOrderRequest(url, event.request?.method, event.request?.postData) &&
          !isLikelyPredictFillReadbackRequest(url, event.request?.method, graphqlMetadata?.operationName) &&
          !isMarketDiagnosticRequest(url, graphqlMetadata?.operationName)) {
          this.allCaptureRequestIds.add(event.requestId)
          const body = traceBody(event.request?.postData)
          this.pushOrderTrace({ kind: 'REQUEST', endpoint: traceEndpoint(url), method: String(event.request?.method ?? 'GET').toUpperCase(), resourceType: event.type, bodyFormat: body.format, bodyBytes: body.bytes, requestFields: body.fields, operationName: graphqlMetadata?.operationName ?? body.operationName, bodyPreview: body.preview, pageUrl: traceEndpoint(page.url()), receivedAt: Date.now() })
        }
        if (this.orderCapturing && this.orderCaptureArmed && event.requestId && isLikelyPredictFillReadbackRequest(url, event.request?.method, graphqlMetadata?.operationName)) {
          this.fillReadbackRequestIds.add(event.requestId)
          const body = traceBody(event.request?.postData)
          this.pushOrderTrace({ kind: 'REQUEST', endpoint: traceEndpoint(url), method: String(event.request?.method ?? 'GET').toUpperCase(), resourceType: event.type, bodyFormat: body.format, bodyBytes: body.bytes, requestFields: body.fields, operationName: graphqlMetadata?.operationName ?? body.operationName, bodyPreview: body.preview, pageUrl: traceEndpoint(page.url()), receivedAt: Date.now() })
        }
        if (this.orderCapturing && event.requestId && isMarketDiagnosticRequest(url, graphqlMetadata?.operationName)) {
          this.marketDiagnosticRequestIds.add(event.requestId)
          const body = traceBody(event.request?.postData)
          this.pushOrderTrace({ kind: 'REQUEST', endpoint: traceEndpoint(url), method: String(event.request?.method ?? 'GET').toUpperCase(), resourceType: event.type, bodyFormat: body.format, bodyBytes: body.bytes, requestFields: body.fields, operationName: graphqlMetadata?.operationName ?? body.operationName, bodyPreview: body.preview, pageUrl: traceEndpoint(page.url()), receivedAt: Date.now() })
        }
      })
      session.on('Network.responseReceived', (raw) => { void this.handleFingerprintResponse(session, page, raw as CdpResponseReceived) })
      session.on('Network.webSocketCreated', (raw) => {
        const event = raw as CdpWebSocketCreated
        if (event.requestId && event.url && isPredictHost(event.url)) this.fingerprintSocketUrls.set(event.requestId, event.url)
      })
      session.on('Network.webSocketClosed', (raw) => {
        const requestId = (raw as { requestId?: string }).requestId
        if (requestId) this.fingerprintSocketUrls.delete(requestId)
      })
      session.on('Network.webSocketFrameReceived', (raw) => this.handleFingerprintFrame(raw as CdpWebSocketFrame, page.url(), 'RECEIVED'))
      session.on('Network.webSocketFrameSent', (raw) => this.handleFingerprintFrame(raw as CdpWebSocketFrame, page.url(), 'SENT'))
      try {
        const secondary = await this.fingerprintRuntime!.attachAdditional({
          hosts: ['predict.fun'], createIfMissing: true, startupUrl: currentPredictMarketUrl(5),
          urlPattern: /\/market\/btc-updown-(?:5|15)m-\d+/i
        })
        this.fingerprintSecondaryPage = secondary
        secondary.on('close', () => {
          if (this.fingerprintSecondaryPage !== secondary) return
          void this.fingerprintSecondarySession?.detach().catch(() => undefined)
          this.fingerprintSecondarySession = undefined
          this.fingerprintSecondaryPage = undefined
        })
        this.fingerprintSecondarySession = await this.attachFingerprintMarketSession(secondary)
        if (!isCurrentPredictMarketUrl(secondary.url(), 5)) {
          await secondary.goto(currentPredictMarketUrl(5), { waitUntil: 'domcontentloaded', timeout: PAGE_START_TIMEOUT_MS })
          await secondary.waitForTimeout(PAGE_ROLL_SETTLE_MS)
        }
      } catch (error) {
        // Keep the primary page usable if Hubstudio refuses a second tab. The
        // status explains that only one rolling WebSocket is then available.
        console.warn(`[Predict.fun] 5m 第二页面监听未建立：${error instanceof Error ? error.message : String(error)}`)
      }
      if (show) await page.bringToFront()
      this.setStatus('CONNECTED', this.captureStatusMessage('已接管指纹浏览器'))
      await this.refreshFingerprintForCurrentRoll(page)
      this.scheduleNextFingerprintRoll(page)
      void this.captureFingerprintPageMarketMetadata(page)
      if (this.fingerprintSecondaryPage) void this.captureFingerprintPageMarketMetadata(this.fingerprintSecondaryPage)
    } catch (error) {
      await this.fingerprintSession?.detach().catch(() => undefined)
      await this.fingerprintSecondarySession?.detach().catch(() => undefined)
      this.fingerprintSession = undefined
      this.fingerprintSecondarySession = undefined
      this.fingerprintPage = undefined
      this.fingerprintSecondaryPage = undefined
      this.setStatus('DISCONNECTED', `Predict.fun 指纹浏览器网络监听失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async attachFingerprintMarketSession(page: Page): Promise<CDPSession> {
    const session = await page.context().newCDPSession(page)
    await session.send('Network.enable')
    session.on('Network.requestWillBeSent', (raw) => {
      const event = raw as CdpRequestWillBeSent
      const url = event.request?.url ?? ''
      if (event.requestId && isPredictHost(url) && url.includes('/graphql')) {
        const metadata = graphqlRequestMetadata(event.request?.postData)
        if (metadata) this.graphqlRequests.set(event.requestId, metadata)
      }
    })
    session.on('Network.responseReceived', (raw) => { void this.handleFingerprintResponse(session, page, raw as CdpResponseReceived) })
    session.on('Network.webSocketCreated', (raw) => {
      const event = raw as CdpWebSocketCreated
      if (event.requestId && event.url && isPredictHost(event.url)) this.fingerprintSocketUrls.set(event.requestId, event.url)
    })
    session.on('Network.webSocketClosed', (raw) => {
      const requestId = (raw as { requestId?: string }).requestId
      if (requestId) this.fingerprintSocketUrls.delete(requestId)
    })
    session.on('Network.webSocketFrameReceived', (raw) => this.handleFingerprintFrame(raw as CdpWebSocketFrame, page.url(), 'RECEIVED'))
    session.on('Network.webSocketFrameSent', (raw) => this.handleFingerprintFrame(raw as CdpWebSocketFrame, page.url(), 'SENT'))
    return session
  }

  private async captureFingerprintPageMarketMetadata(page: Page): Promise<void> {
    try {
      const metadata = await page.evaluate(() => {
        const pageUrl = location.href
        const categorySlug = /\/market\/(btc-updown-(?:5|15)m-\d+)/i.exec(location.pathname)?.[1]
        const html = document.documentElement.innerHTML
        const marketId = [...html.matchAll(/(?:marketId|market_id)[^0-9]{0,12}(\d{4,})/gi)].map((match) => match[1]).find((id) => /^\d+$/.test(id)) || ''
        const outcomeIds = [...html.matchAll(/onChainId.{0,24}?(\d{20,})/g)].map((match) => match[1]).filter((id, index, all) => all.indexOf(id) === index).slice(0, 2)
        return categorySlug && /^\d+$/.test(marketId) ? { pageUrl, categorySlug, marketId, outcomeIds } : null
      }) as { pageUrl: string; categorySlug: string; marketId: string; outcomeIds: string[] } | null
      if (!metadata || (this.fingerprintPage !== page && this.fingerprintSecondaryPage !== page)) return
      const start = Number(metadata.categorySlug.match(/-(\d+)$/)?.[1])
      if (!Number.isFinite(start)) return
      const duration = metadata.categorySlug.includes('-5m-') ? 5 : 15
      const body = {
        success: true,
        data: [{ slug: metadata.categorySlug, startsAt: new Date(start * 1_000).toISOString(), endsAt: new Date((start + duration * 60) * 1_000).toISOString(), status: 'OPEN', marketVariant: 'CRYPTO_UP_DOWN', variantData: { type: 'CRYPTO_UP_DOWN', priceFeedSymbol: 'BTCUSDT' }, markets: [{ id: Number(metadata.marketId), tradingStatus: 'OPEN', decimalPrecision: 2, outcomes: metadata.outcomeIds.length >= 2 ? metadata.outcomeIds.map((onChainId, index) => ({ name: index === 0 ? 'Up' : 'Down', index: index + 1, onChainId })) : [{ name: 'Up', index: 1, onChainId: `predict-page:${metadata.marketId}:up` }, { name: 'Down', index: 2, onChainId: `predict-page:${metadata.marketId}:down` }] }] }]
      }
      const captured: PredictFunCapturedResponse = { url: `${new URL(metadata.pageUrl).origin}/v1/categories/page-metadata`, body: JSON.stringify(body), receivedAt: Date.now(), pageUrl: metadata.pageUrl, operationName: 'FingerprintPageMarketMetadata', requestSlugs: [metadata.categorySlug], requestMarketIds: [metadata.marketId] }
      for (const listener of this.responseListeners) listener(captured)
    } catch {
      // DOM metadata is a fallback; CDP network capture remains authoritative.
    }
  }

  private async handleFingerprintResponse(session: CDPSession, page: Page, event: CdpResponseReceived): Promise<void> {
    const url = event.response?.url ?? ''
    const isAllCaptureResponse = Boolean(event.requestId && this.allCaptureRequestIds.has(event.requestId))
    if (!event.requestId || (!isUsefulResponse(url) && !isAllCaptureResponse) || !['XHR', 'Fetch'].includes(event.type ?? '')) return
    const isOrderResponse = this.orderRequestIds.has(event.requestId)
    if (isOrderResponse) this.orderRequestIds.delete(event.requestId)
    const isFillReadbackResponse = this.fillReadbackRequestIds.has(event.requestId)
    if (isFillReadbackResponse) this.fillReadbackRequestIds.delete(event.requestId)
    const isMarketDiagnosticResponse = this.marketDiagnosticRequestIds.has(event.requestId)
    if (isMarketDiagnosticResponse) this.marketDiagnosticRequestIds.delete(event.requestId)
    if (isAllCaptureResponse) this.allCaptureRequestIds.delete(event.requestId)
    try {
      const result = await session.send('Network.getResponseBody', { requestId: event.requestId }) as { body?: string; base64Encoded?: boolean }
      const body = result.base64Encoded ? Buffer.from(result.body ?? '', 'base64').toString('utf8') : (result.body ?? '')
      if (body) this.ingestPageOrderFillResponse(body, Date.now())
      if (isOrderResponse) {
        const meta = traceBody(body)
        this.pushOrderTrace({ kind: 'RESPONSE', endpoint: traceEndpoint(url), status: event.response?.status, resourceType: event.type, bodyFormat: meta.format, bodyBytes: meta.bytes, responseFields: meta.fields, operationName: meta.operationName, bodyPreview: meta.preview, pageUrl: traceEndpoint(page.url()), receivedAt: Date.now() })
      }
      if (isFillReadbackResponse) {
        const meta = traceBody(body)
        this.pushOrderTrace({ kind: 'RESPONSE', endpoint: traceEndpoint(url), status: event.response?.status, resourceType: event.type, bodyFormat: meta.format, bodyBytes: meta.bytes, responseFields: meta.fields, operationName: meta.operationName, bodyPreview: meta.preview, pageUrl: traceEndpoint(page.url()), receivedAt: Date.now() })
      }
      if (!body && isAllCaptureResponse) {
        this.pushOrderTrace({ kind: 'RESPONSE', endpoint: traceEndpoint(url), status: event.response?.status, resourceType: event.type, bodyFormat: 'EMPTY', bodyBytes: 0, responseFields: [], pageUrl: traceEndpoint(page.url()), receivedAt: Date.now() })
      }
      if (!body) return
      const requestMetadata = this.graphqlRequests.get(event.requestId)
      this.graphqlRequests.delete(event.requestId)
      if (isMarketDiagnosticResponse) {
        const meta = traceBody(body)
        this.pushOrderTrace({ kind: 'RESPONSE', endpoint: traceEndpoint(url), status: event.response?.status, resourceType: event.type, bodyFormat: meta.format, bodyBytes: meta.bytes, responseFields: meta.fields, operationName: requestMetadata?.operationName ?? meta.operationName, bodyPreview: meta.preview, pageUrl: traceEndpoint(page.url()), receivedAt: Date.now() })
      }
      if (isAllCaptureResponse) {
        const meta = traceBody(body)
        this.pushOrderTrace({ kind: 'RESPONSE', endpoint: traceEndpoint(url), status: event.response?.status, resourceType: event.type, bodyFormat: meta.format, bodyBytes: meta.bytes, responseFields: meta.fields, operationName: requestMetadata?.operationName ?? meta.operationName, bodyPreview: meta.preview, pageUrl: traceEndpoint(page.url()), receivedAt: Date.now() })
      }
      const captured: PredictFunCapturedResponse = { url, body, receivedAt: Date.now(), pageUrl: page.url(), operationName: requestMetadata?.operationName, requestSlugs: requestMetadata?.slugs, requestMarketIds: requestMetadata?.marketIds }
      this.responseCount += 1
      this.lastCaptureAt = captured.receivedAt
      this.setStatus('CONNECTED', this.captureStatusMessage('已接管指纹浏览器'))
      for (const listener of this.responseListeners) listener(captured)
    } catch {
      // Cached, redirected or evicted responses may disappear before CDP reads them.
    }
  }

  private handleFingerprintFrame(event: CdpWebSocketFrame, pageUrl: string, direction: 'SENT' | 'RECEIVED'): void {
    const frame = event.response ?? event.request
    if (!event.requestId || frame?.opcode !== 1 || typeof frame.payloadData !== 'string') return
    const payload = frame.payloadData
    const pageFill = parsePredictPageOrderFillEvent(payload)
    if (pageFill) this.rememberPageOrderFill(pageFill)
    // If the fingerprint page was already open when CDP attached, Chrome does
    // not replay Network.webSocketCreated for the existing socket. We can
    // still safely bind a market frame to this Predict.fun page: only payloads
    // carrying an orderbook/status marker are accepted, and the page URL is
    // restricted to predict.fun. This closes the intermittent "0 WS frames /
    // all quotes stale" gap without creating another request or socket.
    let url = this.fingerprintSocketUrls.get(event.requestId)
    if (!url) {
      const isPredictMarketPage = isPredictHost(pageUrl) && /\/market\/btc-updown-(?:5|15)m-\d+/i.test(pageUrl)
      const isLikelyMarketPayload = /predictOrderbook|predict(?:Trading|Market)Status|order[._:/-]?book|"type"\s*:\s*"M"/i.test(payload)
      if (!isPredictMarketPage || (!isLikelyMarketPayload && !this.orderCapturing)) return
      url = 'wss://ws.predict.fun/unknown'
      this.fingerprintSocketUrls.set(event.requestId, url)
    }
    if (this.orderCapturing && payload.length <= 2_000_000) {
      const body = traceBody(payload)
      this.pushOrderTrace({ kind: 'WEBSOCKET', endpoint: traceEndpoint(url), direction, bodyFormat: body.format, bodyBytes: body.bytes, responseFields: body.fields, operationName: body.operationName, bodyPreview: body.preview, pageUrl: traceEndpoint(pageUrl), receivedAt: Date.now() })
    }
    if (payload.length > 2_000_000 || !/predictOrderbook|predict(?:Trading|Market)Status|order[._:/-]?book|"type"\s*:\s*"M"/i.test(payload)) return
    const captured = { url, payload, receivedAt: Date.now(), pageUrl }
    this.webSocketFrameCount += 1
    this.lastCaptureAt = captured.receivedAt
    this.setStatus('CONNECTED', this.captureStatusMessage('已接管指纹浏览器'))
    for (const listener of this.frameListeners) listener(captured)
  }

  /** Keep both rolling market tabs on the current pair so both WebSockets stay live. */
  private async refreshFingerprintForCurrentRoll(page: Page): Promise<void> {
    const rollSlot = Math.floor(Date.now() / PAGE_ROLL_INTERVAL_MS)
    if (this.fingerprintRollSlot === rollSlot) return
    if (this.fingerprintRollPromise) return await this.fingerprintRollPromise
    this.fingerprintRollPromise = (async () => {
      await page.goto(currentPredictMarketUrl(15), { waitUntil: 'domcontentloaded', timeout: PAGE_START_TIMEOUT_MS })
      await page.waitForTimeout(PAGE_ROLL_SETTLE_MS)
      const secondary = this.fingerprintSecondaryPage
      if (secondary && !secondary.isClosed()) {
        await secondary.goto(currentPredictMarketUrl(5), { waitUntil: 'domcontentloaded', timeout: PAGE_START_TIMEOUT_MS })
        await secondary.waitForTimeout(PAGE_ROLL_SETTLE_MS)
      }
      this.fingerprintRollSlot = rollSlot
      this.lastPageRollAt = Date.now()
    })()
    try {
      await this.fingerprintRollPromise
    } catch (error) {
      this.setStatus('DISCONNECTED', `Predict.fun 指纹浏览器自动换轮失败：${error instanceof Error ? error.message : String(error)}`)
      throw error
    } finally {
      this.fingerprintRollPromise = undefined
    }
  }

  private scheduleNextFingerprintRoll(page: Page): void {
    if (this.fingerprintRollTimer) clearTimeout(this.fingerprintRollTimer)
    const now = Date.now()
    const nextBoundary = (Math.floor(now / PAGE_ROLL_INTERVAL_MS) + 1) * PAGE_ROLL_INTERVAL_MS
    this.fingerprintRollTimer = setTimeout(async () => {
      this.fingerprintRollTimer = undefined
      if (this.fingerprintPage !== page || page.isClosed()) return
      try {
        await this.refreshFingerprintForCurrentRoll(page)
        void this.captureFingerprintPageMarketMetadata(page)
        if (this.fingerprintSecondaryPage) void this.captureFingerprintPageMarketMetadata(this.fingerprintSecondaryPage)
      } catch { /* status already explains the failure */ }
      if (this.fingerprintPage === page && !page.isClosed()) this.scheduleNextFingerprintRoll(page)
    }, Math.max(1_000, nextBoundary - now + PAGE_ROLL_SETTLE_MS))
    this.fingerprintRollTimer.unref()
  }

  private async refreshForCurrentRoll(window: BrowserWindow): Promise<void> {
    const rollSlot = Math.floor(Date.now() / PAGE_ROLL_INTERVAL_MS)
    if (this.loadedRollSlot === rollSlot) return
    if (this.rollPromise) return await this.rollPromise
    this.rollPromise = this.loadCurrentRollPair(window)
      .then(() => {
        this.loadedRollSlot = rollSlot
        this.lastPageRollAt = Date.now()
      })
      .catch((error) => {
        this.setStatus('DISCONNECTED', `Predict.fun 新轮次页面刷新失败：${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => { this.rollPromise = undefined })
    await this.rollPromise
  }

  // A single hidden BrowserWindow visits both rolling pages in sequence. This
  // gives the page its own 5m and 15m directory queries without keeping two
  // Chromium renderers alive; the final page remains 15m for stable streaming.
  private async loadCurrentRollPair(window: BrowserWindow): Promise<void> {
    await window.loadURL(currentPredictMarketUrl(5))
    await new Promise<void>((resolve) => setTimeout(resolve, PAGE_ROLL_SETTLE_MS))
    await window.loadURL(currentPredictMarketUrl(15))
  }

  private async capturePageMarketMetadata(window: BrowserWindow): Promise<void> {
    try {
      const metadata = await window.webContents.executeJavaScript(`(() => {
        const pageUrl = location.href
        const categorySlug = /\\/market\\/(btc-updown-(?:5|15)m-\\d+)/i.exec(location.pathname)?.[1]
        const image = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || ''
        const html = document.documentElement.innerHTML
        const marketId = [
          ...image.matchAll(/(?:marketId|market_id)[^0-9]{0,12}(\\d{4,})/gi),
          ...html.matchAll(/(?:marketId|market_id)[^0-9]{0,12}(\\d{4,})/gi)
        ].map((match) => match[1]).find((id) => /^\\d+$/.test(id)) || ''
        const outcomeIds = [...html.matchAll(/onChainId.{0,24}?(\\d{20,})/g)].map((match) => match[1]).filter((id, index, all) => all.indexOf(id) === index).slice(0, 2)
        return categorySlug && /^\\d+$/.test(marketId) ? { pageUrl, categorySlug, marketId, outcomeIds } : null
      })()`, true) as PredictPageMarketMetadata | null
      if (!metadata || this.window !== window) return
      const start = Number(metadata.categorySlug.match(/-(\\d+)$/)?.[1])
      if (!Number.isFinite(start)) return
      const duration = metadata.categorySlug.includes('-5m-') ? 5 : 15
      const outcomes = metadata.outcomeIds.length >= 2
        ? metadata.outcomeIds.map((onChainId, index) => ({ name: index === 0 ? 'Up' : 'Down', index: index + 1, onChainId }))
        : [{ name: 'Up', index: 1, onChainId: `predict-page:${metadata.marketId}:up` }, { name: 'Down', index: 2, onChainId: `predict-page:${metadata.marketId}:down` }]
      const body = {
        success: true,
        data: [{
          slug: metadata.categorySlug,
          startsAt: new Date(start * 1_000).toISOString(),
          endsAt: new Date((start + duration * 60) * 1_000).toISOString(),
          status: 'OPEN',
          marketVariant: 'CRYPTO_UP_DOWN',
          variantData: { type: 'CRYPTO_UP_DOWN', priceFeedSymbol: 'BTCUSDT' },
          markets: [{ id: Number(metadata.marketId), tradingStatus: 'OPEN', decimalPrecision: 2, outcomes }]
        }]
      }
      const captured: PredictFunCapturedResponse = {
        url: `${new URL(metadata.pageUrl).origin}/v1/categories/page-metadata`,
        body: JSON.stringify(body),
        receivedAt: Date.now(),
        pageUrl: metadata.pageUrl,
        operationName: 'PageMarketMetadata',
        requestSlugs: [metadata.categorySlug],
        requestMarketIds: [metadata.marketId]
      }
      for (const listener of this.responseListeners) listener(captured)
    } catch {
      // Page metadata is an optional directory fallback; network capture stays intact.
    }
  }

  private scheduleNextRoll(window: BrowserWindow): void {
    if (this.rollTimer) clearTimeout(this.rollTimer)
    const now = Date.now()
    const nextBoundary = (Math.floor(now / PAGE_ROLL_INTERVAL_MS) + 1) * PAGE_ROLL_INTERVAL_MS
    this.rollTimer = setTimeout(async () => {
      this.rollTimer = undefined
      if (this.window !== window || window.isDestroyed()) return
      await this.refreshForCurrentRoll(window)
      if (this.window === window && !window.isDestroyed()) this.scheduleNextRoll(window)
    }, Math.max(1_000, nextBoundary - now + PAGE_ROLL_SETTLE_MS))
    this.rollTimer.unref()
  }

  private attachDebugger(window: BrowserWindow, backgroundCapture: boolean): void {
    const debug = window.webContents.debugger
    try {
      if (!debug.isAttached()) debug.attach('1.3')
    } catch (error) {
      this.setStatus('DISCONNECTED', `无法启动 Predict.fun 被动监听：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    void debug.sendCommand('Network.enable').then(() => {
      if (!backgroundCapture) return
      return debug.sendCommand('Network.setBlockedURLs', {
        urls: ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.svg', '*.woff', '*.woff2', '*.ttf', '*.mp4', '*.webm', '*google-analytics*', '*googletagmanager*', '*doubleclick*']
      })
    }).catch((error) => {
      this.setStatus('DISCONNECTED', `无法启用 Predict.fun 网络监听：${error instanceof Error ? error.message : String(error)}`)
    })
    debug.on('message', (_event, method, rawParams) => {
      if (method === 'Network.requestWillBeSent') {
        const event = rawParams as CdpRequestWillBeSent
        const url = event.request?.url ?? ''
        const graphqlMetadata = event.requestId && isPredictHost(url) && url.includes('/graphql')
          ? graphqlRequestMetadata(event.request?.postData)
          : undefined
        if (event.requestId && graphqlMetadata) this.graphqlRequests.set(event.requestId, graphqlMetadata)
        if (event.requestId && isLikelyPredictOrderRequest(url, event.request?.method, event.request?.postData)) {
          this.orderCaptureArmed = true
          this.orderRequestIds.add(event.requestId)
          const body = traceBody(event.request?.postData)
          this.pushOrderTrace({
            kind: 'REQUEST', endpoint: traceEndpoint(url), method: String(event.request?.method ?? 'POST').toUpperCase(), resourceType: event.type,
            bodyFormat: body.format, bodyBytes: body.bytes, requestFields: body.fields, operationName: body.operationName,
            bodyPreview: body.preview, pageUrl: traceEndpoint(window.webContents.getURL()), receivedAt: Date.now()
          })
        }
        if (this.orderCapturing && event.requestId && isPredictHost(url) && ['XHR', 'Fetch'].includes(event.type ?? '') &&
          !isLikelyPredictOrderRequest(url, event.request?.method, event.request?.postData) &&
          !isLikelyPredictFillReadbackRequest(url, event.request?.method, graphqlMetadata?.operationName) &&
          !isMarketDiagnosticRequest(url, graphqlMetadata?.operationName)) {
          this.allCaptureRequestIds.add(event.requestId)
          const body = traceBody(event.request?.postData)
          this.pushOrderTrace({
            kind: 'REQUEST', endpoint: traceEndpoint(url), method: String(event.request?.method ?? 'GET').toUpperCase(), resourceType: event.type,
            bodyFormat: body.format, bodyBytes: body.bytes, requestFields: body.fields, operationName: graphqlMetadata?.operationName ?? body.operationName,
            bodyPreview: body.preview, pageUrl: traceEndpoint(window.webContents.getURL()), receivedAt: Date.now()
          })
        }
        if (this.orderCapturing && this.orderCaptureArmed && event.requestId && isLikelyPredictFillReadbackRequest(url, event.request?.method, graphqlMetadata?.operationName)) {
          this.fillReadbackRequestIds.add(event.requestId)
          const body = traceBody(event.request?.postData)
          this.pushOrderTrace({
            kind: 'REQUEST', endpoint: traceEndpoint(url), method: String(event.request?.method ?? 'GET').toUpperCase(), resourceType: event.type,
            bodyFormat: body.format, bodyBytes: body.bytes, requestFields: body.fields, operationName: graphqlMetadata?.operationName ?? body.operationName,
            bodyPreview: body.preview, pageUrl: traceEndpoint(window.webContents.getURL()), receivedAt: Date.now()
          })
        }
        if (this.orderCapturing && event.requestId && isMarketDiagnosticRequest(url, graphqlMetadata?.operationName)) {
          this.marketDiagnosticRequestIds.add(event.requestId)
          const body = traceBody(event.request?.postData)
          this.pushOrderTrace({
            kind: 'REQUEST', endpoint: traceEndpoint(url), method: String(event.request?.method ?? 'GET').toUpperCase(), resourceType: event.type,
            bodyFormat: body.format, bodyBytes: body.bytes, requestFields: body.fields, operationName: graphqlMetadata?.operationName ?? body.operationName,
            bodyPreview: body.preview, pageUrl: traceEndpoint(window.webContents.getURL()), receivedAt: Date.now()
          })
        }
        return
      }
      if (method === 'Network.responseReceived') {
        void this.handleResponse(window, rawParams as CdpResponseReceived)
        return
      }
      if (method === 'Network.webSocketCreated') {
        const event = rawParams as CdpWebSocketCreated
        if (event.requestId && event.url && isPredictHost(event.url)) {
          this.socketUrls.set(event.requestId, event.url)
          this.socketPageUrls.set(event.requestId, window.webContents.getURL())
        }
        return
      }
      if (method === 'Network.webSocketClosed') {
        const requestId = (rawParams as { requestId?: string }).requestId
        if (requestId) {
          this.socketUrls.delete(requestId)
          this.socketPageUrls.delete(requestId)
          this.orderRequestIds.delete(requestId)
        }
        return
      }
      if (method === 'Network.webSocketFrameReceived') this.handleFrame(window, rawParams as CdpWebSocketFrame, 'RECEIVED')
      if (method === 'Network.webSocketFrameSent') this.handleFrame(window, rawParams as CdpWebSocketFrame, 'SENT')
    })
    debug.on('detach', (_event, reason) => {
      if (!this.stopping) this.setStatus('DISCONNECTED', `Predict.fun 网络监听已断开：${reason}`)
    })
  }

  private async handleResponse(window: BrowserWindow, event: CdpResponseReceived): Promise<void> {
    const url = event.response?.url ?? ''
    const isAllCaptureResponse = Boolean(event.requestId && this.allCaptureRequestIds.has(event.requestId))
    if (!event.requestId || (!isUsefulResponse(url) && !isAllCaptureResponse) || !['XHR', 'Fetch'].includes(event.type ?? '')) return
    const isOrderResponse = this.orderRequestIds.has(event.requestId)
    if (isOrderResponse) this.orderRequestIds.delete(event.requestId)
    const isFillReadbackResponse = this.fillReadbackRequestIds.has(event.requestId)
    if (isFillReadbackResponse) this.fillReadbackRequestIds.delete(event.requestId)
    const isMarketDiagnosticResponse = this.marketDiagnosticRequestIds.has(event.requestId)
    if (isMarketDiagnosticResponse) this.marketDiagnosticRequestIds.delete(event.requestId)
    if (isAllCaptureResponse) this.allCaptureRequestIds.delete(event.requestId)
    try {
      const result = await window.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: event.requestId }) as {
        body?: string
        base64Encoded?: boolean
      }
      if (!result.body) {
        if (isOrderResponse) this.pushOrderTrace({ kind: 'RESPONSE', endpoint: traceEndpoint(url), status: event.response?.status, resourceType: event.type, bodyFormat: 'EMPTY', bodyBytes: 0, responseFields: [], pageUrl: traceEndpoint(window.webContents.getURL()), receivedAt: Date.now() })
        if (isFillReadbackResponse) this.pushOrderTrace({ kind: 'RESPONSE', endpoint: traceEndpoint(url), status: event.response?.status, resourceType: event.type, bodyFormat: 'EMPTY', bodyBytes: 0, responseFields: [], pageUrl: traceEndpoint(window.webContents.getURL()), receivedAt: Date.now() })
        if (isAllCaptureResponse) this.pushOrderTrace({ kind: 'RESPONSE', endpoint: traceEndpoint(url), status: event.response?.status, resourceType: event.type, bodyFormat: 'EMPTY', bodyBytes: 0, responseFields: [], pageUrl: traceEndpoint(window.webContents.getURL()), receivedAt: Date.now() })
        return
      }
      const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body
      this.ingestPageOrderFillResponse(body, Date.now())
      const requestMetadata = this.graphqlRequests.get(event.requestId)
      this.graphqlRequests.delete(event.requestId)
      const captured: PredictFunCapturedResponse = {
        url,
        body,
        receivedAt: Date.now(),
        pageUrl: window.webContents.getURL(),
        operationName: requestMetadata?.operationName,
        requestSlugs: requestMetadata?.slugs,
        requestMarketIds: requestMetadata?.marketIds
      }
      if (isOrderResponse) {
        const bodyMeta = traceBody(body)
        this.pushOrderTrace({ kind: 'RESPONSE', endpoint: traceEndpoint(url), status: event.response?.status, resourceType: event.type, bodyFormat: bodyMeta.format, bodyBytes: bodyMeta.bytes, responseFields: bodyMeta.fields, operationName: bodyMeta.operationName, bodyPreview: bodyMeta.preview, pageUrl: traceEndpoint(window.webContents.getURL()), receivedAt: Date.now() })
      }
      if (isFillReadbackResponse) {
        const bodyMeta = traceBody(body)
        this.pushOrderTrace({ kind: 'RESPONSE', endpoint: traceEndpoint(url), status: event.response?.status, resourceType: event.type, bodyFormat: bodyMeta.format, bodyBytes: bodyMeta.bytes, responseFields: bodyMeta.fields, operationName: requestMetadata?.operationName ?? bodyMeta.operationName, bodyPreview: bodyMeta.preview, pageUrl: traceEndpoint(window.webContents.getURL()), receivedAt: Date.now() })
      }
      if (isMarketDiagnosticResponse) {
        const bodyMeta = traceBody(body)
        this.pushOrderTrace({ kind: 'RESPONSE', endpoint: traceEndpoint(url), status: event.response?.status, resourceType: event.type, bodyFormat: bodyMeta.format, bodyBytes: bodyMeta.bytes, responseFields: bodyMeta.fields, operationName: requestMetadata?.operationName ?? bodyMeta.operationName, bodyPreview: bodyMeta.preview, pageUrl: traceEndpoint(window.webContents.getURL()), receivedAt: Date.now() })
      }
      if (isAllCaptureResponse) {
        const bodyMeta = traceBody(body)
        this.pushOrderTrace({ kind: 'RESPONSE', endpoint: traceEndpoint(url), status: event.response?.status, resourceType: event.type, bodyFormat: bodyMeta.format, bodyBytes: bodyMeta.bytes, responseFields: bodyMeta.fields, operationName: requestMetadata?.operationName ?? bodyMeta.operationName, bodyPreview: bodyMeta.preview, pageUrl: traceEndpoint(window.webContents.getURL()), receivedAt: Date.now() })
      }
      this.responseCount += 1
      this.lastCaptureAt = captured.receivedAt
      this.setStatus('CONNECTED', this.captureStatusMessage())
      for (const listener of this.responseListeners) listener(captured)
    } catch {
      // Cached, redirected or already-evicted responses can disappear before getResponseBody.
    }
  }

  private handleFrame(window: BrowserWindow, event: CdpWebSocketFrame, direction: 'SENT' | 'RECEIVED'): void {
    const frame = event.response ?? event.request
    if (!event.requestId || frame?.opcode !== 1 || typeof frame.payloadData !== 'string') return
    const url = this.socketUrls.get(event.requestId)
    if (!url) return
    const payload = frame.payloadData
    const pageFill = parsePredictPageOrderFillEvent(payload)
    if (pageFill) this.rememberPageOrderFill(pageFill)
    if (this.orderCapturing && payload.length <= 2_000_000) {
      const body = traceBody(payload)
      this.pushOrderTrace({ kind: 'WEBSOCKET', endpoint: traceEndpoint(url), direction, bodyFormat: body.format, bodyBytes: body.bytes, responseFields: body.fields, operationName: body.operationName, bodyPreview: body.preview, pageUrl: traceEndpoint(this.socketPageUrls.get(event.requestId) ?? window.webContents.getURL()), receivedAt: Date.now() })
    }
    // Predict.fun pages also carry heartbeats, presence and UI telemetry.
    // Only forward likely orderbook frames to the JSON parser; no API key is
    // required for this passive page path.
    if (payload.length > 2_000_000 || !/predictOrderbook|predict(?:Trading|Market)Status|order[._:/-]?book|"type"\s*:\s*"M"/i.test(payload)) return
    const captured = { url, payload, receivedAt: Date.now(), pageUrl: this.socketPageUrls.get(event.requestId) ?? window.webContents.getURL() }
    this.webSocketFrameCount += 1
    this.lastCaptureAt = captured.receivedAt
    this.setStatus('CONNECTED', this.captureStatusMessage())
    for (const listener of this.frameListeners) listener(captured)
  }

  private captureStatusMessage(prefix = '单页面'): string {
    const roll = this.lastPageRollAt ? `；页面目录最近换轮 ${new Date(this.lastPageRollAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''
    const pair = this.fingerprintSecondaryPage && !this.fingerprintSecondaryPage.isClosed()
      ? '；指纹浏览器 5m/15m 双页面同时监听'
      : ''
    return `Predict.fun ${prefix}被动监听在线；已捕获 ${this.responseCount} 个目标 REST/GraphQL 响应、${this.webSocketFrameCount} 个 WebSocket 帧${roll}${pair}，没有额外调用内部接口`
  }

  private setStatus(state: PredictFunPageCaptureStatus['state'], message: string): void {
    const now = Date.now()
    this.status = {
      state,
      message,
      updatedAt: now,
      responseCount: this.responseCount,
      webSocketFrameCount: this.webSocketFrameCount,
      lastCaptureAt: this.lastCaptureAt
    }
    if (state === 'CONNECTED' && now - this.lastStatusNotifyAt < 500) return
    this.lastStatusNotifyAt = now
    for (const listener of this.statusListeners) listener(this.getStatus())
  }
}
