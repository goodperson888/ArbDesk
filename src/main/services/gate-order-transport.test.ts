import { describe, expect, it, vi } from 'vitest'
import { GateOrderCapture, type GatePreparedRequest } from './gate-order-capture'
import type { GateCapturedHttpResponse } from './gate-order-transport'
import { GateBrowserOrderTransport } from './gate-order-transport'
import type { GateCapturedRequest } from './gate-page-capture'

describe('GateBrowserOrderTransport', () => {
  it('prefers one background page click over replaying a captured POST', async () => {
    const capture = new GateOrderCapture()
    const executeCapturedOrder = vi.fn()
    const executePageOrder = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ order_id: 'gate-page-1', status: 'accepted', filled_quantity: '0' })
    }))
    const transport = new GateBrowserOrderTransport(capture, { executeCapturedOrder, executePageOrder, canExecutePageOrders: () => true })
    const result = await transport.submit({ marketId: 'event-1', outcomeId: 'token-up', direction: 'UP', quantity: '2', limitPrice: '0.5', startTime: Date.now(), endTime: Date.now() + 300_000, quoteReceivedAt: Date.now(), timeInForce: 'FOK', clientOrderId: 'client-page-1' })
    expect(result).toMatchObject({ orderId: 'gate-page-1', status: 'ACCEPTED', filledQuantity: '0' })
    expect(executePageOrder).toHaveBeenCalledTimes(1)
    expect(executeCapturedOrder).not.toHaveBeenCalled()
  })

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

  it('accepts a nested Gate submit response whose order id is data.id', async () => {
    const capture = new GateOrderCapture()
    const executePageOrder = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ data: { id: 'gate-submit-1', status: 'accepted', filled_size: '0' } })
    }))
    const transport = new GateBrowserOrderTransport(capture, { executeCapturedOrder: vi.fn(), executePageOrder, canExecutePageOrders: () => true })
    const result = await transport.submit({ marketId: 'event-1', outcomeId: 'token-up', direction: 'UP', quantity: '2', limitPrice: '0.5', startTime: Date.now(), endTime: Date.now() + 300_000, quoteReceivedAt: Date.now(), timeInForce: 'FOK', clientOrderId: 'client-submit-1' })
    expect(result).toMatchObject({ orderId: 'gate-submit-1', status: 'ACCEPTED', filledQuantity: '0' })
  })

  it('marks a successful HTTP response without an order id as unknown', async () => {
    const capture = new GateOrderCapture()
    const executePageOrder = vi.fn(async () => ({ status: 200, body: '' }))
    const transport = new GateBrowserOrderTransport(capture, { executeCapturedOrder: vi.fn(), executePageOrder, canExecutePageOrders: () => true })
    await expect(transport.submit({ marketId: 'event-1', outcomeId: 'token-up', direction: 'UP', quantity: '2', limitPrice: '0.5', startTime: Date.now(), endTime: Date.now() + 300_000, quoteReceivedAt: Date.now(), timeInForce: 'FOK', clientOrderId: 'client-empty-response' }))
      .resolves.toMatchObject({ orderId: '', status: 'UNKNOWN', message: expect.stringContaining('biz_order_id') })
  })

  it('waits briefly for a passive fill response without sending another request', async () => {
    const capture = new GateOrderCapture()
    const transport = new GateBrowserOrderTransport(capture, { executeCapturedOrder: vi.fn() })
    const pending = transport.reconcile('gate-delayed-1')
    setTimeout(() => capture.observeResponse({
      url: 'https://www.gate.com/apiw/v2/event-contract/orders/history', status: 200,
      body: JSON.stringify({ data: { items: [{ id: 'gate-delayed-1', status: 'FILLED', filled_size: '1', avg_price: '0.51' }] } }), receivedAt: Date.now()
    }), 25)
    await expect(pending).resolves.toMatchObject({ orderId: 'gate-delayed-1', status: 'FILLED', filledQuantity: '1', averagePrice: '0.51' })
  })
})
