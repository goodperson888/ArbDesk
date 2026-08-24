import { describe, expect, it, vi } from 'vitest'
import type { RiskSettings } from '../../shared/types'
import type { MultiVenueExecutionRequest } from '../../shared/multi-venue'
import { MultiVenueExecutionService } from './multi-venue-execution'

function settings(overrides: Partial<RiskSettings> = {}): RiskSettings {
  return {
    mode: 'ASSISTED', kalshiLiveEnabled: true, mexcAutomationEnabled: true, polymarketLiveEnabled: true,
    maxCapitalPerTrade: '100', maxHedgeSlippage: '0.03', polymarketHedgeMode: 'PROTECTED_MARKET', ...overrides
  } as RiskSettings
}

function request(pair: ['MEXC' | 'POLYMARKET', 'KALSHI'] = ['MEXC', 'KALSHI']): MultiVenueExecutionRequest {
  return {
    comparisonId: 'cmp-1', quantity: '2.00', startTime: Date.now() - 10_000, endTime: Date.now() + 60_000, confirmed: true,
    legs: [
      { venueId: pair[0], marketId: pair[0] === 'MEXC' ? 'mexc-event' : 'condition', outcomeId: pair[0] === 'MEXC' ? 'mexc-symbol' : 'poly-token', direction: 'UP', price: '0.40', availableQuantity: '3', quoteAgeMs: 100 },
      { venueId: 'KALSHI', marketId: 'KXBTC15M-TEST', outcomeId: 'KXBTC15M-TEST:YES', direction: 'DOWN', price: '0.50', availableQuantity: '3', quoteAgeMs: 100 }
    ]
  }
}

function deps() {
  const mexc = {
    prepareOrder: vi.fn(async () => ({ ok: true, orderAccepted: true, submittedAt: Date.now(), message: 'mexc accepted', orderId: 'mexc-order' })),
    waitForFill: vi.fn(async () => ({ venue: 'MEXC' as const, direction: 'UP' as const, quantity: '2.00', averagePrice: '0.40', orderId: 'mexc-fill', filledAt: Date.now() }))
  }
  const polymarket = {
    hedge: vi.fn(async () => ({ venue: 'POLYMARKET' as const, direction: 'UP' as const, quantity: '2.00', averagePrice: '0.40', orderId: 'poly-fill', filledAt: Date.now() }))
  }
  const kalshi = {
    placeOrder: vi.fn(async () => ({ orderId: 'kalshi-order', clientOrderId: 'client', ticker: 'KXBTC15M-TEST', direction: 'DOWN' as const, side: 'ask' as const, quantity: '2.00', outcomePrice: '0.50', fillCount: '2.00', remainingCount: '0.00', status: 'EXECUTED' as const, submittedAt: Date.now(), message: 'filled' }))
  }
  return { mexc, polymarket, kalshi }
}

describe('multi-venue Kalshi execution', () => {
  it('executes MEXC first and only then sends the exact fill to Kalshi', async () => {
    const mocked = deps()
    const service = new MultiVenueExecutionService({ ...mocked, settings: () => settings(), liveExecutionEnabled: true } as never)
    const receipt = await service.execute(request())
    expect(receipt.status).toBe('HEDGED')
    expect(mocked.mexc.prepareOrder.mock.invocationCallOrder[0]).toBeLessThan(mocked.mexc.waitForFill.mock.invocationCallOrder[0])
    expect(mocked.kalshi.placeOrder).toHaveBeenCalledTimes(1)
    expect((mocked.kalshi.placeOrder.mock.calls[0] as unknown as [Record<string, string>])[0]).toMatchObject({ quantity: '2.00', direction: 'DOWN' })
  })

  it('supports Polymarket first and does not send Kalshi after a partial first fill', async () => {
    const mocked = deps()
    mocked.polymarket.hedge.mockResolvedValueOnce({ venue: 'POLYMARKET', direction: 'UP', quantity: '1.00', averagePrice: '0.40', orderId: 'poly-partial', filledAt: Date.now() })
    const service = new MultiVenueExecutionService({ ...mocked, settings: () => settings(), liveExecutionEnabled: true } as never)
    const receipt = await service.execute(request(['POLYMARKET', 'KALSHI']))
    expect(receipt.status).toBe('RECOVERY_REQUIRED')
    expect(mocked.kalshi.placeOrder).not.toHaveBeenCalled()
    expect(receipt.message).toContain('未发送 Kalshi')
  })
})
