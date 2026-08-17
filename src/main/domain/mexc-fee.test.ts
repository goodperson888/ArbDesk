import { describe, expect, it } from 'vitest'
import { deriveMexcFeeRate } from './mexc-fee'

describe('MEXC prediction fee calibration', () => {
  const now = 1_786_944_000_000

  it('uses the latest recent buy and ignores sell-side fees', () => {
    const result = deriveMexcFeeRate([
      { tn: 'buy-old', ta: -0.1624, bt: 104, tt: now - 10_000 },
      { tn: 'buy-old', ta: -10.8299, bt: 107, tt: now - 10_000 },
      { tn: 'buy-latest', ta: -0.1, bt: 104, tt: now - 1_000 },
      { tn: 'buy-latest', ta: -10, bt: 107, tt: now - 1_000 },
      { tn: 'sell-1', ta: -0.5952, bt: 104, tt: now },
      { tn: 'sell-1', ta: 39.6852, bt: 108, tt: now }
    ], now)

    expect(Number(result.feeRate)).toBeCloseTo(0.01, 6)
    expect(result.source).toBe('HISTORY')
    expect(result.sampleCount).toBe(2)
  })

  it('recognizes a recent buy without a fee row as a zero-fee trade', () => {
    expect(deriveMexcFeeRate([{ tn: 'zero-fee', ta: -10, bt: 107, tt: now - 1_000 }], now)).toEqual({
      feeRate: '0', source: 'HISTORY', sampleCount: 1
    })
  })

  it('reports unavailable instead of inventing a fallback when history is stale or absent', () => {
    expect(deriveMexcFeeRate([{ tn: 'stale', ta: -10, bt: 107, tt: now - 8 * 24 * 60 * 60 * 1_000 }], now)).toEqual({
      feeRate: '0',
      source: 'UNAVAILABLE',
      sampleCount: 0
    })
  })
})
