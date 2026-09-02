import type { MultiVenueBoardSnapshot, MultiVenueExecutionCommand, MultiVenueExecutionReceipt, MultiVenueExecutionSession, SettlementScenario } from './multi-venue'

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
export type FillVerificationSource = 'PLATFORM_READBACK' | 'MANUAL_ENTRY' | 'SIMULATED' | 'PLANNED'

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
  settlementScenario?: SettlementScenario
  doubleWinEntryEligible?: boolean
  /** The opposite one-up/one-down route is currently eligible to avoid a double-loss interval. */
  reverseEntryEligible?: boolean
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
  timings?: ExecutionTimings
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
  preflightMs?: number
  quotesConfirmedAt?: number
  planConfirmedAt?: number
  mexcCurrencyMappingMs?: number
  mexcCookieReadMs?: number
  mexcPostMs?: number
  mexcPageReadyAt?: number
  mexcDirectionReadyAt?: number
  mexcButtonReadyAt?: number
  mexcSubmittedAt?: number
  mexcAcceptedAt?: number
  mexcFillDetectedAt?: number
  mexcFillReadbackMs?: number
  mexcFillRestQueries?: number
  polymarketStartedAt?: number
  polymarketMetadataMs?: number
  polymarketSigningMs?: number
  polymarketPostMs?: number
  polymarketConfirmationMs?: number
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
  /** Kalshi 单腿实盘下单总开关；默认关闭，且不受自动开单开关影响。 */
  kalshiLiveEnabled?: boolean
  /** Gate 事件合约页面下单总开关；默认关闭，且必须先捕获真实订单结构。 */
  gateLiveEnabled?: boolean
  /** Predict.fun 官方 API 下单总开关；默认关闭，需要 API Key 与签名身份。 */
  predictFunLiveEnabled?: boolean
  allowUnprofitableTestTrade: boolean
  autoOpenEnabled: boolean
  autoOpenQuantityMode: 'FIXED' | 'MAX_PERCENT'
  autoOpenFixedQuantity: string
  autoOpenMaxQuantityPct: number
  maxRecoveryLossUsdt: string
  polymarketHedgeRetryCount: number
  polymarketHedgeMode: PolymarketHedgeMode
  preHedgeRatioPct: number
  unprotectedExecutionEnabled: boolean
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
  /** 覆盖计划数量所要吃到的最贵MEXC档位价，作为直连下单的价格保护上限。 */
  mexcMaximumPrice: string
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
  multiVenueBoard: MultiVenueBoardSnapshot
  multiVenueReceipt?: MultiVenueExecutionReceipt
  multiVenueExecutionSessions: MultiVenueExecutionSession[]
  multiVenueExecutionHistory: MultiVenueExecutionSession[]
  orderHistory: ArbitrageOrderRecord[]
  activeSession?: ExecutionSession
  recoverySessions: ExecutionSession[]
  recentEvents: ExecutionEvent[]
  autoOpenState: AutoOpenState
}

export interface ExecuteRequest {
  opportunityId: string
  quantity: string
  source?: Exclude<OrderTriggerSource, 'UNKNOWN'>
  /** Explicit, per-click consent for a route currently inside its double-win interval. */
  allowDoubleWinEntry?: boolean
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
  orderId?: string
}

export interface UpdateSettingsRequest extends Omit<Partial<RiskSettings>, 'manualExecutionConditions'> {
  manualExecutionConditions?: Partial<ManualExecutionConditions>
}

export interface PlaceKalshiOrderRequest {
  ticker: string
  direction: Direction
  quantity: string
  /** 用户看到的该 outcome 的卖一价（美元）；服务端会重新校验最新缓存。 */
  outcomePrice: string
  quoteReceivedAt: number
  marketEndTime: number
  /** UI 二次确认后才允许进入真实 POST 路径。 */
  confirmed: boolean
}

export interface KalshiOrderReceipt {
  orderId: string
  clientOrderId: string
  ticker: string
  direction: Direction
  side: 'bid' | 'ask'
  quantity: string
  outcomePrice: string
  fillCount: string
  remainingCount: string
  status: 'EXECUTED' | 'PARTIAL' | 'CANCELED' | 'RESTING' | 'UNKNOWN'
  submittedAt: number
  message: string
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

export interface PredictFunCredentialSummary {
  configured: boolean
  tradingConfigured: boolean
  encryptionAvailable: boolean
  apiKeyMasked?: string
  source?: 'KEYCHAIN' | 'ENVIRONMENT'
  accountType?: 'PREDICT_ACCOUNT' | 'EOA'
  accountAddress?: string
  signerAddress?: string
  hasSignerPrivateKey: boolean
  message: string
}

export interface UpdatePredictFunCredentialsRequest {
  apiKey?: string
  accountType?: 'PREDICT_ACCOUNT' | 'EOA'
  accountAddress?: string
  signerPrivateKey?: string
}

export interface PredictFunPageCaptureStatus {
  state: 'IDLE' | 'STARTING' | 'CONNECTED' | 'DISCONNECTED'
  message: string
  updatedAt?: number
  responseCount?: number
  webSocketFrameCount?: number
  lastCaptureAt?: number
}

export interface PredictFunOrderCaptureSummary {
  capturing: boolean
  traceEntryCount: number
  requestCount: number
  responseCount: number
  webSocketCount: number
  message: string
}

export interface GatePageCaptureStatus {
  state: 'IDLE' | 'STARTING' | 'CONNECTED' | 'DISCONNECTED'
  message: string
  updatedAt?: number
  responseCount?: number
  webSocketFrameCount?: number
  lastCaptureAt?: number
}

export interface GateOrderCaptureSummary {
  captured: boolean
  capturing?: boolean
  executionReady?: boolean
  executableDurations?: Array<5 | 15>
  endpoint?: string
  method?: string
  requestFields?: string[]
  pageUrl?: string
  capturedAt?: number
  traceEntryCount?: number
  candidateCount?: number
  responseCount?: number
  webSocketCount?: number
  message: string
}

export interface GateCredentialSummary {
  configured: boolean
  encryptionAvailable: boolean
  apiKeyMasked?: string
  hasApiSecret: boolean
  message: string
}

export interface UpdateGateCredentialsRequest {
  apiKey?: string
  apiSecret?: string
}

export interface KalshiCredentialSummary {
  configured: boolean
  encryptionAvailable: boolean
  apiKeyIdMasked?: string
  hasPrivateKey: boolean
  message: string
}

export interface UpdateKalshiCredentialsRequest {
  apiKeyId?: string
  privateKeyPem?: string
}

export interface KalshiPageCaptureStatus {
  state: 'IDLE' | 'STARTING' | 'CONNECTED' | 'DISCONNECTED'
  message: string
  updatedAt?: number
  responseCount?: number
  webSocketFrameCount?: number
  lastCaptureAt?: number
}

export interface LimitlessCredentialSummary {
  configured: boolean
  encryptionAvailable: boolean
  tokenIdMasked?: string
  hasTokenSecret: boolean
  profileId?: string
  walletAddress?: string
  hasWalletPrivateKey: boolean
  message: string
}

export interface UpdateLimitlessCredentialsRequest {
  tokenId?: string
  tokenSecret?: string
  walletPrivateKey?: string
}

export type VenuePreparationStageStatus = 'PASS' | 'WARN' | 'BLOCKED' | 'SKIPPED'

export interface VenuePreparationStage {
  id: string
  label: string
  status: VenuePreparationStageStatus
  durationMs: number
  detail: string
}

export interface VenuePreparationReport {
  venueId: 'LIMITLESS' | 'PREDICT_FUN' | 'GATE' | 'KALSHI'
  checkedAt: number
  safeMode: true
  orderSubmissionBlocked: true
  identityVerified: boolean
  marketDataReady: boolean
  accountReadsReady: boolean
  localOrderBuilt: boolean
  localOrderSigned: boolean
  fundingReady: boolean
  approvalsReady: boolean
  collateralBalance?: string
  nativeBalance?: string
  openOrderCount?: number
  positionCount?: number
  marketId?: string
  outcomeId?: string
  orderHash?: string
  requestCount: number
  readyExceptFunding: boolean
  message: string
  stages: VenuePreparationStage[]
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
  setVenueMonitoring(venueId: string, enabled: boolean): Promise<AppSnapshot>
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
  getPredictFunCredentialSummary(): Promise<PredictFunCredentialSummary>
  updatePredictFunCredentials(request: UpdatePredictFunCredentialsRequest): Promise<PredictFunCredentialSummary>
  openPredictFunPage(): Promise<void>
  stopPredictFunPage(): Promise<void>
  getPredictFunPageCaptureStatus(): Promise<PredictFunPageCaptureStatus>
  startPredictFunOrderCapture(): Promise<PredictFunOrderCaptureSummary>
  stopPredictFunOrderCapture(): Promise<PredictFunOrderCaptureSummary>
  getPredictFunOrderCaptureSummary(): Promise<PredictFunOrderCaptureSummary>
  clearPredictFunOrderCapture(): Promise<PredictFunOrderCaptureSummary>
  exportPredictFunOrderCapture(): Promise<string>
  getLimitlessCredentialSummary(): Promise<LimitlessCredentialSummary>
  updateLimitlessCredentials(request: UpdateLimitlessCredentialsRequest): Promise<LimitlessCredentialSummary>
  prepareLimitlessWithoutSubmitting(): Promise<VenuePreparationReport>
  preparePredictFunWithoutSubmitting(): Promise<VenuePreparationReport>
  getGateCredentialSummary(): Promise<GateCredentialSummary>
  updateGateCredentials(request: UpdateGateCredentialsRequest): Promise<GateCredentialSummary>
  openGatePage(): Promise<void>
  stopGatePage(): Promise<void>
  getGatePageCaptureStatus(): Promise<GatePageCaptureStatus>
  startGateOrderCapture(): Promise<GateOrderCaptureSummary>
  stopGateOrderCapture(): Promise<GateOrderCaptureSummary>
  getGateOrderCaptureSummary(): Promise<GateOrderCaptureSummary>
  clearGateOrderCapture(): Promise<GateOrderCaptureSummary>
  exportGateOrderCapture(): Promise<string>
  prepareGateWithoutSubmitting(): Promise<VenuePreparationReport>
  getKalshiCredentialSummary(): Promise<KalshiCredentialSummary>
  updateKalshiCredentials(request: UpdateKalshiCredentialsRequest): Promise<KalshiCredentialSummary>
  openKalshiPage(): Promise<void>
  stopKalshiPage(): Promise<void>
  getKalshiPageCaptureStatus(): Promise<KalshiPageCaptureStatus>
  prepareKalshiWithoutSubmitting(): Promise<VenuePreparationReport>
  executeMultiVenue(request: MultiVenueExecutionCommand): Promise<MultiVenueExecutionReceipt>
  listMultiVenueExecutionSessions(): Promise<MultiVenueExecutionSession[]>
  markMultiVenueExecutionSessionRecovered(sessionId: string, note?: string): Promise<MultiVenueExecutionSession[]>
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void
  onLicenseState(listener: (summary: LicenseSummary) => void): () => void
}
