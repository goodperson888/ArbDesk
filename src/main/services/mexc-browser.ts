import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { BrowserWindow, ipcMain, session } from 'electron'
import type { Browser, CDPSession, Locator, Page } from 'playwright-core'
import type {
  Direction,
  MexcAccountState,
  MexcBrowserMode,
  MexcBrowserStatus,
  MexcCalibrationKind,
  MexcOrderCapture
} from '../../shared/types'
import type { MarketDuration, OrderBookLevel } from '../../shared/types'
import {
  updateMexcFeeCalibrationCache,
  type CachedMexcFeeCalibration,
  type MexcAssetLogRow
} from '../domain/mexc-fee'
import { parseLatestMexcSettlement, parseMexcFill, type MexcFillLogRow, type MexcFillMatch } from '../domain/mexc-fill'
import { decodeMexcPredictionFrame } from '../domain/mexc-prediction-frame'

const MEXC_URL = 'https://prediction.mexc.com/prediction-markets/all'
const HUBSTUDIO_API = 'http://127.0.0.1:6873'
const MEXC_USDT_COIN_ID = '128f589271cb4951b03e71e6323eb7be'
const MEXC_EVENT_CACHE_MS = 10_000
const MEXC_FEE_CACHE_MS = 60_000
const MEXC_REST_FALLBACK_MS = 10_000
const MEXC_PREFLIGHT_QUOTE_MS = 500

interface MexcSelectors {
  amountInput?: string
  upButton?: string
  downButton?: string
  submitButton?: string
}

interface PrepareOrderRequest {
  direction: Direction
  amount: string
  allowSubmit: boolean
  durationMinutes?: MarketDuration
  startTime?: number
}

export interface CloseMexcPositionRequest {
  eventId: string
  symbolId: string
  direction: Direction
  quantity: string
  durationMinutes: MarketDuration
  startTime: number
  allowSubmit: boolean
}

interface AutomationResult {
  ok: boolean
  message: string
  matched: Record<string, boolean>
  orderAccepted?: boolean
  submittedAt?: number
  submissionUncertain?: boolean
}

interface HubstudioStartResponse {
  code: number
  msg?: string
  data?: { debuggingPort?: number }
}

interface HubstudioStatusResponse {
  code: number
  data?: { containers?: Array<{ containerCode?: string; status?: number; pid?: number }> }
}

interface MexcRawOutcome {
  si?: string
  rn?: string
  ap?: string
}

interface MexcRawEvent {
  id?: number | string
  mn?: string
  en?: string
  st?: number
  et?: number
  s?: number
  sp?: number
  bsp?: string
  ers?: MexcRawOutcome[]
}

interface MexcRawDepth {
  data?: {
    asks?: Array<{ p?: string; q?: string }>
  }
  timestamp?: number
  receivedAt?: number
  version?: string
}

interface MexcRawIndexRange {
  data?: Array<{ p?: string; ts?: number }>
  timestamp?: number
}

export interface MexcOutcomeQuote {
  direction: Direction
  symbolId: string
  bestAsk: string
  askSize: string
  levels: OrderBookLevel[]
  receivedAt: number
}

export interface MexcWindowQuote {
  eventId: string
  durationMinutes: MarketDuration
  startTime: number
  endTime: number
  baselinePrice: string
  indexPrice?: string
  indexReceivedAt?: number
  feeRate: string
  feeRateSource: 'HISTORY' | 'UNAVAILABLE'
  outcomes: Record<Direction, MexcOutcomeQuote>
}

type SelectorStore = Record<MexcBrowserMode, MexcSelectors>

const emptySelectors = (): SelectorStore => ({ EMBEDDED: {}, HUBSTUDIO: {} })

export class MexcBrowserManager {
  private embeddedWindow?: BrowserWindow
  private hubstudioBrowser?: Browser
  private hubstudioPage?: Page
  private hubstudioDebuggingPort?: number
  private hubstudioConnectedContainerCode?: string
  private hubstudioMonitor?: NodeJS.Timeout
  private hubstudioNetworkSession?: CDPSession
  private hubstudioSocketUrls = new Map<string, string>()
  private hubstudioPredictionConfirmedAt = 0
  private hubstudioPredictionSubscriptionKey = ''
  private lastHubstudioAccountRefreshAt = 0
  private hubstudioAccountRefreshing = false
  private latestResult?: AutomationResult
  private calibrationResolver?: (result: { kind: MexcCalibrationKind; selector: string }) => void
  private selectorStore: SelectorStore = emptySelectors()
  private mode: MexcBrowserMode = 'EMBEDDED'
  private elementMode: 'AUTO' | 'MANUAL' = 'AUTO'
  private hubstudioContainerCode = ''
  private startupOpenAttempted = false
  private embeddedAuthenticated = false
  private hubstudioAuthenticated = false
  private latestAccountState?: MexcAccountState
  private latestOrderCapture?: MexcOrderCapture
  private interceptedDepth = new Map<string, MexcRawDepth>()
  private interceptedEvents?: { receivedAt: number; events: MexcRawEvent[] }
  private latestMexcIndex?: { price: string; receivedAt: number }
  private cachedFeeCalibration?: CachedMexcFeeCalibration
  private latestWindows: MexcWindowQuote[] = []
  private marketDataListeners = new Set<() => void>()
  private instrumentedHubstudioPages = new WeakSet<Page>()
  private discoveredPositionFields = new Set<string>()
  private discoveredOpenOrderFields = new Set<string>()
  private discoveredHistoryFields = new Set<string>()

  constructor(private readonly configPath: string) {
    this.selectorStore = this.loadSelectors()
    ipcMain.on('mexc:automation-result', (event, result: AutomationResult) => {
      if (event.sender !== this.embeddedWindow?.webContents) return
      this.latestResult = result
    })
    ipcMain.on('mexc:calibration-result', (event, result: { kind: MexcCalibrationKind; selector: string }) => {
      if (event.sender !== this.embeddedWindow?.webContents) return
      this.calibrationResolver?.(result)
    })
  }

  configure(config: { mode: MexcBrowserMode; hubstudioContainerCode: string; elementMode: 'AUTO' | 'MANUAL' }): void {
    const nextContainerCode = config.hubstudioContainerCode.trim()
    if (this.mode !== config.mode || this.hubstudioContainerCode !== nextContainerCode) {
      this.latestAccountState = undefined
      this.latestOrderCapture = undefined
    }
    this.mode = config.mode
    this.hubstudioContainerCode = nextContainerCode
    this.elementMode = config.elementMode
  }

  onMarketData(listener: () => void): () => void {
    this.marketDataListeners.add(listener)
    return () => this.marketDataListeners.delete(listener)
  }

  getLatestWindows(): MexcWindowQuote[] {
    return this.latestWindows
  }

  getCalibration(mode = this.mode): MexcBrowserStatus['calibrated'] {
    const selectors = this.selectorStore[mode]
    return {
      amountInput: Boolean(selectors.amountInput),
      upButton: Boolean(selectors.upButton),
      downButton: Boolean(selectors.downButton),
      submitButton: Boolean(selectors.submitButton)
    }
  }

  async open(): Promise<MexcBrowserStatus> {
    this.startupOpenAttempted = true
    return this.mode === 'HUBSTUDIO' ? this.openHubstudio() : this.openEmbedded()
  }

  async prepareOrder(request: PrepareOrderRequest): Promise<AutomationResult> {
    await this.open()
    return this.mode === 'HUBSTUDIO'
      ? this.prepareHubstudioOrder(request)
      : this.prepareEmbeddedOrder(request)
  }

  async closePosition(request: CloseMexcPositionRequest): Promise<AutomationResult> {
    await this.open()
    if (this.mode !== 'HUBSTUDIO') {
      return { ok: false, message: 'MEXC自动卖出当前仅支持Hubstudio模式；未操作网页', matched: {} }
    }
    return await this.closeHubstudioPosition(request)
  }

  async fetchActiveBtcWindows(): Promise<MexcWindowQuote[]> {
    if (!this.getStatus().open) {
      if (this.startupOpenAttempted) throw new Error('MEXC窗口已关闭；请在设置中手动点击打开，软件不会反复拉起')
      await this.open()
    }
    const now = Date.now()
    let events = this.interceptedEvents && now - this.interceptedEvents.receivedAt <= MEXC_EVENT_CACHE_MS
      ? this.interceptedEvents.events
      : undefined
    if (!events) {
      events = await this.evaluateMexcPage(async () => {
        const response = await fetch('/api/platform/predict/market/web/event/events', {
          headers: { accept: 'application/json' }
        })
        if (!response.ok) throw new Error(`MEXC events HTTP ${response.status}`)
        const body = await response.json() as { data?: MexcRawEvent[] }
        return body.data ?? []
      })
      this.interceptedEvents = { events, receivedAt: Date.now() }
    }

    const active = events
      .filter((event) => event.s === 2 && Number(event.st) <= now && Number(event.et) > now)
      .filter((event) => event.mn === 'BTC 5min' || event.mn === 'BTC 15min')
    const selected = [300, 900]
      .map((seconds) => active.find((event) => event.sp === seconds))
      .filter((event): event is MexcRawEvent => Boolean(event))
    const symbolIds = [...new Set(selected.flatMap((event) => event.ers ?? []).map((outcome) => String(outcome.si ?? '')).filter(Boolean))]
    const effectiveDepthReceivedAt = (symbolId: string): number => Math.max(
      Number(this.interceptedDepth.get(symbolId)?.receivedAt) || 0,
      this.hubstudioPredictionSubscriptionKey.includes(symbolId) ? this.hubstudioPredictionConfirmedAt : 0
    )
    const missingDepthSymbolIds = symbolIds.filter((symbolId) =>
      !this.interceptedDepth.get(symbolId)?.data?.asks?.length ||
      now - effectiveDepthReceivedAt(symbolId) > MEXC_REST_FALLBACK_MS
    )
    const needIndex = !this.latestMexcIndex || now - this.latestMexcIndex.receivedAt > MEXC_REST_FALLBACK_MS
    const needFee = !this.cachedFeeCalibration || now - this.cachedFeeCalibration.receivedAt > MEXC_FEE_CACHE_MS

    if (missingDepthSymbolIds.length > 0 || needIndex || needFee) {
      const fallback = await this.evaluateMexcPage(async (request: {
        symbolIds: string[]
        needIndex: boolean
        needFee: boolean
        now: number
      }) => {
        const [depths, indexRange, feeRows] = await Promise.all([
          Promise.all(request.symbolIds.map(async (symbolId) => {
            const response = await fetch(`/api/platform/predict/market/web/depth?symbolId=${encodeURIComponent(symbolId)}`, {
              headers: { accept: 'application/json' }
            })
            if (!response.ok) throw new Error(`MEXC depth HTTP ${response.status}`)
            return { symbolId, depth: await response.json() as MexcRawDepth, receivedAt: Date.now() }
          })),
          request.needIndex
            ? fetch(`/api/platform/predict/market/web/event/index/price/range?indexName=BTC&start=${request.now - 30_000}&end=${request.now}`, {
                headers: { accept: 'application/json' }
              }).then(async (response) => response.ok ? await response.json() as MexcRawIndexRange : { data: [] })
            : Promise.resolve(undefined),
          request.needFee
            ? fetch('/api/platform/predict/asset/query/web/summaryLog?comboExclude=false&pageNum=1&pageSize=100', {
                headers: { accept: 'application/json' }, credentials: 'include'
              }).then(async (response) => {
                if (!response.ok) return [] as MexcAssetLogRow[]
                const body = await response.json() as { data?: { result?: MexcAssetLogRow[] } }
                return body.data?.result ?? []
              }).catch(() => [] as MexcAssetLogRow[])
            : Promise.resolve(undefined)
        ])
        return { depths, indexRange, feeRows }
      }, { symbolIds: missingDepthSymbolIds, needIndex, needFee, now })

      for (const { symbolId, depth, receivedAt } of fallback.depths) {
        this.interceptedDepth.set(symbolId, { ...depth, receivedAt })
      }
      const latestIndex = (fallback.indexRange?.data ?? [])
        .filter((point) => Number(point.p) > 0 && Number(point.ts) > 0)
        .sort((left, right) => Number(right.ts) - Number(left.ts))[0]
      if (latestIndex?.p) this.latestMexcIndex = { price: String(latestIndex.p), receivedAt: Date.now() }
      if (fallback.feeRows) {
        this.applyFeeCalibration(fallback.feeRows, Date.now())
      }
    }

    const feeCalibration = this.cachedFeeCalibration ?? { feeRate: '0', source: 'UNAVAILABLE' as const, receivedAt: 0 }
    const windows: MexcWindowQuote[] = selected.map((event) => {
      const parsed = new Map<Direction, MexcOutcomeQuote>()
      for (const outcome of event.ers ?? []) {
        const normalized = String(outcome.rn ?? '').toUpperCase()
        if (normalized !== 'UP' && normalized !== 'DOWN') continue
        const symbolId = String(outcome.si ?? '')
        const effectiveDepth = this.interceptedDepth.get(symbolId)
        if (!effectiveDepth) continue
        const levels = (effectiveDepth.data?.asks ?? [])
          .map((level) => ({ price: String(level.p ?? ''), size: String(level.q ?? '') }))
          .filter((level) => Number(level.price) > 0 && Number(level.size) > 0)
          .sort((left, right) => Number(left.price) - Number(right.price))
        const best = levels[0]
        if (!best) continue
        parsed.set(normalized, {
          direction: normalized,
          symbolId,
          bestAsk: best.price,
          askSize: best.size,
          levels,
          receivedAt: Math.max(Number(effectiveDepth.receivedAt) || 0, effectiveDepthReceivedAt(symbolId))
        })
      }
      const up = parsed.get('UP')
      const down = parsed.get('DOWN')
      if (!up || !down) throw new Error(`MEXC 事件 ${event.id} 的 UP/DOWN 盘口不完整`)
      return {
        eventId: String(event.id),
        durationMinutes: Number(event.sp) === 300 ? 5 as const : 15 as const,
        startTime: Number(event.st),
        endTime: Number(event.et),
        baselinePrice: String(event.bsp ?? ''),
        indexPrice: this.latestMexcIndex?.price,
        indexReceivedAt: this.latestMexcIndex?.receivedAt,
        feeRate: feeCalibration.feeRate,
        feeRateSource: feeCalibration.source,
        outcomes: { UP: up, DOWN: down }
      }
    })
    this.latestWindows = windows
    if (this.mode === 'HUBSTUDIO') void this.syncHubstudioPredictionSubscriptions().catch(() => undefined)
    return windows
  }

  async confirmMarketQuote(symbolId: string, maximumAgeMs = MEXC_PREFLIGHT_QUOTE_MS): Promise<void> {
    const now = Date.now()
    const currentDepth = this.interceptedDepth.get(symbolId)
    // Opening checks must use a symbol-specific quote timestamp. General socket
    // activity can keep an unchanged market fresh in the scanner, but it must
    // not suppress the final selected-book verification.
    const depthReceivedAt = Number(currentDepth?.receivedAt) || 0
    const needDepth = !currentDepth?.data?.asks?.length || now - depthReceivedAt > maximumAgeMs
    const needIndex = !this.latestMexcIndex || now - this.latestMexcIndex.receivedAt > maximumAgeMs
    const needFee = !this.cachedFeeCalibration || now - this.cachedFeeCalibration.receivedAt > MEXC_FEE_CACHE_MS
    if (!needDepth && !needIndex && !needFee) return

    const result = await this.evaluateMexcPage(async (request: {
      symbolId: string
      needDepth: boolean
      needIndex: boolean
      needFee: boolean
      now: number
    }) => {
      const [depth, indexRange, feeRows] = await Promise.all([
        request.needDepth
          ? fetch(`/api/platform/predict/market/web/depth?symbolId=${encodeURIComponent(request.symbolId)}`, {
              headers: { accept: 'application/json' }
            }).then(async (response) => {
              if (!response.ok) throw new Error(`MEXC depth HTTP ${response.status}`)
              return await response.json() as MexcRawDepth
            })
          : Promise.resolve(undefined),
        request.needIndex
          ? fetch(`/api/platform/predict/market/web/event/index/price/range?indexName=BTC&start=${request.now - 30_000}&end=${request.now}`, {
              headers: { accept: 'application/json' }
            }).then(async (response) => response.ok ? await response.json() as MexcRawIndexRange : { data: [] })
          : Promise.resolve(undefined),
        request.needFee
          ? fetch('/api/platform/predict/asset/query/web/summaryLog?comboExclude=false&pageNum=1&pageSize=100', {
              headers: { accept: 'application/json' }, credentials: 'include'
            }).then(async (response) => {
              if (!response.ok) return [] as MexcAssetLogRow[]
              const body = await response.json() as { data?: { result?: MexcAssetLogRow[] } }
              return body.data?.result ?? []
            }).catch(() => [] as MexcAssetLogRow[])
          : Promise.resolve(undefined)
      ])
      return { depth, indexRange, feeRows, receivedAt: Date.now() }
    }, { symbolId, needDepth, needIndex, needFee, now })

    if (result.depth) {
      const normalized = { ...result.depth, receivedAt: result.receivedAt }
      this.interceptedDepth.set(symbolId, normalized)
      this.applyInterceptedDepth(symbolId, normalized)
    }
    const latestIndex = (result.indexRange?.data ?? [])
      .filter((point) => Number(point.p) > 0 && Number(point.ts) > 0)
      .sort((left, right) => Number(right.ts) - Number(left.ts))[0]
    if (latestIndex?.p) this.applyMexcIndex(String(latestIndex.p), result.receivedAt)
    if (result.feeRows) this.applyFeeCalibration(result.feeRows, result.receivedAt)
  }

  getStatus(): MexcBrowserStatus {
    const hubstudioOpen = Boolean(
      this.hubstudioPage &&
      !this.hubstudioPage.isClosed() &&
      this.hubstudioConnectedContainerCode === this.hubstudioContainerCode
    )
    const embeddedOpen = Boolean(this.embeddedWindow && !this.embeddedWindow.isDestroyed())
    const open = this.mode === 'HUBSTUDIO' ? hubstudioOpen : embeddedOpen
    const url = this.mode === 'HUBSTUDIO'
      ? (hubstudioOpen ? this.hubstudioPage?.url() : undefined)
      : (embeddedOpen ? this.embeddedWindow?.webContents.getURL() : undefined)
    const source = this.mode === 'HUBSTUDIO' ? 'Hubstudio' : '内嵌'
    return this.status(`${source} MEXC窗口${open ? '可用' : '未打开'}`, open, url)
  }

  async refreshAccountState(): Promise<MexcBrowserStatus> {
    const current = this.getStatus()
    if (!current.open) throw new Error('MEXC窗口尚未连接')
    await this.refreshAuthentication()
    if (!this.getStatus().authenticated) {
      this.latestAccountState = {
        checkedAt: Date.now(),
        reachable: true,
        authenticated: false,
        positionCount: 0,
        openOrderCount: 0,
        historyCount: 0,
        positionFields: [],
        openOrderFields: [],
        historyFields: [],
        fillReadbackReady: false,
        message: 'MEXC页面可访问，但尚未检测到登录态'
      }
      return this.getStatus()
    }

    try {
      const payload = await this.evaluateMexcPage(async () => {
        const getJson = async (path: string): Promise<Record<string, unknown>> => {
          const response = await fetch(path, { headers: { accept: 'application/json' }, credentials: 'include' })
          if (!response.ok) throw new Error(`${path} HTTP ${response.status}`)
          return await response.json() as Record<string, unknown>
        }
        const [positions, orders, history, balances] = await Promise.all([
          getJson('/api/platform/predict/asset/query/web/positions?mode=MIX'),
          getJson('/api/platform/predict/order/query/web/current/orders?orderTypes=1&states=0,1,3&pageNum=1&pageSize=100'),
          getJson('/api/platform/predict/asset/query/web/summaryLog?comboExclude=false&pageNum=1&pageSize=100'),
          getJson('/api/platform/predict/asset/query/web/balances?coinIds=128f589271cb4951b03e71e6323eb7be')
        ])
        return { positions, orders, history, balances }
      })

      const positionData = Array.isArray(payload.positions.data) ? payload.positions.data as Record<string, unknown>[] : []
      const orderData = payload.orders.data && typeof payload.orders.data === 'object'
        ? payload.orders.data as Record<string, unknown>
        : {}
      const openOrders = Array.isArray(orderData.resultList) ? orderData.resultList as Record<string, unknown>[] : []
      const historyData = payload.history.data && typeof payload.history.data === 'object'
        ? payload.history.data as Record<string, unknown>
        : {}
      const historyRows = Array.isArray(historyData.result) ? historyData.result as Record<string, unknown>[] : []
      this.applyFeeCalibration(historyRows as MexcAssetLogRow[], Date.now())
      const balanceRows = Array.isArray(payload.balances.data) ? payload.balances.data as Record<string, unknown>[] : []
      const usdtBalance = balanceRows.find((row) => row.coinId === MEXC_USDT_COIN_ID)
      const totalHistory = Number(historyData.total)
      const fields = (rows: Record<string, unknown>[]): string[] => Object.keys(rows[0] ?? {}).sort()
      fields(positionData).forEach((field) => this.discoveredPositionFields.add(field))
      fields(openOrders).forEach((field) => this.discoveredOpenOrderFields.add(field))
      fields(historyRows).forEach((field) => this.discoveredHistoryFields.add(field))
      const positionFields = [...this.discoveredPositionFields].sort()
      const openOrderFields = [...this.discoveredOpenOrderFields].sort()
      const historyFields = [...this.discoveredHistoryFields].sort()
      const latestFill = parseMexcFill(historyRows as MexcFillLogRow[], {
        eventId: String(historyRows.find((row) => Number(row.bt) === 107)?.ei ?? ''),
        direction: String(historyRows.find((row) => Number(row.bt) === 107)?.rft ?? '').toUpperCase() as Direction,
        submittedAfter: 0
      })
      const latestSettlement = parseLatestMexcSettlement(historyRows as Array<MexcFillLogRow & { ta?: number }>)
      // Market orders normally fill immediately and therefore never appear in
      // the open-orders response. A non-empty trade history schema is enough.
      const fillReadbackReady = historyFields.includes('bt') && historyFields.includes('sif') && historyFields.includes('tn')
      const missing = [
        historyFields.length === 0 ? '非空成交历史样本' : ''
      ].filter(Boolean)
      this.latestAccountState = {
        checkedAt: Date.now(),
        reachable: true,
        authenticated: true,
        availableUsdt: typeof usdtBalance?.available === 'string' ? usdtBalance.available : undefined,
        positionCount: positionData.length,
        openOrderCount: Number(orderData.totalResult) || openOrders.length,
        historyCount: Number.isFinite(totalHistory) ? totalHistory : historyRows.length,
        positionFields,
        openOrderFields,
        historyFields,
        fillReadbackReady,
        latestFill,
        latestSettlement,
        message: missing.length > 0
          ? `账户接口读取正常；还需${missing.join('、')}完成自动成交识别`
          : '账户接口与成交历史字段已读取；市价单无需活动委托样本'
      }
    } catch (error) {
      this.latestAccountState = {
        checkedAt: Date.now(),
        reachable: false,
        authenticated: this.getStatus().authenticated,
        positionCount: 0,
        openOrderCount: 0,
        historyCount: 0,
        positionFields: [],
        openOrderFields: [],
        historyFields: [],
        fillReadbackReady: false,
        message: `MEXC账户接口读取失败：${error instanceof Error ? error.message : String(error)}`
      }
    }
    return this.getStatus()
  }

  async waitForFill(match: MexcFillMatch, timeoutMs = 90_000): Promise<import('../../shared/types').Fill | undefined> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const rows = await this.evaluateMexcPage(async () => {
        const response = await fetch('/api/platform/predict/asset/query/web/summaryLog?comboExclude=false&pageNum=1&pageSize=50', {
          headers: { accept: 'application/json' }, credentials: 'include'
        })
        if (!response.ok) throw new Error(`MEXC history HTTP ${response.status}`)
        const body = await response.json() as { data?: { result?: MexcFillLogRow[] } }
        return body.data?.result ?? []
      })
      const fill = parseMexcFill(rows, match)
      if (fill) return fill
      await new Promise((resolve) => setTimeout(resolve, 750))
    }
    return undefined
  }

  async calibrate(kind: MexcCalibrationKind): Promise<MexcBrowserStatus> {
    await this.open()
    return this.mode === 'HUBSTUDIO' ? this.calibrateHubstudio(kind) : this.calibrateEmbedded(kind)
  }

  private async openEmbedded(): Promise<MexcBrowserStatus> {
    if (this.embeddedWindow && !this.embeddedWindow.isDestroyed()) {
      this.embeddedWindow.show()
      this.embeddedWindow.focus()
      await this.refreshEmbeddedAuthentication()
      return this.status('内嵌MEXC窗口已打开', true, this.embeddedWindow.webContents.getURL())
    }

    this.embeddedWindow = new BrowserWindow({
      width: 1240,
      height: 860,
      title: 'MEXC — ArbDesk 内嵌监督窗口',
      backgroundColor: '#020617',
      webPreferences: {
        preload: join(__dirname, '../preload/mexc.js'),
        partition: 'persist:mexc-arbdesk',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    this.embeddedWindow.on('closed', () => {
      this.embeddedWindow = undefined
      this.embeddedAuthenticated = false
    })
    this.embeddedWindow.webContents.on('did-finish-load', () => void this.refreshEmbeddedAuthentication())
    this.embeddedWindow.webContents.on('did-navigate', () => void this.refreshEmbeddedAuthentication())
    this.embeddedWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void this.embeddedWindow?.loadURL(url)
      return { action: 'deny' }
    })
    await this.embeddedWindow.loadURL(MEXC_URL)
    await this.refreshEmbeddedAuthentication()
    return this.status(
      '请在内嵌窗口中自行登录MEXC。应用不会保存密码。',
      true,
      this.embeddedWindow.webContents.getURL()
    )
  }

  private async openHubstudio(): Promise<MexcBrowserStatus> {
    if (!this.hubstudioContainerCode) throw new Error('请先在设置中填写Hubstudio环境ID')
    if (this.hubstudioPage && !this.hubstudioPage.isClosed()) {
      if (this.hubstudioConnectedContainerCode !== this.hubstudioContainerCode) {
        throw new Error(`当前仍连接Hubstudio环境 ${this.hubstudioConnectedContainerCode ?? '未知'}；请先关闭该环境或重启ArbDesk，再切换环境ID。`)
      }
      await this.hubstudioPage.bringToFront()
      await this.refreshHubstudioAuthentication()
      return this.status('Hubstudio MEXC窗口已连接', true, this.hubstudioPage.url())
    }
    if (this.hubstudioBrowser?.isConnected() && this.hubstudioConnectedContainerCode === this.hubstudioContainerCode) {
      const page = await this.bindHubstudioPage()
      return this.status('Hubstudio MEXC标签页已恢复', true, page.url())
    }

    const startResult = await this.callHubstudio<HubstudioStartResponse>('/api/v1/browser/start', {
      containerCode: this.hubstudioContainerCode,
      isHeadless: false,
      isWebDriverReadOnlyMode: false,
      containerTabs: [MEXC_URL]
    })
    let debuggingPort = Number(startResult.data?.debuggingPort)
    if (startResult.code !== 0) {
      if (startResult.code === -10013) debuggingPort = await this.resolveRunningHubstudioDebuggingPort()
      else {
      throw new Error(`Hubstudio环境启动失败（${startResult.code}）：${startResult.msg ?? '未知错误'}`)
      }
    }
    if (!Number.isInteger(debuggingPort) || debuggingPort <= 0) {
      throw new Error('Hubstudio环境已运行，但未能识别调试端口；请关闭该环境后再从ArbDesk打开')
    }

    const { chromium } = await import('playwright-core')
    this.hubstudioBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`)
    this.hubstudioDebuggingPort = debuggingPort
    this.hubstudioConnectedContainerCode = this.hubstudioContainerCode
    this.hubstudioBrowser.on('disconnected', () => this.clearHubstudioConnection())
    const page = await this.bindHubstudioPage()
    return this.status('Hubstudio环境已连接；请在该窗口中登录MEXC。', true, page.url())
  }

  private async bindHubstudioPage(): Promise<Page> {
    const context = this.hubstudioBrowser?.contexts()[0]
    if (!context) throw new Error('无法取得Hubstudio浏览器上下文')
    const pages = context.pages()
    const page = pages.find((candidate) => candidate.url().includes('prediction.mexc.com'))
      ?? pages.find((candidate) => candidate.url().includes('mexc.com'))
      ?? await context.newPage()
    if (!page.url().includes('prediction.mexc.com')) await page.goto(MEXC_URL)
    this.hubstudioPage = page
    this.instrumentHubstudioPage(page)
    await this.startHubstudioWebSocketMonitoring(page)
    page.on('close', () => {
      if (this.hubstudioPage !== page) return
      this.hubstudioPage = undefined
      this.hubstudioAuthenticated = false
    })
    page.on('domcontentloaded', () => {
      void this.refreshHubstudioAuthentication()
      void this.syncHubstudioPredictionSubscriptions().catch(() => undefined)
    })
    await page.bringToFront()
    this.startHubstudioMonitoring()
    await this.refreshHubstudioAuthentication()
    await this.refreshAccountState()
    this.lastHubstudioAccountRefreshAt = Date.now()
    return page
  }

  private async evaluateMexcPage<T>(fn: () => Promise<T>): Promise<T>
  private async evaluateMexcPage<T, Argument>(fn: (argument: Argument) => Promise<T>, argument: Argument): Promise<T>
  private async evaluateMexcPage<T, Argument>(
    fn: (() => Promise<T>) | ((argument: Argument) => Promise<T>),
    argument?: Argument
  ): Promise<T> {
    if (this.mode === 'HUBSTUDIO') {
      const page = this.hubstudioPage
      if (!page || page.isClosed()) throw new Error('Hubstudio MEXC页面不可用')
      return await page.evaluate(fn as never, argument as never) as T
    }
    const window = this.embeddedWindow
    if (!window || window.isDestroyed()) throw new Error('内嵌MEXC页面不可用')
    return await window.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(argument)})`)
  }

  private instrumentHubstudioPage(page: Page): void {
    if (this.instrumentedHubstudioPages.has(page)) return
    this.instrumentedHubstudioPages.add(page)
    const isOrderEndpoint = (url: string): boolean => /\/api\/platform\/predict\/orderCenter\/web\/order\/(?:place\/(?:market|limit)|cancel)/.test(url)
    const objectFields = (value: unknown): string[] => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return []
      const record = value as Record<string, unknown>
      return Object.entries(record).flatMap(([key, nested]) => {
        if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return [key]
        return [key, ...Object.keys(nested as Record<string, unknown>).map((child) => `${key}.${child}`)]
      }).sort()
    }
    page.on('request', (request) => {
      if (!isOrderEndpoint(request.url())) return
      let body: unknown
      try {
        body = request.postDataJSON()
      } catch {
        body = undefined
      }
      this.latestOrderCapture = {
        capturedAt: Date.now(),
        endpoint: new URL(request.url()).pathname,
        method: request.method(),
        requestFields: objectFields(body),
        responseFields: [],
        message: '已捕获MEXC订单请求字段，等待响应'
      }
    })
    page.on('response', (response) => {
      const responseUrl = response.url()
      if (/\/api\/platform\/predict\/market\/web\/event\/events(?:\?|$)/.test(responseUrl)) {
        void response.json().then((body: { data?: MexcRawEvent[] }) => {
          this.interceptedEvents = { events: body.data ?? [], receivedAt: Date.now() }
        }).catch(() => undefined)
      }
      if (/\/api\/platform\/predict\/market\/web\/depth/.test(responseUrl)) {
        void response.json().then((body: MexcRawDepth) => {
          const symbolId = new URL(responseUrl).searchParams.get('symbolId') ?? ''
          if (!symbolId) return
          const normalizedBody = { ...body, timestamp: Number(body.timestamp) || Date.now(), receivedAt: Date.now() }
          this.interceptedDepth.set(symbolId, normalizedBody)
          this.applyInterceptedDepth(symbolId, normalizedBody)
        }).catch(() => undefined)
      }
      if (/\/api\/platform\/predict\/market\/web\/event\/index\/price\/range/.test(responseUrl)) {
        void response.json().then((body: MexcRawIndexRange) => {
          const latest = (body.data ?? [])
            .filter((point) => Number(point.p) > 0 && Number(point.ts) > 0)
            .sort((left, right) => Number(right.ts) - Number(left.ts))[0]
          if (!latest?.p) return
          this.applyMexcIndex(String(latest.p), Date.now())
        }).catch(() => undefined)
      }
      if (/\/api\/platform\/predict\/asset\/query\/web\/summaryLog/.test(responseUrl)) {
        const query = new URL(responseUrl).searchParams
        if (Number(query.get('pageNum') ?? '1') !== 1 || Number(query.get('pageSize') ?? '0') < 100) return
        void response.json().then((body: { data?: { result?: MexcAssetLogRow[] } }) => {
          this.applyFeeCalibration(body.data?.result ?? [], Date.now())
        }).catch(() => undefined)
      }
      if (!isOrderEndpoint(responseUrl)) return
      void response.json().then((body: unknown) => {
        const previous = this.latestOrderCapture
        this.latestOrderCapture = {
          capturedAt: Date.now(),
          endpoint: new URL(response.url()).pathname,
          method: previous?.method ?? 'UNKNOWN',
          requestFields: previous?.requestFields ?? [],
          responseStatus: response.status(),
          responseFields: objectFields(body),
          message: `已捕获MEXC订单响应结构（HTTP ${response.status()}）`
        }
      }).catch(() => {
        if (this.latestOrderCapture) {
          this.latestOrderCapture.responseStatus = response.status()
          this.latestOrderCapture.message = `MEXC订单响应不是JSON（HTTP ${response.status()}）`
        }
      })
    })
  }

  private async startHubstudioWebSocketMonitoring(page: Page): Promise<void> {
    if (this.hubstudioNetworkSession) await this.hubstudioNetworkSession.detach().catch(() => undefined)
    this.hubstudioSocketUrls.clear()
    const networkSession = await page.context().newCDPSession(page)
    this.hubstudioNetworkSession = networkSession
    await networkSession.send('Network.enable')
    networkSession.on('Network.webSocketCreated', (event: { requestId: string; url: string }) => {
      this.hubstudioSocketUrls.set(event.requestId, event.url)
    })
    networkSession.on('Network.webSocketClosed', (event: { requestId: string }) => {
      this.hubstudioSocketUrls.delete(event.requestId)
    })
    networkSession.on('Network.webSocketFrameReceived', (event: {
      requestId: string
      response: { opcode: number; payloadData: string }
    }) => {
      const socketUrl = this.hubstudioSocketUrls.get(event.requestId)
      const knownPredictionSocket = socketUrl?.includes('prediction.mexc.com/predict/ws') ?? false
      if (socketUrl && !knownPredictionSocket) return
      if (knownPredictionSocket) this.confirmMexcPredictionFreshness(Date.now())
      if (event.response.opcode !== 2) return
      const decoded = decodeMexcPredictionFrame(Buffer.from(event.response.payloadData, 'base64'))
      if (!decoded) return
      const receivedAt = Date.now()
      this.confirmMexcPredictionFreshness(receivedAt)
      if (decoded.depth) {
        const previous = this.interceptedDepth.get(decoded.depth.symbolId)
        const previousVersion = previous?.version
        const nextVersion = decoded.depth.version
        if (previousVersion && nextVersion && /^\d+$/.test(previousVersion) && /^\d+$/.test(nextVersion)) {
          if (BigInt(previousVersion) > BigInt(nextVersion)) return
        }
        const depth: MexcRawDepth = {
          data: { asks: decoded.depth.asks.map((level) => ({ p: level.price, q: level.size })) },
          timestamp: receivedAt,
          receivedAt,
          version: nextVersion
        }
        this.interceptedDepth.set(decoded.depth.symbolId, depth)
        this.applyInterceptedDepth(decoded.depth.symbolId, depth)
      }
      if (decoded.index) this.applyMexcIndex(decoded.index.price, receivedAt)
    })
  }

  private async syncHubstudioPredictionSubscriptions(): Promise<void> {
    const page = this.hubstudioPage
    if (!page || page.isClosed() || this.latestWindows.length === 0) return
    const channels = [
      ...new Set(this.latestWindows.flatMap((window) => [
        `predict@public.depth.scale.pb@${window.outcomes.UP.symbolId}@0.01@30`,
        `predict@public.depth.scale.pb@${window.outcomes.DOWN.symbolId}@0.01@30`,
        `predict@public.index.realtime.period.pb@BTC@${window.durationMinutes * 60}`
      ]))
    ].sort()
    const key = channels.join('|')
    const active = await page.evaluate((expectedKey: string) => {
      type FeedState = { key: string; isActive: () => boolean; renew: () => void }
      const root = window as typeof window & { __arbDeskPredictionFeed?: FeedState }
      const matches = root.__arbDeskPredictionFeed?.key === expectedKey && root.__arbDeskPredictionFeed.isActive()
      if (matches) root.__arbDeskPredictionFeed?.renew()
      return matches
    }, key).catch(() => false)
    if (active) {
      this.hubstudioPredictionSubscriptionKey = key
      return
    }

    await page.evaluate(({ subscriptionKey, subscriptionChannels }) => {
      type FeedState = { key: string; stop: () => void; isActive: () => boolean; renew: () => void }
      const root = window as typeof window & { __arbDeskPredictionFeed?: FeedState }
      root.__arbDeskPredictionFeed?.stop()
      let socket: WebSocket | undefined
      let heartbeat = 0
      let reconnect = 0
      let leaseMonitor = 0
      let lastLeaseAt = Date.now()
      let stopped = false
      const clearTimers = (): void => {
        if (heartbeat) window.clearInterval(heartbeat)
        if (reconnect) window.clearTimeout(reconnect)
        if (leaseMonitor) window.clearInterval(leaseMonitor)
        heartbeat = 0
        reconnect = 0
        leaseMonitor = 0
      }
      const connect = (): void => {
        if (stopped) return
        if (!leaseMonitor) {
          leaseMonitor = window.setInterval(() => {
            if (Date.now() - lastLeaseAt > 15_000) root.__arbDeskPredictionFeed?.stop()
          }, 5_000)
        }
        socket = new WebSocket('wss://prediction.mexc.com/predict/ws?platform=web')
        socket.binaryType = 'arraybuffer'
        socket.onopen = () => {
          socket?.send(JSON.stringify({ method: 'SUBSCRIPTION', params: subscriptionChannels, id: Date.now() }))
          heartbeat = window.setInterval(() => {
            if (socket?.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ method: 'PING', id: Date.now() }))
            }
          }, 3_000)
        }
        socket.onclose = () => {
          clearTimers()
          if (!stopped) reconnect = window.setTimeout(connect, 1_500)
        }
      }
      root.__arbDeskPredictionFeed = {
        key: subscriptionKey,
        isActive: () => Boolean(socket && socket.readyState <= WebSocket.OPEN),
        renew: () => { lastLeaseAt = Date.now() },
        stop: () => {
          stopped = true
          clearTimers()
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ method: 'UNSUBSCRIPTION', params: subscriptionChannels, id: Date.now() }))
          }
          socket?.close()
        }
      }
      connect()
    }, { subscriptionKey: key, subscriptionChannels: channels })
    this.hubstudioPredictionSubscriptionKey = key
  }

  private applyMexcIndex(price: string, receivedAt: number): void {
    if (!(Number(price) > 0)) return
    this.latestMexcIndex = { price, receivedAt }
    this.latestWindows = this.latestWindows.map((window) => ({
      ...window,
      indexPrice: price,
      indexReceivedAt: receivedAt
    }))
    for (const listener of this.marketDataListeners) listener()
  }

  private confirmMexcPredictionFreshness(receivedAt: number): void {
    this.hubstudioPredictionConfirmedAt = receivedAt
    let changed = false
    this.latestWindows = this.latestWindows.map((window) => ({
      ...window,
      outcomes: Object.fromEntries(Object.entries(window.outcomes).map(([direction, outcome]) => {
        if (!this.hubstudioPredictionSubscriptionKey.includes(outcome.symbolId)) return [direction, outcome]
        changed = true
        return [direction, { ...outcome, receivedAt }]
      })) as Record<Direction, MexcOutcomeQuote>
    }))
    if (changed) for (const listener of this.marketDataListeners) listener()
  }

  private applyFeeCalibration(rows: MexcAssetLogRow[], receivedAt: number): void {
    const previous = this.cachedFeeCalibration
    const calibration = updateMexcFeeCalibrationCache(previous, rows, receivedAt, MEXC_FEE_CACHE_MS)
    if (calibration === previous) return
    this.cachedFeeCalibration = calibration
    this.latestWindows = this.latestWindows.map((window) => ({
      ...window,
      feeRate: calibration.feeRate,
      feeRateSource: calibration.source
    }))
    for (const listener of this.marketDataListeners) listener()
  }

  private applyInterceptedDepth(symbolId: string, depth: MexcRawDepth): void {
    const levels = (depth.data?.asks ?? [])
      .map((level) => ({ price: String(level.p ?? ''), size: String(level.q ?? '') }))
      .filter((level) => Number(level.price) > 0 && Number(level.size) > 0)
      .sort((left, right) => Number(left.price) - Number(right.price))
    const best = levels[0]
    if (!best) return
    let changed = false
    this.latestWindows = this.latestWindows.map((window) => {
      const direction = window.outcomes.UP.symbolId === symbolId
        ? 'UP'
        : window.outcomes.DOWN.symbolId === symbolId ? 'DOWN' : undefined
      if (!direction) return window
      changed = true
      return {
        ...window,
        outcomes: {
          ...window.outcomes,
          [direction]: {
            ...window.outcomes[direction],
            bestAsk: best.price,
            askSize: best.size,
            levels,
            receivedAt: Number(depth.receivedAt) || Date.now()
          }
        }
      }
    })
    if (changed) for (const listener of this.marketDataListeners) listener()
  }

  private async resolveRunningHubstudioDebuggingPort(): Promise<number> {
    const status = await this.callHubstudio<HubstudioStatusResponse>('/api/v1/browser/all-browser-status', [this.hubstudioContainerCode])
    const container = status.data?.containers?.find((candidate) => candidate.containerCode === this.hubstudioContainerCode)
    const pid = Number(container?.pid)
    if (!Number.isInteger(pid) || pid <= 0) return 0
    let output = ''
    try {
      if (process.platform === 'win32') output = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
      else output = execFileSync('lsof', ['-Pan', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' })
    } catch {
      return 0
    }
    const ports = process.platform === 'win32'
      ? output.split('\n').filter((line) => line.trim().endsWith(String(pid))).map((line) => Number(line.match(/:(\d+)\s+LISTENING/i)?.[1]))
      : Array.from(output.matchAll(/:(\d+)\s+\(LISTEN\)/g), (match) => Number(match[1]))
    for (const port of [...new Set(ports.filter((candidate) => Number.isInteger(candidate) && candidate > 0))]) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) })
        if (response.ok && (await response.json() as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl) return port
      } catch {
        // This listener is not the Chrome DevTools endpoint.
      }
    }
    return 0
  }

  private async prepareEmbeddedOrder(request: PrepareOrderRequest): Promise<AutomationResult> {
    if (!this.embeddedWindow || this.embeddedWindow.isDestroyed()) {
      return { ok: false, message: '内嵌MEXC窗口不可用', matched: {} }
    }
    if (request.durationMinutes && request.startTime) {
      try {
        const target = await this.resolveLiveMarketTarget(request.durationMinutes, request.startTime)
        if (!this.embeddedWindow.webContents.getURL().endsWith(`/${target.eventId}`)) {
          await this.embeddedWindow.loadURL(target.url)
        }
      } catch (error) {
        return {
          ok: false,
          message: `无法切换到对应的实时盘：${error instanceof Error ? error.message : String(error)}；未填写或提交订单`,
          matched: {}
        }
      }
    }
    this.latestResult = undefined
    const useAutomaticRecognition = this.elementMode === 'AUTO'
    this.embeddedWindow.webContents.send('mexc:prepare-order', {
      ...request,
      selectors: useAutomaticRecognition ? {} : this.selectorStore.EMBEDDED,
      allowSemanticFallback: useAutomaticRecognition
    })

    const deadline = Date.now() + 1_500
    while (!this.latestResult && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return this.latestResult ?? {
      ok: false,
      message: '内嵌MEXC页面适配器未响应；已保留窗口供人工完成',
      matched: {}
    }
  }

  private async prepareHubstudioOrder(request: PrepareOrderRequest): Promise<AutomationResult> {
    const page = this.hubstudioPage
    if (!page || page.isClosed()) return { ok: false, message: 'Hubstudio MEXC页面不可用', matched: {} }
    if (!Number.isFinite(Number(request.amount)) || Number(request.amount) <= 0) {
      return { ok: false, message: 'MEXC下单金额必须是大于0的数字；未操作网页', matched: {} }
    }
    if (request.allowSubmit && Number(request.amount) < 1) {
      return { ok: false, message: `MEXC下单金额${request.amount} USDT低于当前1 USDT最小值；未点击买入`, matched: {} }
    }
    if (request.durationMinutes && request.startTime) {
      try {
        await this.ensureHubstudioLiveMarket(page, request.durationMinutes, request.startTime)
      } catch (error) {
        return {
          ok: false,
          message: `无法切换到对应的实时盘：${error instanceof Error ? error.message : String(error)}；未填写或提交订单`,
          matched: {}
        }
      }
    }
    const useAutomaticRecognition = this.elementMode === 'AUTO'
    const selectors = useAutomaticRecognition ? {} : this.selectorStore.HUBSTUDIO
    const automatic = (locators: Locator[]): Locator[] => useAutomaticRecognition ? locators : []
    const directionSelector = request.direction === 'UP' ? selectors.upButton : selectors.downButton
    let amountInput = await this.resolveHubstudioLocator(page, selectors.amountInput, automatic([
      page.locator('input[placeholder="0"]:visible').first()
    ]))
    const directionPattern = request.direction === 'UP'
      ? /^(?:涨(?:\s|\d|$)|up(?:\s|\d|$))/i
      : /^(?:跌(?:\s|\d|$)|down(?:\s|\d|$))/i
    const directionButton = await this.resolveHubstudioLocator(page, directionSelector, automatic([
      page.getByRole('button', { name: directionPattern }).first()
    ]))
    let submitButton = await this.resolveHubstudioLocator(page, selectors.submitButton, automatic([
      page.getByRole('button', { name: /^(?:买入|buy)(?:\s|$)/i }).first()
    ]))
    const matched = {
      amountInput: Boolean(amountInput),
      directionButton: Boolean(directionButton),
      submitButton: Boolean(submitButton),
      submitEnabled: false
    }
    if (!matched.amountInput || !matched.directionButton || !matched.submitButton) {
      return {
        ok: false,
        message: useAutomaticRecognition
          ? '系统未能识别完整的Hubstudio MEXC下单区；未执行任何点击，可切换到手动校准模式'
          : 'Hubstudio手动校准元素未完整匹配；未执行任何点击',
        matched
      }
    }

    try {
      await directionButton!.click()
      await page.waitForTimeout(250)

      // 方向切换可能重绘订单面板，重新解析节点，避免操作失效的旧DOM句柄。
      amountInput = await this.resolveHubstudioLocator(page, selectors.amountInput, automatic([
        page.locator('input[placeholder="0"]:visible').first()
      ]))
      const submitPattern = request.direction === 'UP'
        ? /^(?:买入|buy)\s*(?:涨|up)(?:\s|$)/i
        : /^(?:买入|buy)\s*(?:跌|down)(?:\s|$)/i
      submitButton = await this.resolveHubstudioLocator(page, selectors.submitButton, automatic([
        page.getByRole('button', { name: submitPattern }).first()
      ]))
      matched.amountInput = Boolean(amountInput)
      matched.submitButton = Boolean(submitButton)
      if (!amountInput || !submitButton) {
        return {
          ok: false,
          message: '已切换涨跌方向，但MEXC重绘后未能识别金额框或买入按钮',
          matched
        }
      }

      await amountInput.fill(request.amount)
      // React enables Buy asynchronously after validating the controlled input.
      // Re-resolve the button after each short wait because the order panel can
      // redraw. We retry observing readiness, but submit exactly once.
      const readinessDelays = [150, 300, 500, 700]
      for (const delay of readinessDelays) {
        await page.waitForTimeout(delay)
        submitButton = await this.resolveHubstudioLocator(page, selectors.submitButton, automatic([
          page.getByRole('button', { name: submitPattern }).first()
        ]))
        if (!submitButton) continue
        matched.submitEnabled = await submitButton.isEnabled().catch(() => false)
        if (matched.submitEnabled) break
      }
      matched.submitButton = Boolean(submitButton)
      if (!submitButton) {
        return { ok: false, message: '填入金额后MEXC买入按钮节点消失；未点击', matched }
      }
      await Promise.all([
        this.highlightHubstudio(amountInput),
        this.highlightHubstudio(directionButton!),
        this.highlightHubstudio(submitButton)
      ])
      if (request.allowSubmit && !matched.submitEnabled) {
        return {
          ok: false,
          message: `已填入${request.amount} USDT并等待1.65秒、检查按钮4次，但MEXC买入仍不可用；未点击`,
          matched
        }
      }
      let orderAccepted = false
      let submittedAt: number | undefined
      if (request.allowSubmit) {
        submittedAt = Date.now()
        const orderResponsePromise = page.waitForResponse(
          (response) => /\/api\/platform\/predict\/orderCenter\/web\/order\/place\/(?:market|limit)/.test(response.url()),
          { timeout: 8_000 }
        ).catch(() => undefined)
        await submitButton.click()
        const orderResponse = await orderResponsePromise
        if (!orderResponse) {
          return {
            ok: false,
            orderAccepted: false,
            submittedAt,
            submissionUncertain: true,
            message: '已点击MEXC买入，但未捕获到本次下单接口响应；为避免误对冲，未启动成交监听',
            matched
          }
        }
        let responseBody: unknown
        try {
          responseBody = await orderResponse.json()
        } catch {
          responseBody = undefined
        }
        const record = responseBody && typeof responseBody === 'object'
          ? responseBody as Record<string, unknown>
          : undefined
        const responseCode = Number(record?.code)
        orderAccepted = orderResponse.ok() && (
          responseCode === 0 ||
          responseCode === 200 ||
          record?.success === true
        )
        if (!orderAccepted) {
          const reason = String(record?.msg ?? record?.message ?? `HTTP ${orderResponse.status()}`)
          return {
            ok: false,
            orderAccepted: false,
            submittedAt,
            submissionUncertain: false,
            message: `MEXC下单接口未确认成功：${reason}；未启动Polymarket对冲`,
            matched
          }
        }
      }
      await this.refreshHubstudioAuthentication()
      return {
        ok: true,
        orderAccepted,
        submittedAt,
        message: request.allowSubmit
          ? 'MEXC下单接口已确认接收，正在等待该笔实际成交'
          : '已在Hubstudio中自动选择涨跌并填入金额，买入按钮已高亮，等待人工确认',
        matched
      }
    } catch (error) {
      return {
        ok: false,
        message: `Hubstudio网页操作失败：${error instanceof Error ? error.message : String(error)}`,
        matched
      }
    }
  }

  private async closeHubstudioPosition(request: CloseMexcPositionRequest): Promise<AutomationResult> {
    const page = this.hubstudioPage
    if (!page || page.isClosed()) return { ok: false, message: 'Hubstudio MEXC页面不可用', matched: {} }
    const quantity = Number(request.quantity)
    if (!Number.isFinite(quantity) || quantity <= 0) return { ok: false, message: 'MEXC平仓份额必须大于0', matched: {} }
    if (this.elementMode !== 'AUTO') {
      return { ok: false, message: 'MEXC自动卖出需要切换到“系统自动识别”模式；未操作网页', matched: {} }
    }
    try {
      await this.ensureHubstudioLiveMarket(page, request.durationMinutes, request.startTime)
      const directionPattern = request.direction === 'UP'
        ? /^(?:涨(?:\s|\d|$)|up(?:\s|\d|$))/i
        : /^(?:跌(?:\s|\d|$)|down(?:\s|\d|$))/i
      const directionButton = await this.resolveHubstudioLocator(page, undefined, [
        page.getByRole('button', { name: directionPattern }).first()
      ])
      const sellModeButton = await this.resolveHubstudioLocator(page, undefined, [
        page.getByRole('button', { name: /^(?:卖出|sell)$/i }).first(),
        page.getByRole('tab', { name: /^(?:卖出|sell)$/i }).first()
      ])
      const matched = {
        directionButton: Boolean(directionButton), sellModeButton: Boolean(sellModeButton),
        amountInput: false, submitButton: false, submitEnabled: false
      }
      if (!directionButton || !sellModeButton) {
        return { ok: false, message: '系统未识别MEXC持仓方向或卖出入口；未执行卖出', matched }
      }
      await directionButton.click()
      await page.waitForTimeout(180)
      await sellModeButton.click()
      await page.waitForTimeout(250)

      const amountInput = await this.resolveHubstudioLocator(page, undefined, [
        page.locator('[data-tutorial-id="detail-tutorial-amount"] input:visible').first(),
        page.locator('input[placeholder="0"]:visible').first()
      ])
      const submitPattern = request.direction === 'UP'
        ? /^(?:卖出|sell)\s*(?:涨|up)(?:\s|$)/i
        : /^(?:卖出|sell)\s*(?:跌|down)(?:\s|$)/i
      let submitButton = await this.resolveHubstudioLocator(page, undefined, [
        page.getByRole('button', { name: submitPattern }).first()
      ])
      matched.amountInput = Boolean(amountInput)
      matched.submitButton = Boolean(submitButton)
      if (!amountInput || !submitButton) {
        return { ok: false, message: '已进入MEXC卖出区，但未识别份额输入框或卖出按钮；未提交', matched }
      }
      await amountInput.fill(request.quantity)
      for (const delay of [150, 300, 500, 700]) {
        await page.waitForTimeout(delay)
        submitButton = await this.resolveHubstudioLocator(page, undefined, [
          page.getByRole('button', { name: submitPattern }).first()
        ])
        if (!submitButton) continue
        matched.submitEnabled = await submitButton.isEnabled().catch(() => false)
        if (matched.submitEnabled) break
      }
      matched.submitButton = Boolean(submitButton)
      if (!submitButton || !matched.submitEnabled) {
        return { ok: false, message: `已填入${request.quantity}份，但MEXC卖出按钮不可用；未点击`, matched }
      }
      await Promise.all([this.highlightHubstudio(directionButton), this.highlightHubstudio(amountInput), this.highlightHubstudio(submitButton)])
      if (!request.allowSubmit) return { ok: true, orderAccepted: false, message: 'MEXC卖出信息已填写并高亮，等待确认', matched }

      const submittedAt = Date.now()
      const responsePromise = page.waitForResponse(
        (response) => /\/api\/platform\/predict\/orderCenter\/web\/order\/place\/(?:market|limit)/.test(response.url()),
        { timeout: 8_000 }
      ).catch(() => undefined)
      await submitButton.click()
      const response = await responsePromise
      if (!response) {
        return {
          ok: false, orderAccepted: false, submittedAt, submissionUncertain: true,
          message: '已点击MEXC卖出，但未捕获下单接口响应；已停止后续Polymarket平仓', matched
        }
      }
      let body: unknown
      try { body = await response.json() } catch { body = undefined }
      const record = body && typeof body === 'object' ? body as Record<string, unknown> : undefined
      const code = Number(record?.code)
      const orderAccepted = response.ok() && (code === 0 || code === 200 || record?.success === true)
      if (!orderAccepted) {
        return {
          ok: false, orderAccepted: false, submittedAt,
          message: `MEXC卖出接口未确认成功：${String(record?.msg ?? record?.message ?? `HTTP ${response.status()}`)}`,
          matched
        }
      }
      return {
        ok: true, orderAccepted: true, submittedAt,
        message: 'MEXC卖出接口已确认接收，正在等待实际成交回读', matched
      }
    } catch (error) {
      return { ok: false, message: `MEXC自动卖出失败：${error instanceof Error ? error.message : String(error)}`, matched: {} }
    }
  }

  private async ensureHubstudioLiveMarket(page: Page, durationMinutes: MarketDuration, startTime: number): Promise<void> {
    const target = await this.resolveLiveMarketTarget(durationMinutes, startTime)

    if (!page.url().endsWith(`/${target.eventId}`)) {
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    }
    await page.locator('[data-tutorial-id="detail-tutorial-amount"] input, input[placeholder="0"]')
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
  }

  private async resolveLiveMarketTarget(durationMinutes: MarketDuration, startTime: number): Promise<{ eventId: string; url: string }> {
    const resolver = async (query: { durationMinutes: MarketDuration; startTime: number }): Promise<{ eventId: string; url: string }> => {
      const response = await fetch('/api/platform/predict/market/web/event/events', {
        headers: { accept: 'application/json' }
      })
      if (!response.ok) throw new Error(`MEXC events HTTP ${response.status}`)
      const body = await response.json() as { data?: MexcRawEvent[] }
      const event = (body.data ?? []).find((candidate) =>
        candidate.s === 2 &&
        candidate.mn === `BTC ${query.durationMinutes}min` &&
        Number(candidate.sp) === query.durationMinutes * 60 &&
        Number(candidate.st) === query.startTime
      )
      if (!event?.id || !event.en) throw new Error('所选机会已经跨盘或结束，请刷新套利机会')
      const slug = event.en
        .toLowerCase()
        .replaceAll(',', '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
      return {
        eventId: String(event.id),
        url: `${location.origin}/prediction-markets/up-down/${slug}/${event.id}`
      }
    }
    const query = { durationMinutes, startTime }
    if (this.mode === 'HUBSTUDIO') {
      const page = this.hubstudioPage
      if (!page || page.isClosed()) throw new Error('Hubstudio MEXC页面不可用')
      return await page.evaluate(resolver, query)
    }
    const window = this.embeddedWindow
    if (!window || window.isDestroyed()) throw new Error('内嵌MEXC页面不可用')
    return await window.webContents.executeJavaScript(`(${resolver.toString()})(${JSON.stringify(query)})`)
  }

  private async calibrateEmbedded(kind: MexcCalibrationKind): Promise<MexcBrowserStatus> {
    if (!this.embeddedWindow || this.embeddedWindow.isDestroyed()) throw new Error('内嵌MEXC窗口不可用')
    this.embeddedWindow.show()
    this.embeddedWindow.focus()
    this.embeddedWindow.webContents.send('mexc:start-calibration', { kind })

    const result = await new Promise<{ kind: MexcCalibrationKind; selector: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calibrationResolver = undefined
        reject(new Error('校准超时，请重试'))
      }, 30_000)
      this.calibrationResolver = (value) => {
        clearTimeout(timer)
        this.calibrationResolver = undefined
        resolve(value)
      }
    })
    this.saveSelector('EMBEDDED', result.kind, result.selector)
    return this.status(`${kind} 内嵌模式校准完成`, true, this.embeddedWindow.webContents.getURL())
  }

  private async calibrateHubstudio(kind: MexcCalibrationKind): Promise<MexcBrowserStatus> {
    const page = this.hubstudioPage
    if (!page || page.isClosed()) throw new Error('Hubstudio MEXC页面不可用')
    await page.bringToFront()

    const selection = page.evaluate(({ calibrationKind }) => new Promise<string>((resolve) => {
      type CalibrationWindow = Window & { __arbdeskCancelCalibration?: () => void }
      const calibrationWindow = window as CalibrationWindow
      calibrationWindow.__arbdeskCancelCalibration?.()

      const cssEscape = (value: string): string => globalThis.CSS?.escape
        ? globalThis.CSS.escape(value)
        : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
      const stableSelector = (element: Element): string => {
        if (element.id) return `#${cssEscape(element.id)}`
        for (const attribute of ['data-testid', 'data-test', 'name', 'aria-label']) {
          const value = element.getAttribute(attribute)
          if (value) return `${element.tagName.toLowerCase()}[${attribute}="${cssEscape(value)}"]`
        }
        const parts: string[] = []
        let current: Element | null = element
        while (current && current !== document.body && parts.length < 6) {
          const parent: Element | null = current.parentElement
          const tag = current.tagName.toLowerCase()
          if (!parent) {
            parts.unshift(tag)
            break
          }
          const siblings = Array.from(parent.children).filter((child) => child.tagName === current?.tagName)
          const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ''
          parts.unshift(`${tag}${suffix}`)
          current = parent
        }
        return `body > ${parts.join(' > ')}`
      }

      const banner = document.createElement('div')
      banner.textContent = `ArbDesk Hubstudio校准：请点击 ${calibrationKind} 对应的网页元素（本次点击不会下单）`
      Object.assign(banner.style, {
        position: 'fixed', inset: '12px 12px auto 12px', zIndex: '2147483647', padding: '14px 18px',
        borderRadius: '10px', color: '#f8fafc', background: '#0f172a', border: '1px solid #22c55e',
        font: '600 14px system-ui', boxShadow: '0 12px 32px rgba(0,0,0,.35)'
      })
      document.documentElement.appendChild(banner)

      const select = (event: MouseEvent): void => {
        event.preventDefault()
        event.stopImmediatePropagation()
        const target = event.target
        if (!(target instanceof Element)) return finish('')
        const htmlTarget = target as HTMLElement
        htmlTarget.style.outline = '3px solid #22c55e'
        htmlTarget.style.outlineOffset = '2px'
        setTimeout(() => {
          htmlTarget.style.outline = ''
          htmlTarget.style.outlineOffset = ''
        }, 2_000)
        finish(stableSelector(target))
      }
      const finish = (selector: string): void => {
        banner.remove()
        document.removeEventListener('click', select, true)
        delete calibrationWindow.__arbdeskCancelCalibration
        resolve(selector)
      }
      calibrationWindow.__arbdeskCancelCalibration = () => finish('')
      document.addEventListener('click', select, true)
    }), { calibrationKind: kind })

    let selector = ''
    try {
      selector = await Promise.race([
        selection,
        new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error('校准超时，请重试')), 30_000))
      ])
    } catch (error) {
      await page.evaluate(() => {
        ;(window as Window & { __arbdeskCancelCalibration?: () => void }).__arbdeskCancelCalibration?.()
      }).catch(() => undefined)
      throw error
    }
    if (!selector) throw new Error('未取得有效网页元素，请重试')
    this.saveSelector('HUBSTUDIO', kind, selector)
    return this.status(`${kind} Hubstudio模式校准完成`, true, page.url())
  }

  private async refreshEmbeddedAuthentication(): Promise<void> {
    const window = this.embeddedWindow
    if (!window || window.isDestroyed()) return
    try {
      const pageLooksAuthenticated = await window.webContents.executeJavaScript(`(() => {
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false
          const style = getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
        }
        const url = location.href.toLowerCase()
        if (!location.hostname.endsWith('mexc.com') || url.includes('/login')) return false
        if (Array.from(document.querySelectorAll('input[type="password"]')).some(visible)) return false
        const loginControl = Array.from(document.querySelectorAll('a, button')).find((element) => {
          const text = (element.textContent || '').trim().toLowerCase()
          return visible(element) && ['login', 'log in', 'sign in', '登录'].includes(text)
        })
        return !loginControl
      })()`)
      const cookies = await session.fromPartition('persist:mexc-arbdesk').cookies.get({ url: MEXC_URL })
      this.embeddedAuthenticated = Boolean(pageLooksAuthenticated && cookies.length > 0)
    } catch {
      this.embeddedAuthenticated = false
    }
  }

  private async refreshHubstudioAuthentication(): Promise<void> {
    const page = this.hubstudioPage
    if (!page || page.isClosed()) return
    try {
      const pageLooksAuthenticated = await page.evaluate(() => {
        const visible = (element: Element): boolean => {
          if (!(element instanceof HTMLElement)) return false
          const style = getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
        }
        const url = location.href.toLowerCase()
        if (!location.hostname.endsWith('mexc.com') || url.includes('/login')) return false
        if (Array.from(document.querySelectorAll('input[type="password"]')).some(visible)) return false
        const loginControl = Array.from(document.querySelectorAll('a, button')).find((element) => {
          const text = (element.textContent ?? '').trim().toLowerCase()
          return visible(element) && ['login', 'log in', 'sign in', '登录'].includes(text)
        })
        return !loginControl
      })
      const cookies = await page.context().cookies(page.url())
      this.hubstudioAuthenticated = pageLooksAuthenticated && cookies.length > 0
    } catch {
      this.hubstudioAuthenticated = false
    }
  }

  private async refreshAuthentication(): Promise<void> {
    if (this.mode === 'HUBSTUDIO') await this.refreshHubstudioAuthentication()
    else await this.refreshEmbeddedAuthentication()
  }

  private async followHubstudioLiveMarket(): Promise<void> {
    const page = this.hubstudioPage
    if (!page || page.isClosed()) return
    const match = page.url().match(/\/prediction-markets\/up-down\/btc-(5|15)min-[^/]+\/([^/?#]+)/i)
    if (!match) return
    const durationMinutes = Number(match[1]) as 5 | 15
    const currentEventId = match[2]
    const now = Date.now()
    let events = this.interceptedEvents && now - this.interceptedEvents.receivedAt <= MEXC_EVENT_CACHE_MS
      ? this.interceptedEvents.events
      : undefined
    if (!events) {
      events = await page.evaluate(async () => {
        const response = await fetch('/api/platform/predict/market/web/event/events', {
          headers: { accept: 'application/json' }
        })
        if (!response.ok) throw new Error(`MEXC events HTTP ${response.status}`)
        const body = await response.json() as { data?: MexcRawEvent[] }
        return body.data ?? []
      })
      this.interceptedEvents = { events, receivedAt: Date.now() }
    }
    const event = events.find((candidate) =>
      candidate.s === 2 &&
      candidate.mn === `BTC ${durationMinutes}min` &&
      Number(candidate.sp) === durationMinutes * 60 &&
      Number(candidate.st) <= now &&
      Number(candidate.et) > now
    )
    if (!event?.id || !event.en) return
    const slug = event.en
      .toLowerCase()
      .replaceAll(',', '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
    const target = {
      eventId: String(event.id),
      url: `${new URL(page.url()).origin}/prediction-markets/up-down/${slug}/${event.id}`
    }
    if (!target || target.eventId === currentEventId) return
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  }

  private startHubstudioMonitoring(): void {
    if (this.hubstudioMonitor) clearInterval(this.hubstudioMonitor)
    this.hubstudioMonitor = setInterval(() => {
      if (!this.hubstudioPage || this.hubstudioPage.isClosed()) return
      void this.followHubstudioLiveMarket().catch(() => undefined)
      if (Date.now() - this.lastHubstudioAccountRefreshAt < 15_000 || this.hubstudioAccountRefreshing) return
      this.hubstudioAccountRefreshing = true
      void this.refreshAccountState()
        .finally(() => {
          this.lastHubstudioAccountRefreshAt = Date.now()
          this.hubstudioAccountRefreshing = false
        })
        .catch(() => undefined)
    }, 5_000)
  }

  private clearHubstudioConnection(): void {
    if (this.hubstudioMonitor) clearInterval(this.hubstudioMonitor)
    this.hubstudioMonitor = undefined
    const page = this.hubstudioPage
    if (page && !page.isClosed()) {
      void page.evaluate(() => {
        type FeedState = { stop: () => void }
        const root = window as typeof window & { __arbDeskPredictionFeed?: FeedState }
        root.__arbDeskPredictionFeed?.stop()
        delete root.__arbDeskPredictionFeed
      }).catch(() => undefined)
    }
    if (this.hubstudioNetworkSession) void this.hubstudioNetworkSession.detach().catch(() => undefined)
    this.hubstudioNetworkSession = undefined
    this.hubstudioSocketUrls.clear()
    this.hubstudioPredictionConfirmedAt = 0
    this.hubstudioPredictionSubscriptionKey = ''
    this.lastHubstudioAccountRefreshAt = 0
    this.hubstudioAccountRefreshing = false
    this.hubstudioPage = undefined
    this.hubstudioBrowser = undefined
    this.hubstudioDebuggingPort = undefined
    this.hubstudioConnectedContainerCode = undefined
    this.hubstudioAuthenticated = false
    this.latestAccountState = undefined
    this.latestOrderCapture = undefined
  }

  private async callHubstudio<T>(path: string, body: Record<string, unknown> | string[]): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${HUBSTUDIO_API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000)
      })
    } catch (error) {
      throw new Error(`无法连接Hubstudio Local API（127.0.0.1:6873）：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new Error(`Hubstudio Local API返回HTTP ${response.status}`)
    return await response.json() as T
  }

  private async isVisible(page: Page, selector?: string): Promise<boolean> {
    if (!selector) return false
    try {
      return await page.locator(selector).first().isVisible()
    } catch {
      return false
    }
  }

  private async resolveHubstudioLocator(
    page: Page,
    calibratedSelector: string | undefined,
    fallbacks: Locator[]
  ): Promise<Locator | undefined> {
    const candidates: Locator[] = []
    if (calibratedSelector) candidates.push(page.locator(calibratedSelector).first())
    candidates.push(...fallbacks)
    for (const locator of candidates) {
      try {
        if (await locator.isVisible()) return locator
      } catch {
        // Invalid/stale calibration selectors fall through to semantic matching.
      }
    }
    return undefined
  }

  private async highlightHubstudio(locator: Locator): Promise<void> {
    await locator.evaluate((element) => {
      const htmlElement = element as HTMLElement
      htmlElement.style.outline = '3px solid #22c55e'
      htmlElement.style.outlineOffset = '2px'
      setTimeout(() => {
        htmlElement.style.outline = ''
        htmlElement.style.outlineOffset = ''
      }, 2_000)
    })
  }

  private saveSelector(mode: MexcBrowserMode, kind: MexcCalibrationKind, selector: string): void {
    this.selectorStore = {
      ...this.selectorStore,
      [mode]: { ...this.selectorStore[mode], [kind]: selector }
    }
    mkdirSync(dirname(this.configPath), { recursive: true })
    writeFileSync(this.configPath, JSON.stringify(this.selectorStore, null, 2), 'utf8')
  }

  private loadSelectors(): SelectorStore {
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, 'utf8')) as Partial<SelectorStore> & MexcSelectors
      if (parsed.EMBEDDED || parsed.HUBSTUDIO) {
        return { EMBEDDED: parsed.EMBEDDED ?? {}, HUBSTUDIO: parsed.HUBSTUDIO ?? {} }
      }
      return { EMBEDDED: parsed, HUBSTUDIO: {} }
    } catch {
      return emptySelectors()
    }
  }

  private status(message: string, open: boolean, url?: string): MexcBrowserStatus {
    return {
      mode: this.mode,
      open,
      url,
      authenticated: this.mode === 'HUBSTUDIO' ? this.hubstudioAuthenticated : this.embeddedAuthenticated,
      automationAvailable: open,
      monitoring: open,
      hubstudioContainerCode: this.mode === 'HUBSTUDIO' ? this.hubstudioContainerCode : undefined,
      debuggingPort: this.mode === 'HUBSTUDIO' ? this.hubstudioDebuggingPort : undefined,
      calibrated: this.getCalibration(),
      account: this.latestAccountState,
      lastOrderCapture: this.latestOrderCapture,
      message
    }
  }
}
