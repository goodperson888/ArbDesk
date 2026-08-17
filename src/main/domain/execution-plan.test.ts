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
  minNetEdgePerShare: '0',
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
  })

  it('rejects deeper liquidity when slippage makes the configured return impossible', () => {
    const plan = calculateDepthExecutionPlan({
      ...base,
      minConditionalReturnPct: '7'
    })

    expect(Number(plan.maxExecutableQuantity)).toBeLessThan(Number(plan.marketDepthQuantity))
    expect(plan.limitingFactors).toContain('最低条件收益率')
  })
})
