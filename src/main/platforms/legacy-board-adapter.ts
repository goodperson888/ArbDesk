import Decimal from 'decimal.js'
import type { MultiVenueBoardSnapshot, MultiVenueComparison, VenueConnectionState, VenueCycleHealth } from '../../shared/multi-venue'
import type { Opportunity, RiskSettings } from '../../shared/types'
import { calculateExecutableOpportunityProfit } from '../domain/opportunity-ranking'
import { getVenueDescriptor, listRegisteredVenues } from './registry'
import type { ReadOnlyWindowQuote } from './read-only-types'

interface LegacyBoardInput {
  generatedAt: number
  opportunities: Opportunity[]
  settings: RiskSettings
  connections: Record<'MEXC' | 'POLYMARKET', VenueConnectionState>
  additionalConnections?: Record<string, VenueConnectionState>
  monitoringEnabled?: Record<string, boolean>
  statusMessages?: Record<string, string>
  windows?: ReadOnlyWindowQuote[]
  additionalComparisons?: MultiVenueComparison[]
}

function cycleHealth(
  venueId: string,
  durationMinutes: 5 | 15,
  connectionState: VenueConnectionState,
  windows: ReadOnlyWindowQuote[],
  now: number,
  maximumAgeMs: number
): VenueCycleHealth {
  if (connectionState !== 'CONNECTED') return { durationMinutes, state: 'OFFLINE', marketCount: 0 }
  const candidates = windows.filter((window) => window.venueId === venueId && window.durationMinutes === durationMinutes)
  if (candidates.length === 0) return { durationMinutes, state: 'NO_MARKET', marketCount: 0 }
  const receivedAt = candidates.flatMap((window) => Object.values(window.outcomes).map((quote) => quote?.receivedAt ?? 0))
  const latestQuoteAt = Math.max(0, ...receivedAt) || undefined
  const hasPrices = candidates.some((window) => ['UP', 'DOWN'].every((direction) => Number(window.outcomes[direction as 'UP' | 'DOWN']?.bestAsk) > 0))
  const hasDepth = candidates.some((window) => ['UP', 'DOWN'].every((direction) => Number(window.outcomes[direction as 'UP' | 'DOWN']?.askSize) > 0))
  const stale = !latestQuoteAt || now - latestQuoteAt > maximumAgeMs
  return {
    durationMinutes,
    state: stale ? 'STALE' : hasDepth ? 'DEPTH_READY' : hasPrices ? 'PRICE_ONLY' : 'NO_MARKET',
    marketCount: candidates.length,
    latestQuoteAt
  }
}

function minimumQuantity(opportunity: Opportunity, maxHedgeSlippage: string): Decimal {
  const polymarketMaximumPrice = Decimal.min(
    new Decimal('0.99'),
    new Decimal(opportunity.polymarketPrice || 0).plus(maxHedgeSlippage || 0)
  )
  const mexcPrice = new Decimal(opportunity.mexcPrice || 0)
  if (mexcPrice.lte(0) || polymarketMaximumPrice.lte(0)) return new Decimal(Infinity)
  return Decimal.max(
    new Decimal(opportunity.polymarketMinOrderSize || 0),
    new Decimal(1).div(mexcPrice),
    new Decimal(1).div(polymarketMaximumPrice)
  ).toDecimalPlaces(2, Decimal.ROUND_CEIL)
}

function buildComparison(opportunity: Opportunity, settings: RiskSettings, now: number): MultiVenueComparison {
  const minimum = minimumQuantity(opportunity, settings.maxHedgeSlippage)
  const maximum = new Decimal(opportunity.maxQuantity || 0)
  const cost = new Decimal(opportunity.allInCostPerShare || 0)
  const capitalQuantity = cost.gt(0)
    ? new Decimal(settings.maxCapitalPerTrade || 0).div(cost).toDecimalPlaces(2, Decimal.ROUND_FLOOR)
    : new Decimal(0)
  const executableQuantity = Decimal.max(0, Decimal.min(maximum, capitalQuantity))
  const potentialProfit = new Decimal(opportunity.netEdgePerShare || 0).mul(executableQuantity)
  const autoOrderPotentialProfit = calculateExecutableOpportunityProfit({
    netEdgePerShare: opportunity.netEdgePerShare,
    allInCostPerShare: opportunity.allInCostPerShare,
    availableQuantity: opportunity.maxQuantity,
    maxCapital: settings.maxCapitalPerTrade,
    quantityMode: settings.autoOpenQuantityMode,
    fixedQuantity: settings.autoOpenFixedQuantity,
    maximumQuantityPct: settings.autoOpenMaxQuantityPct
  })
  const conditions = settings.manualExecutionConditions
  const blockReasons: string[] = []

  if (conditions.quoteFreshness && opportunity.stale) blockReasons.push('行情已过期')
  if (conditions.feeVerification && opportunity.feeVerificationBlocked) {
    blockReasons.push(opportunity.feeVerificationReason ?? '手续费待校验')
  }
  if (conditions.settlementRisk && opportunity.settlementRiskBlocked) {
    blockReasons.push(opportunity.settlementRiskReason ?? '结算规则风控未通过')
  }
  if (conditions.conditionalReturn && Number(opportunity.conditionalReturnPct) < Number(settings.minConditionalReturnPct)) {
    blockReasons.push('条件收益率低于设置门槛')
  }
  if (!minimum.isFinite() || maximum.lt(minimum)) blockReasons.push('盘口不足以满足最小对齐份额')
  if (minimum.isFinite() && cost.mul(minimum).gt(settings.maxCapitalPerTrade || 0)) blockReasons.push('单笔资金上限不足')
  if (conditions.expiryCutoff && (opportunity.endTime - now) / 1_000 <= settings.stopBeforeExpirySeconds) {
    blockReasons.push('已进入停止开仓时间')
  }

  const status = conditions.quoteFreshness && opportunity.stale
    ? 'STALE'
    : blockReasons.length > 0
      ? 'BLOCKED'
      : potentialProfit.gt(0)
        ? 'EXECUTABLE'
        : 'NO_EDGE'
  const mexcVenue = getVenueDescriptor('MEXC')
  const polymarketVenue = getVenueDescriptor('POLYMARKET')

  return {
    id: `legacy:${opportunity.id}`,
    legacyOpportunityId: opportunity.id,
    asset: opportunity.symbol,
    durationMinutes: opportunity.durationMinutes,
    startTime: opportunity.startTime,
    endTime: opportunity.endTime,
    strategy: 'COMPLEMENTARY_OUTCOMES',
    matchClass: opportunity.matchClass,
    status,
    executionProvider: 'LEGACY_MEXC_POLY',
    edgeKind: 'NET_VERIFIED',
    legs: [
      {
        venueId: mexcVenue.id,
        venueLabel: mexcVenue.label,
        direction: opportunity.mexcDirection,
        price: opportunity.mexcPrice,
        availableQuantity: opportunity.mexcAvailableQuantity,
        quoteAgeMs: opportunity.mexcQuoteAgeMs
      },
      {
        venueId: polymarketVenue.id,
        venueLabel: polymarketVenue.label,
        direction: opportunity.polymarketDirection,
        price: opportunity.polymarketPrice,
        availableQuantity: opportunity.polymarketAvailableQuantity,
        quoteAgeMs: opportunity.polymarketQuoteAgeMs
      }
    ],
    allInCostPerShare: opportunity.allInCostPerShare,
    netEdgePerShare: opportunity.netEdgePerShare,
    conditionalReturnPct: opportunity.conditionalReturnPct,
    executableQuantity: executableQuantity.toDecimalPlaces(2, Decimal.ROUND_FLOOR).toFixed(2),
    potentialProfit: potentialProfit.toDecimalPlaces(6, Decimal.ROUND_FLOOR).toFixed(6),
    autoOrderPotentialProfit: autoOrderPotentialProfit.toDecimalPlaces(6, Decimal.ROUND_FLOOR).toFixed(6),
    fixedSortKey: [
      String(opportunity.durationMinutes).padStart(3, '0'),
      String(opportunity.startTime).padStart(16, '0'),
      opportunity.symbol,
      mexcVenue.id,
      opportunity.mexcDirection,
      polymarketVenue.id,
      opportunity.polymarketDirection
    ].join(':'),
    blockReasons
  }
}

export function buildLegacyMultiVenueBoard(input: LegacyBoardInput): MultiVenueBoardSnapshot {
  const comparisons = [
    ...input.opportunities
    .map((opportunity) => buildComparison(opportunity, input.settings, input.generatedAt))
    , ...(input.additionalComparisons ?? [])
  ].sort((left, right) => left.fixedSortKey.localeCompare(right.fixedSortKey))
  const windows = input.windows ?? []
  const platforms = listRegisteredVenues().map((venue) => {
    const connectionState = venue.id === 'MEXC' || venue.id === 'POLYMARKET'
      ? input.connections[venue.id]
      : input.additionalConnections?.[venue.id] ?? 'NOT_CONFIGURED' as const
    // Supplemental venues are refreshed on a 15s audit cadence and may use a
    // browser/page fallback. Keep the health chip from declaring them stale
    // between audits; executable comparisons still use the user's strict
    // maxQuoteAgeMs in read-only-board-adapter.
    const healthMaximumAgeMs = venue.id === 'MEXC' || venue.id === 'POLYMARKET'
      ? input.settings.maxQuoteAgeMs
      : Math.max(input.settings.maxQuoteAgeMs, 30_000)
    const durations = venue.supportedDurations ?? [5, 15] as const
    return {
      ...venue,
      monitoringEnabled: input.monitoringEnabled?.[venue.id] ?? true,
      connectionState,
      statusMessage: input.statusMessages?.[venue.id],
      cycles: durations.map((duration) => cycleHealth(
        venue.id,
        duration,
        connectionState,
        windows,
        input.generatedAt,
        healthMaximumAgeMs
      ))
    }
  })
  return { generatedAt: input.generatedAt, platforms, comparisons }
}
