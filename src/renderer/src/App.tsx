import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
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
  Download,
  ExternalLink,
  History,
  Info,
  KeyRound,
  LoaderCircle,
  LogOut,
  LockKeyhole,
  Network,
  Pause,
  Plus,
  Play,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Trash2,
  Volume2,
  X,
  Zap
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
  GateCredentialSummary,
  GateOrderCaptureSummary,
  GatePageCaptureStatus,
  KalshiCredentialSummary,
  KalshiPageCaptureStatus,
  LicenseSummary,
  LimitlessCredentialSummary,
  ManualExecutionConditions,
  MexcBrowserMode,
  MexcBrowserStatus,
  MexcCalibrationKind,
  Opportunity,
  PolymarketCredentialSummary,
  PolymarketHedgeMode,
  PolymarketIdentityValidation,
  PolymarketSignatureType,
  PredictFunCredentialSummary,
  PredictFunOrderCaptureSummary,
  PredictFunPageCaptureStatus,
  SettlementDistanceRule,
  VenuePreparationReport
} from '../../shared/types'
import { isMultiVenueExecutionVenue, type MultiVenueComparison, type MultiVenueComparisonStatus, type MultiVenueExecutionCommand, type MultiVenueExecutionReceipt, type MultiVenueExecutionSession, type VenueCycleDataState, type VenueDescriptor } from '../../shared/multi-venue'
import type { EntryGateCheck } from '../../shared/entry-gates'
import { defaultSettlementDistanceRules } from '../../shared/defaults'
import { buildMultiVenueEntryGateReport, gateDurationExecutionReady } from './multi-venue-entry-gates'
import { MULTI_VENUE_TABLE_COLUMNS, multiVenueExecuteLabel, multiVenueReceiptStatusLabel } from './opportunity-table'
import { selectReadyComparisons, shouldPlayOpportunityAlert } from './opportunity-alert'
import { undismissedRecoverySessions } from './recovery-banner'
import { stableRouteKey } from './route-display'

interface SettlementRuleDraft {
  id: string
  remainingSeconds: string
  minimumBps: string
}

type SettingsView = 'MAIN' | 'RISK' | 'LIVE' | 'ACCOUNT'
type OpportunitySelectionMode = 'FOLLOW_BEST' | 'LOCKED'
type DurationFilter = 'ALL' | 5 | 15

const PREPARATION_STAGE_LABELS = {
  PASS: '通过', WARN: '待资金', BLOCKED: '阻塞', SKIPPED: '跳过'
} as const

function PreparationReportView({ report }: { report: VenuePreparationReport }): JSX.Element {
  return <details className="credential-help preparation-report" open={!report.readyExceptFunding}>
    <summary>{report.readyExceptFunding ? '非下单链路已完成' : '查看非下单联调阻塞项'} · 额外身份/账户请求 {report.requestCount} 次</summary>
    <div className="preparation-report-body">
      <p>{report.message}</p>
      <div className="preparation-summary-grid">
        <span>抵押资产<strong>{report.collateralBalance ?? '—'}</strong></span>
        <span>Gas 资产<strong>{report.nativeBalance ?? '—'}</strong></span>
        <span>持仓<strong>{report.positionCount ?? '—'}</strong></span>
        <span>活动委托<strong>{report.openOrderCount ?? '—'}</strong></span>
      </div>
      {report.stages.map((stage) => <div className={`preparation-stage ${stage.status.toLowerCase()}`} key={stage.id}>
        <span>{PREPARATION_STAGE_LABELS[stage.status]}</span>
        <p><strong>{stage.label}</strong><small>{stage.detail} · {stage.durationMs}ms</small></p>
      </div>)}
      <div className="credential-notice"><ShieldCheck aria-hidden="true" /><span>安全模式已锁定：真实订单提交、撤单和链上授权交易均不可调用。</span></div>
    </div>
  </details>
}

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

function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value
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

function marketWindowLabel(startTime: number, endTime: number): string {
  const format = (value: number): string => new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit', minute: '2-digit', hour12: false
  })
  return `${format(startTime)}–${format(endTime)}`
}

function cycleStateLabel(state: VenueCycleDataState): string {
  if (state === 'DEPTH_READY') return '深度'
  if (state === 'PRICE_ONLY') return '价格'
  if (state === 'STALE') return '过期'
  if (state === 'NO_MARKET') return '无市场'
  return '离线'
}

function StatusDot({ status }: { status: string }): JSX.Element {
  const connected = status === 'CONNECTED' || status === 'BROWSER_READY'
  return <span className={`status-dot ${connected ? 'connected' : 'offline'}`} />
}

function VenueHealthChip({ platform, onToggle, disabled }: { platform: VenueDescriptor; onToggle?: (platform: VenueDescriptor) => void; disabled?: boolean }): JSX.Element {
  const statusMessage = platform.statusMessage ?? `${platform.label}连接状态`
  if (platform.integrationState === 'PLANNED') {
    const plannedMessage = `${platform.label} 当前暂停短周期扫描；不会主动请求市场数据`
    return <span className="venue-health-chip planned" title={plannedMessage} data-status-message={plannedMessage}>
      <span className="status-dot planned-dot" />
      <strong>{platform.label}</strong>
      <small className="venue-planned">暂停扫描</small>
      <span className="venue-status-tooltip" role="tooltip">{plannedMessage}</span>
    </span>
  }
  const monitoringEnabled = platform.monitoringEnabled !== false
  return <span className={`venue-health-chip ${monitoringEnabled ? '' : 'monitoring-paused'}`} title={statusMessage} data-status-message={statusMessage}>
    <StatusDot status={platform.connectionState} />
    <strong>{platform.label}</strong>
    {(platform.cycles ?? []).map((cycle) => <small className={`cycle-health ${cycle.state.toLowerCase()}`} key={cycle.durationMinutes}>
      {cycle.durationMinutes}m {cycleStateLabel(cycle.state)}
    </small>)}
    {platform.integrationState === 'READ_ONLY' && <small className="venue-read-only">只读</small>}
    <span className="venue-status-tooltip" role="tooltip">{statusMessage}</span>
    {onToggle && <button
      className="venue-monitor-toggle"
      type="button"
      onClick={(event) => { event.stopPropagation(); onToggle(platform) }}
      disabled={disabled}
      aria-label={`${monitoringEnabled ? '关闭' : '开启'}${platform.label}监控`}
      title={`${monitoringEnabled ? '关闭' : '开启'}${platform.label}监控`}
    >{monitoringEnabled ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}</button>}
  </span>
}

function opportunityReady(opportunity: Opportunity, snapshot: AppSnapshot, now: number): boolean {
  const minimumQuantity = minimumQuantityForOpportunity(opportunity, snapshot.settings.maxHedgeSlippage)
  const conditions = snapshot.settings.manualExecutionConditions
  return (!conditions.quoteFreshness || !opportunity.stale) &&
    (!conditions.feeVerification || !opportunity.feeVerificationBlocked) &&
    (!conditions.settlementRisk || !opportunity.settlementRiskBlocked) &&
    (!conditions.conditionalReturn || Number(opportunity.conditionalReturnPct) >= Number(snapshot.settings.minConditionalReturnPct)) &&
    Number(opportunity.maxQuantity) >= minimumQuantity &&
    Number(opportunity.allInCostPerShare) * minimumQuantity <= Number(snapshot.settings.maxCapitalPerTrade) &&
    (!conditions.expiryCutoff || (opportunity.endTime - now) / 1_000 > snapshot.settings.stopBeforeExpirySeconds)
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

function comparisonStatusLabel(status: MultiVenueComparisonStatus): string {
  if (status === 'EXECUTABLE') return '可执行'
  if (status === 'MANUAL_EXECUTABLE') return '双腿待确认'
  if (status === 'NO_EDGE') return '暂无利润'
  if (status === 'STALE') return '行情过期'
  return '已拦截'
}

function grossComparisonStatusLabel(status: MultiVenueComparisonStatus): string {
  if (status === 'MANUAL_EXECUTABLE') return '双腿待确认'
  if (status === 'STALE') return '行情过期'
  if (status === 'BLOCKED') return '深度不足 / 暂不可下单'
  return comparisonStatusLabel(status)
}

function comparisonLegLabel(comparison: MultiVenueComparison, index: number): string {
  const leg = comparison.legs[index]
  return leg ? `${leg.venueLabel} ${leg.direction}` : '—'
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
  // 并行预对冲模式下Poly腿在MEXC成交回报前就启动，两段计时重叠，
  // 分段相加会大于总计；标注出来避免误读成两平台时长相加。
  const hedgeOverlapsFill = Boolean(
    timings.polymarketStartedAt && timings.mexcSubmittedAt &&
    timings.polymarketStartedAt >= timings.mexcSubmittedAt &&
    (!timings.mexcFillDetectedAt || timings.polymarketStartedAt < timings.mexcFillDetectedAt)
  )
  if (preflight) segments.push(`复核 ${preflight}`)
  const mexcHotPath = [
    timings.mexcCurrencyMappingMs !== undefined ? `映射${timings.mexcCurrencyMappingMs}ms` : undefined,
    timings.mexcCookieReadMs !== undefined ? `Cookie${timings.mexcCookieReadMs}ms` : undefined,
    timings.mexcPostMs !== undefined ? `POST ${timings.mexcPostMs}ms` : undefined
  ].filter(Boolean).join('/')
  const polyHotPath = [
    timings.polymarketMetadataMs !== undefined ? `元数据${timings.polymarketMetadataMs}ms` : undefined,
    timings.polymarketSigningMs !== undefined ? `签名${timings.polymarketSigningMs}ms` : undefined,
    timings.polymarketPostMs !== undefined ? `POST ${timings.polymarketPostMs}ms` : undefined,
    timings.polymarketConfirmationMs !== undefined ? `确认${timings.polymarketConfirmationMs}ms` : undefined
  ].filter(Boolean).join('/')
  if (page) segments.push(`页面/按钮 ${page}`)
  if (mexcHotPath) segments.push(`MEXC ${mexcHotPath}`)
  if (fill) segments.push(`MEXC成交 ${fill}`)
  if (timings.mexcFillReadbackMs !== undefined) {
    segments.push(`成交回读 ${timings.mexcFillReadbackMs}ms/${timings.mexcFillRestQueries ?? 0}次REST`)
  }
  if (polyHotPath) segments.push(`Poly ${polyHotPath}`)
  if (hedge) segments.push(`Poly对冲${hedgeOverlapsFill ? '(并行) ' : ' '}${hedge}`)
  if (total) segments.push(`总计(墙钟) ${total}`)
  return segments.length > 0 ? segments.join(' · ') : undefined
}

type ExecutionCheck = Pick<EntryGateCheck, 'id' | 'passed' | 'label'> & Partial<Pick<EntryGateCheck, 'condition' | 'enabled' | 'locked' | 'applicable'>>

function ExecutionConditionsHelp({
  checks,
  busy,
  onToggle
}: {
  checks: ExecutionCheck[]
  busy: boolean
  onToggle: (condition: keyof ManualExecutionConditions) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [popoverPosition, setPopoverPosition] = useState({ left: 12, top: 12, width: 380, maxHeight: 480 })
  const visibleChecks = checks.filter((check) => check.applicable !== false)
  const activeChecks = visibleChecks.filter((check) => check.locked || check.enabled !== false)
  const passed = activeChecks.filter((check) => check.passed).length
  const ignored = visibleChecks.length - activeChecks.length

  useEffect(() => {
    if (!open) return

    const updatePosition = (): void => {
      const trigger = triggerRef.current
      if (!trigger) return
      const viewportPadding = 12
      const gap = 7
      const triggerRect = trigger.getBoundingClientRect()
      const width = Math.min(380, window.innerWidth - viewportPadding * 2)
      const desiredHeight = Math.min(480, popoverRef.current?.scrollHeight ?? 480)
      const roomBelow = window.innerHeight - triggerRect.bottom - gap - viewportPadding
      const roomAbove = triggerRect.top - gap - viewportPadding
      const openAbove = roomBelow < desiredHeight && roomAbove > roomBelow
      const availableHeight = Math.max(120, openAbove ? roomAbove : roomBelow)
      const maxHeight = Math.min(480, availableHeight)
      const renderedHeight = Math.min(desiredHeight, maxHeight)
      const left = Math.max(viewportPadding, Math.min(triggerRect.right - width, window.innerWidth - viewportPadding - width))
      const top = openAbove
        ? Math.max(viewportPadding, triggerRect.top - gap - renderedHeight)
        : Math.min(triggerRect.bottom + gap, window.innerHeight - viewportPadding - renderedHeight)
      setPopoverPosition({ left, top, width, maxHeight })
    }

    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }

    updatePosition()
    const frame = window.requestAnimationFrame(updatePosition)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const popover = open && createPortal(<div
    ref={popoverRef}
    id="execution-conditions-popover"
    className="execution-conditions-popover"
    role="dialog"
    aria-label="手动下单条件"
    style={popoverPosition}
  >
      <strong>手动下单条件 · {passed}/{activeChecks.length}通过{ignored > 0 ? ` · ${ignored}项忽略` : ''}</strong>
      <ul>
        {visibleChecks.map((check) => <li key={check.id} className={check.enabled === false && !check.locked ? 'ignored' : check.passed ? 'passed' : 'blocked'}>
          {check.enabled === false && !check.locked ? <span className="condition-ignored-mark">—</span> : check.passed ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
          <span>{check.label}</span>
          {check.locked
            ? <span className="condition-lock" title="交易或账户硬条件，不能关闭"><LockKeyhole aria-hidden="true" />锁定</span>
            : check.condition && <button
              type="button"
              className={`condition-switch ${check.enabled === false ? '' : 'enabled'}`}
              role="switch"
              aria-checked={check.enabled !== false}
              aria-label={`${check.enabled === false ? '启用' : '忽略'}${check.label}`}
              disabled={busy}
              onClick={() => onToggle(check.condition!)}
            ><span /></button>}
        </li>)}
      </ul>
      <small>这里只影响手动下单；自动开单始终使用完整严格条件。账户、最小委托、盘口深度、市场身份和执行中订单属于锁定条件。</small>
    </div>, document.body)

  return <div className="execution-conditions-help">
    <button
      ref={triggerRef}
      type="button"
      className="execution-conditions-trigger"
      aria-label="查看和选择手动下单条件"
      title="查看和选择手动下单条件"
      aria-expanded={open}
      aria-controls="execution-conditions-popover"
      onClick={() => setOpen((current) => !current)}
    ><CircleHelp aria-hidden="true" /></button>
    {popover}
  </div>
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
          const hedgeRemaining = Math.max(0, Number(order.polymarket.targetQuantity ?? order.mexc.entryFill?.quantity ?? 0) - Number(order.polymarket.entryFill?.quantity ?? 0))
          const recoverableHedge = order.status === 'RECOVERY_REQUIRED' && hedgeRemaining > 0.000001 && Date.now() < order.endTime
          const target: CloseTarget | undefined = mexcOpen && polymarketOpen ? 'BOTH' : mexcOpen ? 'MEXC' : polymarketOpen ? 'POLYMARKET' : undefined
          const orderIds = entryOrderIds(order)
          return <article key={order.id} className="emergency-order-card">
            <div><strong>{order.durationMinutes}分钟 · MEXC {directionLabel(order.mexc.direction)}</strong><small>{triggerSourceLabel(order.triggerSource)} · 执行 {new Date(order.createdAt).toLocaleString('zh-CN', { hour12: false })}</small><small>状态 {order.status} · MEXC {Number(order.mexc.openQuantity).toFixed(2)}份 · Poly {Number(order.polymarket.openQuantity).toFixed(2)}份</small>{(orderIds.mexc || orderIds.polymarket) && <small className="emergency-order-ids" title={`MEXC ${orderIds.mexc ?? '无'} / Polymarket ${orderIds.polymarket ?? '无'}`}>订单号：MEXC {orderIds.mexc ?? '—'} · Poly {orderIds.polymarket ?? '—'}</small>}</div>
            {recoverableHedge && <button disabled={busy} onClick={() => void recover(() => window.arbApp.retryPolymarketHedge({ orderId: order.id }))}><RotateCcw />补齐剩余对冲</button>}
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
  const [selectedComparisonId, setSelectedComparisonId] = useState<string>()
  const [selectionMode, setSelectionMode] = useState<OpportunitySelectionMode>('FOLLOW_BEST')
  const [durationFilter, setDurationFilter] = useState<DurationFilter>('ALL')
  const [quantity, setQuantity] = useState('50')
  const [multiVenueQuantity, setMultiVenueQuantity] = useState('1')
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
  const [predictFunCredentials, setPredictFunCredentials] = useState<PredictFunCredentialSummary>()
  const [predictFunPageStatus, setPredictFunPageStatus] = useState<PredictFunPageCaptureStatus>()
  const [predictFunOrderCapture, setPredictFunOrderCapture] = useState<PredictFunOrderCaptureSummary>()
  const [predictFunApiKey, setPredictFunApiKey] = useState('')
  const [predictFunAccountType, setPredictFunAccountType] = useState<'PREDICT_ACCOUNT' | 'EOA'>('PREDICT_ACCOUNT')
  const [predictFunAccountAddress, setPredictFunAccountAddress] = useState('')
  const [predictFunPrivateKey, setPredictFunPrivateKey] = useState('')
  const [limitlessCredentials, setLimitlessCredentials] = useState<LimitlessCredentialSummary>()
  const [limitlessTokenId, setLimitlessTokenId] = useState('')
  const [limitlessTokenSecret, setLimitlessTokenSecret] = useState('')
  const [limitlessPrivateKey, setLimitlessPrivateKey] = useState('')
  const [limitlessPreparation, setLimitlessPreparation] = useState<VenuePreparationReport>()
  const [predictFunPreparation, setPredictFunPreparation] = useState<VenuePreparationReport>()
  const [gateCredentials, setGateCredentials] = useState<GateCredentialSummary>()
  const [gatePageStatus, setGatePageStatus] = useState<GatePageCaptureStatus>()
  const [gateOrderCapture, setGateOrderCapture] = useState<GateOrderCaptureSummary>()
  const [gateApiKey, setGateApiKey] = useState('')
  const [gateApiSecret, setGateApiSecret] = useState('')
  const [gatePreparation, setGatePreparation] = useState<VenuePreparationReport>()
  const [kalshiCredentials, setKalshiCredentials] = useState<KalshiCredentialSummary>()
  const [kalshiPageStatus, setKalshiPageStatus] = useState<KalshiPageCaptureStatus>()
  const [kalshiApiKeyId, setKalshiApiKeyId] = useState('')
  const [kalshiPrivateKeyPem, setKalshiPrivateKeyPem] = useState('')
  const [kalshiPreparation, setKalshiPreparation] = useState<VenuePreparationReport>()
  const [multiVenueReceipt, setMultiVenueReceipt] = useState<MultiVenueExecutionReceipt>()
  const [revealPlatformSecrets, setRevealPlatformSecrets] = useState(false)
  const [settlementRuleDrafts, setSettlementRuleDrafts] = useState<SettlementRuleDraft[]>([])
  const [settlementRuleError, setSettlementRuleError] = useState<string>()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [closeIntent, setCloseIntent] = useState<{ order: ArbitrageOrderRecord; target: CloseTarget }>()
  const [dismissedExecutionNoticeKey, setDismissedExecutionNoticeKey] = useState<string>()
  const [dismissedRecoveryIds, setDismissedRecoveryIds] = useState<Set<string>>(new Set())
  const [dismissedMultiVenueRecoveryIds, setDismissedMultiVenueRecoveryIds] = useState<Set<string>>(new Set())
  const [maxCapitalDraft, setMaxCapitalDraft] = useState('100.00')
  const [minConditionalReturnDraft, setMinConditionalReturnDraft] = useState('0.00')
  const [quoteValidityDraft, setQuoteValidityDraft] = useState('8')
  const [soundEnabledDraft, setSoundEnabledDraft] = useState(true)
  const [soundVolumeDraft, setSoundVolumeDraft] = useState(0.65)
  const [executionPlan, setExecutionPlan] = useState<ExecutionPlan>()
  const [soundCooldownDraft, setSoundCooldownDraft] = useState('30')
  const [autoFixedQuantityDraft, setAutoFixedQuantityDraft] = useState('5.00')
  const [autoMaxQuantityPctDraft, setAutoMaxQuantityPctDraft] = useState('80')
  const [autoStabilityDraft, setAutoStabilityDraft] = useState('100')
  const [maxHedgeSlippageDraft, setMaxHedgeSlippageDraft] = useState('0.0300')
  const [maxRecoveryLossDraft, setMaxRecoveryLossDraft] = useState('2.00')
  const [hedgeRetryCountDraft, setHedgeRetryCountDraft] = useState('8')
  const [preHedgeRatioDraft, setPreHedgeRatioDraft] = useState('50')
  const [hedgeModeDraft, setHedgeModeDraft] = useState<PolymarketHedgeMode>('PROTECTED_MARKET')
  const previousAlertCandidateRef = useRef<string | undefined>(undefined)
  const lastOpportunityAlertAtRef = useRef(0)

  useEffect(() => {
    void window.arbApp.getSnapshot().then((value) => {
      setSnapshot(value)
      void window.arbApp.testPolymarketConnection().catch(() => undefined)
      void window.arbApp.refreshOpportunities().catch(() => undefined)
    })
    const unsubscribe = window.arbApp.onSnapshot(setSnapshot)
    const clock = window.setInterval(() => setNow(Date.now()), 1_000)
    // MEXC/Polymarket/Gate/Predict streams update the snapshot directly.
    // A 15-second REST audit is enough for quiet markets and avoids keeping all
    // platform pages and Electron IPC calls hot every five seconds.
    const refresh = window.setInterval(() => void window.arbApp.refreshOpportunities().catch(() => undefined), 15_000)
    return () => {
      unsubscribe()
      window.clearInterval(clock)
      window.clearInterval(refresh)
    }
  }, [])

  // 执行面板不需要先打开设置；启动后立即读取一次 Kalshi 凭据摘要，避免把未加载误报成未配置。
  useEffect(() => {
    void window.arbApp.getKalshiCredentialSummary().then(setKalshiCredentials)
    void window.arbApp.getGateOrderCaptureSummary().then(setGateOrderCapture)
    void window.arbApp.getPredictFunOrderCaptureSummary().then(setPredictFunOrderCapture)
  }, [])

  useEffect(() => {
    if (!settingsOpen) return
    setHubstudioCode(snapshot?.settings.hubstudioContainerCode ?? '')
    setPolymarketProxyUrl(snapshot?.settings.polymarketProxyUrl ?? '')
    setMaxCapitalDraft(snapshot?.settings.maxCapitalPerTrade ?? '100.00')
    setMinConditionalReturnDraft(snapshot?.settings.minConditionalReturnPct ?? '0.00')
    setQuoteValidityDraft(String((snapshot?.settings.maxQuoteAgeMs ?? 8_000) / 1_000))
    setSoundEnabledDraft(snapshot?.settings.opportunitySoundEnabled ?? true)
    setSoundVolumeDraft(snapshot?.settings.opportunitySoundVolume ?? 0.65)
    setSoundCooldownDraft(String(snapshot?.settings.opportunitySoundCooldownSeconds ?? 30))
    setAutoFixedQuantityDraft(snapshot?.settings.autoOpenFixedQuantity ?? '5.00')
    setAutoMaxQuantityPctDraft(String(snapshot?.settings.autoOpenMaxQuantityPct ?? 80))
    setAutoStabilityDraft(String(snapshot?.settings.autoOpenStabilityMs ?? 100))
    setMaxHedgeSlippageDraft(snapshot?.settings.maxHedgeSlippage ?? '0.0300')
    setMaxRecoveryLossDraft(snapshot?.settings.maxRecoveryLossUsdt ?? '2.00')
    setHedgeRetryCountDraft(String(snapshot?.settings.polymarketHedgeRetryCount ?? 8))
    setPreHedgeRatioDraft(String(snapshot?.settings.preHedgeRatioPct ?? 50))
    setHedgeModeDraft(snapshot?.settings.polymarketHedgeMode ?? 'PROTECTED_MARKET')
    setSettlementRuleDrafts((snapshot?.settings.settlementDistanceRules ?? defaultSettlementDistanceRules()).map((rule) => ({
      id: rule.id,
      remainingSeconds: String(rule.remainingSeconds),
      minimumBps: rule.minimumBps
    })))
    setSettlementRuleError(undefined)
    const refreshStatus = (): void => {
      void window.arbApp.getMexcStatus().then(setMexcStatus)
      void window.arbApp.getPredictFunPageCaptureStatus().then(setPredictFunPageStatus)
      void window.arbApp.getGatePageCaptureStatus().then(setGatePageStatus)
      void window.arbApp.getGateOrderCaptureSummary().then(setGateOrderCapture)
      void window.arbApp.getKalshiPageCaptureStatus().then(setKalshiPageStatus)
    }
    refreshStatus()
    void window.arbApp.getPolymarketCredentialSummary().then((summary) => {
      setPolymarketCredentials(summary)
      setPolySignatureType(summary.signatureType ?? 0)
      setPolyFunderAddress(summary.funderAddress ?? '')
    })
    void window.arbApp.getPredictFunCredentialSummary().then((summary) => {
      setPredictFunCredentials(summary)
      setPredictFunAccountType(summary.accountType ?? 'PREDICT_ACCOUNT')
      setPredictFunAccountAddress(summary.accountAddress ?? '')
    })
    void window.arbApp.getLimitlessCredentialSummary().then((summary) => {
      setLimitlessCredentials(summary)
    })
    void window.arbApp.getGateCredentialSummary().then(setGateCredentials)
    void window.arbApp.getKalshiCredentialSummary().then(setKalshiCredentials)
    const statusTimer = window.setInterval(refreshStatus, 5_000)
    return () => window.clearInterval(statusTimer)
  }, [settingsOpen, snapshot?.settings.hubstudioContainerCode])

  const selected = useMemo(
    () => snapshot?.opportunities.find((opportunity) => opportunity.id === selectedId),
    [selectedId, snapshot]
  )
  const selectedComparison = useMemo(
    () => snapshot?.multiVenueBoard.comparisons.find((comparison) => comparison.id === selectedComparisonId),
    [selectedComparisonId, snapshot?.multiVenueBoard.comparisons]
  )
  const selectedGateLeg = useMemo(
    () => selectedComparison?.legs.find((leg) => leg.venueId === 'GATE'),
    [selectedComparison]
  )
  const selectedGateDuration = selectedGateLeg ? selectedComparison?.durationMinutes : undefined
  useEffect(() => {
    if (!snapshot?.settings.gateLiveEnabled && selectedGateDuration === undefined) return
    let active = true
    const refreshGateExecutionState = (): void => {
      void window.arbApp.getGateOrderCaptureSummary().then((next) => {
        if (!active) return
        setGateOrderCapture((current) => {
          const currentDurations = current?.executableDurations?.join(',') ?? ''
          const nextDurations = next.executableDurations?.join(',') ?? ''
          return current?.executionReady === next.executionReady && currentDurations === nextDurations ? current : next
        })
      })
    }
    refreshGateExecutionState()
    const timer = window.setInterval(refreshGateExecutionState, 1_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [selectedGateDuration, snapshot?.settings.gateLiveEnabled])
  // 待恢复会话不阻塞新开仓；真正执行中的旧路线仍保持互斥。
  const recoveryPending = snapshot?.activeSession?.state === 'RECOVERY_REQUIRED'
  const executionSessionIdle = !snapshot?.activeSession || ['HEDGED', 'CANCELLED', 'RECOVERY_REQUIRED'].includes(snapshot.activeSession.state)
  const unprotectedMode = Boolean(snapshot?.settings.unprotectedExecutionEnabled && snapshot.settings.mode === 'ASSISTED')
  const multiVenueAllInCost = Number(selectedComparison?.allInCostPerShare ?? 0)
  const unprotectedCapitalQuantity = multiVenueAllInCost > 0
    ? Number(snapshot?.settings.maxCapitalPerTrade ?? 0) / multiVenueAllInCost
    : 0
  const multiVenueMaxQuantity = selectedComparison?.executionProvider === 'MULTI_VENUE' && selectedComparison.legs.length === 2
    ? Math.floor((unprotectedMode
      ? unprotectedCapitalQuantity
      : Math.min(
          Number(selectedComparison.executableQuantity),
          ...selectedComparison.legs.map((leg) => Number(leg.availableQuantity))
        )) * 100) / 100
    : 0
  const multiVenueRequestedQuantity = Number(multiVenueQuantity)
  const multiVenueGateMinimumQuantity = selectedGateLeg && Number(selectedGateLeg.price) > 0
    ? Math.ceil((5 / Number(selectedGateLeg.price)) * 100) / 100
    : 0
  const multiVenueMinimumQuantity = selectedGateLeg ? Math.max(1, multiVenueGateMinimumQuantity) : 1
  const multiVenueRequestedCapital = selectedComparison && Number.isFinite(multiVenueRequestedQuantity)
    ? multiVenueAllInCost * multiVenueRequestedQuantity
    : 0
  const opportunityById = useMemo(() => new Map(
    snapshot?.opportunities.map((opportunity) => [opportunity.id, opportunity]) ?? []
  ), [snapshot?.opportunities])
  const visibleComparisons = useMemo(() => snapshot
    ? snapshot.multiVenueBoard.comparisons.filter((comparison) =>
      durationFilter === 'ALL'
        ? comparison.durationMinutes === 5 || comparison.durationMinutes === 15
        : comparison.durationMinutes === durationFilter
    )
    : [], [durationFilter, snapshot])
  const multiVenueEntryReports = useMemo(() => {
    const reports = new Map<string, ReturnType<typeof buildMultiVenueEntryGateReport>>()
    if (!snapshot) return reports
    for (const comparison of visibleComparisons) {
      if (comparison.executionProvider !== 'MULTI_VENUE') continue
      reports.set(comparison.id, buildMultiVenueEntryGateReport({
        comparison,
        quantity: multiVenueQuantity,
        settings: snapshot.settings,
        now,
        executionIdle: executionSessionIdle,
        kalshiReady: kalshiCredentials?.configured === true,
        gateReady: comparison.legs.some((leg) => leg.venueId === 'GATE') ? gateDurationExecutionReady(gateOrderCapture, comparison.durationMinutes) : true
      }))
    }
    return reports
  }, [executionSessionIdle, gateOrderCapture, kalshiCredentials?.configured, multiVenueQuantity, now, snapshot, visibleComparisons])
  const readyComparisons = useMemo(() => {
    if (!snapshot) return []
    const legacyReadyIds = new Set(visibleComparisons
      .filter((comparison) => {
        const legacy = comparison.legacyOpportunityId ? opportunityById.get(comparison.legacyOpportunityId) : undefined
        return Boolean(legacy && opportunityReady(legacy, snapshot, now))
      })
      .map((comparison) => comparison.id))
    return selectReadyComparisons({ comparisons: visibleComparisons, legacyReadyIds, multiVenueReports: multiVenueEntryReports })
  }, [multiVenueEntryReports, now, opportunityById, snapshot, visibleComparisons])
  const bestComparison = useMemo(() => [...readyComparisons].sort((left, right) =>
    Number(snapshot?.settings.autoOpenEnabled ? right.autoOrderPotentialProfit : right.potentialProfit) -
      Number(snapshot?.settings.autoOpenEnabled ? left.autoOrderPotentialProfit : left.potentialProfit) ||
    Number(right.netEdgePerShare) - Number(left.netEdgePerShare) ||
    left.fixedSortKey.localeCompare(right.fixedSortKey)
  )[0], [readyComparisons, snapshot?.settings.autoOpenEnabled])
  const readyOpportunityCount = readyComparisons.length
  const orderedComparisonRows = useMemo(() => visibleComparisons
    .map((comparison) => ({
      comparison,
      opportunity: comparison.legacyOpportunityId
        ? opportunityById.get(comparison.legacyOpportunityId)
        : undefined
    })), [opportunityById, visibleComparisons])
  const integratedPlatformCount = snapshot?.multiVenueBoard.platforms.filter((platform) => platform.integrationState !== 'PLANNED').length ?? 0
  const displayedProfit = (comparison: MultiVenueComparison): string => snapshot?.settings.autoOpenEnabled
    ? comparison.autoOrderPotentialProfit
    : comparison.potentialProfit
  const predictFunHasApiKey = Boolean(predictFunCredentials?.configured || predictFunApiKey.trim().length >= 8)

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
    snapshot?.settings.manualExecutionConditions,
    snapshot?.settings.minConditionalReturnPct
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
  const effectiveConditionalReturn = currentPlan?.conditionalReturnPct ?? selected?.conditionalReturnPct ?? '0'
  const conditionalReturnPassed = Boolean(selected && snapshot && Number(effectiveConditionalReturn) >= Number(snapshot.settings.minConditionalReturnPct))
  const settlementRiskPassed = Boolean(selected && !selected.settlementRiskBlocked)
  const manualConditions = snapshot?.settings.manualExecutionConditions
  const manualConditionEnabled = (condition: keyof ManualExecutionConditions): boolean => manualConditions?.[condition] !== false
  const manualRiskOverrideActive = Boolean(manualConditions && Object.values(manualConditions).some((enabled) => !enabled))
  const executionPlanBlockReason = currentPlan?.blockReason?.includes('最低条件收益率')
    ? `保护价内盘口有${currentPlan.marketDepthQuantity}份，但滑点后条件收益率${money(effectiveConditionalReturn, 2)}%低于设置的${money(String(snapshot?.settings.minConditionalReturnPct ?? 0), 2)}%`
    : currentPlan?.blockReason
  const canExecute = Boolean(
    selected &&
      Number(quantity) > 0 &&
      Number(quantity) >= minimumAlignedQuantity &&
      (unprotectedMode || (!currentPlan || currentPlan.executable)) &&
      (unprotectedMode || Number(quantity) <= Number(currentPlan?.maxExecutableQuantity ?? selected.maxQuantity)) &&
      requestedCapital <= Number(snapshot?.settings.maxCapitalPerTrade ?? 0) &&
      (unprotectedMode || !manualConditionEnabled('feeVerification') || !selected.feeVerificationBlocked) &&
      (!snapshot?.settings.allowUnprofitableTestTrade || (minimumTestCapital <= 12 && requestedCapital <= dynamicTestCapitalLimit)) &&
      (unprotectedMode || !manualConditionEnabled('conditionalReturn') || Number(effectiveConditionalReturn) >= Number(snapshot?.settings.minConditionalReturnPct ?? 0) || testOverrideReady) &&
      (unprotectedMode || !manualConditionEnabled('settlementRisk') || !selected.settlementRiskBlocked || testOverrideReady) &&
      (unprotectedMode || !manualConditionEnabled('quoteFreshness') || !selected.stale) &&
      (unprotectedMode || !manualConditionEnabled('expiryCutoff') || (selected.endTime - now) / 1_000 > Number(snapshot?.settings.stopBeforeExpirySeconds ?? 0)) &&
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
        ? executionPlanBlockReason ?? '当前深度、余额或收益门槛不允许执行'
      : Number(quantity) > Number(currentPlan?.maxExecutableQuantity ?? selected.maxQuantity)
        ? `输入${Number(quantity).toFixed(2)}份超过当前可执行上限${currentPlan?.maxExecutableQuantity ?? selected.maxQuantity}份`
        : requestedCapital > Number(snapshot?.settings.maxCapitalPerTrade ?? 0)
          ? '预计本金超过单笔上限'
          : selected.stale && manualConditionEnabled('quoteFreshness')
            ? '行情已过期，等待自动刷新'
            : (selected.endTime - now) / 1_000 <= Number(snapshot?.settings.stopBeforeExpirySeconds ?? 0) && manualConditionEnabled('expiryCutoff')
              ? `距离到期不足${snapshot?.settings.stopBeforeExpirySeconds ?? 0}秒，禁止新开仓`
            : selected.feeVerificationBlocked && manualConditionEnabled('feeVerification')
              ? selected.feeVerificationReason ?? '手续费尚未校验'
              : selected.settlementRiskBlocked && manualConditionEnabled('settlementRisk') && !testOverrideReady
              ? selected.settlementRiskReason ?? '结算信号风控拦截'
              : Number(effectiveConditionalReturn) < Number(snapshot?.settings.minConditionalReturnPct ?? 0) && manualConditionEnabled('conditionalReturn') && !snapshot?.settings.allowUnprofitableTestTrade
                ? '条件收益率低于设置门槛'
                : snapshot?.settings.allowUnprofitableTestTrade && !snapshot.settings.polymarketLiveEnabled
                  ? '小额亏损联调需先验证身份并开启Polymarket真实对冲'
                  : snapshot?.settings.allowUnprofitableTestTrade && minimumTestCapital > 12
                    ? `当前最小验证单预计需要${minimumTestCapital.toFixed(2)}，超过12 USDT硬上限`
                  : snapshot?.settings.allowUnprofitableTestTrade && requestedCapital > dynamicTestCapitalLimit
                    ? `小额验证最多使用${dynamicTestCapitalLimit.toFixed(2)} USDT，可点击“最大”自动调整`
                    : undefined

  const executionChecks: ExecutionCheck[] = selected && snapshot ? [
    { id: 'quantity-positive', passed: Number(quantity) > 0, label: `输入份额 ${Number(quantity || 0).toFixed(2)} > 0`, locked: true },
    { id: 'minimum-order', passed: Number(quantity) >= minimumAlignedQuantity, label: `最小对齐 ${Number(quantity || 0).toFixed(2)} ≥ ${minimumAlignedQuantity.toFixed(2)}份`, locked: true },
    ...(currentPlan ? [{
      id: 'account-affordability',
      passed: Number(quantity) <= Number(currentPlan.maxAffordableQuantity),
      label: `账户可支付 输入${Number(quantity || 0).toFixed(2)} ≤ ${currentPlan.maxAffordableQuantity}份（余额预留${currentPlan.accountBalanceReservePct}%）`,
      locked: true
    }] : []),
    { id: 'depth-limit', passed: Number(quantity) <= Number(currentPlan?.marketDepthQuantity ?? selected.maxQuantity), label: `保护价内盘口 输入${Number(quantity || 0).toFixed(2)} ≤ ${currentPlan?.marketDepthQuantity ?? selected.maxQuantity}份${currentPlan ? `（Poly最高买到${money(String(polymarketMaximumPrice), 4)}）` : ''}`, locked: true },
    { id: 'capital-limit', passed: requestedCapital <= Number(snapshot.settings.maxCapitalPerTrade), label: `预计本金 $${requestedCapital.toFixed(2)} ≤ $${Number(snapshot.settings.maxCapitalPerTrade).toFixed(2)}`, locked: true },
    { id: 'conditional-return', passed: conditionalReturnPassed || testOverrideReady, label: `滑点后条件收益率 ${money(effectiveConditionalReturn, 2)}% ≥ ${money(snapshot.settings.minConditionalReturnPct, 2)}%${!conditionalReturnPassed && testOverrideReady ? '（小额联调豁免）' : ''}`, condition: 'conditionalReturn', enabled: snapshot.settings.manualExecutionConditions.conditionalReturn },
    { id: 'fee-verification', passed: !selected.feeVerificationBlocked, label: selected.feeVerificationBlocked ? 'MEXC手续费尚未校验' : 'MEXC手续费已校验', condition: 'feeVerification', enabled: snapshot.settings.manualExecutionConditions.feeVerification },
    { id: 'settlement-risk', passed: settlementRiskPassed || testOverrideReady, label: !settlementRiskPassed && testOverrideReady ? '结算信号门槛（小额联调豁免）' : selected.settlementRiskBlocked ? (selected.settlementRiskReason ?? '结算风控未通过') : '结算方向与动态安全距离通过', condition: 'settlementRisk', enabled: snapshot.settings.manualExecutionConditions.settlementRisk },
    { id: 'quote-freshness', passed: !selected.stale, label: `行情 MEXC ${quoteAgeLabel(selected.mexcQuoteAgeMs)} / Poly ${quoteAgeLabel(selected.polymarketQuoteAgeMs)} ≤ ${(snapshot.settings.maxQuoteAgeMs / 1_000).toFixed(0)}秒`, condition: 'quoteFreshness', enabled: snapshot.settings.manualExecutionConditions.quoteFreshness },
    { id: 'expiry-cutoff', passed: (selected.endTime - now) / 1_000 > snapshot.settings.stopBeforeExpirySeconds, label: `距离到期 ${secondsRemaining(selected.endTime, now)}，开仓截止前仍有效`, condition: 'expiryCutoff', enabled: snapshot.settings.manualExecutionConditions.expiryCutoff },
    ...(snapshot.settings.allowUnprofitableTestTrade
      ? [{ id: 'test-trade-limit', passed: testOverrideReady, label: `小额联调限制：人工监督、Poly真实对冲、本金≤${dynamicTestCapitalLimit.toFixed(2)} USDT且硬上限12 USDT`, locked: true }]
      : []),
    { id: 'execution-idle', passed: executionSessionIdle && !busy, label: executionSessionIdle ? (recoveryPending ? '上组待恢复（不阻塞新开仓，可在历史中补单）' : busy ? '当前操作正在执行' : '当前无执行中操作') : `已有执行中套利组（${snapshot.activeSession?.state ?? '未知状态'}）`, locked: true }
  ] : []

  const multiVenueGateReport = selectedComparison?.executionProvider === 'MULTI_VENUE' && snapshot
    ? buildMultiVenueEntryGateReport({
      comparison: selectedComparison,
      quantity: multiVenueQuantity,
      settings: snapshot.settings,
      now,
      executionIdle: executionSessionIdle && !busy,
      kalshiReady: kalshiCredentials?.configured === true,
      gateReady: selectedGateLeg ? gateDurationExecutionReady(gateOrderCapture, selectedComparison.durationMinutes) : true
    })
    : undefined

  useEffect(() => {
    if (selectionMode !== 'FOLLOW_BEST' || !bestComparison || bestComparison.id === selectedComparisonId || busy || !executionSessionIdle) return
    setSelectedComparisonId(bestComparison.id)
    setSelectedId(bestComparison.legacyOpportunityId)
  }, [bestComparison, busy, executionSessionIdle, selectedComparisonId, selectionMode])

  useEffect(() => {
    if (!snapshot) return
    const selectedVisible = orderedComparisonRows.some((row) => row.comparison.id === selectedComparisonId)
    if (selectedComparisonId && selectedVisible) return
    const fallback = bestComparison ?? orderedComparisonRows[0]?.comparison
    setSelectedComparisonId(fallback?.id)
    setSelectedId(fallback?.legacyOpportunityId)
    if (selectionMode === 'LOCKED') setSelectionMode('FOLLOW_BEST')
  }, [bestComparison, orderedComparisonRows, selectedComparisonId, selectionMode, snapshot])

  useEffect(() => {
    const currentId = bestComparison?.id
    const previousId = previousAlertCandidateRef.current
    previousAlertCandidateRef.current = currentId
    if (!snapshot?.settings.opportunitySoundEnabled) return
    if (!shouldPlayOpportunityAlert(
      previousId,
      currentId,
      lastOpportunityAlertAtRef.current,
      now,
      snapshot.settings.opportunitySoundCooldownSeconds * 1_000
    )) return
    playOpportunityChime(snapshot.settings.opportunitySoundVolume)
    lastOpportunityAlertAtRef.current = now
  }, [bestComparison?.id, now, snapshot?.settings.opportunitySoundCooldownSeconds, snapshot?.settings.opportunitySoundEnabled, snapshot?.settings.opportunitySoundVolume])

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

  async function toggleVenueMonitoring(platform: VenueDescriptor): Promise<void> {
    const nextEnabled = platform.monitoringEnabled === false
    await run(
      () => window.arbApp.setVenueMonitoring(platform.id, nextEnabled).then((nextSnapshot) => {
        setSnapshot(nextSnapshot)
        return nextSnapshot
      }),
      `${platform.label}监控已${nextEnabled ? '开启' : '关闭'}`
    )
  }

  async function copyLicenseMachineCode(): Promise<void> {
    try {
      await navigator.clipboard.writeText(license.machineCode)
      setMessage('机器码已复制，可发送给授权管理员续期')
    } catch {
      setMessage(`请手动复制机器码：${license.machineCode}`)
    }
  }

  function selectComparison(comparison: MultiVenueComparison): void {
    setSelectionMode('LOCKED')
    setSelectedComparisonId(comparison.id)
    setSelectedId(comparison.legacyOpportunityId)
  }

  function followBestOpportunity(): void {
    setSelectionMode('FOLLOW_BEST')
    if (bestComparison) {
      setSelectedComparisonId(bestComparison.id)
      setSelectedId(bestComparison.legacyOpportunityId)
    }
  }

  function changeDurationFilter(duration: DurationFilter): void {
    setDurationFilter(duration)
    setSelectionMode('FOLLOW_BEST')
  }

  async function execute(): Promise<void> {
    if (!selected) return
    await run(() => window.arbApp.execute({ opportunityId: selected.id, quantity }), '执行流程已更新')
  }

  async function toggleManualExecutionCondition(condition: keyof ManualExecutionConditions): Promise<void> {
    if (!snapshot) return
    const current = snapshot.settings.manualExecutionConditions[condition]
    if (current) {
      const confirmed = window.confirm('关闭后，该项只在手动下单时被忽略；自动开单仍会严格检查。账户余额、最小委托、盘口深度和执行中订单等硬条件不能关闭。确认忽略此条件？')
      if (!confirmed) return
    }
    const result = await run(() => window.arbApp.updateSettings({
      manualExecutionConditions: {
        ...snapshot.settings.manualExecutionConditions,
        [condition]: !current
      }
    }), current ? '已忽略一项手动下单条件' : '已恢复手动下单条件')
    if (result) setSnapshot({ ...snapshot, settings: result })
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
      ...(mode === 'SIMULATION' ? { mexcAutomationEnabled: false, polymarketLiveEnabled: false, gateLiveEnabled: false, predictFunLiveEnabled: false, kalshiLiveEnabled: false, allowUnprofitableTestTrade: false } : {})
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

  async function savePredictFunCredentials(): Promise<void> {
    const result = await run(
      () => window.arbApp.updatePredictFunCredentials({
        apiKey: predictFunApiKey || undefined,
        accountType: predictFunAccountType,
        accountAddress: predictFunAccountAddress || undefined,
        signerPrivateKey: predictFunPrivateKey || undefined
      }),
      'Predict.fun 凭据已加密保存，行情正在刷新'
    )
    if (!result) return
    setPredictFunCredentials(result)
    setPredictFunApiKey('')
    setPredictFunPrivateKey('')
    setPredictFunPreparation(undefined)
  }

  async function openPredictFunPage(): Promise<void> {
    await run(
      () => window.arbApp.openPredictFunPage(),
      'Predict.fun 单页面已打开；需要释放资源时点击“停止监听”'
    )
    setPredictFunPageStatus(await window.arbApp.getPredictFunPageCaptureStatus())
  }

  async function stopPredictFunPage(): Promise<void> {
    await run(() => window.arbApp.stopPredictFunPage(), 'Predict.fun 监听已停止，页面资源已释放')
    setPredictFunPageStatus(await window.arbApp.getPredictFunPageCaptureStatus())
  }

  async function saveLimitlessCredentials(): Promise<void> {
    const result = await run(
      () => window.arbApp.updateLimitlessCredentials({
        tokenId: limitlessTokenId || undefined,
        tokenSecret: limitlessTokenSecret || undefined,
        walletPrivateKey: limitlessPrivateKey || undefined
      }),
      'Limitless 交易凭据已加密保存'
    )
    if (!result) return
    setLimitlessCredentials(result)
    setLimitlessTokenId('')
    setLimitlessTokenSecret('')
    setLimitlessPrivateKey('')
    setLimitlessPreparation(undefined)
  }

  async function prepareLimitlessWithoutSubmitting(): Promise<void> {
    const result = await run(
      () => window.arbApp.prepareLimitlessWithoutSubmitting(),
      'Limitless 非下单联调完成；没有发送真实订单'
    )
    if (result) setLimitlessPreparation(result)
  }

  async function preparePredictFunWithoutSubmitting(): Promise<void> {
    const result = await run(
      () => window.arbApp.preparePredictFunWithoutSubmitting(),
      'Predict.fun 非下单联调完成；没有发送真实订单'
    )
    if (result) setPredictFunPreparation(result)
  }

  async function saveGateCredentials(): Promise<void> {
    const result = await run(
      () => window.arbApp.updateGateCredentials({ apiKey: gateApiKey || undefined, apiSecret: gateApiSecret || undefined }),
      'Gate APIv4 只读凭据已加密保存'
    )
    if (!result) return
    setGateCredentials(result)
    setGateApiKey('')
    setGateApiSecret('')
    setGatePreparation(undefined)
  }

  async function openGatePage(): Promise<void> {
    await run(() => window.arbApp.openGatePage(), 'Gate 事件合约单页面已打开；需要释放资源时点击“停止监听”')
    setGatePageStatus(await window.arbApp.getGatePageCaptureStatus())
  }

  async function stopGatePage(): Promise<void> {
    await run(() => window.arbApp.stopGatePage(), 'Gate 监听已停止，页面资源已释放')
    setGatePageStatus(await window.arbApp.getGatePageCaptureStatus())
  }

  async function startGateOrderCapture(): Promise<void> {
    const result = await run(() => window.arbApp.startGateOrderCapture(), 'Gate 捕获模式已开启；请在指纹浏览器中手动完成一次最小订单，程序不会自动提交')
    if (result) setGateOrderCapture(result)
  }

  async function stopGateOrderCapture(): Promise<void> {
    const result = await run(() => window.arbApp.stopGateOrderCapture(), 'Gate 链路采集已停止；脱敏元数据仍保留，可先导出分析')
    if (result) setGateOrderCapture(result)
  }

  async function clearGateOrderCapture(): Promise<void> {
    const result = await run(() => window.arbApp.clearGateOrderCapture(), 'Gate 订单捕获结构已清除，恢复只读模式')
    if (result) setGateOrderCapture(result)
  }

  async function exportGateOrderCapture(): Promise<void> {
    const path = await run(() => window.arbApp.exportGateOrderCapture(), '已导出脱敏 Gate 订单链路，可把该文件发给我分析')
    if (path) setMessage(`Gate 脱敏订单链路已导出：${path}`)
  }

  async function prepareGateWithoutSubmitting(): Promise<void> {
    const result = await run(() => window.arbApp.prepareGateWithoutSubmitting(), 'Gate 非下单联调完成；没有发送真实订单')
    if (result) setGatePreparation(result)
  }

  async function startPredictFunOrderCapture(): Promise<void> {
    const result = await run(() => window.arbApp.startPredictFunOrderCapture(), 'Predict.fun 捕获模式已开启；请在已登录页面手动完成一次最小订单，程序不会自动提交')
    if (result) setPredictFunOrderCapture(result)
  }

  async function stopPredictFunOrderCapture(): Promise<void> {
    const result = await run(() => window.arbApp.stopPredictFunOrderCapture(), 'Predict.fun 链路采集已停止；可导出脱敏元数据')
    if (result) setPredictFunOrderCapture(result)
  }

  async function clearPredictFunOrderCapture(): Promise<void> {
    const result = await run(() => window.arbApp.clearPredictFunOrderCapture(), 'Predict.fun 订单捕获结构已清除')
    if (result) setPredictFunOrderCapture(result)
  }

  async function exportPredictFunOrderCapture(): Promise<void> {
    const path = await run(() => window.arbApp.exportPredictFunOrderCapture(), '已导出脱敏 Predict.fun 订单链路，可把该文件发给我分析')
    if (path) setMessage(`Predict.fun 脱敏订单链路已导出：${path}`)
  }

  async function saveKalshiCredentials(): Promise<void> {
    const result = await run(
      () => window.arbApp.updateKalshiCredentials({ apiKeyId: kalshiApiKeyId || undefined, privateKeyPem: kalshiPrivateKeyPem || undefined }),
      'Kalshi API 身份已加密保存；只读联调可用'
    )
    if (!result) return
    setKalshiCredentials(result)
    setKalshiApiKeyId('')
    setKalshiPrivateKeyPem('')
    setKalshiPreparation(undefined)
  }

  async function openKalshiPage(): Promise<void> {
    await run(() => window.arbApp.openKalshiPage(), 'Kalshi 单页面已打开；后台继续被动监听网页行情')
    setKalshiPageStatus(await window.arbApp.getKalshiPageCaptureStatus())
  }

  async function stopKalshiPage(): Promise<void> {
    await run(() => window.arbApp.stopKalshiPage(), 'Kalshi 监听已停止，页面资源已释放')
    setKalshiPageStatus(await window.arbApp.getKalshiPageCaptureStatus())
  }

  async function prepareKalshiWithoutSubmitting(): Promise<void> {
    const result = await run(() => window.arbApp.prepareKalshiWithoutSubmitting(), 'Kalshi 非下单联调完成；没有发送真实订单')
    if (result) setKalshiPreparation(result)
  }

  async function executeSelectedMultiVenue(): Promise<void> {
    if (!snapshot || !selectedComparison || selectedComparison.executionProvider !== 'MULTI_VENUE' || selectedComparison.legs.length !== 2) return
    if (!selectedComparison.legs.every((leg) => isMultiVenueExecutionVenue(leg.venueId))) {
      setMessage('当前路线包含尚未开放真实执行的平台（Limitless 仍为只读）')
      return
    }
    if (!multiVenueGateReport?.allowed) {
      setMessage(multiVenueGateReport?.firstBlockReason ?? '当前双腿入场条件未通过')
      return
    }
    const requestedQuantity = Number(multiVenueQuantity)
    const maxQuantity = multiVenueMaxQuantity
    if (!Number.isFinite(requestedQuantity) || requestedQuantity < 1) {
      setMessage('请输入至少 1 份的双腿执行数量，未发送订单')
      return
    }
    if (selectedGateLeg && requestedQuantity < multiVenueMinimumQuantity) {
      setMessage(`Gate 最小下单金额为 5 USDT；按当前价格至少需要 ${multiVenueMinimumQuantity.toFixed(2)} 份，未发送订单`)
      return
    }
    if (!Number.isFinite(maxQuantity) || maxQuantity < 1) {
      setMessage(unprotectedMode ? '单笔本金上限不足以提交 1 份双腿订单' : '两边盘口不足 1 份，未发送双腿订单')
      return
    }
    const orderQuantity = Math.floor(requestedQuantity * 100) / 100
    if (orderQuantity > maxQuantity) {
      setMessage(unprotectedMode
        ? `输入 ${orderQuantity.toFixed(2)} 份超过单笔本金上限可支持的 ${maxQuantity.toFixed(2)} 份`
        : `输入 ${orderQuantity.toFixed(2)} 份超过当前两边可执行上限 ${maxQuantity.toFixed(2)} 份`)
      return
    }
    const request: MultiVenueExecutionCommand = {
      comparisonId: selectedComparison.id,
      quantity: orderQuantity.toFixed(2),
      confirmed: true
    }
    const result = await run(() => window.arbApp.executeMultiVenue(request), '双腿执行已完成或进入恢复态；请查看两边订单号')
    if (result) setMultiVenueReceipt(result)
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

  async function toggleKalshiLive(): Promise<void> {
    if (!snapshot) return
    const enabling = !snapshot.settings.kalshiLiveEnabled
    if (enabling) {
      if (!kalshiCredentials?.configured) {
      setMessage('请先保存 Kalshi API Key ID 与 RSA 私钥')
        return
      }
      const confirmed = window.confirm('启用后，机会面板中的“双腿执行”按钮才会生效。系统会先成交 MEXC 或 Polymarket，再向 Kalshi 发送实际成交数量；不会自动下单。确认开启？')
      if (!confirmed) return
    }
    const result = await run(() => window.arbApp.updateSettings({ kalshiLiveEnabled: enabling }))
    if (result) setSnapshot({ ...snapshot, settings: result })
  }

  async function toggleGateLive(): Promise<void> {
    if (!snapshot) return
    const enabling = !snapshot.settings.gateLiveEnabled
    if (enabling && gateOrderCapture?.capturing) {
      setMessage('请先停止 Gate 链路采集并导出脱敏元数据，再考虑开启实盘开关')
      return
    }
    if (enabling) {
      if (!gateOrderCapture?.executionReady) {
        setMessage('请先在已接管的 Gate 指纹浏览器页面打开事件合约单页；独立只读页面不能执行订单')
        return
      }
      const confirmed = window.confirm('开启后，确认的 Gate 双腿机会会在后台操作已登录页面，点击一次买入并等待这一次响应；未知结果不会自动重试。确认开启？')
      if (!confirmed) return
    }
    const result = await run(() => window.arbApp.updateSettings({ gateLiveEnabled: enabling }))
    if (result) setSnapshot({ ...snapshot, settings: result })
  }

  async function togglePredictFunLive(): Promise<void> {
    if (!snapshot) return
    const enabling = !snapshot.settings.predictFunLiveEnabled
    if (enabling) {
      const pageReady = predictFunPageStatus?.state === 'CONNECTED'
      if (!predictFunCredentials?.tradingConfigured && !pageReady) {
        setMessage('请先配置 Predict.fun API 交易身份，或打开已登录的 Predict.fun 5m/15m 页面')
        return
      }
    }
    const result = await run(() => window.arbApp.updateSettings({ predictFunLiveEnabled: enabling }))
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
    const maximumSlippage = Number(maxHedgeSlippageDraft)
    const maximumLoss = Number(maxRecoveryLossDraft)
    const retryCount = Number(hedgeRetryCountDraft)
    if (!Number.isFinite(maximumSlippage) || maximumSlippage < 0 || maximumSlippage > 0.5) {
      setMessage('Polymarket最大加价须为0至0.50之间的价格数值')
      return
    }
    if (!Number.isFinite(maximumLoss) || maximumLoss < 0 || maximumLoss > 10_000) {
      setMessage('恢复对冲最大可接受亏损须为0至10,000 USDT')
      return
    }
    if (!Number.isInteger(retryCount) || retryCount < 0 || retryCount > 20) {
      setMessage('Polymarket自动补单次数须为0至20的整数')
      return
    }
    const preHedgeRatio = Number(preHedgeRatioDraft)
    if (!Number.isFinite(preHedgeRatio) || preHedgeRatio < 0 || preHedgeRatio > 100) {
      setMessage('预对冲比例须为0至100之间的数值')
      return
    }
    const result = await run(() => window.arbApp.updateSettings({
      maxHedgeSlippage: maximumSlippage.toFixed(4),
      maxRecoveryLossUsdt: maximumLoss.toFixed(2),
      polymarketHedgeRetryCount: retryCount,
      polymarketHedgeMode: hedgeModeDraft,
      preHedgeRatioPct: preHedgeRatio
    }), '第二腿价格保护与恢复参数已保存')
    if (result && snapshot) setSnapshot({ ...snapshot, settings: result })
  }

  async function toggleUnprotectedExecution(): Promise<void> {
    if (!snapshot) return
    const enabling = !snapshot.settings.unprotectedExecutionEnabled
    if (enabling && !window.confirm('全局无保护模式：MEXC/Polymarket使用原极速逻辑；Gate/Kalshi按输入份额同时提交两边，不等待首腿成交、不按实际成交量对齐，并跳过深度、滑点、收益和结算门槛。单腿失败或成交数量不同会产生裸敞口，程序不会自动补单或重试。确认开启？')) return
    const result = await run(() => window.arbApp.updateSettings({ unprotectedExecutionEnabled: enabling }),
      enabling ? '无保护极速模式已开启' : '无保护极速模式已关闭')
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
      const confirmed = window.confirm('仅供跑通链路：放开一次条件收益率和结算信号门槛。通常限制5 USDT；若平台最小可成交份额需要更多本金，会按实时价格放宽，但绝不超过12 USDT。行情过期与临近结算仍会拦截。确认启用？')
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
  const visibleMultiVenueRecoverySessions = undismissedRecoverySessions(
    snapshot.multiVenueExecutionSessions,
    dismissedMultiVenueRecoveryIds
  )
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
          {snapshot.multiVenueBoard.platforms
            .map((platform) => <VenueHealthChip key={platform.id} platform={platform} onToggle={(venue) => void toggleVenueMonitoring(venue)} disabled={busy} />)}
        </div>
        <div className="top-actions">
          {snapshot.settings.autoOpenEnabled && <button className="auto-armed-badge" type="button" onClick={() => void toggleAutoOpen()} disabled={busy} title="自动开单已布防，点击立即停止">
            <Bot aria-hidden="true" />
            <span><strong>自动已布防</strong><small>{snapshot.settings.autoOpenQuantityMode === 'FIXED' ? `${snapshot.settings.autoOpenFixedQuantity}份` : `最大量${snapshot.settings.autoOpenMaxQuantityPct}%`} · 点击停止</small></span>
          </button>}
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
        {visibleMultiVenueRecoverySessions.length > 0 && <section className="recovery-sessions-banner" role="alert">
          <ShieldAlert aria-hidden="true" />
          <span><strong>{visibleMultiVenueRecoverySessions.length} 条跨平台执行会话需要恢复核对</strong><small>软件不会自动重发未知订单；请打开执行日志核对两边实际成交后再标记已恢复。</small></span>
          <button className="recovery-banner-close" type="button" aria-label="关闭跨平台恢复提示" onClick={() => {
            setDismissedMultiVenueRecoveryIds((current) => {
              const next = new Set(current)
              snapshot.multiVenueExecutionSessions.forEach((session) => next.add(session.sessionId))
              return next
            })
          }}><X aria-hidden="true" /></button>
        </section>}
        <section className="main-column">
          <section className="panel opportunities-panel">
            <div className="panel-header opportunities-header">
              <div className="scanner-title"><h1>多平台套利机会</h1><span>{integratedPlatformCount}个平台 · {visibleComparisons.length}组对比 · {readyOpportunityCount}条可执行</span></div>
              <div className="opportunity-toolbar">
                <div className="compact-segments" role="group" aria-label="机会周期筛选">
                  {(['ALL', 5, 15] as const).map((duration) => (
                    <button key={duration} type="button" aria-pressed={durationFilter === duration} onClick={() => changeDurationFilter(duration)}>
                      {duration === 'ALL' ? '全部' : `${duration}m`}
                    </button>
                  ))}
                </div>
                <div className="compact-segments selection-mode-control" role="group" aria-label="机会选择方式">
                  <button type="button" aria-pressed={selectionMode === 'FOLLOW_BEST'} onClick={followBestOpportunity} title="自动选中当前可执行净利润最大的机会">
                    <Zap aria-hidden="true" />跟随最优
                  </button>
                  <button type="button" aria-pressed={selectionMode === 'LOCKED'} onClick={() => setSelectionMode('LOCKED')} title="保持当前选择，不随最优机会变化">
                    <LockKeyhole aria-hidden="true" />锁定当前
                  </button>
                </div>
                <button className="icon-button scanner-refresh" onClick={() => void run(() => window.arbApp.refreshOpportunities())} disabled={busy} aria-label="刷新套利机会" title="刷新套利机会">
                  <RefreshCw className={busy ? 'spin' : ''} aria-hidden="true" />
                </button>
              </div>
            </div>
            <div className="best-opportunity-strip" role="status" aria-live="polite">
              {bestComparison ? (
                <>
                  <span className="best-opportunity-label">系统推荐</span>
                  <strong>{comparisonLegLabel(bestComparison, 0)} + {comparisonLegLabel(bestComparison, 1)}</strong>
                  <span>{bestComparison.durationMinutes}m</span>
                  <span>可执行 {money(bestComparison.executableQuantity, 2)}份</span>
                  <span className="positive-value">预计 +{money(displayedProfit(bestComparison), 2)} USDT</span>
                  <small>{selectionMode === 'FOLLOW_BEST' ? '下单面板正在跟随最优' : '当前已手动锁定，推荐仅作提示'}</small>
                </>
              ) : <span className="best-opportunity-empty">当前没有通过全部风控的可执行机会</span>}
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>{MULTI_VENUE_TABLE_COLUMNS.map((column) => <th key={column.id}>{column.label}</th>)}</tr>
                </thead>
                <tbody>
                  {orderedComparisonRows.length === 0 && (
                    <tr><td colSpan={MULTI_VENUE_TABLE_COLUMNS.length}><div className="empty-state">当前筛选下暂无真实跨平台报价。{snapshot.connectionDetails.polymarket}</div></td></tr>
                  )}
                  {orderedComparisonRows.map(({ comparison, opportunity }) => {
                    const positive = opportunity
                      ? opportunityReady(opportunity, snapshot, now)
                      : multiVenueEntryReports.get(comparison.id)?.allowed === true
                    const isSelected = comparison.id === selectedComparison?.id
                    const isBest = comparison.id === bestComparison?.id
                    const firstLeg = comparison.legs[0]
                    const secondLeg = comparison.legs[1]
                    const unprotectedReady = !opportunity && unprotectedMode && multiVenueEntryReports.get(comparison.id)?.allowed === true
                    return (
                      <tr key={stableRouteKey(comparison)} className={['opportunity-row', positive ? 'ready' : '', isBest ? 'best' : '', isSelected ? 'selected' : '', opportunity ? '' : comparison.status === 'MANUAL_EXECUTABLE' ? 'manual-executable' : 'read-only'].filter(Boolean).join(' ')} onClick={() => selectComparison(comparison)} tabIndex={0} aria-selected={isSelected} onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        selectComparison(comparison)
                      }}>
                        <td><span className="market-window-cell"><span><span className="duration-pill">{comparison.durationMinutes}m</span>{isBest && <span className="best-badge">最佳</span>}</span><small>{comparison.asset.replace('/USD', '')} · {marketWindowLabel(comparison.startTime, comparison.endTime)}</small></span></td>
                        <td><span className="venue-leg"><strong>{firstLeg?.venueLabel ?? '—'}</strong><span className="quote-inline">{firstLeg && <Direction direction={firstLeg.direction} />}<span className="mono">{firstLeg && Number(firstLeg.price) > 0 ? money(firstLeg.price, 4) : '--'}</span>{firstLeg && Number(firstLeg.price) > 0 && !(Number(firstLeg.availableQuantity) > 0) && <span className="price-only-badge" title="已拿到最优价格，真实盘口深度尚未捕获">仅价</span>}</span></span></td>
                        <td><span className="venue-leg"><strong>{secondLeg?.venueLabel ?? '—'}</strong><span className="quote-inline">{secondLeg && <Direction direction={secondLeg.direction} />}<span className="mono">{secondLeg && Number(secondLeg.price) > 0 ? money(secondLeg.price, 4) : '--'}</span>{secondLeg && Number(secondLeg.price) > 0 && !(Number(secondLeg.availableQuantity) > 0) && <span className="price-only-badge" title="已拿到最优价格，真实盘口深度尚未捕获">仅价</span>}</span></span></td>
                        <td><span className="edge-cell" title={comparison.edgeKind === 'GROSS_ONLY' ? comparison.blockReasons.join('；') : opportunity?.feeVerificationBlocked ? '费用待校验' : opportunity?.settlementRiskBlocked ? '风控拦截' : positive ? '当前可执行' : '未通过全部执行门槛'}>
                          <span className={positive ? 'positive-value' : 'negative-value'}>
                            {comparison.edgeKind === 'GROSS_ONLY' ? `参考 ${Number(comparison.netEdgePerShare) >= 0 ? '+' : ''}${money(comparison.netEdgePerShare, 4)}` : opportunity?.feeVerificationBlocked ? '—' : `${positive ? '+' : ''}${money(comparison.netEdgePerShare, 4)}`}
                          </span>
                          {!positive && <AlertTriangle aria-hidden="true" />}
                        </span></td>
                        <td><span className={positive ? 'positive-value' : 'negative-value'}>{comparison.edgeKind === 'GROSS_ONLY' ? '—' : `${positive ? '+' : ''}${money(displayedProfit(comparison), 2)}`}</span></td>
                        <td className="mono countdown">{secondsRemaining(comparison.endTime, now)}</td>
                        <td><span className={`comparison-status ${unprotectedReady ? 'manual_executable' : comparison.status.toLowerCase()}`} title={comparison.blockReasons.join('；') || '当前通过展示层机会检查'}>{unprotectedReady ? '无保护可执行' : comparison.edgeKind === 'GROSS_ONLY' ? grossComparisonStatusLabel(comparison.status) : comparisonStatusLabel(comparison.status)}</span></td>
                        <td className="all-in-cost-cell mono"><strong>{money(comparison.allInCostPerShare, 4)}</strong><small>/ 份</small></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

        </section>

        <aside className="order-ticket panel" aria-label="执行面板">
          {selectedComparison ? (
            <>
              <section className="ticket-leg-summary">
                <div className="ticket-leg-grid">
                  {selectedComparison.legs.map((leg, index) => <div className="ticket-leg-card" key={`${leg.venueId}:${leg.direction}:${index}`}>
                    <span><strong>{index + 1}. {leg.venueLabel}</strong><Direction direction={leg.direction} /></span>
                    <b className="mono">{Number(leg.price) > 0 ? money(leg.price, 4) : '—'}</b>
                    <small>{Number(leg.availableQuantity) > 0 ? `深度 ${money(leg.availableQuantity, 2)}份` : '仅有价格 · 深度待捕获'} · {quoteAgeLabel(leg.quoteAgeMs)}</small>
                    <small>计划 {Number.isFinite(multiVenueRequestedQuantity) ? multiVenueRequestedQuantity.toFixed(2) : '—'} 份 · 预计 ${Number.isFinite(multiVenueRequestedQuantity) && Number(leg.price) > 0 ? (multiVenueRequestedQuantity * Number(leg.price)).toFixed(2) : '—'}</small>
                  </div>)}
                </div>
                {selectedComparison.executionProvider === 'MULTI_VENUE' && <div className="kalshi-live-ticket">
                  {multiVenueReceipt && multiVenueReceipt.comparisonId === selectedComparison.id && <div className="browser-status-detail"><span>双腿</span><p>{multiVenueReceipt.message} · {multiVenueReceiptStatusLabel(multiVenueReceipt.status)}</p></div>}
                </div>}
              </section>

              {selected ? <>
                <div className="ticket-key-metrics">
                  <span>预计本金<strong>{selected.feeVerificationBlocked ? '—' : `$${requestedCapital.toFixed(2)}`}</strong></span>
                  <span>预计利润<strong className={!selected.feeVerificationBlocked && requestedProfit > 0 ? 'profit' : ''}>{selected.feeVerificationBlocked ? '—' : `${requestedProfit >= 0 ? '+' : ''}$${requestedProfit.toFixed(2)}`}</strong></span>
                  <span>安全距离<strong>{money(selected.settlementDistanceBps, 1)} / {money(selected.requiredSettlementDistanceBps, 1)} bps</strong></span>
                </div>

                {(selected.feeVerificationBlocked || selected.settlementRiskBlocked || selected.stale || Number(selected.conditionalReturnPct) < Number(snapshot.settings.minConditionalReturnPct)) && selected.riskFlags.length > 0 && (
                  <div className="inline-warning"><AlertTriangle aria-hidden="true" /><span>{selected.riskFlags[0]}</span></div>
                )}

                <label className="field-label ticket-quantity-label" htmlFor="quantity">对齐份额</label>
                <div className="quantity-control">
                  <input id="quantity" value={quantity} inputMode="decimal" onFocus={() => setSelectionMode('LOCKED')} onChange={(event) => {
                    setSelectionMode('LOCKED')
                    setQuantity(event.target.value)
                  }} />
                  <button onClick={() => {
                    setSelectionMode('LOCKED')
                    if (snapshot.settings.allowUnprofitableTestTrade) setQuantity(minimumAlignedQuantity.toFixed(2))
                    else void setMaximumQuantity()
                  }} disabled={busy}>
                    {snapshot.settings.allowUnprofitableTestTrade ? '最小' : busy ? '计算中' : '最大'}
                  </button>
                </div>
                {currentPlan && <div className="capacity-summary" title={`账户余额计算已预留${currentPlan.accountBalanceReservePct}%安全垫`}>
                  <span title={`限制：${currentPlan.affordableLimitingFactors.join('、') || '盘口深度'}`}>{snapshot.settings.mode === 'ASSISTED' ? '账户可付' : '本金可用'} <strong>{currentPlan.maxAffordableQuantity}</strong>份</span>
                  <span title={`Polymarket最多接受当前最优价加${snapshot.settings.maxHedgeSlippage}`}>保护价内盘口 <strong>{currentPlan.marketDepthQuantity}</strong>份</span>
                </div>}

                <div className="execute-action-row">
                  <button className={`execute-button ${unprotectedMode || manualRiskOverrideActive ? 'risk-override' : ''}`} onClick={() => void execute()} disabled={!canExecute} title={unprotectedMode ? '无保护模式：MEXC点击后立即并行全量提交Polymarket FAK(最高0.99)，不等成交回报、不校验滑点与收益门槛' : '点击后先复核所选两边盘口；确认MEXC实际成交后才会提交Polymarket对冲'}>
                    {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}
                    {unprotectedMode ? '极速无保护 · ' : manualRiskOverrideActive ? '风险执行 · ' : ''}
                    {snapshot.settings.mode === 'SIMULATION'
                      ? '模拟执行两腿'
                      : snapshot.settings.mexcAutomationEnabled
                        ? '执行MEXC第一腿'
                        : '准备MEXC第一腿'}
                  </button>
                  <ExecutionConditionsHelp checks={executionChecks} busy={busy} onToggle={(condition) => void toggleManualExecutionCondition(condition)} />
                </div>
                {snapshot.settings.autoOpenEnabled && <div className={`browser-status-detail auto-open-status ${snapshot.autoOpenState.status.toLowerCase()}`} role="status" aria-live="polite"><span>AUTO</span><p>{snapshot.autoOpenState.message}</p></div>}
                {!canExecute && executeBlockReason && <p className="execution-note"><AlertTriangle aria-hidden="true" />禁用原因：{executeBlockReason}</p>}

                <div className="cost-breakdown">
                  <details className="ticket-calculation-details">
                    <summary>风险与费用明细</summary>
                    <div>
                      <FormulaHelp inline />
                      <Row label="条件收益率" value={selected.feeVerificationBlocked ? '—' : `${Number(effectiveConditionalReturn) >= 0 ? '+' : ''}${money(effectiveConditionalReturn, 2)}%`} positive={!selected.feeVerificationBlocked && Number(effectiveConditionalReturn) > 0} />
                      <Row label="最坏亏损率" value={selected.feeVerificationBlocked ? '—' : `${money(selected.worstCaseReturnPct, 2)}%`} />
                      <Row label="MEXC结算信号" value={selected.mexcSignal ? <SignalValue direction={selected.mexcSignal} distanceBps={selected.mexcDistanceBps} /> : '未知'} />
                      <Row label="Polymarket结算信号" value={selected.polymarketSignal ? <SignalValue direction={selected.polymarketSignal} distanceBps={selected.polymarketDistanceBps} /> : '未知'} />
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
              </> : <section className="read-only-ticket">
                <div className="ticket-key-metrics">
                  <span>两腿成本<strong>{money(selectedComparison.allInCostPerShare, 4)}</strong></span>
                  <span>参考毛边际<strong className={Number(selectedComparison.netEdgePerShare) > 0 ? 'profit' : ''}>{Number(selectedComparison.netEdgePerShare) >= 0 ? '+' : ''}{money(selectedComparison.netEdgePerShare, 4)}</strong></span>
                  <span>参考收益率<strong>{Number(selectedComparison.conditionalReturnPct) >= 0 ? '+' : ''}{money(selectedComparison.conditionalReturnPct, 2)}%</strong></span>
                </div>
                <label className="field-label ticket-quantity-label" htmlFor="multi-venue-quantity">双腿计划份额</label>
                <div className="quantity-control">
                  <input id="multi-venue-quantity" value={multiVenueQuantity} inputMode="decimal" onChange={(event) => {
                    setSelectionMode('LOCKED')
                    setMultiVenueQuantity(event.target.value)
                  }} />
                  <button onClick={() => {
                    setSelectionMode('LOCKED')
                    if (multiVenueMaxQuantity > 0) setMultiVenueQuantity(multiVenueMaxQuantity.toFixed(2))
                  }} disabled={busy || multiVenueMaxQuantity < 1}>最大</button>
                </div>
                <div className="capacity-summary">
                  <span>{unprotectedMode ? '单笔本金可支持' : '当前可执行上限'} <strong>{Number.isFinite(multiVenueMaxQuantity) ? multiVenueMaxQuantity.toFixed(2) : '—'}</strong>份</span>
                  <span>预计两腿本金 <strong>${Number.isFinite(multiVenueRequestedCapital) ? multiVenueRequestedCapital.toFixed(2) : '—'}</strong></span>
                </div>
                {selectedGateLeg && <div className="capacity-summary">
                  <span>Gate 最低金额 <strong>$5.00</strong></span>
                  <span>当前价最低 <strong>{multiVenueMinimumQuantity.toFixed(2)}</strong>份</span>
                </div>}
                <div className="multi-venue-plan-summary">
                  {selectedComparison.legs.map((leg) => <div key={`plan-${leg.venueId}`}><span>{leg.venueLabel} {leg.direction}</span><strong>{Number.isFinite(multiVenueRequestedQuantity) ? `${multiVenueRequestedQuantity.toFixed(2)}份` : '—'}</strong><small>{Number.isFinite(multiVenueRequestedQuantity) && Number(leg.price) > 0 ? `$${(multiVenueRequestedQuantity * Number(leg.price)).toFixed(2)}` : '金额待报价'}</small></div>)}
                </div>
                {multiVenueGateReport && selectedComparison.legs.length === 2 && <>
                  <div className="execute-action-row">
                    <button className={`execute-button ${unprotectedMode || multiVenueGateReport.ignoredCount > 0 ? 'risk-override' : ''}`} onClick={() => void executeSelectedMultiVenue()} disabled={busy || !multiVenueGateReport.allowed}>
                      {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Zap aria-hidden="true" />}
                      {multiVenueExecuteLabel(unprotectedMode, selectedComparison.legs[0].direction, selectedComparison.legs[1].venueLabel)}
                    </button>
                    <ExecutionConditionsHelp checks={multiVenueGateReport.checks} busy={busy} onToggle={(condition) => void toggleManualExecutionCondition(condition)} />
                  </div>
                  {unprotectedMode && <p className="unprotected-execution-note"><AlertTriangle aria-hidden="true" />按输入份额同时提交两边；不等待首腿成交、不按实际成交量自动对齐或补单。</p>}
                </>}
              </section>}
            </>
          ) : <div className="empty-state">没有可用机会</div>}
        </aside>
      </main>

      {active && executionNoticeKey !== dismissedExecutionNoticeKey && <ExecutionBar
        session={active}
        busy={busy}
        onRetryProtected={() => void run(async () => {
          const result = await window.arbApp.retryPolymarketHedge({ mode: 'PROTECTED' })
          if (result.state !== 'HEDGED') throw new Error(result.error ?? '仍有未对冲份额，请继续恢复或平仓处理')
          return result
        }, 'Polymarket剩余敞口恢复完成')}
        onRetryEmergency={() => {
          const confirmed = window.confirm('快速恢复会在最大可接受亏损范围内使用多个价位成交，速度更快，但平均价格可能稍差。确认用于减少当前未对冲敞口？')
          if (!confirmed) return
          void run(async () => {
            const result = await window.arbApp.retryPolymarketHedge({ mode: 'EMERGENCY_MARKET' })
            if (result.state !== 'HEDGED') throw new Error(result.error ?? '快速恢复后仍有未对冲份额，请继续恢复或平仓处理')
            return result
          }, 'Polymarket快速恢复完成')
        }}
        onOpenHistory={() => setHistoryOpen(true)}
        onDismiss={() => setDismissedExecutionNoticeKey(executionNoticeKey)}
      />}

      {/* 挂起的待恢复套利组：继续钉在主页醒目位置，按订单号补单，不与新开仓互斥 */}
      {snapshot.recoverySessions
        .filter((session) => !dismissedRecoveryIds.has(session.id))
        .map((session) => <ExecutionBar
          key={session.id}
          session={session}
          busy={busy}
          onRetryProtected={() => void run(async () => {
            const result = await window.arbApp.retryPolymarketHedge({ orderId: session.id, mode: 'PROTECTED' })
            if (result.state !== 'HEDGED') throw new Error(result.error ?? '仍有未对冲份额，请继续恢复或平仓处理')
            return result
          }, 'Polymarket剩余敞口恢复完成')}
          onRetryEmergency={() => {
            const confirmed = window.confirm('快速恢复会在最大可接受亏损范围内使用多个价位成交，速度更快，但平均价格可能稍差。确认用于减少当前未对冲敞口？')
            if (!confirmed) return
            void run(async () => {
              const result = await window.arbApp.retryPolymarketHedge({ orderId: session.id, mode: 'EMERGENCY_MARKET' })
              if (result.state !== 'HEDGED') throw new Error(result.error ?? '快速恢复后仍有未对冲份额，请继续恢复或平仓处理')
              return result
            }, 'Polymarket快速恢复完成')
          }}
          onOpenHistory={() => setHistoryOpen(true)}
          onDismiss={() => setDismissedRecoveryIds((current) => new Set(current).add(session.id))}
        />)}

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
        multiVenueSessions={snapshot.multiVenueExecutionHistory}
        busy={busy}
        onDismiss={() => setHistoryOpen(false)}
        onCloseOrder={(order, target) => {
          setHistoryOpen(false)
          setCloseIntent({ order, target })
        }}
        onRetryHedge={(order) => {
          void run(() => window.arbApp.retryPolymarketHedge({ orderId: order.id }), `已对 ${new Date(order.createdAt).toLocaleTimeString('zh-CN', { hour12: false })} 的套利组发起补单`)
        }}
        onMarkMultiVenueRecovered={(sessionId) => {
          void run(() => window.arbApp.markMultiVenueExecutionSessionRecovered(sessionId, '用户已在两边平台核对成交记录'), '跨平台执行会话已标记为已恢复')
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
                <div><strong>账户与环境</strong><span>{snapshot.settings.mexcBrowserMode === 'HUBSTUDIO' ? 'Hubstudio' : '内嵌MEXC'} · {polymarketCredentials?.configured ? 'Polymarket已配置' : 'Polymarket未配置'} · Limitless {limitlessCredentials?.configured ? '已配置' : '待配置'} · Predict {predictFunCredentials?.tradingConfigured ? '已配置' : '待配置'} · Gate {gateCredentials?.configured ? '已配置' : '仅行情'} · Kalshi {kalshiCredentials?.configured ? '已配置' : '仅行情'}</span><small>低频配置：浏览器环境、网络、校准和交易身份</small></div><ChevronRight />
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
              <p>{snapshot.settings.mexcBrowserMode === 'HUBSTUDIO' ? '行情固定并行扫描BTC 5m/15m，不依赖当前详情页；已手动打开环境或页面时会自动接管，连接断开、软件聚焦或电脑休眠恢复后会自动重连，且不会抢占页面焦点。' : '每次启动时最多自动打开一次内嵌窗口；关闭后由用户手动重新打开，登录Cookie独立持久保存。'}应用不读取或保存登录密码。</p>
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
              <div className="browser-status-detail"><span>价格源</span><p>已通过Polymarket官方RTDS的一条公共WebSocket接收Chainlink BTC/USD 60秒TWAP，5m/15m共用，无需密钥；用于结算方向和偏差风控，不替代两平台真实盘口。仅保留内存最新值，不写入逐笔磁盘日志；断线时REST按15秒限频兜底。</p></div>
              </div>
            </details>
            <details className="settings-module credential-section">
              <summary><div><strong>四个平台接入</strong><span>Limitless / Predict.fun / Gate / Kalshi</span><small>分别管理行情页面、可选凭据和实盘开关</small></div><ChevronRight /></summary>
              <div className="settings-module-body">
                <p>公开行情与交易身份分离。Predict.fun 和 Gate 没有 API Key 也可以只靠已登录页面监听行情；Key 仅用于可选账户/余额联调。秘密值只在主进程按需解密，页面、普通设置、日志和状态快照都不会收到私钥原文。</p>
                <details className="credential-platform-card" open>
                  <summary><div><strong>Limitless</strong><span>{limitlessCredentials?.configured ? '交易身份已配置' : '需要 Token + 钱包私钥才可做账户联调'}</span><small>API 交易身份与 Base 钱包</small></div><ChevronRight /></summary>
                  <div className="credential-platform-body">
                <div className="credential-route-card">
                  <strong>Limitless 交易身份</strong>
                  <span>在 Limitless 的 API Tokens 页面派生带 trading scope 的 Token ID 和 Token Secret，再填写 Base 钱包私钥。钱包地址和 Profile ID 由软件自动验证读取。</span>
                </div>
                <label className="settings-field" htmlFor="limitless-token-id">Limitless Token ID（首次必填）
                  <input id="limitless-token-id" type={revealPlatformSecrets ? 'text' : 'password'} value={limitlessTokenId} onChange={(event) => setLimitlessTokenId(event.target.value)} placeholder={limitlessCredentials?.tokenIdMasked ? `已保存 ${limitlessCredentials.tokenIdMasked}；留空不修改` : 'API Token 弹窗 → API Tokens → Derive'} spellCheck={false} autoComplete="new-password" />
                </label>
                <label className="settings-field" htmlFor="limitless-token-secret">Limitless Token Secret（首次必填）
                  <input id="limitless-token-secret" type={revealPlatformSecrets ? 'text' : 'password'} value={limitlessTokenSecret} onChange={(event) => setLimitlessTokenSecret(event.target.value)} placeholder={limitlessCredentials?.hasTokenSecret ? '已保存；留空不修改' : 'Derive 后只显示一次的 Secret'} spellCheck={false} autoComplete="new-password" />
                </label>
                <label className="settings-field" htmlFor="limitless-private-key">Limitless Base 钱包私钥（首次必填）
                  <input id="limitless-private-key" type={revealPlatformSecrets ? 'text' : 'password'} value={limitlessPrivateKey} onChange={(event) => setLimitlessPrivateKey(event.target.value)} placeholder={limitlessCredentials?.hasWalletPrivateKey ? '已保存；留空不修改' : '0x 开头的 32 字节私钥'} spellCheck={false} autoComplete="new-password" />
                </label>
                <button className="wide-secondary" onClick={() => void saveLimitlessCredentials()} disabled={busy || !limitlessCredentials?.encryptionAvailable || (!limitlessCredentials?.configured && (!limitlessTokenId || !limitlessTokenSecret || !limitlessPrivateKey))}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}加密保存并验证 Limitless 身份</button>
                {limitlessCredentials?.message && <div className="browser-status-detail"><span>LIMIT</span><p>{limitlessCredentials.message}{limitlessCredentials.profileId ? ` · Profile ${limitlessCredentials.profileId}` : ''}{limitlessCredentials.walletAddress ? ` · 钱包 ${shortAddress(limitlessCredentials.walletAddress)}` : ''}</p></div>}
                <button className="wide-secondary safe-preparation-button" onClick={() => void prepareLimitlessWithoutSubmitting()} disabled={busy || !limitlessCredentials?.configured}><ShieldCheck aria-hidden="true" />完整联调 Limitless（绝不下单）</button>
                {limitlessPreparation && <PreparationReportView report={limitlessPreparation} />}
                  </div>
                </details>

                <details className="credential-platform-card">
                  <summary><div><strong>Predict.fun</strong><span>{predictFunCredentials?.tradingConfigured ? 'API交易身份已配置' : predictFunPageStatus?.state === 'CONNECTED' ? '已打开页面，可页面下单' : '等待 API 或已登录页面'}</span><small>支持 5m/15m；有 API 走签名接口，无 API 使用已登录页面控件</small></div><ChevronRight /></summary>
                  <div className="credential-platform-body">
                <div className="credential-route-card">
                  <strong>Predict.fun 交易身份</strong>
                  <span>网页账户通常选择 Predict Account；Deposit Address 是账户地址，Privy 私钥对应的 signer 地址会由软件本地派生。</span>
                </div>
                <label className="settings-field" htmlFor="predict-fun-api-key">Predict.fun 主网 API Key（官方API模式必填；网页扫描可留空）
                  <input id="predict-fun-api-key" type={revealPlatformSecrets ? 'text' : 'password'} value={predictFunApiKey} onChange={(event) => setPredictFunApiKey(event.target.value)} placeholder={predictFunCredentials?.configured ? '已保存；填写新值可替换' : '从 Predict.fun 官方申请后粘贴'} spellCheck={false} autoComplete="new-password" />
                </label>
                {predictFunHasApiKey ? <>
                <label className="settings-field" htmlFor="predict-fun-account-type">Predict.fun 账户类型
                  <select id="predict-fun-account-type" value={predictFunAccountType} onChange={(event) => setPredictFunAccountType(event.target.value as 'PREDICT_ACCOUNT' | 'EOA')}>
                    <option value="PREDICT_ACCOUNT">Predict Account（网页智能钱包）</option>
                    <option value="EOA">普通 EOA 钱包</option>
                  </select>
                </label>
                <label className="settings-field" htmlFor="predict-fun-account-address">{predictFunAccountType === 'PREDICT_ACCOUNT' ? 'Predict Deposit Address' : 'EOA 钱包地址'}
                  <input id="predict-fun-account-address" value={predictFunAccountAddress} onChange={(event) => setPredictFunAccountAddress(event.target.value)} placeholder="0x 开头的 BNB Chain 地址" spellCheck={false} autoComplete="off" />
                </label>
                <label className="settings-field" htmlFor="predict-fun-private-key">{predictFunAccountType === 'PREDICT_ACCOUNT' ? 'Privy Wallet 私钥' : 'EOA 钱包私钥'}
                  <input id="predict-fun-private-key" type={revealPlatformSecrets ? 'text' : 'password'} value={predictFunPrivateKey} onChange={(event) => setPredictFunPrivateKey(event.target.value)} placeholder={predictFunCredentials?.hasSignerPrivateKey ? '已保存；留空不修改' : '0x 开头的 32 字节私钥'} spellCheck={false} autoComplete="new-password" />
                </label>
                <label className="credential-reveal"><input type="checkbox" checked={revealPlatformSecrets} onChange={(event) => setRevealPlatformSecrets(event.target.checked)} /><span>临时显示本次尚未保存的密钥输入</span></label>
                </> : <div className="credential-notice"><Network aria-hidden="true" /><span>当前没有 API Key：下面账户地址和私钥无需填写，软件会继续使用 Predict.fun 页面自身的 REST/WebSocket 监听行情。</span></div>}
                <div className="credential-notice"><KeyRound aria-hidden="true" /><span>API Key 使用系统钥匙串加密，不写入普通设置文件。盘口通过 WebSocket 实时更新；REST 每15秒发现轮次、每30秒校准，断线时才临时回退。</span></div>
                <button className="wide-secondary" onClick={() => void savePredictFunCredentials()} disabled={busy || !predictFunCredentials?.encryptionAvailable || (!predictFunCredentials?.configured && predictFunApiKey.trim().length < 8)}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}加密保存 Predict.fun 身份</button>
                <button className="wide-secondary" onClick={() => void openPredictFunPage()} disabled={busy}><ExternalLink aria-hidden="true" />打开 Predict.fun 单页面行情</button>
                <button className="wide-secondary" onClick={() => void stopPredictFunPage()} disabled={busy}><Square aria-hidden="true" />停止 Predict.fun 监听并释放页面</button>
                <div className="credential-notice"><Network aria-hidden="true" /><span>未配置 API Key 时，软件只被动监听这一个网页自身的 REST 响应和 WebSocket 帧；开启实盘后会在同一已登录页面按当前 5m/15m 市场模拟点击买入，不复制网页 Key，也不重放捕获请求。</span></div>
                {predictFunPageStatus && <div className="browser-status-detail"><span>页面</span><p>{predictFunPageStatus.message}</p></div>}
                {predictFunOrderCapture && <div className="browser-status-detail"><span>订单捕获</span><p>{predictFunOrderCapture.message} · 链路 {predictFunOrderCapture.traceEntryCount}（请求 {predictFunOrderCapture.requestCount} / 响应 {predictFunOrderCapture.responseCount} / WS {predictFunOrderCapture.webSocketCount}）</p></div>}
                {snapshot.multiVenueBoard.platforms.filter((platform) => platform.id === 'LIMITLESS' || platform.id === 'PREDICT_FUN' || platform.id === 'GATE' || platform.id === 'KALSHI').map((platform) => (
                  <div className="browser-status-detail" key={platform.id}><span>{platform.id === 'LIMITLESS' ? 'LIMIT' : platform.id === 'PREDICT_FUN' ? 'PRED' : platform.id === 'GATE' ? 'GATE' : 'KALSHI'}</span><p>{platform.integrationState === 'PLANNED' ? '暂不纳入短周期扫描' : platform.connectionState === 'CONNECTED' ? '行情在线' : platform.connectionState === 'NOT_CONFIGURED' ? '等待网页行情或官方Key' : '连接异常'} · {platform.id === 'PREDICT_FUN' && snapshot.settings.predictFunLiveEnabled ? '实盘下单已开启' : platform.integrationState === 'READ_ONLY' ? '只读' : platform.integrationState}</p></div>
                ))}
                {predictFunCredentials?.message && <div className="browser-status-detail"><span>PRED</span><p>{predictFunCredentials.message}{predictFunCredentials.apiKeyMasked ? ` · ${predictFunCredentials.apiKeyMasked}` : ''}{predictFunCredentials.signerAddress ? ` · signer ${shortAddress(predictFunCredentials.signerAddress)}` : ''}</p></div>}
                <div className="credential-notice"><ShieldAlert aria-hidden="true" /><span>Predict.fun 双腿执行已接入：API 身份和页面控件二选一；首次建议用小额、无自动重试方式验证 5m/15m 各一单。</span></div>
                <button className="wide-secondary" onClick={() => void startPredictFunOrderCapture()} disabled={busy}><ShieldAlert aria-hidden="true" />开启 Predict.fun 订单捕获（只等你手动下单）</button>
                {predictFunOrderCapture?.capturing && <button className="wide-secondary" onClick={() => void stopPredictFunOrderCapture()} disabled={busy}><Square aria-hidden="true" />停止 Predict.fun 链路采集</button>}
                <button className="wide-secondary" onClick={() => void exportPredictFunOrderCapture()} disabled={busy || !predictFunOrderCapture?.traceEntryCount}><Download aria-hidden="true" />导出脱敏 Predict.fun 订单链路</button>
                {predictFunOrderCapture?.traceEntryCount ? <button className="wide-secondary" onClick={() => void clearPredictFunOrderCapture()} disabled={busy}><Trash2 aria-hidden="true" />清除 Predict.fun 订单捕获</button> : null}
                <button className="wide-secondary" onClick={() => void togglePredictFunLive()} disabled={busy}>{snapshot.settings.predictFunLiveEnabled ? <Square aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}{snapshot.settings.predictFunLiveEnabled ? '关闭 Predict.fun 实盘下单' : '开启 Predict.fun 实盘下单'}</button>
                <button className="wide-secondary safe-preparation-button" onClick={() => void preparePredictFunWithoutSubmitting()} disabled={busy || !predictFunCredentials?.tradingConfigured}><ShieldCheck aria-hidden="true" />完整联调 Predict.fun（绝不下单）</button>
                {predictFunPreparation && <PreparationReportView report={predictFunPreparation} />}
                  </div>
                </details>

                <details className="credential-platform-card">
                  <summary><div><strong>Gate</strong><span>{gateCredentials?.configured ? '只读 API 身份已配置' : '无 Key：使用指纹页面监听行情'}</span><small>Hubstudio 页面接管、订单链路捕获和实盘门禁</small></div><ChevronRight /></summary>
                  <div className="credential-platform-body">
                <div className="credential-route-card">
                  <strong>Gate 事件合约</strong>
                  <span>Gate 账户通过 Hubstudio 指纹浏览器页面接管；BTC 5分钟、15分钟盘口和事件订单都只复用页面自身会话。</span>
                </div>
                <details className="credential-help">
                  <summary>可选：Gate APIv4 只读账户身份（没有 Key 可跳过）</summary>
                  <div>
                <label className="settings-field" htmlFor="gate-api-key">Gate APIv4 Key（账户只读联调；公开扫描可留空）
                  <input id="gate-api-key" type={revealPlatformSecrets ? 'text' : 'password'} value={gateApiKey} onChange={(event) => setGateApiKey(event.target.value)} placeholder={gateCredentials?.apiKeyMasked ? `已保存 ${gateCredentials.apiKeyMasked}；留空不修改` : 'Gate → API管理 → APIv4 Keys'} spellCheck={false} autoComplete="new-password" />
                </label>
                <label className="settings-field" htmlFor="gate-api-secret">Gate APIv4 Secret
                  <input id="gate-api-secret" type={revealPlatformSecrets ? 'text' : 'password'} value={gateApiSecret} onChange={(event) => setGateApiSecret(event.target.value)} placeholder={gateCredentials?.hasApiSecret ? '已保存；留空不修改' : '创建 Key 时显示的 Secret'} spellCheck={false} autoComplete="new-password" />
                </label>
                <div className="credential-notice"><KeyRound aria-hidden="true" /><span>建议在 Gate 创建仅“现货/保证金只读”的 APIv4 Key，并设置 IP 白名单；不要开启交易或提现权限。软件的 Gate 联调守卫仅放行一个 GET 余额接口。</span></div>
                <button className="wide-secondary" onClick={() => void saveGateCredentials()} disabled={busy || !gateCredentials?.encryptionAvailable || (!gateCredentials?.configured && (!gateApiKey || !gateApiSecret))}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}加密保存 Gate 只读身份</button>
                  </div>
                </details>
                <button className="wide-secondary" onClick={() => void openGatePage()} disabled={busy}><ExternalLink aria-hidden="true" />打开 Gate 事件合约单页面</button>
                <button className="wide-secondary" onClick={() => void stopGatePage()} disabled={busy}><Square aria-hidden="true" />停止 Gate 监听并释放页面</button>
                <div className="credential-notice"><Network aria-hidden="true" /><span>配置 Hubstudio 环境后会接管已登录的 Gate 标签页；未配置时才使用独立只读页面。无 API Key 时也可通过后台控件点击下单；订单捕获仅用于诊断和校验。</span></div>
                {gatePageStatus && <div className="browser-status-detail"><span>GATE页</span><p>{gatePageStatus.message}</p></div>}
                {gateOrderCapture && <div className="browser-status-detail"><span>订单捕获</span><p>{gateOrderCapture.message}{gateOrderCapture.endpoint ? ` · ${gateOrderCapture.method} ${gateOrderCapture.endpoint}` : ''}{gateOrderCapture.requestFields?.length ? ` · 字段 ${gateOrderCapture.requestFields.join(', ')}` : ''}{gateOrderCapture.traceEntryCount !== undefined ? ` · 链路 ${gateOrderCapture.traceEntryCount}（请求 ${gateOrderCapture.candidateCount ?? 0} / 响应 ${gateOrderCapture.responseCount ?? 0} / WS ${gateOrderCapture.webSocketCount ?? 0}）` : ''}</p></div>}
                {gateCredentials?.message && <div className="browser-status-detail"><span>GATE</span><p>{gateCredentials.message}{gateCredentials.apiKeyMasked ? ` · ${gateCredentials.apiKeyMasked}` : ''}</p></div>}
                <button className="wide-secondary" onClick={() => void startGateOrderCapture()} disabled={busy}><ShieldAlert aria-hidden="true" />开启 Gate 订单捕获模式（只等你手动下单）</button>
                {gateOrderCapture?.capturing && <button className="wide-secondary" onClick={() => void stopGateOrderCapture()} disabled={busy}><Square aria-hidden="true" />停止链路采集（保留脱敏元数据）</button>}
                <button className="wide-secondary" onClick={() => void exportGateOrderCapture()} disabled={busy || !gateOrderCapture?.traceEntryCount}><Download aria-hidden="true" />导出脱敏订单链路供分析</button>
                <button className={`wide-secondary ${snapshot.settings.gateLiveEnabled ? 'live-toggle enabled' : ''}`} onClick={() => void toggleGateLive()} disabled={busy || (!snapshot.settings.gateLiveEnabled && (gateOrderCapture?.capturing === true || !gateOrderCapture?.executionReady))}>
                  {snapshot.settings.gateLiveEnabled ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}Gate 事件合约实盘：{snapshot.settings.gateLiveEnabled ? '已开启（点击关闭）' : '默认关闭'}
                </button>
                {gateOrderCapture?.captured && <button className="wide-secondary" onClick={() => void clearGateOrderCapture()} disabled={busy}><Trash2 aria-hidden="true" />清除诊断捕获结构</button>}
                <div className="credential-notice"><ShieldAlert aria-hidden="true" /><span>捕获模式不会自动提交订单；实盘开关默认关闭。订单 POST 超时或状态不明时只做回读，不会重复发送。</span></div>
                <button className="wide-secondary safe-preparation-button" onClick={() => void prepareGateWithoutSubmitting()} disabled={busy || !gateCredentials?.configured}><ShieldCheck aria-hidden="true" />完整联调 Gate（绝不下单）</button>
                {gatePreparation && <PreparationReportView report={gatePreparation} />}
                  </div>
                </details>

                <details className="credential-platform-card">
                  <summary><div><strong>Kalshi</strong><span>{kalshiCredentials?.configured ? (snapshot.settings.kalshiLiveEnabled ? '实盘开关已开' : '身份已配置') : '公开行情可不配 Key'}</span><small>Key ID、RSA 私钥和人工双腿开关</small></div><ChevronRight /></summary>
                  <div className="credential-platform-body">
                <div className="credential-route-card">
                  <strong>Kalshi 行情、账户与人工实盘入口</strong>
                  <span>Kalshi 当前只接入 KXBTC15M 15分钟市场；5分钟市场不纳入扫描。真实执行可与 MEXC、Polymarket、Gate 组成已验证双腿组合，默认关闭，不会自动下单。</span>
                </div>
                <label className="settings-field" htmlFor="kalshi-api-key-id">Kalshi API Key ID（首次必填）
                  <input id="kalshi-api-key-id" type={revealPlatformSecrets ? 'text' : 'password'} value={kalshiApiKeyId} onChange={(event) => setKalshiApiKeyId(event.target.value)} placeholder={kalshiCredentials?.apiKeyIdMasked ? `已保存 ${kalshiCredentials.apiKeyIdMasked}；留空不修改` : 'Kalshi API Keys → Key ID'} spellCheck={false} autoComplete="new-password" />
                </label>
                <label className="settings-field" htmlFor="kalshi-private-key">Kalshi RSA 私钥 PEM（首次必填）
                  <textarea id="kalshi-private-key" rows={5} value={kalshiPrivateKeyPem} onChange={(event) => setKalshiPrivateKeyPem(event.target.value)} placeholder={kalshiCredentials?.hasPrivateKey ? '已保存；留空不修改' : '-----BEGIN RSA PRIVATE KEY-----\\n...\\n-----END RSA PRIVATE KEY-----'} spellCheck={false} autoComplete="new-password" />
                </label>
                <div className="credential-notice"><KeyRound aria-hidden="true" /><span>{kalshiCredentials?.message ?? 'Kalshi 公开市场和盘口无需 Key；配置 Key 后可读取账户并进入人工确认下单。'}</span></div>
                <button className="wide-secondary" onClick={() => void saveKalshiCredentials()} disabled={busy || !kalshiCredentials?.encryptionAvailable || (!kalshiCredentials?.configured && (!kalshiApiKeyId || !kalshiPrivateKeyPem))}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}加密保存 Kalshi 身份</button>
                <button className={`wide-secondary ${snapshot.settings.kalshiLiveEnabled ? 'live-toggle enabled' : ''}`} onClick={() => void toggleKalshiLive()} disabled={busy || !kalshiCredentials?.configured}>
                  {snapshot.settings.kalshiLiveEnabled ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}Kalshi 双腿实盘执行：{snapshot.settings.kalshiLiveEnabled ? '已开启（点击关闭）' : '默认关闭'}
                </button>
                <div className="credential-notice"><ShieldAlert aria-hidden="true" /><span>开启开关不会立即发单；每次发送仍需在机会面板确认 ticker、方向、数量和最高价格。网络超时不会自动重试。</span></div>
                <button className="wide-secondary" onClick={() => void openKalshiPage()} disabled={busy}><ExternalLink aria-hidden="true" />打开 Kalshi 页面检查行情</button>
                <button className="wide-secondary" onClick={() => void stopKalshiPage()} disabled={busy}><Square aria-hidden="true" />停止 Kalshi 监听并释放页面</button>
                {kalshiPageStatus && <div className="browser-status-detail"><span>K页</span><p>{kalshiPageStatus.message}</p></div>}
                <button className="wide-secondary safe-preparation-button" onClick={() => void prepareKalshiWithoutSubmitting()} disabled={busy || !kalshiCredentials?.configured}><ShieldCheck aria-hidden="true" />完整联调 Kalshi（绝不下单）</button>
                {kalshiPreparation && <PreparationReportView report={kalshiPreparation} />}
                  </div>
                </details>
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
              <div><ShieldAlert /><div><h3>一次性最小实盘联调</h3><p>绕过一次条件收益率与结算信号门槛；通常不超过5 USDT。若最小可成交份额需要更多本金，会按实时最小本金放宽，绝对上限12 USDT，使用后自动关闭。</p></div></div>
              <button className={`automation-toggle ${snapshot.settings.allowUnprofitableTestTrade ? 'enabled' : ''}`} onClick={() => void toggleUnprofitableTestTrade()}>
                {snapshot.settings.allowUnprofitableTestTrade ? <Check /> : <LockKeyhole />}
                {snapshot.settings.allowUnprofitableTestTrade ? '本次已放开 · 点击关闭' : '确认后放开一次'}
              </button>
              <div><ShieldAlert /><div><h3>实验自动点击</h3><p>自动识别涨跌、金额框和买入按钮；也可用手动校准覆盖。按钮禁用或页面变化会中止。</p></div></div>
              <button className={`automation-toggle ${snapshot.settings.mexcAutomationEnabled ? 'enabled' : ''}`} onClick={() => void toggleMexcAutomation()}>
                {snapshot.settings.mexcAutomationEnabled ? <Check /> : <LockKeyhole />}
                {snapshot.settings.mexcAutomationEnabled ? '已启用 · 点击关闭' : '确认后启用'}
              </button>
              <div><ShieldAlert /><div><h3>Polymarket真实对冲</h3><p>确认MEXC实际成交后自动买入另一边；所有模式都有价格和最大亏损保护，不会无限追价。</p></div></div>
              <button className={`automation-toggle ${snapshot.settings.polymarketLiveEnabled ? 'enabled' : ''}`} onClick={() => void togglePolymarketLive()}>
                {snapshot.settings.polymarketLiveEnabled ? <Check /> : <LockKeyhole />}
                {snapshot.settings.polymarketLiveEnabled ? '真实对冲已启用 · 点击关闭' : '验证后启用真实对冲'}
              </button>
              <fieldset className="hedge-mode-fieldset">
                <legend>第二腿对冲速度</legend>
                <small>普通首轮受最大加价保护；MEXC确认成交后的自动补单改由整组恢复亏损上限保护。</small>
                <div className="segmented-control browser-mode-control" aria-label="第二腿对冲速度">
                  <button type="button" aria-pressed={hedgeModeDraft === 'PROTECTED_LIMIT'} className={hedgeModeDraft === 'PROTECTED_LIMIT' ? 'active' : ''} onClick={() => setHedgeModeDraft('PROTECTED_LIMIT')}>稳健</button>
                  <button type="button" aria-pressed={hedgeModeDraft === 'PROTECTED_MARKET'} className={hedgeModeDraft === 'PROTECTED_MARKET' ? 'active' : ''} onClick={() => setHedgeModeDraft('PROTECTED_MARKET')}>快速（推荐）</button>
                </div>
                <div className="browser-status-detail hedge-mode-description" role="status" aria-live="polite">
                  <span>{hedgeModeDraft === 'PROTECTED_LIMIT' ? '价格优先' : '成交优先'}</span>
                  <p>{hedgeModeDraft === 'PROTECTED_LIMIT'
                    ? '每次优先成交当前最优价，价格更稳；盘口较少时可能需要多次补单。'
                    : '在保护范围内使用多个价位，通常更快完成对冲；平均价格可能略差。'}</p>
                </div>
              </fieldset>
              <div><ShieldAlert /><div><h3>第二腿恢复保护</h3><p>首轮按正常利润保护价FAK；剩余敞口可在整组最终亏损不超过设置值时自动补单。仍无法成交时可从执行条重试，或在订单历史平掉MEXC。</p></div></div>
              <div className="decision-field-grid">
                <label className="settings-field" htmlFor="hedge-max-slippage">普通对冲最大加价（Polymarket / Kalshi）
                  <input id="hedge-max-slippage" type="number" min="0" max="0.5" step="0.01" value={maxHedgeSlippageDraft} onChange={(event) => setMaxHedgeSlippageDraft(event.target.value)} inputMode="decimal" />
                  <small>例如填0.03：当前最优价0.50时，最高只买到0.53；不是允许亏损比例。</small>
                </label>
                <label className="settings-field" htmlFor="recovery-max-loss">恢复最多接受亏损（USDT）
                  <input id="recovery-max-loss" value={maxRecoveryLossDraft} onChange={(event) => setMaxRecoveryLossDraft(event.target.value)} inputMode="decimal" />
                  <small>MEXC确认成交后补剩余份额时生效；可能突破普通最大加价，但整组最坏预计亏损不得超过此值。</small>
                </label>
                <label className="settings-field" htmlFor="hedge-retry-count">自动补单次数
                  <input id="hedge-retry-count" type="number" min="0" max="20" step="1" value={hedgeRetryCountDraft} onChange={(event) => setHedgeRetryCountDraft(event.target.value)} inputMode="numeric" />
                  <small>只补尚未成交的剩余份额；余额、授权、最低单量、价格保护和回执不确定不会自动重试。</small>
                </label>
                <label className="settings-field" htmlFor="pre-hedge-ratio">预对冲比例（%）
                  <input id="pre-hedge-ratio" type="number" min="0" max="100" step="5" value={preHedgeRatioDraft} onChange={(event) => setPreHedgeRatioDraft(event.target.value)} inputMode="numeric" />
                  <small>MEXC下单被接受后立即先对冲这个比例的份额，成交回报到达后补齐差额；0表示关闭。不低于平台最小单量。</small>
                </label>
              </div>
              <button className="wide-secondary" onClick={() => void saveRecoverySettings()} disabled={busy}><Check />保存恢复参数</button>
              <div><Zap /><div><h3>全局无保护极速模式</h3><p>MEXC/Polymarket沿用原极速逻辑；Gate/Kalshi按输入份额同时提交两边，不等待首腿成交、不自动对齐或补单。跳过深度、滑点、收益和结算门槛，但仍保留身份、最低委托、单笔本金、到期截止和执行互斥。</p></div></div>
              <button
                className={snapshot.settings.unprotectedExecutionEnabled ? 'wide-secondary danger-active' : 'wide-secondary'}
                onClick={() => void toggleUnprotectedExecution()}
                disabled={busy}
              >
                {snapshot.settings.unprotectedExecutionEnabled ? '关闭无保护极速模式' : '开启无保护极速模式'}
              </button>
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

function signedUsd(value: string): string {
  const amount = Number(value)
  return `${amount >= 0 ? '+' : '-'}$${Math.abs(amount).toFixed(2)}`
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
  multiVenueSessions,
  busy,
  onDismiss,
  onCloseOrder,
  onRetryHedge,
  onMarkMultiVenueRecovered
}: {
  orders: ArbitrageOrderRecord[]
  multiVenueSessions: MultiVenueExecutionSession[]
  busy: boolean
  onDismiss: () => void
  onCloseOrder: (order: ArbitrageOrderRecord, target: CloseTarget) => void
  onRetryHedge: (order: ArbitrageOrderRecord) => void
  onMarkMultiVenueRecovered: (sessionId: string) => void
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
          {multiVenueSessions.length > 0 && <section className="multi-venue-history-section">
            <div className="history-section-heading"><div><span className="eyebrow">MULTI-VENUE EXECUTIONS</span><h3>多平台双腿记录</h3></div><small>复用本地执行会话，不与旧 MEXC/Polymarket 订单混写</small></div>
            {multiVenueSessions.map((session) => {
              const receipt = session.receipt
              const first = receipt?.firstLeg
              const second = receipt?.secondLeg
              const recoverable = ['STARTED', 'UNPROTECTED_SUBMITTED', 'RECOVERY_REQUIRED', 'RECONCILE_REQUIRED'].includes(session.status)
              const status = multiVenueReceiptStatusLabel(session.status)
              return <article className={`history-order multi-venue-history-order ${recoverable ? 'recovery_required' : ''}`} key={session.sessionId}>
                <div className="history-order-head"><div><strong>{session.comparisonId}</strong><span>执行 {new Date(session.createdAt).toLocaleString('zh-CN', { hour12: false })} · 会话 {session.sessionId}</span></div><span className="order-status">{status}</span></div>
                <div className="history-legs">
                  <div><span className="history-venue">{first?.venueId ?? '第一腿'} {first && <Direction direction={first.direction} />}</span><strong>{first ? `${first.filledQuantity} / ${first.requestedQuantity}份` : '未确认'}</strong>{first?.averagePrice && <small>均价 {money(first.averagePrice, 4)}</small>}{first?.orderId && <small className="history-order-id" title={first.orderId}>订单号 {first.orderId}</small>}</div>
                  <div><span className="history-venue">{second?.venueId ?? '第二腿'} {second && <Direction direction={second.direction} />}</span><strong>{second ? `${second.filledQuantity} / ${second.requestedQuantity}份` : '未提交'}</strong>{second?.averagePrice && <small>均价 {money(second.averagePrice, 4)}</small>}{second?.orderId && <small className="history-order-id" title={second.orderId}>订单号 {second.orderId}</small>}</div>
                  <div><span>执行结果</span><strong>{receipt?.status ?? session.status}</strong><small>{receipt?.message ?? session.recoveryNote ?? '尚无执行回执'}</small></div>
                </div>
                {session.recoveryNote && <p className="history-error">恢复备注：{session.recoveryNote}</p>}
                {recoverable && <div className="history-actions"><button className="recovery-retry-button" onClick={() => onMarkMultiVenueRecovered(session.sessionId)} disabled={busy}>我已核对两边，标记已恢复</button></div>}
              </article>
            })}
          </section>}
          {orders.length === 0 && multiVenueSessions.length === 0 ? <div className="empty-state">尚无 ArbDesk 交易记录。</div> : orders.map((order) => {
            const mexcOpen = Number(order.mexc.openQuantity) > 0
            const polymarketOpen = Number(order.polymarket.openQuantity) > 0
            const closeable = Date.now() < order.endTime && !['CLOSED', 'CANCELLED', 'EXPIRED'].includes(order.status)
            const hedgeRemaining = Math.max(0, Number(order.polymarket.targetQuantity ?? order.mexc.entryFill?.quantity ?? 0) - Number(order.polymarket.entryFill?.quantity ?? 0))
            const hedgeRetryable = closeable && order.status === 'RECOVERY_REQUIRED' && hedgeRemaining > 0.000001
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
                  <div>{order.hedgeOutcome
                    ? <><span>正常互斥结算（保守）</span><strong>最低 {signedUsd(order.hedgeOutcome.worstPnl)}</strong><small>MEXC方向胜 {signedUsd(order.hedgeOutcome.mexcDirectionPnl)} · Poly方向胜 {signedUsd(order.hedgeOutcome.polymarketDirectionPnl)}</small><small>{order.hedgeOutcome.safe ? order.hedgeOutcome.meetsProfitTarget ? '达到利润门槛' : '双边不亏，但最低利润低于开仓门槛' : '至少一种正常结算结果可能亏损'}</small></>
                    : <><span>预计本金 / 利润</span><strong>${money(order.expectedCapital)} / {Number(order.expectedProfit) >= 0 ? '+' : ''}${money(order.expectedProfit)}</strong><small>{order.mode === 'SIMULATION' ? '模拟' : '实盘记录'}</small></>}</div>
                </div>
                {order.hedgeOutcome && Number(order.hedgeOutcome.quantityDifference) !== 0 && <p className={`history-hedge-outcome ${order.hedgeOutcome.safe ? 'safe' : 'unsafe'}`}><Info aria-hidden="true" />Poly相对MEXC {Number(order.hedgeOutcome.quantityDifference) >= 0 ? '+' : ''}{money(order.hedgeOutcome.quantityDifference, 2)}份；{order.hedgeOutcome.safe ? '正常互斥结算下两种结果均不亏，未自动平仓。' : '至少一种正常结算结果可能亏损，需要恢复或平仓。'}</p>}
                {order.closeOperation?.error && <p className={`history-error ${order.status === 'EXPIRED' ? 'archived' : ''}`}>{order.status === 'EXPIRED' ? '历史执行备注：' : ''}{order.closeOperation.error}</p>}
                {hedgeRetryable && <div className="history-actions">
                  <button className="recovery-retry-button" onClick={() => onRetryHedge(order)} disabled={busy}>补齐剩余对冲 {hedgeRemaining.toFixed(2)}份</button>
                </div>}
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
  onRetryProtected,
  onRetryEmergency,
  onOpenHistory,
  onDismiss
}: {
  session: ExecutionSession
  busy: boolean
  onRetryProtected: () => void
  onRetryEmergency: () => void
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
  const quantityDifference = polymarketQuantity - mexcQuantity
  const hasQuantityDifference = Math.abs(quantityDifference) > 0.000001
  const timingSummary = executionTimingSummary(session)
  const stateLabel = state === 'HEDGED' && hasQuantityDifference
    ? session.hedgeOutcome?.meetsProfitTarget ? '对冲完成 · 份额略有偏差' : '对冲完成 · 利润偏低'
    : STATE_LABELS[state]
  const quantityStatus = done && hasQuantityDifference
    ? `偏差 ${quantityDifference >= 0 ? '+' : ''}${quantityDifference.toFixed(2)}`
    : excessQuantity > 0 ? `超额 ${excessQuantity.toFixed(2)}` : `未对冲 ${remainingQuantity.toFixed(2)}`
  return <div className={`execution-bar ${danger ? 'danger' : done ? 'done' : ''}`}>
    <div className="execution-pulse">{done ? <Check /> : danger ? <AlertTriangle /> : <LoaderCircle className="spin" />}</div>
    <div className="execution-summary">
      <span>申请{session.requestedQuantity} · MEXC {mexcQuantity.toFixed(2)} · Poly目标 {targetQuantity.toFixed(2)} · 已成交 {polymarketQuantity.toFixed(2)} · {quantityStatus}份</span>
      <strong>{stateLabel}</strong>
      {session.hedgeOutcome && <small className={`execution-outcomes ${session.hedgeOutcome.safe ? session.hedgeOutcome.meetsProfitTarget ? 'safe' : 'warning' : 'unsafe'}`} title="按实际成交价、手续费和风险缓冲计算；仅表示正常互斥结算的两种结果">正常互斥：MEXC胜 {signedUsd(session.hedgeOutcome.mexcDirectionPnl)} · Poly胜 {signedUsd(session.hedgeOutcome.polymarketDirectionPnl)} · 最低收益率 {session.hedgeOutcome.worstReturnPct}%</small>}
      {timingSummary && <small className="execution-timings" title="本次执行各阶段耗时">{timingSummary}</small>}
      {error && <small className="execution-error" title={error}>{error}</small>}
    </div>
    <div className="execution-progress"><span /></div>
    {state === 'RECOVERY_REQUIRED' && <div className="execution-recovery-actions">
      <button onClick={onRetryProtected} disabled={busy || remainingQuantity <= 0}>{busy ? '处理中' : '稳健补单'}</button>
      <button onClick={onRetryEmergency} disabled={busy || remainingQuantity <= 0}>快速恢复</button>
      <button onClick={onOpenHistory} disabled={busy}>平仓处理</button>
    </div>}
    <button className="execution-close" onClick={onDismiss} aria-label="关闭执行状态提示" title="关闭提示"><X /></button>
  </div>
}

export default App
