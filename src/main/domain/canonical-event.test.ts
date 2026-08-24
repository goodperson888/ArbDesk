import { describe, expect, it } from 'vitest'
import { canonicalEventId, normalizeCanonicalEvent, type CanonicalEventInput } from './canonical-event'

const btc15m = (overrides: Partial<CanonicalEventInput> = {}): CanonicalEventInput => ({
  category: 'CRYPTO',
  subject: 'btc',
  interval: '15m',
  startTime: 1_787_477_400_000,
  endTime: 1_787_478_300_000,
  settlementSource: 'chainlink-btc-usd',
  outcomes: ['UP', 'DOWN'],
  ...overrides
})

describe('canonical event identity', () => {
  it('normalizes case and produces the same id for equivalent BTC input', () => {
    const left = canonicalEventId(btc15m())
    const right = canonicalEventId(btc15m({ subject: ' BTC ', interval: '15M', outcomes: ['DOWN', 'UP'] }))
    expect(left).toBe(right)
    expect(normalizeCanonicalEvent(btc15m()).subject).toBe('BTC')
  })

  it('keeps BTC 5m and 15m events distinct', () => {
    expect(canonicalEventId(btc15m({ interval: '5m', endTime: 1_787_477_700_000 }))).not.toBe(canonicalEventId(btc15m()))
  })

  it('rejects an event with an invalid interval or incomplete outcome set', () => {
    expect(() => normalizeCanonicalEvent(btc15m({ interval: '0m' }))).toThrow('interval')
    expect(() => normalizeCanonicalEvent(btc15m({ outcomes: ['UP'] }))).toThrow('outcomes')
  })
})
