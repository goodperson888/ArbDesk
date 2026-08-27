import { describe, expect, it, vi } from 'vitest'
import { PredictFunVenueAdapter } from './predict-fun-adapter'
import type { VenueExecutionRequest } from '../venue-adapter'

const request: VenueExecutionRequest = {
  marketId: '501', outcomeId: '123456', direction: 'UP', quantity: '2', limitPrice: '0.45',
  startTime: Date.now() - 60_000, endTime: Date.now() + 240_000, quoteReceivedAt: Date.now(),
  timeInForce: 'GTC', clientOrderId: 'predict-test-1', confirmed: true
}

function trading() {
  return {
    submit: vi.fn(async () => ({ orderId: 'order-1', orderHash: '0xhash', status: 'ACCEPTED' as const, filledQuantity: '0', averagePrice: '0.45' })),
    waitForFill: vi.fn(async () => ({ orderId: 'order-1', orderHash: '0xhash', status: 'FILLED' as const, filledQuantity: '2', averagePrice: '0.45' })),
    reconcile: vi.fn(async () => undefined)
  }
}

describe('PredictFunVenueAdapter', () => {
  it('blocks submission while the explicit live switch is off', async () => {
    const service = trading()
    const adapter = new PredictFunVenueAdapter(service as never, () => false)
    await expect(adapter.submitOrder(request)).rejects.toThrow('实盘下单开关尚未开启')
    expect(service.submit).not.toHaveBeenCalled()
  })

  it('submits once and uses GET readback result as the fill', async () => {
    const service = trading()
    const adapter = new PredictFunVenueAdapter(service as never, () => true)
    const receipt = await adapter.submitOrder(request)
    const fill = await adapter.waitForFill(receipt, request)
    expect(service.submit).toHaveBeenCalledTimes(1)
    expect(service.waitForFill).toHaveBeenCalledTimes(1)
    expect(fill).toMatchObject({ venueId: 'PREDICT_FUN', orderId: 'order-1', quantity: '2', verificationSource: 'PLATFORM_READBACK' })
  })
})
