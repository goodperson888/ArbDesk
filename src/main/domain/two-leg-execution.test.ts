import { describe, expect, it, vi } from 'vitest'
import type { MultiVenueExecutionRequest } from '../../shared/multi-venue'
import type { VenueAdapter, VenueFill, VenueOrderReceipt } from '../platforms/venue-adapter'
import { TwoLegExecutionMachine } from './two-leg-execution'

function request(): MultiVenueExecutionRequest {
  return {
    comparisonId: 'route-1', quantity: '2', startTime: Date.now() - 10_000, endTime: Date.now() + 60_000, confirmed: true,
    legs: [
      { venueId: 'A', marketId: 'a-market', outcomeId: 'a-outcome', direction: 'UP', price: '0.4', availableQuantity: '3', quoteAgeMs: 100 },
      { venueId: 'B', marketId: 'b-market', outcomeId: 'b-outcome', direction: 'DOWN', price: '0.5', availableQuantity: '3', quoteAgeMs: 100 }
    ]
  }
}

function adapter(venueId: string, quantity = '2'): VenueAdapter {
  const receipt: VenueOrderReceipt = { venueId, orderId: `${venueId}-order`, clientOrderId: '', status: 'ACCEPTED', filledQuantity: '0', receivedAt: Date.now() }
  const fill: VenueFill = { venueId, orderId: `${venueId}-fill`, direction: venueId === 'A' ? 'UP' : 'DOWN', quantity, averagePrice: venueId === 'A' ? '0.4' : '0.5', filledAt: Date.now(), verificationSource: 'DIRECT_RECEIPT' }
  return {
    venueId,
    capabilities: { marketDiscovery: true, realtimeBook: true, placeOrder: true, fillReadback: true, reconcileOrder: false, cancelOrder: false },
    preflightOrder: vi.fn(async () => undefined),
    submitOrder: vi.fn(async (request) => ({ ...receipt, clientOrderId: request.clientOrderId })),
    waitForFill: vi.fn(async () => fill),
    reconcileOrder: vi.fn(async () => undefined)
  }
}

describe('two-leg execution machine', () => {
  it('submits the second leg only after a full first-leg fill and preserves quantity', async () => {
    const first = adapter('A')
    const second = adapter('B')
    const receipt = await new TwoLegExecutionMachine().execute(request(), new Map([['A', first], ['B', second]]))
    expect(receipt.status).toBe('HEDGED')
    expect(first.submitOrder).toHaveBeenCalledTimes(1)
    expect(second.submitOrder).toHaveBeenCalledTimes(1)
    expect(vi.mocked(second.submitOrder).mock.calls[0][0].quantity).toBe('2.00')
  })

  it('aligns the second leg to the actual first-leg fill when the first leg is partial', async () => {
    const first = adapter('A', '1')
    const second = adapter('B', '1')
    const receipt = await new TwoLegExecutionMachine().execute(request(), new Map([['A', first], ['B', second]]))
    expect(receipt.status).toBe('HEDGED')
    expect(second.submitOrder).toHaveBeenCalledTimes(1)
    expect(vi.mocked(second.submitOrder).mock.calls[0][0].quantity).toBe('1.00')
    expect(receipt.firstLeg.status).toBe('PARTIAL')
    expect(receipt.secondLeg?.filledQuantity).toBe('1')
  })

  it('returns reconcile required for an unknown first-leg submit', async () => {
    const first = adapter('A')
    first.submitOrder = vi.fn(async () => { throw new Error('订单提交结果未知，禁止重试') })
    const second = adapter('B')
    const receipt = await new TwoLegExecutionMachine().execute(request(), new Map([['A', first], ['B', second]]))
    expect(receipt.status).toBe('RECONCILE_REQUIRED')
    expect(second.submitOrder).not.toHaveBeenCalled()
  })

  it('does not claim the first leg was submitted when the venue returns no order id', async () => {
    const first = adapter('A')
    first.submitOrder = vi.fn(async () => ({
      venueId: 'A', orderId: undefined, clientOrderId: 'client-a', status: 'UNKNOWN' as const,
      filledQuantity: '0', receivedAt: Date.now()
    }))
    const second = adapter('B')
    const receipt = await new TwoLegExecutionMachine().execute(request(), new Map([['A', first], ['B', second]]))
    expect(receipt.status).toBe('RECONCILE_REQUIRED')
    expect(receipt.firstLeg.status).toBe('UNKNOWN')
    expect(receipt.message).toContain('未返回订单号')
    expect(receipt.message).not.toContain('首腿已提交')
    expect(second.submitOrder).not.toHaveBeenCalled()
  })
})
