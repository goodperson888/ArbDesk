import { describe, expect, it } from 'vitest'
import type { MultiVenueComparison } from '../../shared/multi-venue'
import { routeDirectionLabel, stableRouteKey } from './route-display'

const comparison: MultiVenueComparison = {
  id: 'route:MEXC:m1:KALSHI:k1:A_TO_B', asset: 'BTC/USD', durationMinutes: 15, startTime: 1, endTime: 2,
  strategy: 'COMPLEMENTARY_OUTCOMES', matchClass: 'EXACT', status: 'MANUAL_EXECUTABLE', executionProvider: 'MULTI_VENUE', edgeKind: 'GROSS_ONLY',
  legs: [
    { venueId: 'MEXC', venueLabel: 'MEXC', marketId: 'm1', outcomeId: 'up', direction: 'UP', price: '0.4', availableQuantity: '2', quoteAgeMs: 100 },
    { venueId: 'KALSHI', venueLabel: 'Kalshi', marketId: 'k1', outcomeId: 'down', direction: 'DOWN', price: '0.5', availableQuantity: '2', quoteAgeMs: 100 }
  ],
  allInCostPerShare: '0.9', netEdgePerShare: '0.1', conditionalReturnPct: '11', executableQuantity: '2', potentialProfit: '0', autoOrderPotentialProfit: '0', fixedSortKey: '1', blockReasons: []
}

describe('route display helpers', () => {
  it('shows ordered venue and outcome direction', () => {
    expect(routeDirectionLabel(comparison)).toBe('MEXC UP → Kalshi DOWN')
    expect(stableRouteKey(comparison)).toBe(comparison.id)
  })
})
