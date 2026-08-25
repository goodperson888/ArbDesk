import { readFile } from 'node:fs/promises'
import type { MarketProfile } from '../../shared/market-profile'

const KNOWN_VENUES = new Set(['MEXC', 'POLYMARKET', 'LIMITLESS', 'PREDICT_FUN', 'GATE', 'KALSHI'])
const INTERVAL_PATTERN = /^\d+(?:m|h|d)$/

export const DEFAULT_MARKET_PROFILE: MarketProfile = {
  id: 'btc-all',
  subjects: ['BTC'],
  intervals: ['5m', '15m'],
  venues: ['MEXC', 'POLYMARKET', 'LIMITLESS', 'PREDICT_FUN', 'GATE', 'KALSHI'],
  routes: ['*']
}

function asStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${field} 必须是非空字符串数组`)
  }
  return [...new Set(value.map((item) => item.trim().toUpperCase()))]
}

function intervalList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string')) throw new Error('intervals 必须是非空字符串数组')
  const intervals = [...new Set(value.map((item) => String(item).trim().toLowerCase()))]
  if (intervals.some((interval) => !INTERVAL_PATTERN.test(interval))) throw new Error('interval 无效')
  return intervals
}

function routeKey(left: string, right: string): string {
  return [left.toUpperCase(), right.toUpperCase()].sort().join(':')
}

export function parseMarketProfile(value: unknown): MarketProfile {
  if (!value || typeof value !== 'object') throw new Error('market profile 必须是对象')
  const source = value as Partial<MarketProfile>
  if (typeof source.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(source.id.trim())) throw new Error('profile id 无效')
  const subjects = asStringList(source.subjects, 'subjects')
  const intervals = intervalList(source.intervals)
  const venues = asStringList(source.venues, 'venues')
  if (venues.some((venue) => !KNOWN_VENUES.has(venue))) throw new Error('profile venue 未知')
  if (!Array.isArray(source.routes) || source.routes.length === 0 || source.routes.some((route) => typeof route !== 'string' || !route.trim())) throw new Error('routes 必须是非空字符串数组')
  const routes = [...new Set(source.routes.map((route) => route.trim().toUpperCase()))]
  for (const route of routes) {
    if (route === '*') continue
    const [left, right, extra] = route.split(':')
    if (extra || !left || !right || left === right || !KNOWN_VENUES.has(left) || !KNOWN_VENUES.has(right) || !venues.includes(left) || !venues.includes(right)) {
      throw new Error('profile route 无效')
    }
  }
  return { id: source.id.trim(), subjects, intervals, venues, routes }
}

export function profileAllowsVenue(profile: MarketProfile, venueId: string): boolean {
  return profile.venues.includes(venueId.toUpperCase())
}

export function profileAllowsWindow(profile: MarketProfile, window: { asset: string; durationMinutes: number }): boolean {
  const subject = window.asset.split('/')[0]?.trim().toUpperCase()
  return Boolean(subject) && profile.subjects.includes(subject) && profile.intervals.includes(`${window.durationMinutes}m`)
}

export function profileAllowsRoute(profile: MarketProfile, left: string, right: string): boolean {
  if (!profileAllowsVenue(profile, left) || !profileAllowsVenue(profile, right) || left.toUpperCase() === right.toUpperCase()) return false
  return profile.routes.includes('*') || profile.routes.includes(routeKey(left, right))
}

export async function loadMarketProfile(profilePath?: string): Promise<MarketProfile> {
  if (!profilePath) return DEFAULT_MARKET_PROFILE
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(profilePath, 'utf8'))
  } catch (error) {
    throw new Error(`无法读取市场 Profile：${error instanceof Error ? error.message : String(error)}`)
  }
  return parseMarketProfile(parsed)
}
