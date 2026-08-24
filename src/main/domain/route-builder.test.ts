import { describe, expect, it } from 'vitest'
import { defaultManualExecutionConditions, defaultSettlementDistanceRules } from '../../shared/defaults'
import type { RiskSettings } from '../../shared/types'
import type { ReadOnlyWindowQuote } from '../platforms/read-only-types'
import { buildBidirectionalRoutes, routeToComparison } from './route-builder'

const settings: RiskSettings = {
  mode: 'SIMULATION', maxCapitalPerTrade: '100', minConditionalReturnPct: '0', maxQuoteAgeMs: 8_000,
  maxHedgeSlippage: '0.03', stopBeforeExpirySeconds: 20, settlementDistanceRules: defaultSettlementDistanceRules(),
  opportunitySoundEnabled: false, opportunitySoundVolume: 0.5, opportunitySoundCooldownSeconds: 30,
  mexcBrowserMode: 'HUBSTUDIO', mexcElementMode: 'AUTO', hubstudioContainerCode: 'x', polymarketProxyUrl: '',
  mexcAutomationEnabled: false, polymarketLiveEnabled: false, allowUnprofitableTestTrade: false,
  autoOpenEnabled: false, autoOpenQuantityMode: 'FIXED', autoOpenFixedQuantity: '5', autoOpenMaxQuantityPct: 80,
  maxRecoveryLossUsdt: '2', polymarketHedgeRetryCount: 8, polymarketHedgeMode: 'PROTECTED_MARKET',
  preHedgeRatioPct: 50, unprotectedExecutionEnabled: false, manualExecutionConditions: defaultManualExecutionConditions(), autoOpenStabilityMs: 100
}

function market(venueId: string): ReadOnlyWindowQuote {
  return {
    venueId, marketId: `${venueId}-market`, asset: 'BTC/USD', durationMinutes: 5, startTime: 1_000, endTime: 301_000,
    feeVerified: true,
    resolution: {
      asset: 'BTC/USD', startTime: 1_000, endTime: 301_000, baselineSource: 'CHAINLINK', settlementSource: 'CHAINLINK',
      observationMethod: 'TWAP', comparisonOperator: 'GTE', tieOutcome: 'UP', voidRule: 'NONE', staleDataRule: 'NONE', timezone: 'UTC', ruleVersion: 'same'
    },
    outcomes: {
      UP: { direction: 'UP', outcomeId: `${venueId}-up`, bestAsk: '0.40', askSize: '20', levels: [], receivedAt: 10_000 },
      DOWN: { direction: 'DOWN', outcomeId: `${venueId}-down`, bestAsk: '0.40', askSize: '20', levels: [], receivedAt: 10_000 }
    }
  }
}

describe('bidirectional route builder', () => {
  it('builds both directions for every compatible venue pair', () => {
    const routes = buildBidirectionalRoutes([market('MEXC'), market('POLYMARKET'), market('KALSHI')], settings, 10_100)
    expect(routes).toHaveLength(6)
    expect(new Set(routes.map((route) => route.direction))).toEqual(new Set(['A_TO_B', 'B_TO_A']))
    expect(new Set(routes.map((route) => route.routeId)).size).toBe(6)
  })

  it('does not build routes for different event windows', () => {
    const different = { ...market('POLYMARKET'), startTime: 301_000, endTime: 601_000 }
    expect(buildBidirectionalRoutes([market('MEXC'), different], settings, 10_100)).toEqual([])
  })

  it('keeps route IDs stable when market data arrives in a different order', () => {
    const ordered = buildBidirectionalRoutes([market('MEXC'), market('POLYMARKET')], settings, 10_100).map((route) => route.routeId)
    const reversed = buildBidirectionalRoutes([market('POLYMARKET'), market('MEXC')], settings, 10_100).map((route) => route.routeId)
    expect(reversed).toEqual(ordered)
  })

  it('marks Gate↔Kalshi routes as manually executable once both legs have compatible windows', () => {
    const route = buildBidirectionalRoutes([market('GATE'), market('KALSHI')], settings, 10_100)[0]
    expect(routeToComparison(route, settings, 10_100).status).toBe('MANUAL_EXECUTABLE')
  })
})
