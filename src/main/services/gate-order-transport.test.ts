import { describe, expect, it, vi } from 'vitest'
import { GateOrderCapture, type GatePreparedRequest } from './gate-order-capture'
import type { GateCapturedHttpResponse } from './gate-order-transport'
import { GateBrowserOrderTransport } from './gate-order-transport'
import type { GateCapturedRequest } from './gate-page-capture'

describe('GateBrowserOrderTransport', () => {
  it('submits the captured template through the bound page and returns the verified order result', async () => {
    const capture = new GateOrderCapture()
    capture.startCapture()
    const request: GateCapturedRequest = {
      url: 'https://www.gate.com/api/event-contract/orders', method: 'POST',
      body: JSON.stringify({ market_id: 'old', outcome_id: 'old-token', quantity: '1', price: '0.4' }), receivedAt: Date.now()
    }
    capture.observe(request)
    const execute = vi.fn<(request: GatePreparedRequest) => Promise<GateCapturedHttpResponse>>(async () => ({ status: 200, body: JSON.stringify({ order_id: 'gate-1', status: 'accepted', filled_quantity: '0' }) }))
    const transport = new GateBrowserOrderTransport(capture, { executeCapturedOrder: execute })
    const result = await transport.submit({ marketId: 'new', outcomeId: 'new-token', direction: 'UP', quantity: '2', limitPrice: '0.5', startTime: Date.now(), endTime: Date.now() + 300_000, quoteReceivedAt: Date.now(), timeInForce: 'FOK', clientOrderId: 'client-1' })
    expect(result).toMatchObject({ orderId: 'gate-1', status: 'ACCEPTED', filledQuantity: '0' })
    expect(execute).toHaveBeenCalledTimes(1)
    const sent = execute.mock.calls[0]![0]
    expect(JSON.parse(sent.body)).toMatchObject({ market_id: 'new', quantity: '2', price: '0.5' })
  })
})
