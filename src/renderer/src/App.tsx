import { useEffect, useMemo, useState, type JSX } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  ExternalLink,
  Gauge,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Network,
  RefreshCw,
  Settings2,
  ShieldAlert,
  SlidersHorizontal,
  TerminalSquare,
  Unplug,
  X
} from 'lucide-react'
import type {
  AppSnapshot,
  Direction,
  ExecutionState,
  MexcBrowserMode,
  MexcBrowserStatus,
  MexcCalibrationKind,
  Opportunity,
  PolymarketCredentialSummary,
  PolymarketIdentityValidation,
  PolymarketSignatureType
} from '../../shared/types'

const STATE_LABELS: Record<ExecutionState, string> = {
  IDLE: '已创建',
  MEXC_OPENING: '打开MEXC',
  MEXC_SUBMITTING: '提交MEXC',
  MEXC_SUBMITTED: '等待成交确认',
  MEXC_PARTIAL: 'MEXC部分成交',
  MEXC_FILLED: 'MEXC已成交',
  POLY_HEDGING: 'Polymarket对冲中',
  HEDGED: '两腿已对齐',
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

function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot>()
  const [selectedId, setSelectedId] = useState<string>()
  const [quantity, setQuantity] = useState('50')
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mexcStatus, setMexcStatus] = useState<MexcBrowserStatus>()
  const [fillQuantity, setFillQuantity] = useState('')
  const [fillPrice, setFillPrice] = useState('')
  const [fillOrderId, setFillOrderId] = useState('')
  const [hubstudioCode, setHubstudioCode] = useState('')
  const [polymarketProxyUrl, setPolymarketProxyUrl] = useState('')
  const [polymarketCredentials, setPolymarketCredentials] = useState<PolymarketCredentialSummary>()
  const [polySignatureType, setPolySignatureType] = useState<PolymarketSignatureType>(0)
  const [polyFunderAddress, setPolyFunderAddress] = useState('')
  const [polyPrivateKey, setPolyPrivateKey] = useState('')
  const [polyValidation, setPolyValidation] = useState<PolymarketIdentityValidation>()

  useEffect(() => {
    void window.arbApp.getSnapshot().then((value) => {
      setSnapshot(value)
      setSelectedId(value.opportunities[0]?.id)
      void window.arbApp.testPolymarketConnection().catch(() => undefined)
      void window.arbApp.refreshOpportunities().catch(() => undefined)
    })
    const unsubscribe = window.arbApp.onSnapshot(setSnapshot)
    const clock = window.setInterval(() => setNow(Date.now()), 500)
    // Market depth arrives through backend streams; this only refreshes rolling
    // market discovery, settlement references and fees as a fallback.
    const refresh = window.setInterval(() => void window.arbApp.refreshOpportunities().catch(() => undefined), 10_000)
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
  const requestedCapital = selected ? Number(selected.allInCostPerShare) * Number(quantity || 0) : 0
  const requestedProfit = selected ? Number(selected.netEdgePerShare) * Number(quantity || 0) : 0
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
  const ticketCapitalLimit = snapshot?.settings.allowUnprofitableTestTrade
    ? Math.min(12, dynamicTestCapitalLimit, Number(snapshot.settings.maxCapitalPerTrade))
    : Number(snapshot?.settings.maxCapitalPerTrade ?? 0)
  const maximumTicketQuantity = selected && minimumTestCapital <= ticketCapitalLimit
    ? Math.max(minimumAlignedQuantity, Math.floor(ticketCapitalLimit / Number(selected.allInCostPerShare) * 100) / 100)
    : 0
  const testOverrideReady = Boolean(
    snapshot?.settings.allowUnprofitableTestTrade &&
    snapshot.settings.mode === 'ASSISTED' &&
    snapshot.settings.polymarketLiveEnabled &&
    minimumTestCapital <= 12 &&
    requestedCapital <= dynamicTestCapitalLimit
  )
  const canExecute = Boolean(
    selected &&
      Number(quantity) > 0 &&
      Number(quantity) >= minimumAlignedQuantity &&
      Number(quantity) <= Number(selected.maxQuantity) &&
      requestedCapital <= Number(snapshot?.settings.maxCapitalPerTrade ?? 0) &&
      (!snapshot?.settings.allowUnprofitableTestTrade || (minimumTestCapital <= 12 && requestedCapital <= dynamicTestCapitalLimit)) &&
      (Number(selected.netEdgePerShare) >= Number(snapshot?.settings.minNetEdgePerShare ?? 0) || testOverrideReady) &&
      (!selected.settlementRiskBlocked || testOverrideReady) &&
      !selected.stale &&
      !busy
  )
  const executeBlockReason = !selected
    ? '当前没有匹配市场'
    : !(Number(quantity) > 0)
      ? '请输入大于0的对齐份额'
    : Number(quantity) < minimumAlignedQuantity
        ? `最小对齐份额为${minimumAlignedQuantity.toFixed(2)}份（Polymarket至少${selected.polymarketMinOrderSize}份且BUY金额至少1，MEXC本金至少1 USDT）`
      : Number(quantity) > Number(selected.maxQuantity)
        ? '份额超过两边当前盘口可执行量'
        : requestedCapital > Number(snapshot?.settings.maxCapitalPerTrade ?? 0)
          ? '预计本金超过单笔上限'
          : selected.stale
            ? '行情已过期，等待自动刷新'
            : selected.settlementRiskBlocked && !testOverrideReady
              ? selected.settlementRiskReason ?? '结算信号风控拦截'
              : Number(selected.netEdgePerShare) < Number(snapshot?.settings.minNetEdgePerShare ?? 0) && !snapshot?.settings.allowUnprofitableTestTrade
                ? '净收益低于门槛；可在设置中放开一次小额亏损联调'
                : snapshot?.settings.allowUnprofitableTestTrade && !snapshot.settings.polymarketLiveEnabled
                  ? '小额亏损联调需先验证身份并开启Polymarket真实FOK'
                  : snapshot?.settings.allowUnprofitableTestTrade && minimumTestCapital > 12
                    ? `当前最小验证单预计需要${minimumTestCapital.toFixed(2)}，超过12 USDT硬上限`
                  : snapshot?.settings.allowUnprofitableTestTrade && requestedCapital > dynamicTestCapitalLimit
                    ? `小额验证最多使用${dynamicTestCapitalLimit.toFixed(2)} USDT，可点击“最大”自动调整`
                    : undefined

  useEffect(() => {
    if (!selected || snapshot?.activeSession?.opportunityId !== selected.id) return
    setFillQuantity(snapshot.activeSession.requestedQuantity)
    setFillPrice(selected.mexcPrice)
  }, [selected, snapshot?.activeSession])

  async function run<T>(action: () => Promise<T>, success?: string): Promise<T | undefined> {
    setBusy(true)
    setMessage(undefined)
    try {
      const result = await action()
      if (success) setMessage(success)
      return result
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
      return undefined
    } finally {
      setBusy(false)
    }
  }

  async function execute(): Promise<void> {
    if (!selected) return
    await run(() => window.arbApp.execute({ opportunityId: selected.id, quantity }), '执行流程已更新')
  }

  async function confirmFill(): Promise<void> {
    await run(
      () => window.arbApp.confirmMexcFill({ quantity: fillQuantity, averagePrice: fillPrice, orderId: fillOrderId || 'manual-confirm' }),
      '已按MEXC实际成交量发起对冲'
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
      const confirmed = window.confirm('启用后，确认MEXC实际成交会立即提交Polymarket FOK真实对冲订单。确认启用？')
      if (!confirmed) return
    }
    const result = await run(() => window.arbApp.updateSettings({ polymarketLiveEnabled: enabling }))
    if (result) setSnapshot({ ...snapshot, settings: result })
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

  if (!snapshot) {
    return (
      <main className="loading-screen">
        <LoaderCircle className="spin" aria-hidden="true" />
        <p>正在启动交易引擎…</p>
      </main>
    )
  }

  const active = snapshot.activeSession
  const automaticLiveFlow = snapshot.settings.mexcAutomationEnabled && snapshot.settings.polymarketLiveEnabled
  const needsMexcConfirmation = active &&
    ['MEXC_SUBMITTED', 'MEXC_SUBMITTING'].includes(active.state) &&
    !automaticLiveFlow

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Activity aria-hidden="true" /></div>
          <div>
            <strong>ArbDesk</strong>
            <span>MEXC × Polymarket</span>
          </div>
        </div>
        <div className="connection-strip" aria-label="连接状态">
          <span title={snapshot.connectionDetails.mexc}><StatusDot status={snapshot.connection.mexc} />MEXC {snapshot.connection.mexc === 'BROWSER_READY' ? (snapshot.settings.mexcBrowserMode === 'HUBSTUDIO' ? 'Hubstudio' : '内嵌') : '未连接'}</span>
          <span title={snapshot.connectionDetails.polymarket}><StatusDot status={snapshot.connection.polymarket} />Polymarket {snapshot.connection.polymarket === 'CONNECTED' ? '在线' : '断开'}</span>
        </div>
        <div className="top-actions">
          <div className={`mode-badge ${snapshot.settings.mode.toLowerCase()}`}>
            {snapshot.settings.mode === 'SIMULATION' ? '模拟模式' : snapshot.settings.mode === 'ASSISTED' ? '人工监督' : '实盘'}
          </div>
          <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="打开设置">
            <Settings2 aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="risk-banner">
        <ShieldAlert aria-hidden="true" />
        <span><strong>条件型机会：</strong>MEXC 与 Polymarket 结算源不同，界面利润不是保证收益。</span>
        <button onClick={() => setSettingsOpen(true)}>查看风控 <ChevronRight aria-hidden="true" /></button>
      </div>

      <main className="workspace">
        <section className="main-column">
          <div className="metrics-grid">
            <article className="metric-card">
              <div className="metric-icon green"><Gauge aria-hidden="true" /></div>
              <div><span>最佳净边际</span><strong>{money(snapshot.opportunities[0]?.netEdgePerShare ?? '0', 4)}</strong><small>每份结算份额</small></div>
            </article>
            <article className="metric-card">
              <div className="metric-icon blue"><Activity aria-hidden="true" /></div>
              <div><span>可执行机会</span><strong>{snapshot.opportunities.filter((item) => Number(item.netEdgePerShare) > 0 && !item.settlementRiskBlocked).length}</strong><small>已通过结算源风控</small></div>
            </article>
            <article className="metric-card">
              <div className="metric-icon amber"><Clock3 aria-hidden="true" /></div>
              <div><span>最快到期</span><strong>{snapshot.opportunities.length ? secondsRemaining(Math.min(...snapshot.opportunities.map((item) => item.endTime)), now) : '—'}</strong><small>停止前 20 秒禁开仓</small></div>
            </article>
            <article className="metric-card">
              <div className="metric-icon slate"><CircleDollarSign aria-hidden="true" /></div>
              <div><span>单笔限额</span><strong>${money(snapshot.settings.maxCapitalPerTrade)}</strong><small>本地风控</small></div>
            </article>
          </div>

          <section className="panel opportunities-panel">
            <div className="panel-header">
              <div><span className="eyebrow">LIVE SCANNER</span><h1>BTC 跨平台机会</h1></div>
              <button className="secondary-button" onClick={() => void run(() => window.arbApp.refreshOpportunities())} disabled={busy}>
                <RefreshCw className={busy ? 'spin' : ''} aria-hidden="true" />刷新
              </button>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>周期</th><th>MEXC</th><th>Polymarket</th><th>全部成本</th><th>净边际</th><th>可执行量</th><th>剩余</th><th aria-label="选择" /></tr>
                </thead>
                <tbody>
                  {snapshot.opportunities.length === 0 && (
                    <tr><td colSpan={8}><div className="empty-state">暂无真实跨平台报价。{snapshot.connectionDetails.polymarket}</div></td></tr>
                  )}
                  {snapshot.opportunities.map((opportunity) => {
                    const positive = Number(opportunity.netEdgePerShare) > 0 && !opportunity.settlementRiskBlocked
                    const isSelected = opportunity.id === selected?.id
                    return (
                      <tr key={opportunity.id} className={isSelected ? 'selected' : ''} onClick={() => setSelectedId(opportunity.id)} tabIndex={0} onKeyDown={(event) => event.key === 'Enter' && setSelectedId(opportunity.id)}>
                        <td><span className="duration-pill">{opportunity.durationMinutes}m</span></td>
                        <td><Direction direction={opportunity.mexcDirection} /><small>@ {money(opportunity.mexcPrice, 4)}</small></td>
                        <td><Direction direction={opportunity.polymarketDirection} /><small>@ {money(opportunity.polymarketPrice, 4)}</small></td>
                        <td className="mono">{money(opportunity.allInCostPerShare, 4)}</td>
                        <td><span className={positive ? 'positive-value' : 'negative-value'}>{positive ? '+' : ''}{money(opportunity.netEdgePerShare, 4)}</span><small>{opportunity.settlementRiskBlocked ? '风控拦截' : '条件型'}</small></td>
                        <td className="mono">{money(opportunity.maxQuantity, 0)}</td>
                        <td className="mono countdown">{secondsRemaining(opportunity.endTime, now)}</td>
                        <td><ChevronRight className="row-arrow" aria-hidden="true" /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel event-panel">
            <div className="panel-header compact">
              <div><span className="eyebrow">EXECUTION AUDIT</span><h2>执行记录</h2></div>
              <span className="audit-path"><TerminalSquare aria-hidden="true" /> 本地审计日志</span>
            </div>
            <div className="event-list">
              {snapshot.recentEvents.length === 0 ? <div className="empty-state">尚无执行记录。先用模拟模式跑一笔。</div> : snapshot.recentEvents.slice(0, 7).map((event) => (
                <div className="event-row" key={event.id}>
                  <span className={`event-marker ${event.state === 'HEDGED' ? 'ok' : event.state === 'RECOVERY_REQUIRED' ? 'danger' : ''}`} />
                  <time>{new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</time>
                  <strong>{STATE_LABELS[event.state]}</strong>
                  <p>{event.message}</p>
                </div>
              ))}
            </div>
          </section>
        </section>

        <aside className="order-ticket panel" aria-label="执行面板">
          <div className="ticket-heading">
            <div><span className="eyebrow">ORDER TICKET</span><h2>执行套利</h2></div>
            <span className="conditional-badge">CONDITIONAL</span>
          </div>
          {selected ? (
            <>
              <div className="market-summary">
                <div><span>BTC/USD · {selected.durationMinutes}分钟</span><strong>{new Date(selected.endTime).toLocaleTimeString('zh-CN', { hour12: false })} 到期</strong></div>
                <div className="large-countdown">{secondsRemaining(selected.endTime, now)}</div>
              </div>

              <div className="legs">
                <div className="leg-card">
                  <div><span className="venue-logo mexc">M</span><div><strong>MEXC</strong><small>第一腿 · 网页监督</small></div></div>
                  <Direction direction={selected.mexcDirection} />
                  <span className="leg-price">{money(selected.mexcPrice, 4)}</span>
                </div>
                <div className="leg-connector"><ArrowDown aria-hidden="true" /></div>
                <div className="leg-card">
                  <div><span className="venue-logo poly">P</span><div><strong>Polymarket</strong><small>第二腿 · API对冲</small></div></div>
                  <Direction direction={selected.polymarketDirection} />
                  <span className="leg-price">{money(selected.polymarketPrice, 4)}</span>
                </div>
              </div>

              <label className="field-label" htmlFor="quantity">对齐份额</label>
              <div className="quantity-control">
                <input id="quantity" value={quantity} inputMode="decimal" onChange={(event) => setQuantity(event.target.value)} />
                <button onClick={() => setQuantity(snapshot.settings.allowUnprofitableTestTrade
                  ? minimumAlignedQuantity.toFixed(2)
                  : String(Math.min(Number(selected.maxQuantity), maximumTicketQuantity).toFixed(2)))}>
                  {snapshot.settings.allowUnprofitableTestTrade ? '最小' : '最大'}
                </button>
              </div>

              <div className="cost-breakdown">
                <Row label="MEXC本金" value={`$${money(Number(selected.mexcPrice) * Number(quantity || 0) + '', 2)}`} />
                <Row label="Polymarket本金" value={`$${money(Number(selected.polymarketPrice) * Number(quantity || 0) + '', 2)}`} />
                <Row label={`MEXC手续费（${selected.mexcFeeRateSource === 'HISTORY' ? '历史校准' : '保守兜底'} ${(Number(selected.mexcFeeRate) * 100).toFixed(2)}%）`} value={`$${money(Number(selected.mexcFeePerShare) * Number(quantity || 0) + '', 2)}`} />
                <Row label={`Polymarket曲线手续费（r=${(Number(selected.polymarketFeeRate) * 100).toFixed(2)}%）`} value={`$${money(Number(selected.polymarketFeePerShare) * Number(quantity || 0) + '', 2)}`} />
                <Row label="风险缓冲（预留）" value={`$${money(Number(selected.riskBufferPerShare) * Number(quantity || 0) + '', 2)}`} />
                <div className="breakdown-divider" />
                <Row label="预计占用本金" value={`$${requestedCapital.toFixed(2)}`} emphasized />
                <Row label="正常一赢一输" value={`${requestedProfit >= 0 ? '+' : ''}$${requestedProfit.toFixed(2)}`} positive={requestedProfit > 0} />
                <Row label="两边同时输" value={`-$${Math.abs(requestedBothLose).toFixed(2)}`} />
                <Row label="两边同时赢" value={`+$${requestedBothWin.toFixed(2)}`} positive />
                <div className="breakdown-divider" />
                <Row label="MEXC结算信号" value={`${selected.mexcSignal ?? '未知'}${selected.mexcDistanceBps ? ` · ${Number(selected.mexcDistanceBps) >= 0 ? '+' : ''}${money(selected.mexcDistanceBps, 2)} bps` : ''}`} />
                <Row label="Polymarket信号" value={`${selected.polymarketSignal ?? '未知'}${selected.polymarketDistanceBps ? ` · ${Number(selected.polymarketDistanceBps) >= 0 ? '+' : ''}${money(selected.polymarketDistanceBps, 2)} bps` : ''}`} />
              </div>

              {selected.riskFlags.length > 0 && <div className="inline-warning"><AlertTriangle aria-hidden="true" /><span>{selected.riskFlags[0]}</span></div>}

              <button className="execute-button" onClick={() => void execute()} disabled={!canExecute}>
                {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}
                {snapshot.settings.mode === 'SIMULATION'
                  ? '模拟执行两腿'
                  : snapshot.settings.mexcAutomationEnabled
                    ? '执行MEXC第一腿'
                    : '准备MEXC第一腿'}
              </button>
              {!canExecute && executeBlockReason && <p className="execution-note"><AlertTriangle aria-hidden="true" />禁用原因：{executeBlockReason}</p>}
              <p className="execution-note"><LockKeyhole aria-hidden="true" />只有确认MEXC实际成交后，才允许提交Polymarket对冲。</p>
            </>
          ) : <div className="empty-state">没有可用机会</div>}
        </aside>
      </main>

      {active && <ExecutionBar state={active.state} quantity={active.requestedQuantity} error={active.error} />}

      {needsMexcConfirmation && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="fill-title">
            <div className="modal-heading"><div><span className="eyebrow">HUMAN CHECKPOINT</span><h2 id="fill-title">确认MEXC实际成交</h2></div></div>
            <div className="modal-warning"><ShieldAlert aria-hidden="true" /><span>请以MEXC页面实际成交记录为准，不要填写原始委托数量。</span></div>
            <div className="form-grid">
              <label>实际成交份额<input value={fillQuantity} onChange={(event) => setFillQuantity(event.target.value)} inputMode="decimal" /></label>
              <label>成交均价<input value={fillPrice} onChange={(event) => setFillPrice(event.target.value)} inputMode="decimal" /></label>
              <label className="span-two">MEXC订单号<input value={fillOrderId} onChange={(event) => setFillOrderId(event.target.value)} placeholder="可暂填 manual-confirm" /></label>
            </div>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => void run(() => window.arbApp.cancelExecution())}>取消执行</button>
              <button className="execute-button compact-button" onClick={() => void confirmFill()} disabled={busy || !fillQuantity || !fillPrice}><Check aria-hidden="true" />确认并对冲</button>
            </div>
          </section>
        </div>
      )}

      {settingsOpen && (
        <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSettingsOpen(false)}>
          <aside className="settings-drawer" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="drawer-header"><div><span className="eyebrow">LOCAL CONTROL</span><h2 id="settings-title">运行与校准</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="关闭设置"><X /></button></div>
            <section className="settings-section">
              <h3>执行模式</h3>
              <div className="segmented-control">
                <button className={snapshot.settings.mode === 'SIMULATION' ? 'active' : ''} onClick={() => void setMode('SIMULATION')}><Bot />模拟</button>
                <button className={snapshot.settings.mode === 'ASSISTED' ? 'active' : ''} onClick={() => void setMode('ASSISTED')}><SlidersHorizontal />人工监督</button>
              </div>
              <p>人工监督模式会先打开MEXC窗口，确认实际成交后才对冲。</p>
            </section>
            <section className="settings-section">
              <div className="settings-title-row"><h3>MEXC浏览器</h3><span className={mexcStatus?.open ? 'ready-text' : ''}>{mexcStatus?.open ? (mexcStatus.authenticated ? '已连接 · 已检测登录' : '已连接 · 待登录') : '尚未打开'}</span></div>
              <div className="segmented-control browser-mode-control">
                <button className={snapshot.settings.mexcBrowserMode === 'EMBEDDED' ? 'active' : ''} onClick={() => void setMexcBrowser('EMBEDDED')}><Bot />内嵌浏览器</button>
                <button className={snapshot.settings.mexcBrowserMode === 'HUBSTUDIO' ? 'active' : ''} onClick={() => void setMexcBrowser('HUBSTUDIO')}><ExternalLink />Hubstudio</button>
              </div>
              <label className="settings-field">Hubstudio环境ID
                <input value={hubstudioCode} onChange={(event) => setHubstudioCode(event.target.value)} placeholder="例如 223012801" inputMode="numeric" />
              </label>
              <button className="wide-secondary" onClick={() => void setMexcBrowser('HUBSTUDIO')} disabled={!hubstudioCode.trim()}><Check />保存并使用Hubstudio</button>
              <button className="wide-secondary" onClick={() => void openMexc()}><ExternalLink />打开{snapshot.settings.mexcBrowserMode === 'HUBSTUDIO' ? 'Hubstudio环境' : '内嵌MEXC窗口'}</button>
              <button className="wide-secondary" onClick={() => void refreshMexcAccount()} disabled={!mexcStatus?.open || busy}><RefreshCw />读取账户与委托状态（不下单）</button>
              <p>{snapshot.settings.mexcBrowserMode === 'HUBSTUDIO' ? '每次启动ArbDesk时最多自动打开一次；用户关闭后不会反复拉起，需要点击上方按钮重新打开。' : '每次启动时最多自动打开一次内嵌窗口；关闭后由用户手动重新打开，登录Cookie独立持久保存。'}应用不读取或保存登录密码。</p>
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
            </section>
            <section className="settings-section">
              <h3>网页元素校准</h3>
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
            </section>
            <section className="settings-section credential-section">
              <div className="settings-title-row"><h3>Polymarket 网络</h3><span className={snapshot.connection.polymarket === 'CONNECTED' ? 'ready-text' : ''}>{snapshot.connection.polymarket === 'CONNECTED' ? '公共盘口在线' : '未连接'}</span></div>
              <p>独立测试 Gamma 与 CLOB 公共接口，不依赖MEXC窗口或当前是否有BTC市场；不改变Hubstudio的代理。</p>
              <label className="settings-field" htmlFor="poly-proxy-url">HTTP/HTTPS 代理地址
                <input id="poly-proxy-url" value={polymarketProxyUrl} onChange={(event) => setPolymarketProxyUrl(event.target.value)} placeholder="留空为直连，例如 http://127.0.0.1:7890" spellCheck={false} autoComplete="off" />
              </label>
              <button className="wide-secondary" onClick={() => void saveAndTestPolymarketProxy()} disabled={busy}><Network />保存并测试公开行情</button>
              <div className="browser-status-detail"><span>NET</span><p>{snapshot.connectionDetails.polymarket}</p></div>
              <div className="browser-status-detail"><span>价格源</span><p>当前套利判断直接比较MEXC与Polymarket官方盘口，不需要Chainlink密钥。Chainlink只适合以后作为结算参考价和偏差预警，不作为下单前置条件。</p></div>
            </section>
            <section className="settings-section credential-section">
              <div className="settings-title-row"><h3>Polymarket 交易身份</h3><span className={polymarketCredentials?.configured ? 'ready-text' : ''}>{polymarketCredentials?.configured ? '已加密配置' : '未配置'}</span></div>
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
            </section>
            <section className="settings-section danger-zone">
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
              <div><ShieldAlert /><div><h3>Polymarket真实FOK</h3><p>MEXC成交确认后按实际数量立即对冲；必须先通过不下单验证。</p></div></div>
              <button className={`automation-toggle ${snapshot.settings.polymarketLiveEnabled ? 'enabled' : ''}`} onClick={() => void togglePolymarketLive()}>
                {snapshot.settings.polymarketLiveEnabled ? <Check /> : <LockKeyhole />}
                {snapshot.settings.polymarketLiveEnabled ? '真实对冲已启用 · 点击关闭' : '验证后启用真实对冲'}
              </button>
            </section>
          </aside>
        </div>
      )}

      {message && <div className="toast" role="status"><AlertTriangle aria-hidden="true" /><span>{message}</span><button onClick={() => setMessage(undefined)} aria-label="关闭提示"><X /></button></div>}
    </div>
  )
}

function Direction({ direction }: { direction: Direction }): JSX.Element {
  return <span className={`direction ${direction.toLowerCase()}`}>{direction === 'UP' ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}{directionLabel(direction)}</span>
}

function Row({ label, value, emphasized, positive }: { label: string; value: string; emphasized?: boolean; positive?: boolean }): JSX.Element {
  return <div className={`breakdown-row ${emphasized ? 'emphasized' : ''} ${positive ? 'positive' : ''}`}><span>{label}</span><strong>{value}</strong></div>
}

function ExecutionBar({ state, quantity, error }: { state: ExecutionState; quantity: string; error?: string }): JSX.Element {
  const danger = state === 'RECOVERY_REQUIRED'
  const done = state === 'HEDGED'
  return <div className={`execution-bar ${danger ? 'danger' : done ? 'done' : ''}`}>
    <div className="execution-pulse">{done ? <Check /> : danger ? <AlertTriangle /> : <LoaderCircle className="spin" />}</div>
    <div className="execution-summary"><span>当前执行组 · {quantity}份</span><strong>{STATE_LABELS[state]}</strong>{error && <small title={error}>{error}</small>}</div>
    <div className="execution-progress"><span /></div>
  </div>
}

export default App
