import { randomUUID } from 'node:crypto'
import Decimal from 'decimal.js'
import type {
  ArbitrageOrderRecord,
  AppSnapshot,
  AutoOpenState,
  CalculateExecutionPlanRequest,
  CloseOrderRequest,
  ConfirmMexcFillRequest,
  Direction,
  ExecuteRequest,
  ExecutionEvent,
  ExecutionSession,
  ExecutionState,
  ExecutionPlan,
  EmergencyAccessSnapshot,
  Fill,
  HedgeOutcomeSummary,
  MexcAccountState,
  Opportunity,
  RetryPolymarketHedgeRequest,
  RiskSettings,
  UpdateSettingsRequest
} from '../shared/types'
import { defaultManualExecutionConditions, defaultSettlementDistanceRules } from '../shared/defaults'
import { assertTransition } from './domain/execution-machine'
import { calculateOpportunity, polymarketCryptoFeePerShare } from './domain/opportunity'
import { calculateDepthExecutionPlan } from './domain/execution-plan'
import { normalizeSettlementDistanceRules } from './domain/settlement-distance'
import { EventStore } from './services/event-store'
import type { MexcBrowserManager } from './services/mexc-browser'
import { SimulatedPolymarketBroker, type PolymarketBroker } from './services/polymarket'
import type { PolymarketLiveBroker, PolymarketTradingCapacity } from './services/polymarket-live'
import { PolymarketMarketData, type PolymarketWindowQuote } from './services/polymarket-market-data'
import type { MexcWindowQuote } from './services/mexc-browser'

const DEFAULT_SETTINGS: RiskSettings = {
  mode: 'SIMULATION',
  maxCapitalPerTrade: '100',
  minConditionalReturnPct: '0.00',
  maxQuoteAgeMs: 8_000,
  maxHedgeSlippage: '0.0300',
  stopBeforeExpirySeconds: 20,
  settlementDistanceRules: defaultSettlementDistanceRules(),
  opportunitySoundEnabled: true,
  opportunitySoundVolume: 0.65,
  opportunitySoundCooldownSeconds: 30,
  mexcBrowserMode: 'HUBSTUDIO',
  mexcElementMode: 'AUTO',
  hubstudioContainerCode: process.env.HUBSTUDIO_CONTAINER_CODE ?? '1643173278',
  polymarketProxyUrl: process.env.POLYMARKET_PROXY_URL ?? 'http://127.0.0.1:7890',
  mexcAutomationEnabled: false,
  polymarketLiveEnabled: false,
  allowUnprofitableTestTrade: false,
  autoOpenEnabled: false,
  autoOpenQuantityMode: 'FIXED',
  autoOpenFixedQuantity: '5.00',
  autoOpenMaxQuantityPct: 80,
  maxRecoveryLossUsdt: '2.00',
  polymarketHedgeRetryCount: 8,
  polymarketHedgeMode: 'PROTECTED_MARKET',
  manualExecutionConditions: defaultManualExecutionConditions(),
  autoOpenStabilityMs: 100
}

const TEST_TRADE_CAPITAL_FLOOR = new Decimal(5)
const TEST_TRADE_CAPITAL_HARD_LIMIT = new Decimal(12)
const MEXC_MIN_NOTIONAL = new Decimal(1)
const POLYMARKET_MIN_BUY_AMOUNT = new Decimal(1)
const POLYMARKET_MAX_ORDER_PRICE = new Decimal('0.99')

function aggregateFills(fills: Fill[], direction: Direction): Fill | undefined {
  if (fills.length === 0) return undefined
  const quantity = Decimal.sum(0, ...fills.map((fill) => new Decimal(fill.quantity || 0)))
  if (quantity.lte(0)) return undefined
  const cost = Decimal.sum(0, ...fills.map((fill) => new Decimal(fill.quantity || 0).mul(fill.averagePrice || 0)))
  const verificationSources = [...new Set(fills.map((fill) => fill.verificationSource).filter(Boolean))]
  return {
    venue: 'POLYMARKET',
    direction,
    quantity: quantity.toDecimalPlaces(6).toString(),
    averagePrice: cost.div(quantity).toDecimalPlaces(6).toString(),
    orderId: fills.map((fill) => fill.orderId).join(','),
    filledAt: Math.max(...fills.map((fill) => fill.filledAt)),
    verificationSource: verificationSources.length === 1 ? verificationSources[0] : undefined
  }
}

export class AppController {
  private settings: RiskSettings = DEFAULT_SETTINGS
  private opportunities: Opportunity[] = []
  private activeSession?: ExecutionSession
  private activeOpportunity?: Opportunity
  private recentEvents: ExecutionEvent[] = []
  private orderHistory: ArbitrageOrderRecord[] = []
  private broadcast: (snapshot: AppSnapshot) => void = () => undefined
  private readonly simulatedBroker: PolymarketBroker = new SimulatedPolymarketBroker()
  private mexcDataMessage = '尚未读取 MEXC 盘口'
  private polymarketDataMessage = '尚未连接 Polymarket 公共 API'
  private refreshing?: Promise<AppSnapshot>
  private latestMexcWindows: MexcWindowQuote[] = []
  private latestPolymarketWindows: PolymarketWindowQuote[] = []
  private streamRefreshTimer?: NodeJS.Timeout
  private closingOrderId?: string
  private activeExecutionPlan?: ExecutionPlan
  private autoOpenState: AutoOpenState = { status: 'OFF', message: '自动开单未启用', since: Date.now() }
  private autoOpenTimer?: NodeJS.Timeout
  private autoOpenCandidateId?: string
  private autoOpenAttempting = false
  private autoOpenLastAttemptAt = 0
  private autoOpenedRounds = new Set<string>()
  private autoOpenLastFingerprint?: string
  private capacityRefreshTimer?: NodeJS.Timeout
  private licenseActive = false

  constructor(
    private readonly store: EventStore,
    private readonly mexcBrowser: MexcBrowserManager,
    private readonly polymarketData = new PolymarketMarketData(),
    private readonly liveBroker?: PolymarketLiveBroker,
    private readonly liveExecutionEnabled = process.env.ARB_ENABLE_LIVE_EXECUTION === 'true'
  ) {
    this.mexcBrowser.onMarketData?.(() => this.scheduleStreamingSnapshot())
    this.polymarketData.onMarketData?.(() => this.scheduleStreamingSnapshot())
  }

  async initialize(): Promise<void> {
    await this.store.initialize()
    this.settings = await this.store.loadSettings(DEFAULT_SETTINGS)
    this.settings.manualExecutionConditions = defaultManualExecutionConditions(this.settings.manualExecutionConditions)
    this.settings.autoOpenEnabled = false
    try {
      this.settings = {
        ...this.settings,
        settlementDistanceRules: normalizeSettlementDistanceRules(this.settings.settlementDistanceRules)
      }
    } catch {
      this.settings = { ...this.settings, settlementDistanceRules: defaultSettlementDistanceRules() }
      await this.store.saveSettings(this.settings)
    }
    if (this.settings.maxQuoteAgeMs <= 6_000) {
      this.settings = { ...this.settings, maxQuoteAgeMs: 8_000 }
      await this.store.saveSettings(this.settings)
    }
    if (!this.settings.hubstudioContainerCode) {
      this.settings = {
        ...this.settings,
        mexcBrowserMode: 'HUBSTUDIO',
        hubstudioContainerCode: DEFAULT_SETTINGS.hubstudioContainerCode
      }
      await this.store.saveSettings(this.settings)
    }
    this.mexcBrowser.configure({
      mode: this.settings.mexcBrowserMode,
      hubstudioContainerCode: this.settings.hubstudioContainerCode,
      elementMode: this.settings.mexcElementMode
    })
    this.polymarketData.configureProxy(this.settings.polymarketProxyUrl)
    this.liveBroker?.configureProxy(this.settings.polymarketProxyUrl)
    this.recentEvents = await this.store.loadRecentEvents(80)
    this.orderHistory = (await this.store.loadOrderHistory()).map((order) => {
      const interrupted = order.status === 'OPENING' ||
        ['MEXC_CLOSING', 'MEXC_CLOSE_SUBMITTED', 'POLY_CLOSING'].includes(order.executionState)
      if (!interrupted) return this.expireOrderIfElapsed(order)
      const message = '应用上次在订单执行过程中退出；请先核对两边实际持仓'
      const normalized: ArbitrageOrderRecord = {
        ...order,
        status: 'RECOVERY_REQUIRED',
        executionState: 'RECOVERY_REQUIRED',
        closeOperation: order.closeOperation
          ? { ...order.closeOperation, state: 'RECOVERY_REQUIRED', updatedAt: Date.now(), error: message }
          : undefined,
        updatedAt: Date.now()
      }
      return this.expireOrderIfElapsed(normalized)
    })
    await this.store.saveOrderHistory(this.orderHistory)
    this.opportunities = []
    this.syncCapacityRefreshTimer()
  }

  setBroadcaster(broadcast: (snapshot: AppSnapshot) => void): void {
    this.broadcast = broadcast
  }

  setLicenseActive(active: boolean): void {
    if (this.licenseActive === active) return
    this.licenseActive = active
    this.syncCapacityRefreshTimer()
  }

  getSnapshot(): AppSnapshot {
    const now = Date.now()
    this.normalizeExpiredOrders(now)
    const mexcStatus = this.mexcBrowser.getStatus()
    const settlementFeedConnected = this.opportunities.some((opportunity) => Boolean(opportunity.polymarketSignal))
    return {
      generatedAt: now,
      connection: {
        mexc: mexcStatus.open ? 'BROWSER_READY' : 'DISCONNECTED',
        polymarket: this.polymarketData.getStatus().connected ? 'CONNECTED' : 'DISCONNECTED',
        chainlink: settlementFeedConnected ? 'CONNECTED' : 'DISCONNECTED'
      },
      connectionDetails: {
        mexc: this.mexcDataMessage,
        polymarket: this.polymarketDataMessage,
        chainlink: settlementFeedConnected
          ? '已读取Polymarket官方BTC参考价与基准价；用于结算源方向和距离风控'
          : '尚未取得Polymarket官方BTC参考价；结算源风控会禁止执行'
      },
      settings: this.settings,
      opportunities: this.opportunities,
      orderHistory: this.orderHistory,
      activeSession: this.activeSessionForSnapshot(now),
      recentEvents: this.recentEvents,
      autoOpenState: this.autoOpenState
    }
  }

  hasRecoverableExposure(): boolean {
    const now = Date.now()
    this.normalizeExpiredOrders(now)
    if (this.hasActionableActiveSession(now)) return true
    return this.orderHistory.some((order) => this.hasActionableOrderExposure(order, now))
  }

  getEmergencyAccessSnapshot(): EmergencyAccessSnapshot {
    const now = Date.now()
    this.normalizeExpiredOrders(now)
    return {
      activeSession: this.hasActionableActiveSession(now) ? this.activeSession : undefined,
      orders: this.orderHistory.filter((order) => this.hasActionableOrderExposure(order, now))
    }
  }

  private expireOrderIfElapsed(order: ArbitrageOrderRecord, now = Date.now()): ArbitrageOrderRecord {
    if (
      order.endTime > now ||
      ['CLOSED', 'CANCELLED', 'EXPIRED'].includes(order.status)
    ) return order
    return { ...order, status: 'EXPIRED' }
  }

  private normalizeExpiredOrders(now = Date.now()): void {
    this.orderHistory = this.orderHistory.map((order) => this.expireOrderIfElapsed(order, now))
  }

  private hasActionableActiveSession(now: number): boolean {
    if (!this.activeSession || ['HEDGED', 'CANCELLED', 'CLOSED'].includes(this.activeSession.state)) return false
    const order = this.orderHistory.find((candidate) => candidate.id === this.activeSession?.id)
    if (!order) return true
    return order.endTime > now && order.status !== 'EXPIRED'
  }

  private activeSessionForSnapshot(now: number): ExecutionSession | undefined {
    if (!this.activeSession) return undefined
    const order = this.orderHistory.find((candidate) => candidate.id === this.activeSession?.id)
    if (order && (order.endTime <= now || order.status === 'EXPIRED')) return undefined
    return this.activeSession
  }

  private hasActionableOrderExposure(order: ArbitrageOrderRecord, now: number): boolean {
    if (order.endTime <= now || ['CLOSED', 'CANCELLED', 'EXPIRED'].includes(order.status)) return false
    return order.status === 'RECOVERY_REQUIRED' ||
      new Decimal(order.mexc.openQuantity || 0).gt(0) ||
      new Decimal(order.polymarket.openQuantity || 0).gt(0)
  }

  async refreshOpportunities(): Promise<AppSnapshot> {
    if (this.refreshing) return await this.refreshing
    this.refreshing = this.loadLiveOpportunities()
    try {
      return await this.refreshing
    } finally {
      this.refreshing = undefined
    }
  }

  async testPolymarketConnection(): Promise<AppSnapshot> {
    try {
      const status = await this.polymarketData.testConnection()
      this.polymarketDataMessage = status.message
    } catch (error) {
      this.polymarketDataMessage = this.polymarketData.getStatus().message
      const snapshot = this.getSnapshot()
      this.broadcast(snapshot)
      throw error
    }
    const snapshot = this.getSnapshot()
    this.broadcast(snapshot)
    return snapshot
  }

  async updateSettings(request: UpdateSettingsRequest): Promise<RiskSettings> {
    const previousAutoOpenEnabled = this.settings.autoOpenEnabled
    const next = {
      ...this.settings,
      ...request,
      manualExecutionConditions: defaultManualExecutionConditions({
        ...this.settings.manualExecutionConditions,
        ...request.manualExecutionConditions
      })
    }
    const autoSensitiveSettings: Array<keyof RiskSettings> = [
      'mode', 'maxCapitalPerTrade', 'minConditionalReturnPct', 'maxQuoteAgeMs',
      'maxHedgeSlippage', 'stopBeforeExpirySeconds', 'settlementDistanceRules', 'mexcBrowserMode',
      'mexcElementMode', 'hubstudioContainerCode', 'polymarketProxyUrl', 'mexcAutomationEnabled',
      'polymarketLiveEnabled', 'allowUnprofitableTestTrade', 'autoOpenQuantityMode',
      'autoOpenFixedQuantity', 'autoOpenMaxQuantityPct', 'maxRecoveryLossUsdt',
      'polymarketHedgeRetryCount', 'polymarketHedgeMode', 'autoOpenStabilityMs'
    ]
    if (
      this.settings.autoOpenEnabled && request.autoOpenEnabled === undefined &&
      autoSensitiveSettings.some((key) => Object.prototype.hasOwnProperty.call(request, key))
    ) next.autoOpenEnabled = false
    next.settlementDistanceRules = normalizeSettlementDistanceRules(next.settlementDistanceRules)
    const maximumCapital = new Decimal(next.maxCapitalPerTrade)
    if (!maximumCapital.isFinite() || maximumCapital.lte(0) || maximumCapital.gt(1_000_000)) {
      throw new Error('单笔最大本金须为大于0且不超过1,000,000 USDT的数值')
    }
    next.maxCapitalPerTrade = maximumCapital.toDecimalPlaces(2).toFixed(2)
    const minimumReturn = new Decimal(next.minConditionalReturnPct)
    if (!minimumReturn.isFinite() || minimumReturn.lt(0) || minimumReturn.gt(100)) {
      throw new Error('最低条件收益率须为0至100之间的百分比')
    }
    next.minConditionalReturnPct = minimumReturn.toDecimalPlaces(2).toFixed(2)
    const maximumHedgeSlippage = new Decimal(next.maxHedgeSlippage)
    if (!maximumHedgeSlippage.isFinite() || maximumHedgeSlippage.lt(0) || maximumHedgeSlippage.gt('0.5')) {
      throw new Error('Polymarket最大加价须为0至0.50之间的价格数值')
    }
    next.maxHedgeSlippage = maximumHedgeSlippage.toDecimalPlaces(4).toFixed(4)
    if (!Number.isInteger(next.maxQuoteAgeMs) || next.maxQuoteAgeMs < 3_000 || next.maxQuoteAgeMs > 30_000) {
      throw new Error('行情最长未确认时间须为3至30秒的整数')
    }
    if (!Number.isFinite(next.opportunitySoundVolume) || next.opportunitySoundVolume < 0 || next.opportunitySoundVolume > 1) {
      throw new Error('提示音音量须在0至1之间')
    }
    if (!Number.isInteger(next.opportunitySoundCooldownSeconds) || next.opportunitySoundCooldownSeconds < 5 || next.opportunitySoundCooldownSeconds > 3_600) {
      throw new Error('提示音冷却时间须为5至3600秒的整数')
    }
    const autoFixedQuantity = new Decimal(next.autoOpenFixedQuantity)
    if (!autoFixedQuantity.isFinite() || autoFixedQuantity.lte(0) || autoFixedQuantity.gt(1_000_000)) {
      throw new Error('自动开单固定份额须为大于0的数值')
    }
    next.autoOpenFixedQuantity = autoFixedQuantity.toDecimalPlaces(2).toFixed(2)
    if (!Number.isInteger(next.autoOpenMaxQuantityPct) || next.autoOpenMaxQuantityPct < 10 || next.autoOpenMaxQuantityPct > 100) {
      throw new Error('自动开单最大量比例须为10至100的整数百分比')
    }
    const maximumRecoveryLoss = new Decimal(next.maxRecoveryLossUsdt)
    if (!maximumRecoveryLoss.isFinite() || maximumRecoveryLoss.lt(0) || maximumRecoveryLoss.gt(10_000)) {
      throw new Error('恢复对冲最大可接受亏损须为0至10,000 USDT')
    }
    next.maxRecoveryLossUsdt = maximumRecoveryLoss.toDecimalPlaces(2).toFixed(2)
    if (!Number.isInteger(next.polymarketHedgeRetryCount) || next.polymarketHedgeRetryCount < 0 || next.polymarketHedgeRetryCount > 20) {
      throw new Error('Polymarket自动补单次数须为0至20的整数')
    }
    if (!['PROTECTED_LIMIT', 'PROTECTED_MARKET'].includes(next.polymarketHedgeMode)) {
      throw new Error('Polymarket第二腿对冲速度无效')
    }
    if (Object.values(next.manualExecutionConditions).some((enabled) => typeof enabled !== 'boolean')) {
      throw new Error('手动下单条件开关无效')
    }
    if (!Number.isInteger(next.autoOpenStabilityMs) || next.autoOpenStabilityMs < 0 || next.autoOpenStabilityMs > 1_000) {
      throw new Error('自动开单稳定时间须为0至1000毫秒的整数')
    }
    if (next.mode !== 'ASSISTED' || !next.mexcAutomationEnabled || !next.polymarketLiveEnabled || next.allowUnprofitableTestTrade) {
      next.autoOpenEnabled = false
    }
    if (next.autoOpenEnabled && !this.liveExecutionEnabled) throw new Error('当前构建未启用真实执行，不能开启自动开单')
    next.hubstudioContainerCode = next.hubstudioContainerCode.trim()
    next.polymarketProxyUrl = next.polymarketProxyUrl.trim()
    if (next.polymarketProxyUrl) {
      let proxyUrl: URL
      try {
        proxyUrl = new URL(next.polymarketProxyUrl)
      } catch {
        throw new Error('Polymarket 代理地址格式无效')
      }
      if (!['http:', 'https:'].includes(proxyUrl.protocol)) throw new Error('当前仅支持 HTTP/HTTPS 代理')
    }
    if (next.mode === 'LIVE' && !this.liveExecutionEnabled) {
      throw new Error('实盘总开关未启用。开发环境请使用 npm run dev:live；正式安装包会自动启用该能力')
    }
    if (next.mexcAutomationEnabled) {
      if (next.mode !== 'ASSISTED') throw new Error('MEXC自动点击只允许在人工监督模式启用')
      if (next.mexcElementMode === 'MANUAL') {
        const calibration = this.mexcBrowser.getCalibration(next.mexcBrowserMode)
        if (!Object.values(calibration).every(Boolean)) throw new Error('手动校准模式需要完成金额框、UP、DOWN和提交按钮的全部校准')
      }
    }
    if (next.polymarketLiveEnabled) {
      if (next.mode !== 'ASSISTED') throw new Error('Polymarket真实对冲只允许在人工监督模式启用')
      if (!this.liveExecutionEnabled) {
        throw new Error('实盘总开关未启用；开发环境请用 npm run dev:live 启动ArbDesk')
      }
      if (!this.liveBroker || !await this.liveBroker.isConfigured()) {
        throw new Error('请先派生并加密保存Polymarket交易身份')
      }
    }
    if (next.allowUnprofitableTestTrade && next.mode !== 'ASSISTED') {
      throw new Error('小额亏损联调只允许在人工监督模式启用')
    }
    this.settings = next
    this.mexcBrowser.configure({
      mode: next.mexcBrowserMode,
      hubstudioContainerCode: next.hubstudioContainerCode,
      elementMode: next.mexcElementMode
    })
    this.polymarketData.configureProxy(next.polymarketProxyUrl)
    this.liveBroker?.configureProxy(next.polymarketProxyUrl)
    await this.store.saveSettings(next)
    this.syncCapacityRefreshTimer()
    if (next.autoOpenEnabled !== previousAutoOpenEnabled) {
      this.setAutoOpenState(next.autoOpenEnabled ? 'MONITORING' : 'OFF', next.autoOpenEnabled ? '自动开单已布防，等待全部条件满足' : '自动开单未启用')
      if (!next.autoOpenEnabled) this.clearAutoOpenCandidate()
    }
    if (next.autoOpenEnabled) this.evaluateAutoOpen()
    this.broadcast(this.getSnapshot())
    return next
  }

  async disarmAutoOpen(message = '自动开单已停用'): Promise<void> {
    if (!this.settings.autoOpenEnabled) return
    this.settings = { ...this.settings, autoOpenEnabled: false }
    this.clearAutoOpenCandidate()
    this.setAutoOpenState('OFF', message)
    await this.store.saveSettings(this.settings)
    this.broadcast(this.getSnapshot())
  }

  async execute(request: ExecuteRequest): Promise<ExecutionSession> {
    const executeRequestedAt = Date.now()
    const triggerSource = request.source ?? (this.settings.allowUnprofitableTestTrade ? 'TEST' : 'MANUAL')
    let quotesConfirmedAt = executeRequestedAt
    if (this.closingOrderId) throw new Error('平仓流程正在执行，不能同时开新仓')
    if (this.hasActionableActiveSession(executeRequestedAt)) {
      throw new Error('已有执行中的套利组，不能重复开仓')
    }
    let opportunity = this.opportunities.find((candidate) => candidate.id === request.opportunityId)
    if (!opportunity || opportunity.endTime <= Date.now()) {
      await this.refreshOpportunities()
      opportunity = this.opportunities.find((candidate) => candidate.id === request.opportunityId)
    } else {
      if (!opportunity.polymarketTokenId) throw new Error('Polymarket所选盘口缺少token，无法复核')
      if (this.executionConditionEnabled('quoteFreshness', triggerSource)) {
        await Promise.all([
          this.mexcBrowser.confirmMarketQuote?.(opportunity.mexcSymbolId),
          this.polymarketData.confirmOutcomeQuote?.(opportunity.polymarketTokenId)
        ])
      }
      quotesConfirmedAt = Date.now()
      const mexcWindows = this.mexcBrowser.getLatestWindows?.() ?? this.latestMexcWindows
      const polymarketWindows = this.polymarketData.getLatestWindows?.() ?? this.latestPolymarketWindows
      if (mexcWindows.length > 0 && polymarketWindows.length > 0) {
        this.latestMexcWindows = mexcWindows
        this.latestPolymarketWindows = polymarketWindows
        this.opportunities = this.combineLiveQuotes(mexcWindows, polymarketWindows)
        this.broadcast(this.getSnapshot())
      }
      opportunity = this.opportunities.find((candidate) => candidate.id === request.opportunityId)
    }
    if (!opportunity) throw new Error('机会已失效，请刷新后重试')
    const executionPlan = await this.calculateExecutionPlanInternal(opportunity, request.quantity, false, triggerSource)
    this.validateExecution(opportunity, request.quantity, executionPlan, triggerSource)
    this.activeExecutionPlan = executionPlan

    this.activeSession = {
      id: randomUUID(),
      opportunityId: opportunity.id,
      requestedQuantity: new Decimal(request.quantity).toFixed(2),
      state: 'IDLE',
      mode: this.settings.mode,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      timings: {
        executeRequestedAt,
        quotesConfirmedAt,
        planConfirmedAt: Date.now()
      }
    }
    this.activeOpportunity = opportunity
    const orderRecord: ArbitrageOrderRecord = {
      id: this.activeSession.id,
      opportunityId: opportunity.id,
      symbol: opportunity.symbol,
      durationMinutes: opportunity.durationMinutes,
      startTime: opportunity.startTime,
      endTime: opportunity.endTime,
      mode: this.settings.mode,
      triggerSource,
      status: 'OPENING',
      executionState: 'IDLE',
      requestedQuantity: this.activeSession.requestedQuantity,
      expectedCapital: executionPlan.capitalRequired,
      expectedProfit: executionPlan.expectedProfit,
      createdAt: this.activeSession.startedAt,
      updatedAt: this.activeSession.updatedAt,
      mexc: {
        venue: 'MEXC', direction: opportunity.mexcDirection, eventId: opportunity.mexcEventId,
        symbolId: opportunity.mexcSymbolId, closeFills: [], openQuantity: '0'
      },
      polymarket: {
        venue: 'POLYMARKET', direction: opportunity.polymarketDirection, tokenId: opportunity.polymarketTokenId,
        closeFills: [], openQuantity: '0'
      }
    }
    this.orderHistory = [orderRecord, ...this.orderHistory].slice(0, 500)
    await this.store.saveOrderHistory(this.orderHistory)
    if (this.settings.allowUnprofitableTestTrade) {
      this.settings = { ...this.settings, allowUnprofitableTestTrade: false }
      await this.store.saveSettings(this.settings)
      this.broadcast(this.getSnapshot())
    }
    await this.transition('MEXC_OPENING', '正在准备MEXC第一腿')

    if (this.settings.mode === 'SIMULATION') {
      await this.transition('MEXC_SUBMITTING', '模拟发送MEXC订单')
      await new Promise((resolve) => setTimeout(resolve, 260))
      const fill: Fill = {
        venue: 'MEXC',
        direction: opportunity.mexcDirection,
        quantity: this.activeSession.requestedQuantity,
        averagePrice: opportunity.mexcPrice,
        orderId: `sim-mexc-${randomUUID()}`,
        filledAt: Date.now(),
        verificationSource: 'SIMULATED'
      }
      this.activeSession.mexcFill = fill
      await this.transition('MEXC_FILLED', 'MEXC模拟订单已完全成交')
      await this.hedgePolymarket(opportunity, fill)
      return this.activeSession
    }

    await this.transition('MEXC_SUBMITTING', '正在打开MEXC监督窗口并准备网页订单')
    const result = await this.mexcBrowser.prepareOrder({
      direction: opportunity.mexcDirection,
      amount: executionPlan.mexcSpend,
      allowSubmit: this.settings.mexcAutomationEnabled,
      durationMinutes: opportunity.durationMinutes,
      startTime: opportunity.startTime,
      eventId: opportunity.mexcEventId
    })
    this.activeSession.timings = {
      ...this.activeSession.timings!,
      mexcPageReadyAt: result.pageReadyAt,
      mexcDirectionReadyAt: result.directionReadyAt,
      mexcButtonReadyAt: result.buttonReadyAt,
      mexcSubmittedAt: result.submittedAt,
      mexcAcceptedAt: result.responseAt ?? Date.now()
    }
    const automaticSubmissionFailed = this.settings.mexcAutomationEnabled && (!result.ok || !result.orderAccepted)
    if (automaticSubmissionFailed) {
      const message = result.ok
        ? 'MEXC网页操作完成，但没有取得本次订单成功回执；未启动Polymarket对冲'
        : result.message
      this.activeSession.error = message
      await this.transition(
        result.submissionUncertain ? 'RECOVERY_REQUIRED' : 'CANCELLED',
        message,
        { automationMatched: result.ok, orderAccepted: false }
      )
      return this.activeSession
    }
    await this.transition('MEXC_SUBMITTED', result.message, {
      automationMatched: result.ok,
      orderAccepted: result.orderAccepted ?? false
    })
    if (this.settings.polymarketLiveEnabled) {
      const automaticAccepted = this.settings.mexcAutomationEnabled && result.ok && result.orderAccepted
      const awaitingManualClick = !this.settings.mexcAutomationEnabled
      if (automaticAccepted || awaitingManualClick) {
        const submittedAfter = (result.submittedAt ?? Date.now()) - 2_000
        void this.monitorMexcFill(opportunity, submittedAfter, awaitingManualClick ? 120_000 : 90_000)
      }
    }
    return this.activeSession
  }

  async confirmMexcFill(fill: ConfirmMexcFillRequest): Promise<ExecutionSession> {
    const orderId = fill.orderId.trim()
    if (!fill.manualAcknowledged) throw new Error('请先确认已经在MEXC成交记录中核对数量、均价和真实订单号')
    if (!orderId || orderId.toLowerCase() === 'manual-confirm') {
      throw new Error('人工强制录入必须填写MEXC成交记录中的真实订单号')
    }
    return await this.completeMexcFill(fill, false)
  }

  private async completeMexcFill(
    fill: Pick<Fill, 'quantity' | 'averagePrice' | 'orderId'> & Partial<Pick<Fill, 'filledAt'>>,
    trustedReadback: boolean
  ): Promise<ExecutionSession> {
    if (!this.activeSession) throw new Error('当前没有等待确认的套利组')
    if (!['MEXC_SUBMITTED', 'MEXC_SUBMITTING'].includes(this.activeSession.state)) {
      throw new Error(`当前状态 ${this.activeSession.state} 不能确认MEXC成交`)
    }
    const opportunity = this.activeOpportunity ?? this.opportunities.find((item) => item.id === this.activeSession?.opportunityId)
    if (!opportunity) throw new Error('原机会已经不存在')

    const quantity = new Decimal(fill.quantity)
    if (quantity.lte(0) || (!trustedReadback && quantity.gt(this.activeSession.requestedQuantity))) {
      throw new Error('实际成交数量必须大于0且不能超过委托数量')
    }
    const mexcFill: Fill = {
      venue: 'MEXC',
      direction: opportunity.mexcDirection,
      quantity: quantity.toFixed(2),
      averagePrice: new Decimal(fill.averagePrice).toFixed(4),
      orderId: fill.orderId.trim(),
      filledAt: fill.filledAt ?? Date.now(),
      verificationSource: trustedReadback ? 'PLATFORM_READBACK' : 'MANUAL_ENTRY'
    }
    this.activeSession.mexcFill = mexcFill
    if (this.activeSession.timings) this.activeSession.timings.mexcFillDetectedAt = Date.now()
    const state: ExecutionState = quantity.eq(this.activeSession.requestedQuantity) ? 'MEXC_FILLED' : 'MEXC_PARTIAL'
    const sourceLabel = trustedReadback ? 'MEXC平台回读' : '人工强制录入（未经平台回读）'
    await this.transition(state, `${sourceLabel}：${state === 'MEXC_FILLED' ? '完全成交' : '部分成交'}`)
    await this.hedgePolymarket(opportunity, mexcFill)
    return this.activeSession
  }

  private async monitorMexcFill(opportunity: Opportunity, submittedAfter: number, timeoutMs = 90_000): Promise<void> {
    try {
      const fill = await this.mexcBrowser.waitForFill({
        eventId: opportunity.mexcEventId,
        symbolId: opportunity.mexcSymbolId,
        direction: opportunity.mexcDirection,
        submittedAfter
      }, timeoutMs)
      if (!this.activeSession || this.activeSession.opportunityId !== opportunity.id) return
      if (!['MEXC_SUBMITTED', 'MEXC_SUBMITTING'].includes(this.activeSession.state)) return
      if (!fill) {
        this.activeSession.error = `MEXC成交回读在${Math.round(timeoutMs / 1_000)}秒内没有检测到本轮真实成交；请核对MEXC成交记录，必要时使用人工强制录入`
        this.broadcast(this.getSnapshot())
        return
      }
      await this.completeMexcFill(fill, true)
    } catch (error) {
      if (!this.activeSession || this.activeSession.opportunityId !== opportunity.id) return
      if (!['MEXC_SUBMITTED', 'MEXC_SUBMITTING'].includes(this.activeSession.state)) return
      this.activeSession.error = `MEXC自动成交读取失败：${error instanceof Error ? error.message : String(error)}`
      this.broadcast(this.getSnapshot())
    }
  }

  async cancelExecution(): Promise<ExecutionSession | undefined> {
    if (!this.activeSession) return undefined
    if (!['IDLE', 'MEXC_OPENING', 'MEXC_SUBMITTED'].includes(this.activeSession.state)) {
      throw new Error('已有成交或正在对冲，不能直接取消；请进入恢复流程')
    }
    await this.transition('CANCELLED', '用户取消本次执行')
    return this.activeSession
  }

  async retryPolymarketHedge(request: RetryPolymarketHedgeRequest = {}): Promise<ExecutionSession> {
    if (
      !this.activeSession ||
      this.activeSession.state !== 'RECOVERY_REQUIRED' ||
      !this.hasActionableActiveSession(Date.now())
    ) {
      throw new Error('当前没有可重试的Polymarket剩余对冲')
    }
    const opportunity = this.activeOpportunity ?? this.opportunities.find((item) => item.id === this.activeSession?.opportunityId)
    if (!opportunity || !this.activeSession.mexcFill) throw new Error('恢复所需的原机会或MEXC成交记录已经丢失')
    this.activeSession.error = undefined
    const hedgeMode = request.mode === 'EMERGENCY_MARKET'
      ? 'PROTECTED_MARKET'
      : request.mode === 'PROTECTED'
        ? 'PROTECTED_LIMIT'
        : this.settings.polymarketHedgeMode
    await this.hedgePolymarket(opportunity, this.activeSession.mexcFill, true, hedgeMode)
    return this.activeSession
  }

  async closeOrder(request: CloseOrderRequest): Promise<ArbitrageOrderRecord> {
    if (this.closingOrderId) throw new Error('已有平仓流程正在执行，请等待完成或进入恢复状态')
    if (!['MEXC', 'POLYMARKET', 'BOTH'].includes(request.target)) throw new Error('平仓目标无效')
    const order = this.orderHistory.find((candidate) => candidate.id === request.orderId)
    if (!order) throw new Error('未找到对应套利订单')
    if (
      this.activeSession && !['HEDGED', 'CANCELLED'].includes(this.activeSession.state) &&
      !(this.activeSession.state === 'RECOVERY_REQUIRED' && this.activeSession.id === order.id)
    ) throw new Error('当前仍有开仓或对冲流程，不能同时执行平仓')
    if (['CLOSED', 'CANCELLED', 'EXPIRED'].includes(order.status)) throw new Error('该订单已经没有可平持仓')
    if (Date.now() >= order.endTime) throw new Error('该市场已经到期，不能提交中途平仓')
    const closeMexc = request.target === 'MEXC' || request.target === 'BOTH'
    const closePolymarket = request.target === 'POLYMARKET' || request.target === 'BOTH'
    if (closeMexc && new Decimal(order.mexc.openQuantity).lte(0)) throw new Error('该订单没有可平的MEXC持仓')
    if (closePolymarket && new Decimal(order.polymarket.openQuantity).lte(0)) throw new Error('该订单没有可平的Polymarket持仓')
    if (closeMexc && order.mode !== 'SIMULATION') {
      if (!this.settings.mexcAutomationEnabled) throw new Error('请先启用MEXC实验自动点击，再执行自动卖出')
      if (this.settings.mexcBrowserMode !== 'HUBSTUDIO') throw new Error('MEXC自动卖出当前要求Hubstudio模式')
      if (this.settings.mexcElementMode !== 'AUTO') throw new Error('MEXC自动卖出当前要求系统自动识别模式')
    }
    if (closePolymarket && order.mode !== 'SIMULATION' && !this.settings.polymarketLiveEnabled) {
      throw new Error('请先启用Polymarket真实FOK，再执行SELL平仓')
    }

    this.closingOrderId = order.id
    const operationId = randomUUID()
    let working: ArbitrageOrderRecord = {
      ...order,
      closeOperation: {
        id: operationId, target: request.target, state: closeMexc ? 'MEXC_CLOSING' : 'POLY_CLOSING',
        startedAt: Date.now(), updatedAt: Date.now()
      },
      executionState: closeMexc ? 'MEXC_CLOSING' : 'POLY_CLOSING',
      updatedAt: Date.now()
    }
    await this.replaceOrderRecord(working)
    let mexcClosedThisOperation: Decimal | undefined
    try {
      if (closeMexc) {
        await this.appendOrderEvent(order.id, 'MEXC_CLOSING', `正在自动卖出MEXC ${order.mexc.openQuantity}份 ${order.mexc.direction}`)
        let fill: Fill
        if (order.mode === 'SIMULATION') {
          fill = {
            venue: 'MEXC', direction: order.mexc.direction, quantity: order.mexc.openQuantity,
            averagePrice: order.mexc.entryFill?.averagePrice ?? '0.5', orderId: `sim-mexc-close-${randomUUID()}`, filledAt: Date.now(),
            verificationSource: 'SIMULATED'
          }
        } else {
          const result = await this.mexcBrowser.closePosition({
            eventId: order.mexc.eventId ?? '', symbolId: order.mexc.symbolId ?? '', direction: order.mexc.direction,
            quantity: order.mexc.openQuantity, durationMinutes: order.durationMinutes, startTime: order.startTime,
            allowSubmit: true
          })
          if (!result.ok || !result.orderAccepted || !result.submittedAt) throw new Error(result.message)
          working = {
            ...working,
            executionState: 'MEXC_CLOSE_SUBMITTED',
            closeOperation: { ...working.closeOperation!, state: 'MEXC_CLOSE_SUBMITTED', updatedAt: Date.now() },
            updatedAt: Date.now()
          }
          await this.replaceOrderRecord(working)
          await this.appendOrderEvent(order.id, 'MEXC_CLOSE_SUBMITTED', result.message)
          const captured = await this.mexcBrowser.waitForFill({
            eventId: order.mexc.eventId ?? '', symbolId: order.mexc.symbolId,
            direction: order.mexc.direction, submittedAfter: result.submittedAt - 1_500
          })
          if (!captured) throw new Error('MEXC卖出已提交，但90秒内没有读取到实际成交；请在MEXC核对后进入恢复处理')
          fill = captured
        }
        const closedQuantity = Decimal.min(order.mexc.openQuantity, fill.quantity)
        mexcClosedThisOperation = closedQuantity
        working = {
          ...working,
          mexc: {
            ...working.mexc,
            closeFills: [...working.mexc.closeFills, { ...fill, quantity: closedQuantity.toString() }],
            openQuantity: Decimal.max(new Decimal(working.mexc.openQuantity).minus(closedQuantity), 0).toString()
          },
          updatedAt: Date.now()
        }
        await this.replaceOrderRecord(working)
      }

      if (closePolymarket) {
        working = {
          ...working,
          executionState: 'POLY_CLOSING',
          closeOperation: { ...working.closeOperation!, state: 'POLY_CLOSING', updatedAt: Date.now() },
          updatedAt: Date.now()
        }
        await this.replaceOrderRecord(working)
        const polymarketCloseQuantity = request.target === 'BOTH' && mexcClosedThisOperation
          ? Decimal.min(working.polymarket.openQuantity, mexcClosedThisOperation)
          : new Decimal(working.polymarket.openQuantity)
        if (polymarketCloseQuantity.lte(0)) throw new Error('MEXC本次没有可用于对齐的实际平仓成交量，已停止Polymarket SELL')
        await this.appendOrderEvent(order.id, 'POLY_CLOSING', `正在SELL FOK平仓Polymarket ${polymarketCloseQuantity.toString()}份 ${working.polymarket.direction}`)
        const broker = order.mode === 'SIMULATION' ? this.simulatedBroker : this.liveBroker
        if (!broker) throw new Error('Polymarket真实平仓代理不可用')
        const fill = await broker.closePosition({
          tokenId: working.polymarket.tokenId,
          direction: working.polymarket.direction,
          quantity: polymarketCloseQuantity.toString(),
          maximumSlippage: this.settings.maxHedgeSlippage
        })
        const closedQuantity = Decimal.min(polymarketCloseQuantity, fill.quantity)
        working = {
          ...working,
          polymarket: {
            ...working.polymarket,
            closeFills: [...working.polymarket.closeFills, { ...fill, quantity: closedQuantity.toString() }],
            openQuantity: Decimal.max(new Decimal(working.polymarket.openQuantity).minus(closedQuantity), 0).toString()
          },
          updatedAt: Date.now()
        }
      }

      const mexcOpen = new Decimal(working.mexc.openQuantity).gt(0)
      const polymarketOpen = new Decimal(working.polymarket.openQuantity).gt(0)
      const quantitiesAligned = new Decimal(working.mexc.openQuantity).eq(working.polymarket.openQuantity)
      const status = !mexcOpen && !polymarketOpen
        ? 'CLOSED' as const
        : mexcOpen && polymarketOpen && quantitiesAligned
          ? 'OPEN' as const
          : 'UNHEDGED' as const
      working = {
        ...working,
        status,
        executionState: status === 'CLOSED' ? 'CLOSED' : status === 'UNHEDGED' ? 'UNHEDGED' : 'HEDGED',
        closeOperation: { ...working.closeOperation!, state: 'CLOSED', updatedAt: Date.now() },
        updatedAt: Date.now()
      }
      await this.replaceOrderRecord(working)
      await this.appendOrderEvent(order.id, status === 'CLOSED' ? 'CLOSED' : status === 'UNHEDGED' ? 'UNHEDGED' : 'HEDGED', status === 'CLOSED'
        ? '中途平仓完成，两边持仓均已归零'
        : `单腿平仓完成；剩余MEXC ${working.mexc.openQuantity}份 / Polymarket ${working.polymarket.openQuantity}份`)
      if (this.activeSession?.id === order.id) {
        this.activeSession = undefined
        this.activeOpportunity = undefined
      }
      return working
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      working = {
        ...working,
        status: 'RECOVERY_REQUIRED',
        executionState: 'RECOVERY_REQUIRED',
        closeOperation: { ...working.closeOperation!, state: 'RECOVERY_REQUIRED', updatedAt: Date.now(), error: message },
        updatedAt: Date.now()
      }
      await this.replaceOrderRecord(working)
      await this.appendOrderEvent(order.id, 'RECOVERY_REQUIRED', `平仓未完整完成：${message}`)
      throw new Error(message)
    } finally {
      this.closingOrderId = undefined
      this.broadcast(this.getSnapshot())
    }
  }

  private async replaceOrderRecord(updated: ArbitrageOrderRecord): Promise<void> {
    this.orderHistory = this.orderHistory.map((order) => order.id === updated.id ? updated : order)
    await this.store.saveOrderHistory(this.orderHistory)
    this.broadcast(this.getSnapshot())
  }

  private async appendOrderEvent(sessionId: string, state: ExecutionState, message: string): Promise<void> {
    const event: ExecutionEvent = { id: randomUUID(), sessionId, state, timestamp: Date.now(), message }
    this.recentEvents = [event, ...this.recentEvents].slice(0, 80)
    await this.store.appendEvent(event)
    this.broadcast(this.getSnapshot())
  }

  async calculateExecutionPlan(request: CalculateExecutionPlanRequest): Promise<ExecutionPlan> {
    const opportunity = this.opportunities.find((candidate) => candidate.id === request.opportunityId)
    if (!opportunity) throw new Error('所选机会已经失效')
    const first = await this.calculateExecutionPlanInternal(
      opportunity,
      request.useMaximum ? undefined : request.quantity,
      request.refreshStaleAccounts ?? false
    )
    if (!request.useMaximum) return first
    if (!(Number(first.maxExecutableQuantity) > 0)) {
      return {
        ...first,
        blockReason: first.limitingFactors.join('、') || first.blockReason
      }
    }
    return await this.calculateExecutionPlanInternal(
      opportunity,
      first.maxExecutableQuantity,
      false
    )
  }

  private async calculateExecutionPlanInternal(
    opportunity: Opportunity,
    quantity: string | undefined,
    refreshStaleAccounts: boolean,
    source: 'MANUAL' | 'AUTO' | 'TEST' = 'MANUAL'
  ): Promise<ExecutionPlan> {
    let mexcAccount = this.mexcBrowser.getCachedAccountState?.()
    let polymarketCapacity = this.liveBroker?.getCachedTradingCapacity?.()
    if (this.settings.mode === 'ASSISTED' && refreshStaleAccounts) {
      try {
        ;[mexcAccount, polymarketCapacity] = await Promise.all([
          this.mexcBrowser.ensureAccountBalance?.(30_000),
          this.liveBroker?.ensureTradingCapacity?.(30_000)
        ])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`轻量账户余额复核失败：${message}`)
      }
    }
    return this.buildExecutionPlan(opportunity, quantity, mexcAccount, polymarketCapacity, this.settings.mode === 'ASSISTED', source)
  }

  private buildExecutionPlan(
    opportunity: Opportunity,
    quantity: string | undefined,
    mexcAccount: MexcAccountState | undefined,
    polymarketCapacity: PolymarketTradingCapacity | undefined,
    requireBalances: boolean,
    source: 'MANUAL' | 'AUTO' | 'TEST' = 'MANUAL'
  ): ExecutionPlan {
    const mexcWindow = this.latestMexcWindows.find((window) => window.eventId === opportunity.mexcEventId)
    const mexcOutcome = mexcWindow?.outcomes[opportunity.mexcDirection]
    const polymarketWindow = this.latestPolymarketWindows.find((window) =>
      window.durationMinutes === opportunity.durationMinutes &&
      window.startTime === opportunity.startTime &&
      window.endTime === opportunity.endTime
    )
    const polymarketOutcome = polymarketWindow?.outcomes[opportunity.polymarketDirection]
    const mexcLevels = mexcOutcome?.levels?.length
      ? mexcOutcome.levels
      : [{ price: opportunity.mexcPrice, size: opportunity.mexcAvailableQuantity }]
    const polymarketLevels = polymarketOutcome?.levels?.length
      ? polymarketOutcome.levels
      : [{ price: opportunity.polymarketPrice, size: opportunity.polymarketAvailableQuantity }]

    const accountCheckedAt = [mexcAccount?.checkedAt, polymarketCapacity?.checkedAt]
      .filter((value): value is number => Number.isFinite(value))
    const accountDataAgeMs = accountCheckedAt.length > 0
      ? Math.max(...accountCheckedAt.map((value) => Math.max(0, Date.now() - value)))
      : undefined
    const plan = calculateDepthExecutionPlan({
      opportunityId: opportunity.id,
      quantity,
      mexcLevels,
      polymarketLevels,
      mexcFeeRate: opportunity.mexcFeeRate,
      polymarketFeeRate: opportunity.polymarketFeeRate,
      polymarketFeeExponent: opportunity.polymarketFeeExponent,
      polymarketMinOrderSize: opportunity.polymarketMinOrderSize,
      riskBufferPerShare: opportunity.riskBufferPerShare,
      minConditionalReturnPct: this.executionConditionEnabled('conditionalReturn', source) ? this.settings.minConditionalReturnPct : '-100000',
      maxCapital: this.settings.maxCapitalPerTrade,
      maxHedgeSlippage: this.settings.maxHedgeSlippage,
      mexcBalance: this.settings.mode === 'ASSISTED' ? mexcAccount?.availableUsdt : undefined,
      polymarketBalance: this.settings.mode === 'ASSISTED' ? polymarketCapacity?.collateralBalance : undefined,
      requireBalances,
      accountDataAgeMs,
      balanceUsageRatio: '0.99'
    })
    if (this.settings.mode === 'ASSISTED' && polymarketCapacity?.closedOnly) {
      return { ...plan, executable: false, blockReason: 'Polymarket账户当前仅允许平仓' }
    }
    if (this.settings.mode === 'ASSISTED' && polymarketCapacity && !polymarketCapacity.allowanceReady) {
      return { ...plan, executable: false, blockReason: 'Polymarket授权额度尚未就绪' }
    }
    if (this.settings.mode === 'ASSISTED' && (accountDataAgeMs === undefined || accountDataAgeMs > 30_000)) {
      return { ...plan, executable: false, blockReason: '账户余额缓存超过30秒，等待后台轻量刷新' }
    }
    return plan
  }

  private syncCapacityRefreshTimer(): void {
    if (this.capacityRefreshTimer) clearInterval(this.capacityRefreshTimer)
    this.capacityRefreshTimer = undefined
    if (!this.licenseActive || !this.settings.polymarketLiveEnabled || !this.liveBroker) return
    const refresh = (): void => {
      void Promise.all([
        this.mexcBrowser.ensureAccountBalance?.(30_000),
        this.liveBroker?.ensureTradingCapacity(0),
        this.liveBroker?.prefetchOrderBooks?.(
          this.opportunities.map((opportunity) => opportunity.polymarketTokenId ?? '')
        )
      ])
        .then(() => this.broadcast(this.getSnapshot()))
        .catch(() => undefined)
    }
    refresh()
    this.capacityRefreshTimer = setInterval(refresh, 20_000)
    this.capacityRefreshTimer.unref()
  }

  private executionConditionEnabled(
    condition: keyof RiskSettings['manualExecutionConditions'],
    source: 'MANUAL' | 'AUTO' | 'TEST'
  ): boolean {
    return source === 'AUTO' || this.settings.manualExecutionConditions[condition]
  }

  private validateExecution(
    opportunity: Opportunity,
    quantityInput: string,
    executionPlan: ExecutionPlan,
    source: 'MANUAL' | 'AUTO' | 'TEST'
  ): void {
    const quantity = new Decimal(quantityInput)
    if (!quantity.isFinite() || quantity.lte(0)) throw new Error('数量必须大于0')
    const minimumQuantity = new Decimal(executionPlan.minimumQuantity)
    if (quantity.lt(minimumQuantity)) {
      throw new Error(`最小对齐份额为${minimumQuantity.toFixed(2)}份（Polymarket至少${opportunity.polymarketMinOrderSize}份且BUY金额至少1，MEXC本金至少1 USDT）`)
    }
    if (!executionPlan.executable) throw new Error(`当前数量不可执行：${executionPlan.blockReason ?? '深度或账户条件不足'}`)
    if (opportunity.stale && this.executionConditionEnabled('quoteFreshness', source)) throw new Error('行情已过期，请刷新')
    if (opportunity.feeVerificationBlocked && this.executionConditionEnabled('feeVerification', source)) {
      throw new Error(`手续费校验未通过：${opportunity.feeVerificationReason ?? '缺少可验证费率'}`)
    }
    if (
      opportunity.settlementRiskBlocked &&
      this.executionConditionEnabled('settlementRisk', source) &&
      !this.settings.allowUnprofitableTestTrade
    ) {
      throw new Error(`结算源风控拦截：${opportunity.settlementRiskReason ?? '实时信号不满足条件'}`)
    }
    const capital = new Decimal(executionPlan.capitalRequired)
    const belowReturn = new Decimal(executionPlan.conditionalReturnPct).lt(this.settings.minConditionalReturnPct)
    if (belowReturn && this.executionConditionEnabled('conditionalReturn', source) && !this.settings.allowUnprofitableTestTrade) throw new Error('条件收益率低于风控阈值')
    if (this.settings.allowUnprofitableTestTrade) {
      if (this.settings.mode !== 'ASSISTED') throw new Error('小额亏损联调只允许在人工监督模式执行')
      if (!this.settings.polymarketLiveEnabled) throw new Error('请先通过身份验证并开启Polymarket真实对冲，再进行小额亏损联调')
      const minimumCapital = capital.div(quantity).mul(minimumQuantity)
      if (minimumCapital.gt(TEST_TRADE_CAPITAL_HARD_LIMIT)) {
        throw new Error(`当前最小可成交验证单预计需要${minimumCapital.toFixed(2)}，超过12 USDT验证硬上限`)
      }
      const testCapitalLimit = Decimal.max(TEST_TRADE_CAPITAL_FLOOR, minimumCapital)
      if (capital.gt(testCapitalLimit)) {
        throw new Error(`小额验证最多使用${testCapitalLimit.toFixed(2)} USDT（当前最小可成交份额${minimumQuantity.toFixed(2)}份）`)
      }
    }
    if (capital.gt(this.settings.maxCapitalPerTrade)) {
      throw new Error('预计本金超过单笔限额')
    }
    if (
      this.executionConditionEnabled('expiryCutoff', source) &&
      (opportunity.endTime - Date.now()) / 1_000 <= this.settings.stopBeforeExpirySeconds
    ) {
      throw new Error('距离到期过近，禁止新开仓')
    }
  }

  private async hedgePolymarket(
    opportunity: Opportunity,
    mexcFill: Fill,
    recoveryMode = false,
    hedgeMode = this.settings.polymarketHedgeMode
  ): Promise<void> {
    if (!this.activeSession) throw new Error('执行会话意外丢失')
    const targetQuantity = this.calculatePolymarketTargetQuantity(mexcFill)
    this.activeSession.polymarketTargetQuantity = targetQuantity.toDecimalPlaces(6).toString()
    this.activeSession.excessHedgeQuantity = '0'
    if (this.activeSession.state !== 'POLY_HEDGING') {
      await this.transition('POLY_HEDGING', `${recoveryMode ? '恢复' : '开始'}对冲：MEXC实际成交${mexcFill.quantity}份，Polymarket计算目标${targetQuantity.toDecimalPlaces(6).toString()}份`)
    }
    const broker = this.settings.mode === 'SIMULATION'
      ? this.simulatedBroker
      : this.settings.polymarketLiveEnabled
        ? this.liveBroker
        : undefined
    if (!broker) {
      const message = 'Polymarket真实对冲未启用；没有提交订单'
      this.activeSession.error = message
      await this.transition('RECOVERY_REQUIRED', message, { error: message })
      return
    }

    if (this.activeSession.timings && !this.activeSession.timings.polymarketStartedAt) {
      this.activeSession.timings.polymarketStartedAt = Date.now()
    }
    const fills = [...(this.activeSession.polymarketFills ?? (this.activeSession.polymarketFill ? [this.activeSession.polymarketFill] : []))]
    let filledQuantity = Decimal.sum(0, ...fills.map((fill) => new Decimal(fill.quantity || 0)))
    let remainingQuantity = Decimal.max(targetQuantity.minus(filledQuantity), 0)
    const normalMaximumPrice = Decimal.min(
      new Decimal(opportunity.polymarketPrice).add(this.settings.maxHedgeSlippage),
      new Decimal(this.activeExecutionPlan?.polymarketMaximumPrice ?? POLYMARKET_MAX_ORDER_PRICE),
      POLYMARKET_MAX_ORDER_PRICE
    )
    const totalAttempts = this.settings.polymarketHedgeRetryCount + 1
    let lastError = ''
    let forceQuoteRefresh = false

    for (let attempt = 0; attempt < totalAttempts && remainingQuantity.gt('0.000001'); attempt += 1) {
      const recoveryMaximumPrice = this.calculateRecoveryMaximumPrice(opportunity, mexcFill, fills, remainingQuantity)
      const maximumPrice = recoveryMode || attempt > 0 ? recoveryMaximumPrice : normalMaximumPrice
      if (maximumPrice.lte(0)) {
        lastError = `恢复损失上限${this.settings.maxRecoveryLossUsdt} USDT内没有可接受的Polymarket价格`
        break
      }
      if (attempt > 0 || recoveryMode) {
        await new Promise((resolve) => setTimeout(resolve, hedgeMode === 'PROTECTED_MARKET' ? 75 : 150))
      }
      this.activeSession.hedgeAttempts = (this.activeSession.hedgeAttempts ?? 0) + 1
      try {
        if (!opportunity.polymarketTokenId) throw new Error('Polymarket对冲缺少token')
        await this.polymarketData.confirmOutcomeQuote?.(
          opportunity.polymarketTokenId,
          forceQuoteRefresh ? -1 : 1_000
        )
        forceQuoteRefresh = false
        const currentWindows = this.polymarketData.getLatestWindows?.() ?? this.latestPolymarketWindows
        const liveWindow = currentWindows.find((window) =>
          window.durationMinutes === opportunity.durationMinutes &&
          window.startTime === opportunity.startTime &&
          window.endTime === opportunity.endTime
        )
        const liveOutcome = liveWindow?.outcomes[opportunity.polymarketDirection]
        const minimumOrderSize = new Decimal(liveOutcome?.minOrderSize ?? opportunity.polymarketMinOrderSize ?? '1')
        const tailOverhedge = Decimal.max(minimumOrderSize.minus(remainingQuantity), 0)
        const fill = await broker.hedge({
          tokenId: opportunity.polymarketTokenId,
          direction: opportunity.polymarketDirection,
          quantity: remainingQuantity.toDecimalPlaces(6).toString(),
          maximumPrice: Decimal.min(maximumPrice, POLYMARKET_MAX_ORDER_PRICE).toFixed(4),
          feeRate: opportunity.polymarketFeeRate,
          feeExponent: opportunity.polymarketFeeExponent,
          mode: hedgeMode,
          levels: liveOutcome?.levels,
          quoteReceivedAt: liveOutcome?.receivedAt,
          minimumOrderSize: minimumOrderSize.toString(),
          allowTailOverhedge: recoveryMode && tailOverhedge.gt(0) && tailOverhedge.lt(remainingQuantity)
        })
        fills.push(fill)
        filledQuantity = Decimal.sum(0, ...fills.map((item) => new Decimal(item.quantity || 0)))
        remainingQuantity = Decimal.max(targetQuantity.minus(filledQuantity), 0)
        this.activeSession.polymarketFills = fills
        this.activeSession.polymarketFill = aggregateFills(fills, opportunity.polymarketDirection)
        this.activeSession.remainingHedgeQuantity = remainingQuantity.toDecimalPlaces(6).toString()
        await this.syncActiveOrderRecord()
        await this.recordActiveExecutionEvent(
          'POLY_HEDGING',
          `Polymarket FAK第${attempt + 1}次成交${fill.quantity}份 @ ${fill.averagePrice}；累计${filledQuantity.toDecimalPlaces(6).toString()}份，剩余${remainingQuantity.toDecimalPlaces(6).toString()}份`,
          {
            attempt: attempt + 1,
            hedgeMode,
            maximumPrice: Decimal.min(maximumPrice, POLYMARKET_MAX_ORDER_PRICE).toFixed(4),
            filledQuantity: fill.quantity,
            remainingQuantity: remainingQuantity.toDecimalPlaces(6).toString(),
            ...fill.executionDetails
          }
        )
        if (filledQuantity.gt(targetQuantity.add('0.000001'))) {
          lastError = `Polymarket出现超额对冲：目标${targetQuantity.toString()}份，实际${filledQuantity.toString()}份`
          break
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        const quoteMoved = /盘口已变化|no orders found to match|no match is found/i.test(lastError)
        const priceProtectionTriggered = /价格保护已触发|已超过最高可接受价/i.test(lastError)
        forceQuoteRefresh = quoteMoved
        console.error(`[Polymarket hedge attempt ${attempt + 1} failed] ${lastError}`)
        await this.recordActiveExecutionEvent('POLY_HEDGING', `Polymarket FAK第${attempt + 1}次未成交：${lastError}`, {
          attempt: attempt + 1,
          hedgeMode,
          maximumPrice: Decimal.min(maximumPrice, POLYMARKET_MAX_ORDER_PRICE).toFixed(4),
          remainingQuantity: remainingQuantity.toDecimalPlaces(6).toString()
        })
        if (lastError.startsWith('POLY_SUBMISSION_UNCERTAIN:') || priceProtectionTriggered) break
      }
    }

    if (!this.activeSession) throw new Error('执行会话意外丢失')
    const excessQuantity = Decimal.max(filledQuantity.minus(targetQuantity), 0)
    this.activeSession.excessHedgeQuantity = excessQuantity.toDecimalPlaces(6).toString()
    const outcome = this.calculateHedgeOutcome(opportunity, mexcFill, fills)
    this.activeSession.hedgeOutcome = outcome
    const exactlyAligned = remainingQuantity.lte('0.000001') && excessQuantity.lte('0.000001')
    const safeImbalance = !exactlyAligned && Boolean(outcome?.safe)
    const safeToComplete = outcome ? outcome.safe : exactlyAligned
    if (safeToComplete) {
      this.activeSession.error = undefined
      if (exactlyAligned) this.activeSession.remainingHedgeQuantity = '0'
      if (this.activeSession.timings) {
        this.activeSession.timings.polymarketCompletedAt = Date.now()
        this.activeSession.timings.hedgedAt = Date.now()
      }
      const outcomeDetails = outcome ? {
        protectedCost: outcome.protectedCost,
        mexcDirectionPnl: outcome.mexcDirectionPnl,
        polymarketDirectionPnl: outcome.polymarketDirectionPnl,
        worstPnl: outcome.worstPnl,
        worstReturnPct: outcome.worstReturnPct,
        quantityDifference: outcome.quantityDifference,
        meetsProfitTarget: outcome.meetsProfitTarget
      } : undefined
      if (safeImbalance && outcome) {
        const profitNote = outcome.meetsProfitTarget ? '仍达到利润门槛' : '最低利润低于开仓门槛'
        await this.transition(
          'HEDGED',
          `对冲完成但份额略有偏差：Poly相对MEXC ${new Decimal(outcome.quantityDifference).gte(0) ? '+' : ''}${outcome.quantityDifference}份；正常互斥结算下MEXC方向盈亏${outcome.mexcDirectionPnl} USDT、Polymarket方向盈亏${outcome.polymarketDirectionPnl} USDT，${profitNote}；安全偏差未自动平仓`,
          outcomeDetails
        )
      } else {
        await this.transition(
          'HEDGED',
          `两腿已按实际成交量对齐；Polymarket共${fills.length}笔FAK成交${outcome ? `；正常互斥结算下最低预计盈亏${outcome.worstPnl} USDT${outcome.meetsProfitTarget ? '' : `，收益率${outcome.worstReturnPct}%低于设置门槛`}` : ''}`,
          outcomeDetails
        )
      }
      return
    }
    const quantityIssue = excessQuantity.gt('0.000001')
      ? `Polymarket超额成交${excessQuantity.toDecimalPlaces(6).toString()}份：目标${targetQuantity.toDecimalPlaces(6).toString()}份，实际${filledQuantity.toDecimalPlaces(6).toString()}份`
      : remainingQuantity.gt('0.000001')
        ? `已对冲${filledQuantity.toDecimalPlaces(6).toString()}份，仍有${remainingQuantity.toDecimalPlaces(6).toString()}份未对冲`
        : '两腿份额已对齐'
    const message = outcome && !outcome.safe
      ? `${quantityIssue}；正常互斥结算下最低预计盈亏${outcome.worstPnl} USDT，存在亏损结果，需要恢复或平仓处理`
      : `${quantityIssue}${lastError ? `：${lastError}` : ''}`
    this.activeSession.error = message
    this.activeSession.remainingHedgeQuantity = remainingQuantity.toDecimalPlaces(6).toString()
    await this.transition('RECOVERY_REQUIRED', `实际成交后仍需处理：${message}`, {
      error: message,
      filledQuantity: filledQuantity.toDecimalPlaces(6).toString(),
      remainingQuantity: remainingQuantity.toDecimalPlaces(6).toString(),
      ...(outcome ? {
        protectedCost: outcome.protectedCost,
        mexcDirectionPnl: outcome.mexcDirectionPnl,
        polymarketDirectionPnl: outcome.polymarketDirectionPnl,
        worstPnl: outcome.worstPnl,
        worstReturnPct: outcome.worstReturnPct
      } : {})
    })
  }

  private calculateHedgeOutcome(
    opportunity: Opportunity,
    mexcFill: Fill,
    polymarketFills: Fill[]
  ): HedgeOutcomeSummary | undefined {
    if (
      opportunity.feeVerificationBlocked ||
      mexcFill.direction !== opportunity.mexcDirection ||
      opportunity.mexcDirection === opportunity.polymarketDirection ||
      polymarketFills.some((fill) => fill.direction !== opportunity.polymarketDirection)
    ) return undefined
    const mexcQuantity = new Decimal(mexcFill.quantity || 0)
    const mexcPrice = new Decimal(mexcFill.averagePrice || 0)
    const polymarketQuantity = Decimal.sum(0, ...polymarketFills.map((fill) => new Decimal(fill.quantity || 0)))
    if (mexcQuantity.lte(0) || mexcPrice.lte(0) || polymarketQuantity.lte(0)) return undefined
    const mexcCost = mexcQuantity.mul(mexcPrice)
    const mexcFee = mexcCost.mul(opportunity.mexcFeeRate || 0)
    const polymarketCostAndFees = Decimal.sum(0, ...polymarketFills.map((fill) => {
      const quantity = new Decimal(fill.quantity || 0)
      const price = new Decimal(fill.averagePrice || 0)
      if (quantity.lte(0) || price.lte(0)) return new Decimal(Infinity)
      return quantity.mul(price.add(polymarketCryptoFeePerShare(
        price,
        opportunity.polymarketFeeRate || 0,
        opportunity.polymarketFeeExponent || 1
      )))
    }))
    if (!polymarketCostAndFees.isFinite()) return undefined
    const riskReserve = Decimal.max(mexcQuantity, polymarketQuantity).mul(opportunity.riskBufferPerShare || 0)
    const protectedCost = mexcCost.add(mexcFee).add(polymarketCostAndFees).add(riskReserve)
    if (protectedCost.lte(0)) return undefined
    const mexcDirectionPnl = mexcQuantity.minus(protectedCost)
    const polymarketDirectionPnl = polymarketQuantity.minus(protectedCost)
    const worstPnl = Decimal.min(mexcDirectionPnl, polymarketDirectionPnl)
    const worstReturnPct = worstPnl.div(protectedCost).mul(100)
    return {
      protectedCost: protectedCost.toFixed(2),
      mexcDirectionPnl: mexcDirectionPnl.toFixed(2),
      polymarketDirectionPnl: polymarketDirectionPnl.toFixed(2),
      worstPnl: worstPnl.toFixed(2),
      worstReturnPct: worstReturnPct.toFixed(2),
      quantityDifference: polymarketQuantity.minus(mexcQuantity).toDecimalPlaces(6).toString(),
      safe: worstPnl.gte(0),
      meetsProfitTarget: worstReturnPct.gte(this.settings.minConditionalReturnPct)
    }
  }

  private calculatePolymarketTargetQuantity(mexcFill: Fill): Decimal {
    // Both connected contracts currently settle one winning share to one unit.
    // Keep this as a payout-ratio calculation so venue-specific settlement deductions
    // can be introduced without changing the execution safety boundary.
    const mexcNetPayoutPerShare = new Decimal(1)
    const polymarketNetPayoutPerShare = new Decimal(1)
    return new Decimal(mexcFill.quantity)
      .mul(mexcNetPayoutPerShare)
      .div(polymarketNetPayoutPerShare)
      .toDecimalPlaces(6, Decimal.ROUND_FLOOR)
  }

  private calculateRecoveryMaximumPrice(
    opportunity: Opportunity,
    mexcFill: Fill,
    polymarketFills: Fill[],
    remainingQuantity: Decimal
  ): Decimal {
    if (remainingQuantity.lte(0)) return new Decimal(0)
    const targetQuantity = new Decimal(mexcFill.quantity)
    const mexcCost = targetQuantity.mul(mexcFill.averagePrice).mul(new Decimal(1).add(opportunity.mexcFeeRate))
    const existingPolymarketCost = Decimal.sum(0, ...polymarketFills.map((fill) => {
      const quantity = new Decimal(fill.quantity || 0)
      const price = new Decimal(fill.averagePrice || 0)
      return quantity.mul(price.add(polymarketCryptoFeePerShare(
        price,
        new Decimal(opportunity.polymarketFeeRate || 0),
        new Decimal(opportunity.polymarketFeeExponent || 1)
      )))
    }))
    const riskBuffer = targetQuantity.mul(opportunity.riskBufferPerShare)
    const availableForRemaining = targetQuantity
      .add(this.settings.maxRecoveryLossUsdt)
      .minus(mexcCost)
      .minus(existingPolymarketCost)
      .minus(riskBuffer)
    if (availableForRemaining.lte(0)) return new Decimal(0)
    const feeRate = new Decimal(opportunity.polymarketFeeRate || 0)
    const feeExponent = new Decimal(opportunity.polymarketFeeExponent || 1)
    const affordable = (price: Decimal): boolean => remainingQuantity
      .mul(price.add(polymarketCryptoFeePerShare(price, feeRate, feeExponent)))
      .lte(availableForRemaining)
    let low = new Decimal('0.01')
    let high = POLYMARKET_MAX_ORDER_PRICE
    if (!affordable(low)) return new Decimal(0)
    for (let index = 0; index < 48; index += 1) {
      const middle = low.add(high).div(2)
      if (affordable(middle)) low = middle
      else high = middle
    }
    return low.toDecimalPlaces(4, Decimal.ROUND_FLOOR)
  }

  private async transition(
    next: ExecutionState,
    message: string,
    details?: Record<string, string | number | boolean>
  ): Promise<void> {
    if (!this.activeSession) throw new Error('没有活动执行会话')
    assertTransition(this.activeSession.state, next)
    this.activeSession.state = next
    this.activeSession.updatedAt = Date.now()
    await this.syncActiveOrderRecord()
    await this.recordActiveExecutionEvent(next, message, details)
  }

  private async recordActiveExecutionEvent(
    state: ExecutionState,
    message: string,
    details?: Record<string, string | number | boolean>
  ): Promise<void> {
    if (!this.activeSession) throw new Error('没有活动执行会话')
    const event: ExecutionEvent = {
      id: randomUUID(),
      sessionId: this.activeSession.id,
      state,
      timestamp: Date.now(),
      message,
      details
    }
    this.recentEvents = [event, ...this.recentEvents].slice(0, 80)
    await this.store.appendEvent(event)
    this.broadcast(this.getSnapshot())
  }

  private async syncActiveOrderRecord(): Promise<void> {
    const session = this.activeSession
    if (!session) return
    const index = this.orderHistory.findIndex((order) => order.id === session.id)
    if (index < 0) return
    const current = this.orderHistory[index]
    const mexc = session.mexcFill && !current.mexc.entryFill
      ? { ...current.mexc, entryFill: session.mexcFill, openQuantity: session.mexcFill.quantity }
      : current.mexc
    const polymarketBase = session.polymarketTargetQuantity
      ? { ...current.polymarket, targetQuantity: session.polymarketTargetQuantity }
      : current.polymarket
    const polymarket = session.polymarketFill
      ? {
        ...polymarketBase,
        entryFill: session.polymarketFill,
        entryFills: session.polymarketFills ?? [session.polymarketFill],
        openQuantity: session.polymarketFill.quantity
      }
      : polymarketBase
    const status = current.endTime <= Date.now() && !['CLOSED', 'CANCELLED'].includes(current.status)
      ? 'EXPIRED' as const
      : session.state === 'HEDGED'
      ? 'OPEN' as const
      : session.state === 'CANCELLED'
        ? 'CANCELLED' as const
        : session.state === 'RECOVERY_REQUIRED'
          ? 'RECOVERY_REQUIRED' as const
          : 'OPENING' as const
    const updated: ArbitrageOrderRecord = {
      ...current,
      status,
      executionState: session.state,
      updatedAt: session.updatedAt,
      mexc,
      polymarket,
      hedgeOutcome: session.hedgeOutcome ?? current.hedgeOutcome
    }
    this.orderHistory = this.orderHistory.map((order, orderIndex) => orderIndex === index ? updated : order)
    await this.store.saveOrderHistory(this.orderHistory)
  }

  private async loadLiveOpportunities(): Promise<AppSnapshot> {
    let mexcWindows: MexcWindowQuote[]
    try {
      mexcWindows = await this.mexcBrowser.fetchActiveBtcWindows()
      this.latestMexcWindows = mexcWindows
      const monitoredDurations = [...new Set(mexcWindows.map((window) => window.durationMinutes))]
        .sort((left, right) => left - right)
        .map((duration) => `${duration}m`)
        .join('/')
      this.mexcDataMessage = mexcWindows.length
        ? `MEXC ${monitoredDurations} 并行监控（与当前详情页周期无关）`
        : 'MEXC 当前没有可交易的 BTC 5m/15m 盘口'
    } catch (error) {
      this.mexcDataMessage = `MEXC 读取失败：${error instanceof Error ? error.message : String(error)}`
      this.opportunities = []
      const snapshot = this.getSnapshot()
      this.broadcast(snapshot)
      return snapshot
    }
    try {
      const polymarketWindows = await this.polymarketData.fetchWindows(mexcWindows.map((window) => ({
        durationMinutes: window.durationMinutes as 5 | 15,
        startTime: window.startTime,
        endTime: window.endTime
      })))
      this.latestPolymarketWindows = polymarketWindows
      this.polymarketDataMessage = this.polymarketData.getStatus().message
      this.opportunities = this.combineLiveQuotes(mexcWindows, polymarketWindows)
      if (this.licenseActive && this.settings.polymarketLiveEnabled) {
        void this.liveBroker?.prefetchOrderBooks?.(
          this.opportunities.map((opportunity) => opportunity.polymarketTokenId ?? '')
        ).catch(() => undefined)
      }
      this.evaluateAutoOpen()
    } catch (error) {
      this.polymarketDataMessage = this.polymarketData.getStatus().message
      this.opportunities = []
    }
    const snapshot = this.getSnapshot()
    this.broadcast(snapshot)
    return snapshot
  }

  private scheduleStreamingSnapshot(): void {
    if (this.streamRefreshTimer) return
    this.streamRefreshTimer = setTimeout(() => {
      this.streamRefreshTimer = undefined
      const mexcWindows = this.mexcBrowser.getLatestWindows?.() ?? this.latestMexcWindows
      const polymarketWindows = this.polymarketData.getLatestWindows?.() ?? this.latestPolymarketWindows
      if (mexcWindows.length === 0 || polymarketWindows.length === 0) return
      this.latestMexcWindows = mexcWindows
      this.latestPolymarketWindows = polymarketWindows
      this.mexcDataMessage = `Hubstudio实时深度已接收，最近推送 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
      this.polymarketDataMessage = this.polymarketData.getStatus().message
      this.opportunities = this.combineLiveQuotes(mexcWindows, polymarketWindows)
      this.evaluateAutoOpen()
      this.broadcast(this.getSnapshot())
    }, 50)
    this.streamRefreshTimer.unref()
  }

  private combineLiveQuotes(mexcWindows: MexcWindowQuote[], polymarketWindows: PolymarketWindowQuote[]): Opportunity[] {
    const now = Date.now()
    const opportunities: Opportunity[] = []
    for (const mexc of mexcWindows) {
      const polymarket = polymarketWindows.find((candidate) =>
        candidate.durationMinutes === mexc.durationMinutes &&
        candidate.startTime === mexc.startTime &&
        candidate.endTime === mexc.endTime
      )
      if (!polymarket) continue
      for (const mexcDirection of ['UP', 'DOWN'] as const) {
        const polymarketDirection = mexcDirection === 'UP' ? 'DOWN' : 'UP'
        const mexcQuote = mexc.outcomes[mexcDirection]
        const polymarketQuote = polymarket.outcomes[polymarketDirection]
        if (!polymarketQuote) continue
        const signal = (
          baseline: string | undefined,
          current: string | undefined,
          receivedAt: number | undefined,
          equalityWinsUp: boolean
        ): { direction?: Direction; distanceBps?: string; missingReason?: string } => {
          const base = new Decimal(baseline || 0)
          const latest = new Decimal(current || 0)
          if (base.lte(0)) return { missingReason: '缺少本轮基准价' }
          if (latest.lte(0)) return { missingReason: '缺少实时指数价' }
          if (!receivedAt) return { missingReason: '缺少实时指数更新时间' }
          if (now - receivedAt > 90_000) {
            return { missingReason: `实时指数已超过90秒未更新（${Math.floor((now - receivedAt) / 1_000)}秒）` }
          }
          const difference = latest.minus(base)
          const direction: Direction = equalityWinsUp ? (difference.gte(0) ? 'UP' : 'DOWN') : (difference.gt(0) ? 'UP' : 'DOWN')
          return { direction, distanceBps: difference.div(base).mul(10_000).toFixed(4) }
        }
        const mexcSignal = signal(mexc.baselinePrice, mexc.indexPrice, mexc.indexReceivedAt, false)
        const polymarketSignal = signal(
          polymarket.baselinePrice,
          polymarket.indexPrice,
          polymarket.indexReceivedAt,
          true
        )
        const mexcDepthQuantity = mexcQuote.levels.length > 0
          ? Decimal.sum(0, ...mexcQuote.levels.map((level) => new Decimal(level.size || 0)))
          : new Decimal(mexcQuote.askSize)
        const polymarketDepthQuantity = polymarketQuote.levels.length > 0
          ? Decimal.sum(0, ...polymarketQuote.levels.map((level) => new Decimal(level.size || 0)))
          : new Decimal(polymarketQuote.askSize)
        const quantity = Decimal.min(mexcDepthQuantity, polymarketDepthQuantity)
        const mexcQuoteAgeMs = Math.max(0, now - this.normalizeQuoteTimestamp(mexcQuote.receivedAt))
        const polymarketQuoteAgeMs = Math.max(0, now - this.normalizeQuoteTimestamp(polymarketQuote.receivedAt))
        opportunities.push(calculateOpportunity({
          id: `btc-${mexc.durationMinutes}m-${mexc.startTime}-mexc-${mexcDirection.toLowerCase()}`,
          mexcEventId: mexc.eventId,
          mexcSymbolId: mexcQuote.symbolId,
          durationMinutes: mexc.durationMinutes,
          startTime: mexc.startTime,
          endTime: mexc.endTime,
          mexcDirection,
          mexcPrice: mexcQuote.bestAsk,
          mexcFeeRate: mexc.feeRate,
          mexcFeeRateSource: mexc.feeRateSource,
          polymarketPrice: polymarketQuote.bestAsk,
          polymarketTokenId: polymarketQuote.tokenId,
          polymarketMinOrderSize: polymarketQuote.minOrderSize,
          polymarketFeeRate: polymarketQuote.feeRate,
          polymarketFeeExponent: polymarketQuote.feeExponent,
          maxQuantity: quantity.toString(),
          mexcAvailableQuantity: mexcDepthQuantity.toString(),
          polymarketAvailableQuantity: polymarketDepthQuantity.toString(),
          riskBufferPerShare: mexc.durationMinutes === 5 ? '0.008' : '0.012',
          matchClass: 'CONDITIONAL',
          quoteAgeMs: Math.max(mexcQuoteAgeMs, polymarketQuoteAgeMs),
          mexcQuoteAgeMs,
          polymarketQuoteAgeMs,
          maxQuoteAgeMs: this.settings.maxQuoteAgeMs,
          mexcSignal: mexcSignal.direction,
          polymarketSignal: polymarketSignal.direction,
          mexcDistanceBps: mexcSignal.distanceBps,
          polymarketDistanceBps: polymarketSignal.distanceBps,
          evaluationTime: now,
          settlementSignalMissingReason: [
            mexcSignal.missingReason ? `MEXC ${mexcSignal.missingReason}` : undefined,
            polymarketSignal.missingReason ? `Polymarket ${polymarketSignal.missingReason}` : undefined
          ].filter(Boolean).join('；') || undefined,
          settlementDistanceRules: this.settings.settlementDistanceRules
        }))
      }
    }
    return opportunities.sort((left, right) =>
      left.durationMinutes - right.durationMinutes ||
      Number(left.mexcDirection === 'DOWN') - Number(right.mexcDirection === 'DOWN')
    )
  }

  private autoRoundKey(opportunity: Opportunity): string {
    return `${opportunity.durationMinutes}:${opportunity.startTime}`
  }

  private autoOpportunityFingerprint(opportunity: Opportunity): string {
    const mexcLevels = this.latestMexcWindows
      .find((window) => window.eventId === opportunity.mexcEventId)
      ?.outcomes[opportunity.mexcDirection].levels ?? []
    const polymarketLevels = this.latestPolymarketWindows
      .find((window) => window.durationMinutes === opportunity.durationMinutes && window.startTime === opportunity.startTime)
      ?.outcomes[opportunity.polymarketDirection]?.levels ?? []
    return [
      opportunity.id,
      mexcLevels.map((level) => `${level.price}@${level.size}`).join(','),
      polymarketLevels.map((level) => `${level.price}@${level.size}`).join(',')
    ].join(':')
  }

  private autoOpportunityReady(opportunity: Opportunity): boolean {
    const mexcAccount = this.mexcBrowser.getCachedAccountState?.()
    const polymarketCapacity = this.liveBroker?.getCachedTradingCapacity?.()
    const maximumPlan = this.buildExecutionPlan(opportunity, undefined, mexcAccount, polymarketCapacity, false, 'AUTO')
    const plannedQuantity = this.settings.autoOpenQuantityMode === 'FIXED'
      ? new Decimal(this.settings.autoOpenFixedQuantity)
      : new Decimal(maximumPlan.maxExecutableQuantity)
        .mul(this.settings.autoOpenMaxQuantityPct)
        .div(100)
        .toDecimalPlaces(2, Decimal.ROUND_FLOOR)
    const plannedPlan = this.settings.autoOpenQuantityMode === 'FIXED'
      ? this.buildExecutionPlan(opportunity, plannedQuantity.toFixed(2), mexcAccount, polymarketCapacity, false, 'AUTO')
      : maximumPlan
    return !opportunity.stale &&
      !opportunity.feeVerificationBlocked &&
      !opportunity.settlementRiskBlocked &&
      plannedPlan.executable &&
      plannedQuantity.gte(plannedPlan.minimumQuantity) &&
      plannedQuantity.lte(plannedPlan.maxExecutableQuantity) &&
      (opportunity.endTime - Date.now()) / 1_000 > this.settings.stopBeforeExpirySeconds &&
      !this.autoOpenedRounds.has(this.autoRoundKey(opportunity))
  }

  private evaluateAutoOpen(): void {
    if (
      !this.settings.autoOpenEnabled || this.autoOpenAttempting ||
      (this.activeSession && !['HEDGED', 'CANCELLED'].includes(this.activeSession.state))
    ) {
      this.clearAutoOpenCandidate()
      return
    }
    const candidate = [...this.opportunities]
      .filter((opportunity) => this.autoOpportunityReady(opportunity))
      .sort((left, right) => {
        const leftProfit = new Decimal(left.netEdgePerShare).mul(left.maxQuantity)
        const rightProfit = new Decimal(right.netEdgePerShare).mul(right.maxQuantity)
        return rightProfit.comparedTo(leftProfit) || new Decimal(right.netEdgePerShare).comparedTo(left.netEdgePerShare)
      })[0]
    if (!candidate) {
      this.clearAutoOpenCandidate()
      this.setAutoOpenState('MONITORING', '自动开单监控中，等待全部条件满足')
      return
    }
    const fingerprint = this.autoOpportunityFingerprint(candidate)
    if (fingerprint === this.autoOpenLastFingerprint) {
      this.setAutoOpenState('COOLDOWN', '上次复核未通过，等待新盘口', candidate.id)
      return
    }
    if (this.autoOpenCandidateId === candidate.id && this.autoOpenTimer) return
    this.clearAutoOpenCandidate()
    this.autoOpenCandidateId = candidate.id
    this.setAutoOpenState('STABILIZING', `全部条件已满足，连续确认${this.settings.autoOpenStabilityMs}毫秒`, candidate.id)
    this.broadcast(this.getSnapshot())
    this.autoOpenTimer = setTimeout(async () => {
      this.autoOpenTimer = undefined
      await this.triggerAutoOpen(candidate.id, fingerprint)
    }, this.settings.autoOpenStabilityMs)
    this.autoOpenTimer.unref()
  }

  private async triggerAutoOpen(opportunityId: string, fingerprint: string): Promise<void> {
    if (!this.settings.autoOpenEnabled || this.autoOpenAttempting || this.autoOpenCandidateId !== opportunityId) return
    const opportunity = this.opportunities.find((candidate) => candidate.id === opportunityId)
    if (!opportunity || !this.autoOpportunityReady(opportunity)) {
      this.clearAutoOpenCandidate()
      this.setAutoOpenState('MONITORING', `${this.settings.autoOpenStabilityMs}毫秒内条件发生变化，已取消本次触发`)
      this.broadcast(this.getSnapshot())
      return
    }
    this.autoOpenAttempting = true
    this.autoOpenLastAttemptAt = Date.now()
    this.autoOpenLastFingerprint = fingerprint
    this.setAutoOpenState('VERIFYING', '正在使用最新缓存复核；仅过期数据会补充请求', opportunityId)
    this.broadcast(this.getSnapshot())
    try {
      let quantity = this.settings.autoOpenFixedQuantity
      if (this.settings.autoOpenQuantityMode === 'MAX_PERCENT') {
        const maximumPlan = await this.calculateExecutionPlan({
          opportunityId,
          useMaximum: true,
          refreshStaleAccounts: false
        })
        quantity = new Decimal(maximumPlan.maxExecutableQuantity)
          .mul(this.settings.autoOpenMaxQuantityPct)
          .div(100)
          .toDecimalPlaces(2, Decimal.ROUND_FLOOR)
          .toFixed(2)
        if (new Decimal(quantity).lt(maximumPlan.minimumQuantity)) {
          throw new Error(`当前自动份额${quantity}低于最小对齐${maximumPlan.minimumQuantity}份`)
        }
      }
      const session = await this.execute({ opportunityId, quantity, source: 'AUTO' })
      if (session.state === 'CANCELLED' || session.state === 'RECOVERY_REQUIRED') {
        throw new Error(session.error ?? `自动执行进入${session.state}`)
      }
      this.autoOpenedRounds.add(this.autoRoundKey(opportunity))
      this.setAutoOpenState('COOLDOWN', `本轮已自动触发${quantity}份，不会重复开单`, opportunityId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const recoverable = /当前数量不可执行|行情已过期|距离到期|低于|风控|手续费|机会已失效|盘口|最小对齐/.test(message)
      if (recoverable) {
        this.setAutoOpenState('COOLDOWN', `最终复核未通过：${message}`, opportunityId)
      } else {
        this.settings = { ...this.settings, autoOpenEnabled: false }
        await this.store.saveSettings(this.settings)
        this.setAutoOpenState('ERROR', `自动开单已停用：${message}`, opportunityId)
      }
    } finally {
      this.autoOpenAttempting = false
      this.autoOpenCandidateId = undefined
      this.broadcast(this.getSnapshot())
    }
  }

  private clearAutoOpenCandidate(): void {
    if (this.autoOpenTimer) clearTimeout(this.autoOpenTimer)
    this.autoOpenTimer = undefined
    this.autoOpenCandidateId = undefined
  }

  private setAutoOpenState(status: AutoOpenState['status'], message: string, opportunityId?: string): void {
    this.autoOpenState = { status, message, opportunityId, since: Date.now() }
  }

  private normalizeQuoteTimestamp(timestamp: number): number {
    return timestamp > 0 && timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp
  }
}
