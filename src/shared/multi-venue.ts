export type VenueId = string

/**
 * Venues that have a validated real-order transport in the current product.
 * Predict.fun and Limitless remain observable only until their order flows are
 * validated independently; keeping this allow-list in shared code prevents a
 * UI route from being accidentally treated as executable by the main process.
 */
export const MULTI_VENUE_EXECUTION_VENUES = ['MEXC', 'POLYMARKET', 'GATE', 'KALSHI', 'PREDICT_FUN'] as const

export function isMultiVenueExecutionVenue(venueId: VenueId): boolean {
  return (MULTI_VENUE_EXECUTION_VENUES as readonly string[]).includes(venueId.toUpperCase())
}

export type CanonicalEventCategory = 'CRYPTO' | 'SPORTS' | 'POLITICS' | 'FINANCE' | 'OTHER'
export type CanonicalDirection = 'UP' | 'DOWN'

export interface CanonicalOutcome {
  id: string
  label: string
  direction?: CanonicalDirection
}

export interface CanonicalEvent {
  eventId: string
  category: CanonicalEventCategory
  subject: string
  interval?: string
  startTime: number
  endTime: number
  settlementSource?: string
  outcomes: CanonicalOutcome[]
}

export interface CanonicalMarket {
  eventId: string
  venueId: VenueId
  marketId: string
  outcomeIds: string[]
  receivedAt: number
  quoteAvailable: boolean
  depthAvailable: boolean
}

export interface VenueAdapterCapabilities {
  marketDiscovery: boolean
  realtimeBook: boolean
  placeOrder: boolean
  fillReadback: boolean
  reconcileOrder: boolean
  cancelOrder: boolean
}

export type ExecutionPolicy =
  | 'OBSERVE_ONLY'
  | 'MANUAL_TWO_LEG'
  | 'SEQUENTIAL_FILL_THEN_HEDGE'
  | 'PARALLEL_UNPROTECTED'
  | 'PARALLEL_FOK'
  | 'AUTO_WITH_RECOVERY'

export type VenueIntegrationState = 'LIVE' | 'READ_ONLY' | 'PLANNED'
export type VenueConnectionState = 'CONNECTED' | 'DISCONNECTED' | 'NOT_CONFIGURED'
export type VenueCycleDataState = 'DEPTH_READY' | 'PRICE_ONLY' | 'STALE' | 'NO_MARKET' | 'OFFLINE'

export interface VenueCycleHealth {
  durationMinutes: 5 | 15
  state: VenueCycleDataState
  marketCount: number
  latestQuoteAt?: number
}

export interface VenueCapabilities {
  marketDiscovery: boolean
  realtimeBook: boolean
  placeOrder: boolean
  cancelOrder: boolean
  fillStream: boolean
  exitPosition: boolean
  splitMerge: boolean
}

export interface VenueDescriptor {
  id: VenueId
  label: string
  integrationState: VenueIntegrationState
  /** Whether this venue is currently included in background monitoring. */
  monitoringEnabled?: boolean
  supportedDurations?: Array<5 | 15>
  supportedSubjects?: string[]
  supportedIntervals?: string[]
  connectionState: VenueConnectionState
  statusMessage?: string
  cycles?: VenueCycleHealth[]
  capabilities: VenueCapabilities
}

export type MultiVenueStrategy =
  | 'COMPLEMENTARY_OUTCOMES'
  | 'COMPLETE_SET'
  | 'COVERED_RANGE'
  | 'MAKER_THEN_HEDGE'

export type MultiVenueMatchClass = 'EXACT' | 'COVERED' | 'CONDITIONAL' | 'CORRELATED' | 'INCOMPATIBLE'
export type MultiVenueComparisonStatus = 'EXECUTABLE' | 'MANUAL_EXECUTABLE' | 'NO_EDGE' | 'BLOCKED' | 'STALE'
export type MultiVenueExecutionProvider = 'LEGACY_MEXC_POLY' | 'MULTI_VENUE'

export interface MultiVenueLeg {
  venueId: VenueId
  venueLabel: string
  marketId?: string
  outcomeId?: string
  direction: 'UP' | 'DOWN'
  price: string
  availableQuantity: string
  quoteAgeMs: number
}

export interface MultiVenueComparison {
  id: string
  legacyOpportunityId?: string
  asset: string
  durationMinutes: number
  startTime: number
  endTime: number
  strategy: MultiVenueStrategy
  matchClass: MultiVenueMatchClass
  status: MultiVenueComparisonStatus
  executionProvider: MultiVenueExecutionProvider
  edgeKind: 'NET_VERIFIED' | 'GROSS_ONLY'
  legs: MultiVenueLeg[]
  allInCostPerShare: string
  netEdgePerShare: string
  conditionalReturnPct: string
  executableQuantity: string
  potentialProfit: string
  autoOrderPotentialProfit: string
  fixedSortKey: string
  blockReasons: string[]
}

export interface MultiVenueBoardSnapshot {
  generatedAt: number
  platforms: VenueDescriptor[]
  comparisons: MultiVenueComparison[]
}

export type MultiVenueExecutionVenue = VenueId

export interface MultiVenueExecutionLegRequest {
  venueId: MultiVenueExecutionVenue
  marketId?: string
  outcomeId?: string
  direction: 'UP' | 'DOWN'
  price: string
  availableQuantity: string
  quoteAgeMs: number
}

export interface MultiVenueExecutionRequest {
  comparisonId: string
  sessionId?: string
  quantity: string
  startTime: number
  endTime: number
  confirmed: boolean
  maxQuoteAgeMs?: number
  stopBeforeExpirySeconds?: number
  executionPolicy?: ExecutionPolicy
  firstLegIndex?: 0 | 1
  legs: [MultiVenueExecutionLegRequest, MultiVenueExecutionLegRequest]
}

export interface MultiVenueExecutionCommand {
  comparisonId: string
  quantity: string
  confirmed: boolean
}

export interface MultiVenueExecutionLegReceipt {
  venueId: MultiVenueExecutionVenue
  direction: 'UP' | 'DOWN'
  requestedQuantity: string
  filledQuantity: string
  averagePrice?: string
  orderId?: string
  status: 'SUBMITTED' | 'FILLED' | 'PARTIAL' | 'UNKNOWN' | 'NOT_SUBMITTED'
}

export interface MultiVenueExecutionReceipt {
  sessionId: string
  comparisonId: string
  status: 'HEDGED' | 'UNPROTECTED_SUBMITTED' | 'RECOVERY_REQUIRED' | 'RECONCILE_REQUIRED' | 'CANCELED'
  firstLeg: MultiVenueExecutionLegReceipt
  secondLeg?: MultiVenueExecutionLegReceipt
  message: string
}

export type MultiVenueExecutionSessionStatus = 'STARTED' | 'HEDGED' | 'UNPROTECTED_SUBMITTED' | 'RECOVERY_REQUIRED' | 'RECONCILE_REQUIRED' | 'CANCELED' | 'RECOVERED'

export interface MultiVenueExecutionSession {
  sessionId: string
  comparisonId: string
  status: MultiVenueExecutionSessionStatus
  createdAt: number
  updatedAt: number
  receipt?: MultiVenueExecutionReceipt
  recoveryNote?: string
}
