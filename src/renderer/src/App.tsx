import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  CircleHelp,
  Copy,
  ExternalLink,
  History,
  Info,
  KeyRound,
  LoaderCircle,
  LogOut,
  LockKeyhole,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Volume2,
  X
} from 'lucide-react'
import type {
  ArbitrageOrderRecord,
  AppSnapshot,
  CloseTarget,
  Direction,
  ExecutionSession,
  ExecutionState,
  ExecutionPlan,
  EmergencyAccessSnapshot,
  LicenseSummary,
  MexcBrowserMode,
  MexcBrowserStatus,
  MexcCalibrationKind,
  Opportunity,
  PolymarketCredentialSummary,
  PolymarketIdentityValidation,
  PolymarketSignatureType,
  SettlementDistanceRule
} from '../../shared/types'
import { defaultSettlementDistanceRules } from '../../shared/defaults'

interface SettlementRuleDraft {
  id: string
  remainingSeconds: string
  minimumBps: string
}

type SettingsView = 'MAIN' | 'RISK' | 'LIVE' | 'ACCOUNT'

const STATE_LABELS: Record<ExecutionState, string> = {
  IDLE: '已创建',
  MEXC_OPENING: '打开MEXC',
  MEXC_SUBMITTING: '提交MEXC',
  MEXC_SUBMITTED: '等待成交确认',
  MEXC_PARTIAL: 'MEXC部分成交',
  MEXC_FILLED: 'MEXC已成交',
  POLY_HEDGING: 'Polymarket对冲中',
  HEDGED: '两腿已对齐',
  MEXC_CLOSING: 'MEXC平仓中',
  MEXC_CLOSE_SUBMITTED: '等待MEXC平仓成交',
  POLY_CLOSING: 'Polymarket平仓中',
  CLOSED: '两腿已平仓',
  UNHEDGED: '单腿敞口',
  RECOVERY_REQUIRED: '需要恢复',
  CANCELLED: '已取消'
}

const CALIBRATION_LABELS: Record<MexcCalibrationKind, string> = {
  amountInput: '金额输入框',
  upButton: 'UP按钮',
  downButton: 'DOWN按钮',
  submitButton: '确认下单按钮'
}

function money(value: string, digits = 2): string {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : '—'
}

function directionLabel(direction: Direction): string {
  return direction === 'UP' ? '看涨 UP' : '看跌 DOWN'
}

function triggerSourceLabel(source: ArbitrageOrderRecord['triggerSource']): string {
  return source === 'AUTO' ? '自动开单' : source === 'MANUAL' ? '手动开单' : source === 'TEST' ? '测试开单' : '历史记录（来源未记录）'
}

function entryOrderIds(order: ArbitrageOrderRecord): { mexc?: string; polymarket?: string } {
  const polymarketIds = order.polymarket.entryFills?.map((fill) => fill.orderId).filter(Boolean)
  return {
    mexc: order.mexc.entryFill?.orderId,
    polymarket: polymarketIds?.length ? [...new Set(polymarketIds)].join('、') : order.polymarket.entryFill?.orderId
  }
}

function fillVerificationLabel(fill: ArbitrageOrderRecord['mexc']['entryFill']): string {
  if (fill?.verificationSource === 'PLATFORM_READBACK') return '平台成交回读'
  if (fill?.verificationSource === 'MANUAL_ENTRY' || fill?.orderId === 'manual-confirm') return '人工强制录入 · 未经平台回读'
  if (fill?.verificationSource === 'SIMULATED' || fill?.orderId.startsWith('sim-')) return '模拟成交'
  return '历史来源未记录'
}

function secondsRemaining(endTime: number, now: number): string {
  const total = Math.max(0, Math.floor((endTime - now) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function StatusDot({ status }: { status: string }): JSX.Element {
  const connected = status === 'CONNECTED' || status === 'BROWSER_READY'
  return <span className={`status-dot ${connected ? 'connected' : 'offline'}`} />
}

function opportunityReady(opportunity: Opportunity, snapshot: AppSnapshot, now: number): boolean {
  const minimumQuantity = minimumQuantityForOpportunity(opportunity, snapshot.settings.maxHedgeSlippage)
  return !opportunity.stale &&
    !opportunity.feeVerificationBlocked &&
    !opportunity.settlementRiskBlocked &&
    Number(opportunity.netEdgePerShare) >= Number(snapshot.settings.minNetEdgePerShare) &&
    Number(opportunity.conditionalReturnPct) >= Number(snapshot.settings.minConditionalReturnPct) &&
    Number(opportunity.maxQuantity) >= minimumQuantity &&
    Number(opportunity.allInCostPerShare) * minimumQuantity <= Number(snapshot.settings.maxCapitalPerTrade) &&
    (opportunity.endTime - now) / 1_000 > snapshot.settings.stopBeforeExpirySeconds
}

function minimumQuantityForOpportunity(opportunity: Opportunity, maxHedgeSlippage: string): number {
  const polymarketMaximumPrice = Math.min(0.99, Number(opportunity.polymarketPrice) + Number(maxHedgeSlippage))
  return polymarketMaximumPrice > 0 && Number(opportunity.mexcPrice) > 0
    ? Math.ceil(Math.max(
      Number(opportunity.polymarketMinOrderSize),
      1 / Number(opportunity.mexcPrice),
      1 / polymarketMaximumPrice
    ) * 100) / 100
    : Number.POSITIVE_INFINITY
}

function opportunityPotentialProfit(opportunity: Opportunity, snapshot: AppSnapshot): number {
  const cost = Number(opportunity.allInCostPerShare)
  if (!(cost > 0)) return Number.NEGATIVE_INFINITY
  const capitalQuantity = Math.floor(Number(snapshot.settings.maxCapitalPerTrade) / cost * 100) / 100
  const executableQuantity = Math.max(0, Math.min(Number(opportunity.maxQuantity), capitalQuantity))
  return Number(opportunity.netEdgePerShare) * executableQuantity
}

function quoteAgeLabel(milliseconds: number): string {
  return `${Math.max(0, milliseconds / 1_000).toFixed(1)}秒`
}

function executionTimingSummary(session: ExecutionSession): string | undefined {
  const timings = session.timings
  if (!timings) return undefined
  const segments: string[] = []
  const duration = (start?: number, end?: number): string | undefined =>
    start && end && end >= start ? `${end - start}ms` : undefined
  const preflight = duration(timings.executeRequestedAt, timings.planConfirmedAt)
  const page = duration(timings.planConfirmedAt, timings.mexcButtonReadyAt)
  const fill = duration(timings.mexcSubmittedAt, timings.mexcFillDetectedAt)
  const hedge = duration(timings.polymarketStartedAt, timings.polymarketCompletedAt)
  const total = duration(timings.executeRequestedAt, timings.hedgedAt)
  if (preflight) segments.push(`复核 ${preflight}`)
  if (page) segments.push(`页面/按钮 ${page}`)
  if (fill) segments.push(`MEXC成交 ${fill}`)
  if (hedge) segments.push(`Poly对冲 ${hedge}`)
  if (total) segments.push(`总计 ${total}`)
  return segments.length > 0 ? segments.join(' · ') : undefined
}

interface ExecutionCheck {
  passed: boolean
  label: string
}

function ExecutionConditionsHelp({ checks }: { checks: ExecutionCheck[] }): JSX.Element {
  const passed = checks.filter((check) => check.passed).length
  return <details className="execution-conditions-help">
    <summary aria-label="查看下单条件" title="查看下单条件"><CircleHelp aria-hidden="true" /></summary>
    <div className="execution-conditions-popover">
      <strong>下单条件 · {passed}/{checks.length}</strong>
      <ul>
        {checks.map((check) => <li key={check.label} className={check.passed ? 'passed' : 'blocked'}>
          {check.passed ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
          <span>{check.label}</span>
        </li>)}
      </ul>
      <small>点击开仓后会复核所选两边盘口；超过500毫秒未收到对应盘口时才补充请求，真实下单接口还会校验账户余额。</small>
    </div>
  </details>
}

function playOpportunityChime(volume: number): void {
  const AudioContextClass = window.AudioContext
  if (!AudioContextClass) return
  const context = new AudioContextClass()
  const gain = context.createGain()
  gain.gain.setValueAtTime(0, context.currentTime)
  gain.gain.linearRampToValueAtTime(Math.max(0, Math.min(1, volume)) * 0.16, context.currentTime + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.52)
  gain.connect(context.destination)
  ;[880, 1174].forEach((frequency, index) => {
    const oscillator = context.createOscillator()
    oscillator.type = 'sine'
    oscillator.frequency.value = frequency
    oscillator.connect(gain)
    oscillator.start(context.currentTime + index * 0.1)
    oscillator.stop(context.currentTime + 0.52)
  })
  window.setTimeout(() => void context.close(), 650)
}

function formatLicenseRemaining(seconds?: number): string {
  if (seconds === undefined) return '—'
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor(seconds % 86_400 / 3_600)
  return days > 0 ? `${days}天${hours}小时` : `${hours}小时${Math.floor(seconds % 3_600 / 60)}分钟`
}

function LicenseGate({ summary, onActivated }: { summary: LicenseSummary; onActivated: (summary: LicenseSummary) => void }): JSX.Element {
  const [activationCode, setActivationCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<string>()

  async function activate(): Promise<void> {
    if (!activationCode.trim()) {
      setFeedback('请粘贴管理员为当前机器码生成的授权码')
      return
    }
    setSubmitting(true)
    setFeedback(undefined)
    try {
      const result = await window.arbApp.activateLicense(activationCode)
      onActivated(result)
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  async function copyMachineCode(): Promise<void> {
    try {
      await navigator.clipboard.writeText(summary.machineCode)
      setFeedback('机器码已复制，请发送给授权管理员')
    } catch {
      setFeedback(`请手动复制机器码：${summary.machineCode}`)
    }
  }

  return <main className="license-shell">
    <section className="license-card" aria-labelledby="license-title">
      <div className="license-brand"><span><ShieldCheck aria-hidden="true" /></span><div><strong>ArbDesk</strong><small>安全授权入口</small></div></div>
      <div className="license-heading">
        <span className={`license-status ${summary.status.toLowerCase()}`}><LockKeyhole aria-hidden="true" />{summary.status === 'EXPIRED' ? '授权已到期' : summary.status === 'CLOCK_ERROR' ? '系统时间异常' : '需要授权'}</span>
        <h1 id="license-title">输入限时授权后进入交易控制台</h1>
        <p>未验证授权时不会加载行情、账户配置或交易功能。授权码仅适用于当前机器。</p>
      </div>
      <div className="machine-code-block">
        <label>本机机器码</label>
        <div><code>{summary.machineCode}</code><button onClick={() => void copyMachineCode()} aria-label="复制机器码" title="复制机器码"><Copy aria-hidden="true" /></button></div>
        <small>把机器码发给管理员，由管理员按授权天数生成激活码。</small>
      </div>
      <details className="license-help">
        <summary><CircleHelp aria-hidden="true" />客户如何获取和使用机器码</summary>
        <ol>
          <li>打开 ArbDesk，未授权时会直接停留在当前授权页面。</li>
          <li>在“本机机器码”一栏点击右侧复制按钮。</li>
          <li>把以 <code>ARB-</code> 开头的完整机器码发给授权管理员，不要发送账户密码或交易私钥。</li>
          <li>收到以 <code>ARB1.</code> 开头的授权码后，粘贴到下方并点击“验证并进入软件”。</li>
        </ol>
        <p>已经进入软件时，可在“右上角设置 → 账户与环境 → 软件授权”再次复制机器码，用于续期。</p>
      </details>
      <label className="license-code-field" htmlFor="license-code">授权码
        <textarea id="license-code" value={activationCode} onChange={(event) => setActivationCode(event.target.value)} placeholder="ARB1..." autoComplete="off" spellCheck={false} />
      </label>
      {feedback
        ? <div className="license-feedback error" role="alert"><AlertTriangle aria-hidden="true" /><span>{feedback}</span></div>
        : <div className="license-feedback"><Info aria-hidden="true" /><span>{summary.message}</span></div>}
      <button className="license-activate" onClick={() => void activate()} disabled={submitting || !summary.encryptionAvailable}>
        {submitting ? <LoaderCircle className="spin" aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
        {submitting ? '正在验证授权' : '验证并进入软件'}
      </button>
      <small className="license-safety-note">授权到期后自动退出交易界面；如果仍有真实敞口，只保留紧急恢复和平仓入口。</small>
    </section>
  </main>
}

function EmergencyLicensePage({ summary, onStateChange }: { summary: LicenseSummary; onStateChange: (summary: LicenseSummary) => void }): JSX.Element {
  const [snapshot, setSnapshot] = useState<EmergencyAccessSnapshot>()
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string>()

  const refresh = async (): Promise<void> => {
    const [emergency, nextSummary] = await Promise.all([
      window.arbApp.getEmergencyAccessSnapshot(),
      window.arbApp.getLicenseSummary()
    ])
    setSnapshot(emergency)
    onStateChange(nextSummary)
  }
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2_000)
    return () => window.clearInterval(timer)
  }, [])

  async function recover(action: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    setFeedback(undefined)
    try {
      await action()
      await refresh()
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return <main className="license-shell emergency-license-shell">
    <section className="license-card emergency-license-card">
      <div className="license-heading"><span className="license-status expired"><ShieldAlert aria-hidden="true" />授权已退出</span><h1>仅保留紧急持仓处理</h1><p>{summary.message}。为避免隐藏真实敞口，你只能恢复对冲或平仓；处理完成后自动回到授权页面。</p></div>
      {feedback && <div className="license-feedback error" role="alert"><AlertTriangle aria-hidden="true" /><span>{feedback}</span></div>}
      {!snapshot ? <LoaderCircle className="spin emergency-loading" aria-label="正在读取持仓" /> : <div className="emergency-order-list">
        {snapshot.activeSession?.state === 'RECOVERY_REQUIRED' && <button className="license-activate" disabled={busy} onClick={() => void recover(() => window.arbApp.retryPolymarketHedge())}><RotateCcw />重试剩余对冲</button>}
        {snapshot.orders.map((order) => {
          const mexcOpen = Number(order.mexc.openQuantity) > 0
          const polymarketOpen = Number(order.polymarket.openQuantity) > 0
          const target: CloseTarget | undefined = mexcOpen && polymarketOpen ? 'BOTH' : mexcOpen ? 'MEXC' : polymarketOpen ? 'POLYMARKET' : undefined
          const orderIds = entryOrderIds(order)
          return <article key={order.id} className="emergency-order-card">
            <div><strong>{order.durationMinutes}分钟 · MEXC {directionLabel(order.mexc.direction)}</strong><small>{triggerSourceLabel(order.triggerSource)} · 执行 {new Date(order.createdAt).toLocaleString('zh-CN', { hour12: false })}</small><small>状态 {order.status} · MEXC {Number(order.mexc.openQuantity).toFixed(2)}份 · Poly {Number(order.polymarket.openQuantity).toFixed(2)}份</small>{(orderIds.mexc || orderIds.polymarket) && <small className="emergency-order-ids" title={`MEXC ${orderIds.mexc ?? '无'} / Polymarket ${orderIds.polymarket ?? '无'}`}>订单号：MEXC {orderIds.mexc ?? '—'} · Poly {orderIds.polymarket ?? '—'}</small>}</div>
            {target
              ? <button disabled={busy} onClick={() => void recover(() => window.arbApp.closeOrder({ orderId: order.id, target }))}><LogOut />{target === 'BOTH' ? '平掉两腿' : target === 'MEXC' ? '平掉MEXC' : '平掉Polymarket'}</button>
              : <small className="emergency-manual-note">成交数量未知，请先在两平台人工核对；重新授权后可进入完整记录处理。</small>}
          </article>
        })}
        {snapshot.orders.length === 0 && <div className="license-feedback"><Check aria-hidden="true" /><span>没有剩余持仓，正在退出到授权页面。</span></div>}
      </div>}
    </section>
  </main>
}

function App(): JSX.Element {
  const [license, setLicense] = useState<LicenseSummary>()
  useEffect(() => {
    void window.arbApp.getLicenseSummary().then(setLicense)
    return window.arbApp.onLicenseState(setLicense)
  }, [])
  if (!license) return <div className="loading-screen"><LoaderCircle className="spin" /><span>正在验证软件授权</span></div>
  if (license.status === 'ACTIVE') return <TradingApp license={license} />
  if (license.emergencyOnly) return <EmergencyLicensePage summary={license} onStateChange={setLicense} />
  return <LicenseGate summary={license} onActivated={setLicense} />
}

function TradingApp({ license }: { license: LicenseSummary }): JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot>()
  const [selectedId, setSelectedId] = useState<string>()
  const [quantity, setQuantity] = useState('50')
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsView, setSettingsView] = useState<SettingsView>('MAIN')
  const [mexcStatus, setMexcStatus] = useState<MexcBrowserStatus>()
  const [fillQuantity, setFillQuantity] = useState('')
  const [fillPrice, setFillPrice] = useState('')
  const [fillOrderId, setFillOrderId] = useState('')
  const [manualFillAcknowledged, setManualFillAcknowledged] = useState(false)
  const [hubstudioCode, setHubstudioCode] = useState('')
  const [polymarketProxyUrl, setPolymarketProxyUrl] = useState('')
  const [polymarketCredentials, setPolymarketCredentials] = useState<PolymarketCredentialSummary>()
  const [polySignatureType, setPolySignatureType] = useState<PolymarketSignatureType>(0)
  const [polyFunderAddress, setPolyFunderAddress] = useState('')
  const [polyPrivateKey, setPolyPrivateKey] = useState('')
  const [polyValidation, setPolyValidation] = useState<PolymarketIdentityValidation>()
  const [settlementRuleDrafts, setSettlementRuleDrafts] = useState<SettlementRuleDraft[]>([])
  const [settlementRuleError, setSettlementRuleError] = useState<string>()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [closeIntent, setCloseIntent] = useState<{ order: ArbitrageOrderRecord; target: CloseTarget }>()
  const [dismissedExecutionNoticeKey, setDismissedExecutionNoticeKey] = useState<string>()
  const [maxCapitalDraft, setMaxCapitalDraft] = useState('100.00')
  const [minNetEdgeDraft, setMinNetEdgeDraft] = useState('0.0100')
  const [minConditionalReturnDraft, setMinConditionalReturnDraft] = useState('0.00')
  const [quoteValidityDraft, setQuoteValidityDraft] = useState('8')
  const [soundEnabledDraft, setSoundEnabledDraft] = useState(true)
  const [soundVolumeDraft, setSoundVolumeDraft] = useState(0.65)
  const [executionPlan, setExecutionPlan] = useState<ExecutionPlan>()
  const [soundCooldownDraft, setSoundCooldownDraft] = useState('30')
  const [autoFixedQuantityDraft, setAutoFixedQuantityDraft] = useState('5.00')
  const [autoMaxQuantityPctDraft, setAutoMaxQuantityPctDraft] = useState('80')
  const [autoStabilityDraft, setAutoStabilityDraft] = useState('100')
  const [maxRecoveryLossDraft, setMaxRecoveryLossDraft] = useState('2.00')
  const [hedgeRetryCountDraft, setHedgeRetryCountDraft] = useState('2')
  const previousCanExecuteRef = useRef(false)
  const soundCooldownRef = useRef(new Map<string, number>())
  const manualSelectionUntilRef = useRef(0)

  useEffect(() => {
    void window.arbApp.getSnapshot().then((value) => {
      setSnapshot(value)
      setSelectedId(value.opportunities[0]?.id)
      void window.arbApp.testPolymarketConnection().catch(() => undefined)
      void window.arbApp.refreshOpportunities().catch(() => undefined)
    })
    const unsubscribe = window.arbApp.onSnapshot(setSnapshot)
    const clock = window.setInterval(() => setNow(Date.now()), 500)
    // Market depth arrives through backend streams; the five-second refresh is
    // a full-book audit for quiet markets and a fallback for broken streams.
    const refresh = window.setInterval(() => void window.arbApp.refreshOpportunities().catch(() => undefined), 5_000)
    return () => {
      unsubscribe()
      window.clearInterval(clock)
      window.clearInterval(refresh)
    }
  }, [])

  useEffect(() => {
    if (!settingsOpen) return
    setHubstudioCode(snapshot?.settings.hubstudioContainerCode ?? '')
    setPolymarketProxyUrl(snapshot?.settings.polymarketProxyUrl ?? '')
    setMaxCapitalDraft(snapshot?.settings.maxCapitalPerTrade ?? '100.00')
    setMinNetEdgeDraft(snapshot?.settings.minNetEdgePerShare ?? '0.0100')
    setMinConditionalReturnDraft(snapshot?.settings.minConditionalReturnPct ?? '0.00')
    setQuoteValidityDraft(String((snapshot?.settings.maxQuoteAgeMs ?? 8_000) / 1_000))
    setSoundEnabledDraft(snapshot?.settings.opportunitySoundEnabled ?? true)
    setSoundVolumeDraft(snapshot?.settings.opportunitySoundVolume ?? 0.65)
    setSoundCooldownDraft(String(snapshot?.settings.opportunitySoundCooldownSeconds ?? 30))
    setAutoFixedQuantityDraft(snapshot?.settings.autoOpenFixedQuantity ?? '5.00')
    setAutoMaxQuantityPctDraft(String(snapshot?.settings.autoOpenMaxQuantityPct ?? 80))
    setAutoStabilityDraft(String(snapshot?.settings.autoOpenStabilityMs ?? 100))
    setMaxRecoveryLossDraft(snapshot?.settings.maxRecoveryLossUsdt ?? '2.00')
    setHedgeRetryCountDraft(String(snapshot?.settings.polymarketHedgeRetryCount ?? 2))
    setSettlementRuleDrafts((snapshot?.settings.settlementDistanceRules ?? defaultSettlementDistanceRules()).map((rule) => ({
      id: rule.id,
      remainingSeconds: String(rule.remainingSeconds),
      minimumBps: rule.minimumBps
    })))
    setSettlementRuleError(undefined)
    const refreshStatus = (): void => void window.arbApp.getMexcStatus().then(setMexcStatus)
    refreshStatus()
    void window.arbApp.getPolymarketCredentialSummary().then((summary) => {
      setPolymarketCredentials(summary)
      setPolySignatureType(summary.signatureType ?? 0)
      setPolyFunderAddress(summary.funderAddress ?? '')
    })
    const statusTimer = window.setInterval(refreshStatus, 2_000)
    return () => window.clearInterval(statusTimer)
  }, [settingsOpen, snapshot?.settings.hubstudioContainerCode])

  const selected = useMemo(
    () => snapshot?.opportunities.find((opportunity) => opportunity.id === selectedId) ?? snapshot?.opportunities[0],
    [selectedId, snapshot]
  )
  const readyOpportunities = useMemo(() => snapshot
    ? snapshot.opportunities.filter((opportunity) => opportunityReady(opportunity, snapshot, now))
    : [], [now, snapshot])
  const bestOpportunity = useMemo(() => snapshot
    ? [...readyOpportunities].sort((left, right) =>
      opportunityPotentialProfit(right, snapshot) - opportunityPotentialProfit(left, snapshot) ||
      Number(right.netEdgePerShare) - Number(left.netEdgePerShare)
    )[0]
    : undefined, [readyOpportunities, snapshot])
  const readyOpportunityCount = readyOpportunities.length
  const orderedOpportunities = useMemo(() => snapshot
    ? [...snapshot.opportunities].sort((left, right) =>
      left.durationMinutes - right.durationMinutes ||
      Number(left.mexcDirection === 'DOWN') - Number(right.mexcDirection === 'DOWN')
    )
    : [], [snapshot])

  useEffect(() => {
    if (!selected?.id || !(Number(quantity) > 0)) {
      setExecutionPlan(undefined)
      return
    }
    const timer = window.setTimeout(() => {
      void window.arbApp.calculateExecutionPlan({
        opportunityId: selected.id,
        quantity,
        refreshStaleAccounts: false
      }).then(setExecutionPlan).catch(() => undefined)
    }, 150)
    return () => window.clearTimeout(timer)
  }, [
    quantity,
    selected?.id,
    selected?.mexcPrice,
    selected?.polymarketPrice,
    selected?.mexcAvailableQuantity,
    selected?.polymarketAvailableQuantity,
    snapshot?.settings.maxCapitalPerTrade,
    snapshot?.settings.maxHedgeSlippage,
    snapshot?.settings.minConditionalReturnPct,
    snapshot?.settings.minNetEdgePerShare
  ])

  const currentPlan = executionPlan && executionPlan.opportunityId === selected?.id && executionPlan.requestedQuantity === Number(quantity || 0).toFixed(2)
    ? executionPlan
    : undefined
  const requestedCapital = currentPlan ? Number(currentPlan.capitalRequired) : selected ? Number(selected.allInCostPerShare) * Number(quantity || 0) : 0
  const requestedProfit = currentPlan ? Number(currentPlan.expectedProfit) : selected ? Number(selected.netEdgePerShare) * Number(quantity || 0) : 0
  const requestedBothLose = selected ? Number(selected.bothLosePnlPerShare) * Number(quantity || 0) : 0
  const requestedBothWin = selected ? Number(selected.bothWinPnlPerShare) * Number(quantity || 0) : 0
  const polymarketMaximumPrice = selected
    ? Math.min(0.99, Number(selected.polymarketPrice) + Number(snapshot?.settings.maxHedgeSlippage ?? 0))
    : 0
  const minimumAlignedQuantity = selected && polymarketMaximumPrice > 0
    ? Math.ceil(Math.max(
      Number(selected.polymarketMinOrderSize),
      1 / Number(selected.mexcPrice),
      1 / polymarketMaximumPrice
    ) * 100) / 100
    : 0
  const minimumTestCapital = selected ? minimumAlignedQuantity * Number(selected.allInCostPerShare) : 0
  const dynamicTestCapitalLimit = Math.max(5, minimumTestCapital)
  const testOverrideReady = Boolean(
    snapshot?.settings.allowUnprofitableTestTrade &&
    snapshot.settings.mode === 'ASSISTED' &&
    snapshot.settings.polymarketLiveEnabled &&
    minimumTestCapital <= 12 &&
    requestedCapital <= dynamicTestCapitalLimit
  )
  const executionSessionIdle = !snapshot?.activeSession || ['HEDGED', 'CANCELLED'].includes(snapshot.activeSession.state)
  const effectiveNetEdge = currentPlan?.netEdgePerShare ?? selected?.netEdgePerShare ?? '0'
  const effectiveConditionalReturn = currentPlan?.conditionalReturnPct ?? selected?.conditionalReturnPct ?? '0'
  const netEdgePassed = Boolean(selected && snapshot && Number(effectiveNetEdge) >= Number(snapshot.settings.minNetEdgePerShare))
  const conditionalReturnPassed = Boolean(selected && snapshot && Number(effectiveConditionalReturn) >= Number(snapshot.settings.minConditionalReturnPct))
  const settlementRiskPassed = Boolean(selected && !selected.settlementRiskBlocked)
  const canExecute = Boolean(
    selected &&
      Number(quantity) > 0 &&
      Number(quantity) >= minimumAlignedQuantity &&
      (!currentPlan || currentPlan.executable) &&
      Number(quantity) <= Number(currentPlan?.maxExecutableQuantity ?? selected.maxQuantity) &&
      requestedCapital <= Number(snapshot?.settings.maxCapitalPerTrade ?? 0) &&
      !selected.feeVerificationBlocked &&
      (!snapshot?.settings.allowUnprofitableTestTrade || (minimumTestCapital <= 12 && requestedCapital <= dynamicTestCapitalLimit)) &&
      (Number(effectiveNetEdge) >= Number(snapshot?.settings.minNetEdgePerShare ?? 0) || testOverrideReady) &&
      (Number(effectiveConditionalReturn) >= Number(snapshot?.settings.minConditionalReturnPct ?? 0) || testOverrideReady) &&
      (!selected.settlementRiskBlocked || testOverrideReady) &&
      !selected.stale &&
      (selected.endTime - now) / 1_000 > Number(snapshot?.settings.stopBeforeExpirySeconds ?? 0) &&
      executionSessionIdle &&
      !busy
  )
  const executeBlockReason = !selected
    ? '当前没有匹配市场'
    : !executionSessionIdle
      ? `已有执行中的套利组（${snapshot?.activeSession?.state ?? '未知状态'}）`
    : !(Number(quantity) > 0)
      ? '请输入大于0的对齐份额'
    : Number(quantity) < minimumAlignedQuantity
        ? `最小对齐份额为${minimumAlignedQuantity.toFixed(2)}份（Polymarket至少${selected.polymarketMinOrderSize}份且BUY金额至少1，MEXC本金至少1 USDT）`
    : currentPlan && !currentPlan.executable
        ? currentPlan.blockReason ?? '当前深度、余额或收益门槛不允许执行'
      : Number(quantity) > Number(currentPlan?.maxExecutableQuantity ?? selected.maxQuantity)
        ? `输入${Number(quantity).toFixed(2)}份超过当前可执行上限${currentPlan?.maxExecutableQuantity ?? selected.maxQuantity}份`
        : requestedCapital > Number(snapshot?.settings.maxCapitalPerTrade ?? 0)
          ? '预计本金超过单笔上限'
          : selected.stale
            ? '行情已过期，等待自动刷新'
            : (selected.endTime - now) / 1_000 <= Number(snapshot?.settings.stopBeforeExpirySeconds ?? 0)
              ? `距离到期不足${snapshot?.settings.stopBeforeExpirySeconds ?? 0}秒，禁止新开仓`
            : selected.feeVerificationBlocked
              ? selected.feeVerificationReason ?? '手续费尚未校验'
              : selected.settlementRiskBlocked && !testOverrideReady
              ? selected.settlementRiskReason ?? '结算信号风控拦截'
              : Number(effectiveNetEdge) < Number(snapshot?.settings.minNetEdgePerShare ?? 0) && !snapshot?.settings.allowUnprofitableTestTrade
                ? '净收益低于门槛；可在设置中放开一次小额亏损联调'
              : Number(effectiveConditionalReturn) < Number(snapshot?.settings.minConditionalReturnPct ?? 0) && !snapshot?.settings.allowUnprofitableTestTrade
                ? '条件收益率低于设置门槛'
                : snapshot?.settings.allowUnprofitableTestTrade && !snapshot.settings.polymarketLiveEnabled
                  ? '小额亏损联调需先验证身份并开启Polymarket真实对冲'
                  : snapshot?.settings.allowUnprofitableTestTrade && minimumTestCapital > 12
                    ? `当前最小验证单预计需要${minimumTestCapital.toFixed(2)}，超过12 USDT硬上限`
                  : snapshot?.settings.allowUnprofitableTestTrade && requestedCapital > dynamicTestCapitalLimit
                    ? `小额验证最多使用${dynamicTestCapitalLimit.toFixed(2)} USDT，可点击“最大”自动调整`
                    : undefined

  const executionChecks: ExecutionCheck[] = selected && snapshot ? [
    { passed: Number(quantity) > 0, label: `输入份额 ${Number(quantity || 0).toFixed(2)} > 0` },
    { passed: Number(quantity) >= minimumAlignedQuantity, label: `最小对齐 ${Number(quantity || 0).toFixed(2)} ≥ ${minimumAlignedQuantity.toFixed(2)}份` },
    ...(currentPlan ? [{
      passed: Number(quantity) <= Number(currentPlan.maxAffordableQuantity),
      label: `账户可支付 输入${Number(quantity || 0).toFixed(2)} ≤ ${currentPlan.maxAffordableQuantity}份（余额预留${currentPlan.accountBalanceReservePct}%）`
    }] : []),
    { passed: Number(quantity) <= Number(currentPlan?.maxExecutableQuantity ?? selected.maxQuantity), label: `收益可执行上限 输入${Number(quantity || 0).toFixed(2)} ≤ ${currentPlan?.maxExecutableQuantity ?? selected.maxQuantity}份${currentPlan ? `（MEXC ${currentPlan.mexcLevelsUsed}档 / Poly ${currentPlan.polymarketLevelsUsed}档）` : ''}` },
    { passed: requestedCapital <= Number(snapshot.settings.maxCapitalPerTrade), label: `预计本金 $${requestedCapital.toFixed(2)} ≤ $${Number(snapshot.settings.maxCapitalPerTrade).toFixed(2)}` },
    { passed: netEdgePassed || testOverrideReady, label: `滑点后净边际 ${money(effectiveNetEdge, 4)} ≥ ${money(snapshot.settings.minNetEdgePerShare, 4)}美元/份${!netEdgePassed && testOverrideReady ? '（小额联调豁免）' : ''}` },
    { passed: conditionalReturnPassed || testOverrideReady, label: `滑点后条件收益率 ${money(effectiveConditionalReturn, 2)}% ≥ ${money(snapshot.settings.minConditionalReturnPct, 2)}%${!conditionalReturnPassed && testOverrideReady ? '（小额联调豁免）' : ''}` },
    { passed: !selected.feeVerificationBlocked, label: selected.feeVerificationBlocked ? 'MEXC手续费尚未校验' : 'MEXC手续费已校验' },
    { passed: settlementRiskPassed || testOverrideReady, label: !settlementRiskPassed && testOverrideReady ? '结算信号门槛（小额联调豁免）' : selected.settlementRiskBlocked ? (selected.settlementRiskReason ?? '结算风控未通过') : '结算方向与动态安全距离通过' },
    { passed: !selected.stale, label: `行情 MEXC ${quoteAgeLabel(selected.mexcQuoteAgeMs)} / Poly ${quoteAgeLabel(selected.polymarketQuoteAgeMs)} ≤ ${(snapshot.settings.maxQuoteAgeMs / 1_000).toFixed(0)}秒` },
    { passed: (selected.endTime - now) / 1_000 > snapshot.settings.stopBeforeExpirySeconds, label: `距离到期 ${secondsRemaining(selected.endTime, now)}，开仓截止前仍有效` },
    ...(snapshot.settings.allowUnprofitableTestTrade
      ? [{ passed: testOverrideReady, label: `小额联调限制：人工监督、Poly真实对冲、本金≤${dynamicTestCapitalLimit.toFixed(2)} USDT且硬上限12 USDT` }]
      : []),
    { passed: executionSessionIdle && !busy, label: executionSessionIdle ? (busy ? '当前操作正在执行' : '当前无执行中操作') : `已有执行中套利组（${snapshot.activeSession?.state ?? '未知状态'}）` }
  ] : []

  useEffect(() => {
    const bestId = bestOpportunity?.id
    if (!bestId || bestId === selected?.id || busy || !executionSessionIdle) return
    const delay = Math.max(1_000, manualSelectionUntilRef.current - Date.now() + 1_000)
    let timer = 0
    const selectWhenIdle = (): void => {
      if ((document.activeElement as HTMLElement | null)?.id === 'quantity') {
        timer = window.setTimeout(selectWhenIdle, 1_000)
        return
      }
      setSelectedId(bestId)
    }
    timer = window.setTimeout(selectWhenIdle, delay)
    return () => window.clearTimeout(timer)
  }, [bestOpportunity?.id, busy, executionSessionIdle, selected?.id])

  useEffect(() => {
    const becameExecutable = canExecute && !previousCanExecuteRef.current
    previousCanExecuteRef.current = canExecute
    if (!snapshot || !selected || !canExecute || !snapshot.settings.opportunitySoundEnabled) return
    const lastAlerted = soundCooldownRef.current.get(selected.id) ?? 0
    if (!becameExecutable && now - lastAlerted < snapshot.settings.opportunitySoundCooldownSeconds * 1_000) return
    playOpportunityChime(snapshot.settings.opportunitySoundVolume)
    soundCooldownRef.current.set(selected.id, now)
  }, [canExecute, now, selected?.id, snapshot?.settings.opportunitySoundCooldownSeconds, snapshot?.settings.opportunitySoundEnabled, snapshot?.settings.opportunitySoundVolume])

  useEffect(() => {
    if (!snapshot?.activeSession?.id) return
    setFillQuantity('')
    setFillPrice('')
    setFillOrderId('')
    setManualFillAcknowledged(false)
  }, [snapshot?.activeSession?.id])

  async function run<T>(action: () => Promise<T>, success?: string): Promise<T | undefined> {
    setBusy(true)
    setMessage(undefined)
    try {
      const result = await action()
      if (success) setMessage(success)
      return result
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error)
      const normalized = rawMessage.replace(/^Error invoking remote method '[^']+':\s*/i, '')
      setMessage(/ApiError:\s*aborted/i.test(normalized)
        ? `${normalized.replace(/ApiError:\s*aborted/ig, '请求被中断')}。请检查7890代理连接后重试`
        : normalized)
      return undefined
    } finally {
      setBusy(false)
    }
  }

  async function copyLicenseMachineCode(): Promise<void> {
    try {
      await navigator.clipboard.writeText(license.machineCode)
      setMessage('机器码已复制，可发送给授权管理员续期')
    } catch {
      setMessage(`请手动复制机器码：${license.machineCode}`)
    }
  }

  function selectOpportunity(id: string): void {
    manualSelectionUntilRef.current = Date.now() + 15_000
    setSelectedId(id)
  }

  async function execute(): Promise<void> {
    if (!selected) return
    await run(() => window.arbApp.execute({ opportunityId: selected.id, quantity }), '执行流程已更新')
  }

  async function confirmFill(): Promise<void> {
    await run(
      () => window.arbApp.confirmMexcFill({
        quantity: fillQuantity,
        averagePrice: fillPrice,
        orderId: fillOrderId,
        manualAcknowledged: manualFillAcknowledged
      }),
      '已按人工核对的MEXC成交量发起对冲'
    )
  }

  async function openMexc(): Promise<void> {
    const result = await run(() => window.arbApp.openMexc())
    if (result) setMexcStatus(result)
  }

  async function refreshMexcAccount(): Promise<void> {
    const result = await run(() => window.arbApp.refreshMexcAccount(), 'MEXC账户状态已刷新（未下单）')
    if (result) setMexcStatus(result)
  }

  async function setMexcBrowser(mode: MexcBrowserMode): Promise<void> {
    if (!snapshot) return
    const containerCode = hubstudioCode.trim()
    if (mode === 'HUBSTUDIO' && !containerCode) {
      setMessage('请先填写Hubstudio环境ID')
      return
    }
    const result = await run(() => window.arbApp.updateSettings({
      mexcBrowserMode: mode,
      hubstudioContainerCode: containerCode,
      mexcAutomationEnabled: false
    }))
    if (!result) return
    setSnapshot({ ...snapshot, settings: result })
    setMexcStatus(await window.arbApp.getMexcStatus())
    setMessage(mode === 'HUBSTUDIO' ? '已切换到Hubstudio模式，请从ArbDesk打开环境' : '已切换到内嵌浏览器模式')
  }

  async function calibrate(kind: MexcCalibrationKind): Promise<void> {
    const result = await run(() => window.arbApp.calibrateMexc(kind), `${CALIBRATION_LABELS[kind]}校准完成`)
    if (result) setMexcStatus(result)
  }

  async function setMexcElementMode(mode: 'AUTO' | 'MANUAL'): Promise<void> {
    if (!snapshot) return
    const result = await run(() => window.arbApp.updateSettings({
      mexcElementMode: mode,
      mexcAutomationEnabled: false
    }))
    if (!result) return
    setSnapshot({ ...snapshot, settings: result })
    setMessage(mode === 'AUTO'
      ? '已使用系统自动识别；已保存的手动校准不会参与匹配'
      : '已切换到仅使用手动校准；请完成四个元素的校准')
  }

  async function setMode(mode: 'SIMULATION' | 'ASSISTED'): Promise<void> {
    const result = await run(() => window.arbApp.updateSettings({
      mode,
      ...(mode === 'SIMULATION' ? { mexcAutomationEnabled: false, polymarketLiveEnabled: false, allowUnprofitableTestTrade: false } : {})
    }))
    if (result && snapshot) setSnapshot({ ...snapshot, settings: result })
  }

  async function toggleMexcAutomation(): Promise<void> {
    if (!snapshot) return
    if (!snapshot.settings.mexcAutomationEnabled) {
      const confirmed = window.confirm('启用后，“准备MEXC第一腿”会自动识别涨跌、填入金额并点击对应买入按钮。验证码、按钮禁用或匹配失败会停止；手动校准可覆盖自动识别。确认启用？')
      if (!confirmed) return
    }
    const result = await run(() => window.arbApp.updateSettings({ mexcAutomationEnabled: !snapshot.settings.mexcAutomationEnabled }))
    if (result) setSnapshot({ ...snapshot, settings: result })
  }

  async function savePolymarketCredentials(): Promise<void> {
    const result = await run(() => window.arbApp.updatePolymarketCredentials({
      signatureType: polySignatureType,
      funderAddress: polyFunderAddress,
      signerPrivateKey: polyPrivateKey || undefined
    }), 'Polymarket API凭据已自动派生并加密保存')
    if (!result) return
    setPolymarketCredentials(result)
    setPolyPrivateKey('')
    setPolyValidation(undefined)
  }

  async function validatePolymarketIdentity(): Promise<void> {
    const result = await run(() => window.arbApp.validatePolymarketIdentity(selected?.polymarketTokenId))
    if (!result) return
    setPolyValidation(result)
    if (result.suggestedSignatureType !== undefined) setPolySignatureType(result.suggestedSignatureType)
    setMessage(result.message)
  }

  async function togglePolymarketLive(): Promise<void> {
    if (!snapshot) return
    const enabling = !snapshot.settings.polymarketLiveEnabled
    if (enabling) {
      if (!polyValidation?.ok) {
        setMessage('请先执行“不下单验证”，并处理余额或授权问题')
        return
      }
      const confirmed = window.confirm('启用后，确认MEXC实际成交会立即提交Polymarket精确份额FAK真实对冲；可部分成交并自动补齐剩余敞口。确认启用？')
      if (!confirmed) return
    }
    const result = await run(() => window.arbApp.updateSettings({ polymarketLiveEnabled: enabling }))
    if (result) setSnapshot({ ...snapshot, settings: result })
  }

  async function toggleAutoOpen(): Promise<void> {
    if (!snapshot) return
    const enabling = !snapshot.settings.autoOpenEnabled
    if (enabling) {
      if (!snapshot.settings.mexcAutomationEnabled || !snapshot.settings.polymarketLiveEnabled) {
        setMessage('请先启用MEXC自动点击和Polymarket真实对冲')
        return
      }
      const fixedQuantity = Number(autoFixedQuantityDraft)
      const maximumPercentage = Number(autoMaxQuantityPctDraft)
      const stabilityMs = Number(autoStabilityDraft)
      if (!(fixedQuantity > 0)) {
        setMessage('自动开单固定份额须大于0')
        return
      }
      if (!Number.isInteger(maximumPercentage) || maximumPercentage < 10 || maximumPercentage > 100) {
        setMessage('最大可执行量比例须为10至100的整数')
        return
      }
      if (!Number.isInteger(stabilityMs) || stabilityMs < 0 || stabilityMs > 1_000) {
        setMessage('自动开单稳定时间须为0至1000毫秒的整数')
        return
      }
      const quantityDescription = snapshot.settings.autoOpenQuantityMode === 'FIXED'
        ? `固定${fixedQuantity.toFixed(2)}份`
        : `当前最大可执行量的${maximumPercentage}%`
      const confirmed = window.confirm(`启用后，机会连续${stabilityMs}毫秒满足全部按钮条件就会自动执行${quantityDescription}；每个市场轮次最多一单，异常会自动停用。软件重启后需要重新开启。确认布防？`)
      if (!confirmed) return
    }
    const result = await run(() => window.arbApp.updateSettings(enabling ? {
      autoOpenEnabled: true,
      autoOpenFixedQuantity: Number(autoFixedQuantityDraft).toFixed(2),
      autoOpenMaxQuantityPct: Number(autoMaxQuantityPctDraft),
      autoOpenStabilityMs: Number(autoStabilityDraft)
    } : { autoOpenEnabled: false }))
    if (result) setSnapshot({ ...snapshot, settings: result })
  }

  async function setAutoQuantityMode(mode: 'FIXED' | 'MAX_PERCENT'): Promise<void> {
    if (!snapshot) return
    const result = await run(() => window.arbApp.updateSettings({
      autoOpenQuantityMode: mode,
      autoOpenEnabled: false
    }))
    if (result) setSnapshot({ ...snapshot, settings: result })
  }

  async function saveRecoverySettings(): Promise<void> {
    const maximumLoss = Number(maxRecoveryLossDraft)
    const retryCount = Number(hedgeRetryCountDraft)
    if (!Number.isFinite(maximumLoss) || maximumLoss < 0 || maximumLoss > 10_000) {
      setMessage('恢复对冲最大可接受亏损须为0至10,000 USDT')
      return
    }
    if (!Number.isInteger(retryCount) || retryCount < 0 || retryCount > 5) {
      setMessage('Polymarket自动补单次数须为0至5的整数')
      return
    }
    const result = await run(() => window.arbApp.updateSettings({
      maxRecoveryLossUsdt: maximumLoss.toFixed(2),
      polymarketHedgeRetryCount: retryCount
    }), '第二腿部分成交与恢复参数已保存')
    if (result && snapshot) setSnapshot({ ...snapshot, settings: result })
  }

  async function saveAutoOpenSettings(): Promise<void> {
    const fixedQuantity = Number(autoFixedQuantityDraft)
    const maximumPercentage = Number(autoMaxQuantityPctDraft)
    const stabilityMs = Number(autoStabilityDraft)
    if (!(fixedQuantity > 0)) return setMessage('自动开单固定份额须大于0')
    if (!Number.isInteger(maximumPercentage) || maximumPercentage < 10 || maximumPercentage > 100) {
      return setMessage('最大可执行量比例须为10至100的整数')
    }
    if (!Number.isInteger(stabilityMs) || stabilityMs < 0 || stabilityMs > 1_000) {
      return setMessage('自动开单稳定时间须为0至1000毫秒的整数')
    }
    const result = await run(() => window.arbApp.updateSettings({
      autoOpenFixedQuantity: fixedQuantity.toFixed(2),
      autoOpenMaxQuantityPct: maximumPercentage,
      autoOpenStabilityMs: stabilityMs
    }), '自动开单参数已保存')
    if (result && snapshot) setSnapshot({ ...snapshot, settings: result })
  }

  async function toggleUnprofitableTestTrade(): Promise<void> {
    if (!snapshot) return
    const enabling = !snapshot.settings.allowUnprofitableTestTrade
    if (enabling) {
      const confirmed = window.confirm('仅供跑通链路：放开一次净收益和结算信号门槛。通常限制5 USDT；若平台最小可成交份额需要更多本金，会按实时价格放宽，但绝不超过12 USDT。行情过期与临近结算仍会拦截。确认启用？')
      if (!confirmed) return
    }
    const result = await run(() => window.arbApp.updateSettings({ allowUnprofitableTestTrade: enabling }))
    if (result) {
      setSnapshot({ ...snapshot, settings: result })
      if (enabling && minimumAlignedQuantity > 0) setQuantity(minimumAlignedQuantity.toFixed(2))
    }
  }

  async function saveAndTestPolymarketProxy(): Promise<void> {
    const result = await run(async () => {
      await window.arbApp.updateSettings({ polymarketProxyUrl: polymarketProxyUrl.trim() })
      return await window.arbApp.testPolymarketConnection()
    })
    if (!result) return
    setSnapshot(result)
    setMessage(result.connection.polymarket === 'CONNECTED'
      ? 'Polymarket 代理测试成功，真实公开盘口已连接'
      : result.connectionDetails.polymarket ?? 'Polymarket 仍未连接')
  }

  function updateSettlementRule(id: string, field: 'remainingSeconds' | 'minimumBps', value: string): void {
    setSettlementRuleDrafts((rules) => rules.map((rule) => rule.id === id ? { ...rule, [field]: value } : rule))
    setSettlementRuleError(undefined)
  }

  function addSettlementRule(): void {
    const usedSeconds = new Set(settlementRuleDrafts.map((rule) => Number(rule.remainingSeconds)))
    let suggestedSeconds = 60
    while (usedSeconds.has(suggestedSeconds)) suggestedSeconds += 10
    setSettlementRuleDrafts((rules) => [
      ...rules,
      { id: `rule-${Date.now()}-${rules.length}`, remainingSeconds: String(suggestedSeconds), minimumBps: '' }
    ])
    setSettlementRuleError(undefined)
  }

  function removeSettlementRule(id: string): void {
    if (settlementRuleDrafts.length <= 1) {
      setSettlementRuleError('动态安全距离至少保留一个规则节点')
      return
    }
    setSettlementRuleDrafts((rules) => rules.filter((rule) => rule.id !== id))
    setSettlementRuleError(undefined)
  }

  function resetSettlementRules(): void {
    setSettlementRuleDrafts(defaultSettlementDistanceRules().map((rule) => ({
      id: rule.id,
      remainingSeconds: String(rule.remainingSeconds),
      minimumBps: rule.minimumBps
    })))
    setSettlementRuleError(undefined)
  }

  function parseSettlementRules(): SettlementDistanceRule[] | undefined {
    if (settlementRuleDrafts.length === 0) {
      setSettlementRuleError('动态安全距离至少保留一个规则节点')
      return undefined
    }
    const secondsSeen = new Set<number>()
    const parsed: SettlementDistanceRule[] = []
    for (const [index, draft] of settlementRuleDrafts.entries()) {
      const remainingSeconds = Number(draft.remainingSeconds)
      const minimumBps = Number(draft.minimumBps)
      if (!draft.remainingSeconds.trim() || !Number.isInteger(remainingSeconds) || remainingSeconds < 0 || remainingSeconds > 86_400) {
        setSettlementRuleError(`第${index + 1}行：剩余秒数须为0至86400的整数`)
        return undefined
      }
      if (!draft.minimumBps.trim() || !Number.isFinite(minimumBps) || minimumBps < 0 || minimumBps > 10_000) {
        setSettlementRuleError(`第${index + 1}行：最低bps须在0至10000之间`)
        return undefined
      }
      if (secondsSeen.has(remainingSeconds)) {
        setSettlementRuleError(`剩余${remainingSeconds}秒存在重复规则`)
        return undefined
      }
      secondsSeen.add(remainingSeconds)
      parsed.push({ id: draft.id, remainingSeconds, minimumBps: String(minimumBps) })
    }
    return parsed.sort((left, right) => right.remainingSeconds - left.remainingSeconds)
  }

  async function saveSettlementRules(): Promise<void> {
    const settlementDistanceRules = parseSettlementRules()
    if (!settlementDistanceRules) return
    const result = await run(async () => {
      await window.arbApp.updateSettings({ settlementDistanceRules })
      return await window.arbApp.refreshOpportunities()
    }, '动态安全距离规则已保存并应用')
    if (!result) return
    setSnapshot(result)
    setSettlementRuleDrafts(result.settings.settlementDistanceRules.map((rule) => ({
      id: rule.id,
      remainingSeconds: String(rule.remainingSeconds),
      minimumBps: rule.minimumBps
    })))
    setSettlementRuleError(undefined)
  }

  async function saveDecisionSettings(): Promise<void> {
    const maxCapital = Number(maxCapitalDraft)
    if (!Number.isFinite(maxCapital) || maxCapital <= 0 || maxCapital > 1_000_000) {
      setMessage('单笔最大本金须为大于0且不超过1,000,000 USDT的数值')
      return
    }
    const edge = Number(minNetEdgeDraft)
    if (!Number.isFinite(edge) || edge < 0 || edge >= 1) {
      setMessage('最低净边际须为0至1之间的美元/份数值')
      return
    }
    const conditionalReturn = Number(minConditionalReturnDraft)
    if (!Number.isFinite(conditionalReturn) || conditionalReturn < 0 || conditionalReturn > 100) {
      setMessage('最低条件收益率须为0至100之间的百分比')
      return
    }
    const quoteValiditySeconds = Number(quoteValidityDraft)
    if (!Number.isInteger(quoteValiditySeconds) || quoteValiditySeconds < 3 || quoteValiditySeconds > 30) {
      setMessage('行情最长未确认时间须为3至30秒的整数')
      return
    }
    const cooldownSeconds = Number(soundCooldownDraft)
    if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 5 || cooldownSeconds > 3_600) {
      setMessage('提示音重复间隔须为5至3600秒的整数')
      return
    }
    const result = await run(() => window.arbApp.updateSettings({
      maxCapitalPerTrade: maxCapital.toFixed(2),
      minNetEdgePerShare: edge.toFixed(4),
      minConditionalReturnPct: conditionalReturn.toFixed(2),
      maxQuoteAgeMs: quoteValiditySeconds * 1_000,
      opportunitySoundEnabled: soundEnabledDraft,
      opportunitySoundVolume: soundVolumeDraft,
      opportunitySoundCooldownSeconds: cooldownSeconds
    }), '下单门槛与提示音设置已保存')
    if (result && snapshot) setSnapshot({ ...snapshot, settings: result })
  }

  async function setMaximumQuantity(): Promise<void> {
    if (!snapshot || !selected) return
    const result = await run(async () => {
      const maximumPlan = await window.arbApp.calculateExecutionPlan({
        opportunityId: selected.id,
        useMaximum: true,
        refreshStaleAccounts: snapshot.settings.mode === 'ASSISTED'
      })
      if (Number(maximumPlan.maxExecutableQuantity) >= Number(maximumPlan.minimumQuantity)) {
        return { kind: 'EXECUTABLE' as const, plan: maximumPlan, quantity: maximumPlan.maxExecutableQuantity }
      }
      if (Number(maximumPlan.maxAffordableQuantity) >= Number(maximumPlan.minimumQuantity)) {
        const affordablePlan = await window.arbApp.calculateExecutionPlan({
          opportunityId: selected.id,
          quantity: maximumPlan.maxAffordableQuantity,
          refreshStaleAccounts: false
        })
        return { kind: 'AFFORDABLE' as const, plan: affordablePlan, quantity: maximumPlan.maxAffordableQuantity }
      }
      return { kind: 'BELOW_MINIMUM' as const, plan: maximumPlan }
    })
    if (!result) return
    setExecutionPlan(result.plan)
    if (result.kind === 'BELOW_MINIMUM') {
      setMessage(`账户、单笔本金和盘口最多支持${result.plan.maxAffordableQuantity}份，低于平台最小对齐${result.plan.minimumQuantity}份；限制：${result.plan.affordableLimitingFactors.join('、') || '盘口深度'}`)
      return
    }
    setQuantity(result.quantity)
    if (result.kind === 'AFFORDABLE') {
      setMessage(`已按账户可支付上限调整为${result.quantity}份（余额预留${result.plan.accountBalanceReservePct}%）；当前仍不可执行：${result.plan.blockReason ?? result.plan.limitingFactors.join('、')}`)
      return
    }
    setMessage(`最大可执行${result.quantity}份 · 账户可付${result.plan.maxAffordableQuantity}份 · MEXC ${result.plan.mexcLevelsUsed}档 / Poly ${result.plan.polymarketLevelsUsed}档 · 滑点后收益率${result.plan.conditionalReturnPct}%`)
  }

  async function confirmCloseOrder(): Promise<void> {
    if (!closeIntent) return
    const result = await run(
      () => window.arbApp.closeOrder({ orderId: closeIntent.order.id, target: closeIntent.target }),
      closeIntent.target === 'BOTH' ? '双腿平仓流程已完成' : '单腿平仓流程已完成，请注意剩余敞口'
    )
    if (result) {
      setCloseIntent(undefined)
      setHistoryOpen(true)
    }
  }

  function openSettings(view: SettingsView = 'MAIN'): void {
    setSettingsView(view)
    setSettingsOpen(true)
  }

  function closeSettings(): void {
    setSettingsOpen(false)
    setSettingsView('MAIN')
  }

  if (!snapshot) {
    return (
      <main className="loading-screen">
        <LoaderCircle className="spin" aria-hidden="true" />
        <p>正在启动交易引擎…</p>
      </main>
    )
  }

  const active = snapshot.activeSession
  const executionNoticeKey = active ? `${active.id}:${active.state}:${active.error ?? ''}` : undefined
  const automaticLiveFlow = snapshot.settings.mexcAutomationEnabled && snapshot.settings.polymarketLiveEnabled
  const needsMexcConfirmation = active &&
    ['MEXC_SUBMITTED', 'MEXC_SUBMITTING'].includes(active.state) &&
    !automaticLiveFlow
  const mexcReadbackError = active?.error?.startsWith('MEXC成交回读') ? active.error : undefined

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Activity aria-hidden="true" /></div>
          <strong>ArbDesk</strong>
        </div>
        <div className="connection-strip" aria-label="连接状态">
          <span title={snapshot.connectionDetails.mexc}><StatusDot status={snapshot.connection.mexc} />MEXC {snapshot.connection.mexc === 'BROWSER_READY' ? (snapshot.settings.mexcBrowserMode === 'HUBSTUDIO' ? 'Hubstudio' : '内嵌') : '未连接'}</span>
          <span title={snapshot.connectionDetails.polymarket}><StatusDot status={snapshot.connection.polymarket} />Polymarket {snapshot.connection.polymarket === 'CONNECTED' ? '在线' : '断开'}</span>
        </div>
        <div className="top-actions">
          <div className={`mode-badge ${snapshot.settings.mode.toLowerCase()}`}>
            {snapshot.settings.mode === 'SIMULATION' ? '模拟模式' : snapshot.settings.mode === 'ASSISTED' ? '人工监督' : '实盘'}
          </div>
          <button className="icon-button has-count" onClick={() => setHistoryOpen(true)} aria-label={`打开历史订单，共${snapshot.orderHistory.length}组`}>
            <History aria-hidden="true" />{snapshot.orderHistory.length > 0 && <span>{Math.min(99, snapshot.orderHistory.length)}</span>}
          </button>
          <button className="icon-button" onClick={() => setLogsOpen(true)} aria-label="打开执行日志">
            <ScrollText aria-hidden="true" />
          </button>
          <button className="icon-button" onClick={() => openSettings()} aria-label="打开设置">
            <Settings2 aria-hidden="true" />
          </button>
        </div>
      </header>

      <button className="risk-banner" type="button" onClick={() => openSettings('RISK')} aria-label="查看条件型结算风险设置">
        <ShieldAlert aria-hidden="true" />
        <span><strong>条件型：</strong>两平台结算源不同</span>
        <ChevronRight className="risk-banner-arrow" aria-hidden="true" />
      </button>

      <main className="workspace">
        <section className="main-column">
          <section className="panel opportunities-panel">
            <div className="panel-header">
              <div className="scanner-title"><h1>BTC 跨平台机会</h1><span>{snapshot.opportunities.length}条 · {readyOpportunityCount}条可执行</span></div>
              <button className="icon-button scanner-refresh" onClick={() => void run(() => window.arbApp.refreshOpportunities())} disabled={busy} aria-label="刷新套利机会" title="刷新套利机会">
                <RefreshCw className={busy ? 'spin' : ''} aria-hidden="true" />
              </button>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>周期</th><th>MEXC</th><th>Polymarket</th><th>全部成本</th><th>净边际</th><th title="两边盘口深度允许的对齐数量，不含账户余额和收益门槛">盘口量</th><th>剩余</th></tr>
                </thead>
                <tbody>
                  {snapshot.opportunities.length === 0 && (
                    <tr><td colSpan={7}><div className="empty-state">暂无真实跨平台报价。{snapshot.connectionDetails.polymarket}</div></td></tr>
                  )}
                  {orderedOpportunities.map((opportunity) => {
                    const positive = opportunityReady(opportunity, snapshot, now)
                    const isSelected = opportunity.id === selected?.id
                    const isBest = opportunity.id === bestOpportunity?.id
                    return (
                      <tr key={opportunity.id} className={['opportunity-row', positive ? 'ready' : '', isBest ? 'best' : '', isSelected ? 'selected' : ''].filter(Boolean).join(' ')} onClick={() => selectOpportunity(opportunity.id)} tabIndex={0} onKeyDown={(event) => event.key === 'Enter' && selectOpportunity(opportunity.id)}>
                        <td><span className="duration-pill">{opportunity.durationMinutes}m</span>{isBest && <span className="best-badge">最佳</span>}</td>
                        <td><span className="quote-inline"><Direction direction={opportunity.mexcDirection} /><span className="mono">{money(opportunity.mexcPrice, 4)}</span></span></td>
                        <td><span className="quote-inline"><Direction direction={opportunity.polymarketDirection} /><span className="mono">{money(opportunity.polymarketPrice, 4)}</span></span></td>
                        <td className="mono">{opportunity.feeVerificationBlocked ? '—' : money(opportunity.allInCostPerShare, 4)}</td>
                        <td><span className="edge-cell" title={opportunity.feeVerificationBlocked ? '费用待校验' : opportunity.settlementRiskBlocked ? '风控拦截' : positive ? '当前可执行' : '未通过全部执行门槛'}>
                          <span className={positive ? 'positive-value' : 'negative-value'}>
                            {opportunity.feeVerificationBlocked ? '—' : `${positive ? '+' : ''}${money(opportunity.netEdgePerShare, 4)}`}
                          </span>
                          {!positive && <AlertTriangle aria-hidden="true" />}
                        </span></td>
                        <td className="mono">{money(opportunity.maxQuantity, 0)}</td>
                        <td className="mono countdown">{secondsRemaining(opportunity.endTime, now)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

        </section>

        <aside className="order-ticket panel" aria-label="执行面板">
          {selected ? (
            <>
              <label className="field-label" htmlFor="quantity">对齐份额</label>
              <div className="quantity-control">
                <input id="quantity" value={quantity} inputMode="decimal" onChange={(event) => setQuantity(event.target.value)} />
                <button onClick={() => snapshot.settings.allowUnprofitableTestTrade
                  ? setQuantity(minimumAlignedQuantity.toFixed(2))
                  : void setMaximumQuantity()} disabled={busy}>
                  {snapshot.settings.allowUnprofitableTestTrade ? '最小' : busy ? '计算中' : '最大'}
                </button>
              </div>

              <div className="execute-action-row">
                <button className="execute-button" onClick={() => void execute()} disabled={!canExecute} title="点击后先复核所选两边盘口；确认MEXC实际成交后才会提交Polymarket对冲">
                  {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}
                  {snapshot.settings.mode === 'SIMULATION'
                    ? '模拟执行两腿'
                    : snapshot.settings.mexcAutomationEnabled
                      ? '执行MEXC第一腿'
                      : '准备MEXC第一腿'}
                </button>
                <ExecutionConditionsHelp checks={executionChecks} />
              </div>
              {snapshot.settings.autoOpenEnabled && <div className={`browser-status-detail auto-open-status ${snapshot.autoOpenState.status.toLowerCase()}`} role="status" aria-live="polite"><span>AUTO</span><p>{snapshot.autoOpenState.message}</p></div>}
              {currentPlan && <div className="capacity-summary" title={`账户余额计算已预留${currentPlan.accountBalanceReservePct}%安全垫`}>
                <span title={`限制：${currentPlan.affordableLimitingFactors.join('、') || '盘口深度'}`}>{snapshot.settings.mode === 'ASSISTED' ? '账户可付' : '本金可用'} <strong>{currentPlan.maxAffordableQuantity}</strong>份</span>
                <span title={`限制：${currentPlan.limitingFactors.join('、') || '盘口深度'}`}>收益可执行 <strong>{currentPlan.maxExecutableQuantity}</strong>份</span>
              </div>}
              {!canExecute && executeBlockReason && <p className="execution-note"><AlertTriangle aria-hidden="true" />禁用原因：{executeBlockReason}</p>}

              {(selected.feeVerificationBlocked || selected.settlementRiskBlocked || selected.stale || Number(selected.netEdgePerShare) < Number(snapshot.settings.minNetEdgePerShare)) && selected.riskFlags.length > 0 && (
                <div className="inline-warning"><AlertTriangle aria-hidden="true" /><span>{selected.riskFlags[0]}</span></div>
              )}

              <div className="cost-breakdown">
                <Row label="预计占用本金" value={selected.feeVerificationBlocked ? '—' : `$${requestedCapital.toFixed(2)}`} emphasized />
                <Row label="预计利润" value={selected.feeVerificationBlocked ? '—' : `${requestedProfit >= 0 ? '+' : ''}$${requestedProfit.toFixed(2)}`} positive={!selected.feeVerificationBlocked && requestedProfit > 0} />
                <Row label="动态安全距离" value={`${money(selected.settlementDistanceBps, 2)} / ${money(selected.requiredSettlementDistanceBps, 2)} bps`} positive={Number(selected.settlementDistanceBps) >= Number(selected.requiredSettlementDistanceBps)} />
                <details className="ticket-calculation-details">
                  <summary>风险与费用明细</summary>
                  <div>
                    <FormulaHelp inline />
                    <Row
                      label="条件收益率"
                      value={selected.feeVerificationBlocked ? '—' : `${Number(effectiveConditionalReturn) >= 0 ? '+' : ''}${money(effectiveConditionalReturn, 2)}%`}
                      positive={!selected.feeVerificationBlocked && Number(effectiveConditionalReturn) > 0}
                    />
                    <Row label="最坏亏损率" value={selected.feeVerificationBlocked ? '—' : `${money(selected.worstCaseReturnPct, 2)}%`} />
                    <Row label="MEXC结算信号" value={selected.mexcSignal
                      ? <SignalValue direction={selected.mexcSignal} distanceBps={selected.mexcDistanceBps} />
                      : '未知'} />
                    <Row label="Polymarket结算信号" value={selected.polymarketSignal
                      ? <SignalValue direction={selected.polymarketSignal} distanceBps={selected.polymarketDistanceBps} />
                      : '未知'} />
                    <div className="breakdown-divider" />
                    <Row label="MEXC本金" value={`$${currentPlan?.mexcSpend ?? money(Number(selected.mexcPrice) * Number(quantity || 0) + '', 2)}`} />
                    <Row label="Polymarket本金" value={`$${currentPlan?.polymarketSpend ?? money(Number(selected.polymarketPrice) * Number(quantity || 0) + '', 2)}`} />
                    <Row label="MEXC手续费" value={selected.mexcFeeRateSource === 'HISTORY' ? `$${currentPlan ? money(currentPlan.mexcFee, 2) : money(Number(selected.mexcFeePerShare) * Number(quantity || 0) + '', 2)}` : '—'} />
                    <Row label="Polymarket手续费" value={`$${currentPlan ? money(currentPlan.polymarketFee, 2) : money(Number(selected.polymarketFeePerShare) * Number(quantity || 0) + '', 2)}`} />
                    {currentPlan && <Row label="盘口档位" value={`MEXC ${currentPlan.mexcLevelsUsed}档 / Poly ${currentPlan.polymarketLevelsUsed}档`} />}
                    <Row label="风险缓冲" value={`$${money(Number(selected.riskBufferPerShare) * Number(quantity || 0) + '', 2)}`} />
                    <Row label="两边同时输" value={selected.feeVerificationBlocked ? '—' : `-$${Math.abs(requestedBothLose).toFixed(2)}`} />
                    <Row label="两边同时赢" value={selected.feeVerificationBlocked ? '—' : `+$${requestedBothWin.toFixed(2)}`} positive={!selected.feeVerificationBlocked} />
                  </div>
                </details>
              </div>
            </>
          ) : <div className="empty-state">没有可用机会</div>}
        </aside>
      </main>

      {active && executionNoticeKey !== dismissedExecutionNoticeKey && <ExecutionBar
        session={active}
        busy={busy}
        onRetry={() => void run(async () => {
          const result = await window.arbApp.retryPolymarketHedge()
          if (result.state !== 'HEDGED') throw new Error(result.error ?? '仍有未对冲份额，请继续恢复或平仓处理')
          return result
        }, 'Polymarket剩余敞口恢复完成')}
        onOpenHistory={() => setHistoryOpen(true)}
        onDismiss={() => setDismissedExecutionNoticeKey(executionNoticeKey)}
      />}

      {needsMexcConfirmation && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="fill-title">
            <div className="modal-heading"><div><span className="eyebrow">MEXC FILL READBACK</span><h2 id="fill-title">等待MEXC真实成交</h2></div></div>
            <div className="modal-warning"><ShieldAlert aria-hidden="true" /><span>软件在人工监督模式下<strong>不会点击MEXC买入</strong>。请先确认MEXC页面的周期、方向和金额，再手动点击买入；软件读取到平台成交记录后会自动开始Polymarket对冲。</span></div>
            <div className={`manual-fill-monitor ${mexcReadbackError ? 'warning' : ''}`} role="status" aria-live="polite">
              {mexcReadbackError ? <AlertTriangle aria-hidden="true" /> : <LoaderCircle className="spin" aria-hidden="true" />}
              <div><strong>{mexcReadbackError ? '暂未读取到平台成交' : '正在监听MEXC成交流水'}</strong><small>{mexcReadbackError ?? '只接受本轮市场、方向和开始时间之后的真实成交；不会使用申请数量代替成交数量。'}</small></div>
            </div>
            <details className="manual-fill-override">
              <summary><AlertTriangle aria-hidden="true" />自动读取失败？使用人工强制录入</summary>
              <div className="manual-fill-override-body">
                <p>仅在你已经打开MEXC“成交记录”，逐项核对真实成交后使用。人工数据无法由软件验证，填写错误会直接造成单边持仓。</p>
                <div className="form-grid">
                  <label>实际成交份额<input value={fillQuantity} onChange={(event) => setFillQuantity(event.target.value)} inputMode="decimal" autoComplete="off" /></label>
                  <label>成交均价<input value={fillPrice} onChange={(event) => setFillPrice(event.target.value)} inputMode="decimal" autoComplete="off" /></label>
                  <label className="span-two">MEXC真实订单号<input value={fillOrderId} onChange={(event) => setFillOrderId(event.target.value)} placeholder="必须填写成交记录中的订单号" autoComplete="off" /></label>
                </div>
                <label className="manual-fill-acknowledgement"><input type="checkbox" checked={manualFillAcknowledged} onChange={(event) => setManualFillAcknowledged(event.target.checked)} /><span>我已在MEXC成交记录中核对以上数量、均价和订单号，并理解软件尚未从平台回读验证。</span></label>
                <button className="danger-confirm-button manual-fill-confirm" onClick={() => void confirmFill()} disabled={busy || !fillQuantity || !fillPrice || !fillOrderId.trim() || !manualFillAcknowledged}><ShieldAlert aria-hidden="true" />按人工成交记录启动对冲</button>
              </div>
            </details>
            <button className="wide-secondary manual-fill-cancel" onClick={() => void run(() => window.arbApp.cancelExecution())} disabled={busy}>我尚未在MEXC下单，取消本次</button>
          </section>
        </div>
      )}

      {historyOpen && <HistoryModal
        orders={snapshot.orderHistory}
        busy={busy}
        onDismiss={() => setHistoryOpen(false)}
        onCloseOrder={(order, target) => {
          setHistoryOpen(false)
          setCloseIntent({ order, target })
        }}
      />}

      {logsOpen && <LogsModal events={snapshot.recentEvents} onDismiss={() => setLogsOpen(false)} />}

      {closeIntent && <CloseConfirmModal
        intent={closeIntent}
        busy={busy}
        onDismiss={() => setCloseIntent(undefined)}
        onConfirm={() => void confirmCloseOrder()}
      />}

      {settingsOpen && (
        <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeSettings()}>
          <aside className="settings-drawer" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="drawer-header">
              <div className="drawer-heading">
                {settingsView !== 'MAIN' && <button className="settings-back-button" onClick={() => setSettingsView('MAIN')} aria-label="返回设置主页"><ArrowLeft /></button>}
                <div><h2 id="settings-title">{settingsView === 'MAIN' ? '设置' : settingsView === 'RISK' ? '风控规则' : settingsView === 'LIVE' ? '实盘控制' : '账户与环境'}</h2></div>
              </div>
              <button className="icon-button" onClick={closeSettings} aria-label="关闭设置"><X /></button>
            </div>
            {settingsView === 'MAIN' && <>
            <section className="settings-section decision-settings-section">
              <div className="settings-title-row"><h3>执行与提醒</h3><span className="ready-text">实时生效</span></div>
              <div className="segmented-control">
                <button className={snapshot.settings.mode === 'SIMULATION' ? 'active' : ''} onClick={() => void setMode('SIMULATION')}><Bot />模拟</button>
                <button className={snapshot.settings.mode === 'ASSISTED' ? 'active' : ''} onClick={() => void setMode('ASSISTED')}><SlidersHorizontal />人工监督</button>
              </div>
              <p>人工监督会先执行MEXC，确认实际成交后才对冲；“最大”会逐档计算两边深度、滑点和费用，并受余额、本金及最低收益门槛共同限制。</p>
              <div className="decision-field-grid">
                <label className="settings-field" htmlFor="max-capital">单笔最大本金（USDT）
                  <input id="max-capital" value={maxCapitalDraft} onChange={(event) => setMaxCapitalDraft(event.target.value)} inputMode="decimal" />
                </label>
                <label className="settings-field" htmlFor="min-net-edge">最低净边际（美元/份）
                  <input id="min-net-edge" value={minNetEdgeDraft} onChange={(event) => setMinNetEdgeDraft(event.target.value)} inputMode="decimal" />
                </label>
                <label className="settings-field" htmlFor="min-conditional-return">最低条件收益率（%）
                  <input id="min-conditional-return" value={minConditionalReturnDraft} onChange={(event) => setMinConditionalReturnDraft(event.target.value)} inputMode="decimal" />
                </label>
                <label className="settings-field" htmlFor="quote-validity">行情最长未确认（秒）
                  <input id="quote-validity" type="number" min="3" max="30" step="1" value={quoteValidityDraft} onChange={(event) => setQuoteValidityDraft(event.target.value)} inputMode="numeric" />
                </label>
              </div>
              <div className="sound-setting-row">
                <label htmlFor="opportunity-sound"><input id="opportunity-sound" type="checkbox" checked={soundEnabledDraft} onChange={(event) => setSoundEnabledDraft(event.target.checked)} />可下单提示音</label>
                <button className="secondary-button" onClick={() => playOpportunityChime(soundVolumeDraft)}><Volume2 aria-hidden="true" />测试</button>
              </div>
              {soundEnabledDraft && <><label className="settings-field volume-field" htmlFor="sound-volume">提示音音量 · {Math.round(soundVolumeDraft * 100)}%
                <input id="sound-volume" type="range" min="0.1" max="1" step="0.05" value={soundVolumeDraft} onChange={(event) => setSoundVolumeDraft(Number(event.target.value))} disabled={!soundEnabledDraft} />
              </label>
              <label className="settings-field" htmlFor="sound-cooldown">重复提示间隔（秒）
                <input id="sound-cooldown" type="number" min="5" max="3600" step="1" value={soundCooldownDraft} onChange={(event) => setSoundCooldownDraft(event.target.value)} disabled={!soundEnabledDraft} inputMode="numeric" />
              </label></>}
              <button className="wide-secondary rule-save-button" onClick={() => void saveDecisionSettings()} disabled={busy}><Check aria-hidden="true" />保存执行与提醒</button>
            </section>
            <nav className="settings-menu" aria-label="更多设置模块">
              <button className="settings-menu-card" onClick={() => setSettingsView('RISK')}>
                <div><strong>风控规则</strong><span>动态安全距离 · {snapshot.settings.settlementDistanceRules.length}个节点</span><small>控制临近结算时允许开仓的最小价格距离</small></div><ChevronRight />
              </button>
              <button className="settings-menu-card" onClick={() => setSettingsView('LIVE')}>
                <div><strong>实盘控制</strong><span>{snapshot.settings.autoOpenEnabled ? '自动开单已布防' : snapshot.settings.mexcAutomationEnabled ? 'MEXC自动点击已开' : '自动执行已关'} · {snapshot.settings.polymarketLiveEnabled ? '真实对冲已开' : '真实对冲已关'}</span><small>管理自动点击、真实FAK、自动开单与一次性小额联调</small></div><ChevronRight />
              </button>
              <button className="settings-menu-card" onClick={() => setSettingsView('ACCOUNT')}>
                <div><strong>账户与环境</strong><span>{snapshot.settings.mexcBrowserMode === 'HUBSTUDIO' ? 'Hubstudio' : '内嵌MEXC'} · {polymarketCredentials?.configured ? 'Polymarket已配置' : 'Polymarket未配置'}</span><small>低频配置：浏览器环境、网络、校准和交易身份</small></div><ChevronRight />
              </button>
            </nav>
            </>}
            {settingsView === 'RISK' && <section className="settings-section settlement-rules-section settings-subpage-section">
              <div className="settings-title-row">
                <div><h3>动态安全距离</h3><span className="settings-kicker">剩余时间 → 最低 bps</span></div>
                <FormulaHelp compact />
              </div>
              <p>规则按剩余秒数从大到小应用，节点之间线性插值；超出节点范围时使用最近端点。到期前{snapshot.settings.stopBeforeExpirySeconds}秒禁止开仓仍独立生效。</p>
              <div className="settlement-rule-head" aria-hidden="true"><span>剩余秒数</span><span>最低距离</span><span>操作</span></div>
              <div className="settlement-rule-list">
                {settlementRuleDrafts.map((rule, index) => (
                  <div className="settlement-rule-row" key={rule.id}>
                    <label>
                      <span>第{index + 1}行剩余秒数</span>
                      <input
                        value={rule.remainingSeconds}
                        onChange={(event) => updateSettlementRule(rule.id, 'remainingSeconds', event.target.value)}
                        inputMode="numeric"
                        aria-label={`第${index + 1}行剩余秒数`}
                      />
                      <small>秒</small>
                    </label>
                    <label>
                      <span>第{index + 1}行最低距离</span>
                      <input
                        value={rule.minimumBps}
                        onChange={(event) => updateSettlementRule(rule.id, 'minimumBps', event.target.value)}
                        inputMode="decimal"
                        aria-label={`第${index + 1}行最低距离bps`}
                      />
                      <small>bps</small>
                    </label>
                    <button
                      className="rule-delete-button"
                      onClick={() => removeSettlementRule(rule.id)}
                      disabled={settlementRuleDrafts.length <= 1}
                      aria-label={`删除第${index + 1}行规则`}
                    ><Trash2 aria-hidden="true" /></button>
                  </div>
                ))}
              </div>
              {settlementRuleError && <p className="settings-inline-error" role="alert">{settlementRuleError}</p>}
              <div className="settlement-rule-actions">
                <button className="secondary-button" onClick={addSettlementRule} disabled={settlementRuleDrafts.length >= 20}><Plus aria-hidden="true" />添加节点</button>
                <button className="secondary-button" onClick={resetSettlementRules}><RotateCcw aria-hidden="true" />恢复默认</button>
              </div>
              <button className="wide-secondary rule-save-button" onClick={() => void saveSettlementRules()} disabled={busy}><Check aria-hidden="true" />保存并立即应用</button>
            </section>}
            {settingsView === 'ACCOUNT' && <>
            <div className="settings-module-intro">这些项目通常只在首次安装、更换环境或连接异常时调整。</div>
            <details className="settings-module license-settings-module">
              <summary><div><strong>软件授权</strong><span className="ready-text">已授权 · 剩余{formatLicenseRemaining(license.validUntil ? Math.max(0, Math.floor((license.validUntil - now) / 1_000)) : license.remainingSeconds)}</span><small>查看机器码、到期时间和续期步骤</small></div><ChevronRight /></summary>
              <div className="settings-module-body">
                <div className="machine-code-block compact">
                  <label>本机机器码</label>
                  <div><code>{license.machineCode}</code><button onClick={() => void copyLicenseMachineCode()} aria-label="复制授权机器码" title="复制机器码"><Copy aria-hidden="true" /></button></div>
                  <small>续期时把完整机器码发给授权管理员。机器码不是密码，可以发送；账户密码、助记词和交易私钥不能发送。</small>
                </div>
                <div className="browser-status-detail"><span>有效期</span><p>{license.validUntil ? new Date(license.validUntil).toLocaleString('zh-CN') : '未提供到期时间'} · 当前客户 {license.customer ?? '未命名'}</p></div>
                <ol className="license-renewal-steps">
                  <li>点击上方复制按钮。</li>
                  <li>把机器码发给管理员并说明需要续期多久。</li>
                  <li>到期后软件会回到授权页，再粘贴新授权码即可。</li>
                </ol>
              </div>
            </details>
            <details className="settings-module">
              <summary><div><strong>MEXC环境</strong><span className={mexcStatus?.open ? 'ready-text' : ''}>{mexcStatus?.open ? (mexcStatus.authenticated ? '已连接 · 已登录' : '已连接 · 待登录') : '尚未打开'}</span><small>浏览器模式、Hubstudio环境和账户读取</small></div><ChevronRight /></summary>
              <div className="settings-module-body">
              <div className="segmented-control browser-mode-control">
                <button className={snapshot.settings.mexcBrowserMode === 'EMBEDDED' ? 'active' : ''} onClick={() => void setMexcBrowser('EMBEDDED')}><Bot />内嵌浏览器</button>
                <button className={snapshot.settings.mexcBrowserMode === 'HUBSTUDIO' ? 'active' : ''} onClick={() => void setMexcBrowser('HUBSTUDIO')}><ExternalLink />Hubstudio</button>
              </div>
              {snapshot.settings.mexcBrowserMode === 'HUBSTUDIO' && <><label className="settings-field">Hubstudio环境ID
                <input value={hubstudioCode} onChange={(event) => setHubstudioCode(event.target.value)} placeholder="例如 223012801" inputMode="numeric" />
              </label>
              <button className="wide-secondary" onClick={() => void setMexcBrowser('HUBSTUDIO')} disabled={!hubstudioCode.trim()}><Check />保存并使用Hubstudio</button></>}
              <button className="wide-secondary" onClick={() => void openMexc()}><ExternalLink />打开{snapshot.settings.mexcBrowserMode === 'HUBSTUDIO' ? 'Hubstudio环境' : '内嵌MEXC窗口'}</button>
              <button className="wide-secondary" onClick={() => void refreshMexcAccount()} disabled={!mexcStatus?.open || busy}><RefreshCw />读取账户与委托状态（不下单）</button>
              <p>{snapshot.settings.mexcBrowserMode === 'HUBSTUDIO' ? '行情固定并行扫描BTC 5m/15m，不依赖当前详情页；执行时自动切换到所选周期和轮次。每次启动最多自动打开一次，关闭后需手动重新打开。' : '每次启动时最多自动打开一次内嵌窗口；关闭后由用户手动重新打开，登录Cookie独立持久保存。'}应用不读取或保存登录密码。</p>
              {(mexcStatus?.message || mexcStatus?.account || mexcStatus?.lastOrderCapture) && <details className="credential-help diagnostics-details">
                <summary>连接与账户诊断</summary><div>
              {mexcStatus?.message && <div className="browser-status-detail"><span>{mexcStatus.mode === 'HUBSTUDIO' ? 'HUB' : '内嵌'}</span><p>{mexcStatus.message}{mexcStatus.debuggingPort ? ` · CDP ${mexcStatus.debuggingPort}` : ''}</p></div>}
              {mexcStatus?.account && <div className="browser-status-detail"><span>账户</span><p>
                可用 {mexcStatus.account.availableUsdt ?? '—'} USDT · 持仓 {mexcStatus.account.positionCount} · 活动委托 {mexcStatus.account.openOrderCount} · 历史 {mexcStatus.account.historyCount}<br />
                {mexcStatus.account.message}
                {mexcStatus.account.latestSettlement && <><br />最近结算：{mexcStatus.account.latestSettlement.result === 'WON' ? '胜' : '负'} · {mexcStatus.account.latestSettlement.direction} · 返还 {mexcStatus.account.latestSettlement.payout} USDT</>}
              </p></div>}
              {mexcStatus?.lastOrderCapture && <div className="browser-status-detail"><span>捕获</span><p>
                {mexcStatus.lastOrderCapture.method} {mexcStatus.lastOrderCapture.endpoint} · 请求字段 {mexcStatus.lastOrderCapture.requestFields.length} · 响应字段 {mexcStatus.lastOrderCapture.responseFields.length}<br />
                {mexcStatus.lastOrderCapture.message}
              </p></div>}
                </div>
              </details>}
              </div>
            </details>
            <details className="settings-module">
              <summary><div><strong>网页控制</strong><span>{snapshot.settings.mexcElementMode === 'AUTO' ? '自动识别' : `${Object.values(mexcStatus?.calibrated ?? {}).filter(Boolean).length}/4已校准`}</span><small>自动定位下单元素；页面变化时可改为手动校准</small></div><ChevronRight /></summary>
              <div className="settings-module-body">
              <div className="segmented-control browser-mode-control">
                <button className={snapshot.settings.mexcElementMode === 'AUTO' ? 'active' : ''} onClick={() => void setMexcElementMode('AUTO')}><Bot />系统自动识别</button>
                <button className={snapshot.settings.mexcElementMode === 'MANUAL' ? 'active' : ''} onClick={() => void setMexcElementMode('MANUAL')}><SlidersHorizontal />手动校准</button>
              </div>
              <p>{snapshot.settings.mexcElementMode === 'AUTO'
                ? '代码会按涨/跌、金额框和买入按钮的语义自动定位；手动校准记录在此模式下不会参与匹配。'
                : '只使用你点选保存的四个网页元素，不回退到系统识别。校准点击会被拦截，不会提交订单。'}</p>
              {snapshot.settings.mexcElementMode === 'MANUAL' && <div className="calibration-list">
                {(Object.keys(CALIBRATION_LABELS) as MexcCalibrationKind[]).map((kind, index) => {
                  const calibrated = mexcStatus?.calibrated[kind]
                  return <button key={kind} onClick={() => void calibrate(kind)} disabled={busy}><span>{index + 1}</span><strong>{CALIBRATION_LABELS[kind]}</strong>{calibrated ? <Check className="check-icon" /> : <ChevronRight />}</button>
                })}
              </div>}
              </div>
            </details>
            <details className="settings-module credential-section">
              <summary><div><strong>Polymarket网络</strong><span className={snapshot.connection.polymarket === 'CONNECTED' ? 'ready-text' : ''}>{snapshot.connection.polymarket === 'CONNECTED' ? '公共盘口在线' : '未连接'}</span><small>公开行情连接和独立代理设置</small></div><ChevronRight /></summary>
              <div className="settings-module-body">
              <p>独立测试 Gamma 与 CLOB 公共接口，不依赖MEXC窗口或当前是否有BTC市场；不改变Hubstudio的代理。</p>
              <label className="settings-field" htmlFor="poly-proxy-url">HTTP/HTTPS 代理地址
                <input id="poly-proxy-url" value={polymarketProxyUrl} onChange={(event) => setPolymarketProxyUrl(event.target.value)} placeholder="留空为直连，例如 http://127.0.0.1:7890" spellCheck={false} autoComplete="off" />
              </label>
              <button className="wide-secondary" onClick={() => void saveAndTestPolymarketProxy()} disabled={busy}><Network />保存并测试公开行情</button>
              <div className="browser-status-detail"><span>NET</span><p>{snapshot.connectionDetails.polymarket}</p></div>
              <div className="browser-status-detail"><span>价格源</span><p>当前套利判断直接比较MEXC与Polymarket官方盘口，不需要Chainlink密钥。Chainlink只适合以后作为结算参考价和偏差预警，不作为下单前置条件。</p></div>
              </div>
            </details>
            <details className="settings-module credential-section">
              <summary><div><strong>Polymarket交易身份</strong><span className={polymarketCredentials?.configured ? 'ready-text' : ''}>{polymarketCredentials?.configured ? '已加密配置' : '未配置'}</span><small>仅用于真实下单的账户签名和身份验证</small></div><ChevronRight /></summary>
              <div className="settings-module-body">
              <p>公开行情无需这些信息。以下凭据仅用于真实下单，秘密字段经系统安全存储加密，之后不会回显。</p>
              <div className="credential-route-card">
                <strong>当前可直接配置：Magic邮箱账户或专用EOA</strong>
                <span>邮箱登录选择类型1，并从Magic官方恢复页导出对应signer私钥；专用独立钱包选择类型0。两种路线都由软件自动派生CLOB API凭据。</span>
              </div>
              <div className="credential-grid">
                <label className="settings-field" htmlFor="poly-signature-type">本地签名账户类型
                  <select id="poly-signature-type" value={polySignatureType} onChange={(event) => setPolySignatureType(Number(event.target.value) as PolymarketSignatureType)}>
                    <option value={0}>0 · EOA（当前推荐）</option>
                    <option value={1}>1 · POLY_PROXY（Magic邮箱账户）</option>
                    <option value={2}>2 · GNOSIS_SAFE（高级：需对应signer）</option>
                    <option value={3}>3 · POLY_1271（高级：需deposit wallet signer）</option>
                  </select>
                </label>
                <label className="settings-field" htmlFor="poly-funder">Funder 公开地址
                  <input id="poly-funder" value={polyFunderAddress} onChange={(event) => setPolyFunderAddress(event.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" />
                </label>
                <label className="settings-field" htmlFor="poly-private-key">订单签名私钥
                  <input id="poly-private-key" type="password" value={polyPrivateKey} onChange={(event) => setPolyPrivateKey(event.target.value)} placeholder={polymarketCredentials?.hasSignerPrivateKey ? '已保存；留空表示不修改' : '0x…'} spellCheck={false} autoComplete="new-password" />
                </label>
              </div>
              {polySignatureType === 1 && <div className="credential-notice"><KeyRound aria-hidden="true" /><span>邮箱账户的signer地址通常与Funder不同，这是Proxy结构的正常现象。请使用同一邮箱从Magic官方恢复页导出的私钥，不要把页面显示的公开“签名者地址”填进私钥框。</span></div>}
              {(polySignatureType === 2 || polySignatureType === 3) && <div className="credential-warning"><ShieldAlert aria-hidden="true" /><span>该高级类型仅适用于你已经掌握对应owner/session signer私钥的情况。网站显示的“签名者地址”只是公开地址，不能填进私钥框。</span></div>}
              <div className="credential-notice"><KeyRound aria-hidden="true" /><span>软件会通过官方SDK自动创建或派生API凭据，并与私钥一起用系统钥匙串加密。不要在聊天、截图或日志中发送私钥。</span></div>
              <details className="credential-help">
                <summary>按当前支持方式配置（含你截图页面的说明）</summary>
                <div>
                  <p><strong>先看你截图的位置：</strong>“右上角头像 → Settings → Relayer API 密钥”是gasless链上交易的开发者凭据页，不是CLOB下单身份页。当前软件不读取它，因此不需要点击“新建”；页面中的“签名者地址”也不是私钥。</p>
                  <p><strong>邮箱登录路线（你的情况）：</strong></p>
                  <ol>
                    <li>保持Polymarket登录，打开Magic官方的 <a href="https://reveal.magic.link/polymarket" target="_blank" rel="noreferrer">Polymarket密钥恢复页</a>。</li>
                    <li>使用登录Polymarket的同一邮箱完成Magic验证，然后选择“Export Private Key”。私钥只粘贴到本机软件，不要发给任何人。</li>
                    <li>回到Polymarket，依次点击“右上角头像 → Settings → 个人资料”，复制页面的Address/Polymarket Wallet公开地址作为Funder；不要复制Relayer页面的“签名者地址”。</li>
                    <li>软件中选择 <strong>1 · POLY_PROXY</strong>，填入Funder和导出的私钥，保存后点击“不下单验证”。</li>
                  </ol>
                  <p>如果Magic恢复页提示不支持、导出的账户无法通过验证，先停止配置。这通常表示账户不是经典Magic Proxy，而是较新的Safe/deposit wallet流程，需要对应的owner/session signer或后续外部签名器支持，不能靠猜类型解决。</p>
                  <p><strong>推荐路线 · 专用EOA：</strong>在你自己控制的钱包扩展中创建一个只给本软件使用的新账户；从钱包扩展的账户详情复制公开地址，并在确认是该专用账户后导出它的私钥。不要使用主钱包，也不要填写助记词。</p>
                  <ol>
                    <li>签名类型选择 <strong>0 · EOA</strong>。</li>
                    <li>Funder填写这个专用钱包的公开地址；类型0下它必须与私钥对应地址完全一致。</li>
                    <li>订单签名私钥填写该专用钱包私钥，然后点击“自动派生并加密保存”。</li>
                    <li>给该Funder准备Polymarket当前交易抵押资产及授权，点击“验证交易身份（不下单）”查看余额、allowance与只读账户接口。</li>
                  </ol>
                  <p><strong>其他Polymarket网站账户：</strong>Safe或deposit wallet只有在你掌握对应owner/session signer时才能使用；只知道Funder、签名者地址或Relayer API Key都不够。</p>
                  <p><strong>高级类型对应关系：</strong></p>
                  <ul>
                    <li><strong>1 · POLY_PROXY：</strong>经典Magic邮箱账户；Funder是既有Proxy Wallet，私钥由Magic恢复页导出。</li>
                    <li><strong>2 · GNOSIS_SAFE：</strong>Funder是既有Safe地址，私钥必须属于其owner/session signer。</li>
                    <li><strong>3 · POLY_1271：</strong>Funder是已部署的deposit wallet，私钥必须属于其owner或已批准session signer。本软件目前不会部署钱包或执行首次链上授权。</li>
                  </ul>
                  <p><strong>为什么朋友的软件只填Funder：</strong>通常是因为签名密钥已由客户端预置、授权方注入、远程签名或浏览器会话负责；Funder本身不能签名。本软件目前采用本地加密私钥方案，不会猜测或截取Polymarket网页会话。</p>
                </div>
              </details>
              <button className="wide-secondary" onClick={() => void savePolymarketCredentials()} disabled={busy || !polymarketCredentials?.encryptionAvailable || !polyFunderAddress.trim() || (!polymarketCredentials?.configured && !polyPrivateKey.trim())}><LockKeyhole />自动派生并加密保存</button>
              <button className="wide-secondary" onClick={() => void validatePolymarketIdentity()} disabled={busy || !polymarketCredentials?.configured}><ShieldAlert />验证交易身份（不下单）</button>
              {polymarketCredentials?.message && <div className="browser-status-detail"><span>POLY</span><p>{polymarketCredentials.message}{polymarketCredentials.signerAddress ? ` · Signer ${polymarketCredentials.signerAddress.slice(0, 6)}…${polymarketCredentials.signerAddress.slice(-4)}` : ''}</p></div>}
              {polyValidation && <div className="browser-status-detail"><span>{polyValidation.ok ? 'PASS' : 'CHECK'}</span><p>{polyValidation.message} · 余额 ${polyValidation.collateralBalance} · 授权 {polyValidation.allowanceCount} · 活动委托 {polyValidation.openOrderCount} · 最近成交 {polyValidation.recentTradeCount}{polyValidation.suggestedSignatureType !== undefined ? ` · 已切换建议类型 ${polyValidation.suggestedSignatureType}（尚未保存）` : ''}{polyValidation.closedOnly ? ' · 账户仅可平仓' : ''}</p></div>}
              </div>
            </details>
            </>}
            {settingsView === 'LIVE' && <section className="settings-section danger-zone settings-subpage-section">
              <div><ShieldAlert /><div><h3>一次性最小实盘联调</h3><p>绕过一次净收益与结算信号门槛；通常不超过5 USDT。若最小可成交份额需要更多本金，会按实时最小本金放宽，绝对上限12 USDT，使用后自动关闭。</p></div></div>
              <button className={`automation-toggle ${snapshot.settings.allowUnprofitableTestTrade ? 'enabled' : ''}`} onClick={() => void toggleUnprofitableTestTrade()}>
                {snapshot.settings.allowUnprofitableTestTrade ? <Check /> : <LockKeyhole />}
                {snapshot.settings.allowUnprofitableTestTrade ? '本次已放开 · 点击关闭' : '确认后放开一次'}
              </button>
              <div><ShieldAlert /><div><h3>实验自动点击</h3><p>自动识别涨跌、金额框和买入按钮；也可用手动校准覆盖。按钮禁用或页面变化会中止。</p></div></div>
              <button className={`automation-toggle ${snapshot.settings.mexcAutomationEnabled ? 'enabled' : ''}`} onClick={() => void toggleMexcAutomation()}>
                {snapshot.settings.mexcAutomationEnabled ? <Check /> : <LockKeyhole />}
                {snapshot.settings.mexcAutomationEnabled ? '已启用 · 点击关闭' : '确认后启用'}
              </button>
              <div><ShieldAlert /><div><h3>Polymarket精确份额FAK</h3><p>MEXC成交后按实际份额成交可用盘口，未成交部分自动重新定价补单；更优价格始终允许。</p></div></div>
              <button className={`automation-toggle ${snapshot.settings.polymarketLiveEnabled ? 'enabled' : ''}`} onClick={() => void togglePolymarketLive()}>
                {snapshot.settings.polymarketLiveEnabled ? <Check /> : <LockKeyhole />}
                {snapshot.settings.polymarketLiveEnabled ? '真实对冲已启用 · 点击关闭' : '验证后启用真实对冲'}
              </button>
              <div><ShieldAlert /><div><h3>第二腿恢复保护</h3><p>首轮按正常利润保护价FAK；剩余敞口可在整组最终亏损不超过设置值时自动补单。仍无法成交时可从执行条重试，或在订单历史平掉MEXC。</p></div></div>
              <div className="decision-field-grid">
                <label className="settings-field" htmlFor="recovery-max-loss">恢复最多接受亏损（USDT）
                  <input id="recovery-max-loss" value={maxRecoveryLossDraft} onChange={(event) => setMaxRecoveryLossDraft(event.target.value)} inputMode="decimal" />
                </label>
                <label className="settings-field" htmlFor="hedge-retry-count">自动补单次数
                  <input id="hedge-retry-count" type="number" min="0" max="5" step="1" value={hedgeRetryCountDraft} onChange={(event) => setHedgeRetryCountDraft(event.target.value)} inputMode="numeric" />
                </label>
              </div>
              <button className="wide-secondary" onClick={() => void saveRecoverySettings()} disabled={busy}><Check />保存恢复参数</button>
              <div><Bot /><div><h3>自动开单</h3><p>全部按钮条件连续满足设定时间后触发；期间只读实时缓存，下单热路径不刷新账户。每轮最多一单，异常自动停用。</p></div></div>
              <div className="segmented-control browser-mode-control">
                <button className={snapshot.settings.autoOpenQuantityMode === 'FIXED' ? 'active' : ''} onClick={() => void setAutoQuantityMode('FIXED')} disabled={snapshot.settings.autoOpenEnabled}>固定份额</button>
                <button className={snapshot.settings.autoOpenQuantityMode === 'MAX_PERCENT' ? 'active' : ''} onClick={() => void setAutoQuantityMode('MAX_PERCENT')} disabled={snapshot.settings.autoOpenEnabled}>按最大比例</button>
              </div>
              {snapshot.settings.autoOpenQuantityMode === 'FIXED'
                ? <label className="settings-field" htmlFor="auto-fixed-quantity">每次自动开单份额
                  <input id="auto-fixed-quantity" value={autoFixedQuantityDraft} onChange={(event) => setAutoFixedQuantityDraft(event.target.value)} inputMode="decimal" disabled={snapshot.settings.autoOpenEnabled} />
                </label>
                : <label className="settings-field" htmlFor="auto-max-pct">最大可执行量使用比例
                  <input id="auto-max-pct" value={autoMaxQuantityPctDraft} onChange={(event) => setAutoMaxQuantityPctDraft(event.target.value)} inputMode="numeric" disabled={snapshot.settings.autoOpenEnabled} />
                  <small>建议80%，允许10%至100%</small>
                </label>}
              <label className="settings-field" htmlFor="auto-stability-ms">连续满足时间（毫秒）
                <input id="auto-stability-ms" type="number" min="0" max="1000" step="50" value={autoStabilityDraft} onChange={(event) => setAutoStabilityDraft(event.target.value)} inputMode="numeric" disabled={snapshot.settings.autoOpenEnabled} />
                <small>0极速 · 100推荐 · 300稳健 · 500保守；事件监听到按钮可用后立即进入该确认窗口</small>
              </label>
              <button className="wide-secondary" onClick={() => void saveAutoOpenSettings()} disabled={busy || snapshot.settings.autoOpenEnabled}><Check />保存自动参数</button>
              <button className={`automation-toggle ${snapshot.settings.autoOpenEnabled ? 'enabled' : ''}`} onClick={() => void toggleAutoOpen()} disabled={busy}>
                {snapshot.settings.autoOpenEnabled ? <Check /> : <LockKeyhole />}
                {snapshot.settings.autoOpenEnabled ? '已布防 · 点击停止' : '确认参数并启用自动开单'}
              </button>
              <div className="browser-status-detail"><span>{snapshot.autoOpenState.status}</span><p>{snapshot.autoOpenState.message}</p></div>
            </section>}
          </aside>
        </div>
      )}

      {message && <div className="toast" role="status"><AlertTriangle aria-hidden="true" /><span>{message}</span><button onClick={() => setMessage(undefined)} aria-label="关闭提示"><X /></button></div>}
    </div>
  )
}

function Direction({ direction }: { direction: Direction }): JSX.Element {
  const label = directionLabel(direction)
  return <span className={`direction ${direction.toLowerCase()}`} aria-label={label} title={label}>{direction === 'UP' ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}</span>
}

function SignalValue({ direction, distanceBps }: { direction: Direction; distanceBps?: string }): JSX.Element {
  return <span className="signal-value"><Direction direction={direction} />{distanceBps && <span>{Number(distanceBps) >= 0 ? '+' : ''}{money(distanceBps, 2)} bps</span>}</span>
}

function Row({ label, value, emphasized, positive }: { label: string; value: ReactNode; emphasized?: boolean; positive?: boolean }): JSX.Element {
  return <div className={`breakdown-row ${emphasized ? 'emphasized' : ''} ${positive ? 'positive' : ''}`}><span>{label}</span><strong>{value}</strong></div>
}

function FormulaHelp({ compact = false, inline = false }: { compact?: boolean; inline?: boolean }): JSX.Element {
  return (
    <details className={`formula-help ${compact ? 'compact' : ''} ${inline ? 'inline' : ''}`}>
      <summary aria-label="查看费用、利润和动态安全距离计算方式"><Info aria-hidden="true" />计算方式</summary>
      <div className="formula-popover">
        <strong>费用与收益</strong>
        <p>MEXC手续费/份 = MEXC价格 × 账户最近买入实际费率</p>
        <p>Polymarket手续费/份 = r × [价格 × (1 − 价格)]<sup>e</sup></p>
        <p>总成本/份 = MEXC价格 + Polymarket价格 + 两边手续费 + 风险缓冲</p>
        <p>条件利润 = 份额 × (1 − 总成本/份)</p>
        <p>条件收益率 = 条件利润 ÷ 预计占用本金 × 100%</p>
        <p>最坏亏损率 = 两边同时输损失 ÷ 预计占用本金 × 100%</p>
        <strong>动态安全距离</strong>
        <p>单边bps = |实时价 − 基准价| ÷ 基准价 × 10,000；实际距离取两边较小值。</p>
        <p>插值bps = 低节点bps + (高节点bps − 低节点bps) × (剩余秒数 − 低节点秒数) ÷ (高节点秒数 − 低节点秒数)。</p>
        <p>实际距离须不低于插值结果。默认120秒=2bps、20秒=0.5bps；计算结果是条件场景，不代表保证盈利。</p>
      </div>
    </details>
  )
}

function HistoryModal({
  orders,
  busy,
  onDismiss,
  onCloseOrder
}: {
  orders: ArbitrageOrderRecord[]
  busy: boolean
  onDismiss: () => void
  onCloseOrder: (order: ArbitrageOrderRecord, target: CloseTarget) => void
}): JSX.Element {
  const statusLabels: Record<ArbitrageOrderRecord['status'], string> = {
    OPENING: '开仓中', OPEN: '双腿持仓', UNHEDGED: '单腿敞口', CLOSED: '已平仓',
    RECOVERY_REQUIRED: '需要恢复', CANCELLED: '已取消', EXPIRED: '已到期 · 待结算归档'
  }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onDismiss()}>
      <section className="history-modal" role="dialog" aria-modal="true" aria-labelledby="history-title">
        <div className="modal-heading history-heading">
          <div><span className="eyebrow">ORDER GROUPS</span><h2 id="history-title">套利订单与持仓</h2></div>
          <button className="icon-button" onClick={onDismiss} aria-label="关闭历史订单"><X /></button>
        </div>
        <div className="history-list">
          {orders.length === 0 ? <div className="empty-state">升级后尚无ArbDesk套利订单。</div> : orders.map((order) => {
            const mexcOpen = Number(order.mexc.openQuantity) > 0
            const polymarketOpen = Number(order.polymarket.openQuantity) > 0
            const closeable = Date.now() < order.endTime && !['CLOSED', 'CANCELLED', 'EXPIRED'].includes(order.status)
            const orderIds = entryOrderIds(order)
            return (
              <article className={`history-order ${order.status.toLowerCase()}`} key={order.id}>
                <div className="history-order-head">
                  <div><strong>BTC/USD · {order.durationMinutes}m</strong><span>{triggerSourceLabel(order.triggerSource)} · 执行 {new Date(order.createdAt).toLocaleString('zh-CN', { hour12: false })}</span></div>
                  <span className="order-status">{statusLabels[order.status]}</span>
                </div>
                {order.status === 'EXPIRED' && <p className="history-expired-note"><Info aria-hidden="true" />市场已结束；下方数量是结算前的本地执行记录，不代表当前平台仍有持仓。</p>}
                <div className="history-legs">
                  <div><span className="history-venue">MEXC <Direction direction={order.mexc.direction} /></span><strong>{order.mexc.entryFill ? `${order.mexc.entryFill.quantity}份 @ ${money(order.mexc.entryFill.averagePrice, 4)}` : '未成交'}</strong>{order.mexc.entryFill && <small className={`fill-verification ${order.mexc.entryFill.verificationSource === 'MANUAL_ENTRY' || order.mexc.entryFill.orderId === 'manual-confirm' ? 'manual' : ''}`}>{fillVerificationLabel(order.mexc.entryFill)}</small>}{orderIds.mexc && <small className="history-order-id" title={orderIds.mexc}>订单号 {orderIds.mexc}</small>}{order.mexc.closeFills.at(-1) && <small>最近卖出 @ {money(order.mexc.closeFills.at(-1)!.averagePrice, 4)}</small>}<small>记录剩余 {money(order.mexc.openQuantity, 2)}份</small></div>
                  <div><span className="history-venue">Polymarket <Direction direction={order.polymarket.direction} /></span><strong>{order.polymarket.entryFill ? `${order.polymarket.entryFill.quantity}份 @ ${money(order.polymarket.entryFill.averagePrice, 4)}` : '未成交'}</strong><small>目标对冲 {money(order.polymarket.targetQuantity ?? order.mexc.entryFill?.quantity ?? '0', 2)}份</small>{orderIds.polymarket && <small className="history-order-id" title={orderIds.polymarket}>订单号 {orderIds.polymarket}</small>}{order.polymarket.closeFills.at(-1) && <small>最近卖出 @ {money(order.polymarket.closeFills.at(-1)!.averagePrice, 4)}</small>}<small>记录剩余 {money(order.polymarket.openQuantity, 2)}份</small></div>
                  <div><span>预计本金 / 利润</span><strong>${money(order.expectedCapital)} / {Number(order.expectedProfit) >= 0 ? '+' : ''}${money(order.expectedProfit)}</strong><small>{order.mode === 'SIMULATION' ? '模拟' : '实盘记录'}</small></div>
                </div>
                {order.closeOperation?.error && <p className={`history-error ${order.status === 'EXPIRED' ? 'archived' : ''}`}>{order.status === 'EXPIRED' ? '历史执行备注：' : ''}{order.closeOperation.error}</p>}
                {closeable && (mexcOpen || polymarketOpen) && <div className="history-actions">
                  <button onClick={() => onCloseOrder(order, 'MEXC')} disabled={busy || !mexcOpen}>平 MEXC</button>
                  <button onClick={() => onCloseOrder(order, 'POLYMARKET')} disabled={busy || !polymarketOpen}>平 Polymarket</button>
                  <button className="close-both-button" onClick={() => onCloseOrder(order, 'BOTH')} disabled={busy || !mexcOpen || !polymarketOpen}>双腿平仓</button>
                </div>}
              </article>
            )
          })}
        </div>
      </section>
    </div>
  )
}

function LogsModal({ events, onDismiss }: { events: AppSnapshot['recentEvents']; onDismiss: () => void }): JSX.Element {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onDismiss()}>
      <section className="history-modal logs-modal" role="dialog" aria-modal="true" aria-labelledby="logs-title">
        <div className="modal-heading history-heading"><div><span className="eyebrow">EXECUTION AUDIT</span><h2 id="logs-title">本地执行日志</h2></div><button className="icon-button" onClick={onDismiss} aria-label="关闭日志"><X /></button></div>
        <div className="event-list expanded">
          {events.length === 0 ? <div className="empty-state">尚无执行记录。</div> : events.map((event) => (
            <div className="event-row" key={event.id}>
              <span className={`event-marker ${['HEDGED', 'CLOSED'].includes(event.state) ? 'ok' : event.state === 'RECOVERY_REQUIRED' ? 'danger' : ''}`} />
              <time>{new Date(event.timestamp).toLocaleString('zh-CN', { hour12: false })}</time>
              <strong>{STATE_LABELS[event.state]}</strong>
              <p title={event.message}>{event.message}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function CloseConfirmModal({
  intent,
  busy,
  onDismiss,
  onConfirm
}: {
  intent: { order: ArbitrageOrderRecord; target: CloseTarget }
  busy: boolean
  onDismiss: () => void
  onConfirm: () => void
}): JSX.Element {
  const targetLabel = intent.target === 'BOTH' ? 'MEXC与Polymarket双腿' : intent.target
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal close-confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="close-title">
        <div className="modal-heading"><div><span className="eyebrow">POSITION CLOSE</span><h2 id="close-title">确认中途平仓</h2></div></div>
        <div className="modal-warning"><ShieldAlert aria-hidden="true" /><span>
          将平掉{targetLabel}。{intent.target === 'BOTH'
            ? '系统会先自动卖出MEXC并回读实际成交，再按该数量提交Polymarket SELL FOK；两腿不能原子同时成交。'
            : '这是单腿平仓，会留下方向性敞口，价格继续波动可能扩大损失。'}
        </span></div>
        <div className="close-summary">
          <span>MEXC剩余 <strong>{money(intent.order.mexc.openQuantity, 2)}份</strong></span>
          <span>Polymarket剩余 <strong>{money(intent.order.polymarket.openQuantity, 2)}份</strong></span>
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onDismiss} disabled={busy}>取消</button>
          <button className="danger-confirm-button" onClick={onConfirm} disabled={busy}>{busy ? <LoaderCircle className="spin" /> : <ShieldAlert />}确认平仓</button>
        </div>
      </section>
    </div>
  )
}

function ExecutionBar({
  session,
  busy,
  onRetry,
  onOpenHistory,
  onDismiss
}: {
  session: ExecutionSession
  busy: boolean
  onRetry: () => void
  onOpenHistory: () => void
  onDismiss: () => void
}): JSX.Element {
  const { state, error } = session
  const danger = state === 'RECOVERY_REQUIRED' || state === 'UNHEDGED' || Boolean(error)
  const done = state === 'HEDGED' || state === 'CLOSED'
  const mexcQuantity = Number(session.mexcFill?.quantity ?? 0)
  const polymarketQuantity = Number(session.polymarketFill?.quantity ?? 0)
  const targetQuantity = Number(session.polymarketTargetQuantity ?? mexcQuantity)
  const remainingQuantity = Math.max(0, Number(session.remainingHedgeQuantity ?? targetQuantity - polymarketQuantity))
  const excessQuantity = Math.max(0, Number(session.excessHedgeQuantity ?? polymarketQuantity - targetQuantity))
  const timingSummary = executionTimingSummary(session)
  return <div className={`execution-bar ${danger ? 'danger' : done ? 'done' : ''}`}>
    <div className="execution-pulse">{done ? <Check /> : danger ? <AlertTriangle /> : <LoaderCircle className="spin" />}</div>
    <div className="execution-summary">
      <span>申请{session.requestedQuantity} · MEXC {mexcQuantity.toFixed(2)} · Poly目标 {targetQuantity.toFixed(2)} · 已成交 {polymarketQuantity.toFixed(2)} · {excessQuantity > 0 ? `超额 ${excessQuantity.toFixed(2)}` : `未对冲 ${remainingQuantity.toFixed(2)}`}份</span>
      <strong>{STATE_LABELS[state]}</strong>
      {timingSummary && <small className="execution-timings" title="本次执行各阶段耗时">{timingSummary}</small>}
      {error && <small className="execution-error" title={error}>{error}</small>}
    </div>
    <div className="execution-progress"><span /></div>
    {state === 'RECOVERY_REQUIRED' && <div className="execution-recovery-actions">
      <button onClick={onRetry} disabled={busy || remainingQuantity <= 0}>{busy ? '处理中' : '重试对冲'}</button>
      <button onClick={onOpenHistory} disabled={busy}>平仓处理</button>
    </div>}
    <button className="execution-close" onClick={onDismiss} aria-label="关闭执行状态提示" title="关闭提示"><X /></button>
  </div>
}

export default App
