import { describe, expect, it } from 'vitest'
import { defaultManualExecutionConditions, defaultSettlementDistanceRules } from '../../shared/defaults'
import type { RiskSettings } from '../../shared/types'
import type { ReadOnlyWindowQuote } from './read-only-types'
import { buildReadOnlyComparisons } from './read-only-board-adapter'

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

function window(venueId: string, up: string, down: string): ReadOnlyWindowQuote {
  const startTime = 1_000
  const endTime = 301_000
  return {
    venueId, marketId: `${venueId}-market`, asset: 'BTC/USD', durationMinutes: 5, startTime, endTime,
    feeVerified: false,
    resolution: {
      asset: 'BTC/USD', startTime, endTime, baselineSource: venueId, settlementSource: venueId,
      observationMethod: venueId, comparisonOperator: 'GT', tieOutcome: 'DOWN', voidRule: venueId,
      staleDataRule: venueId, timezone: 'UTC', ruleVersion: '1'
    },
    outcomes: {
      UP: { direction: 'UP', outcomeId: 'up', bestAsk: up, askSize: '20', levels: [], receivedAt: 10_000 },
      DOWN: { direction: 'DOWN', outcomeId: 'down', bestAsk: down, askSize: '10', levels: [], receivedAt: 10_000 }
    }
  }
}

describe('read-only multi-venue board adapter', () => {
  it('shows new-platform routes as gross-only and never executable', () => {
    const rows = buildReadOnlyComparisons([
      window('POLYMARKET', '0.40', '0.60'),
      window('LIMITLESS', '0.55', '0.35')
    ], settings, 10_100)

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ edgeKind: 'GROSS_ONLY', status: 'BLOCKED', executionProvider: 'MULTI_VENUE', potentialProfit: '0.000000' })
    expect(rows[0].blockReasons).toContain('新平台当前只读，尚未开放该路线下单')
  })

  it('does not duplicate the legacy MEXC plus Polymarket route', () => {
    expect(buildReadOnlyComparisons([
      window('MEXC', '0.40', '0.60'),
      window('POLYMARKET', '0.55', '0.35')
    ], settings, 10_100)).toEqual([])
  })

  it('collapses duplicate venue windows into one comparison per duration and time range', () => {
    const gate = window('GATE', '0.40', '0.40')
    const duplicateGate = { ...window('GATE', '0.45', '0.35'), marketId: 'GATE-market-duplicate' }
    const kalshi = window('KALSHI', '0.45', '0.45')
    const rows = buildReadOnlyComparisons([gate, duplicateGate, kalshi], settings, 10_100)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.id)).size).toBe(2)
  })
})
