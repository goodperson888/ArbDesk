export type Venue = 'MEXC' | 'POLYMARKET'
export type Direction = 'UP' | 'DOWN'
export type MarketDuration = 5 | 15 | 30
export type ExecutionMode = 'SIMULATION' | 'ASSISTED' | 'LIVE'
export type MatchClass = 'CONDITIONAL' | 'INCOMPATIBLE' | 'EXACT'
export type MexcCalibrationKind = 'amountInput' | 'upButton' | 'downButton' | 'submitButton'
export type MexcBrowserMode = 'EMBEDDED' | 'HUBSTUDIO'
export type MexcElementMode = 'AUTO' | 'MANUAL'
export type PolymarketSignatureType = 0 | 1 | 2 | 3

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
export type ArbitrageOrderStatus = 'OPENING' | 'OPEN' | 'UNHEDGED' | 'CLOSED' | 'RECOVERY_REQUIRED' | 'CANCELLED'

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
  maxQuantity: string
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
}

export interface OrderLegRecord {
  venue: Venue
  direction: Direction
  eventId?: string
  symbolId?: string
  tokenId?: string
  entryFill?: Fill
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

export interface ArbitrageOrderRecord {
  id: string
  opportunityId: string
  symbol: 'BTC/USD'
  durationMinutes: MarketDuration
  startTime: number
  endTime: number
  mode: ExecutionMode
  status: ArbitrageOrderStatus
  executionState: ExecutionState
  requestedQuantity: string
  expectedCapital: string
  expectedProfit: string
  createdAt: number
  updatedAt: number
  mexc: OrderLegRecord
  polymarket: OrderLegRecord
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
  error?: string
}

export interface RiskSettings {
  mode: ExecutionMode
  maxCapitalPerTrade: string
  minNetEdgePerShare: string
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
}

export interface ExecuteRequest {
  opportunityId: string
  quantity: string
}

export interface CloseOrderRequest {
  orderId: string
  target: CloseTarget
}

export interface UpdateSettingsRequest extends Partial<RiskSettings> {}

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

export interface ArbAppApi {
  getSnapshot(): Promise<AppSnapshot>
  refreshOpportunities(): Promise<AppSnapshot>
  testPolymarketConnection(): Promise<AppSnapshot>
  execute(request: ExecuteRequest): Promise<ExecutionSession>
  confirmMexcFill(fill: Pick<Fill, 'quantity' | 'averagePrice' | 'orderId'>): Promise<ExecutionSession>
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
}
