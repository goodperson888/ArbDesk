import { describe, expect, it } from 'vitest'
import { parseKalshiCandidate } from './kalshi-market-data'

describe('Kalshi market normalization', () => {
  it('accepts only the live BTC 15m directional binary market', () => {
    expect(parseKalshiCandidate({
      ticker: 'KXBTC-26AUG221230-5M-UP', market_type: 'binary', status: 'open',
      title: 'Bitcoin up or down in 5 minutes?',
      open_time: '2026-08-22T04:00:00.000Z', close_time: '2026-08-22T04:05:00.000Z'
    })).toBeUndefined()
    expect(parseKalshiCandidate({
      ticker: 'KXBTC15M-26AUG221230-30', market_type: 'binary', status: 'open',
      title: 'Bitcoin up or down in 15 minutes?',
      open_time: '2026-08-22T04:00:00.000Z', close_time: '2026-08-22T04:15:00.000Z'
    })).toMatchObject({ durationMinutes: 15, yesDirection: 'UP' })
    expect(parseKalshiCandidate({
      ticker: 'KXBTC-DAILY', market_type: 'binary', status: 'open', title: 'Bitcoin daily close above target?',
      open_time: '2026-08-22T04:00:00.000Z', close_time: '2026-08-23T04:00:00.000Z'
    })).toBeUndefined()
  })

  it('rejects ambiguous BTC threshold markets without a directional rule', () => {
    expect(parseKalshiCandidate({
      ticker: 'KXBTC-5M', market_type: 'binary', status: 'open', title: 'Bitcoin price in 5 minutes',
      open_time: '2026-08-22T04:00:00.000Z', close_time: '2026-08-22T04:05:00.000Z'
    })).toBeUndefined()
  })

  it('accepts the live KXBTC15M series shape even when the API omits a title', () => {
    const candidate = parseKalshiCandidate({
      ticker: 'KXBTC15M-26AUG230330-30', market_type: 'binary', status: 'active',
      open_time: '2026-08-23T03:15:00.000Z', close_time: '2026-08-23T03:30:00.000Z'
    })
    expect(candidate).toMatchObject({ durationMinutes: 15, yesDirection: 'UP' })
  })
})
