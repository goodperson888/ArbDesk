import { describe, expect, it } from 'vitest'
import { calculateDepthExecutionPlan } from './execution-plan'

const base = {
  opportunityId: 'test',
  mexcLevels: [{ price: '0.40', size: '5' }, { price: '0.42', size: '10' }],
  polymarketLevels: [{ price: '0.50', size: '4' }, { price: '0.52', size: '10' }],
  mexcFeeRate: '0.015',
  polymarketFeeRate: '0.07',
  polymarketFeeExponent: '1',
  polymarketMinOrderSize: '1',
  riskBufferPerShare: '0.008',
  minConditionalReturnPct: '0',
  maxCapital: '100',
  maxHedgeSlippage: '0.03'
}

describe('depth execution plan', () => {
  it('uses multiple levels while the aggregate return remains above the threshold', () => {
    const plan = calculateDepthExecutionPlan({ ...base, quantity: '10' })

    expect(plan.executable).toBe(true)
    expect(plan.mexcLevelsUsed).toBe(2)
    expect(plan.polymarketLevelsUsed).toBe(2)
    expect(Number(plan.mexcAveragePrice)).toBeCloseTo(0.41, 6)
    expect(Number(plan.polymarketAveragePrice)).toBeCloseTo(0.512, 6)
  })

  it('caps maximum quantity using balances and reports the limiting factor', () => {
    const plan = calculateDepthExecutionPlan({
      ...base,
      mexcBalance: '2.05',
      polymarketBalance: '100',
      requireBalances: true
    })

    expect(Number(plan.maxExecutableQuantity)).toBeLessThan(6)
    expect(plan.limitingFactors).toContain('MEXC可用余额')
    expect(plan.affordableLimitingFactors).toContain('MEXC可用余额')
  })

  it('rejects deeper liquidity when slippage makes the configured return impossible', () => {
    const plan = calculateDepthExecutionPlan({
      ...base,
      minConditionalReturnPct: '7'
    })

    expect(Number(plan.maxExecutableQuantity)).toBeLessThan(Number(plan.marketDepthQuantity))
    expect(plan.limitingFactors).toContain('最低条件收益率')
  })

  it('separates what the accounts can afford from what the profit rules allow', () => {
    const plan = calculateDepthExecutionPlan({
      ...base,
      mexcLevels: [{ price: '0.99', size: '100' }],
      polymarketLevels: [{ price: '0.01', size: '100' }],
      mexcBalance: '48',
      polymarketBalance: '126',
      requireBalances: true,
      maxHedgeSlippage: '0.06',
      balanceUsageRatio: '0.99'
    })

    expect(plan.minimumQuantity).toBe('14.29')
    expect(plan.maxAffordableQuantity).toBe('47.29')
    expect(plan.maxExecutableQuantity).toBe('0.00')
    expect(plan.accountBalanceReservePct).toBe('1.00')
    expect(plan.affordableLimitingFactors).toEqual(['MEXC可用余额'])
    expect(plan.limitingFactors).toEqual(['最低条件收益率'])
  })
})
