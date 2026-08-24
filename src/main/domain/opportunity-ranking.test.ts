import { describe, expect, it } from 'vitest'
import { calculateExecutableOpportunityProfit } from './opportunity-ranking'

describe('executable opportunity profit ranking', () => {
  it('ranks by profit within the capital limit instead of raw book depth', () => {
    const deepButThinEdge = calculateExecutableOpportunityProfit({
      netEdgePerShare: '0.01', allInCostPerShare: '0.90', availableQuantity: '10000', maxCapital: '100',
      quantityMode: 'MAX_PERCENT', fixedQuantity: '5', maximumQuantityPct: 100
    })
    const smallerButBetterEdge = calculateExecutableOpportunityProfit({
      netEdgePerShare: '0.03', allInCostPerShare: '0.90', availableQuantity: '200', maxCapital: '100',
      quantityMode: 'MAX_PERCENT', fixedQuantity: '5', maximumQuantityPct: 100
    })

    expect(smallerButBetterEdge.gt(deepButThinEdge)).toBe(true)
  })

  it('uses the configured fixed quantity for fixed-size auto orders', () => {
    const profit = calculateExecutableOpportunityProfit({
      netEdgePerShare: '0.025', allInCostPerShare: '0.90', availableQuantity: '1000', maxCapital: '100',
      quantityMode: 'FIXED', fixedQuantity: '5', maximumQuantityPct: 80
    })

    expect(profit.toFixed(3)).toBe('0.125')
  })
})
