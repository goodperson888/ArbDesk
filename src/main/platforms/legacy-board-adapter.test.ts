import { describe, expect, it } from 'vitest'
import { defaultManualExecutionConditions, defaultSettlementDistanceRules } from '../../shared/defaults'
import type { Opportunity, RiskSettings } from '../../shared/types'
import { buildLegacyMultiVenueBoard } from './legacy-board-adapter'
import type { ReadOnlyWindowQuote } from './read-only-types'

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'btc-5m-1-mexc-up', mexcEventId: 'mexc-event', mexcSymbolId: 'mexc-up', symbol: 'BTC/USD',
    durationMinutes: 5, startTime: 1, endTime: 300_001, mexcDirection: 'UP', polymarketDirection: 'DOWN',
    polymarketTokenId: 'poly-down', polymarketMinOrderSize: '1', mexcPrice: '0.40', polymarketPrice: '0.50',
    mexcFeeRate: '0.01', mexcFeeRateSource: 'HISTORY', polymarketFeeRate: '0.01', polymarketFeeExponent: '1',
    polymarketEffectiveFeeRate: '0.01', mexcFeePerShare: '0.004', polymarketFeePerShare: '0.005',
    riskBufferPerShare: '0.005', allInCostPerShare: '0.914', grossEdgePerShare: '0.10', netEdgePerShare: '0.086',
    mexcAvailableQuantity: '30', polymarketAvailableQuantity: '20', maxQuantity: '20', mexcQuoteAgeMs: 50,
    polymarketQuoteAgeMs: 60, capitalRequired: '18.28', expectedProfit: '1.72', conditionalReturnPct: '9.41',
    worstCaseReturnPct: '9.41', bothLosePnlPerShare: '-0.914', bothWinPnlPerShare: '1.086',
    feeVerificationBlocked: false, settlementRiskBlocked: false, settlementDistanceBps: '10',
    requiredSettlementDistanceBps: '5', matchClass: 'CONDITIONAL', stale: false, riskFlags: [],
    ...overrides
  }
}

function settings(overrides: Partial<RiskSettings> = {}): RiskSettings {
  return {
    mode: 'SIMULATION', maxCapitalPerTrade: '100', minConditionalReturnPct: '0', maxQuoteAgeMs: 8_000,
    maxHedgeSlippage: '0.0300', stopBeforeExpirySeconds: 20,
    settlementDistanceRules: defaultSettlementDistanceRules(), opportunitySoundEnabled: true,
    opportunitySoundVolume: 0.65, opportunitySoundCooldownSeconds: 30, mexcBrowserMode: 'HUBSTUDIO',
    mexcElementMode: 'AUTO', hubstudioContainerCode: 'test', polymarketProxyUrl: '', mexcAutomationEnabled: false,
    polymarketLiveEnabled: false, allowUnprofitableTestTrade: false, autoOpenEnabled: false,
    autoOpenQuantityMode: 'FIXED', autoOpenFixedQuantity: '5', autoOpenMaxQuantityPct: 80,
    maxRecoveryLossUsdt: '2', polymarketHedgeRetryCount: 8, polymarketHedgeMode: 'PROTECTED_MARKET',
    preHedgeRatioPct: 50, unprotectedExecutionEnabled: false,
    manualExecutionConditions: defaultManualExecutionConditions(), autoOpenStabilityMs: 100,
    ...overrides
  }
}

function windowQuote(overrides: Partial<ReadOnlyWindowQuote> = {}): ReadOnlyWindowQuote {
  return {
    venueId: 'GATE', marketId: 'gate-btc-5m', asset: 'BTC/USD', durationMinutes: 5,
    startTime: 0, endTime: 300_000, feeVerified: false,
    resolution: {
      asset: 'BTC/USD', startTime: 0, endTime: 300_000, baselineSource: 'GATE', settlementSource: 'GATE',
      observationMethod: 'platform', comparisonOperator: 'GT', tieOutcome: 'DOWN', voidRule: 'platform',
      staleDataRule: 'platform', timezone: 'UTC', ruleVersion: 'test'
    },
    outcomes: {
      UP: { direction: 'UP', outcomeId: 'up', bestAsk: '0.45', askSize: '0', levels: [], receivedAt: 9_500 },
      DOWN: { direction: 'DOWN', outcomeId: 'down', bestAsk: '0.55', askSize: '0', levels: [], receivedAt: 9_500 }
    },
    ...overrides
  }
}

describe('legacy multi-venue board adapter', () => {
  it('maps legacy execution opportunities into generic legs without changing the execution id', () => {
    const board = buildLegacyMultiVenueBoard({
      generatedAt: 100,
      opportunities: [opportunity()],
      settings: settings({ maxCapitalPerTrade: '10' }),
      connections: { MEXC: 'CONNECTED', POLYMARKET: 'CONNECTED' }
    })

    expect(board.comparisons[0]).toMatchObject({
      legacyOpportunityId: 'btc-5m-1-mexc-up',
      executionProvider: 'LEGACY_MEXC_POLY',
      status: 'EXECUTABLE',
      executableQuantity: '10.94',
      potentialProfit: '0.940840',
      autoOrderPotentialProfit: '0.430000',
      legs: [
        { venueId: 'MEXC', direction: 'UP', price: '0.40' },
        { venueId: 'POLYMARKET', direction: 'DOWN', price: '0.50' }
      ]
    })
  })

  it('uses a stable route key instead of profit for ordering', () => {
    const board = buildLegacyMultiVenueBoard({
      generatedAt: 100,
      opportunities: [
        opportunity({ id: 'down', mexcDirection: 'DOWN', polymarketDirection: 'UP', netEdgePerShare: '0.50' }),
        opportunity({ id: 'up', mexcDirection: 'UP', polymarketDirection: 'DOWN', netEdgePerShare: '0.01' })
      ],
      settings: settings(),
      connections: { MEXC: 'CONNECTED', POLYMARKET: 'CONNECTED' }
    })

    expect(board.comparisons.map((comparison) => comparison.legacyOpportunityId)).toEqual(['down', 'up'])
  })

  it('keeps blocked comparisons visible for a stable board', () => {
    const board = buildLegacyMultiVenueBoard({
      generatedAt: 100,
      opportunities: [opportunity({ settlementRiskBlocked: true, settlementRiskReason: '结算源不兼容' })],
      settings: settings(),
      connections: { MEXC: 'CONNECTED', POLYMARKET: 'CONNECTED' }
    })

    expect(board.comparisons[0].status).toBe('BLOCKED')
    expect(board.comparisons[0].blockReasons).toContain('结算源不兼容')
  })

  it('reports price-only and missing cycles without issuing any extra market request', () => {
    const board = buildLegacyMultiVenueBoard({
      generatedAt: 10_000,
      opportunities: [],
      settings: settings(),
      connections: { MEXC: 'CONNECTED', POLYMARKET: 'CONNECTED' },
      additionalConnections: { GATE: 'CONNECTED' },
      statusMessages: { GATE: '页面捕获已收到5分钟价格' },
      windows: [windowQuote()]
    })

    expect(board.platforms.find((platform) => platform.id === 'GATE')).toMatchObject({
      statusMessage: '页面捕获已收到5分钟价格',
      cycles: [
        { durationMinutes: 5, state: 'PRICE_ONLY', marketCount: 1, latestQuoteAt: 9_500 },
        { durationMinutes: 15, state: 'NO_MARKET', marketCount: 0 }
      ]
    })
  })
})
