import type { VenueExecutionRequest } from '../platforms/venue-adapter'
import { GateOrderCapture, parseGateOrderResults, type GateCapturedOrderResult, type GatePreparedRequest } from './gate-order-capture'
import type { GateCapturedResponse, GatePageOrderIntent } from './gate-page-capture'

export interface GateCapturedHttpResponse { status: number; body: string }

export interface GatePageOrderExecutor {
  canExecutePageOrders?(): boolean
  executePageOrder?(request: GatePageOrderIntent): Promise<GateCapturedHttpResponse>
  executeCapturedOrder(request: GatePreparedRequest): Promise<GateCapturedHttpResponse>
}

function parseResult(body: string, httpStatus: number): GateCapturedOrderResult {
  return parseGateOrderResults(body, httpStatus)[0] ?? { orderId: '', status: httpStatus >= 400 ? 'REJECTED' : httpStatus >= 200 && httpStatus < 300 ? 'ACCEPTED' : 'UNKNOWN', filledQuantity: '0' }
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
    const captured: GateCapturedResponse = { url: prepared.endpoint, body: response.body, receivedAt: Date.now(), status: response.status, pageUrl: prepared.pageUrl }
    this.capture.observeResponse(captured)
    return result
  }

  async reconcile(orderId: string): Promise<GateCapturedOrderResult | undefined> {
    const deadline = Date.now() + 2_000
    while (true) {
      const result = this.capture.getResult(orderId)
      if (result) return result
      if (Date.now() >= deadline) return undefined
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
  }
}
