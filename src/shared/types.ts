export type Venue = 'MEXC' | 'POLYMARKET'
export type Direction = 'UP' | 'DOWN'
export type MarketDuration = 5 | 15 | 30
export type ExecutionMode = 'SIMULATION' | 'ASSISTED' | 'LIVE'
export type MatchClass = 'CONDITIONAL' | 'INCOMPATIBLE' | 'EXACT'
export type MexcCalibrationKind = 'amountInput' | 'upButton' | 'downButton' | 'submitButton'
export type MexcBrowserMode = 'EMBEDDED' | 'HUBSTUDIO'
export type MexcElementMode = 'AUTO' | 'MANUAL'
export type PolymarketSignatureType = 0 | 1 | 2 | 3
export type LicenseStatus = 'UNLICENSED' | 'ACTIVE' | 'EXPIRED' | 'INVALID' | 'CLOCK_ERROR' | 'STORAGE_ERROR'
export type PolymarketHedgeMode = 'PROTECTED_LIMIT' | 'PROTECTED_MARKET'
export type RecoveryHedgeMode = 'PROTECTED' | 'EMERGENCY_MARKET'

export interface ManualExecutionConditions {
  conditionalReturn: boolean
  settlementRisk: boolean
  feeVerification: boolean
  quoteFreshness: boolean
  expiryCutoff: boolean
}

export interface SettlementDistanceRule {
  id: string
  remainingSeconds: number
  minimumBps: string
}

export type ExecutionState =
  | 'IDLE'
  | 'MEXC_OPENING'
  | 'MEXC_SUBMITTING'
  | 'MEXC_SUBMITTED'
  | 'MEXC_PARTIAL'
  | 'MEXC_FILLED'
  | 'POLY_HEDGING'
  | 'HEDGED'
  | 'MEXC_CLOSING'
  | 'MEXC_CLOSE_SUBMITTED'
  | 'POLY_CLOSING'
  | 'CLOSED'
  | 'UNHEDGED'
  | 'RECOVERY_REQUIRED'
  | 'CANCELLED'

export type CloseTarget = 'MEXC' | 'POLYMARKET' | 'BOTH'
export type ArbitrageOrderStatus = 'OPENING' | 'OPEN' | 'UNHEDGED' | 'CLOSED' | 'RECOVERY_REQUIRED' | 'CANCELLED' | 'EXPIRED'
export type OrderTriggerSource = 'MANUAL' | 'AUTO' | 'TEST' | 'UNKNOWN'
export type FillVerificationSource = 'PLATFORM_READBACK' | 'MANUAL_ENTRY' | 'SIMULATED'

export interface OrderBookLevel {
  price: string
  size: string
}

export interface VenueQuote {
  venue: Venue
  direction: Direction
  bestAsk: string
  levels: OrderBookLevel[]
  receivedAt: number
  source: 'LIVE' | 'SIMULATED' | 'MANUAL'
}

export interface Opportunity {
  id: string
  mexcEventId: string
  mexcSymbolId: string
  symbol: 'BTC/USD'
  durationMinutes: MarketDuration
  startTime: number
  endTime: number
  mexcDirection: Direction
  polymarketDirection: Direction
  polymarketTokenId?: string
  polymarketMinOrderSize: string
  mexcPrice: string
  polymarketPrice: string
  mexcFeeRate: string
  mexcFeeRateSource: 'HISTORY' | 'UNAVAILABLE'
  polymarketFeeRate: string
  polymarketFeeExponent: string
  polymarketEffectiveFeeRate: string
  mexcFeePerShare: string
  polymarketFeePerShare: string
  riskBufferPerShare: string
  allInCostPerShare: string
  grossEdgePerShare: string
  netEdgePerShare: string
  mexcAvailableQuantity: string
  polymarketAvailableQuantity: string
  maxQuantity: string
  mexcQuoteAgeMs: number
  polymarketQuoteAgeMs: number
  capitalRequired: string
  expectedProfit: string
  conditionalReturnPct: string
  worstCaseReturnPct: string
  bothLosePnlPerShare: string
  bothWinPnlPerShare: string
  feeVerificationBlocked: boolean
  feeVerificationReason?: string
  settlementRiskBlocked: boolean
  settlementRiskReason?: string
  mexcSignal?: Direction
  polymarketSignal?: Direction
  mexcDistanceBps?: string
  polymarketDistanceBps?: string
  settlementDistanceBps: string
  requiredSettlementDistanceBps: string
  matchClass: MatchClass
  stale: boolean
  riskFlags: string[]
}

export interface Fill {
  venue: Venue
  direction: Direction
  quantity: string
  averagePrice: string
  orderId: string
  filledAt: number
  verificationSource?: FillVerificationSource
  executionDetails?: Record<string, string | number | boolean>
}

export interface OrderLegRecord {
  venue: Venue
  direction: Direction
  eventId?: string
  symbolId?: string
  tokenId?: string
  entryFill?: Fill
  entryFills?: Fill[]
  targetQuantity?: string
  closeFills: Fill[]
  openQuantity: string
}

export interface CloseOperation {
  id: string
  target: CloseTarget
  state: 'MEXC_CLOSING' | 'MEXC_CLOSE_SUBMITTED' | 'POLY_CLOSING' | 'CLOSED' | 'RECOVERY_REQUIRED'
  startedAt: number
  updatedAt: number
  error?: string
}

export interface HedgeOutcomeSummary {
  protectedCost: string
  mexcDirectionPnl: string
  polymarketDirectionPnl: string
  worstPnl: string
  worstReturnPct: string
  quantityDifference: string
  safe: boolean
  meetsProfitTarget: boolean
}

export interface ArbitrageOrderRecord {
  id: string
  opportunityId: string
  symbol: 'BTC/USD'
  durationMinutes: MarketDuration
  startTime: number
  endTime: number
  mode: ExecutionMode
  triggerSource?: OrderTriggerSource
  status: ArbitrageOrderStatus
  executionState: ExecutionState
  requestedQuantity: string
  expectedCapital: string
  expectedProfit: string
  createdAt: number
  updatedAt: number
  mexc: OrderLegRecord
  polymarket: OrderLegRecord
  hedgeOutcome?: HedgeOutcomeSummary
  closeOperation?: CloseOperation
}

export interface ExecutionEvent {
  id: string
  sessionId: string
  state: ExecutionState
  timestamp: number
  message: string
  details?: Record<string, string | number | boolean>
}

export interface ExecutionSession {
  id: string
  opportunityId: string
  requestedQuantity: string
  state: ExecutionState
  mode: ExecutionMode
  startedAt: number
  updatedAt: number
  mexcFill?: Fill
  polymarketFill?: Fill
  polymarketFills?: Fill[]
  polymarketTargetQuantity?: string
  remainingHedgeQuantity?: string
  excessHedgeQuantity?: string
  hedgeOutcome?: HedgeOutcomeSummary
  hedgeAttempts?: number
  timings?: ExecutionTimings
  error?: string
}

export interface ExecutionTimings {
  executeRequestedAt: number
  quotesConfirmedAt?: number
  planConfirmedAt?: number
  mexcPageReadyAt?: number
  mexcDirectionReadyAt?: number
  mexcButtonReadyAt?: number
  mexcSubmittedAt?: number
  mexcAcceptedAt?: number
  mexcFillDetectedAt?: number
  polymarketStartedAt?: number
  polymarketCompletedAt?: number
  hedgedAt?: number
}

export interface RiskSettings {
  mode: ExecutionMode
  maxCapitalPerTrade: string
  minConditionalReturnPct: string
  maxQuoteAgeMs: number
  maxHedgeSlippage: string
  stopBeforeExpirySeconds: number
  settlementDistanceRules: SettlementDistanceRule[]
  opportunitySoundEnabled: boolean
  opportunitySoundVolume: number
  opportunitySoundCooldownSeconds: number
  mexcBrowserMode: MexcBrowserMode
  mexcElementMode: MexcElementMode
  hubstudioContainerCode: string
  polymarketProxyUrl: string
  mexcAutomationEnabled: boolean
  polymarketLiveEnabled: boolean
  allowUnprofitableTestTrade: boolean
  autoOpenEnabled: boolean
  autoOpenQuantityMode: 'FIXED' | 'MAX_PERCENT'
  autoOpenFixedQuantity: string
  autoOpenMaxQuantityPct: number
  maxRecoveryLossUsdt: string
  polymarketHedgeRetryCount: number
  polymarketHedgeMode: PolymarketHedgeMode
  manualExecutionConditions: ManualExecutionConditions
  autoOpenStabilityMs: number
}

export interface ExecutionPlan {
  opportunityId: string
  requestedQuantity: string
  minimumQuantity: string
  maxAffordableQuantity: string
  maxExecutableQuantity: string
  bestLevelQuantity: string
  marketDepthQuantity: string
  mexcAveragePrice: string
  polymarketAveragePrice: string
  polymarketMaximumPrice: string
  mexcSpend: string
  polymarketSpend: string
  mexcFee: string
  polymarketFee: string
  capitalRequired: string
  expectedProfit: string
  netEdgePerShare: string
  conditionalReturnPct: string
  mexcLevelsUsed: number
  polymarketLevelsUsed: number
  affordableLimitingFactors: string[]
  limitingFactors: string[]
  accountBalanceReservePct: string
  executable: boolean
  blockReason?: string
  accountDataAgeMs?: number
}

export interface CalculateExecutionPlanRequest {
  opportunityId: string
  quantity?: string
  useMaximum?: boolean
  refreshStaleAccounts?: boolean
}

export interface AutoOpenState {
  status: 'OFF' | 'MONITORING' | 'STABILIZING' | 'VERIFYING' | 'COOLDOWN' | 'ERROR'
  message: string
  opportunityId?: string
  since: number
}

export interface AppSnapshot {
  generatedAt: number
  connection: {
    mexc: 'DISCONNECTED' | 'BROWSER_READY'
    polymarket: 'DISCONNECTED' | 'CONNECTED'
    chainlink: 'DISCONNECTED' | 'CONNECTED'
  }
  connectionDetails: {
    mexc?: string
    polymarket?: string
    chainlink?: string
  }
  settings: RiskSettings
  opportunities: Opportunity[]
  orderHistory: ArbitrageOrderRecord[]
  activeSession?: ExecutionSession
  recentEvents: ExecutionEvent[]
  autoOpenState: AutoOpenState
}

export interface ExecuteRequest {
  opportunityId: string
  quantity: string
  source?: Exclude<OrderTriggerSource, 'UNKNOWN'>
}

export interface ConfirmMexcFillRequest extends Pick<Fill, 'quantity' | 'averagePrice' | 'orderId'> {
  manualAcknowledged: boolean
}

export interface CloseOrderRequest {
  orderId: string
  target: CloseTarget
}

export interface RetryPolymarketHedgeRequest {
  mode?: RecoveryHedgeMode
}

export interface UpdateSettingsRequest extends Omit<Partial<RiskSettings>, 'manualExecutionConditions'> {
  manualExecutionConditions?: Partial<ManualExecutionConditions>
}

export interface MexcBrowserStatus {
  mode: MexcBrowserMode
  open: boolean
  url?: string
  authenticated: boolean
  automationAvailable: boolean
  monitoring: boolean
  hubstudioContainerCode?: string
  debuggingPort?: number
  calibrated: Record<MexcCalibrationKind, boolean>
  account?: MexcAccountState
  lastOrderCapture?: MexcOrderCapture
  message: string
}

export interface MexcOrderCapture {
  capturedAt: number
  endpoint: string
  method: string
  requestFields: string[]
  responseStatus?: number
  responseFields: string[]
  message: string
}

export interface MexcAccountState {
  checkedAt: number
  reachable: boolean
  authenticated: boolean
  availableUsdt?: string
  positionCount: number
  openOrderCount: number
  historyCount: number
  positionFields: string[]
  openOrderFields: string[]
  historyFields: string[]
  fillReadbackReady: boolean
  latestFill?: Fill
  latestSettlement?: MexcSettlement
  message: string
}

export interface MexcSettlement {
  eventId: string
  direction: Direction
  quantity: string
  payout: string
  result: 'WON' | 'LOST'
  transactionId: string
  settledAt: number
}

export interface PolymarketCredentialSummary {
  configured: boolean
  encryptionAvailable: boolean
  signatureType?: PolymarketSignatureType
  funderAddress?: string
  signerAddress?: string
  apiKeyMasked?: string
  hasSignerPrivateKey: boolean
  hasApiSecret: boolean
  hasApiPassphrase: boolean
  message: string
}

export interface PolymarketIdentityValidation {
  ok: boolean
  checkedAt: number
  signerAddress: string
  funderAddress: string
  apiAuthenticated: boolean
  localSignatureVerified: boolean
  localOrderSigned: boolean
  closedOnly: boolean
  collateralBalance: string
  allowanceReady: boolean
  allowanceCount: number
  openOrderCount: number
  recentTradeCount: number
  tokenId?: string
  suggestedSignatureType?: PolymarketSignatureType
  message: string
}

export interface UpdatePolymarketCredentialsRequest {
  signatureType: PolymarketSignatureType
  funderAddress: string
  signerPrivateKey?: string
  apiKey?: string
  apiSecret?: string
  apiPassphrase?: string
}

export interface LicenseSummary {
  status: LicenseStatus
  machineCode: string
  licenseId?: string
  customer?: string
  validFrom?: number
  validUntil?: number
  remainingSeconds?: number
  emergencyOnly: boolean
  encryptionAvailable: boolean
  message: string
}

export interface EmergencyAccessSnapshot {
  activeSession?: ExecutionSession
  orders: ArbitrageOrderRecord[]
}

export interface ArbAppApi {
  getLicenseSummary(): Promise<LicenseSummary>
  activateLicense(activationCode: string): Promise<LicenseSummary>
  deactivateLicense(): Promise<LicenseSummary>
  getEmergencyAccessSnapshot(): Promise<EmergencyAccessSnapshot>
  getSnapshot(): Promise<AppSnapshot>
  refreshOpportunities(): Promise<AppSnapshot>
  testPolymarketConnection(): Promise<AppSnapshot>
  execute(request: ExecuteRequest): Promise<ExecutionSession>
  calculateExecutionPlan(request: CalculateExecutionPlanRequest): Promise<ExecutionPlan>
  confirmMexcFill(fill: ConfirmMexcFillRequest): Promise<ExecutionSession>
  retryPolymarketHedge(request?: RetryPolymarketHedgeRequest): Promise<ExecutionSession>
  cancelExecution(): Promise<ExecutionSession | undefined>
  closeOrder(request: CloseOrderRequest): Promise<ArbitrageOrderRecord>
  updateSettings(request: UpdateSettingsRequest): Promise<RiskSettings>
  openMexc(): Promise<MexcBrowserStatus>
  getMexcStatus(): Promise<MexcBrowserStatus>
  refreshMexcAccount(): Promise<MexcBrowserStatus>
  calibrateMexc(kind: MexcCalibrationKind): Promise<MexcBrowserStatus>
  getPolymarketCredentialSummary(): Promise<PolymarketCredentialSummary>
  updatePolymarketCredentials(request: UpdatePolymarketCredentialsRequest): Promise<PolymarketCredentialSummary>
  validatePolymarketIdentity(tokenId?: string): Promise<PolymarketIdentityValidation>
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void
  onLicenseState(listener: (summary: LicenseSummary) => void): () => void
}
