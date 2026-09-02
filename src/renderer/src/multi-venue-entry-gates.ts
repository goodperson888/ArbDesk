import type { EntryGateReport, EntryGateReadiness } from '../../shared/entry-gates'
import { evaluateEntryGates } from '../../shared/entry-gates'
import { isMultiVenueExecutionVenue, type MultiVenueComparison } from '../../shared/multi-venue'
import type { GateOrderCaptureSummary, RiskSettings } from '../../shared/types'

export interface MultiVenueEntryGateArgs {
  comparison: MultiVenueComparison
  quantity: string
  settings: RiskSettings
  now: number
  executionIdle: boolean
  kalshiReady?: boolean
  gateReady: boolean
  allowDoubleWinEntry?: boolean
}

export function gateDurationExecutionReady(summary: GateOrderCaptureSummary | undefined, durationMinutes: number): boolean {
  if (durationMinutes !== 5 && durationMinutes !== 15) return false
  return summary?.executableDurations?.includes(durationMinutes) === true
}

export function buildMultiVenueEntryGateReport(args: MultiVenueEntryGateArgs): EntryGateReport {
  const unprotected = args.settings.mode === 'ASSISTED' && args.settings.unprotectedExecutionEnabled === true
  const supportedRoute = args.comparison.legs.length === 2 && args.comparison.legs.every((leg) => isMultiVenueExecutionVenue(leg.venueId))
  const doubleWinConsented = args.comparison.doubleWinEntryEligible === true && args.allowDoubleWinEntry === true
  const settlementRiskPassed = args.comparison.settlementRiskPassed === undefined
    ? args.comparison.matchClass === 'EXACT'
    : args.comparison.settlementRiskPassed === true || doubleWinConsented
  const settlementLabel = doubleWinConsented
    ? `已确认当前双赢组合开仓；安全距离 ${args.comparison.settlementDistanceBps ?? '—'} ≥ ${args.comparison.requiredSettlementDistanceBps ?? '—'} bps`
    : settlementRiskPassed
      ? `动态安全距离通过：${args.comparison.settlementDistanceBps ?? '—'} ≥ ${args.comparison.requiredSettlementDistanceBps ?? '—'} bps`
      : args.comparison.settlementRiskReason ?? '无法验证动态安全距离'
  const unsupportedVenue = args.comparison.legs.find((leg) => !isMultiVenueExecutionVenue(leg.venueId))?.venueId
  const unsupportedReason = unsupportedVenue === 'LIMITLESS'
      ? 'Limitless 当前只读，尚未开放实盘执行'
      : '当前路线尚未接入真实执行'
  const liveReady = (venueId: string): boolean => venueId === 'MEXC'
    ? args.settings.mexcAutomationEnabled === true
    : venueId === 'POLYMARKET'
      ? args.settings.polymarketLiveEnabled === true
      : venueId === 'GATE'
        ? args.settings.gateLiveEnabled === true
        : venueId === 'KALSHI'
          ? args.settings.kalshiLiveEnabled === true
          : venueId === 'PREDICT_FUN'
            ? args.settings.predictFunLiveEnabled === true
          : false
  const readiness: EntryGateReadiness[] = [
    { id: 'supported-route', label: supportedRoute ? '双腿路线已接入' : unsupportedReason, passed: supportedRoute, blockReason: unsupportedReason },
    { id: 'assisted-mode', label: args.settings.mode === 'ASSISTED' ? '已进入人工监督模式' : '尚未进入人工监督模式', passed: args.settings.mode === 'ASSISTED', blockReason: '请先切换到人工监督模式' },
    ...args.comparison.legs.flatMap((leg) => {
      const items: EntryGateReadiness[] = [{
        id: `${leg.venueId.toLowerCase()}-live`,
        label: `${leg.venueLabel} 实盘开关${liveReady(leg.venueId) ? '已开启' : '未开启'}`,
        passed: liveReady(leg.venueId),
        blockReason: `请先开启 ${leg.venueLabel} 实盘下单`
      }]
      if (leg.venueId === 'KALSHI') items.push({
        id: 'kalshi-credentials',
        label: args.kalshiReady ? 'Kalshi 本地身份已配置' : 'Kalshi 本地身份未配置',
        passed: args.kalshiReady === true,
        blockReason: '请先配置 Kalshi API Key ID 与 RSA 私钥'
      })
      if (leg.venueId === 'GATE') items.push({
        id: 'gate-capture',
        label: `Gate ${args.comparison.durationMinutes}m 下单页面${args.gateReady ? '已接管' : '未接管'}`,
        passed: args.gateReady,
        blockReason: `Gate ${args.comparison.durationMinutes}m 下单页面未接管`
      })
      return items
    })
  ]

  return evaluateEntryGates({
    mode: 'MANUAL', quantity: args.quantity, allInCostPerShare: args.comparison.allInCostPerShare,
    conditionalReturnPct: args.comparison.conditionalReturnPct, edgeKind: args.comparison.edgeKind,
    matchClass: args.comparison.matchClass, endTime: args.comparison.endTime, now: args.now,
    maxCapitalPerTrade: args.settings.maxCapitalPerTrade, minConditionalReturnPct: args.settings.minConditionalReturnPct,
    maxQuoteAgeMs: args.settings.maxQuoteAgeMs, stopBeforeExpirySeconds: args.settings.stopBeforeExpirySeconds,
    manualConditions: unprotected
      ? {
          ...args.settings.manualExecutionConditions,
          conditionalReturn: false,
          feeVerification: false,
          settlementRisk: false,
          quoteFreshness: false,
          expiryCutoff: true
        }
      : args.settings.manualExecutionConditions,
    executionIdle: args.executionIdle,
    settlementRiskPassed,
    settlementRiskLabel: settlementLabel,
    settlementRiskBlockReason: args.comparison.settlementRiskReason ?? '动态安全距离未通过',
    depthLimitApplicable: !unprotected,
    readiness,
    legs: args.comparison.legs.map((leg) => ({
      ...leg,
      minimumQuantity: leg.venueId === 'KALSHI' ? '1' : undefined,
      minimumNotionalUsd: leg.venueId === 'GATE' ? '5' : undefined
    }))
  })
}
