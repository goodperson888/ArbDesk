import { randomUUID } from 'node:crypto'
import type { RiskSettings } from '../../shared/types'
import type {
  MultiVenueComparison,
  MultiVenueExecutionCommand,
  MultiVenueExecutionLegRequest,
  MultiVenueExecutionReceipt,
  MultiVenueExecutionRequest
} from '../../shared/multi-venue'
import { isMultiVenueExecutionVenue } from '../../shared/multi-venue'
import { evaluateEntryGates } from '../../shared/entry-gates'
import type { MexcBrowserManager } from './mexc-browser'
import type { PolymarketLiveBroker } from './polymarket-live'
import type { KalshiTradingService } from './kalshi-trading'
import type { GateOrderTransport } from '../platforms/adapters/gate-adapter'
import type { PredictFunTradingService } from './predict-fun-trading'
import { MexcVenueAdapter } from '../platforms/adapters/mexc-adapter'
import { PolymarketVenueAdapter } from '../platforms/adapters/polymarket-adapter'
import { KalshiVenueAdapter } from '../platforms/adapters/kalshi-adapter'
import { GateVenueAdapter } from '../platforms/adapters/gate-adapter'
import { PredictFunVenueAdapter } from '../platforms/adapters/predict-fun-adapter'
import { TwoLegExecutionMachine } from '../domain/two-leg-execution'
import type { ExecutionSessionStore } from './execution-session-store'

interface PairExecutionDependencies {
  mexc: MexcBrowserManager
  polymarket?: PolymarketLiveBroker
  kalshi: KalshiTradingService
  gate?: GateOrderTransport
  predictFun?: PredictFunTradingService
  settings: () => RiskSettings
  comparisonProvider: (comparisonId: string) => MultiVenueComparison | undefined
  kalshiCredentialsReady: () => Promise<boolean>
  gateExecutionReady: (durationMinutes: 5 | 15) => boolean
  liveExecutionEnabled: boolean
  executionSessionStore?: ExecutionSessionStore
}

const leadPriority: Record<string, number> = {
  MEXC: 10,
  POLYMARKET: 20,
  GATE: 30,
  KALSHI: 40,
  PREDICT_FUN: 50
}

function pairFor(legs: MultiVenueExecutionLegRequest[]): { first: MultiVenueExecutionLegRequest; second: MultiVenueExecutionLegRequest } {
  if (legs.length !== 2 || legs[0].venueId === legs[1].venueId || legs.some((leg) => !isMultiVenueExecutionVenue(leg.venueId))) {
    throw new Error('当前双腿执行仅开放 MEXC、Polymarket、Gate、Kalshi、Predict.fun 的组合；Limitless 暂为只读')
  }
  // Prefer a direct API leg as the lead where possible. Gate remains ahead of
  // Kalshi to preserve the existing Gate↔Kalshi route semantics.
  const [left, right] = legs
  return (leadPriority[left.venueId] ?? 999) <= (leadPriority[right.venueId] ?? 999)
    ? { first: left, second: right }
    : { first: right, second: left }
}

function liveReadyForVenue(venueId: string, settings: RiskSettings): boolean {
  switch (venueId) {
    case 'MEXC': return settings.mexcAutomationEnabled === true
    case 'POLYMARKET': return settings.polymarketLiveEnabled === true
    case 'GATE': return settings.gateLiveEnabled === true
    case 'KALSHI': return settings.kalshiLiveEnabled === true
    case 'PREDICT_FUN': return settings.predictFunLiveEnabled === true
    default: return false
  }
}

export class MultiVenueExecutionService {
  private readonly machine = new TwoLegExecutionMachine()
  private readonly adapters: Map<string, import('../platforms/venue-adapter').VenueAdapter>
  private executionInFlight = false

  constructor(private readonly dependencies: PairExecutionDependencies) {
    this.adapters = new Map()
    this.adapters.set('MEXC', new MexcVenueAdapter(dependencies.mexc))
    if (dependencies.polymarket) this.adapters.set('POLYMARKET', new PolymarketVenueAdapter(dependencies.polymarket))
    this.adapters.set('KALSHI', new KalshiVenueAdapter(dependencies.kalshi))
    if (dependencies.gate) this.adapters.set('GATE', new GateVenueAdapter(dependencies.gate, { liveEnabledProvider: () => dependencies.settings().gateLiveEnabled === true }))
    if (dependencies.predictFun) this.adapters.set('PREDICT_FUN', new PredictFunVenueAdapter(dependencies.predictFun, () => dependencies.settings().predictFunLiveEnabled === true))
  }

  async execute(command: MultiVenueExecutionCommand): Promise<MultiVenueExecutionReceipt> {
    if (this.executionInFlight) throw new Error('已有双腿订单正在执行，已拒绝重复提交')
    this.executionInFlight = true
    try {
      const settings = this.dependencies.settings()
      if (!this.dependencies.liveExecutionEnabled) throw new Error('当前构建未开启实盘执行门禁')
      if (settings.mode !== 'ASSISTED') throw new Error('双腿实盘目前只允许人工监督模式')
      if (!command.confirmed) throw new Error('未完成双腿真实下单二次确认')
      const comparison = this.dependencies.comparisonProvider(command.comparisonId)
      if (!comparison) throw new Error('机会已变化或不再存在，请重新选择后下单')
      if (comparison.executionProvider !== 'MULTI_VENUE' || comparison.legs.length !== 2) throw new Error('当前机会不是可执行的多平台双腿路线')
      const unprotected = settings.unprotectedExecutionEnabled === true
      const requestLegs: [MultiVenueExecutionLegRequest, MultiVenueExecutionLegRequest] = [
        { ...comparison.legs[0] },
        { ...comparison.legs[1] }
      ]
      const { first, second } = pairFor(requestLegs)
      const gateDuration = comparison.durationMinutes === 5 || comparison.durationMinutes === 15
        ? comparison.durationMinutes
        : undefined
      const hasKalshi = requestLegs.some((leg) => leg.venueId === 'KALSHI')
      const hasGate = requestLegs.some((leg) => leg.venueId === 'GATE')
      const kalshiCredentialsReady = hasKalshi ? await this.dependencies.kalshiCredentialsReady() : true
      const gateExecutionReady = !hasGate || Boolean(gateDuration && this.dependencies.gateExecutionReady(gateDuration))
      const readiness = [] as Array<{ id: string; label: string; passed: boolean; blockReason: string }>
      if (hasKalshi) readiness.push({
        id: 'kalshi-credentials',
        label: 'Kalshi 本地身份已配置',
        passed: kalshiCredentialsReady,
        blockReason: '请先配置 Kalshi API Key ID 与 RSA 私钥'
      })
      readiness.push(...requestLegs.flatMap((leg) => {
        const venueLabel = comparison.legs.find((candidate) => candidate.venueId === leg.venueId)?.venueLabel ?? leg.venueId
        const liveReady = liveReadyForVenue(leg.venueId, settings)
        const items = [{
          id: `${leg.venueId.toLowerCase()}-live`,
          label: `${venueLabel} 实盘开关已开启`,
          passed: liveReady,
          blockReason: `请先开启 ${venueLabel} 实盘下单开关`
        }]
        if (leg.venueId === 'GATE') items.push({
          id: 'gate-capture',
          label: `Gate ${gateDuration ?? comparison.durationMinutes}m 下单页面${gateExecutionReady ? '已接管' : '未接管'}`,
          passed: gateExecutionReady,
          blockReason: `Gate ${gateDuration ?? comparison.durationMinutes}m 下单页面未接管`
        })
        return items
      }))
      const gateReport = evaluateEntryGates({
        mode: 'MANUAL', quantity: command.quantity, allInCostPerShare: comparison.allInCostPerShare,
        conditionalReturnPct: comparison.conditionalReturnPct, edgeKind: comparison.edgeKind,
        matchClass: comparison.matchClass, endTime: comparison.endTime, now: Date.now(),
        maxCapitalPerTrade: settings.maxCapitalPerTrade, minConditionalReturnPct: settings.minConditionalReturnPct,
        maxQuoteAgeMs: settings.maxQuoteAgeMs, stopBeforeExpirySeconds: settings.stopBeforeExpirySeconds,
        manualConditions: unprotected
          ? {
              ...settings.manualExecutionConditions,
              conditionalReturn: false,
              feeVerification: false,
              settlementRisk: false,
              quoteFreshness: false,
              expiryCutoff: true
            }
          : settings.manualExecutionConditions,
        executionIdle: true,
        depthLimitApplicable: !unprotected,
        readiness,
        legs: requestLegs.map((leg) => ({
          ...leg,
          venueLabel: comparison.legs.find((candidate) => candidate.venueId === leg.venueId)?.venueLabel ?? leg.venueId,
          minimumQuantity: leg.venueId === 'KALSHI' ? '1' : undefined,
          minimumNotionalUsd: leg.venueId === 'GATE' ? '5' : undefined
        }))
      })
      if (!gateReport.allowed) throw new Error(gateReport.firstBlockReason ?? '当前入场条件未通过')

      const sessionId = randomUUID()
      await this.dependencies.executionSessionStore?.begin(sessionId, command.comparisonId)
      const orderedRequest: MultiVenueExecutionRequest = {
        comparisonId: command.comparisonId,
        quantity: command.quantity,
        maxCapitalPerTrade: settings.maxCapitalPerTrade,
        confirmed: command.confirmed,
        startTime: comparison.startTime,
        endTime: comparison.endTime,
        maxQuoteAgeMs: settings.maxQuoteAgeMs,
        stopBeforeExpirySeconds: settings.stopBeforeExpirySeconds,
        sessionId,
        legs: [first, second],
        firstLegIndex: 0,
        executionPolicy: unprotected ? 'PARALLEL_UNPROTECTED' : 'SEQUENTIAL_FILL_THEN_HEDGE'
      }
      const receipt = await this.machine.execute(orderedRequest, this.adapters)
      await this.dependencies.executionSessionStore?.recordReceipt(receipt)
      return receipt
    } finally {
      this.executionInFlight = false
    }
  }
}
