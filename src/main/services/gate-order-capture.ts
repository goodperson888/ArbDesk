import Decimal from 'decimal.js'
import type { GateOrderCaptureSummary } from '../../shared/types'
import type { VenueExecutionRequest } from '../platforms/venue-adapter'
import { isGateHost, type GateCapturedRequest, type GateCapturedResponse, type GateCapturedWebSocketFrame, type GatePageCaptureSource } from './gate-page-capture'

export interface GateOrderSchema {
  endpoint: string
  method: string
  requestFields: string[]
  responseFields?: string[]
  pageUrl?: string
  capturedAt: number
}

export interface GatePreparedRequest {
  endpoint: string
  method: string
  body: string
  pageUrl?: string
}

export interface GateCapturedOrderResult {
  orderId: string
  status: 'ACCEPTED' | 'FILLED' | 'PARTIAL' | 'REJECTED' | 'UNKNOWN' | 'CANCELED'
  filledQuantity: string
  averagePrice?: string
  message?: string
}

const ORDER_ID_KEYS = ['order_id', 'orderId', 'order_no', 'orderNo', 'orderID', 'client_order_id', 'clientOrderId', 'id'] as const
const STATUS_KEYS = ['status', 'order_status', 'orderStatus', 'state', 'order_state', 'orderState'] as const
const FILLED_QUANTITY_KEYS = [
  'filled_quantity', 'filledQuantity', 'executed_quantity', 'executedQuantity',
  'filled_size', 'filledSize', 'deal_size', 'dealSize', 'matched_size', 'matchedSize',
  'size_filled', 'sizeFilled', 'filled_amount', 'filledAmount', 'executed_size', 'executedSize',
  'matched_quantity', 'matchedQuantity'
] as const
const AVERAGE_PRICE_KEYS = [
  'avg_price', 'average_price', 'avgPrice', 'averagePrice', 'fill_price', 'fillPrice',
  'deal_price', 'dealPrice', 'executed_price', 'executedPrice', 'matched_price', 'matchedPrice'
] as const

function firstField(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key]
  return undefined
}

function normalizeOrderStatus(value: unknown, httpStatus = 200): GateCapturedOrderResult['status'] {
  const raw = String(value ?? '').toUpperCase()
  if (/FILLED|EXECUTED|COMPLETED|DONE/.test(raw)) return 'FILLED'
  if (/PARTIAL/.test(raw)) return 'PARTIAL'
  if (/CANCEL/.test(raw)) return 'CANCELED'
  if (/REJECT|FAIL|ERROR/.test(raw) || httpStatus >= 400) return 'REJECTED'
  if (/ACCEPT|OPEN|REST|PENDING|NEW/.test(raw) || (httpStatus >= 200 && httpStatus < 300)) return 'ACCEPTED'
  return 'UNKNOWN'
}

/** Normalize the order-shaped records emitted by Gate place-order, order history, and WS events. */
export function parseGateOrderRecord(value: unknown, httpStatus = 200): GateCapturedOrderResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  const id = firstField(item, ORDER_ID_KEYS)
  if (typeof id !== 'string' && typeof id !== 'number') return undefined
  const rawStatus = firstField(item, STATUS_KEYS)
  const filled = firstField(item, FILLED_QUANTITY_KEYS)
  const average = firstField(item, AVERAGE_PRICE_KEYS)
  const normalizedKeys = new Set(Object.keys(item).map((key) => key.toLowerCase().replace(/[-_]/g, '')))
  const explicitOrderId = ORDER_ID_KEYS.slice(0, -1).some((key) => item[key] !== undefined && item[key] !== null)
  const orderSignals = rawStatus !== undefined || filled !== undefined || average !== undefined ||
    ['side', 'marketid', 'eventid', 'tokenid', 'outcomeid', 'ordertype', 'orderstatus'].some((key) => normalizedKeys.has(key))
  // A bare `id` occurs on many unrelated Gate objects. Only treat it as an order
  // id when the record also has an order/fill signal.
  if (!explicitOrderId && !orderSignals) return undefined
  const filledQuantity = filled === undefined ? '0' : String(filled)
  const averagePrice = average === undefined ? undefined : String(average)
  const status = normalizeOrderStatus(rawStatus, httpStatus)
  return {
    orderId: String(id), status, filledQuantity, averagePrice,
    message: typeof item.message === 'string' ? item.message : undefined
  }
}

export function parseGateOrderResults(body: string, httpStatus = 200): GateCapturedOrderResult[] {
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return [] }
  const results: GateCapturedOrderResult[] = []
  const visit = (value: unknown): void => {
    const result = parseGateOrderRecord(value, httpStatus)
    if (result) results.push(result)
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const child of value) visit(child); return }
    for (const child of Object.values(value as Record<string, unknown>)) visit(child)
  }
  visit(parsed)
  return results
}

export type GateOrderTraceKind = 'REQUEST' | 'RESPONSE' | 'WEBSOCKET'

export interface GateOrderTraceEntry {
  sequence: number
  kind: GateOrderTraceKind
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
  orderIds?: string[]
  pageUrl?: string
  receivedAt: number
}

type GateOrderCaptureSource = Pick<GatePageCaptureSource, 'onRequest' | 'onResponse'> & Partial<Pick<GatePageCaptureSource, 'onWebSocketFrame' | 'onNetworkRequest' | 'onNetworkResponse' | 'onRawWebSocketFrame'>>

const MAX_TRACE_ENTRIES = 500

function bodyFields(body: string | undefined): string[] {
  if (!body) return []
  try {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    const fields = new Set<string>()
    const visit = (value: unknown, prefix = ''): void => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const field = prefix ? `${prefix}.${key}` : key
        if (key.length > 0) fields.add(field)
        visit(child, field)
      }
    }
    visit(parsed)
    return [...fields].sort()
  } catch {
    return []
  }
}

function parseBody(body: string | undefined): { parsed?: unknown; format: GateOrderTraceEntry['bodyFormat']; fields: string[]; operationName?: string; orderIds: string[] } {
  if (!body) return { format: 'EMPTY', fields: [], orderIds: [] }
  try {
    const parsed = JSON.parse(body) as unknown
    const fields = bodyFields(body)
    const orderIds = new Set<string>()
    let operationName: string | undefined
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) { for (const child of value) visit(child); return }
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const normalized = key.toLowerCase().replace(/[-_]/g, '')
        if ((normalized === 'orderid' || normalized === 'clientorderid') && (typeof child === 'string' || typeof child === 'number')) orderIds.add(String(child))
        if (!operationName && (normalized === 'operationname' || normalized === 'operation') && typeof child === 'string') operationName = child
        visit(child)
      }
    }
    visit(parsed)
    return { parsed, format: 'JSON', fields, operationName, orderIds: [...orderIds].slice(0, 20) }
  } catch {
    try {
      const params = new URLSearchParams(body)
      const fields = [...new Set([...params.keys()])].sort()
      return { format: 'FORM', fields, orderIds: [] }
    } catch {
      return { format: 'TEXT', fields: [], orderIds: [] }
    }
  }
}

function traceEndpoint(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return rawUrl
  }
}

function sanitizeEndpoint(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    // Query strings on private order endpoints can contain one-time tokens.
    // The captured request is replayed only against the same path; credentials
    // continue to come from the logged-in Gate page.
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return rawUrl
  }
}

function isLikelyOrderEndpoint(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return /order|trade|execution|position|place/i.test(url.pathname)
  } catch {
    return false
  }
}

export class GateOrderCapture {
  private capturing = false
  private schema?: GateOrderSchema
  private replayEndpoint?: string
  private templateBody?: unknown
  private results = new Map<string, GateCapturedOrderResult>()
  private trace: GateOrderTraceEntry[] = []
  private traceSequence = 0
  private readonly executionReady?: () => boolean
  private readonly source?: GateOrderCaptureSource
  private stopNetworkCapture?: () => void
  private unsubscribe?: () => void

  constructor(source?: GateOrderCaptureSource, executionReady?: () => boolean) {
    this.source = source
    this.executionReady = executionReady
    if (source) {
      const stopRequest = source.onRequest((event) => this.observe(event))
      const stopResponse = source.onResponse((event) => this.observeResponse(event))
      const stopWebSocket = source.onWebSocketFrame?.((event) => {
        if (event.direction === 'SENT') return
        this.observeResponse({ url: event.url, body: event.payload, receivedAt: event.receivedAt })
      })
      this.unsubscribe = () => { stopRequest(); stopResponse(); stopWebSocket?.(); this.stopNetworkCapture?.(); this.stopNetworkCapture = undefined }
    }
  }

  startCapture(): void {
    this.schema = undefined
    this.replayEndpoint = undefined
    this.templateBody = undefined
    this.results.clear()
    this.trace = []
    this.traceSequence = 0
    this.capturing = true
    this.stopNetworkCapture?.()
    const stopNetworkRequest = this.source?.onNetworkRequest?.((event) => this.observeNetworkRequest(event))
    const stopNetworkResponse = this.source?.onNetworkResponse?.((event) => this.observeNetworkResponse(event))
    const stopRawFrame = this.source?.onRawWebSocketFrame?.((event) => this.observeWebSocketFrame(event))
    this.stopNetworkCapture = () => { stopNetworkRequest?.(); stopNetworkResponse?.(); stopRawFrame?.() }
  }

  stopCapture(): void { this.capturing = false; this.stopNetworkCapture?.(); this.stopNetworkCapture = undefined }

  observe(event: GateCapturedRequest): void {
    if (!this.capturing || this.schema || !isGateHost(event.url)) return
    const method = event.method.toUpperCase()
    if (!['POST', 'PUT', 'PATCH'].includes(method)) return
    if (!isLikelyOrderEndpoint(event.url)) return
    let parsedBody: unknown
    try { parsedBody = event.body ? JSON.parse(event.body) : undefined } catch { parsedBody = undefined }
    this.templateBody = parsedBody
    this.replayEndpoint = event.url
    this.schema = {
      endpoint: sanitizeEndpoint(event.url),
      method,
      requestFields: bodyFields(event.body),
      pageUrl: event.pageUrl,
      capturedAt: event.receivedAt
    }
  }

  private pushTrace(entry: Omit<GateOrderTraceEntry, 'sequence'>): void {
    if (!this.capturing) return
    this.trace.push({ sequence: ++this.traceSequence, ...entry })
    if (this.trace.length > MAX_TRACE_ENTRIES) this.trace.splice(0, this.trace.length - MAX_TRACE_ENTRIES)
  }

  observeNetworkRequest(event: GateCapturedRequest): void {
    if (!this.capturing || !isGateHost(event.url)) return
    const body = parseBody(event.body)
    this.pushTrace({
      kind: 'REQUEST', endpoint: traceEndpoint(event.url), method: event.method.toUpperCase(), resourceType: event.resourceType,
      bodyFormat: body.format, bodyBytes: event.body?.length ?? 0, requestFields: body.fields,
      operationName: body.operationName, orderIds: body.orderIds, pageUrl: event.pageUrl ? traceEndpoint(event.pageUrl) : undefined, receivedAt: event.receivedAt
    })
  }

  observeNetworkResponse(event: GateCapturedResponse): void {
    if (!this.capturing || !isGateHost(event.url)) return
    const body = parseBody(event.body)
    this.pushTrace({
      kind: 'RESPONSE', endpoint: traceEndpoint(event.url), status: event.status, resourceType: event.resourceType,
      bodyFormat: body.format, bodyBytes: event.body.length, responseFields: body.fields,
      operationName: body.operationName, orderIds: body.orderIds, pageUrl: event.pageUrl ? traceEndpoint(event.pageUrl) : undefined, receivedAt: event.receivedAt
    })
  }

  observeWebSocketFrame(event: GateCapturedWebSocketFrame): void {
    if (!this.capturing || !isGateHost(event.url)) return
    const body = parseBody(event.payload)
    this.pushTrace({
      kind: 'WEBSOCKET', endpoint: traceEndpoint(event.url), direction: event.direction, bodyFormat: body.format,
      bodyBytes: event.payload.length, responseFields: body.fields, operationName: body.operationName,
      orderIds: body.orderIds, pageUrl: event.pageUrl ? traceEndpoint(event.pageUrl) : undefined, receivedAt: event.receivedAt
    })
  }

  observeResponse(event: GateCapturedResponse): void {
    for (const result of parseGateOrderResults(event.body, event.status ?? 200)) this.results.set(result.orderId, result)
  }

  buildRequest(request: VenueExecutionRequest): GatePreparedRequest {
    const schema = this.schema
    if (!schema || !this.templateBody || typeof this.templateBody !== 'object') throw new Error('尚未捕获 Gate 可复用的订单请求体')
    const replaced = new Set<string>()
    const replace = (key: string, value: string): string => { replaced.add(key); return value }
    const totalCost = new Decimal(request.quantity).mul(new Decimal(request.limitPrice)).toFixed()
    const visit = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(visit)
      if (!value || typeof value !== 'object') return value
      const record = value as Record<string, unknown>
      return Object.fromEntries(Object.entries(record).map(([key, child]) => {
        const normalized = key.toLowerCase().replace(/[-_]/g, '')
        if (['marketid', 'eventid', 'contractid'].includes(normalized)) return [key, replace(key, request.marketId)]
        if (['outcomeid', 'tokenid', 'contracttokenid'].includes(normalized)) return [key, replace(key, request.outcomeId)]
        if (['quantity', 'qty', 'size', 'amount'].includes(normalized)) return [key, replace(key, request.quantity)]
        if (['price', 'limitprice', 'outcomeprice'].includes(normalized)) return [key, replace(key, request.limitPrice)]
        if (['totalcost', 'cost', 'totalamount'].includes(normalized)) return [key, replace(key, totalCost)]
        if (normalized === 'direction' || normalized === 'outcome') return [key, replace(key, request.direction)]
        if (normalized === 'clientorderid') return [key, replace(key, request.clientOrderId)]
        if (normalized === 'timeinforce') return [key, replace(key, request.timeInForce)]
        return [key, visit(child)]
      }))
    }
    const body = visit(this.templateBody)
    const keys = [...replaced].map((key) => key.toLowerCase().replace(/[-_]/g, ''))
    const required = [
      ['marketid', 'eventid', 'contractid'], ['outcomeid', 'tokenid', 'contracttokenid'],
      ['quantity', 'qty', 'size', 'amount'], ['price', 'limitprice', 'outcomeprice', 'totalcost', 'cost', 'totalamount']
    ]
    if (required.some((group) => !group.some((field) => keys.includes(field)))) throw new Error('Gate 捕获订单缺少可安全替换的市场、结果、数量或价格字段')
    return { endpoint: this.replayEndpoint ?? schema.endpoint, method: schema.method, body: JSON.stringify(body), pageUrl: schema.pageUrl }
  }

  getSchema(): GateOrderSchema | undefined { return this.schema ? { ...this.schema, requestFields: [...this.schema.requestFields] } : undefined }

  /** Restore only the sanitized order schema exported by a prior capture.
   * The request body, cookies and signatures are intentionally never restored;
   * page-click execution does not need them and the replay fallback remains
   * blocked until a fresh in-memory template is captured.
   */
  restoreSchema(schema: Partial<GateOrderSchema> | undefined): boolean {
    if (!schema || typeof schema.endpoint !== 'string' || !isGateHost(schema.endpoint)) return false
    let url: URL
    try { url = new URL(schema.endpoint) } catch { return false }
    if (url.protocol !== 'https:' || url.pathname !== '/apiw/v2/event-contract/place-order') return false
    const method = String(schema.method ?? '').toUpperCase()
    const requestFields = Array.isArray(schema.requestFields) ? schema.requestFields.filter((field): field is string => typeof field === 'string') : []
    if (method !== 'POST' || !requestFields.length) return false
    this.schema = {
      endpoint: url.toString(), method, requestFields,
      pageUrl: typeof schema.pageUrl === 'string' ? schema.pageUrl : undefined,
      capturedAt: Number.isFinite(Number(schema.capturedAt)) ? Number(schema.capturedAt) : Date.now()
    }
    this.replayEndpoint = undefined
    this.templateBody = undefined
    return true
  }
  getTrace(): GateOrderTraceEntry[] {
    return this.trace.map((entry) => ({
      ...entry,
      requestFields: entry.requestFields ? [...entry.requestFields] : undefined,
      responseFields: entry.responseFields ? [...entry.responseFields] : undefined,
      orderIds: entry.orderIds ? [...entry.orderIds] : undefined
    }))
  }

  getSummary(): GateOrderCaptureSummary {
    const schema = this.getSchema()
    return schema
      ? { captured: true, capturing: this.capturing, executionReady: this.executionReady?.() ?? false, endpoint: schema.endpoint, method: schema.method, requestFields: schema.requestFields, pageUrl: schema.pageUrl, capturedAt: schema.capturedAt, traceEntryCount: this.trace.length, candidateCount: this.trace.filter((entry) => entry.kind === 'REQUEST').length, responseCount: this.trace.filter((entry) => entry.kind === 'RESPONSE').length, webSocketCount: this.trace.filter((entry) => entry.kind === 'WEBSOCKET').length, message: this.executionReady?.() ? '已捕获 Gate 订单候选；链路仍在内存采集，可停止后导出脱敏元数据' : '已捕获订单候选，但当前不是可执行的指纹浏览器页面' }
      : { captured: false, capturing: this.capturing, executionReady: this.executionReady?.() ?? false, traceEntryCount: this.trace.length, candidateCount: this.trace.filter((entry) => entry.kind === 'REQUEST').length, responseCount: this.trace.filter((entry) => entry.kind === 'RESPONSE').length, webSocketCount: this.trace.filter((entry) => entry.kind === 'WEBSOCKET').length, message: this.capturing ? '正在采集 Gate 页面所有脱敏网络元数据；请手动完成一次最小订单' : this.executionReady?.() ? 'Gate 指纹页面已接管；实盘订单将通过后台控件点击，不需要 API Key 或保存请求体' : '尚未接管可执行的 Gate 指纹浏览器页面' }
  }
  getResult(orderId: string): GateCapturedOrderResult | undefined {
    const result = this.results.get(orderId)
    return result ? { ...result } : undefined
  }
  clear(): void { this.stopCapture(); this.schema = undefined; this.replayEndpoint = undefined; this.templateBody = undefined; this.trace = []; this.traceSequence = 0; this.results.clear() }
  dispose(): void { this.unsubscribe?.(); this.unsubscribe = undefined }
}
