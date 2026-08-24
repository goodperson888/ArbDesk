import { describe, expect, it } from 'vitest'
import { GateOrderCapture } from './gate-order-capture'
import type { GateCapturedRequest, GateCapturedResponse, GateCapturedWebSocketFrame, GatePageCaptureSource } from './gate-page-capture'

function request(overrides: Partial<GateCapturedRequest> = {}): GateCapturedRequest {
  return {
    url: 'https://www.gate.com/api/event-contract/orders',
    method: 'POST',
    headers: {
      cookie: 'session=secret',
      authorization: 'Bearer secret',
      sign: 'signature-secret',
      'content-type': 'application/json'
    },
    body: '{"market_id":"m1","side":"buy","quantity":"1"}',
    pageUrl: 'https://www.gate.com/zh/trade-events/btc-updown-15m?eventId=m1',
    receivedAt: Date.now(),
    ...overrides
  }
}

describe('GateOrderCapture', () => {
  it('captures only an explicit manual order request and redacts secrets', () => {
    const capture = new GateOrderCapture()
    capture.observe(request())
    expect(capture.getSchema()).toBeUndefined()

    capture.startCapture()
    capture.observe(request())
    expect(capture.getSchema()).toMatchObject({
      endpoint: 'https://www.gate.com/api/event-contract/orders',
      method: 'POST',
      pageUrl: 'https://www.gate.com/zh/trade-events/btc-updown-15m?eventId=m1'
    })
    const schema = capture.getSchema()!
    expect(schema.requestFields).toEqual(['market_id', 'quantity', 'side'])
    expect(JSON.stringify(schema)).not.toContain('secret')
    expect(JSON.stringify(schema)).not.toContain('signature')
    expect(JSON.stringify(schema)).not.toContain('market_id":"m1')
  })

  it('strips query tokens and ignores non-order mutation endpoints', () => {
    const capture = new GateOrderCapture()
    capture.startCapture()
    capture.observe(request({ url: 'https://www.gate.com/api/event-contract/markets?token=secret' }))
    expect(capture.getSchema()).toBeUndefined()
    capture.observe(request({ url: 'https://www.gate.com/api/event-contract/orders?nonce=secret' }))
    expect(capture.getSchema()?.endpoint).toBe('https://www.gate.com/api/event-contract/orders')
    expect(JSON.stringify(capture.getSchema())).not.toContain('secret')
  })

  it('ignores read-only requests and keeps the capture session open for the rest of the order chain', () => {
    const capture = new GateOrderCapture()
    capture.startCapture()
    capture.observe(request({ method: 'GET', url: 'https://www.gate.com/api/event-contract/markets' }))
    expect(capture.getSchema()).toBeUndefined()
    capture.observe(request())
    capture.observe(request({ url: 'https://www.gate.com/api/event-contract/orders/second' }))
    expect(capture.getSchema()?.endpoint).toBe('https://www.gate.com/api/event-contract/orders')
    expect(capture.getSummary().capturing).toBe(true)
  })

  it('builds a new order body only by replacing fields proven by the captured template', () => {
    const capture = new GateOrderCapture()
    capture.startCapture()
    capture.observe(request({ body: JSON.stringify({ market_id: 'old-market', outcome_id: 'old-token', quantity: '1', price: '0.40', side: 'buy' }) }))
    const built = capture.buildRequest({
      marketId: 'new-market', outcomeId: 'new-token', direction: 'DOWN', quantity: '2', limitPrice: '0.52',
      startTime: Date.now(), endTime: Date.now() + 300_000, quoteReceivedAt: Date.now(), timeInForce: 'FOK', clientOrderId: 'client-1'
    })
    expect(JSON.parse(built.body)).toMatchObject({ market_id: 'new-market', outcome_id: 'new-token', quantity: '2', price: '0.52', side: 'buy' })
    expect(built.endpoint).toContain('/orders')
  })

  it('keeps only normalized order status fields for later reconciliation', () => {
    const capture = new GateOrderCapture()
    capture.observeResponse({
      url: 'https://www.gate.com/api/event-contract/orders/gate-1',
      body: JSON.stringify({ data: { order_id: 'gate-1', status: 'filled', filled_quantity: '2', avg_price: '0.50' } }),
      receivedAt: Date.now()
    })
    expect(capture.getResult('gate-1')).toMatchObject({ orderId: 'gate-1', status: 'FILLED', filledQuantity: '2', averagePrice: '0.50' })
  })

  it('records a complete sanitized request/response/websocket trace until capture is stopped', () => {
    const requests: Array<(event: GateCapturedRequest) => void> = []
    const responses: Array<(event: GateCapturedResponse) => void> = []
    const frames: Array<(event: GateCapturedWebSocketFrame) => void> = []
    const source = {
      onRequest: (listener: (event: GateCapturedRequest) => void) => { requests.push(listener); return () => undefined },
      onResponse: (listener: (event: GateCapturedResponse) => void) => { responses.push(listener); return () => undefined },
      onNetworkRequest: (listener: (event: GateCapturedRequest) => void) => { requests.push(listener); return () => undefined },
      onNetworkResponse: (listener: (event: GateCapturedResponse) => void) => { responses.push(listener); return () => undefined },
      onRawWebSocketFrame: (listener: (event: GateCapturedWebSocketFrame) => void) => { frames.push(listener); return () => undefined }
    } satisfies Pick<GatePageCaptureSource, 'onRequest' | 'onResponse'> & Record<string, unknown>
    const capture = new GateOrderCapture(source)
    capture.startCapture()
    requests[1]?.({ url: 'https://www.gate.com/graphql', method: 'POST', body: JSON.stringify({ operationName: 'placeOrder', variables: { marketId: 'm1', quantity: '1', authToken: 'secret' } }), receivedAt: Date.now() })
    responses[1]?.({ url: 'https://www.gate.com/graphql', status: 200, body: JSON.stringify({ data: { placeOrder: { orderId: 'o-1', status: 'accepted' } } }), receivedAt: Date.now() })
    frames[0]?.({ url: 'wss://fx-ws.gateio.ws/ws', direction: 'SENT', payload: JSON.stringify({ op: 'order.create', orderId: 'o-1', signature: 'secret' }), receivedAt: Date.now() })
    const trace = capture.getTrace()
    expect(trace).toHaveLength(3)
    expect(trace.map((entry) => entry.kind)).toEqual(['REQUEST', 'RESPONSE', 'WEBSOCKET'])
    expect(trace[0]).toMatchObject({ method: 'POST', operationName: 'placeOrder' })
    expect(trace[0]?.requestFields).toContain('variables.marketId')
    expect(trace[1]?.orderIds).toContain('o-1')
    expect(JSON.stringify(trace)).not.toContain('secret')
    expect(capture.getSummary().capturing).toBe(true)
    capture.stopCapture()
    expect(capture.getSummary().capturing).toBe(false)
  })
})
