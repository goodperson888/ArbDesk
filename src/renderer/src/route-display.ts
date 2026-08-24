import type { MultiVenueComparison } from '../../shared/multi-venue'

export function routeDirectionLabel(comparison: MultiVenueComparison): string {
  const first = comparison.legs[0]
  const second = comparison.legs[1]
  if (!first || !second) return '路线未完整映射'
  return `${first.venueLabel} ${first.direction} → ${second.venueLabel} ${second.direction}`
}

export function stableRouteKey(comparison: MultiVenueComparison): string {
  return comparison.id
}
