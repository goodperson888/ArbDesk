import Decimal from 'decimal.js'
import { isMultiVenueExecutionVenue, type MultiVenueComparison, type MultiVenueLeg, type MultiVenueMatchClass } from '../../shared/multi-venue'
import type { MarketProfile } from '../../shared/market-profile'
import type { Direction, RiskSettings } from '../../shared/types'
import type { ReadOnlyOutcomeQuote, ReadOnlyWindowQuote } from '../platforms/read-only-types'
import type { ResolutionFingerprint } from '../platforms/contracts'
import { getVenueDescriptor } from '../platforms/registry'
import { profileAllowsRoute } from '../services/market-profile'

export type RouteDirection = 'A_TO_B' | 'B_TO_A'

export interface BidirectionalRoute {
  routeId: string
  direction: RouteDirection
  left: ReadOnlyWindowQuote
  right: ReadOnlyWindowQuote
  leftDirection: Direction
  rightDirection: Direction
  matchClass: MultiVenueMatchClass
  allInCostPerShare: string
  netEdgePerShare: string
  executableQuantity: string
  quoteAgeMs: number
}

function quoteAgeMs(quote: ReadOnlyOutcomeQuote, now: number): number {
  const observedAt = Math.max(quote.receivedAt, quote.observedAt ?? 0)
  return Math.max(0, now - observedAt)
}

function matchClass(left: ResolutionFingerprint, right: ResolutionFingerprint): MultiVenueMatchClass {
  const exactFields: Array<keyof ResolutionFingerprint> = [
    'asset', 'startTime', 'endTime', 'baselineSource', 'settlementSource', 'observationMethod',
    'comparisonOperator', 'tieOutcome', 'voidRule', 'staleDataRule', 'timezone', 'ruleVersion'
  ]
  return exactFields.every((field) => left[field] === right[field]) ? 'EXACT' : 'CONDITIONAL'
}

function compatibleWindow(left: ReadOnlyWindowQuote, right: ReadOnlyWindowQuote): boolean {
  return left.venueId !== right.venueId && left.asset === right.asset && left.durationMinutes === right.durationMinutes &&
    left.startTime === right.startTime && left.endTime === right.endTime
}

function makeRoute(left: ReadOnlyWindowQuote, right: ReadOnlyWindowQuote, direction: RouteDirection, settings: RiskSettings, now: number, profile?: MarketProfile): BidirectionalRoute | undefined {
  if (profile && !profileAllowsRoute(profile, left.venueId, right.venueId)) return undefined
  const leftDirection: Direction = direction === 'A_TO_B' ? 'UP' : 'DOWN'
  const rightDirection: Direction = leftDirection === 'UP' ? 'DOWN' : 'UP'
  const leftQuote = left.outcomes[leftDirection]
  const rightQuote = right.outcomes[rightDirection]
  if (!leftQuote || !rightQuote) return undefined
  const cost = new Decimal(leftQuote.bestAsk || 0).plus(rightQuote.bestAsk || 0)
  if (!cost.isFinite() || cost.lte(0)) return undefined
  const grossEdge = new Decimal(1).minus(cost)
  const available = Decimal.min(leftQuote.askSize || 0, rightQuote.askSize || 0)
  const capitalQuantity = new Decimal(settings.maxCapitalPerTrade || 0).div(cost)
  const quantity = Decimal.max(0, Decimal.min(available, capitalQuantity)).toDecimalPlaces(2, Decimal.ROUND_FLOOR)
  return {
    routeId: `route:${left.venueId}:${left.marketId}:${right.venueId}:${right.marketId}:${direction}`,
    direction, left, right, leftDirection, rightDirection,
    matchClass: matchClass(left.resolution, right.resolution),
    allInCostPerShare: cost.toFixed(6), netEdgePerShare: grossEdge.toFixed(6), executableQuantity: quantity.toFixed(2),
    quoteAgeMs: Math.max(quoteAgeMs(leftQuote, now), quoteAgeMs(rightQuote, now))
  }
}

export function buildBidirectionalRoutes(windows: ReadOnlyWindowQuote[], settings: RiskSettings, now: number, profile?: MarketProfile): BidirectionalRoute[] {
  const stableWindows = [...windows].sort((left, right) => left.venueId.localeCompare(right.venueId) || left.marketId.localeCompare(right.marketId))
  const routes: BidirectionalRoute[] = []
  for (let leftIndex = 0; leftIndex < stableWindows.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < stableWindows.length; rightIndex += 1) {
      const left = stableWindows[leftIndex]
      const right = stableWindows[rightIndex]
      if (!compatibleWindow(left, right)) continue
      for (const direction of ['A_TO_B', 'B_TO_A'] as const) {
        const route = makeRoute(left, right, direction, settings, now, profile)
        if (route) routes.push(route)
      }
    }
  }
  return routes.sort((left, right) => left.routeId.localeCompare(right.routeId))
}

function legs(route: BidirectionalRoute, now: number): MultiVenueLeg[] {
  const leftQuote = route.left.outcomes[route.leftDirection]!
  const rightQuote = route.right.outcomes[route.rightDirection]!
  return [
    { venueId: route.left.venueId, venueLabel: getVenueDescriptor(route.left.venueId).label, marketId: route.left.marketId, outcomeId: leftQuote.outcomeId, direction: route.leftDirection, price: leftQuote.bestAsk, availableQuantity: leftQuote.askSize, quoteAgeMs: quoteAgeMs(leftQuote, now) },
    { venueId: route.right.venueId, venueLabel: getVenueDescriptor(route.right.venueId).label, marketId: route.right.marketId, outcomeId: rightQuote.outcomeId, direction: route.rightDirection, price: rightQuote.bestAsk, availableQuantity: rightQuote.askSize, quoteAgeMs: quoteAgeMs(rightQuote, now) }
  ]
}

export function routeToComparison(route: BidirectionalRoute, settings: RiskSettings, now: number): MultiVenueComparison {
  const executionEligible = [route.left.venueId, route.right.venueId].every(isMultiVenueExecutionVenue)
  const hasPredictFun = [route.left.venueId, route.right.venueId].some((venue) => venue === 'PREDICT_FUN')
  const hasLimitless = [route.left.venueId, route.right.venueId].some((venue) => venue === 'LIMITLESS')
  const comparisonLegs = legs(route, now)
  const maxAge = Math.max(...comparisonLegs.map((leg) => leg.quoteAgeMs))
  const staleLegs = comparisonLegs.filter((leg) => leg.quoteAgeMs > settings.maxQuoteAgeMs)
  const staleReason = staleLegs.length > 0
    ? `行情过期：${staleLegs.map((leg) => `${leg.venueLabel} ${Math.round(leg.quoteAgeMs / 1_000)} 秒`).join('；')}未收到价格或有效流观测（门槛 ${Math.round(settings.maxQuoteAgeMs / 1_000)} 秒）`
    : ''
  const executableDepth = new Decimal(route.executableQuantity)
  const depthReady = executableDepth.gte(1)
  const blockReasons = [
    executionEligible
      ? '跨平台双腿执行需人工确认；按首腿实际成交量对齐第二腿'
      : hasPredictFun
        ? 'Predict.fun 当前只读，尚未开放实盘执行'
        : hasLimitless
          ? 'Limitless 当前只读，尚未开放实盘执行'
          : '交易连接器尚未接入',
    route.matchClass === 'EXACT'
      ? executionEligible ? '双腿没有跨平台原子事务；第二腿失败会进入恢复态' : ''
      : '结算源、取价方式或平价规则不完全一致',
    staleReason,
    !depthReady ? '当前至少一腿没有可执行深度，无法确定安全下单份额' : '',
    !route.left.feeVerified || !route.right.feeVerified ? '手续费模型尚未完成实盘校验，当前仅显示毛边际' : ''
  ].filter(Boolean)
  return {
    id: route.routeId,
    asset: route.left.asset, durationMinutes: route.left.durationMinutes, startTime: route.left.startTime, endTime: route.left.endTime,
    strategy: 'COMPLEMENTARY_OUTCOMES', matchClass: route.matchClass,
    status: maxAge > settings.maxQuoteAgeMs ? 'STALE' : executionEligible && depthReady ? 'MANUAL_EXECUTABLE' : 'BLOCKED',
    executionProvider: 'MULTI_VENUE', edgeKind: 'GROSS_ONLY', legs: comparisonLegs,
    allInCostPerShare: route.allInCostPerShare, netEdgePerShare: route.netEdgePerShare,
    conditionalReturnPct: new Decimal(route.allInCostPerShare).gt(0) ? new Decimal(route.netEdgePerShare).div(route.allInCostPerShare).mul(100).toFixed(4) : '0',
    executableQuantity: route.executableQuantity, potentialProfit: '0.000000', autoOrderPotentialProfit: '0.000000',
    fixedSortKey: [String(route.left.durationMinutes).padStart(3, '0'), String(route.left.startTime).padStart(16, '0'), route.left.asset, route.routeId].join(':'),
    blockReasons
  }
}
