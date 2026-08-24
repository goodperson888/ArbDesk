import type { VenueExecutionRequest } from '../platforms/venue-adapter'
import { GateOrderCapture, type GateCapturedOrderResult, type GatePreparedRequest } from './gate-order-capture'
import type { GateCapturedResponse, GatePageOrderIntent } from './gate-page-capture'

export interface GateCapturedHttpResponse { status: number; body: string }

export interface GatePageOrderExecutor {
  canExecutePageOrders?(): boolean
  executePageOrder?(request: GatePageOrderIntent): Promise<GateCapturedHttpResponse>
  executeCapturedOrder(request: GatePreparedRequest): Promise<GateCapturedHttpResponse>
}

function statusFrom(value: unknown, httpStatus: number): GateCapturedOrderResult['status'] {
  const raw = String(value ?? '').toUpperCase()
  if (/FILLED|EXECUTED|COMPLETED|DONE/.test(raw)) return 'FILLED'
  if (/PARTIAL/.test(raw)) return 'PARTIAL'
  if (/CANCEL/.test(raw)) return 'CANCELED'
  if (/REJECT|FAIL|ERROR/.test(raw) || httpStatus >= 400) return 'REJECTED'
  if (/ACCEPT|OPEN|REST/.test(raw) || (httpStatus >= 200 && httpStatus < 300)) return 'ACCEPTED'
  return 'UNKNOWN'
}

function parseResult(body: string, httpStatus: number): GateCapturedOrderResult {
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { parsed = undefined }
  const queue: unknown[] = [parsed]
  while (queue.length) {
    const current = queue.shift()
    if (!current || typeof current !== 'object') continue
    if (Array.isArray(current)) { queue.push(...current); continue }
    const item = current as Record<string, unknown>
    const id = item.order_id ?? item.orderId
    if (typeof id === 'string' || typeof id === 'number') {
      return {
        orderId: String(id), status: statusFrom(item.status ?? item.order_status ?? item.orderStatus, httpStatus),
        filledQuantity: String(item.filled_quantity ?? item.filledQuantity ?? item.executed_quantity ?? item.executedQuantity ?? '0'),
        averagePrice: item.avg_price !== undefined ? String(item.avg_price) : item.average_price !== undefined ? String(item.average_price) : undefined,
        message: typeof item.message === 'string' ? item.message : undefined
      }
    }
    queue.push(...Object.values(item))
  }
  return { orderId: '', status: statusFrom(undefined, httpStatus), filledQuantity: '0' }
}

export class GateBrowserOrderTransport {
  constructor(private readonly capture: GateOrderCapture, private readonly page: GatePageOrderExecutor) {}

  getSchema() { return this.capture.getSchema() }
  canExecutePageOrders(): boolean { return this.page.canExecutePageOrders?.() ?? false }

  async submit(request: VenueExecutionRequest): Promise<GateCapturedOrderResult> {
    if (this.page.executePageOrder && this.canExecutePageOrders()) {
      const response = await this.page.executePageOrder({
        marketId: request.marketId,
        outcomeId: request.outcomeId,
        direction: request.direction,
        quantity: request.quantity,
        limitPrice: request.limitPrice,
        clientOrderId: request.clientOrderId,
        durationMinutes: Math.round((request.endTime - request.startTime) / 60_000) as 5 | 15,
        allowSubmit: true
      })
      const result = parseResult(response.body, response.status)
      const captured: GateCapturedResponse = { url: 'https://www.gate.com/apiw/v2/event-contract/place-order', body: response.body, receivedAt: Date.now(), status: response.status }
      this.capture.observeResponse(captured)
      return result
    }
    const prepared = this.capture.buildRequest(request)
    const response = await this.page.executeCapturedOrder(prepared)
    const result = parseResult(response.body, response.status)
    const captured: GateCapturedResponse = { url: prepared.endpoint, body: response.body, receivedAt: Date.now(), pageUrl: prepared.pageUrl }
    this.capture.observeResponse(captured)
    return result
  }

  async reconcile(orderId: string): Promise<GateCapturedOrderResult | undefined> {
    return this.capture.getResult(orderId)
  }
}
