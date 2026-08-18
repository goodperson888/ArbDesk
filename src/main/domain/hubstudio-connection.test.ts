import { describe, expect, it } from 'vitest'
import {
  HUBSTUDIO_RECONNECT_COOLDOWN_MS,
  canAttemptHubstudioReconnect,
  hubstudioMarketDuration
} from './hubstudio-connection'

describe('Hubstudio connection helpers', () => {
  it('recognizes existing 5m and 15m prediction tabs', () => {
    expect(hubstudioMarketDuration('https://prediction.mexc.com/prediction-markets/up-down/btc-5min-price/123')).toBe(5)
    expect(hubstudioMarketDuration('https://prediction.mexc.com/prediction-markets/up-down/btc-15min-price/456?source=tab')).toBe(15)
    expect(hubstudioMarketDuration('https://www.mexc.com/exchange/BTC_USDT')).toBeUndefined()
  })

  it('throttles passive reconnect attempts while allowing an explicit reconnect', () => {
    const lastAttemptAt = 10_000
    expect(canAttemptHubstudioReconnect(lastAttemptAt, lastAttemptAt + HUBSTUDIO_RECONNECT_COOLDOWN_MS - 1)).toBe(false)
    expect(canAttemptHubstudioReconnect(lastAttemptAt, lastAttemptAt + HUBSTUDIO_RECONNECT_COOLDOWN_MS)).toBe(true)
    expect(canAttemptHubstudioReconnect(lastAttemptAt, lastAttemptAt + 1, true)).toBe(true)
  })
})
