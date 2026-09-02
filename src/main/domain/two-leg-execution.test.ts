import { describe, expect, it, vi } from 'vitest'
import type { MultiVenueExecutionRequest } from '../../shared/multi-venue'
import type { VenueAdapter, VenueFill, VenueOrderReceipt } from '../platforms/venue-adapter'
import { TwoLegExecutionMachine } from './two-leg-execution'
import { PreSubmitBlockedError } from './execution-errors'

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

  it('hedges a rounding-only first-leg overfill after reducing to the second venue precision', async () => {
    const first = adapter('A', '2.005')
    const second = adapter('B', '2')
    const receipt = await new TwoLegExecutionMachine().execute(request(), new Map([['A', first], ['B', second]]))
    expect(receipt.status).toBe('HEDGED')
    expect(second.submitOrder).toHaveBeenCalledTimes(1)
    expect(vi.mocked(second.submitOrder).mock.calls[0][0].quantity).toBe('2.00')
    expect(receipt.message).toContain('按第二腿精度对齐')
  })

  it('hedges a material first-leg overfill when the second-leg quote has enough fresh depth', async () => {
    const first = adapter('A', '2.5')
    const second = adapter('B', '2.5')
    const receipt = await new TwoLegExecutionMachine().execute(request(), new Map([['A', first], ['B', second]]))
    expect(receipt.status).toBe('HEDGED')
    expect(second.submitOrder).toHaveBeenCalledTimes(1)
    expect(vi.mocked(second.submitOrder).mock.calls[0][0].quantity).toBe('2.50')
    expect(receipt.message).toContain('双腿已对齐')
  })

  it('stops a material overfill when the second-leg captured depth cannot cover it', async () => {
    const first = adapter('A', '2.5')
    const second = adapter('B', '2.5')
    const constrainedRequest = {
      ...request(),
      legs: request().legs.map((leg, index) => index === 1 ? { ...leg, availableQuantity: '2.2' } : leg) as MultiVenueExecutionRequest['legs']
    }
    const receipt = await new TwoLegExecutionMachine().execute(constrainedRequest, new Map([['A', first], ['B', second]]))
    expect(receipt.status).toBe('RECOVERY_REQUIRED')
    expect(second.submitOrder).not.toHaveBeenCalled()
    expect(receipt.message).toContain('可用深度仅2.2份')
  })

  it('stops a material overfill when the whole-trade capital cap would be exceeded', async () => {
    const first = adapter('A', '2.5')
    const second = adapter('B', '2.5')
    const cappedRequest = { ...request(), maxCapitalPerTrade: '2.00' }
    const receipt = await new TwoLegExecutionMachine().execute(cappedRequest, new Map([['A', first], ['B', second]]))
    expect(receipt.status).toBe('RECOVERY_REQUIRED')
    expect(second.submitOrder).not.toHaveBeenCalled()
    expect(receipt.message).toContain('超过单笔上限')
  })

  it('starts both unprotected submissions before either response resolves and keeps equal target quantities', async () => {
    const first = adapter('A')
    const second = adapter('B')
    let resolveFirst!: (receipt: VenueOrderReceipt) => void
    let resolveSecond!: (receipt: VenueOrderReceipt) => void
    first.submitOrder = vi.fn(() => new Promise<VenueOrderReceipt>((resolve) => { resolveFirst = resolve }))
    second.submitOrder = vi.fn(() => new Promise<VenueOrderReceipt>((resolve) => { resolveSecond = resolve }))
    first.waitForFill = vi.fn(async () => { throw new Error('unprotected mode must not wait for first fill') })
    second.waitForFill = vi.fn(async () => { throw new Error('unprotected mode must not wait for second fill') })

    const execution = new TwoLegExecutionMachine().execute({
      ...request(),
      executionPolicy: 'PARALLEL_UNPROTECTED' as never
    }, new Map([['A', first], ['B', second]]))

    await vi.waitFor(() => expect(first.submitOrder).toHaveBeenCalledTimes(1))
    const secondStartedBeforeFirstResolved = vi.mocked(second.submitOrder).mock.calls.length === 1
    resolveFirst({ venueId: 'A', orderId: 'A-parallel', clientOrderId: 'a-client', status: 'ACCEPTED', filledQuantity: '0', receivedAt: Date.now() })
    if (secondStartedBeforeFirstResolved) {
      resolveSecond({ venueId: 'B', orderId: 'B-parallel', clientOrderId: 'b-client', status: 'ACCEPTED', filledQuantity: '0', receivedAt: Date.now() })
    }
    const receipt = await execution

    expect(secondStartedBeforeFirstResolved).toBe(true)
    expect(receipt.status).toBe('UNPROTECTED_SUBMITTED')
    expect(vi.mocked(first.submitOrder).mock.calls[0][0].quantity).toBe('2.00')
    expect(vi.mocked(second.submitOrder).mock.calls[0][0].quantity).toBe('2.00')
    expect(first.waitForFill).not.toHaveBeenCalled()
    expect(second.waitForFill).not.toHaveBeenCalled()
  })

  it('records both unprotected legs without retry when one submission fails', async () => {
    const first = adapter('A')
    const second = adapter('B')
    first.submitOrder = vi.fn(async () => { throw new Error('Gate rejected') })

    const receipt = await new TwoLegExecutionMachine().execute({
      ...request(),
      executionPolicy: 'PARALLEL_UNPROTECTED' as never
    }, new Map([['A', first], ['B', second]]))

    expect(receipt.status).toBe('RECOVERY_REQUIRED')
    expect(first.submitOrder).toHaveBeenCalledTimes(1)
    expect(second.submitOrder).toHaveBeenCalledTimes(1)
    expect(receipt.firstLeg.status).toBe('NOT_SUBMITTED')
    expect(receipt.secondLeg?.orderId).toBe('B-order')
    expect(first.waitForFill).not.toHaveBeenCalled()
    expect(second.waitForFill).not.toHaveBeenCalled()
  })

  it('returns reconcile required for an unknown first-leg submit', async () => {
    const first = adapter('A')
    first.submitOrder = vi.fn(async () => { throw new Error('订单提交结果未知，禁止重试') })
    const second = adapter('B')
    const receipt = await new TwoLegExecutionMachine().execute(request(), new Map([['A', first], ['B', second]]))
    expect(receipt.status).toBe('RECONCILE_REQUIRED')
    expect(second.submitOrder).not.toHaveBeenCalled()
  })

  it('cancels a known pre-submit block without creating a recovery exposure', async () => {
    const first = adapter('A')
    first.submitOrder = vi.fn(async () => { throw new PreSubmitBlockedError('Gate 15m 正在切换当前轮次，未操作订单') })
    const second = adapter('B')

    const receipt = await new TwoLegExecutionMachine().execute(request(), new Map([['A', first], ['B', second]]))

    expect(receipt.status).toBe('CANCELED')
    expect(receipt.message).toContain('首腿未提交')
    expect(receipt.message).not.toContain('需要恢复')
    expect(receipt.secondLeg).toBeUndefined()
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

  it('使用调用方传入的行情时效和到期截止门槛', async () => {
    const first = adapter('A')
    const second = adapter('B')
    const executionRequest = {
      ...request(),
      endTime: Date.now() + 15_000,
      maxQuoteAgeMs: 10_000,
      stopBeforeExpirySeconds: 10,
      legs: request().legs.map((leg) => ({ ...leg, quoteAgeMs: 9_000 })) as MultiVenueExecutionRequest['legs']
    }

    const receipt = await new TwoLegExecutionMachine().execute(executionRequest, new Map([['A', first], ['B', second]]))
    expect(receipt.status).toBe('HEDGED')
  })
})
