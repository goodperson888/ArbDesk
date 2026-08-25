import { describe, expect, it } from 'vitest'
import type { EntryGateReport } from '../../shared/entry-gates'
import type { MultiVenueComparison } from '../../shared/multi-venue'
import { selectReadyComparisons, shouldPlayOpportunityAlert } from './opportunity-alert'

function comparison(id: string, executionProvider: MultiVenueComparison['executionProvider']): MultiVenueComparison {
  return {
    id, legacyOpportunityId: executionProvider === 'LEGACY_MEXC_POLY' ? `${id}-legacy` : undefined,
    asset: 'BTC/USD', durationMinutes: 15, startTime: 0, endTime: 100_000,
    strategy: 'COMPLEMENTARY_OUTCOMES', matchClass: 'EXACT',
    status: executionProvider === 'LEGACY_MEXC_POLY' ? 'EXECUTABLE' : 'MANUAL_EXECUTABLE', executionProvider,
    edgeKind: executionProvider === 'LEGACY_MEXC_POLY' ? 'NET_VERIFIED' : 'GROSS_ONLY', legs: [],
    allInCostPerShare: '0.9', netEdgePerShare: '0.1', conditionalReturnPct: '11', executableQuantity: '10',
    potentialProfit: '1', autoOrderPotentialProfit: '1', fixedSortKey: id, blockReasons: []
  }
}

describe('shared opportunity selection and alert', () => {
  it('同时接受旧路线和通过门禁的 Gate/Kalshi 路线', () => {
    const legacy = comparison('legacy', 'LEGACY_MEXC_POLY')
    const gateKalshi = comparison('gate-kalshi', 'MULTI_VENUE')
    const reports = new Map<string, Pick<EntryGateReport, 'allowed'>>([[gateKalshi.id, { allowed: true }]])
    const ready = selectReadyComparisons({
      comparisons: [legacy, gateKalshi], multiVenueReports: reports,
      legacyReadyIds: new Set([legacy.id])
    })

    expect(ready.map((item) => item.id)).toEqual([legacy.id, gateKalshi.id])
  })

  it('拒绝未通过门禁的多平台路线且不改变原表顺序', () => {
    const blocked = comparison('blocked', 'MULTI_VENUE')
    const ready = comparison('ready', 'MULTI_VENUE')
    const source = [blocked, ready]
    const result = selectReadyComparisons({
      comparisons: source,
      multiVenueReports: new Map([[blocked.id, { allowed: false }], [ready.id, { allowed: true }]]),
      legacyReadyIds: new Set()
    })

    expect(result.map((item) => item.id)).toEqual(['ready'])
    expect(source.map((item) => item.id)).toEqual(['blocked', 'ready'])
  })

  it('同一候选持续合格时不重复播放，新候选在冷却后播放', () => {
    expect(shouldPlayOpportunityAlert(undefined, 'a', 0, 10_000, 30_000)).toBe(true)
    expect(shouldPlayOpportunityAlert('a', 'a', 10_000, 20_000, 30_000)).toBe(false)
    expect(shouldPlayOpportunityAlert('a', 'b', 10_000, 20_000, 30_000)).toBe(false)
    expect(shouldPlayOpportunityAlert('a', 'b', 10_000, 41_000, 30_000)).toBe(true)
    expect(shouldPlayOpportunityAlert('a', undefined, 10_000, 41_000, 30_000)).toBe(false)
  })
})
