import type { GateOrderCaptureSummary } from '../../shared/types'
import type { VenueExecutionRequest } from '../platforms/venue-adapter'
import { isGateHost, type GateCapturedRequest, type GateCapturedResponse, type GatePageCaptureSource } from './gate-page-capture'

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
  private readonly executionReady?: () => boolean
  private unsubscribe?: () => void

  constructor(source?: Pick<GatePageCaptureSource, 'onRequest' | 'onResponse'>, executionReady?: () => boolean) {
    this.executionReady = executionReady
    if (source) {
      const stopRequest = source.onRequest((event) => this.observe(event))
      const stopResponse = source.onResponse((event) => this.observeResponse(event))
      this.unsubscribe = () => { stopRequest(); stopResponse() }
    }
  }

  startCapture(): void {
    if (this.schema) return
    this.capturing = true
  }

  stopCapture(): void { this.capturing = false }

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
    this.capturing = false
  }

  observeResponse(event: GateCapturedResponse): void {
    let parsed: unknown
    try { parsed = JSON.parse(event.body) } catch { return }
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) { for (const child of value) visit(child); return }
      const item = value as Record<string, unknown>
      const id = item.order_id ?? item.orderId
      const rawStatus = String(item.status ?? item.order_status ?? item.orderStatus ?? '').toUpperCase()
      if ((typeof id === 'string' || typeof id === 'number') && rawStatus) {
        const normalizedStatus: GateCapturedOrderResult['status'] = /FILLED|EXECUTED|COMPLETED|DONE/.test(rawStatus)
          ? 'FILLED' : /PARTIAL/.test(rawStatus) ? 'PARTIAL' : /CANCEL/.test(rawStatus) ? 'CANCELED'
            : /REJECT|FAIL|ERROR/.test(rawStatus) ? 'REJECTED' : /ACCEPT|OPEN|REST/.test(rawStatus) ? 'ACCEPTED' : 'UNKNOWN'
        const result: GateCapturedOrderResult = {
          orderId: String(id), status: normalizedStatus,
          filledQuantity: String(item.filled_quantity ?? item.filledQuantity ?? item.executed_quantity ?? item.executedQuantity ?? '0'),
          averagePrice: item.avg_price !== undefined ? String(item.avg_price) : item.average_price !== undefined ? String(item.average_price) : undefined,
          message: typeof item.message === 'string' ? item.message : undefined
        }
        this.results.set(result.orderId, result)
      }
      for (const child of Object.values(item)) visit(child)
    }
    visit(parsed)
  }

  buildRequest(request: VenueExecutionRequest): GatePreparedRequest {
    const schema = this.schema
    if (!schema || !this.templateBody || typeof this.templateBody !== 'object') throw new Error('尚未捕获 Gate 可复用的订单请求体')
    const replaced = new Set<string>()
    const replace = (key: string, value: string): string => { replaced.add(key); return value }
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
      ['quantity', 'qty', 'size', 'amount'], ['price', 'limitprice', 'outcomeprice']
    ]
    if (required.some((group) => !group.some((field) => keys.includes(field)))) throw new Error('Gate 捕获订单缺少可安全替换的市场、结果、数量或价格字段')
    return { endpoint: this.replayEndpoint ?? schema.endpoint, method: schema.method, body: JSON.stringify(body), pageUrl: schema.pageUrl }
  }

  getSchema(): GateOrderSchema | undefined { return this.schema ? { ...this.schema, requestFields: [...this.schema.requestFields] } : undefined }
  getSummary(): GateOrderCaptureSummary {
    const schema = this.getSchema()
    return schema
      ? { captured: true, executionReady: this.executionReady?.() ?? false, endpoint: schema.endpoint, method: schema.method, requestFields: schema.requestFields, pageUrl: schema.pageUrl, capturedAt: schema.capturedAt, message: this.executionReady?.() ? '已捕获 Gate 事件合约订单结构；当前指纹页面可执行' : '已捕获订单结构，但当前不是可执行的指纹浏览器页面' }
      : { captured: false, executionReady: this.executionReady?.() ?? false, message: this.capturing ? '正在等待你在 Gate 指纹浏览器中手动完成一次最小订单' : '尚未捕获 Gate 事件合约订单结构' }
  }
  getResult(orderId: string): GateCapturedOrderResult | undefined {
    const result = this.results.get(orderId)
    return result ? { ...result } : undefined
  }
  clear(): void { this.schema = undefined; this.replayEndpoint = undefined; this.templateBody = undefined }
  dispose(): void { this.unsubscribe?.(); this.unsubscribe = undefined }
}
