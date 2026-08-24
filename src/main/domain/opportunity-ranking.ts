import Decimal from 'decimal.js'

interface OpportunityProfitInput {
  netEdgePerShare: string
  allInCostPerShare: string
  availableQuantity: string
  maxCapital: string
  quantityMode: 'FIXED' | 'MAX_PERCENT'
  fixedQuantity: string
  maximumQuantityPct: number
}

export function calculateExecutableOpportunityProfit(input: OpportunityProfitInput): Decimal {
  const edge = new Decimal(input.netEdgePerShare || 0)
  const cost = new Decimal(input.allInCostPerShare || 0)
  const available = Decimal.max(0, new Decimal(input.availableQuantity || 0))
  if (cost.lte(0) || edge.lte(0) || available.lte(0)) return new Decimal(0)

  const capitalQuantity = new Decimal(input.maxCapital || 0)
    .div(cost)
    .toDecimalPlaces(2, Decimal.ROUND_FLOOR)
  const maximumExecutable = Decimal.max(0, Decimal.min(available, capitalQuantity))
  const quantity = input.quantityMode === 'FIXED'
    ? Decimal.min(maximumExecutable, Decimal.max(0, new Decimal(input.fixedQuantity || 0)))
    : maximumExecutable
      .mul(input.maximumQuantityPct)
      .div(100)
      .toDecimalPlaces(2, Decimal.ROUND_FLOOR)
  return edge.mul(quantity)
}
