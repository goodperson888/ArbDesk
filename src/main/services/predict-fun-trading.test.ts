import { describe, expect, it, vi } from 'vitest'
import { PredictFunTradingService } from './predict-fun-trading'
import type { VenueExecutionRequest } from '../platforms/venue-adapter'

const request: VenueExecutionRequest = {
  marketId: '1765334',
  outcomeId: '10198991570576564136864839809615440848156670589328863970171823680668680595774',
  direction: 'UP',
  quantity: '11.904',
  limitPrice: '0.84',
  startTime: Date.now() - 60_000,
  endTime: Date.now() + 4 * 60_000,
  quoteReceivedAt: Date.now(),
  timeInForce: 'FOK',
  clientOrderId: 'predict-page-create-order',
  confirmed: true
}

describe('PredictFunTradingService page CreateOrder', () => {
  it('accepts the captured GraphQL CreateOrder response through the logged-in page without API credentials', async () => {
    const getCredentials = vi.fn(async () => { throw new Error('Predict.fun 交易身份尚未完整配置') })
    const executePageOrder = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ data: { createOrder: { code: 'Ok', order: { id: '2799242769' } } } })
    }))
    const service = new PredictFunTradingService(
      { getCredentials } as never,
      {} as never,
      vi.fn() as never,
      'http://127.0.0.1:8545',
      { canExecutePageOrders: () => true, executePageOrder } as never
    )

    const result = await service.submit(request)

    expect(executePageOrder).toHaveBeenCalledWith(expect.objectContaining({
      marketId: '1765334', direction: 'UP', durationMinutes: 5, allowSubmit: true
    }))
    expect(result).toMatchObject({ orderId: '2799242769', transport: 'PAGE', status: 'ACCEPTED', filledQuantity: '0' })
    expect(await service.waitForFill(result, request)).toBeUndefined()
    expect(getCredentials).toHaveBeenCalledTimes(1)
  })

  it('uses the existing page wallet websocket for fill readback without an API poll', async () => {
    const getCredentials = vi.fn(async () => { throw new Error('Predict.fun 交易身份尚未完整配置') })
    const executePageOrder = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ data: { createOrder: { code: 'Ok', order: { id: '2892348198' } } } })
    }))
    const waitForPageOrderFill = vi.fn(async () => ({
      orderId: '2892348198', orderHash: '0xorder', status: 'FILLED' as const,
      filledQuantity: '11.904', averagePrice: '0.61',
      filledAt: Date.now(), source: 'WALLET_WEBSOCKET' as const
    }))
    const service = new PredictFunTradingService(
      { getCredentials } as never,
      {} as never,
      vi.fn() as never,
      'http://127.0.0.1:8545',
      { canExecutePageOrders: () => true, executePageOrder, waitForPageOrderFill } as never
    )

    const submitted = await service.submit(request)
    const filled = await service.waitForFill(submitted, request)

    expect(waitForPageOrderFill).toHaveBeenCalledWith('2892348198')
    expect(filled).toMatchObject({
      orderId: '2892348198', orderHash: '0xorder', transport: 'PAGE', status: 'FILLED',
      filledQuantity: '11.904', averagePrice: '0.61', message: 'WALLET_WEBSOCKET'
    })
    expect(getCredentials).toHaveBeenCalledTimes(1)
  })

  it('returns an explicit rejection when the wallet reports transaction failure', async () => {
    const getCredentials = vi.fn(async () => { throw new Error('Predict.fun 交易身份尚未完整配置') })
    const executePageOrder = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ data: { createOrder: { code: 'Ok', order: { id: 'failed-order' } } } })
    }))
    const waitForPageOrderFill = vi.fn(async () => ({
      orderId: 'failed-order', status: 'REJECTED' as const, filledQuantity: '0', filledAt: Date.now(),
      source: 'WALLET_WEBSOCKET' as const, message: 'minimum output not met'
    }))
    const service = new PredictFunTradingService(
      { getCredentials } as never,
      {} as never,
      vi.fn() as never,
      'http://127.0.0.1:8545',
      { canExecutePageOrders: () => true, executePageOrder, waitForPageOrderFill } as never
    )

    const submitted = await service.submit(request)
    await expect(service.waitForFill(submitted, request)).resolves.toMatchObject({
      orderId: 'failed-order', transport: 'PAGE', status: 'REJECTED', filledQuantity: '0',
      message: 'minimum output not met'
    })
  })
})
