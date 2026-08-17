import { randomUUID } from 'node:crypto'
import Decimal from 'decimal.js'
import type {
  ArbitrageOrderRecord,
  AppSnapshot,
  CloseOrderRequest,
  Direction,
  ExecuteRequest,
  ExecutionEvent,
  ExecutionSession,
  ExecutionState,
  Fill,
  Opportunity,
  RiskSettings,
  UpdateSettingsRequest
} from '../shared/types'
import { defaultSettlementDistanceRules } from '../shared/defaults'
import { assertTransition } from './domain/execution-machine'
import { calculateOpportunity } from './domain/opportunity'
import { normalizeSettlementDistanceRules } from './domain/settlement-distance'
import { EventStore } from './services/event-store'
import type { MexcBrowserManager } from './services/mexc-browser'
import { SimulatedPolymarketBroker, type PolymarketBroker } from './services/polymarket'
import type { PolymarketLiveBroker } from './services/polymarket-live'
import { PolymarketMarketData, type PolymarketWindowQuote } from './services/polymarket-market-data'
import type { MexcWindowQuote } from './services/mexc-browser'

const DEFAULT_SETTINGS: RiskSettings = {
  mode: 'SIMULATION',
  maxCapitalPerTrade: '100',
  minNetEdgePerShare: '0.0100',
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
  allowUnprofitableTestTrade: false
}

const TEST_TRADE_CAPITAL_FLOOR = new Decimal(5)
const TEST_TRADE_CAPITAL_HARD_LIMIT = new Decimal(12)
const MEXC_MIN_NOTIONAL = new Decimal(1)
const POLYMARKET_MIN_BUY_AMOUNT = new Decimal(1)
const POLYMARKET_MAX_ORDER_PRICE = new Decimal('0.99')

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
      if (!interrupted) return order
      const message = '应用上次在订单执行过程中退出；请先核对两边实际持仓'
      return {
        ...order,
        status: 'RECOVERY_REQUIRED' as const,
        executionState: 'RECOVERY_REQUIRED' as const,
        closeOperation: order.closeOperation
          ? { ...order.closeOperation, state: 'RECOVERY_REQUIRED' as const, updatedAt: Date.now(), error: message }
          : undefined,
        updatedAt: Date.now()
      }
    })
    await this.store.saveOrderHistory(this.orderHistory)
    this.opportunities = []
  }

  setBroadcaster(broadcast: (snapshot: AppSnapshot) => void): void {
    this.broadcast = broadcast
  }

  getSnapshot(): AppSnapshot {
    const mexcStatus = this.mexcBrowser.getStatus()
    const settlementFeedConnected = this.opportunities.some((opportunity) => Boolean(opportunity.polymarketSignal))
    return {
      generatedAt: Date.now(),
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
      activeSession: this.activeSession,
      recentEvents: this.recentEvents
    }
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
    const next = { ...this.settings, ...request }
    next.settlementDistanceRules = normalizeSettlementDistanceRules(next.settlementDistanceRules)
    const maximumCapital = new Decimal(next.maxCapitalPerTrade)
    if (!maximumCapital.isFinite() || maximumCapital.lte(0) || maximumCapital.gt(1_000_000)) {
      throw new Error('单笔最大本金须为大于0且不超过1,000,000 USDT的数值')
    }
    next.maxCapitalPerTrade = maximumCapital.toDecimalPlaces(2).toFixed(2)
    const minimumEdge = new Decimal(next.minNetEdgePerShare)
    if (!minimumEdge.isFinite() || minimumEdge.lt(0) || minimumEdge.gte(1)) {
      throw new Error('最低净边际须为0至1之间的美元/份数值')
    }
    next.minNetEdgePerShare = minimumEdge.toDecimalPlaces(4).toFixed(4)
    const minimumReturn = new Decimal(next.minConditionalReturnPct)
    if (!minimumReturn.isFinite() || minimumReturn.lt(0) || minimumReturn.gt(100)) {
      throw new Error('最低条件收益率须为0至100之间的百分比')
    }
    next.minConditionalReturnPct = minimumReturn.toDecimalPlaces(2).toFixed(2)
    if (!Number.isInteger(next.maxQuoteAgeMs) || next.maxQuoteAgeMs < 3_000 || next.maxQuoteAgeMs > 30_000) {
      throw new Error('行情最长未确认时间须为3至30秒的整数')
    }
    if (!Number.isFinite(next.opportunitySoundVolume) || next.opportunitySoundVolume < 0 || next.opportunitySoundVolume > 1) {
      throw new Error('提示音音量须在0至1之间')
    }
    if (!Number.isInteger(next.opportunitySoundCooldownSeconds) || next.opportunitySoundCooldownSeconds < 5 || next.opportunitySoundCooldownSeconds > 3_600) {
      throw new Error('提示音冷却时间须为5至3600秒的整数')
    }
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
    this.broadcast(this.getSnapshot())
    return next
  }

  async execute(request: ExecuteRequest): Promise<ExecutionSession> {
    if (this.closingOrderId) throw new Error('平仓流程正在执行，不能同时开新仓')
    if (this.activeSession && !['HEDGED', 'CANCELLED'].includes(this.activeSession.state)) {
      throw new Error('已有执行中的套利组，不能重复开仓')
    }
    await this.refreshOpportunities()
    const opportunity = this.opportunities.find((candidate) => candidate.id === request.opportunityId)
    if (!opportunity) throw new Error('机会已失效，请刷新后重试')
    this.validateExecution(opportunity, request.quantity)

    this.activeSession = {
      id: randomUUID(),
      opportunityId: opportunity.id,
      requestedQuantity: new Decimal(request.quantity).toFixed(2),
      state: 'IDLE',
      mode: this.settings.mode,
      startedAt: Date.now(),
      updatedAt: Date.now()
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
      status: 'OPENING',
      executionState: 'IDLE',
      requestedQuantity: this.activeSession.requestedQuantity,
      expectedCapital: new Decimal(opportunity.allInCostPerShare).mul(this.activeSession.requestedQuantity).toFixed(2),
      expectedProfit: new Decimal(opportunity.netEdgePerShare).mul(this.activeSession.requestedQuantity).toFixed(2),
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
        filledAt: Date.now()
      }
      this.activeSession.mexcFill = fill
      await this.transition('MEXC_FILLED', 'MEXC模拟订单已完全成交')
      await this.hedgePolymarket(opportunity, fill)
      return this.activeSession
    }

    await this.mexcBrowser.open()
    await this.transition('MEXC_SUBMITTING', '已打开MEXC监督窗口，准备网页订单')
    const result = await this.mexcBrowser.prepareOrder({
      direction: opportunity.mexcDirection,
      amount: new Decimal(opportunity.mexcPrice).mul(request.quantity).toFixed(2),
      allowSubmit: this.settings.mexcAutomationEnabled,
      durationMinutes: opportunity.durationMinutes,
      startTime: opportunity.startTime
    })
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
    if (
      this.settings.polymarketLiveEnabled &&
      this.settings.mexcAutomationEnabled &&
      result.ok &&
      result.orderAccepted
    ) {
      const submittedAfter = (result.submittedAt ?? Date.now()) - 2_000
      void this.monitorMexcFill(opportunity, submittedAfter)
    }
    return this.activeSession
  }

  async confirmMexcFill(fill: Pick<Fill, 'quantity' | 'averagePrice' | 'orderId'>): Promise<ExecutionSession> {
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
      ...fill,
      venue: 'MEXC',
      direction: opportunity.mexcDirection,
      quantity: quantity.toFixed(2),
      averagePrice: new Decimal(fill.averagePrice).toFixed(4),
      filledAt: fill.filledAt ?? Date.now()
    }
    this.activeSession.mexcFill = mexcFill
    const state: ExecutionState = quantity.eq(this.activeSession.requestedQuantity) ? 'MEXC_FILLED' : 'MEXC_PARTIAL'
    await this.transition(state, state === 'MEXC_FILLED' ? '已确认MEXC完全成交' : '已确认MEXC部分成交')
    await this.hedgePolymarket(opportunity, mexcFill)
    return this.activeSession
  }

  private async monitorMexcFill(opportunity: Opportunity, submittedAfter: number): Promise<void> {
    try {
      const fill = await this.mexcBrowser.waitForFill({
        eventId: opportunity.mexcEventId,
        symbolId: opportunity.mexcSymbolId,
        direction: opportunity.mexcDirection,
        submittedAfter
      })
      if (!fill || !this.activeSession || this.activeSession.opportunityId !== opportunity.id) return
      if (!['MEXC_SUBMITTED', 'MEXC_SUBMITTING'].includes(this.activeSession.state)) return
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

  async closeOrder(request: CloseOrderRequest): Promise<ArbitrageOrderRecord> {
    if (this.closingOrderId) throw new Error('已有平仓流程正在执行，请等待完成或进入恢复状态')
    if (!['MEXC', 'POLYMARKET', 'BOTH'].includes(request.target)) throw new Error('平仓目标无效')
    if (this.activeSession && !['HEDGED', 'CANCELLED'].includes(this.activeSession.state)) {
      throw new Error('当前仍有开仓或对冲流程，不能同时执行平仓')
    }
    const order = this.orderHistory.find((candidate) => candidate.id === request.orderId)
    if (!order) throw new Error('未找到对应套利订单')
    if (order.status === 'CLOSED' || order.status === 'CANCELLED') throw new Error('该订单已经没有可平持仓')
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
            averagePrice: order.mexc.entryFill?.averagePrice ?? '0.5', orderId: `sim-mexc-close-${randomUUID()}`, filledAt: Date.now()
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

  private validateExecution(opportunity: Opportunity, quantityInput: string): void {
    const quantity = new Decimal(quantityInput)
    if (!quantity.isFinite() || quantity.lte(0)) throw new Error('数量必须大于0')
    const mexcNotional = new Decimal(opportunity.mexcPrice).mul(quantity)
    const polymarketMaximumPrice = Decimal.min(
      new Decimal(opportunity.polymarketPrice).add(this.settings.maxHedgeSlippage),
      POLYMARKET_MAX_ORDER_PRICE
    )
    const minimumQuantity = Decimal.max(
      new Decimal(opportunity.polymarketMinOrderSize),
      MEXC_MIN_NOTIONAL.div(opportunity.mexcPrice),
      POLYMARKET_MIN_BUY_AMOUNT.div(polymarketMaximumPrice)
    ).toDecimalPlaces(2, Decimal.ROUND_CEIL)
    if (quantity.lt(minimumQuantity)) {
      throw new Error(`最小对齐份额为${minimumQuantity.toFixed(2)}份（Polymarket至少${opportunity.polymarketMinOrderSize}份且BUY金额至少1，MEXC本金至少1 USDT）`)
    }
    if (quantity.gt(opportunity.maxQuantity)) {
      throw new Error(`数量超过当前盘口可执行上限：输入${quantity.toFixed(2)}份，MEXC可用${opportunity.mexcAvailableQuantity}份，Polymarket可用${opportunity.polymarketAvailableQuantity}份`)
    }
    if (opportunity.stale) throw new Error('行情已过期，请刷新')
    if (opportunity.feeVerificationBlocked) {
      throw new Error(`手续费校验未通过：${opportunity.feeVerificationReason ?? '缺少可验证费率'}`)
    }
    if (opportunity.settlementRiskBlocked && !this.settings.allowUnprofitableTestTrade) {
      throw new Error(`结算源风控拦截：${opportunity.settlementRiskReason ?? '实时信号不满足条件'}`)
    }
    const capital = new Decimal(opportunity.allInCostPerShare).mul(quantity)
    const belowEdge = new Decimal(opportunity.netEdgePerShare).lt(this.settings.minNetEdgePerShare)
    if (belowEdge && !this.settings.allowUnprofitableTestTrade) throw new Error('净收益低于风控阈值')
    const belowReturn = new Decimal(opportunity.conditionalReturnPct).lt(this.settings.minConditionalReturnPct)
    if (belowReturn && !this.settings.allowUnprofitableTestTrade) throw new Error('条件收益率低于风控阈值')
    if (this.settings.allowUnprofitableTestTrade) {
      if (this.settings.mode !== 'ASSISTED') throw new Error('小额亏损联调只允许在人工监督模式执行')
      if (!this.settings.polymarketLiveEnabled) throw new Error('请先通过身份验证并开启Polymarket真实FOK，再进行小额亏损联调')
      const minimumCapital = new Decimal(opportunity.allInCostPerShare).mul(minimumQuantity)
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
    if ((opportunity.endTime - Date.now()) / 1_000 <= this.settings.stopBeforeExpirySeconds) {
      throw new Error('距离到期过近，禁止新开仓')
    }
  }

  private async hedgePolymarket(opportunity: Opportunity, mexcFill: Fill): Promise<void> {
    await this.transition('POLY_HEDGING', `按MEXC实际成交 ${mexcFill.quantity} 份执行Polymarket对冲`)
    try {
      const broker = this.settings.mode === 'SIMULATION'
        ? this.simulatedBroker
        : this.settings.polymarketLiveEnabled
          ? this.liveBroker
          : undefined
      if (!broker) throw new Error('Polymarket真实对冲未启用；没有提交订单')
      const maximumPrice = Decimal.min(
        new Decimal(opportunity.polymarketPrice).add(this.settings.maxHedgeSlippage),
        POLYMARKET_MAX_ORDER_PRICE
      )
        .toFixed(4)
      const fill = await broker.hedge({
        tokenId: opportunity.polymarketTokenId,
        direction: opportunity.polymarketDirection,
        quantity: mexcFill.quantity,
        maximumPrice,
        feeRate: opportunity.polymarketFeeRate,
        feeExponent: opportunity.polymarketFeeExponent
      })
      if (!this.activeSession) throw new Error('执行会话意外丢失')
      this.activeSession.polymarketFill = fill
      await this.transition('HEDGED', '两腿数量已对齐；结算规则仍属于条件型')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[Polymarket hedge failed] ${message}`)
      if (this.activeSession) this.activeSession.error = message
      await this.transition('RECOVERY_REQUIRED', `Polymarket对冲失败：${message}`, { error: message })
    }
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
    const event: ExecutionEvent = {
      id: randomUUID(),
      sessionId: this.activeSession.id,
      state: next,
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
    const polymarket = session.polymarketFill && !current.polymarket.entryFill
      ? { ...current.polymarket, entryFill: session.polymarketFill, openQuantity: session.polymarketFill.quantity }
      : current.polymarket
    const status = session.state === 'HEDGED'
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
      polymarket
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
        const quantity = Decimal.min(mexcQuote.askSize, polymarketQuote.askSize)
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
          mexcAvailableQuantity: mexcQuote.askSize,
          polymarketAvailableQuantity: polymarketQuote.askSize,
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

  private normalizeQuoteTimestamp(timestamp: number): number {
    return timestamp > 0 && timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp
  }
}
