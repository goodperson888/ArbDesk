import { describe, expect, it } from 'vitest'
import { deriveMexcFeeRate } from './mexc-fee'

describe('MEXC prediction fee calibration', () => {
  it('derives the median fee ratio from paired fee and trade asset logs', () => {
    const result = deriveMexcFeeRate([
      { tn: 'buy-1', ta: -0.1624, bt: 104 },
      { tn: 'buy-1', ta: -10.8299, bt: 107 },
      { tn: 'sell-1', ta: -0.5952, bt: 104 },
      { tn: 'sell-1', ta: 39.6852, bt: 108 }
    ])

    expect(Number(result.feeRate)).toBeCloseTo(0.015, 4)
    expect(result.source).toBe('HISTORY')
    expect(result.sampleCount).toBe(2)
  })

  it('uses a conservative fallback when no paired history is available', () => {
    expect(deriveMexcFeeRate([])).toEqual({
      feeRate: '0.015',
      source: 'CONSERVATIVE_FALLBACK',
      sampleCount: 0
    })
  })
})
