import Decimal from 'decimal.js'
import type { MultiVenueComparison, MultiVenueLeg, MultiVenueMatchClass } from '../../shared/multi-venue'
import type { Direction, RiskSettings } from '../../shared/types'
import type { ReadOnlyWindowQuote } from '../platforms/read-only-types'
import type { ResolutionFingerprint } from '../platforms/contracts'
import { getVenueDescriptor } from '../platforms/registry'

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

function makeRoute(left: ReadOnlyWindowQuote, right: ReadOnlyWindowQuote, direction: RouteDirection, settings: RiskSettings, now: number): BidirectionalRoute | undefined {
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
    quoteAgeMs: Math.max(now - leftQuote.receivedAt, now - rightQuote.receivedAt)
  }
}

export function buildBidirectionalRoutes(windows: ReadOnlyWindowQuote[], settings: RiskSettings, now: number): BidirectionalRoute[] {
  const stableWindows = [...windows].sort((left, right) => left.venueId.localeCompare(right.venueId) || left.marketId.localeCompare(right.marketId))
  const routes: BidirectionalRoute[] = []
  for (let leftIndex = 0; leftIndex < stableWindows.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < stableWindows.length; rightIndex += 1) {
      const left = stableWindows[leftIndex]
      const right = stableWindows[rightIndex]
      if (!compatibleWindow(left, right)) continue
      for (const direction of ['A_TO_B', 'B_TO_A'] as const) {
        const route = makeRoute(left, right, direction, settings, now)
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
    { venueId: route.left.venueId, venueLabel: getVenueDescriptor(route.left.venueId).label, marketId: route.left.marketId, outcomeId: leftQuote.outcomeId, direction: route.leftDirection, price: leftQuote.bestAsk, availableQuantity: leftQuote.askSize, quoteAgeMs: Math.max(0, now - leftQuote.receivedAt) },
    { venueId: route.right.venueId, venueLabel: getVenueDescriptor(route.right.venueId).label, marketId: route.right.marketId, outcomeId: rightQuote.outcomeId, direction: route.rightDirection, price: rightQuote.bestAsk, availableQuantity: rightQuote.askSize, quoteAgeMs: Math.max(0, now - rightQuote.receivedAt) }
  ]
}

export function routeToComparison(route: BidirectionalRoute, settings: RiskSettings, now: number): MultiVenueComparison {
  const includesKalshi = route.left.venueId === 'KALSHI' || route.right.venueId === 'KALSHI'
  const kalshiPairSupported = includesKalshi && [route.left.venueId, route.right.venueId].some((venue) => venue === 'MEXC' || venue === 'POLYMARKET' || venue === 'GATE')
  const maxAge = route.quoteAgeMs
  const executableDepth = new Decimal(route.executableQuantity)
  const depthReady = executableDepth.gte(1)
  const blockReasons = [
    includesKalshi ? '跨平台双腿执行需人工确认；按首腿实际成交量对冲第二腿' : '新平台当前只读，尚未开放该路线下单',
    route.matchClass === 'EXACT'
      ? kalshiPairSupported ? '双腿没有跨平台原子事务；第二腿失败会进入恢复态' : '交易连接器尚未接入'
      : '结算源、取价方式或平价规则不完全一致',
    maxAge > settings.maxQuoteAgeMs ? `行情过期：最慢一腿 ${Math.round(maxAge / 1_000)} 秒未更新（门槛 ${Math.round(settings.maxQuoteAgeMs / 1_000)} 秒）` : '',
    !depthReady ? '当前至少一腿没有可执行深度，无法确定安全下单份额' : '',
    !route.left.feeVerified || !route.right.feeVerified ? '手续费模型尚未完成实盘校验，当前仅显示毛边际' : ''
  ].filter(Boolean)
  const comparisonLegs = legs(route, now)
  return {
    id: route.routeId,
    asset: route.left.asset, durationMinutes: route.left.durationMinutes, startTime: route.left.startTime, endTime: route.left.endTime,
    strategy: 'COMPLEMENTARY_OUTCOMES', matchClass: route.matchClass,
    status: maxAge > settings.maxQuoteAgeMs ? 'STALE' : kalshiPairSupported && depthReady ? 'MANUAL_EXECUTABLE' : 'BLOCKED',
    executionProvider: 'MULTI_VENUE', edgeKind: 'GROSS_ONLY', legs: comparisonLegs,
    allInCostPerShare: route.allInCostPerShare, netEdgePerShare: route.netEdgePerShare,
    conditionalReturnPct: new Decimal(route.allInCostPerShare).gt(0) ? new Decimal(route.netEdgePerShare).div(route.allInCostPerShare).mul(100).toFixed(4) : '0',
    executableQuantity: route.executableQuantity, potentialProfit: '0.000000', autoOrderPotentialProfit: '0.000000',
    fixedSortKey: [String(route.left.durationMinutes).padStart(3, '0'), String(route.left.startTime).padStart(16, '0'), route.left.asset, route.routeId].join(':'),
    blockReasons
  }
}
