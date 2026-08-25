import { describe, expect, it } from 'vitest'
import { defaultManualExecutionConditions } from './defaults'
import type { EntryGateInput, EntryGateLeg } from './entry-gates'
import { entryGateMinimumQuantity, evaluateEntryGates } from './entry-gates'

function gate(price = '1.00', availableQuantity = '20'): EntryGateLeg {
  return {
    venueId: 'GATE', venueLabel: 'Gate', marketId: 'gate-market', outcomeId: 'gate-up',
    price, availableQuantity, quoteAgeMs: 100, minimumNotionalUsd: '5'
  }
}

function kalshi(price = '0.01', availableQuantity = '20'): EntryGateLeg {
  return {
    venueId: 'KALSHI', venueLabel: 'Kalshi', marketId: 'kalshi-market', outcomeId: 'kalshi-down',
    price, availableQuantity, quoteAgeMs: 100, minimumQuantity: '1'
  }
}

function input(overrides: Partial<EntryGateInput> = {}): EntryGateInput {
  return {
    mode: 'MANUAL', quantity: '5.00', allInCostPerShare: '1.01', conditionalReturnPct: '1.00',
    edgeKind: 'NET_VERIFIED', matchClass: 'EXACT', endTime: 100_000, now: 10_000,
    maxCapitalPerTrade: '100', minConditionalReturnPct: '0.50', maxQuoteAgeMs: 8_000,
    stopBeforeExpirySeconds: 20, manualConditions: defaultManualExecutionConditions(),
    executionIdle: true, readiness: [], legs: [gate(), kalshi()], ...overrides
  }
}

describe('shared entry gates', () => {
  it('把 Gate 5 USD、深度和本金作为不可关闭的硬条件', () => {
    const minimum = evaluateEntryGates(input({ quantity: '4.99' }))
    expect(minimum.allowed).toBe(false)
    expect(minimum.checks.find((check) => check.id === 'minimum-order')).toMatchObject({ passed: false, locked: true })
    expect(minimum.firstBlockReason).toContain('Gate 最低金额')

    const depth = evaluateEntryGates(input({ quantity: '21' }))
    expect(depth.firstBlockReason).toContain('盘口深度')

    const capital = evaluateEntryGates(input({ quantity: '10', maxCapitalPerTrade: '10' }))
    expect(capital.firstBlockReason).toContain('单笔上限')
  })

  it('按两位小数向上计算每条腿共同满足的最低份额', () => {
    expect(entryGateMinimumQuantity([gate('0.74'), kalshi('0.26')]).toFixed(2)).toBe('6.76')
  })

  it('手动模式允许明确忽略毛边际手续费检查，自动模式不允许', () => {
    const manualConditions = { ...defaultManualExecutionConditions(), feeVerification: false }
    const manual = evaluateEntryGates(input({ edgeKind: 'GROSS_ONLY', manualConditions, mode: 'MANUAL' }))
    const automatic = evaluateEntryGates(input({ edgeKind: 'GROSS_ONLY', manualConditions, mode: 'AUTO' }))

    expect(manual.checks.find((check) => check.id === 'fee-verification')).toMatchObject({ enabled: false, passed: false })
    expect(manual.allowed).toBe(true)
    expect(automatic.allowed).toBe(false)
    expect(automatic.firstBlockReason).toContain('手续费')
  })

  it('统一应用收益、结算规则、行情时效和到期截止条件', () => {
    expect(evaluateEntryGates(input({ conditionalReturnPct: '0.49' })).firstBlockReason).toContain('收益率')
    expect(evaluateEntryGates(input({ matchClass: 'CONDITIONAL' })).firstBlockReason).toContain('结算规则')
    expect(evaluateEntryGates(input({ legs: [{ ...gate(), quoteAgeMs: 8_001 }, kalshi()] })).firstBlockReason).toContain('行情')
    expect(evaluateEntryGates(input({ endTime: 29_999 })).firstBlockReason).toContain('到期')
  })

  it('不适用的路线专属条件不会阻塞', () => {
    const report = evaluateEntryGates(input({
      edgeKind: 'GROSS_ONLY', matchClass: 'CONDITIONAL', feeVerificationApplicable: false,
      settlementRiskApplicable: false
    }))

    expect(report.allowed).toBe(true)
    expect(report.checks.find((check) => check.id === 'fee-verification')?.applicable).toBe(false)
    expect(report.checks.find((check) => check.id === 'settlement-risk')?.applicable).toBe(false)
  })

  it('缺少市场身份、实盘就绪或存在执行冲突时按硬条件阻塞', () => {
    const identity = evaluateEntryGates(input({ legs: [{ ...gate(), outcomeId: undefined }, kalshi()] }))
    expect(identity.firstBlockReason).toContain('市场身份')

    const readiness = evaluateEntryGates(input({ readiness: [{ id: 'kalshi-live', label: 'Kalshi 实盘开关', passed: false, blockReason: '请开启 Kalshi 实盘开关' }] }))
    expect(readiness.firstBlockReason).toBe('请开启 Kalshi 实盘开关')

    const busy = evaluateEntryGates(input({ executionIdle: false }))
    expect(busy.firstBlockReason).toContain('执行中的套利组')
  })
})
