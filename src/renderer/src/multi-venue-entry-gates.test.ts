import { describe, expect, it } from 'vitest'
import { defaultManualExecutionConditions } from '../../shared/defaults'
import type { MultiVenueComparison } from '../../shared/multi-venue'
import type { RiskSettings } from '../../shared/types'
import { buildMultiVenueEntryGateReport, gateDurationExecutionReady } from './multi-venue-entry-gates'

function comparison(overrides: Partial<MultiVenueComparison> = {}): MultiVenueComparison {
  return {
    id: 'gate-kalshi', asset: 'BTC/USD', durationMinutes: 15, startTime: 0, endTime: 120_000,
    strategy: 'COMPLEMENTARY_OUTCOMES', matchClass: 'EXACT', status: 'MANUAL_EXECUTABLE', executionProvider: 'MULTI_VENUE',
    edgeKind: 'GROSS_ONLY', allInCostPerShare: '0.90', netEdgePerShare: '0.10', conditionalReturnPct: '11.11',
    executableQuantity: '20', potentialProfit: '0', autoOrderPotentialProfit: '0', fixedSortKey: 'gate-kalshi', blockReasons: [],
    legs: [
      { venueId: 'GATE', venueLabel: 'Gate', marketId: 'gate-market', outcomeId: 'gate-up', direction: 'UP', price: '0.40', availableQuantity: '20', quoteAgeMs: 100 },
      { venueId: 'KALSHI', venueLabel: 'Kalshi', marketId: 'kalshi-market', outcomeId: 'kalshi-down', direction: 'DOWN', price: '0.50', availableQuantity: '20', quoteAgeMs: 100 }
    ],
    ...overrides
  }
}

function settings(overrides: Partial<RiskSettings> = {}): RiskSettings {
  return {
    mode: 'ASSISTED', gateLiveEnabled: true, kalshiLiveEnabled: true, mexcAutomationEnabled: true, polymarketLiveEnabled: true,
    maxCapitalPerTrade: '100', minConditionalReturnPct: '1', maxQuoteAgeMs: 8_000, stopBeforeExpirySeconds: 20,
    manualExecutionConditions: defaultManualExecutionConditions(), ...overrides
  } as RiskSettings
}

function report(overrides: Partial<Parameters<typeof buildMultiVenueEntryGateReport>[0]> = {}) {
  return buildMultiVenueEntryGateReport({
    comparison: comparison(), quantity: '13.00', settings: settings(), now: 10_000,
    executionIdle: true, kalshiReady: true, gateReady: true, ...overrides
  })
}

describe('multi venue entry gate adapter', () => {
  it('只把目标周期已接管的 Gate 页面视为可执行', () => {
    const summary = { captured: true, executionReady: true, executableDurations: [5] as Array<5 | 15>, message: 'ready' }

    expect(gateDurationExecutionReady(summary, 5)).toBe(true)
    expect(gateDurationExecutionReady(summary, 15)).toBe(false)
    expect(gateDurationExecutionReady({ ...summary, executableDurations: undefined }, 5)).toBe(false)
  })

  it('把全局设置和 Gate/Kalshi 路线转换成共用门禁报告', () => {
    const result = report()
    expect(result.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
      'minimum-order', 'depth-limit', 'capital-limit', 'conditional-return',
      'fee-verification', 'settlement-risk', 'quote-freshness', 'expiry-cutoff'
    ]))
    expect(result.firstBlockReason).toContain('手续费')
  })

  it('关闭手续费检查后允许毛边际手动路线，但 Gate 最低金额仍不可关闭', () => {
    const manualConditions = { ...defaultManualExecutionConditions(), feeVerification: false }
    const allowed = report({ settings: settings({ manualExecutionConditions: manualConditions }) })
    expect(allowed.allowed).toBe(true)

    const tooSmall = report({ quantity: '12.49', settings: settings({ manualExecutionConditions: manualConditions }) })
    expect(tooSmall.allowed).toBe(false)
    expect(tooSmall.firstBlockReason).toContain('Gate 最低金额')
    expect(tooSmall.checks.find((check) => check.id === 'minimum-order')?.locked).toBe(true)
  })

  it('全局无保护模式忽略深度和经济风控但保留最低金额', () => {
    const risky = comparison({
      matchClass: 'CONDITIONAL', conditionalReturnPct: '-20',
      legs: comparison().legs.map((leg) => ({ ...leg, availableQuantity: '0', quoteAgeMs: 30_000 }))
    })
    const unprotected = report({
      comparison: risky,
      settings: settings({ unprotectedExecutionEnabled: true, minConditionalReturnPct: '100' })
    })

    expect(unprotected.allowed).toBe(true)
    expect(unprotected.checks.find((check) => check.id === 'depth-limit')?.applicable).toBe(false)
    expect(unprotected.checks.find((check) => check.id === 'minimum-order')?.locked).toBe(true)
  })

  it('把 Kalshi 凭据、Gate 捕获结构和人工监督模式作为硬条件', () => {
    expect(report({ kalshiReady: false }).firstBlockReason).toContain('Kalshi')
    expect(report({ gateReady: false }).firstBlockReason).toContain('Gate')
    expect(report({ settings: settings({ mode: 'SIMULATION' }) }).firstBlockReason).toContain('人工监督')
  })

  it('允许 Polymarket↔Gate 复用同一套双腿门禁，且不要求 Kalshi 凭据', () => {
    const polyGate = comparison({
      id: 'poly-gate',
      legs: [
        { venueId: 'POLYMARKET', venueLabel: 'Polymarket', marketId: 'poly-market', outcomeId: 'poly-up', direction: 'UP', price: '0.40', availableQuantity: '20', quoteAgeMs: 100 },
        { venueId: 'GATE', venueLabel: 'Gate', marketId: 'gate-market', outcomeId: 'gate-down', direction: 'DOWN', price: '0.50', availableQuantity: '20', quoteAgeMs: 100 }
      ]
    })
    const result = report({ comparison: polyGate, kalshiReady: false, settings: settings({ manualExecutionConditions: { ...defaultManualExecutionConditions(), feeVerification: false } }) })
    expect(result.checks.find((check) => check.id === 'kalshi-credentials')).toBeUndefined()
    expect(result.allowed).toBe(true)
  })

  it('允许 Predict.fun 进入真实双腿门禁并受独立实盘开关控制', () => {
    const predict = comparison({
      legs: [
        { venueId: 'PREDICT_FUN', venueLabel: 'Predict.fun', marketId: 'predict-market', outcomeId: 'predict-up', direction: 'UP', price: '0.40', availableQuantity: '20', quoteAgeMs: 100 },
        { venueId: 'GATE', venueLabel: 'Gate', marketId: 'gate-market', outcomeId: 'gate-down', direction: 'DOWN', price: '0.50', availableQuantity: '20', quoteAgeMs: 100 }
      ]
    })
    const result = report({ comparison: predict, settings: settings({ predictFunLiveEnabled: true }) })
    expect(result.checks.find((check) => check.id === 'supported-route')?.passed).toBe(true)
    expect(result.firstBlockReason).not.toContain('Predict.fun 当前只读')
  })
})
