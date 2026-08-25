import { describe, expect, it, vi } from 'vitest'
import type { GateOrderSchema } from '../../services/gate-order-capture'
import { GateVenueAdapter, type GateOrderTransport } from './gate-adapter'
import type { VenueExecutionRequest } from '../venue-adapter'

const baseRequest: VenueExecutionRequest = {
  marketId: 'event-1', outcomeId: 'token-up', direction: 'UP', quantity: '2', limitPrice: '0.51',
  startTime: Date.now() - 60_000, endTime: Date.now() + 300_000, quoteReceivedAt: Date.now(),
  timeInForce: 'FOK', clientOrderId: 'gate-test-1', confirmed: true
}

const schema: GateOrderSchema = {
  endpoint: 'https://www.gate.com/api/event-contract/orders', method: 'POST',
  requestFields: ['market_id', 'outcome_id', 'price', 'quantity'], capturedAt: Date.now()
}

function transport(overrides: Partial<GateOrderTransport> = {}): GateOrderTransport {
  return {
    getSchema: vi.fn(() => schema),
    submit: vi.fn(async () => ({ orderId: 'gate-order-1', status: 'ACCEPTED' as const, filledQuantity: '0' })),
    reconcile: vi.fn(async () => undefined),
    ...overrides
  }
}

describe('GateVenueAdapter', () => {
  it('allows page-click execution without a persisted request template', async () => {
    const submit = vi.fn(async () => ({ orderId: 'gate-page-order', status: 'ACCEPTED' as const, filledQuantity: '0' }))
    const adapter = new GateVenueAdapter(transport({ getSchema: () => undefined, canExecutePageOrders: () => true, submit }), { liveEnabled: true })
    await expect(adapter.preflightOrder(baseRequest)).resolves.toBeUndefined()
    expect(submit).not.toHaveBeenCalled()
  })

  it('blocks real submission until a verified captured schema exists', async () => {
    const submit = vi.fn()
    const adapter = new GateVenueAdapter(transport({ getSchema: () => undefined, submit }))
    await expect(adapter.preflightOrder(baseRequest)).rejects.toThrow('Gate 页面下单不可用')
    expect(submit).not.toHaveBeenCalled()
  })

  it('submits once and reconciles an ambiguous result without retrying POST', async () => {
    const submit = vi.fn(async () => ({ orderId: 'gate-order-2', status: 'UNKNOWN' as const, filledQuantity: '0' }))
    const reconcile = vi.fn(async () => ({ orderId: 'gate-order-2', status: 'FILLED' as const, filledQuantity: '2', averagePrice: '0.50' }))
    const adapter = new GateVenueAdapter(transport({ submit, reconcile }), { liveEnabled: true })
    const receipt = await adapter.submitOrder(baseRequest)
    expect(receipt.status).toBe('UNKNOWN')
    const fill = await adapter.waitForFill(receipt, baseRequest)
    expect(fill).toMatchObject({ orderId: 'gate-order-2', quantity: '2', averagePrice: '0.50', direction: 'UP' })
    expect(submit).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  it('reconciles a filled status when the submit response has no average price', async () => {
    const reconcile = vi.fn(async () => ({ orderId: 'gate-order-3', status: 'FILLED' as const, filledQuantity: '2', averagePrice: '0.52' }))
    const adapter = new GateVenueAdapter(transport({ submit: vi.fn(async () => ({ orderId: 'gate-order-3', status: 'FILLED' as const, filledQuantity: '2' })), reconcile }), { liveEnabled: true })
    const receipt = await adapter.submitOrder(baseRequest)
    const fill = await adapter.waitForFill(receipt, baseRequest)
    expect(fill).toMatchObject({ orderId: 'gate-order-3', quantity: '2', averagePrice: '0.52' })
    expect(reconcile).toHaveBeenCalledTimes(1)
  })
})
