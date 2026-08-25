import type { EntryGateReport, EntryGateReadiness } from '../../shared/entry-gates'
import { evaluateEntryGates } from '../../shared/entry-gates'
import type { MultiVenueComparison } from '../../shared/multi-venue'
import type { RiskSettings } from '../../shared/types'

export interface MultiVenueEntryGateArgs {
  comparison: MultiVenueComparison
  quantity: string
  settings: RiskSettings
  now: number
  executionIdle: boolean
  kalshiReady: boolean
  gateReady: boolean
}

export function buildMultiVenueEntryGateReport(args: MultiVenueEntryGateArgs): EntryGateReport {
  const kalshi = args.comparison.legs.find((leg) => leg.venueId === 'KALSHI')
  const other = args.comparison.legs.find((leg) => leg.venueId !== 'KALSHI')
  const supportedRoute = Boolean(kalshi && other && ['MEXC', 'POLYMARKET', 'GATE'].includes(other.venueId))
  const otherLiveReady = other?.venueId === 'MEXC'
    ? args.settings.mexcAutomationEnabled
    : other?.venueId === 'POLYMARKET'
      ? args.settings.polymarketLiveEnabled
      : other?.venueId === 'GATE' && args.settings.gateLiveEnabled
  const readiness: EntryGateReadiness[] = [
    { id: 'supported-route', label: supportedRoute ? '双腿路线已接入' : '当前路线尚未接入真实执行', passed: supportedRoute, blockReason: '当前路线尚未接入真实双腿执行' },
    { id: 'assisted-mode', label: args.settings.mode === 'ASSISTED' ? '已进入人工监督模式' : '尚未进入人工监督模式', passed: args.settings.mode === 'ASSISTED', blockReason: '请先切换到人工监督模式' },
    { id: 'kalshi-credentials', label: args.kalshiReady ? 'Kalshi 本地身份已配置' : 'Kalshi 本地身份未配置', passed: args.kalshiReady, blockReason: '请先配置 Kalshi API Key ID 与 RSA 私钥' },
    { id: 'kalshi-live', label: args.settings.kalshiLiveEnabled ? 'Kalshi 实盘开关已开启' : 'Kalshi 实盘开关未开启', passed: args.settings.kalshiLiveEnabled === true, blockReason: '请先开启 Kalshi 人工实盘下单开关' },
    ...(other?.venueId === 'GATE' ? [{ id: 'gate-capture', label: args.gateReady ? 'Gate 下单结构已捕获' : 'Gate 下单结构未就绪', passed: args.gateReady, blockReason: '请先完成 Gate 订单结构捕获' }] : []),
    { id: 'first-leg-live', label: `${other?.venueLabel ?? '第一平台'}实盘${otherLiveReady ? '已开启' : '未开启'}`, passed: Boolean(otherLiveReady), blockReason: `请先开启 ${other?.venueLabel ?? '第一平台'} 实盘下单` }
  ]

  return evaluateEntryGates({
    mode: 'MANUAL', quantity: args.quantity, allInCostPerShare: args.comparison.allInCostPerShare,
    conditionalReturnPct: args.comparison.conditionalReturnPct, edgeKind: args.comparison.edgeKind,
    matchClass: args.comparison.matchClass, endTime: args.comparison.endTime, now: args.now,
    maxCapitalPerTrade: args.settings.maxCapitalPerTrade, minConditionalReturnPct: args.settings.minConditionalReturnPct,
    maxQuoteAgeMs: args.settings.maxQuoteAgeMs, stopBeforeExpirySeconds: args.settings.stopBeforeExpirySeconds,
    manualConditions: args.settings.manualExecutionConditions, executionIdle: args.executionIdle,
    readiness,
    legs: args.comparison.legs.map((leg) => ({
      ...leg,
      minimumQuantity: leg.venueId === 'KALSHI' ? '1' : undefined,
      minimumNotionalUsd: leg.venueId === 'GATE' ? '5' : undefined
    }))
  })
}
