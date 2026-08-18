import Decimal from 'decimal.js'
import type { ExecutionPlan, OrderBookLevel } from '../../shared/types'
import { polymarketCryptoFeePerShare } from './opportunity'

interface ExecutionPlanInput {
  opportunityId: string
  quantity?: string
  mexcLevels: OrderBookLevel[]
  polymarketLevels: OrderBookLevel[]
  mexcFeeRate: string
  polymarketFeeRate: string
  polymarketFeeExponent: string
  polymarketMinOrderSize: string
  riskBufferPerShare: string
  minConditionalReturnPct: string
  maxCapital: string
  maxHedgeSlippage: string
  mexcBalance?: string
  polymarketBalance?: string
  requireBalances?: boolean
  accountDataAgeMs?: number
  balanceUsageRatio?: string
}

interface BookFill {
  quantity: Decimal
  cost: Decimal
  averagePrice: Decimal
  worstPrice: Decimal
  levelsUsed: number
  polymarketFee: Decimal
}

interface EvaluatedQuantity {
  quantity: Decimal
  mexc: BookFill
  polymarket: BookFill
  mexcFee: Decimal
  capital: Decimal
  profit: Decimal
  netEdge: Decimal
  conditionalReturn: Decimal
  affordabilityFailures: string[]
  failures: string[]
}

function normalizeLevels(levels: OrderBookLevel[]): Array<{ price: Decimal; size: Decimal }> {
  return levels
    .map((level) => ({ price: new Decimal(level.price || 0), size: new Decimal(level.size || 0) }))
    .filter((level) => level.price.gt(0) && level.size.gt(0))
    .sort((left, right) => left.price.comparedTo(right.price))
}

function fillBook(
  levels: Array<{ price: Decimal; size: Decimal }>,
  quantity: Decimal,
  feeRate?: Decimal,
  feeExponent?: Decimal
): BookFill | undefined {
  let remaining = quantity
  let cost = new Decimal(0)
  let worstPrice = new Decimal(0)
  let levelsUsed = 0
  let polymarketFee = new Decimal(0)
  for (const level of levels) {
    if (remaining.lte(0)) break
    const taken = Decimal.min(remaining, level.size)
    if (taken.lte(0)) continue
    cost = cost.add(taken.mul(level.price))
    if (feeRate && feeExponent) {
      polymarketFee = polymarketFee.add(taken.mul(polymarketCryptoFeePerShare(level.price, feeRate, feeExponent)))
    }
    remaining = remaining.minus(taken)
    worstPrice = level.price
    levelsUsed += 1
  }
  if (remaining.gt('0.0000001') || quantity.lte(0)) return undefined
  return {
    quantity,
    cost,
    averagePrice: cost.div(quantity),
    worstPrice,
    levelsUsed,
    polymarketFee
  }
}

export function calculateDepthExecutionPlan(input: ExecutionPlanInput): ExecutionPlan {
  const mexcLevels = normalizeLevels(input.mexcLevels)
  const allPolymarketLevels = normalizeLevels(input.polymarketLevels)
  const mexcBest = mexcLevels[0]?.price ?? new Decimal(0)
  const polymarketBest = allPolymarketLevels[0]?.price ?? new Decimal(0)
  const maximumPolymarketPrice = Decimal.min(
    new Decimal('0.99'),
    polymarketBest.add(input.maxHedgeSlippage || 0)
  )
  const polymarketLevels = allPolymarketLevels.filter((level) => level.price.lte(maximumPolymarketPrice))
  const mexcDepth = Decimal.sum(0, ...mexcLevels.map((level) => level.size))
  const polymarketDepth = Decimal.sum(0, ...polymarketLevels.map((level) => level.size))
  const marketDepth = Decimal.min(mexcDepth, polymarketDepth)
  const bestLevelQuantity = Decimal.min(mexcLevels[0]?.size ?? 0, polymarketLevels[0]?.size ?? 0)
  const minimumQuantity = mexcBest.gt(0) && maximumPolymarketPrice.gt(0)
    ? Decimal.max(
      new Decimal(input.polymarketMinOrderSize || 1),
      new Decimal(1).div(mexcBest),
      new Decimal(1).div(maximumPolymarketPrice)
    ).toDecimalPlaces(2, Decimal.ROUND_CEIL)
    : new Decimal(Infinity)
  const mexcFeeRate = new Decimal(input.mexcFeeRate || 0)
  const polymarketFeeRate = new Decimal(input.polymarketFeeRate || 0)
  const polymarketFeeExponent = new Decimal(input.polymarketFeeExponent || 1)
  const riskBuffer = new Decimal(input.riskBufferPerShare || 0)
  const maxCapital = new Decimal(input.maxCapital || 0)
  const minReturn = new Decimal(input.minConditionalReturnPct || 0)
  const mexcBalance = input.mexcBalance === undefined ? undefined : new Decimal(input.mexcBalance || 0)
  const polymarketBalance = input.polymarketBalance === undefined ? undefined : new Decimal(input.polymarketBalance || 0)
  const balanceUsageRatio = Decimal.min(1, Decimal.max(0, new Decimal(input.balanceUsageRatio ?? '0.99')))
  const usableMexcBalance = mexcBalance?.mul(balanceUsageRatio)
  const usablePolymarketBalance = polymarketBalance?.mul(balanceUsageRatio)

  const evaluate = (quantity: Decimal): EvaluatedQuantity | undefined => {
    const mexc = fillBook(mexcLevels, quantity)
    const polymarket = fillBook(polymarketLevels, quantity, polymarketFeeRate, polymarketFeeExponent)
    if (!mexc || !polymarket) return undefined
    const mexcFee = mexc.cost.mul(mexcFeeRate)
    const capital = mexc.cost.add(mexcFee).add(polymarket.cost).add(polymarket.polymarketFee).add(riskBuffer.mul(quantity))
    const profit = quantity.minus(capital)
    const netEdge = profit.div(quantity)
    const conditionalReturn = capital.gt(0) ? profit.div(capital).mul(100) : new Decimal(0)
    const affordabilityFailures: string[] = []
    const thresholdFailures: string[] = []
    if (capital.gt(maxCapital)) affordabilityFailures.push('单笔本金上限')
    if (input.requireBalances && usableMexcBalance === undefined) affordabilityFailures.push('MEXC余额待刷新')
    if (input.requireBalances && usablePolymarketBalance === undefined) affordabilityFailures.push('Polymarket余额待刷新')
    if (usableMexcBalance !== undefined && mexc.cost.add(mexcFee).gt(usableMexcBalance)) affordabilityFailures.push('MEXC可用余额')
    if (usablePolymarketBalance !== undefined && polymarket.cost.add(polymarket.polymarketFee).gt(usablePolymarketBalance)) affordabilityFailures.push('Polymarket可用余额')
    if (conditionalReturn.lt(minReturn)) thresholdFailures.push('最低条件收益率')
    return {
      quantity, mexc, polymarket, mexcFee, capital, profit, netEdge, conditionalReturn,
      affordabilityFailures,
      failures: [...thresholdFailures, ...affordabilityFailures]
    }
  }

  const maximumCents = marketDepth.isFinite() && marketDepth.gt(0)
    ? Math.max(0, Math.floor(marketDepth.mul(100).toNumber()))
    : 0
  const findMaximum = (isAllowed: (evaluated: EvaluatedQuantity) => boolean): Decimal => {
    let low = 0
    let high = maximumCents
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      const evaluated = evaluate(new Decimal(middle).div(100))
      if (evaluated && isAllowed(evaluated)) low = middle
      else high = middle - 1
    }
    return new Decimal(low).div(100)
  }
  const maximumAffordableQuantity = findMaximum((evaluated) => evaluated.affordabilityFailures.length === 0)
  const maximumQuantity = findMaximum((evaluated) => evaluated.failures.length === 0)
  const requested = input.quantity !== undefined
    ? new Decimal(input.quantity || 0).toDecimalPlaces(2, Decimal.ROUND_FLOOR)
    : maximumQuantity
  const evaluated = evaluate(requested)
  const maximumEvaluated = maximumQuantity.gt(0) ? evaluate(maximumQuantity) : undefined
  const nextEvaluated = maximumQuantity.lt(marketDepth)
    ? evaluate(maximumQuantity.add('0.01'))
    : undefined
  const nextAffordableEvaluated = maximumAffordableQuantity.lt(marketDepth)
    ? evaluate(maximumAffordableQuantity.add('0.01'))
    : undefined
  const affordableLimitingFactors = nextAffordableEvaluated?.affordabilityFailures.length
    ? [...new Set(nextAffordableEvaluated.affordabilityFailures)]
    : maximumAffordableQuantity.gte(marketDepth) && marketDepth.gt(0) ? ['盘口深度'] : []
  const limitingFactors = nextEvaluated?.failures.length
    ? [...new Set(nextEvaluated.failures)]
    : maximumQuantity.gte(marketDepth) && marketDepth.gt(0) ? ['盘口深度'] : []
  const failures = evaluated?.failures ? [...evaluated.failures] : ['盘口深度不足']
  if (evaluated && requested.lt(minimumQuantity)) failures.unshift(`低于最小对齐份额${minimumQuantity.toFixed(2)}份`)
  const values = evaluated ?? maximumEvaluated

  return {
    opportunityId: input.opportunityId,
    requestedQuantity: requested.isFinite() ? requested.toFixed(2) : '0.00',
    minimumQuantity: minimumQuantity.isFinite() ? minimumQuantity.toFixed(2) : '0.00',
    maxAffordableQuantity: maximumAffordableQuantity.toFixed(2),
    maxExecutableQuantity: maximumQuantity.toFixed(2),
    bestLevelQuantity: bestLevelQuantity.toFixed(2),
    marketDepthQuantity: marketDepth.toFixed(2),
    mexcAveragePrice: values?.mexc.averagePrice.toFixed(6) ?? '0',
    polymarketAveragePrice: values?.polymarket.averagePrice.toFixed(6) ?? '0',
    polymarketMaximumPrice: values?.polymarket.worstPrice.toFixed(4) ?? maximumPolymarketPrice.toFixed(4),
    mexcSpend: values?.mexc.cost.toFixed(2, Decimal.ROUND_UP) ?? '0.00',
    polymarketSpend: values?.polymarket.cost.toFixed(2, Decimal.ROUND_UP) ?? '0.00',
    mexcFee: values?.mexcFee.toFixed(6) ?? '0',
    polymarketFee: values?.polymarket.polymarketFee.toFixed(6) ?? '0',
    capitalRequired: values?.capital.toFixed(2, Decimal.ROUND_UP) ?? '0.00',
    expectedProfit: values?.profit.toFixed(2) ?? '0.00',
    netEdgePerShare: values?.netEdge.toFixed(6) ?? '0',
    conditionalReturnPct: values?.conditionalReturn.toFixed(2) ?? '0.00',
    mexcLevelsUsed: values?.mexc.levelsUsed ?? 0,
    polymarketLevelsUsed: values?.polymarket.levelsUsed ?? 0,
    affordableLimitingFactors,
    limitingFactors,
    accountBalanceReservePct: new Decimal(1).minus(balanceUsageRatio).mul(100).toFixed(2),
    executable: Boolean(evaluated && failures.length === 0 && requested.gt(0)),
    blockReason: failures.length > 0 ? failures.join('、') : undefined,
    accountDataAgeMs: input.accountDataAgeMs
  }
}
