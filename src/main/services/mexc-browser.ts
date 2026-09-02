import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
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
import { canAttemptHubstudioReconnect, hubstudioMarketDuration } from '../domain/hubstudio-connection'
import type { FingerprintBrowserRuntime } from './fingerprint-browser-runtime'

const MEXC_URL = 'https://prediction.mexc.com/prediction-markets/all'
const HUBSTUDIO_API = 'http://127.0.0.1:6873'
const HUBSTUDIO_API_PORT_FALLBACKS = [6873, 56975]
const MEXC_USDT_COIN_ID = '128f589271cb4951b03e71e6323eb7be'
// Event rotation is frequent on the 5m board. Keep the directory cache short
// enough that a just-opened round is not hidden behind the previous response.
const MEXC_EVENT_CACHE_MS = 2_000
const MEXC_FRESHNESS_NOTIFY_THROTTLE_MS = 250
const MEXC_FEE_CACHE_MS = 10 * 60_000
// The default board freshness gate is 8 seconds. Keep the audited REST
// fallback below that threshold so a temporarily undecodable/missing WS depth
// frame cannot make a healthy browser market oscillate between fresh/stale.
const MEXC_REST_FALLBACK_MS = 5_000
const MEXC_PREFLIGHT_QUOTE_MS = 500
const MEXC_RATE_LIMIT_COOLDOWN_MS = 60_000
const MEXC_FORBIDDEN_COOLDOWN_MS = 15 * 60_000
const MEXC_FILL_READBACK_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000] as const
const MEXC_SYMBOL_MAP_TIMEOUT_MS = 5_000
const MEXC_FILL_QUERY_TIMEOUT_MS = 5_000
const execFileAsync = promisify(execFile)

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
  eventId?: string
  /** 计划算出的MEXC最贵可吃档价；直连下单用它做逐档深度检查与价格保护。 */
  maximumPrice?: string
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
  pageReadyAt?: number
  directionReadyAt?: number
  buttonReadyAt?: number
  submittedAt?: number
  responseAt?: number
  submissionUncertain?: boolean
  orderResponseUrl?: string
  orderRequestBody?: string
  orderResponseBody?: string
  orderId?: string
  currencyMappingMs?: number
  cookieReadMs?: number
  postMs?: number
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
  [key: string]: unknown
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

interface MexcFetchOutcome {
  status: number
  httpOk: boolean
  body: unknown
  retryAfter?: string
}

interface MexcFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

function normalizeSourceTimestamp(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || !value || value <= 0) return undefined
  return value < 10_000_000_000 ? value * 1_000 : value
}

function normalizeMexcEventTime(value: number | string | undefined): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return numeric < 10_000_000_000 ? numeric * 1_000 : numeric
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
  private hubstudioOrderPages = new Map<5 | 15, Page>()
  private hubstudioOrderWarmPromise?: Promise<void>
  private hubstudioDebuggingPort?: number
  private hubstudioApiBase?: string
  private hubstudioConnectedContainerCode?: string
  private hubstudioMonitor?: NodeJS.Timeout
  private hubstudioPredictionSyncPromise?: Promise<void>
  /**
   * Symbols discovered in the active event directory, including a side whose
   * depth is temporarily missing. Subscriptions must be based on this set,
   * not only on fully assembled windows; otherwise one incomplete rollover
   * permanently drops that duration from the live feed.
   */
  private hubstudioPredictionTargets = new Map<5 | 15, { upSymbolId: string; downSymbolId: string }>()
  private hubstudioMarketRefreshPromise?: Promise<void>
  private hubstudioNetworkSession?: CDPSession
  private hubstudioSocketUrls = new Map<string, string>()
  private hubstudioPredictionConfirmedAt = 0
  private hubstudioPredictionSubscriptionKey = ''
  private hubstudioBinaryFrameCount = 0
  private hubstudioPredictFrameCount = 0
  private hubstudioDepthFrameCount = 0
  private hubstudioIndexFrameCount = 0
  private lastHubstudioBinaryFrameAt = 0
  private lastHubstudioDepthFrameAt = 0
  private lastHubstudioDepthSymbolId = ''
  private hubstudioPassiveConnectPromise?: Promise<boolean>
  private lastHubstudioPassiveConnectAt = 0
  private lastHubstudioConnectionError?: string
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
  private feeRows = new Map<string, MexcAssetLogRow>()
  private latestFillRows?: { receivedAt: number; rows: MexcFillLogRow[] }
  private fillRowListeners = new Set<(rows: MexcFillLogRow[]) => void>()
  private latestWindows: MexcWindowQuote[] = []
  private lastWindowDiagnostic = ''
  private monitoringEnabled = true
  private marketDataListeners = new Set<() => void>()
  private instrumentedHubstudioPages = new WeakSet<Page>()
  private trackedHubstudioOrderPages = new WeakSet<Page>()
  private discoveredPositionFields = new Set<string>()
  private discoveredOpenOrderFields = new Set<string>()
  private discoveredHistoryFields = new Set<string>()
  private symbolCurrencyMap?: { receivedAt: number; byId: Map<string, { cd: string; mcd: string }> }
  private symbolCurrencyMapRefreshPromise?: Promise<void>
  private arbFetchJsonPages = new WeakSet<Page>()
  private arbFetchInitScriptPages = new WeakSet<Page>()
  private mexcRequestsBlockedUntil = 0

  constructor(private readonly configPath: string, private readonly fingerprintRuntime?: FingerprintBrowserRuntime) {
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

  setMonitoringEnabled(enabled: boolean): void {
    if (this.monitoringEnabled === enabled) return
    this.monitoringEnabled = enabled
    if (enabled) {
      if (this.hubstudioPage && !this.hubstudioPage.isClosed()) {
        this.startHubstudioMonitoring()
        void this.syncHubstudioPredictionSubscriptions().catch(() => undefined)
      }
      return
    }
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
    this.latestWindows = []
    for (const listener of this.marketDataListeners) listener()
  }

  getLatestWindows(): MexcWindowQuote[] {
    return this.latestWindows
  }

  getWindowDiagnostic(): string {
    if (this.mode !== 'HUBSTUDIO') return this.lastWindowDiagnostic
    const now = Date.now()
    const age = (receivedAt: number): string => receivedAt > 0
      ? `${Math.max(0, Math.floor((now - receivedAt) / 1_000))}s`
      : '无'
    const quoteAges = this.latestWindows.flatMap((window) => (['UP', 'DOWN'] as const).map((direction) => {
      const outcome = window.outcomes[direction]
      return `${window.durationMinutes}m${direction}:${age(outcome?.receivedAt ?? 0)}`
    }))
    const streamDiagnostic = `流诊断 原始${this.hubstudioBinaryFrameCount}(${age(this.lastHubstudioBinaryFrameAt)})/Predict${this.hubstudioPredictFrameCount}(${age(this.hubstudioPredictionConfirmedAt)})/深度${this.hubstudioDepthFrameCount}(${age(this.lastHubstudioDepthFrameAt)}${this.lastHubstudioDepthSymbolId ? `,${this.lastHubstudioDepthSymbolId}` : ''})/指数${this.hubstudioIndexFrameCount}`
    return [this.lastWindowDiagnostic, streamDiagnostic, quoteAges.length > 0 ? `盘口年龄 ${quoteAges.join(' ')}` : '盘口年龄 无'].filter(Boolean).join('；')
  }

  getCachedAccountState(): MexcAccountState | undefined {
    return this.latestAccountState
  }

  async ensureAccountBalance(maximumAgeMs = 30_000): Promise<MexcAccountState> {
    const cached = this.latestAccountState
    if (
      cached?.authenticated && cached.reachable && cached.availableUsdt !== undefined &&
      Date.now() - cached.checkedAt <= maximumAgeMs
    ) return cached
    return await this.refreshAccountBalanceState()
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

  async reconnectIfAvailable(force = false): Promise<MexcBrowserStatus> {
    if (this.mode !== 'HUBSTUDIO' || this.getStatus().open) return this.getStatus()
    await this.tryAdoptRunningHubstudio(force, {
      bringToFront: false,
      createIfMissing: false,
      refreshAccount: false
    })
    return this.getStatus()
  }

  async prepareOrder(request: PrepareOrderRequest): Promise<AutomationResult> {
    // 已连接时不再走open()：openHubstudio会bringToFront并刷新认证，
    // 把Hubstudio窗口抢到最前还多付一次往返，后台标签页本来就能完成下单。
    if (!this.getStatus().open) await this.open()
    return this.mode === 'HUBSTUDIO'
      ? this.prepareHubstudioOrder(request)
      : this.prepareEmbeddedOrder(request)
  }

  async closePosition(request: CloseMexcPositionRequest): Promise<AutomationResult> {
    if (!this.getStatus().open) await this.open()
    if (this.mode !== 'HUBSTUDIO') {
      return { ok: false, message: 'MEXC自动卖出当前仅支持Hubstudio模式；未操作网页', matched: {} }
    }
    return await this.closeHubstudioPosition(request)
  }

  async fetchActiveBtcWindows(): Promise<MexcWindowQuote[]> {
    if (!this.monitoringEnabled) return []
    if (!this.getStatus().open) {
      if (this.mode === 'HUBSTUDIO') {
        await this.reconnectIfAvailable()
        if (!this.getStatus().open && !this.startupOpenAttempted) await this.open()
        if (!this.getStatus().open) {
          throw new Error(this.lastHubstudioConnectionError
            ? `Hubstudio尚未连接，软件会自动重试：${this.lastHubstudioConnectionError}`
            : 'Hubstudio尚未连接，软件正在自动检测已运行环境')
        }
      } else {
        await this.open()
      }
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
      .filter((event) => Number(event.s) === 2 && normalizeMexcEventTime(event.st) <= now && normalizeMexcEventTime(event.et) > now)
      .filter((event) => event.mn === 'BTC 5min' || event.mn === 'BTC 15min')
    const selected = [300, 900]
      .map((seconds) => active.find((event) => Number(event.sp) === seconds))
      .filter((event): event is MexcRawEvent => Boolean(event))
    for (const event of selected) {
      const upSymbolId = String(event.ers?.find((outcome) => String(outcome.rn ?? '').toUpperCase() === 'UP')?.si ?? '')
      const downSymbolId = String(event.ers?.find((outcome) => String(outcome.rn ?? '').toUpperCase() === 'DOWN')?.si ?? '')
      const duration = Number(event.sp) === 300 ? 5 as const : 15 as const
      if (upSymbolId && downSymbolId) this.hubstudioPredictionTargets.set(duration, { upSymbolId, downSymbolId })
    }
    const missingDirectoryDurations = [300, 900]
      .filter((seconds) => !selected.some((event) => Number(event.sp) === seconds))
      .map((seconds) => `${seconds === 300 ? 5 : 15}m`)
    this.lastWindowDiagnostic = missingDirectoryDurations.length > 0
      ? `事件目录未找到 ${missingDirectoryDurations.join('/')} 当前轮`
      : ''
    // Do not keep separate 5m/15m execution tabs hot while monitoring. The
    // direct order API runs in the monitor page and does not need those tabs;
    // permanently warming both detail pages costs two Chromium renderer
    // processes and is especially expensive in Hubstudio. If a direct order
    // cannot be used, prepareHubstudioOrder falls back to the current page's
    // controls on demand.
    const symbolIds = [...new Set(selected.flatMap((event) => event.ers ?? []).map((outcome) => String(outcome.si ?? '')).filter(Boolean))]
    // 直连下单依赖 symbolsV2 的 si→currencyId 映射；开盘滚动会出现新si，
    // 缓存缺失或临近过期（>7分钟，早于10分钟TTL）时后台刷新，
    // 保证下单瞬间永远直接命中缓存、绝不在线上拉这5MB。
    if (this.mode === 'HUBSTUDIO' && !this.symbolCurrencyMapRefreshPromise &&
        (!this.symbolCurrencyMap ||
          symbolIds.some((symbolId) => !this.symbolCurrencyMap!.byId.has(symbolId)) ||
          Date.now() - this.symbolCurrencyMap.receivedAt > 420_000)) {
      this.symbolCurrencyMapRefreshPromise = this.fetchSymbolCurrencyMap(true)
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => { this.symbolCurrencyMapRefreshPromise = undefined })
    }
    // Only a symbol-specific depth frame or REST response can refresh a book.
    // Generic predict channels (mini tickers/pings/indexes) prove the socket is
    // alive but must not disguise an old order book as fresh.
    const effectiveDepthReceivedAt = (symbolId: string): number => Number(this.interceptedDepth.get(symbolId)?.receivedAt) || 0
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
          // A single symbol can briefly return an empty book or an HTTP error
          // during the 5m/15m rollover. Keep the other symbols usable instead
          // of rejecting the whole batch and making both windows look expired.
          Promise.all(request.symbolIds.map(async (symbolId) => {
            try {
              const response = await fetch(`/api/platform/predict/market/web/depth?symbolId=${encodeURIComponent(symbolId)}`, {
                headers: { accept: 'application/json' }
              })
              if (!response.ok) throw new Error(`MEXC depth HTTP ${response.status}`)
              return { symbolId, depth: await response.json() as MexcRawDepth, receivedAt: Date.now() }
            } catch (error) {
              console.warn(`[MEXC盘口] depth 获取失败，跳过 symbol ${symbolId}: ${error instanceof Error ? error.message : String(error)}`)
              return undefined
            }
          })).then((rows) => rows.filter((row): row is { symbolId: string; depth: MexcRawDepth; receivedAt: number } => Boolean(row))),
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
      const latestIndexAt = normalizeSourceTimestamp(latestIndex?.ts)
      if (latestIndex?.p && latestIndexAt) this.latestMexcIndex = { price: String(latestIndex.p), receivedAt: latestIndexAt }
      if (fallback.feeRows) {
        this.applyFeeCalibration(fallback.feeRows, Date.now(), true)
      }
    }

    const feeCalibration = this.cachedFeeCalibration ?? { feeRate: '0', source: 'UNAVAILABLE' as const, receivedAt: 0 }
    const incompleteEvents: string[] = []
    const eventReceivedAt = this.interceptedEvents?.receivedAt ?? now
    const windows: MexcWindowQuote[] = []
    for (const event of selected) {
      const parsed = new Map<Direction, MexcOutcomeQuote>()
      for (const outcome of event.ers ?? []) {
        const normalized = String(outcome.rn ?? '').toUpperCase()
        if (normalized !== 'UP' && normalized !== 'DOWN') continue
        const symbolId = String(outcome.si ?? '')
        const effectiveDepth = this.interceptedDepth.get(symbolId)
        const levels = (effectiveDepth?.data?.asks ?? [])
          .map((level) => ({ price: String(level.p ?? ''), size: String(level.q ?? '') }))
          .filter((level) => Number(level.price) > 0 && Number(level.size) > 0)
          .sort((left, right) => Number(left.price) - Number(right.price))
        const best = levels[0]
        // The page can show the event's current ask while the symbol-specific
        // depth endpoint is briefly empty during rollover or when that side
        // has no posted size. Keep that fresh price visible as PRICE_ONLY
        // (askSize=0), but never treat it as executable depth; venue gates
        // still block automatic orders until real asks arrive.
        const eventAsk = String(outcome.ap ?? '')
        if (!best && !(Number(eventAsk) > 0 && Number(eventAsk) < 1)) continue
        parsed.set(normalized, {
          direction: normalized,
          symbolId,
          bestAsk: best?.price ?? eventAsk,
          askSize: best?.size ?? '0',
          levels,
          receivedAt: best
            ? Math.max(Number(effectiveDepth?.receivedAt) || 0, effectiveDepthReceivedAt(symbolId))
            : eventReceivedAt
        })
      }
      const up = parsed.get('UP')
      const down = parsed.get('DOWN')
      if (!up || !down) {
        const missing = [!up ? 'UP' : '', !down ? 'DOWN' : ''].filter(Boolean).join('/')
        incompleteEvents.push(`${Number(event.sp) === 300 ? '5m' : '15m'}#${String(event.id ?? '?')} 缺 ${missing}`)
        continue
      }
      windows.push({
        eventId: String(event.id),
        durationMinutes: Number(event.sp) === 300 ? 5 as const : 15 as const,
        startTime: normalizeMexcEventTime(event.st),
        endTime: normalizeMexcEventTime(event.et),
        baselinePrice: String(event.bsp ?? ''),
        indexPrice: this.latestMexcIndex?.price,
        indexReceivedAt: this.latestMexcIndex?.receivedAt,
        feeRate: feeCalibration.feeRate,
        feeRateSource: feeCalibration.source,
        outcomes: { UP: up, DOWN: down }
      })
    }
    if (incompleteEvents.length > 0) {
      console.warn(`[MEXC盘口] 本轮跳过不完整事件：${incompleteEvents.join('；')}`)
      this.lastWindowDiagnostic = [this.lastWindowDiagnostic, `盘口不完整：${incompleteEvents.join('；')}`].filter(Boolean).join('；')
    }
    if (windows.length === 0 && selected.length > 0) {
      throw new Error(`MEXC 当前 BTC 盘口均不完整：${incompleteEvents.join('；')}`)
    }
    this.latestWindows = windows
    if (this.mode === 'HUBSTUDIO' && this.hubstudioPredictionConfirmedAt > 0) {
      const streamAge = Date.now() - this.hubstudioPredictionConfirmedAt
      if (streamAge > MEXC_REST_FALLBACK_MS) {
        this.lastWindowDiagnostic = [this.lastWindowDiagnostic, `实时深度流已 ${Math.floor(streamAge / 1_000)} 秒未收到帧`].filter(Boolean).join('；')
      }
    }
    if (this.mode === 'HUBSTUDIO') {
      void this.syncHubstudioPredictionSubscriptions().catch(() => undefined)
    }
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
    const latestIndexAt = normalizeSourceTimestamp(latestIndex?.ts)
    if (latestIndex?.p && latestIndexAt) this.applyMexcIndex(String(latestIndex.p), latestIndexAt)
    if (result.feeRows) this.applyFeeCalibration(result.feeRows, result.receivedAt, true)
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
      this.applyFeeCalibration(historyRows as MexcAssetLogRow[], Date.now(), true)
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

  private async fetchSummaryLogRows(page: Page): Promise<MexcFillLogRow[]> {
    const outcome = await this.evaluateMexcFetchJson(
      page,
      '/api/platform/predict/asset/query/web/summaryLog?comboExclude=false&pageNum=1&pageSize=50',
      { method: 'GET', timeoutMs: MEXC_FILL_QUERY_TIMEOUT_MS }
    )
    if (!outcome.httpOk) throw new Error(`MEXC history HTTP ${outcome.status}`)
    const body = outcome.body as { data?: { result?: MexcFillLogRow[] } }
    return body.data?.result ?? []
  }

  async waitForFill(match: MexcFillMatch, timeoutMs = 90_000): Promise<import('../../shared/types').Fill | undefined> {
    const readbackStartedAt = Date.now()
    console.info(`[MEXC成交核验] 开始等待：eventId=${match.eventId} symbolId=${match.symbolId} direction=${match.direction} orderId=${match.orderId ?? '无'} timeout=${timeoutMs}ms`)
    let restQueries = 0
    const measured = (fill: import('../../shared/types').Fill | undefined): import('../../shared/types').Fill | undefined => fill ? {
      ...fill,
      executionDetails: {
        ...fill.executionDetails,
        readbackMs: Date.now() - readbackStartedAt,
        restQueries
      }
    } : undefined
    const deadline = Date.now() + timeoutMs
    const passiveFill = await this.waitForInterceptedFill(match, Math.min(200, timeoutMs))
    if (passiveFill) return measured(passiveFill)
    // REST只做有上限的成交核验。预算耗尽后继续等待页面/WS被动回执，
    // 不会因一笔异常订单在90秒内持续每秒打history接口。
    for (const delay of MEXC_FILL_READBACK_DELAYS_MS) {
      if (Date.now() >= deadline) break
      // 查询发出后仍保持页面响应监听；如果MEXC页面自己的成交回执先回来，
      // 直接使用它，不会为“并行”再增加第二个HTTP请求。
      const observer = this.observeInterceptedFill(match)
      let rows: MexcFillLogRow[]
      try {
        restQueries += 1
        if (this.mode === 'HUBSTUDIO' && this.hubstudioPage && !this.hubstudioPage.isClosed()) {
          rows = await this.fetchSummaryLogRows(this.hubstudioPage)
        } else {
          this.assertMexcRequestsAvailable()
          const outcome = await this.evaluateMexcPage(async () => {
            const response = await fetch('/api/platform/predict/asset/query/web/summaryLog?comboExclude=false&pageNum=1&pageSize=50', {
              headers: { accept: 'application/json' }, credentials: 'include',
              signal: AbortSignal.timeout(5_000)
            })
            let body: unknown
            try { body = await response.json() } catch { body = undefined }
            return {
              status: response.status,
              httpOk: response.ok,
              retryAfter: response.headers.get('retry-after') ?? undefined,
              body
            }
          })
          this.applyMexcResponseProtection(outcome)
          if (!outcome.httpOk) throw new Error(`MEXC history HTTP ${outcome.status}`)
          const body = outcome.body as { data?: { result?: MexcFillLogRow[] } }
          rows = body.data?.result ?? []
        }
        const receivedAt = Date.now()
        this.applyFeeCalibration(rows as MexcAssetLogRow[], receivedAt, false)
        this.applyInterceptedFillRows(rows, receivedAt)
        const fill = observer.current() ?? parseMexcFill(rows, match)
        if (fill) return measured(fill)
      } catch (error) {
        // The order is already submitted at this point. A transient timeout
        // from the history endpoint must not abort the whole two-leg state
        // machine immediately; keep listening for the intercepted page/WS
        // receipt and use the remaining bounded readback attempts.
        console.warn(
          `[MEXC成交核验] 第${restQueries}次查询失败，继续等待被动成交回报：` +
          `${error instanceof Error ? error.message : String(error)}`
        )
        const interceptedDuringQuery = observer.current()
        if (interceptedDuringQuery) return measured(interceptedDuringQuery)
      } finally {
        observer.stop()
      }
      const intercepted = await this.waitForInterceptedFill(match, Math.min(delay, Math.max(0, deadline - Date.now())))
      if (intercepted) return measured(intercepted)
    }
    const result = measured(await this.waitForInterceptedFill(match, Math.max(0, deadline - Date.now())))
    console.info(`[MEXC成交核验] ${result ? `已检测到成交 ${result.quantity}份` : '超时未检测到成交'}，耗时${Date.now() - readbackStartedAt}ms，REST查询${restQueries}次`)
    return result
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
    if (this.fingerprintRuntime?.isConfigured()) {
      if (await this.adoptFingerprintPage({ bringToFront: true, createIfMissing: true, refreshAccount: true })) {
        return this.status('已通过通用指纹浏览器运行时连接MEXC页面', true, this.hubstudioPage?.url())
      }
    }
    if (this.hubstudioPage && !this.hubstudioPage.isClosed()) {
      if (this.hubstudioConnectedContainerCode !== this.hubstudioContainerCode) {
        throw new Error(`当前仍连接Hubstudio环境 ${this.hubstudioConnectedContainerCode ?? '未知'}；请先关闭该环境或重启ArbDesk，再切换环境ID。`)
      }
      await this.hubstudioPage.bringToFront()
      await this.refreshHubstudioAuthentication()
      return this.status('Hubstudio MEXC窗口已连接', true, this.hubstudioPage.url())
    }
    if (this.hubstudioBrowser?.isConnected() && this.hubstudioConnectedContainerCode === this.hubstudioContainerCode) {
      const page = await this.bindHubstudioPage({ bringToFront: true, createIfMissing: true, refreshAccount: true })
      if (!page) throw new Error('Hubstudio已连接，但无法取得MEXC标签页')
      return this.status('Hubstudio MEXC标签页已恢复', true, page.url())
    }

    if (await this.tryAdoptRunningHubstudio(true, {
      bringToFront: true,
      createIfMissing: true,
      refreshAccount: true
    })) {
      return this.status('已接管正在运行的Hubstudio环境', true, this.hubstudioPage?.url())
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

    const page = await this.connectHubstudioBrowser(debuggingPort, {
      bringToFront: true,
      createIfMissing: true,
      refreshAccount: true
    })
    if (!page) throw new Error('Hubstudio环境已启动，但无法取得MEXC标签页')
    return this.status('Hubstudio环境已连接；请在该窗口中登录MEXC。', true, page.url())
  }

  private async tryAdoptRunningHubstudio(
    force: boolean,
    options: { bringToFront: boolean; createIfMissing: boolean; refreshAccount: boolean }
  ): Promise<boolean> {
    if (!this.hubstudioContainerCode || this.mode !== 'HUBSTUDIO') return false
    if (this.fingerprintRuntime?.isConfigured()) return await this.adoptFingerprintPage(options)
    if (this.hubstudioPage && !this.hubstudioPage.isClosed()) {
      if (options.bringToFront) await this.hubstudioPage.bringToFront()
      return true
    }
    if (this.hubstudioBrowser?.isConnected() && this.hubstudioConnectedContainerCode === this.hubstudioContainerCode) {
      const page = await this.bindHubstudioPage(options)
      if (page) {
        this.lastHubstudioConnectionError = undefined
        return true
      }
    }
    const now = Date.now()
    if (this.hubstudioPassiveConnectPromise) return await this.hubstudioPassiveConnectPromise
    if (!canAttemptHubstudioReconnect(this.lastHubstudioPassiveConnectAt, now, force)) return false
    this.lastHubstudioPassiveConnectAt = now
    this.hubstudioPassiveConnectPromise = (async () => {
      try {
        const debuggingPort = await this.resolveRunningHubstudioDebuggingPort()
        if (!Number.isInteger(debuggingPort) || debuggingPort <= 0) {
          this.lastHubstudioConnectionError = '指定环境尚未运行或调试端口尚未就绪'
          return false
        }
        const page = await this.connectHubstudioBrowser(debuggingPort, options)
        if (!page) {
          this.lastHubstudioConnectionError = '环境已运行，等待现有MEXC页面出现'
          return false
        }
        this.lastHubstudioConnectionError = undefined
        return true
      } catch (error) {
        this.lastHubstudioConnectionError = error instanceof Error ? error.message : String(error)
        return false
      }
    })().finally(() => {
      this.hubstudioPassiveConnectPromise = undefined
    })
    return await this.hubstudioPassiveConnectPromise
  }

  private async adoptFingerprintPage(options: { bringToFront: boolean; createIfMissing: boolean; refreshAccount: boolean }): Promise<boolean> {
    try {
      const page = await this.fingerprintRuntime!.attach('MEXC', {
        hosts: ['prediction.mexc.com', 'mexc.com'],
        createIfMissing: options.createIfMissing,
        startupUrl: MEXC_URL
      })
      this.hubstudioPage = page
      this.hubstudioBrowser = page.context().browser() ?? undefined
      this.hubstudioConnectedContainerCode = this.hubstudioContainerCode
      this.hubstudioDebuggingPort = undefined
      this.instrumentHubstudioPage(page)
      this.adoptExistingHubstudioOrderPages(page.context().pages())
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
      if (options.bringToFront) await page.bringToFront()
      this.startHubstudioMonitoring()
      await this.refreshHubstudioAuthentication()
      if (options.refreshAccount) {
        await this.refreshAccountState().catch(() => undefined)
        this.lastHubstudioAccountRefreshAt = Date.now()
      }
      this.lastHubstudioConnectionError = undefined
      return true
    } catch (error) {
      this.lastHubstudioConnectionError = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  private async connectHubstudioBrowser(
    debuggingPort: number,
    options: { bringToFront: boolean; createIfMissing: boolean; refreshAccount: boolean }
  ): Promise<Page | undefined> {
    const { chromium } = await import('playwright-core')
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`)
    this.hubstudioBrowser = browser
    this.hubstudioDebuggingPort = debuggingPort
    this.hubstudioConnectedContainerCode = this.hubstudioContainerCode
    browser.on('disconnected', () => {
      if (this.hubstudioBrowser === browser) this.clearHubstudioConnection()
    })
    return await this.bindHubstudioPage(options)
  }

  private async bindHubstudioPage(options: {
    bringToFront: boolean
    createIfMissing: boolean
    refreshAccount: boolean
  }): Promise<Page | undefined> {
    const context = this.hubstudioBrowser?.contexts()[0]
    if (!context) throw new Error('无法取得Hubstudio浏览器上下文')
    const pages = context.pages()
    let page = pages.find((candidate) => candidate.url().includes('prediction.mexc.com'))
    if (!page && options.createIfMissing) {
      page = pages.find((candidate) => candidate.url().includes('mexc.com')) ?? await context.newPage()
      if (!page.url().includes('prediction.mexc.com')) await page.goto(MEXC_URL)
    }
    if (!page) return undefined
    this.hubstudioPage = page
    this.instrumentHubstudioPage(page)
    this.adoptExistingHubstudioOrderPages(context.pages())
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
    if (options.bringToFront) await page.bringToFront()
    this.startHubstudioMonitoring()
    await this.refreshHubstudioAuthentication()
    if (options.refreshAccount) {
      await this.refreshAccountState().catch(() => undefined)
      this.lastHubstudioAccountRefreshAt = Date.now()
    }
    return page
  }

  private adoptExistingHubstudioOrderPages(pages: Page[]): void {
    for (const page of pages) {
      if (page.isClosed()) continue
      const duration = hubstudioMarketDuration(page.url())
      if (!duration) continue
      this.instrumentHubstudioPage(page)
      this.hubstudioOrderPages.set(duration, page)
      if (this.trackedHubstudioOrderPages.has(page)) continue
      this.trackedHubstudioOrderPages.add(page)
      page.on('close', () => {
        if (this.hubstudioOrderPages.get(duration) === page) this.hubstudioOrderPages.delete(duration)
      })
    }
  }

  private marketTargetFromEvent(event: MexcRawEvent, origin: string): { eventId: string; url: string } | undefined {
    if (!event.id || !event.en) return undefined
    const slug = event.en
      .toLowerCase()
      .replaceAll(',', '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
    return { eventId: String(event.id), url: `${origin}/prediction-markets/up-down/${slug}/${event.id}` }
  }

  private async warmHubstudioOrderPages(events: MexcRawEvent[]): Promise<void> {
    const context = this.hubstudioBrowser?.contexts()[0]
    const monitorPage = this.hubstudioPage
    if (!context || !monitorPage || monitorPage.isClosed()) return
    this.adoptExistingHubstudioOrderPages(context.pages())
    const origin = new URL(monitorPage.url()).origin
    await Promise.all(events.map(async (event) => {
      const duration = Number(event.sp) === 300 ? 5 as const : Number(event.sp) === 900 ? 15 as const : undefined
      const target = this.marketTargetFromEvent(event, origin)
      if (!duration || !target) return
      let page = this.hubstudioOrderPages.get(duration)
      if (!page || page.isClosed()) {
        page = context.pages().find((candidate) =>
          !candidate.isClosed() &&
          candidate.url().includes(`/prediction-markets/up-down/btc-${duration}min-`)
        ) ?? await context.newPage()
        this.hubstudioOrderPages.set(duration, page)
        this.instrumentHubstudioPage(page)
        page.on('close', () => {
          if (this.hubstudioOrderPages.get(duration) === page) this.hubstudioOrderPages.delete(duration)
        })
      }
      if (!page.url().endsWith(`/${target.eventId}`)) {
        await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      }
      await this.installMexcFetchJson(page).catch(() => undefined)
      await page.locator('[data-tutorial-id="detail-tutorial-amount"] input, input[placeholder="0"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
    }))
  }

  private hubstudioExecutionPage(durationMinutes?: MarketDuration): Page | undefined {
    if (durationMinutes === 5 || durationMinutes === 15) {
      const warmed = this.hubstudioOrderPages.get(durationMinutes)
      if (warmed && !warmed.isClosed()) return warmed
    }
    return this.hubstudioPage && !this.hubstudioPage.isClosed() ? this.hubstudioPage : undefined
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
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const urlBefore = page.url()
        try {
          const result = await page.evaluate(fn as never, argument as never) as T
          return result
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const navigationRace = /execution context was destroyed|most likely because of a navigation|frame was detached|target page, context or browser has been closed/i.test(message)
          if (!navigationRace || attempt === 1 || page.isClosed()) throw error
          console.warn(`[MEXC读取] 页面导航竞态，等待页面稳定后重试：${urlBefore} -> ${page.url()}`)
          await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => undefined)
          await new Promise((resolve) => setTimeout(resolve, 350))
        }
      }
      throw new Error('MEXC页面读取重试失败')
    }
    const window = this.embeddedWindow
    if (!window || window.isDestroyed()) throw new Error('内嵌MEXC页面不可用')
    return await window.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(argument)})`)
  }

  /**
   * 页面内fetch的常驻通道。Hubstudio容器的CDP是远程连接，page.evaluate每次
   * 都要把整段函数体序列化传输，单轮往返约1秒；首次调用把__arbFetchJson装进
   * 页面后，后续每轮只传小参数，把直连下单和成交轮询的往返降到百毫秒级。
   * 页面跳转后注入会丢失：结果为空或异常时清掉标记并走一次性注入回退，
   * 下一轮自动重装。fetch仍完全运行在页面上下文里（cookie/指纹与手动一致）。
   */
  private async evaluateMexcFetchJson(
    page: Page,
    url: string,
    init: MexcFetchInit
  ): Promise<MexcFetchOutcome> {
    this.assertMexcRequestsAvailable()
    const oneShot = async (): Promise<MexcFetchOutcome> => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await page.evaluate(async (argument: { url: string; init: MexcFetchInit }) => {
            const response = await fetch(argument.url, {
              method: argument.init.method ?? 'GET',
              credentials: 'include',
              headers: { accept: 'application/json', ...(argument.init.headers ?? {}) },
              body: argument.init.body,
              signal: argument.init.timeoutMs ? AbortSignal.timeout(argument.init.timeoutMs) : undefined
            })
            let body: unknown
            try { body = await response.json() } catch { body = undefined }
            return { status: response.status, httpOk: response.ok, retryAfter: response.headers.get('retry-after') ?? undefined, body }
          }, { url, init })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const navigationRace = /execution context was destroyed|most likely because of a navigation|frame was detached|target page, context or browser has been closed/i.test(message)
          if (!navigationRace || attempt === 1 || page.isClosed()) throw error
          await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => undefined)
          await new Promise((resolve) => setTimeout(resolve, 350))
        }
      }
      throw new Error('MEXC页面请求重试失败')
    }
    if (!this.arbFetchJsonPages.has(page)) {
      try {
        await this.installMexcFetchJson(page)
      } catch {
        const result = await oneShot()
        this.applyMexcResponseProtection(result)
        return result
      }
    }
    try {
      const result = await page.evaluate((argument: { url: string; init: MexcFetchInit }) => {
        const scope = window as unknown as {
          __arbFetchJson?: (url: string, init: MexcFetchInit) => Promise<MexcFetchOutcome>
        }
        return scope.__arbFetchJson?.(argument.url, argument.init)
      }, { url, init })
      if (result) {
        this.applyMexcResponseProtection(result)
        return result
      }
    } catch { /* 回落到一次性注入 */ }
    this.arbFetchJsonPages.delete(page)
    const result = await oneShot()
    this.applyMexcResponseProtection(result)
    return result
  }

  private assertMexcRequestsAvailable(): void {
    const remainingMs = this.mexcRequestsBlockedUntil - Date.now()
    if (remainingMs <= 0) return
    throw new Error(`MEXC请求保护已触发，暂停自动请求约${Math.ceil(remainingMs / 1_000)}秒；不会自动重试下单`)
  }

  private applyMexcResponseProtection(outcome: Pick<MexcFetchOutcome, 'status' | 'retryAfter'>): void {
    if (outcome.status !== 403 && outcome.status !== 429) return
    const retryAfterMs = this.parseRetryAfterMs(outcome.retryAfter)
    const fallback = outcome.status === 429 ? MEXC_RATE_LIMIT_COOLDOWN_MS : MEXC_FORBIDDEN_COOLDOWN_MS
    this.mexcRequestsBlockedUntil = Math.max(this.mexcRequestsBlockedUntil, Date.now() + (retryAfterMs ?? fallback))
  }

  private parseRetryAfterMs(value: string | undefined): number | undefined {
    if (!value) return undefined
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1_000, seconds * 1_000)
    const dateMs = Date.parse(value)
    return Number.isFinite(dateMs) ? Math.max(1_000, dateMs - Date.now()) : undefined
  }

  private async installMexcFetchJson(page: Page): Promise<void> {
    const install = (): void => {
      const scope = window as unknown as {
          __arbFetchJson?: (url: string, init: MexcFetchInit) => Promise<MexcFetchOutcome>
      }
      if (scope.__arbFetchJson) return
      scope.__arbFetchJson = async (url, init) => {
        const response = await fetch(url, {
          method: init.method ?? 'GET',
          credentials: 'include',
          headers: { accept: 'application/json', ...(init.headers ?? {}) },
          body: init.body,
          signal: init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined
        })
        let body: unknown
        try { body = await response.json() } catch { body = undefined }
        return { status: response.status, httpOk: response.ok, retryAfter: response.headers.get('retry-after') ?? undefined, body }
      }
    }
    if (!this.arbFetchInitScriptPages.has(page)) {
      await page.addInitScript(install)
      this.arbFetchInitScriptPages.add(page)
    }
    await page.evaluate(install)
    this.arbFetchJsonPages.add(page)
  }

  private instrumentHubstudioPage(page: Page): void {
    if (this.instrumentedHubstudioPages.has(page)) return
    this.instrumentedHubstudioPages.add(page)
    void this.installMexcFetchJson(page).catch(() => undefined)
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
      if (/\/api\/platform\/predict\/market\/web\/symbolsV2/.test(responseUrl)) {
        // 页面自己会定期拉symbolsV2，白嫖它的响应更新缓存：
        // 零额外请求，还顺带刷新7分钟主动预热的计时钟。
        void response.json().then((body: { data?: { symbols?: Record<string, Array<{ id?: string; cd?: string; mcd?: string }>> } }) => {
          const byId = new Map<string, { cd: string; mcd: string }>()
          for (const items of Object.values(body.data?.symbols ?? {})) {
            for (const item of items) {
              if (item.id && item.cd && item.mcd) byId.set(item.id, { cd: item.cd, mcd: item.mcd })
            }
          }
          if (byId.size > 0) this.symbolCurrencyMap = { receivedAt: Date.now(), byId }
        }).catch(() => undefined)
      }
      if (/\/api\/platform\/predict\/market\/web\/event\/index\/price\/range/.test(responseUrl)) {
        void response.json().then((body: MexcRawIndexRange) => {
          const latest = (body.data ?? [])
            .filter((point) => Number(point.p) > 0 && Number(point.ts) > 0)
            .sort((left, right) => Number(right.ts) - Number(left.ts))[0]
          if (!latest?.p) return
          const latestAt = normalizeSourceTimestamp(latest.ts)
          if (latestAt) this.applyMexcIndex(String(latest.p), latestAt)
        }).catch(() => undefined)
      }
      if (/\/api\/platform\/predict\/asset\/query\/web\/summaryLog/.test(responseUrl)) {
        const query = new URL(responseUrl).searchParams
        if (Number(query.get('pageNum') ?? '1') !== 1) return
        const allowUnpairedBuyAsZero = Number(query.get('pageSize') ?? '0') >= 100
        void response.json().then((body: { data?: { result?: Array<MexcAssetLogRow & MexcFillLogRow> } }) => {
          const rows = body.data?.result ?? []
          const receivedAt = Date.now()
          this.applyFeeCalibration(rows, receivedAt, allowUnpairedBuyAsZero)
          this.applyInterceptedFillRows(rows, receivedAt)
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

  private applyInterceptedFillRows(rows: MexcFillLogRow[], receivedAt: number): void {
    this.latestFillRows = { rows, receivedAt }
    for (const listener of this.fillRowListeners) listener(rows)
  }

  private observeInterceptedFill(match: MexcFillMatch): {
    current: () => import('../../shared/types').Fill | undefined
    stop: () => void
  } {
    let fill = this.latestFillRows ? parseMexcFill(this.latestFillRows.rows, match) : undefined
    const listener = (rows: MexcFillLogRow[]): void => {
      fill ??= parseMexcFill(rows, match)
    }
    this.fillRowListeners.add(listener)
    return {
      current: () => fill,
      stop: () => this.fillRowListeners.delete(listener)
    }
  }

  private async waitForInterceptedFill(match: MexcFillMatch, timeoutMs: number): Promise<import('../../shared/types').Fill | undefined> {
    const cached = this.latestFillRows
    if (cached) {
      const fill = parseMexcFill(cached.rows, match)
      if (fill) return fill
    }
    return await new Promise((resolve) => {
      let settled = false
      const finish = (fill?: import('../../shared/types').Fill): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.fillRowListeners.delete(listener)
        resolve(fill)
      }
      const listener = (rows: MexcFillLogRow[]): void => {
        const fill = parseMexcFill(rows, match)
        if (fill) finish(fill)
      }
      const timer = setTimeout(() => finish(), Math.max(0, timeoutMs))
      this.fillRowListeners.add(listener)
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
      if (event.response.opcode !== 2) return
      const receivedAt = Date.now()
      this.hubstudioBinaryFrameCount += 1
      this.lastHubstudioBinaryFrameAt = receivedAt
      const decoded = decodeMexcPredictionFrame(Buffer.from(event.response.payloadData, 'base64'))
      // CDP may attach after a WebSocket was created, so its URL is not
      // necessarily present in hubstudioSocketUrls. Trust the decoded
      // protobuf channel instead of dropping valid predict@ frames solely
      // because the creation event was missed. Non-predict sockets still
      // fail closed because the decoder returns undefined for them.
      if (!decoded || !decoded.channel.startsWith('predict@')) return
      this.hubstudioPredictFrameCount += 1
      this.confirmMexcPredictionFreshness(receivedAt)
      if (decoded.depth) {
        this.hubstudioDepthFrameCount += 1
        this.lastHubstudioDepthFrameAt = receivedAt
        this.lastHubstudioDepthSymbolId = decoded.depth.symbolId
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
      if (decoded.index) {
        this.hubstudioIndexFrameCount += 1
        this.applyMexcIndex(decoded.index.price, receivedAt)
      }
    })
  }

  private async syncHubstudioPredictionSubscriptions(): Promise<void> {
    if (this.hubstudioPredictionSyncPromise) return await this.hubstudioPredictionSyncPromise
    this.hubstudioPredictionSyncPromise = this.syncHubstudioPredictionSubscriptionsInternal()
    try {
      await this.hubstudioPredictionSyncPromise
    } finally {
      this.hubstudioPredictionSyncPromise = undefined
    }
  }

  private async syncHubstudioPredictionSubscriptionsInternal(): Promise<void> {
    const page = this.hubstudioPage
    const targets = [...this.hubstudioPredictionTargets.entries()]
    if (!page || page.isClosed() || (this.latestWindows.length === 0 && targets.length === 0)) return
    const channels = [
      ...new Set(targets.flatMap(([duration, target]) => [
        `predict@public.depth.scale.pb@${target.upSymbolId}@0.01@30`,
        `predict@public.depth.scale.pb@${target.downSymbolId}@0.01@30`,
        `predict@public.index.realtime.period.pb@BTC@${duration * 60}`
      ]))
    ].sort()
    if (channels.length === 0) return
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
    if (this.latestMexcIndex?.price === price) {
      const shouldNotify = receivedAt - this.latestMexcIndex.receivedAt >= MEXC_FRESHNESS_NOTIFY_THROTTLE_MS
      this.latestMexcIndex = { price, receivedAt }
      if (!shouldNotify) {
        for (const window of this.latestWindows) {
          window.indexPrice = price
          window.indexReceivedAt = receivedAt
        }
        return
      }
      this.latestWindows = this.latestWindows.map((window) => ({
        ...window,
        indexPrice: price,
        indexReceivedAt: receivedAt
      }))
      for (const listener of this.marketDataListeners) listener()
      return
    }
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
    // Do not notify/render or refresh every outcome for generic predict frames.
    // applyInterceptedDepth updates exactly the symbol carried by a depth frame.
  }

  private applyFeeCalibration(
    rows: MexcAssetLogRow[],
    receivedAt: number,
    allowUnpairedBuyAsZero: boolean
  ): void {
    for (const row of rows) {
      if (!row.tn) continue
      const key = `${row.tn}:${String(row.bt ?? '')}:${String(row.ta ?? '')}:${String(row.tt ?? '')}`
      this.feeRows.set(key, row)
    }
    const oldestAllowed = receivedAt - 7 * 24 * 60 * 60 * 1_000
    for (const [key, row] of this.feeRows) {
      const timestamp = Number(row.tt)
      const normalized = timestamp > 0 && timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp
      if (!Number.isFinite(normalized) || normalized < oldestAllowed) this.feeRows.delete(key)
    }
    const previous = this.cachedFeeCalibration
    const calibration = updateMexcFeeCalibrationCache(
      previous,
      [...this.feeRows.values()],
      receivedAt,
      MEXC_FEE_CACHE_MS,
      allowUnpairedBuyAsZero
    )
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
      const command = process.platform === 'win32' ? 'netstat' : 'lsof'
      const args = process.platform === 'win32'
        ? ['-ano', '-p', 'TCP']
        : ['-Pan', '-p', String(pid), '-iTCP', '-sTCP:LISTEN']
      const result = await execFileAsync(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
      output = String(result.stdout)
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

  // symbolsV2 提供 symbolId(事件里的si) → currencyId(cd)/marketCurrencyId(mcd) 的映射，
  // 是下单接口必填currencyId的唯一来源。响应约5MB，不能在热路径刷新：
  // 缓存10分钟，盘中出现新si（开盘滚动）才是真正的刷新时机。
  private async fetchSymbolCurrencyMap(force = false): Promise<Map<string, { cd: string; mcd: string }> | undefined> {
    const now = Date.now()
    if (!force && this.symbolCurrencyMap && now - this.symbolCurrencyMap.receivedAt < 600_000) {
      return this.symbolCurrencyMap.byId
    }
    // 已有后台刷新在跑就等它复用（含热路径强制刷新场景），
    // 绝不并发第二个5MB请求。注：prewarm先调用本方法再赋值promise，
    // 同步段读到undefined，不会自等待死锁。
    if (this.symbolCurrencyMapRefreshPromise) {
      await this.symbolCurrencyMapRefreshPromise
      return this.symbolCurrencyMap?.byId
    }
    try {
      this.assertMexcRequestsAvailable()
      const outcome = await this.evaluateMexcPage(async (timeoutMs: number) => {
        const response = await fetch('/api/platform/predict/market/web/symbolsV2', {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs)
        })
        let rows: Array<{ id: string; cd: string; mcd: string }> = []
        if (!response.ok) return {
          status: response.status,
          httpOk: false,
          retryAfter: response.headers.get('retry-after') ?? undefined,
          rows
        }
        const body = await response.json() as {
          data?: { symbols?: Record<string, Array<{ id?: string; cd?: string; mcd?: string }>> }
        }
        rows = []
        for (const items of Object.values(body.data?.symbols ?? {})) {
          for (const item of items) {
            if (item.id && item.cd && item.mcd) rows.push({ id: item.id, cd: item.cd, mcd: item.mcd })
          }
        }
        return {
          status: response.status,
          httpOk: response.ok,
          retryAfter: response.headers.get('retry-after') ?? undefined,
          rows
        }
      }, MEXC_SYMBOL_MAP_TIMEOUT_MS)
      this.applyMexcResponseProtection(outcome)
      const rows = outcome.rows
      if (!Array.isArray(rows) || rows.length === 0) return this.symbolCurrencyMap?.byId
      const byId = new Map(rows.map((row) => [row.id, { cd: row.cd, mcd: row.mcd }]))
      this.symbolCurrencyMap = { receivedAt: Date.now(), byId }
      return byId
    } catch {
      return this.symbolCurrencyMap?.byId
    }
  }

  // MEXC网页端签名（已用真实抓包复算验证）：
  //   salt = md5(uc_token + nonce).substring(7)
  //   e    = 请求体按key排序后的urlencoded串
  //   sign = md5(nonce + e + salt)，随 x-mxc-nonce / x-mxc-sign 头发送。
  private buildMexcSignedHeaders(token: string, payload: Record<string, string>): Record<string, string> {
    const nonce = String(Date.now())
    const md5 = (value: string): string => createHash('md5').update(value).digest('hex')
    const salt = md5(token + nonce).substring(7)
    const sorted = Object.keys(payload).sort()
    const e = new URLSearchParams(sorted.map((key) => [key, payload[key]])).toString()
    return {
      'x-mxc-nonce': nonce,
      'x-mxc-sign': md5(nonce + e + salt)
    }
  }

  private async trySubmitHubstudioOrderDirect(page: Page, request: PrepareOrderRequest): Promise<AutomationResult | undefined> {
    const eventId = String(request.eventId ?? '')
    const event = (this.interceptedEvents?.events ?? [])
      .find((candidate) => String(candidate.id ?? '') === eventId)
    const outcome = (event?.ers ?? [])
      .find((candidate) => String(candidate.rn ?? '').toUpperCase() === request.direction)
    if (!outcome) return undefined
    const symbolId = String(outcome.si ?? '')
    if (!symbolId) return undefined
    const currencyMappingStartedAt = Date.now()
    const currency = (await this.fetchSymbolCurrencyMap())?.get(symbolId)
      // 仅当上面的调用确实用了旧缓存（而非刚拉取过）时才强制重拉，
      // 避免热路径上背靠背两次5MB请求（曾造成29秒卡顿）。
      ?? (Date.now() - (this.symbolCurrencyMap?.receivedAt ?? 0) >= 5_000
        ? (await this.fetchSymbolCurrencyMap(true))?.get(symbolId)
        : undefined)
    const currencyMappingMs = Date.now() - currencyMappingStartedAt
    if (!currency) return undefined
    // 逐档深度检查：卖档从低到高累计可成交金额，提交价=恰好覆盖下单金额的那一档。
    // 旧逻辑只报最优档价，多档计划会被价格保护截断成部分成交（申请10成交8.46的根因）。
    // 深度不足时不放弃整单：FAK按可成交部分成交，Polymarket按实际成交量对冲（少赚也是赚）；
    // 但盘口整体超过保护价时只按保护价提交，绝不买贵。
    const asks = (this.interceptedDepth.get(symbolId)?.data?.asks ?? [])
      .map((level) => ({ price: String(level.p ?? ''), size: Number(level.q) }))
      .filter((level) => Number(level.price) > 0 && Number(level.price) < 1 && Number.isFinite(level.size) && level.size > 0)
      .sort((left, right) => Number(left.price) - Number(right.price))
    let price = String(outcome.ap ?? '')
    if (asks.length > 0) {
      const cap = Number(request.maximumPrice) > 0 ? Number(request.maximumPrice) : Number.POSITIVE_INFINITY
      const spendAmount = Number(request.amount)
      let cumulativeCost = 0
      let walkedPrice = ''
      for (const level of asks) {
        if (Number(level.price) > cap) break
        cumulativeCost += Number(level.price) * level.size
        walkedPrice = level.price
        if (cumulativeCost >= spendAmount) break
      }
      if (walkedPrice) {
        price = walkedPrice
        if (cumulativeCost < spendAmount) {
          console.info(`[MEXC深度检查] 保护价${request.maximumPrice}内约可成交${cumulativeCost.toFixed(2)} USDT < 下单${request.amount} USDT；按FAK部分成交处理，Polymarket按实际成交量对冲`)
        }
      } else if (Number(request.maximumPrice) > 0) {
        // 盘口已整体超过保护价：按保护价提交，撮不到就不成交，不追价。
        price = String(request.maximumPrice)
      }
    }
    if (!price) return undefined
    const cookieReadStartedAt = Date.now()
    const cookies = await page.context().cookies(['https://prediction.mexc.com'])
    const cookieReadMs = Date.now() - cookieReadStartedAt
    const token = cookies.find((cookie) => cookie.name === 'uc_token')?.value
      ?? cookies.find((cookie) => cookie.name === 'u_id')?.value
    if (!token) return undefined
    const payload: Record<string, string> = {
      currencyId: currency.cd,
      marketCurrencyId: currency.mcd || MEXC_USDT_COIN_ID,
      tradeType: 'BUY',
      price,
      orderType: 'MARKET_ORDER',
      orderSource: 'WEB',
      amount: String(request.amount)
    }
    const signedHeaders = this.buildMexcSignedHeaders(token, payload)
    const submittedAt = Date.now()
    let outcome2: { status: number; httpOk: boolean; body: unknown }
    try {
      // 常驻通道：请求仍由页面上下文发出（cookie/指纹与手动一致），省掉函数体序列化。
      outcome2 = await this.evaluateMexcFetchJson(page, 'https://prediction.mexc.com/api/platform/predict/orderCenter/web/order/place/market', {
        method: 'POST',
        // A remote Hubstudio page can leave fetch pending indefinitely when
        // its network tunnel stalls. Bound the request so the execution state
        // becomes explicitly uncertain instead of remaining STARTED forever.
        timeoutMs: 8_000,
        headers: {
          accept: '*/*',
          'content-type': 'application/json',
          language: 'en-US',
          platform: 'WEB',
          ...signedHeaders
        },
        body: JSON.stringify(payload)
      })
    } catch (error) {
      // 请求可能已到达服务器但响应丢失，重试有重复下单风险，按“结果不确定”上报。
      return {
        ok: false,
        submissionUncertain: true,
        submittedAt,
        responseAt: Date.now(),
        currencyMappingMs,
        cookieReadMs,
        postMs: Date.now() - submittedAt,
        message: `MEXC直连下单网络异常：${error instanceof Error ? error.message : String(error)}；为避免重复下单不再改走页面操作`,
        matched: {}
      }
    }
    const responseAt = Date.now()
    const record = outcome2.body && typeof outcome2.body === 'object' ? outcome2.body as Record<string, unknown> : undefined
    const responseCode = Number(record?.code)
    const orderAccepted = outcome2.httpOk && (responseCode === 0 || responseCode === 200 || record?.success === true)
    const orderResponseUrl = 'https://prediction.mexc.com/api/platform/predict/orderCenter/web/order/place/market'
    const orderRequestBody = JSON.stringify(payload)
    const orderResponseBody = record === undefined ? '' : JSON.stringify(outcome2.body)
    if (record === undefined) {
      return {
        ok: false,
        submissionUncertain: true,
        submittedAt,
        responseAt,
        orderResponseUrl,
        orderRequestBody,
        currencyMappingMs,
        cookieReadMs,
        postMs: responseAt - submittedAt,
        message: 'MEXC直连下单返回非JSON响应，接收状态不确定；不再改走页面操作',
        matched: {}
      }
    }
    if (!orderAccepted) {
      const reason = String(record?.msg ?? record?.message ?? `HTTP ${outcome2.status}`)
      const codeText = Number.isFinite(responseCode) ? `code=${responseCode}` : `HTTP=${outcome2.status}`
      const cachedBalance = this.latestAccountState?.availableUsdt
      const balanceText = cachedBalance === undefined ? '余额快照=未读取' : `余额快照=${cachedBalance} USDT`
      // Rejections are the only responses that previously did not leave a
      // useful console trace.  Keep the body intact in the audit result and
      // print the non-secret request facts needed to distinguish balance,
      // stale-market and symbol-mapping failures on the next attempt.
      console.error(
        `[MEXC直连下单拒绝] ${codeText} msg=${reason} ` +
        `eventId=${eventId} symbolId=${symbolId} direction=${request.direction} ` +
        `amount=${request.amount} price=${price} ${balanceText} ` +
        `timing=${JSON.stringify({ currencyMappingMs, cookieReadMs, postMs: responseAt - submittedAt, totalMs: responseAt - currencyMappingStartedAt })} ` +
        `响应=${orderResponseBody}`
      )
      return {
        ok: false,
        orderAccepted: false,
        submittedAt,
        responseAt,
        orderResponseUrl,
        orderRequestBody,
        orderResponseBody,
        currencyMappingMs,
        cookieReadMs,
        postMs: responseAt - submittedAt,
        message: `MEXC直连下单被拒绝（${codeText}）：${reason}；未启动第二腿对冲`,
        matched: {}
      }
    }
    console.info(`[MEXC直连下单] ${JSON.stringify({ orderResponseUrl, eventId, symbolId, direction: request.direction, currencyMappingMs, cookieReadMs, postMs: responseAt - submittedAt, totalMs: responseAt - currencyMappingStartedAt })} 请求=${orderRequestBody} 响应=${orderResponseBody}`)
    return {
      ok: true,
      orderAccepted: true,
      submittedAt,
      responseAt,
      orderResponseUrl,
      orderRequestBody,
      orderResponseBody,
      currencyMappingMs,
      cookieReadMs,
      postMs: responseAt - submittedAt,
      // place响应data即订单号，与成交流水行的si字段一致，用于精确匹配成交。
      orderId: typeof record?.data === 'string' ? record.data : undefined,
      message: 'MEXC直连下单已确认接收（跳过页面操作），正在等待该笔实际成交',
      matched: {}
    }
  }

  private async prepareHubstudioOrder(request: PrepareOrderRequest): Promise<AutomationResult> {
    const page = this.hubstudioExecutionPage(request.durationMinutes)
    if (!page || page.isClosed()) return { ok: false, message: 'Hubstudio MEXC页面不可用', matched: {} }
    if (!Number.isFinite(Number(request.amount)) || Number(request.amount) <= 0) {
      return { ok: false, message: 'MEXC下单金额必须是大于0的数字；未操作网页', matched: {} }
    }
    if (request.allowSubmit && Number(request.amount) < 1) {
      return { ok: false, message: `MEXC下单金额${request.amount} USDT低于当前1 USDT最小值；未点击买入`, matched: {} }
    }
    // 直连下单：字段映射已验证时直接POST下单API，跳过全部UI操作
    // （切盘、点方向、填金额、等按钮），约省1.4s；解析不了则回退UI自动化。
    if (request.allowSubmit && request.eventId) {
      const directStartedAt = Date.now()
      const direct = await this.trySubmitHubstudioOrderDirect(page, request)
      if (direct) {
        console.info(`[MEXC下单] 直连接口路径完成，耗时${Date.now() - directStartedAt}ms`)
        return direct
      }
      console.warn(`[MEXC下单] 直连接口未使用，耗时${Date.now() - directStartedAt}ms；回退网页控件路径`)
    }
    if (request.durationMinutes && request.startTime) {
      try {
        await this.ensureHubstudioLiveMarket(page, request.durationMinutes, request.startTime, request.eventId)
      } catch (error) {
        return {
          ok: false,
          message: `无法切换到对应的实时盘：${error instanceof Error ? error.message : String(error)}；未填写或提交订单`,
          matched: {}
        }
      }
    }
    const pageReadyAt = Date.now()
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
      await this.waitForHubstudioOrderPanel(page, selectors.amountInput, selectors.submitButton, request.direction, 'BUY', false, 1_200)
      const directionReadyAt = Date.now()

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
      await this.waitForHubstudioOrderPanel(page, selectors.amountInput, selectors.submitButton, request.direction, 'BUY', true, 1_200)
      submitButton = await this.resolveHubstudioLocator(page, selectors.submitButton, automatic([
        page.getByRole('button', { name: submitPattern }).first()
      ]))
      matched.submitEnabled = Boolean(submitButton && await submitButton.isEnabled().catch(() => false))
      matched.submitButton = Boolean(submitButton)
      if (!submitButton) {
        return { ok: false, message: '填入金额后MEXC买入按钮节点消失；未点击', matched }
      }
      if (request.allowSubmit && !matched.submitEnabled) {
        return {
          ok: false,
          pageReadyAt,
          directionReadyAt,
          message: `已填入${request.amount} USDT并监听按钮状态，但MEXC买入仍不可用；未点击`, matched
        }
      }
      const buttonReadyAt = Date.now()
      if (!request.allowSubmit) {
        await Promise.all([
          this.highlightHubstudio(amountInput),
          this.highlightHubstudio(directionButton!),
          this.highlightHubstudio(submitButton)
        ])
      }
      let orderAccepted = false
      let submittedAt: number | undefined
      let responseAt: number | undefined
      let orderCapture: { orderResponseUrl: string; orderRequestBody: string; orderResponseBody: string } | undefined
      if (request.allowSubmit) {
        submittedAt = Date.now()
        const orderResponsePromise = page.waitForResponse(
          (response) => /\/api\/platform\/predict\/orderCenter\/web\/order\/place\/(?:market|limit)/.test(response.url()),
          { timeout: 8_000 }
        ).catch(() => undefined)
        await submitButton.click()
        const orderResponse = await orderResponsePromise
        responseAt = Date.now()
        if (!orderResponse) {
          return {
            ok: false,
            orderAccepted: false,
            pageReadyAt,
            directionReadyAt,
            buttonReadyAt,
            submittedAt,
            responseAt,
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
        const orderCaptureValue = {
          orderResponseUrl: orderResponse.url(),
          orderRequestBody: orderResponse.request().postData() ?? '',
          orderResponseBody: responseBody === undefined ? '' : JSON.stringify(responseBody)
        }
        orderCapture = orderCaptureValue
        console.info(
          `[MEXC下单接口] ${orderCaptureValue.orderResponseUrl} 请求=${orderCaptureValue.orderRequestBody} 响应=${orderCaptureValue.orderResponseBody}`
        )
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
            pageReadyAt,
            directionReadyAt,
            buttonReadyAt,
            submittedAt,
            responseAt,
            submissionUncertain: false,
            message: `MEXC下单接口未确认成功：${reason}；未启动第二腿对冲`,
            matched,
            ...orderCapture
          }
        }
      }
      await this.refreshHubstudioAuthentication()
      return {
        ok: true,
        orderAccepted,
        pageReadyAt,
        directionReadyAt,
        buttonReadyAt,
        submittedAt,
        responseAt,
        message: request.allowSubmit
          ? 'MEXC下单接口已确认接收，正在等待该笔实际成交'
          : '已在Hubstudio中自动选择涨跌并填入金额，买入按钮已高亮，等待人工确认',
        matched,
        orderResponseUrl: orderCapture?.orderResponseUrl,
        orderRequestBody: orderCapture?.orderRequestBody,
        orderResponseBody: orderCapture?.orderResponseBody
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
    const page = this.hubstudioExecutionPage(request.durationMinutes)
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
      const sellModeCandidate = page.getByRole('button', { name: /^(?:卖出|sell)$/i }).first()
      const sellModeTabCandidate = page.getByRole('tab', { name: /^(?:卖出|sell)$/i }).first()
      await Promise.race([
        sellModeCandidate.waitFor({ state: 'visible', timeout: 1_200 }),
        sellModeTabCandidate.waitFor({ state: 'visible', timeout: 1_200 })
      ]).catch(() => undefined)
      const refreshedSellModeButton = await this.resolveHubstudioLocator(page, undefined, [
        sellModeCandidate,
        sellModeTabCandidate
      ])
      if (!refreshedSellModeButton) return { ok: false, message: '切换方向后未识别MEXC卖出入口；未执行卖出', matched }
      await refreshedSellModeButton.click()
      await this.waitForHubstudioOrderPanel(page, undefined, undefined, request.direction, 'SELL', false, 1_200)

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
      await this.waitForHubstudioOrderPanel(page, undefined, undefined, request.direction, 'SELL', true, 1_200)
      submitButton = await this.resolveHubstudioLocator(page, undefined, [
        page.getByRole('button', { name: submitPattern }).first()
      ])
      matched.submitEnabled = Boolean(submitButton && await submitButton.isEnabled().catch(() => false))
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

  private async ensureHubstudioLiveMarket(
    page: Page,
    durationMinutes: MarketDuration,
    startTime: number,
    expectedEventId?: string
  ): Promise<void> {
    if (expectedEventId && page.url().endsWith(`/${expectedEventId}`)) {
      await page.locator('[data-tutorial-id="detail-tutorial-amount"] input, input[placeholder="0"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
      return
    }
    const target = await this.resolveLiveMarketTarget(durationMinutes, startTime)

    if (!page.url().endsWith(`/${target.eventId}`)) {
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    }
    await page.locator('[data-tutorial-id="detail-tutorial-amount"] input, input[placeholder="0"]')
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
  }

  private async resolveLiveMarketTarget(durationMinutes: MarketDuration, startTime: number): Promise<{ eventId: string; url: string }> {
    const origin = this.mode === 'HUBSTUDIO'
      ? new URL(this.hubstudioPage?.url() ?? MEXC_URL).origin
      : new URL(this.embeddedWindow?.webContents.getURL() || MEXC_URL).origin
    const matches = (candidate: MexcRawEvent, now: number): boolean =>
      Number(candidate.s) === 2 &&
      candidate.mn === `BTC ${durationMinutes}min` &&
      Number(candidate.sp) === durationMinutes * 60 &&
      normalizeMexcEventTime(candidate.st) === startTime &&
      normalizeMexcEventTime(candidate.et) > now
    const toTarget = (event: MexcRawEvent): { eventId: string; url: string } | undefined => {
      if (!event.id || !event.en) return undefined
      const slug = event.en
        .toLowerCase()
        .replaceAll(',', '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
      return {
        eventId: String(event.id),
        url: `${origin}/prediction-markets/up-down/${slug}/${event.id}`
      }
    }
    // Reuse the event directory already captured by the monitor first. This
    // keeps a transient page-network failure from blocking an otherwise valid
    // order and avoids an extra round trip immediately before navigation.
    const cachedEvents = this.interceptedEvents
    if (cachedEvents && Date.now() - cachedEvents.receivedAt <= MEXC_EVENT_CACHE_MS) {
      const cachedTarget = cachedEvents.events.find((candidate) => matches(candidate, Date.now()))
      const target = cachedTarget ? toTarget(cachedTarget) : undefined
      if (target) return target
    }
    const resolver = async (query: { durationMinutes: MarketDuration; startTime: number }): Promise<{ eventId: string; url: string }> => {
      const normalizeEventTime = (value: unknown): number => {
        const numeric = Number(value)
        if (!Number.isFinite(numeric) || numeric <= 0) return 0
        return numeric < 10_000_000_000 ? numeric * 1_000 : numeric
      }
      let events: MexcRawEvent[] = []
      let lastError = 'MEXC事件目录不可用'
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch('/api/platform/predict/market/web/event/events', {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(3_000)
          })
          if (!response.ok) throw new Error(`MEXC events HTTP ${response.status}`)
          const body = await response.json() as { data?: MexcRawEvent[] }
          events = body.data ?? []
          break
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
        }
      }
      const now = Date.now()
      const event = events.find((candidate) =>
        Number(candidate.s) === 2 &&
        candidate.mn === `BTC ${query.durationMinutes}min` &&
        Number(candidate.sp) === query.durationMinutes * 60 &&
        normalizeEventTime(candidate.st) === query.startTime &&
        normalizeEventTime(candidate.et) > now
      )
      if (!event?.id || !event.en) throw new Error(`${lastError}；所选机会可能已经跨盘或结束`)
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
      normalizeMexcEventTime(candidate.st) <= now &&
      normalizeMexcEventTime(candidate.et) > now
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
    if (!this.monitoringEnabled) return
    if (this.hubstudioMonitor) clearInterval(this.hubstudioMonitor)
    this.hubstudioMonitor = setInterval(() => {
      if (!this.hubstudioPage || this.hubstudioPage.isClosed()) return
      // Do not navigate the monitor tab on every rollover. Market discovery
      // and depth come from the event directory plus the independent feed;
      // navigating this page while a read is in flight destroys its execution
      // context and turns a transient rollover into a full MEXC read failure.
      // Order-specific pages are still navigated by ensureHubstudioLiveMarket
      // immediately before an order.
      // The in-page prediction feed has a 15s lease. Renew it from the
      // manager's 5s monitor loop instead of waiting for the renderer's
      // 15s opportunity refresh; otherwise the feed can self-stop between
      // refreshes and both windows become stale until the next poll.
      void this.syncHubstudioPredictionSubscriptions().catch(() => undefined)
      // Independently audit the actual symbol books. This is deliberately not
      // tied to the renderer's 15-second refresh and keeps a REST-backed quote
      // below the 8-second freshness gate when the protobuf depth decoder or a
      // subscription is temporarily quiet.
      const oldestQuoteAt = this.latestWindows.reduce((oldest, window) => Math.min(
        oldest,
        Number(window.outcomes.UP?.receivedAt) || 0,
        Number(window.outcomes.DOWN?.receivedAt) || 0
      ), Number.POSITIVE_INFINITY)
      if (!this.hubstudioMarketRefreshPromise && (!Number.isFinite(oldestQuoteAt) || Date.now() - oldestQuoteAt >= MEXC_REST_FALLBACK_MS)) {
        this.hubstudioMarketRefreshPromise = this.fetchActiveBtcWindows()
          .then(() => {
            // A background REST audit replaces latestWindows directly. Wake
            // the controller even when no WS depth mutation occurred, so the
            // refreshed timestamps reach MEXC + non-Polymarket routes.
            for (const listener of this.marketDataListeners) listener()
          })
          .catch((error) => {
            this.lastWindowDiagnostic = [this.lastWindowDiagnostic, `后台盘口审计失败：${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('；')
          })
          .finally(() => { this.hubstudioMarketRefreshPromise = undefined })
      }
      void this.prunePredictionTrackerCookies().catch(() => undefined)
      void this.recoverStuckErrorPages().catch(() => undefined)
      if (Date.now() - this.lastHubstudioAccountRefreshAt < 30_000 || this.hubstudioAccountRefreshing) return
      this.hubstudioAccountRefreshing = true
      void this.refreshAccountBalanceState()
        .finally(() => {
          this.lastHubstudioAccountRefreshAt = Date.now()
          this.hubstudioAccountRefreshing = false
        })
        .catch(() => undefined)
    }, 3_000)
  }

  // 长时间运行的环境Cookie会膨胀，MEXC(nginx)可能返回“400 Request Header Or
  // Cookie Too Large”错误页；预热下单页一旦卡在错误页会被一直复用导致下单失败。
  // 周期体检：发现错误页自动重载，1分钟冷却避免死循环。
  private lastErrorPageCheckAt = 0
  private readonly errorPageReloadAt = new Map<Page, number>()

  // MEXC预测页的埋点SDK会按访问路径写Cookie（_TDID_CK等），每切一个新盘累积一份，
  // 攒到数百个后请求头超过nginx限制触发400。周期清理重复的追踪Cookie，不动登录态。
  private lastTrackerCookiePruneAt = 0

  private async prunePredictionTrackerCookies(): Promise<void> {
    const now = Date.now()
    if (now - this.lastTrackerCookiePruneAt < 60_000) return
    this.lastTrackerCookiePruneAt = now
    const context = this.hubstudioBrowser?.contexts()[0]
    if (!context) return
    const cookies = await context.cookies(['https://prediction.mexc.com']).catch(() => [])
    const counts = new Map<string, number>()
    for (const cookie of cookies) counts.set(cookie.name, (counts.get(cookie.name) ?? 0) + 1)
    const junkNames = [...counts.entries()]
      .filter(([name, count]) => count > 3 && name !== 'NEXT_LOCALE')
      .map(([name]) => name)
    if (junkNames.length === 0) return
    for (const name of junkNames) {
      await context.clearCookies({ name, domain: 'prediction.mexc.com' }).catch(() => undefined)
    }
    console.error(`[MEXC] 清理重复追踪Cookie：${junkNames.map((name) => `${name}×${counts.get(name)}`).join('、')}`)
  }

  private async recoverStuckErrorPages(): Promise<void> {
    const now = Date.now()
    if (now - this.lastErrorPageCheckAt < 15_000) return
    this.lastErrorPageCheckAt = now
    const pages = [this.hubstudioPage, ...this.hubstudioOrderPages.values()]
    for (const page of pages) {
      if (!page || page.isClosed()) continue
      const title = await page.title().catch(() => '')
      if (!/^\s*(400|401|403|502|504)\b|Request Header Or Cookie/i.test(title)) continue
      const lastReload = this.errorPageReloadAt.get(page) ?? 0
      if (now - lastReload < 60_000) continue
      this.errorPageReloadAt.set(page, now)
      console.error(`[MEXC] 页面卡在错误页（${title.slice(0, 50)}），自动重载：${page.url()}`)
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined)
    }
  }

  private async refreshAccountBalanceState(): Promise<MexcAccountState> {
    const current = this.getStatus()
    if (!current.open) throw new Error('MEXC窗口尚未连接')
    await this.refreshAuthentication()
    if (!this.getStatus().authenticated) throw new Error('MEXC登录态不可用')
    const balances = await this.evaluateMexcPage(async () => {
      const response = await fetch('/api/platform/predict/asset/query/web/balances?coinIds=128f589271cb4951b03e71e6323eb7be', {
        headers: { accept: 'application/json' }, credentials: 'include'
      })
      if (!response.ok) throw new Error(`MEXC balances HTTP ${response.status}`)
      return await response.json() as { data?: Array<{ coinId?: string; available?: string }> }
    })
    const usdt = (balances.data ?? []).find((row) => row.coinId === MEXC_USDT_COIN_ID)
    const previous = this.latestAccountState
    this.latestAccountState = {
      checkedAt: Date.now(),
      reachable: true,
      authenticated: true,
      availableUsdt: usdt?.available,
      positionCount: previous?.positionCount ?? 0,
      openOrderCount: previous?.openOrderCount ?? 0,
      historyCount: previous?.historyCount ?? 0,
      positionFields: previous?.positionFields ?? [],
      openOrderFields: previous?.openOrderFields ?? [],
      historyFields: previous?.historyFields ?? [],
      fillReadbackReady: previous?.fillReadbackReady ?? false,
      latestFill: previous?.latestFill,
      latestSettlement: previous?.latestSettlement,
      message: 'MEXC可用余额已轻量刷新；持仓、委托与流水沿用最近完整读取结果'
    }
    return this.latestAccountState
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
    this.hubstudioPredictionTargets.clear()
    this.hubstudioMarketRefreshPromise = undefined
    this.hubstudioBinaryFrameCount = 0
    this.hubstudioPredictFrameCount = 0
    this.hubstudioDepthFrameCount = 0
    this.hubstudioIndexFrameCount = 0
    this.lastHubstudioBinaryFrameAt = 0
    this.lastHubstudioDepthFrameAt = 0
    this.lastHubstudioDepthSymbolId = ''
    this.hubstudioOrderPages.clear()
    this.hubstudioOrderWarmPromise = undefined
    this.lastHubstudioPassiveConnectAt = 0
    this.latestFillRows = undefined
    this.fillRowListeners.clear()
    this.lastHubstudioAccountRefreshAt = 0
    this.hubstudioAccountRefreshing = false
    this.hubstudioPage = undefined
    this.hubstudioBrowser = undefined
    this.hubstudioDebuggingPort = undefined
    this.hubstudioConnectedContainerCode = undefined
    this.hubstudioAuthenticated = false
    this.lastHubstudioConnectionError = '连接已断开，等待自动重连'
    this.latestAccountState = undefined
    this.latestOrderCapture = undefined
  }

  // Hubstudio 3.57+ 的本地API端口是启动时动态分配的（API子进程命令行为
  // `Hubstudio ... httpServer.cjs <port> ...`）。先扫描进程命令行提取候选端口，
  // 逐个探测 /api/v1/browser/all-browser-status 验证；旧版本的固定端口6873作为兜底。
  private async discoverHubstudioApiBase(): Promise<string | undefined> {
    const candidates: number[] = []
    try {
      const result = process.platform === 'win32'
        ? await execFileAsync('powershell', [
            '-NoProfile', '-Command',
            "Get-CimInstance Win32_Process -Filter \"Name='Hubstudio.exe'\" | ForEach-Object { $_.CommandLine }"
          ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
        : await execFileAsync('ps', ['-axo', 'args='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
      for (const match of String(result.stdout).matchAll(/httpServer\.cjs\D+(\d{2,5})/g)) {
        const port = Number(match[1])
        if (Number.isInteger(port) && port > 0) candidates.push(port)
      }
    } catch {
      // 进程扫描失败时只依赖固定端口
    }
    // Hubstudio 3.57+ exposes a dynamic Local API port. 56975 is the
    // currently documented/common port; retain 6873 for older installs.
    candidates.push(...HUBSTUDIO_API_PORT_FALLBACKS)
    for (const port of [...new Set(candidates)]) {
      const base = `http://127.0.0.1:${port}`
      try {
        const probe = await fetch(`${base}/api/v1/browser/all-browser-status`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '[]',
          signal: AbortSignal.timeout(1_500)
        })
        if (!probe.ok) continue
        const payload = await probe.json() as { code?: unknown }
        if (typeof payload.code === 'number') return base
      } catch {
        // 该端口不是Hubstudio Local API，继续探测
      }
    }
    return undefined
  }

  private async callHubstudio<T>(path: string, body: Record<string, unknown> | string[]): Promise<T> {
    const serialized = JSON.stringify(body)
    const send = async (base: string): Promise<T> => {
      let response: Response
      try {
        response = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: serialized,
          signal: AbortSignal.timeout(20_000)
        })
      } catch (error) {
        throw new Error(`无法连接Hubstudio Local API（${base.replace('http://', '')}）：${error instanceof Error ? error.message : String(error)}`)
      }
      if (!response.ok) throw new Error(`Hubstudio Local API返回HTTP ${response.status}`)
      return await response.json() as T
    }
    if (!this.hubstudioApiBase) {
      this.hubstudioApiBase = (await this.discoverHubstudioApiBase()) ?? HUBSTUDIO_API
    }
    try {
      return await send(this.hubstudioApiBase)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 仅网络层失败才可能是端口变了（Hubstudio重启后动态端口会换），重新发现一次
      if (!message.startsWith('无法连接Hubstudio Local API')) throw error
      const rediscovered = await this.discoverHubstudioApiBase()
      if (!rediscovered || rediscovered === this.hubstudioApiBase) throw error
      this.hubstudioApiBase = rediscovered
      return await send(this.hubstudioApiBase)
    }
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

  private async waitForHubstudioOrderPanel(
    page: Page,
    amountSelector: string | undefined,
    submitSelector: string | undefined,
    direction: Direction,
    action: 'BUY' | 'SELL',
    requireEnabled: boolean,
    timeoutMs: number
  ): Promise<boolean> {
    return await page.evaluate(({ amountSelector, submitSelector, direction, action, requireEnabled, timeoutMs }) => new Promise<boolean>((resolve) => {
      const visible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) return false
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      }
      const query = (selector?: string): Element | null => {
        if (!selector) return null
        try { return document.querySelector(selector) } catch { return null }
      }
      const compact = (value: string): string => value.toLowerCase().replace(/\s+/g, '')
      const expected = action === 'BUY'
        ? direction === 'UP' ? ['买入涨', 'buyup'] : ['买入跌', 'buydown']
        : direction === 'UP' ? ['卖出涨', 'sellup'] : ['卖出跌', 'selldown']
      const findSubmit = (): HTMLElement | null => {
        const calibrated = query(submitSelector)
        if (visible(calibrated)) return calibrated
        return Array.from(document.querySelectorAll('button, [role="button"]'))
          .find((element) => visible(element) && expected.some((label) => compact(element.textContent ?? '').startsWith(label))) as HTMLElement | undefined ?? null
      }
      const check = (): boolean => {
        const calibratedAmount = query(amountSelector)
        const amount = visible(calibratedAmount)
          ? calibratedAmount
          : Array.from(document.querySelectorAll('[data-tutorial-id="detail-tutorial-amount"] input, input[placeholder="0"]')).find(visible)
        const submit = findSubmit()
        if (!amount || !submit) return false
        if (!requireEnabled) return true
        const nativeDisabled = submit instanceof HTMLButtonElement && submit.disabled
        return !nativeDisabled && submit.getAttribute('aria-disabled') !== 'true' && !submit.classList.contains('disabled')
      }
      let settled = false
      const finish = (ready: boolean): void => {
        if (settled) return
        settled = true
        observer.disconnect()
        clearInterval(fallback)
        clearTimeout(timeout)
        resolve(ready)
      }
      const observer = new MutationObserver(() => {
        if (check()) finish(true)
      })
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['disabled', 'aria-disabled', 'class', 'value']
      })
      const fallback = setInterval(() => {
        if (check()) finish(true)
      }, 50)
      const timeout = setTimeout(() => finish(check()), timeoutMs)
      if (check()) finish(true)
    }), { amountSelector, submitSelector, direction, action, requireEnabled, timeoutMs })
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
      monitoring: this.monitoringEnabled && open,
      hubstudioContainerCode: this.mode === 'HUBSTUDIO' ? this.hubstudioContainerCode : undefined,
      debuggingPort: this.mode === 'HUBSTUDIO' ? this.hubstudioDebuggingPort : undefined,
      calibrated: this.getCalibration(),
      account: this.latestAccountState,
      lastOrderCapture: this.latestOrderCapture,
      message
    }
  }
}
