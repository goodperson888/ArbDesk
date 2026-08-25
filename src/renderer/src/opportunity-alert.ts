import type { EntryGateReport } from '../../shared/entry-gates'
import type { MultiVenueComparison } from '../../shared/multi-venue'

export interface ReadyComparisonSelectionArgs {
  comparisons: MultiVenueComparison[]
  legacyReadyIds: ReadonlySet<string>
  multiVenueReports: ReadonlyMap<string, Pick<EntryGateReport, 'allowed'>>
}

export function selectReadyComparisons(args: ReadyComparisonSelectionArgs): MultiVenueComparison[] {
  return args.comparisons.filter((comparison) => {
    if (comparison.executionProvider === 'LEGACY_MEXC_POLY') {
      return comparison.status === 'EXECUTABLE' && args.legacyReadyIds.has(comparison.id)
    }
    return comparison.status === 'MANUAL_EXECUTABLE' && args.multiVenueReports.get(comparison.id)?.allowed === true
  })
}

export function shouldPlayOpportunityAlert(
  previousId: string | undefined,
  currentId: string | undefined,
  lastPlayedAt: number,
  now: number,
  cooldownMs: number
): boolean {
  if (!currentId || currentId === previousId) return false
  if (previousId === undefined) return true
  return now - lastPlayedAt >= cooldownMs
}
