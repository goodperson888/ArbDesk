import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { DEFAULT_MARKET_PROFILE, loadMarketProfile, parseMarketProfile, profileAllowsRoute, profileAllowsWindow } from './market-profile'

describe('market profiles', () => {
  it('allows the default BTC profile only for configured BTC windows', () => {
    expect(profileAllowsWindow(DEFAULT_MARKET_PROFILE, { asset: 'BTC/USD', durationMinutes: 15 })).toBe(true)
    expect(profileAllowsWindow(DEFAULT_MARKET_PROFILE, { asset: 'ETH/USD', durationMinutes: 15 })).toBe(false)
    expect(profileAllowsWindow({ ...DEFAULT_MARKET_PROFILE, intervals: ['15m'] }, { asset: 'BTC/USD', durationMinutes: 5 })).toBe(false)
  })

  it('accepts wildcard routes and rejects venues outside the profile', () => {
    expect(profileAllowsRoute(DEFAULT_MARKET_PROFILE, 'GATE', 'KALSHI')).toBe(true)
    expect(profileAllowsRoute({ ...DEFAULT_MARKET_PROFILE, venues: ['MEXC', 'KALSHI'], routes: ['MEXC:KALSHI'] }, 'GATE', 'KALSHI')).toBe(false)
  })

  it('rejects malformed profiles instead of silently widening the build', () => {
    expect(() => parseMarketProfile({ ...DEFAULT_MARKET_PROFILE, intervals: ['1x'] })).toThrow('interval')
    expect(() => parseMarketProfile({ ...DEFAULT_MARKET_PROFILE, venues: ['UNKNOWN'] })).toThrow('venue')
    expect(() => parseMarketProfile({ ...DEFAULT_MARKET_PROFILE, routes: ['MEXC:MEXC'] })).toThrow('route')
  })

  it('loads the Git package profile with only the Gate/Kalshi BTC 15m route', async () => {
    const profile = await loadMarketProfile(resolve(process.cwd(), 'config/market-profiles/btc-gate-kalshi.json'))

    expect(profile).toEqual({
      id: 'btc-gate-kalshi',
      subjects: ['BTC'],
      intervals: ['15m'],
      venues: ['GATE', 'KALSHI'],
      routes: ['GATE:KALSHI']
    })
    expect(profileAllowsRoute(profile, 'GATE', 'KALSHI')).toBe(true)
    expect(profileAllowsRoute(profile, 'MEXC', 'KALSHI')).toBe(false)
    expect(profileAllowsWindow(profile, { asset: 'BTC/USD', durationMinutes: 5 })).toBe(false)
  })

  it('保留专用和全量两个可打包 Profile', async () => {
    const gateKalshi = await loadMarketProfile(resolve(process.cwd(), 'config/market-profiles/btc-gate-kalshi.json'))
    const all = await loadMarketProfile(resolve(process.cwd(), 'config/market-profiles/btc-all.json'))

    expect(profileAllowsRoute(gateKalshi, 'GATE', 'KALSHI')).toBe(true)
    expect(profileAllowsRoute(gateKalshi, 'MEXC', 'POLYMARKET')).toBe(false)
    expect(profileAllowsWindow(gateKalshi, { asset: 'BTC/USD', durationMinutes: 5 })).toBe(false)
    expect(profileAllowsRoute(all, 'MEXC', 'POLYMARKET')).toBe(true)
    expect(profileAllowsWindow(all, { asset: 'BTC/USD', durationMinutes: 5 })).toBe(true)
  })
})
