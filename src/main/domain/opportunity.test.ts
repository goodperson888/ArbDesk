import { describe, expect, it } from 'vitest'
import { calculateOpportunity, polymarketCryptoFeePerShare } from './opportunity'
import {
  normalizeSettlementDistanceRules,
  settlementDistanceBpsAt,
  settlementDistanceBpsForRemaining
} from './settlement-distance'

describe('opportunity calculator', () => {
  it('includes Polymarket crypto taker fee and risk buffer', () => {
    const result = calculateOpportunity({
      id: 'test',
      durationMinutes: 5,
      startTime: 0,
      endTime: 300_000,
      mexcDirection: 'UP',
      mexcPrice: '0.42',
      mexcFeeRate: '0.015',
      mexcFeeRateSource: 'HISTORY',
      polymarketPrice: '0.50',
      maxQuantity: '100',
      mexcAvailableQuantity: '120',
      polymarketAvailableQuantity: '100',
      mexcQuoteAgeMs: 250,
      polymarketQuoteAgeMs: 500,
      riskBufferPerShare: '0.01'
    })

    expect(polymarketCryptoFeePerShare('0.5').toFixed(4)).toBe('0.0175')
    expect(result.mexcFeePerShare).toBe('0.006300')
    expect(result.allInCostPerShare).toBe('0.953800')
    expect(result.expectedProfit).toBe('4.62')
    expect(result.polymarketDirection).toBe('DOWN')
    expect(result.polymarketEffectiveFeeRate).toBe('0.035000')
    expect(result.conditionalReturnPct).toBe('4.84')
    expect(result.mexcAvailableQuantity).toBe('120.00')
    expect(result.polymarketAvailableQuantity).toBe('100.00')
    expect(result.mexcQuoteAgeMs).toBe(250)
    expect(result.polymarketQuoteAgeMs).toBe(500)
    expect(result.worstCaseReturnPct).toBe('-98.95')
    expect(result.feeVerificationBlocked).toBe(false)
  })

  it('marks stale quotes and non-positive opportunities', () => {
    const result = calculateOpportunity({
      id: 'stale',
      durationMinutes: 15,
      startTime: 0,
      endTime: 900_000,
      mexcDirection: 'DOWN',
      mexcPrice: '0.55',
      mexcFeeRate: '0.015',
      mexcFeeRateSource: 'HISTORY',
      polymarketPrice: '0.47',
      maxQuantity: '10',
      riskBufferPerShare: '0.01',
      quoteAgeMs: 2_000,
      maxQuoteAgeMs: 1_000
    })

    expect(result.stale).toBe(true)
    expect(result.riskFlags).toContain('行情已过期')
    expect(result.riskFlags).toContain('计入费用和缓冲后无正收益')
  })

  it('blocks execution when settlement-source directions disagree and exposes both-outcome scenarios', () => {
    const result = calculateOpportunity({
      id: 'basis-risk',
      durationMinutes: 5,
      startTime: 0,
      endTime: 300_000,
      mexcDirection: 'UP',
      mexcPrice: '0.20',
      mexcFeeRate: '0.015',
      mexcFeeRateSource: 'HISTORY',
      polymarketPrice: '0.70',
      polymarketFeeRate: '0.07',
      maxQuantity: '10',
      riskBufferPerShare: '0.008',
      mexcSignal: 'UP',
      polymarketSignal: 'DOWN',
      mexcDistanceBps: '4',
      polymarketDistanceBps: '-3'
    })

    expect(result.settlementRiskBlocked).toBe(true)
    expect(result.settlementRiskReason).toContain('结算信号分歧')
    expect(result.bothLosePnlPerShare).toBe('-0.917700')
    expect(result.bothWinPnlPerShare).toBe('1.082300')
  })

  it('supports the V2 fee exponent and blocks an unverified MEXC rate', () => {
    const result = calculateOpportunity({
      id: 'fee-v2', durationMinutes: 5, startTime: 0, endTime: 300_000,
      mexcDirection: 'UP', mexcPrice: '0.40', mexcFeeRateSource: 'UNAVAILABLE',
      polymarketPrice: '0.50', polymarketFeeRate: '0.08', polymarketFeeExponent: '2',
      maxQuantity: '10', riskBufferPerShare: '0'
    })

    expect(polymarketCryptoFeePerShare('0.5', '0.08', '2').toFixed(4)).toBe('0.0050')
    expect(result.polymarketEffectiveFeeRate).toBe('0.010000')
    expect(result.feeVerificationBlocked).toBe(true)
    expect(result.riskFlags).toContainEqual(expect.stringContaining('手续费与净收益暂不可确认'))
  })

  it('reduces the settlement-distance threshold only near expiry', () => {
    const rules = [
      { id: '120', remainingSeconds: 120, minimumBps: '2' },
      { id: '20', remainingSeconds: 20, minimumBps: '0.5' }
    ]
    expect(settlementDistanceBpsAt(rules, 300_000, 0).toFixed(2)).toBe('2.00')
    expect(settlementDistanceBpsAt(rules, 100_000, 30_000).toFixed(2)).toBe('1.25')
    expect(settlementDistanceBpsAt(rules, 100_000, 80_000).toFixed(2)).toBe('0.50')

    const input = {
      id: 'dynamic-distance', durationMinutes: 5 as const, startTime: 0, endTime: 100_000,
      mexcDirection: 'UP' as const, mexcPrice: '0.40', mexcFeeRate: '0.015', mexcFeeRateSource: 'HISTORY' as const,
      polymarketPrice: '0.50', polymarketFeeRate: '0.07', polymarketFeeExponent: '1',
      maxQuantity: '10', riskBufferPerShare: '0', mexcSignal: 'UP' as const, polymarketSignal: 'UP' as const,
      mexcDistanceBps: '1', polymarketDistanceBps: '8'
    }
    const earlier = calculateOpportunity({ ...input, settlementDistanceRules: rules, evaluationTime: 30_000 })
    const later = calculateOpportunity({ ...input, settlementDistanceRules: rules, evaluationTime: 50_000 })

    expect(earlier.requiredSettlementDistanceBps).toBe('1.2500')
    expect(earlier.settlementRiskBlocked).toBe(true)
    expect(later.requiredSettlementDistanceBps).toBe('0.9500')
    expect(later.settlementRiskBlocked).toBe(false)
  })

  it('interpolates customer-defined settlement-distance nodes', () => {
    const rules = [
      { id: 'late', remainingSeconds: 180, minimumBps: '4' },
      { id: 'middle', remainingSeconds: 60, minimumBps: '1' },
      { id: 'close', remainingSeconds: 10, minimumBps: '0.25' }
    ]

    expect(settlementDistanceBpsForRemaining(rules, 240).toFixed(2)).toBe('4.00')
    expect(settlementDistanceBpsForRemaining(rules, 120).toFixed(2)).toBe('2.50')
    expect(settlementDistanceBpsForRemaining(rules, 35).toFixed(3)).toBe('0.625')
    expect(settlementDistanceBpsForRemaining(rules, 5).toFixed(2)).toBe('0.25')
  })

  it('rejects duplicate or invalid customer-defined nodes', () => {
    expect(() => normalizeSettlementDistanceRules([
      { id: 'first', remainingSeconds: 60, minimumBps: '1' },
      { id: 'duplicate', remainingSeconds: 60, minimumBps: '2' }
    ])).toThrow('存在重复规则')
    expect(() => normalizeSettlementDistanceRules([])).toThrow('至少保留一个规则节点')
    expect(() => normalizeSettlementDistanceRules([
      { id: 'invalid', remainingSeconds: -1, minimumBps: '1' }
    ])).toThrow('剩余秒数')
  })
})
