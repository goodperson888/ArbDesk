import Decimal from 'decimal.js'
import type { Direction, MarketDuration, MatchClass, Opportunity } from '../../shared/types'

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
  mexcFeeRateSource?: 'HISTORY' | 'CONSERVATIVE_FALLBACK'
  polymarketPrice: string
  polymarketTokenId?: string
  polymarketMinOrderSize?: string
  polymarketFeeRate?: string
  maxQuantity: string
  riskBufferPerShare: string
  matchClass?: MatchClass
  quoteAgeMs?: number
  maxQuoteAgeMs?: number
  mexcSignal?: Direction
  polymarketSignal?: Direction
  mexcDistanceBps?: string
  polymarketDistanceBps?: string
  minimumSettlementDistanceBps?: string
  settlementSignalMissingReason?: string
}

export function opposite(direction: Direction): Direction {
  return direction === 'UP' ? 'DOWN' : 'UP'
}

export function polymarketCryptoFeePerShare(price: Decimal.Value, feeRate: Decimal.Value = '0.07'): Decimal {
  const p = new Decimal(price)
  return p.mul(feeRate).mul(new Decimal(1).minus(p))
}

export function calculateOpportunity(input: OpportunityInput): Opportunity {
  const mexcPrice = new Decimal(input.mexcPrice)
  const polymarketPrice = new Decimal(input.polymarketPrice)
  const mexcFee = mexcPrice.mul(input.mexcFeeRate ?? '0.015')
  const fee = polymarketCryptoFeePerShare(polymarketPrice, input.polymarketFeeRate ?? '0.07')
  const buffer = new Decimal(input.riskBufferPerShare)
  const grossCost = mexcPrice.add(polymarketPrice)
  const cashCost = grossCost.add(mexcFee).add(fee)
  const allInCost = cashCost.add(buffer)
  const grossEdge = new Decimal(1).minus(grossCost)
  const netEdge = new Decimal(1).minus(allInCost)
  const quantity = new Decimal(input.maxQuantity)
  const capital = allInCost.mul(quantity)
  const expectedProfit = netEdge.mul(quantity)
  const bothLosePnl = cashCost.negated()
  const bothWinPnl = new Decimal(2).minus(cashCost)
  const stale = (input.quoteAgeMs ?? 0) > (input.maxQuoteAgeMs ?? 1500)
  const matchClass = input.matchClass ?? 'CONDITIONAL'
  const riskFlags: string[] = []
  const minimumDistance = new Decimal(input.minimumSettlementDistanceBps ?? '2')
  const mexcDistance = new Decimal(input.mexcDistanceBps ?? '0')
  const polymarketDistance = new Decimal(input.polymarketDistanceBps ?? '0')
  const signalsAvailable = Boolean(input.mexcSignal && input.polymarketSignal)
  const signalsDisagree = signalsAvailable && input.mexcSignal !== input.polymarketSignal
  const tooCloseToBaseline = signalsAvailable && (mexcDistance.abs().lt(minimumDistance) || polymarketDistance.abs().lt(minimumDistance))
  const settlementRiskBlocked = !signalsAvailable || signalsDisagree || tooCloseToBaseline
  const settlementRiskReason = !signalsAvailable
    ? `结算信号不完整：${input.settlementSignalMissingReason ?? '缺少平台基准价、实时指数价或有效更新时间'}`
    : signalsDisagree
      ? `结算信号分歧（不是对冲腿方向）：MEXC ${input.mexcSignal} / Polymarket ${input.polymarketSignal}`
      : tooCloseToBaseline
        ? `距离基准价不足 ${minimumDistance.toString()} bps`
        : undefined

  if (matchClass !== 'EXACT') riskFlags.push('两个平台结算源不同，不属于保证锁利')
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
    polymarketDirection: opposite(input.mexcDirection),
    polymarketTokenId: input.polymarketTokenId,
    polymarketMinOrderSize: new Decimal(input.polymarketMinOrderSize ?? '1').toString(),
    mexcPrice: mexcPrice.toFixed(4),
    polymarketPrice: polymarketPrice.toFixed(4),
    mexcFeeRate: new Decimal(input.mexcFeeRate ?? '0.015').toFixed(6),
    mexcFeeRateSource: input.mexcFeeRateSource ?? 'CONSERVATIVE_FALLBACK',
    polymarketFeeRate: new Decimal(input.polymarketFeeRate ?? '0.07').toFixed(6),
    mexcFeePerShare: mexcFee.toFixed(6),
    polymarketFeePerShare: fee.toFixed(6),
    riskBufferPerShare: buffer.toFixed(4),
    allInCostPerShare: allInCost.toFixed(6),
    grossEdgePerShare: grossEdge.toFixed(6),
    netEdgePerShare: netEdge.toFixed(6),
    maxQuantity: quantity.toFixed(2),
    capitalRequired: capital.toFixed(2),
    expectedProfit: expectedProfit.toFixed(2),
    bothLosePnlPerShare: bothLosePnl.toFixed(6),
    bothWinPnlPerShare: bothWinPnl.toFixed(6),
    settlementRiskBlocked,
    settlementRiskReason,
    mexcSignal: input.mexcSignal,
    polymarketSignal: input.polymarketSignal,
    mexcDistanceBps: input.mexcDistanceBps,
    polymarketDistanceBps: input.polymarketDistanceBps,
    matchClass,
    stale,
    riskFlags
  }
}
