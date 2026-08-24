import type { MultiVenueComparison } from '../../shared/multi-venue'
import type { Direction, RiskSettings } from '../../shared/types'
import type { MexcWindowQuote } from '../services/mexc-browser'
import type { PolymarketWindowQuote } from '../services/polymarket-market-data'
import type { ResolutionFingerprint } from './contracts'
import type { ReadOnlyWindowQuote } from './read-only-types'
import { buildBidirectionalRoutes, routeToComparison } from '../domain/route-builder'

function mexcResolution(window: MexcWindowQuote): ResolutionFingerprint {
  return {
    asset: 'BTC/USD', startTime: window.startTime, endTime: window.endTime,
    baselineSource: 'MEXC:PLATFORM_RULE', settlementSource: 'MEXC:PLATFORM_RULE',
    observationMethod: 'MEXC prediction market settlement rule', comparisonOperator: 'GT', tieOutcome: 'DOWN',
    voidRule: 'Platform rule', staleDataRule: 'Platform rule', timezone: 'UTC', ruleVersion: 'mexc-legacy-live'
  }
}

function polymarketResolution(window: PolymarketWindowQuote): ResolutionFingerprint {
  return {
    asset: 'BTC/USD', startTime: window.startTime, endTime: window.endTime,
    baselineSource: 'CHAINLINK:BTC/USD_TWAP_60S', settlementSource: 'CHAINLINK:BTC/USD_TWAP_60S',
    observationMethod: 'Polymarket opening and settlement Chainlink-computed 60-second TWAP', comparisonOperator: 'GTE', tieOutcome: 'UP',
    voidRule: 'Polymarket market rule', staleDataRule: 'Polymarket market rule', timezone: 'UTC',
    ruleVersion: 'polymarket-chainlink-twap-60s-2026-08-14'
  }
}

export function normalizeLegacyWindows(
  mexcWindows: MexcWindowQuote[],
  polymarketWindows: PolymarketWindowQuote[]
): ReadOnlyWindowQuote[] {
  const mexc = mexcWindows.flatMap((window): ReadOnlyWindowQuote[] => {
    if (window.durationMinutes !== 5 && window.durationMinutes !== 15) return []
    return [{
      venueId: 'MEXC', marketId: window.eventId, asset: 'BTC/USD', durationMinutes: window.durationMinutes,
      startTime: window.startTime, endTime: window.endTime, feeVerified: window.feeRateSource === 'HISTORY',
      feeRateBps: Number(window.feeRate || 0) * 10_000, resolution: mexcResolution(window),
      outcomes: Object.fromEntries((['UP', 'DOWN'] as const).map((direction) => {
        const quote = window.outcomes[direction]
        return [direction, {
          direction, outcomeId: quote.symbolId, bestAsk: quote.bestAsk, askSize: quote.askSize,
          levels: quote.levels, receivedAt: quote.receivedAt
        }]
      }))
    }]
  })
  const polymarket = polymarketWindows.flatMap((window): ReadOnlyWindowQuote[] => {
    if (window.durationMinutes !== 5 && window.durationMinutes !== 15) return []
    return [{
      venueId: 'POLYMARKET', marketId: window.conditionId ?? `${window.startTime}`, asset: 'BTC/USD',
      durationMinutes: window.durationMinutes, startTime: window.startTime, endTime: window.endTime,
      feeVerified: true, resolution: polymarketResolution(window),
      outcomes: Object.fromEntries(Object.entries(window.outcomes).map(([direction, quote]) => [direction, quote ? {
        direction: direction as Direction, outcomeId: quote.tokenId, bestAsk: quote.bestAsk, askSize: quote.askSize,
        levels: quote.levels, receivedAt: quote.receivedAt
      } : undefined]))
    }]
  })
  return [...mexc, ...polymarket]
}

export function buildReadOnlyComparisons(windows: ReadOnlyWindowQuote[], settings: RiskSettings, now: number): MultiVenueComparison[] {
  return buildBidirectionalRoutes(windows, settings, now)
    // The mature MEXC↔Polymarket path already has its own fee/risk model and
    // execution provider. Keep it out of the supplemental board to avoid a
    // duplicate opportunity row while every other pair uses the generic route.
    .filter((route) => new Set([route.left.venueId, route.right.venueId]).size === 2 && ![route.left.venueId, route.right.venueId].every((venue) => venue === 'MEXC' || venue === 'POLYMARKET'))
    .map((route) => routeToComparison(route, settings, now))
    .sort((left, right) => left.fixedSortKey.localeCompare(right.fixedSortKey))
}
