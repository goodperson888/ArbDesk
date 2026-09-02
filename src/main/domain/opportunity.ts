import Decimal from 'decimal.js'
import { defaultSettlementDistanceRules } from '../../shared/defaults'
import type { Direction, MarketDuration, MatchClass, Opportunity, SettlementDistanceRule } from '../../shared/types'
import { settlementDistanceBpsAt } from './settlement-distance'

export interface OpportunityInput {
  id: string
  mexcEventId?: string
  mexcSymbolId?: string
  durationMinutes: MarketDuration
  startTime: number
  endTime: number
  mexcDirection: Direction
  mexcPrice: string
  mexcFeeRate?: string
  mexcFeeRateSource?: 'HISTORY' | 'UNAVAILABLE'
  polymarketPrice: string
  polymarketTokenId?: string
  polymarketMinOrderSize?: string
  polymarketFeeRate?: string
  polymarketFeeExponent?: string
  maxQuantity: string
  mexcAvailableQuantity?: string
  polymarketAvailableQuantity?: string
  riskBufferPerShare: string
  matchClass?: MatchClass
  quoteAgeMs?: number
  mexcQuoteAgeMs?: number
  polymarketQuoteAgeMs?: number
  maxQuoteAgeMs?: number
  mexcSignal?: Direction
  polymarketSignal?: Direction
  mexcDistanceBps?: string
  polymarketDistanceBps?: string
  settlementDistanceRules?: SettlementDistanceRule[]
  settlementSignalMissingReason?: string
  evaluationTime?: number
}

export function opposite(direction: Direction): Direction {
  return direction === 'UP' ? 'DOWN' : 'UP'
}

export function polymarketCryptoFeePerShare(
  price: Decimal.Value,
  feeRate: Decimal.Value = '0.07',
  feeExponent: Decimal.Value = '1'
): Decimal {
  const p = new Decimal(price)
  return p.mul(new Decimal(1).minus(p)).pow(feeExponent).mul(feeRate)
}

export function calculateOpportunity(input: OpportunityInput): Opportunity {
  const mexcPrice = new Decimal(input.mexcPrice)
  const polymarketPrice = new Decimal(input.polymarketPrice)
  const mexcFeeRate = new Decimal(input.mexcFeeRate ?? '0')
  const mexcFeeRateSource = input.mexcFeeRateSource ?? 'UNAVAILABLE'
  const polymarketFeeRate = new Decimal(input.polymarketFeeRate ?? '0.07')
  const polymarketFeeExponent = new Decimal(input.polymarketFeeExponent ?? '1')
  const mexcFee = mexcPrice.mul(mexcFeeRate)
  const fee = polymarketCryptoFeePerShare(polymarketPrice, polymarketFeeRate, polymarketFeeExponent)
  const polymarketEffectiveFeeRate = polymarketPrice.gt(0) ? fee.div(polymarketPrice) : new Decimal(0)
  const buffer = new Decimal(input.riskBufferPerShare)
  const grossCost = mexcPrice.add(polymarketPrice)
  const cashCost = grossCost.add(mexcFee).add(fee)
  const allInCost = cashCost.add(buffer)
  const grossEdge = new Decimal(1).minus(grossCost)
  const netEdge = new Decimal(1).minus(allInCost)
  const quantity = new Decimal(input.maxQuantity)
  const mexcAvailableQuantity = new Decimal(input.mexcAvailableQuantity ?? input.maxQuantity)
  const polymarketAvailableQuantity = new Decimal(input.polymarketAvailableQuantity ?? input.maxQuantity)
  const capital = allInCost.mul(quantity)
  const expectedProfit = netEdge.mul(quantity)
  const bothLosePnl = cashCost.negated()
  const bothWinPnl = new Decimal(2).minus(cashCost)
  const conditionalReturnPct = allInCost.gt(0) ? netEdge.div(allInCost).mul(100) : new Decimal(0)
  const worstCaseReturnPct = allInCost.gt(0) ? bothLosePnl.div(allInCost).mul(100) : new Decimal(0)
  const stale = (input.quoteAgeMs ?? 0) > (input.maxQuoteAgeMs ?? 1500)
  const matchClass = input.matchClass ?? 'CONDITIONAL'
  const riskFlags: string[] = []
  const feeVerificationBlocked = mexcFeeRateSource !== 'HISTORY'
  const feeVerificationReason = feeVerificationBlocked
    ? 'MEXC最近7天没有可验证的买入费用流水，手续费与净收益暂不可确认'
    : undefined
  const minimumDistance = settlementDistanceBpsAt(
    input.settlementDistanceRules ?? defaultSettlementDistanceRules(),
    input.endTime,
    input.evaluationTime
  )
  const mexcDistance = new Decimal(input.mexcDistanceBps ?? '0')
  const polymarketDistance = new Decimal(input.polymarketDistanceBps ?? '0')
  const settlementDistance = Decimal.min(mexcDistance.abs(), polymarketDistance.abs())
  const signalsAvailable = Boolean(input.mexcSignal && input.polymarketSignal)
  const signalsDisagree = signalsAvailable && input.mexcSignal !== input.polymarketSignal
  const tooCloseToBaseline = signalsAvailable && (mexcDistance.abs().lt(minimumDistance) || polymarketDistance.abs().lt(minimumDistance))
  const polymarketDirection = opposite(input.mexcDirection)
  const settlementScenario = !signalsAvailable
    ? 'UNKNOWN'
    : !signalsDisagree
      ? 'SINGLE_WIN'
      : input.mexcSignal === input.mexcDirection && input.polymarketSignal === polymarketDirection
        ? 'DOUBLE_WIN'
        : 'DOUBLE_LOSS'
  const doubleWinEntryEligible = settlementScenario === 'DOUBLE_WIN' && !tooCloseToBaseline
  const settlementRiskBlocked = !signalsAvailable || settlementScenario !== 'SINGLE_WIN' || tooCloseToBaseline
  const settlementRiskReason = !signalsAvailable
      ? `结算信号不完整：${input.settlementSignalMissingReason ?? '缺少平台基准价、实时指数价或有效更新时间'}`
    : tooCloseToBaseline
        ? `距离基准价不足动态门槛 ${minimumDistance.toFixed(2)} bps（当前较近一侧 ${settlementDistance.toFixed(2)} bps）`
      : settlementScenario === 'DOUBLE_WIN'
        ? `结算信号分歧：所选的一涨一跌组合当前位于双赢区间（仅按当前参考价推断，非最终结算保证）；需用户明确确认后才可执行`
      : settlementScenario === 'DOUBLE_LOSS'
        ? `结算信号分歧：当前方向存在双输风险：MEXC ${input.mexcSignal} / Polymarket ${input.polymarketSignal}`
        : undefined

  if (matchClass !== 'EXACT') riskFlags.push('两个平台结算源不同，不属于保证锁利')
  if (feeVerificationReason) riskFlags.unshift(feeVerificationReason)
  if (settlementRiskReason) riskFlags.unshift(settlementRiskReason)
  if (stale) riskFlags.push('行情已过期')
  if (netEdge.lte(0)) riskFlags.push('计入费用和缓冲后无正收益')
  if (input.durationMinutes === 30) riskFlags.push('30分钟市场连接器尚未启用')

  return {
    id: input.id,
    mexcEventId: input.mexcEventId ?? '',
    mexcSymbolId: input.mexcSymbolId ?? '',
    symbol: 'BTC/USD',
    durationMinutes: input.durationMinutes,
    startTime: input.startTime,
    endTime: input.endTime,
    mexcDirection: input.mexcDirection,
    polymarketDirection,
    polymarketTokenId: input.polymarketTokenId,
    polymarketMinOrderSize: new Decimal(input.polymarketMinOrderSize ?? '1').toString(),
    mexcPrice: mexcPrice.toFixed(4),
    polymarketPrice: polymarketPrice.toFixed(4),
    mexcFeeRate: mexcFeeRate.toFixed(6),
    mexcFeeRateSource,
    polymarketFeeRate: polymarketFeeRate.toFixed(6),
    polymarketFeeExponent: polymarketFeeExponent.toFixed(6),
    polymarketEffectiveFeeRate: polymarketEffectiveFeeRate.toFixed(6),
    mexcFeePerShare: mexcFee.toFixed(6),
    polymarketFeePerShare: fee.toFixed(6),
    riskBufferPerShare: buffer.toFixed(4),
    allInCostPerShare: allInCost.toFixed(6),
    grossEdgePerShare: grossEdge.toFixed(6),
    netEdgePerShare: netEdge.toFixed(6),
    mexcAvailableQuantity: mexcAvailableQuantity.toFixed(2),
    polymarketAvailableQuantity: polymarketAvailableQuantity.toFixed(2),
    maxQuantity: quantity.toFixed(2),
    mexcQuoteAgeMs: Math.max(0, input.mexcQuoteAgeMs ?? input.quoteAgeMs ?? 0),
    polymarketQuoteAgeMs: Math.max(0, input.polymarketQuoteAgeMs ?? input.quoteAgeMs ?? 0),
    capitalRequired: capital.toFixed(2),
    expectedProfit: expectedProfit.toFixed(2),
    conditionalReturnPct: conditionalReturnPct.toFixed(2),
    worstCaseReturnPct: worstCaseReturnPct.toFixed(2),
    bothLosePnlPerShare: bothLosePnl.toFixed(6),
    bothWinPnlPerShare: bothWinPnl.toFixed(6),
    feeVerificationBlocked,
    feeVerificationReason,
    settlementRiskBlocked,
    settlementRiskReason,
    mexcSignal: input.mexcSignal,
    polymarketSignal: input.polymarketSignal,
    mexcDistanceBps: input.mexcDistanceBps,
    polymarketDistanceBps: input.polymarketDistanceBps,
    settlementDistanceBps: signalsAvailable ? settlementDistance.toFixed(4) : '',
    requiredSettlementDistanceBps: minimumDistance.toFixed(4),
    settlementScenario,
    doubleWinEntryEligible,
    matchClass,
    stale,
    riskFlags
  }
}
