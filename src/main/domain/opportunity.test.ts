import { describe, expect, it } from 'vitest'
import { calculateOpportunity, polymarketCryptoFeePerShare } from './opportunity'

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
      polymarketPrice: '0.50',
      maxQuantity: '100',
      riskBufferPerShare: '0.01'
    })

    expect(polymarketCryptoFeePerShare('0.5').toFixed(4)).toBe('0.0175')
    expect(result.mexcFeePerShare).toBe('0.006300')
    expect(result.allInCostPerShare).toBe('0.953800')
    expect(result.expectedProfit).toBe('4.62')
    expect(result.polymarketDirection).toBe('DOWN')
  })

  it('marks stale quotes and non-positive opportunities', () => {
    const result = calculateOpportunity({
      id: 'stale',
      durationMinutes: 15,
      startTime: 0,
      endTime: 900_000,
      mexcDirection: 'DOWN',
      mexcPrice: '0.55',
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
})
