import { randomUUID } from 'node:crypto'
import Decimal from 'decimal.js'
import type { RiskSettings } from '../../shared/types'
import type {
  MultiVenueExecutionLegRequest,
  MultiVenueExecutionReceipt,
  MultiVenueExecutionRequest
} from '../../shared/multi-venue'
import type { MexcBrowserManager } from './mexc-browser'
import type { PolymarketLiveBroker } from './polymarket-live'
import type { KalshiTradingService } from './kalshi-trading'
import { MexcVenueAdapter } from '../platforms/adapters/mexc-adapter'
import { PolymarketVenueAdapter } from '../platforms/adapters/polymarket-adapter'
import { KalshiVenueAdapter } from '../platforms/adapters/kalshi-adapter'
import { TwoLegExecutionMachine } from '../domain/two-leg-execution'
import type { ExecutionSessionStore } from './execution-session-store'

const MAX_QUOTE_AGE_MS = 8_000

interface PairExecutionDependencies {
  mexc: MexcBrowserManager
  polymarket?: PolymarketLiveBroker
  kalshi: KalshiTradingService
  settings: () => RiskSettings
  liveExecutionEnabled: boolean
  executionSessionStore?: ExecutionSessionStore
}

function pairFor(legs: MultiVenueExecutionLegRequest[]): { first: MultiVenueExecutionLegRequest; second: MultiVenueExecutionLegRequest } {
  const kalshi = legs.find((leg) => leg.venueId === 'KALSHI')
  const other = legs.find((leg) => leg.venueId !== 'KALSHI')
  if (!kalshi || !other || (other.venueId !== 'MEXC' && other.venueId !== 'POLYMARKET')) {
    throw new Error('当前仅支持 MEXC↔Kalshi 或 Polymarket↔Kalshi 双腿执行')
  }
  // Keep the mature route ordering: MEXC's web order is the lead leg and
  // Polymarket's FAK is the lead leg for the direct-API route. Kalshi is always
  // submitted only after the first leg has an actual fill.
  return { first: other, second: kalshi }
}

export class MultiVenueExecutionService {
  private readonly machine = new TwoLegExecutionMachine()
  private readonly adapters: Map<string, import('../platforms/venue-adapter').VenueAdapter>

  constructor(private readonly dependencies: PairExecutionDependencies) {
    this.adapters = new Map()
    this.adapters.set('MEXC', new MexcVenueAdapter(dependencies.mexc))
    if (dependencies.polymarket) this.adapters.set('POLYMARKET', new PolymarketVenueAdapter(dependencies.polymarket))
    this.adapters.set('KALSHI', new KalshiVenueAdapter(dependencies.kalshi))
  }

  async execute(request: MultiVenueExecutionRequest): Promise<MultiVenueExecutionReceipt> {
    const settings = this.dependencies.settings()
    if (!this.dependencies.liveExecutionEnabled) throw new Error('当前构建未开启实盘执行门禁')
    if (!settings.kalshiLiveEnabled) throw new Error('请先开启 Kalshi 人工实盘下单开关')
    if (settings.mode !== 'ASSISTED') throw new Error('双腿实盘目前只允许人工监督模式')
    if (!request.confirmed) throw new Error('未完成双腿真实下单二次确认')
    if (!Array.isArray(request.legs) || request.legs.length !== 2) throw new Error('双腿执行必须提供两个平台腿')
    const { first, second } = pairFor(request.legs)
    const quantity = new Decimal(request.quantity)
    if (!quantity.isFinite() || quantity.lt(1)) throw new Error('双腿执行数量必须至少为 1 份')
    if (quantity.gt(new Decimal(first.availableQuantity)) || quantity.gt(new Decimal(second.availableQuantity))) {
      throw new Error('双腿执行数量超过当前任一平台盘口深度')
    }
    if (request.endTime - Date.now() < 20_000) throw new Error('市场距离结算不足 20 秒，已拒绝双腿下单')
    for (const leg of request.legs) {
      if (!Number.isFinite(leg.quoteAgeMs) || leg.quoteAgeMs > MAX_QUOTE_AGE_MS) throw new Error(`${leg.venueId} 行情已过期，已拒绝双腿下单`)
      if (!leg.marketId || (leg.venueId !== 'KALSHI' && !leg.outcomeId)) throw new Error(`${leg.venueId} 缺少市场或结果 ID`)
    }
    const totalCapital = quantity.mul(first.price).add(quantity.mul(second.price))
    if (totalCapital.gt(new Decimal(settings.maxCapitalPerTrade))) throw new Error(`双腿预计本金 ${totalCapital.toFixed(2)} 超过单笔上限 ${settings.maxCapitalPerTrade}`)
    if (first.venueId === 'MEXC' && !settings.mexcAutomationEnabled) throw new Error('MEXC↔Kalshi 双腿执行需要先开启 MEXC 自动提交')
    if (first.venueId === 'POLYMARKET' && !settings.polymarketLiveEnabled) throw new Error('Polymarket↔Kalshi 双腿执行需要先开启 Polymarket 实盘对冲')

    const sessionId = randomUUID()
    await this.dependencies.executionSessionStore?.begin(sessionId, request.comparisonId)
    const orderedRequest: MultiVenueExecutionRequest = {
      ...request,
      sessionId,
      legs: [first, second],
      firstLegIndex: 0,
      executionPolicy: 'SEQUENTIAL_FILL_THEN_HEDGE'
    }
    const receipt = await this.machine.execute(orderedRequest, this.adapters)
    await this.dependencies.executionSessionStore?.recordReceipt(receipt)
    return receipt
  }
}
