import { app, BrowserWindow, shell } from 'electron'
import Decimal from 'decimal.js'
import type { CDPSession, Page } from 'playwright-core'
import type { GatePageCaptureStatus } from '../../shared/types'
import { PreSubmitBlockedError } from '../domain/execution-errors'
import type { FingerprintBrowserRuntime } from './fingerprint-browser-runtime'

// Gate only subscribes the order book for the duration shown by a page. Keep
// one passive page per supported duration inside the same logged-in profile.
const GATE_PAGE_URLS = {
  5: 'https://www.gate.com/zh/trade-events/btc-updown-5m',
  15: 'https://www.gate.com/zh/trade-events/btc-updown-15m'
} as const
const GATE_PAGE_URL = GATE_PAGE_URLS[5]
const PAGE_START_TIMEOUT_MS = 25_000
const PAGE_ROLL_INTERVAL_MS = {
  5: 5 * 60_000,
  15: 15 * 60_000
} as const

export function gateRollDelayMs(now = Date.now(), duration: 5 | 15 = 5): number {
  const interval = PAGE_ROLL_INTERVAL_MS[duration]
  const nextBoundary = (Math.floor(now / interval) + 1) * interval
  return Math.max(1_000, nextBoundary - now)
}

export function gateOrderBlockedByRoll(rollingDurations: ReadonlySet<5 | 15>, requestedDuration?: 5 | 15): boolean {
  return requestedDuration === undefined ? rollingDurations.size > 0 : rollingDurations.has(requestedDuration)
}

export interface GateCapturedResponse {
  url: string
  body: string
  receivedAt: number
  requestId?: string
  status?: number
  resourceType?: string
  /** The visible/hidden page URL that initiated the request. */
  pageUrl?: string
}

export interface GateCapturedWebSocketFrame {
  url: string
  payload: string
  receivedAt: number
  requestId?: string
  direction?: 'SENT' | 'RECEIVED'
  /** The visible/hidden page URL that owns the socket. */
  pageUrl?: string
}

export interface GateCapturedRequest {
  url: string
  method: string
  headers?: Record<string, string>
  body?: string
  receivedAt: number
  requestId?: string
  resourceType?: string
  pageUrl?: string
}

export interface GatePreparedOrderRequest {
  endpoint: string
  method: string
  body: string
  pageUrl?: string
}

export interface GatePageOrderIntent {
  marketId: string
  outcomeId: string
  direction: 'UP' | 'DOWN'
  quantity: string
  limitPrice: string
  clientOrderId: string
  durationMinutes?: 5 | 15
  allowSubmit?: boolean
}

export interface GateCapturedHttpResponse {
  status: number
  body: string
}

export interface GatePageCaptureSource {
  getStatus(): GatePageCaptureStatus
  onRequest(listener: (event: GateCapturedRequest) => void): () => void
  onResponse(listener: (event: GateCapturedResponse) => void): () => void
  onNetworkRequest?(listener: (event: GateCapturedRequest) => void): () => void
  onNetworkResponse?(listener: (event: GateCapturedResponse) => void): () => void
  onWebSocketFrame(listener: (event: GateCapturedWebSocketFrame) => void): () => void
  onRawWebSocketFrame?(listener: (event: GateCapturedWebSocketFrame) => void): () => void
  onStatus(listener: (status: GatePageCaptureStatus) => void): () => void
  start(show?: boolean): Promise<void>
  stop(): void
}

interface CdpResponseReceived {
  requestId?: string
  type?: string
  response?: { url?: string; mimeType?: string; status?: number }
}

interface CdpRequestWillBeSent {
  requestId?: string
  type?: string
  request?: { url?: string; method?: string; headers?: Record<string, string>; postData?: string }
}

interface CdpWebSocketCreated {
  requestId?: string
  url?: string
}

interface CdpWebSocketFrame {
  requestId?: string
  response?: { opcode?: number; payloadData?: string }
  request?: { opcode?: number; payloadData?: string }
}

export function gateWebSocketPayload(event: CdpWebSocketFrame, _direction: 'SENT' | 'RECEIVED'): string | undefined {
  // CDP names the WebSocketFrame field `response` for both
  // Network.webSocketFrameReceived and Network.webSocketFrameSent.
  // Keep `request` only as a compatibility fallback for older wrappers.
  const frame = event.response ?? event.request
  return frame?.opcode === 1 && typeof frame.payloadData === 'string' ? frame.payloadData : undefined
}

export function isGateHost(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase()
    return hostname === 'gate.com' || hostname.endsWith('.gate.com') ||
      hostname === 'gate.io' || hostname.endsWith('.gate.io') ||
      hostname === 'gateio.ws' || hostname.endsWith('.gateio.ws') ||
      hostname === 'gateio.live' || hostname.endsWith('.gateio.live')
  } catch {
    return false
  }
}

export function isGateBtcEventUrl(rawUrl: string): boolean {
  return gatePageDuration(rawUrl) !== undefined
}

export function gatePageDuration(rawUrl: string): 5 | 15 | undefined {
  try {
    const url = new URL(rawUrl)
    if (!isGateHost(rawUrl)) return undefined
    const match = url.pathname.match(/^\/zh\/trade-events\/btc-updown-(5|15)m(?:$|\/)/i)
    return match ? Number(match[1]) as 5 | 15 : undefined
  } catch {
    return undefined
  }
}

function gateEventIdRank(rawUrl: string): number | undefined {
  try {
    const raw = new URL(rawUrl).searchParams.get('eventId') ?? new URL(rawUrl).searchParams.get('event_id')
    const value = raw ? Number(raw) : NaN
    return Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Hubstudio profiles can retain an old Gate tab from a previous run. When
 * several tabs expose the same duration, attach to the highest eventId (Gate
 * event IDs increase with each new round) instead of whichever tab happens to
 * be first in Chromium's page list.
 */
export function selectGatePageUrl(urls: readonly string[], duration: 5 | 15): string | undefined {
  let selected: string | undefined
  let selectedRank = Number.NEGATIVE_INFINITY
  let selectedIndex = -1
  urls.forEach((url, index) => {
    if (gatePageDuration(url) !== duration) return
    const rank = gateEventIdRank(url) ?? Number.NEGATIVE_INFINITY
    if (rank > selectedRank || (rank === selectedRank && index > selectedIndex)) {
      selected = url
      selectedRank = rank
      selectedIndex = index
    }
  })
  return selected
}

export function selectGatePageDuration(available: readonly (5 | 15)[], requested?: 5 | 15): 5 | 15 | undefined {
  if (requested !== undefined) return available.includes(requested) ? requested : undefined
  return available.includes(5) ? 5 : available[0]
}

export function isGateEventResponse(rawUrl: string): boolean {
  if (!isGateHost(rawUrl)) return false
  try {
    const { pathname, search } = new URL(rawUrl)
    return /event|predict|contract|clob|order.?book|depth|market|ticker|quote/i.test(`${pathname}${search}`)
  } catch {
    return false
  }
}

export class GatePageCapture implements GatePageCaptureSource {
  private window?: BrowserWindow
  private fingerprintPage?: Page
  private fingerprintPages = new Map<5 | 15, Page>()
  private fingerprintNetworkSessions = new Map<5 | 15, CDPSession>()
  private startPromise?: Promise<void>
  private captureGeneration = 0
  private stopping = false
  private destroying = false
  private status: GatePageCaptureStatus = { state: 'IDLE', message: 'Gate 事件合约网页被动行情尚未启动' }
  private socketUrls = new Map<string, string>()
  private responseCount = 0
  private webSocketFrameCount = 0
  private lastCaptureAt?: number
  private lastStatusNotifyAt = 0
  private loadedRollSlot?: number
  private rollPromise?: Promise<void>
  private fingerprintRollTimers = new Map<5 | 15, ReturnType<typeof setTimeout>>()
  private fingerprintOrderInFlight = 0
  private fingerprintRollInFlight = new Set<5 | 15>()
  private responseListeners = new Set<(event: GateCapturedResponse) => void>()
  private requestListeners = new Set<(event: GateCapturedRequest) => void>()
  private networkResponseListeners = new Set<(event: GateCapturedResponse) => void>()
  private networkRequestListeners = new Set<(event: GateCapturedRequest) => void>()
  private frameListeners = new Set<(event: GateCapturedWebSocketFrame) => void>()
  private rawFrameListeners = new Set<(event: GateCapturedWebSocketFrame) => void>()
  private statusListeners = new Set<(status: GatePageCaptureStatus) => void>()

  constructor(private readonly fingerprintRuntime?: FingerprintBrowserRuntime) {
    app.once('before-quit', () => {
      this.stopping = true
      this.window?.destroy()
    })
  }

  getStatus(): GatePageCaptureStatus { return { ...this.status } }
  getExecutableDurations(): Array<5 | 15> {
    return ([5, 15] as const).filter((duration) => {
      const page = this.fingerprintPages.get(duration)
      return Boolean(page && !page.isClosed() && !this.fingerprintRollInFlight.has(duration))
    })
  }

  canExecuteOrders(duration?: 5 | 15): boolean {
    const executableDurations = this.getExecutableDurations()
    if (duration !== undefined) return executableDurations.includes(duration)
    return executableDurations.length > 0
  }

  canExecutePageOrders(): boolean { return this.canExecuteOrders() }

  /**
   * Use the logged-in Gate page's own controls for exactly one order attempt.
   * This deliberately does not bring the tab to the foreground and never
   * replays the captured POST with fetch, so a timeout cannot create a second
   * request. The caller must reconcile an uncertain response before retrying.
   */
  async executePageOrder(intent: GatePageOrderIntent): Promise<GateCapturedHttpResponse> {
    if (gateOrderBlockedByRoll(this.fingerprintRollInFlight, intent.durationMinutes)) {
      const durationLabel = intent.durationMinutes ? ` ${intent.durationMinutes}m` : ''
      throw new PreSubmitBlockedError(`Gate${durationLabel} 正在切换当前轮次，未操作订单；请稍后重试`)
    }
    this.fingerprintOrderInFlight += 1
    try {
      return await this.executePageOrderInternal(intent)
    } finally {
      this.fingerprintOrderInFlight = Math.max(0, this.fingerprintOrderInFlight - 1)
    }
  }

  private async executePageOrderInternal(intent: GatePageOrderIntent): Promise<GateCapturedHttpResponse> {
    const availableDurations = [...this.fingerprintPages.entries()]
      .filter(([, candidate]) => !candidate.isClosed())
      .map(([duration]) => duration)
    const selectedDuration = selectGatePageDuration(availableDurations, intent.durationMinutes)
    const page = intent.durationMinutes !== undefined
      ? selectedDuration ? this.fingerprintPages.get(selectedDuration) : undefined
      : this.fingerprintPage
    if (intent.durationMinutes !== undefined && !page) throw new Error(`Gate ${intent.durationMinutes}m 页面不可用，未操作订单`)
    if (!page || page.isClosed()) throw new Error('Gate 指纹浏览器标签页不可用，未操作订单')
    const quantity = new Decimal(intent.quantity)
    const price = new Decimal(intent.limitPrice)
    if (!quantity.isFinite() || quantity.lte(0) || !price.isFinite() || price.lte(0) || price.gte(1)) {
      throw new Error('Gate 页面下单数量或价格无效，未操作订单')
    }
    const currentEventId = (() => {
      try { return new URL(page.url()).searchParams.get('eventId') ?? undefined } catch { return undefined }
    })()
    if (currentEventId && intent.marketId && currentEventId !== intent.marketId) {
      const duration = intent.durationMinutes
      if (duration !== 5 && duration !== 15) throw new Error(`Gate 页面当前 eventId=${currentEventId} 与目标市场 ${intent.marketId} 不一致，且无法识别目标周期`)
      const outcome = intent.direction === 'UP' ? 'Up' : 'Down'
      const targetUrl = `https://www.gate.com/zh/trade-events/btc-updown-${duration}m?eventId=${encodeURIComponent(intent.marketId)}&outcome=${outcome}`
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 })
    }
    const cost = quantity.mul(price).toFixed()
    const directionPattern = intent.direction === 'UP' ? /^看涨\s+\d+(?:\.\d+)?%$/ : /^看跌\s+\d+(?:\.\d+)?%$/
    const outcomeButton = page.getByRole('button', { name: directionPattern }).first()
    const costInput = page.locator('label').filter({ hasText: /成本\s*\(USDT\)/ }).last().locator('input[inputmode="decimal"]').first()
    await Promise.all([
      outcomeButton.waitFor({ state: 'visible', timeout: 15_000 }),
      costInput.waitFor({ state: 'visible', timeout: 15_000 })
    ]).catch(() => undefined)
    if (!await outcomeButton.isVisible().catch(() => false)) throw new Error('Gate 页面未识别当前涨跌按钮，未操作订单')
    if (!await costInput.isVisible().catch(() => false)) throw new Error('Gate 页面未识别成本输入框，未操作订单')

    await outcomeButton.click()
    await costInput.fill(cost)
    const submitButton = page.getByRole('button', { name: intent.direction === 'UP' ? /^买入看涨$/ : /^买入看跌$/ }).first()
    await submitButton.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
    if (!await submitButton.isVisible().catch(() => false)) throw new Error('Gate 页面未识别买入按钮，未操作订单')
    if (!await submitButton.isEnabled().catch(() => false)) throw new Error(`Gate 买入按钮不可用（成本 ${cost} USDT），未提交订单`)
    if (intent.allowSubmit === false) return { status: 200, body: JSON.stringify({ status: 'prepared', order_id: '' }) }

    const responsePromise = page.waitForResponse(
      (response) => response.request().method().toUpperCase() === 'POST' && /\/apiw\/v2\/event-contract\/place-order(?:$|\?)/.test(response.url()),
      { timeout: 8_000 }
    ).catch(() => undefined)
    await submitButton.click()
    const response = await responsePromise
    if (!response) throw new Error('已点击 Gate 买入，但 8 秒内没有捕获 place-order 响应；订单状态不明，禁止重试')
    return { status: response.status(), body: await response.text() }
  }

  async executeCapturedOrder(request: GatePreparedOrderRequest): Promise<GateCapturedHttpResponse> {
    const duration = gatePageDuration(request.pageUrl ?? '')
    if (gateOrderBlockedByRoll(this.fingerprintRollInFlight, duration)) {
      const durationLabel = duration ? ` ${duration}m` : ''
      throw new PreSubmitBlockedError(`Gate${durationLabel} 正在切换当前轮次，未发送订单；请稍后重试`)
    }
    this.fingerprintOrderInFlight += 1
    try {
      return await this.executeCapturedOrderInternal(request)
    } finally {
      this.fingerprintOrderInFlight = Math.max(0, this.fingerprintOrderInFlight - 1)
    }
  }

  private async executeCapturedOrderInternal(request: GatePreparedOrderRequest): Promise<GateCapturedHttpResponse> {
    const method = request.method.toUpperCase()
    if (!isGateHost(request.endpoint) || !['POST', 'PUT', 'PATCH'].includes(method)) throw new Error('Gate 页面订单请求不受安全范围允许')
    const duration = gatePageDuration(request.pageUrl ?? '')
    const availableDurations = [...this.fingerprintPages.entries()]
      .filter(([, candidate]) => !candidate.isClosed())
      .map(([availableDuration]) => availableDuration)
    const selectedDuration = selectGatePageDuration(availableDurations, duration)
    const page = duration !== undefined
      ? selectedDuration ? this.fingerprintPages.get(selectedDuration) : undefined
      : this.fingerprintPage
    if (duration !== undefined && !page) throw new Error(`Gate ${duration}m 页面不可用，未发送订单`)
    if (!page || page.isClosed()) throw new Error('Gate 指纹浏览器标签页不可用，未发送订单')
    return await page.evaluate(async (input: { endpoint: string; method: string; body: string }) => {
      const response = await fetch(input.endpoint, {
        method: input.method,
        credentials: 'include',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: input.body,
        signal: AbortSignal.timeout(5_000)
      })
      return { status: response.status, body: await response.text() }
    }, { endpoint: request.endpoint, method, body: request.body })
  }

  onResponse(listener: (event: GateCapturedResponse) => void): () => void {
    this.responseListeners.add(listener)
    return () => this.responseListeners.delete(listener)
  }

  onRequest(listener: (event: GateCapturedRequest) => void): () => void {
    this.requestListeners.add(listener)
    return () => this.requestListeners.delete(listener)
  }

  onNetworkRequest(listener: (event: GateCapturedRequest) => void): () => void {
    this.networkRequestListeners.add(listener)
    return () => this.networkRequestListeners.delete(listener)
  }

  onNetworkResponse(listener: (event: GateCapturedResponse) => void): () => void {
    this.networkResponseListeners.add(listener)
    return () => this.networkResponseListeners.delete(listener)
  }

  onWebSocketFrame(listener: (event: GateCapturedWebSocketFrame) => void): () => void {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  onRawWebSocketFrame(listener: (event: GateCapturedWebSocketFrame) => void): () => void {
    this.rawFrameListeners.add(listener)
    return () => this.rawFrameListeners.delete(listener)
  }

  onStatus(listener: (status: GatePageCaptureStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  async start(show = false): Promise<void> {
    const liveFingerprintDurations = ([5, 15] as const).filter((duration) => {
      const page = this.fingerprintPages.get(duration)
      return Boolean(page && !page.isClosed() && this.fingerprintNetworkSessions.has(duration))
    })
    if (this.fingerprintPage && !this.fingerprintPage.isClosed() && liveFingerprintDurations.length === 2) {
      this.scheduleFingerprintRoll()
      if (show) await this.fingerprintPage.bringToFront()
      return
    }
    if (this.fingerprintRuntime?.isConfigured()) {
      if (this.startPromise) { await this.startPromise; if (show) await this.fingerprintPage?.bringToFront(); return }
      const generation = ++this.captureGeneration
      this.startPromise = this.createFingerprintPage(show, generation)
      try { await this.startPromise } finally { this.startPromise = undefined }
      return
    }
    if (this.window && !this.window.isDestroyed()) {
      await this.refreshForCurrentRoll(this.window)
      if (show) this.open()
      return
    }
    if (this.startPromise) {
      await this.startPromise
      if (show) this.open()
      return
    }
    this.startPromise = this.createWindow(show)
    try {
      await this.startPromise
    } finally {
      this.startPromise = undefined
    }
  }

  stop(): void {
    const fingerprintStartup = Boolean(this.fingerprintRuntime?.isConfigured() && this.startPromise)
    if (this.fingerprintPage || this.fingerprintPages.size > 0 || fingerprintStartup) {
      this.captureGeneration += 1
      this.destroying = true
      this.clearFingerprintRollTimer()
      this.fingerprintRollInFlight.clear()
      for (const session of this.fingerprintNetworkSessions.values()) void session.detach().catch(() => undefined)
      this.fingerprintNetworkSessions.clear()
      this.fingerprintPages.clear()
      // This page belongs to the user's fingerprint browser. Detach CDP but
      // never close the logged-in tabs when only monitoring is stopped.
      this.fingerprintPage = undefined
      this.setStatus('IDLE', 'Gate 指纹浏览器 5m/15m 页面监听已停止')
      return
    }
    const window = this.window
    if (!window || window.isDestroyed()) return
    this.destroying = true
    window.destroy()
  }

  open(): void {
    if (this.fingerprintPage && !this.fingerprintPage.isClosed()) {
      void this.fingerprintPage.bringToFront()
      return
    }
    if (!this.window || this.window.isDestroyed()) {
      void this.start(true)
      return
    }
    this.window.show()
    this.window.focus()
  }

  private async createFingerprintPage(show: boolean, generation: number): Promise<void> {
    this.setStatus('STARTING', '正在接管已登录的 Gate 指纹浏览器 5m/15m 标签页；只监听页面自身请求')
    let seedPage: Page
    try {
      seedPage = await this.fingerprintRuntime!.attach('GATE', {
        hosts: ['gate.com', 'gate.io', 'gateio.ws', 'gateio.live'],
        createIfMissing: true,
        startupUrl: GATE_PAGE_URL
      })
    } catch (error) {
      this.setStatus('DISCONNECTED', `Gate 指纹浏览器接管失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (generation !== this.captureGeneration) return
    try {
      const context = seedPage.context()
      const pagesByDuration = new Map<5 | 15, Page>()
      const candidates = context.pages().filter((candidate) => !candidate.isClosed())
      for (const duration of [5, 15] as const) {
        const sameDuration = candidates.filter((candidate) => gatePageDuration(candidate.url()) === duration)
        const selectedUrl = selectGatePageUrl(sameDuration.map((candidate) => candidate.url()), duration)
        const selected = sameDuration.find((candidate) => candidate.url() === selectedUrl)
        if (selected) pagesByDuration.set(duration, selected)
      }
      if (!pagesByDuration.has(5) && !gatePageDuration(seedPage.url())) pagesByDuration.set(5, seedPage)
      for (const duration of [5, 15] as const) {
        if (generation !== this.captureGeneration) return
        const page = pagesByDuration.get(duration) ?? await context.newPage()
        if (!await this.bindFingerprintPage(page, duration, generation)) return
      }
      if (generation !== this.captureGeneration) return
      this.fingerprintPage = this.fingerprintPages.get(5) ?? this.fingerprintPages.get(15)
      this.scheduleFingerprintRoll(generation)
      if (show) await this.fingerprintPage?.bringToFront()
      this.setStatus('CONNECTED', this.captureStatusMessage('5m/15m 已接管指纹浏览器'))
    } catch (error) {
      this.setStatus('DISCONNECTED', `Gate 指纹浏览器网络监听失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async bindFingerprintPage(page: Page, duration: 5 | 15, generation: number): Promise<boolean> {
    const current = this.fingerprintPages.get(duration)
    if (current === page && !page.isClosed() && this.fingerprintNetworkSessions.has(duration)) return true
    if (generation !== this.captureGeneration) return false
    const session = await page.context().newCDPSession(page)
    if (generation !== this.captureGeneration) {
      await session.detach().catch(() => undefined)
      return false
    }
    const socketUrls = new Map<string, string>()
    this.fingerprintPages.set(duration, page)
    this.fingerprintNetworkSessions.set(duration, session)
    page.on('close', () => {
      if (this.fingerprintPages.get(duration) !== page) return
      this.fingerprintPages.delete(duration)
      this.fingerprintNetworkSessions.delete(duration)
      this.clearFingerprintRollTimer(duration)
      this.fingerprintRollInFlight.delete(duration)
      if (this.fingerprintPage === page) this.fingerprintPage = this.fingerprintPages.get(duration === 5 ? 15 : 5)
      const remaining = [...this.fingerprintPages.values()].some((candidate) => !candidate.isClosed())
      if (!remaining) this.clearFingerprintRollTimer()
      this.setStatus(remaining ? 'CONNECTED' : 'DISCONNECTED', remaining
        ? `Gate ${duration}m 页面已关闭；另一周期仍在监听`
        : `Gate ${duration}m 指纹浏览器标签页已关闭`)
    })
    try {
      await session.send('Network.enable')
      session.on('Network.requestWillBeSent', (rawParams) => this.handleRequest(rawParams as CdpRequestWillBeSent, page.url()))
      session.on('Network.responseReceived', (rawParams) => { void this.handlePlaywrightResponse(session, page, rawParams as CdpResponseReceived) })
      session.on('Network.webSocketCreated', (rawParams) => {
        const event = rawParams as CdpWebSocketCreated
        if (event.requestId && event.url && isGateHost(event.url)) socketUrls.set(event.requestId, event.url)
      })
      session.on('Network.webSocketClosed', (rawParams) => {
        const requestId = (rawParams as { requestId?: string }).requestId
        if (requestId) socketUrls.delete(requestId)
      })
      session.on('Network.webSocketFrameReceived', (rawParams) => {
        const event = rawParams as CdpWebSocketFrame
        this.handleFrame(event, page.url(), 'RECEIVED', event.requestId ? socketUrls.get(event.requestId) : undefined)
      })
      session.on('Network.webSocketFrameSent', (rawParams) => {
        const event = rawParams as CdpWebSocketFrame
        this.handleFrame(event, page.url(), 'SENT', event.requestId ? socketUrls.get(event.requestId) : undefined)
      })
      this.setStatus('STARTING', `Gate ${duration}m 已接管；正在后台刷新一次以捕获当前盘口流`)
      if (generation !== this.captureGeneration) return false
      if (gatePageDuration(page.url()) === duration) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: PAGE_START_TIMEOUT_MS })
      } else {
        await page.goto(GATE_PAGE_URLS[duration], { waitUntil: 'domcontentloaded', timeout: PAGE_START_TIMEOUT_MS })
      }
      if (generation !== this.captureGeneration) return false
      return true
    } catch (error) {
      if (this.fingerprintPages.get(duration) === page) this.fingerprintPages.delete(duration)
      if (this.fingerprintNetworkSessions.get(duration) === session) this.fingerprintNetworkSessions.delete(duration)
      await session.detach().catch(() => undefined)
      throw error
    }
  }

  private scheduleFingerprintRoll(generation = this.captureGeneration, onlyDuration?: 5 | 15): void {
    const durations = onlyDuration === undefined ? ([5, 15] as const) : ([onlyDuration] as const)
    for (const duration of durations) {
      this.clearFingerprintRollTimer(duration)
      if (this.stopping || generation !== this.captureGeneration) continue
      const page = this.fingerprintPages.get(duration)
      if (!page || page.isClosed()) continue
      const timer = setTimeout(() => {
        this.fingerprintRollTimers.delete(duration)
        if (this.stopping || generation !== this.captureGeneration) return
        void this.refreshFingerprintPage(duration, generation)
          .finally(() => this.scheduleFingerprintRoll(generation, duration))
      }, gateRollDelayMs(Date.now(), duration))
      this.fingerprintRollTimers.set(duration, timer)
      timer.unref?.()
    }
  }

  private clearFingerprintRollTimer(duration?: 5 | 15): void {
    if (duration !== undefined) {
      const timer = this.fingerprintRollTimers.get(duration)
      if (timer) clearTimeout(timer)
      this.fingerprintRollTimers.delete(duration)
      return
    }
    for (const timer of this.fingerprintRollTimers.values()) clearTimeout(timer)
    this.fingerprintRollTimers.clear()
  }

  private async refreshFingerprintPage(duration: 5 | 15, generation: number): Promise<void> {
    if (generation !== this.captureGeneration) return
    // A page.goto() can invalidate a pending click and move it to another
    // eventId. Let the current order finish, then retry the next boundary.
    if (this.fingerprintOrderInFlight > 0) return
    const page = this.fingerprintPages.get(duration)
    if (!page || page.isClosed()) return
    this.fingerprintRollInFlight.add(duration)
    try {
      this.setStatus('STARTING', `Gate ${duration}m 正在切换到当前轮次；另一周期不受影响`)
      // Do not reload the old eventId URL. Gate can keep that event pinned;
      // the duration entry URL resolves to the currently active round.
      await page.goto(GATE_PAGE_URLS[duration], { waitUntil: 'domcontentloaded', timeout: PAGE_START_TIMEOUT_MS })
      this.setStatus('CONNECTED', `Gate ${duration}m 当前轮次已刷新；继续监听最新盘口`)
    } catch {
      this.setStatus('DISCONNECTED', `Gate ${duration}m 当前轮次刷新失败；等待下一次自动重试`)
    } finally {
      this.fingerprintRollInFlight.delete(duration)
    }
  }

  private async createWindow(show: boolean): Promise<void> {
    this.setStatus('STARTING', '正在启动单个 Gate 事件合约网页；只监听网页自身请求')
    const window = new BrowserWindow({
      width: 1380,
      height: 900,
      minWidth: 980,
      minHeight: 680,
      show,
      title: 'Gate 事件合约 · ArbDesk 被动行情',
      backgroundColor: '#020617',
      webPreferences: {
        partition: 'persist:gate-events-arbdesk',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Hidden passive capture should not keep the full foreground timer
        // budget. Network/WebSocket events continue while Chromium throttles
        // page scripts in the background.
        backgroundThrottling: true
      }
    })
    this.window = window
    const startupTimeout = setTimeout(() => {
      if (this.window === window && this.status.state === 'STARTING') {
        this.setStatus('DISCONNECTED', 'Gate 页面 25 秒内未完成加载；请打开单页面检查网络、地区限制或登录状态，扫描主流程不会被阻塞')
      }
    }, PAGE_START_TIMEOUT_MS)
    startupTimeout.unref()
    window.webContents.setAudioMuted(true)
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url)
      return { action: 'deny' }
    })
    window.on('close', (event) => {
      if (this.stopping || this.destroying) return
      event.preventDefault()
      window.hide()
    })
    window.on('closed', () => {
      clearTimeout(startupTimeout)
      if (this.window === window) this.window = undefined
      this.socketUrls.clear()
      const wasDestroying = this.destroying
      this.destroying = false
      this.setStatus(wasDestroying ? 'IDLE' : 'DISCONNECTED', wasDestroying ? 'Gate 网页监听已停止；页面资源已释放' : 'Gate 网页监听窗口已关闭')
    })
    window.webContents.on('did-finish-load', () => {
      clearTimeout(startupTimeout)
      this.setStatus('CONNECTED', this.captureStatusMessage())
    })
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame) return
      clearTimeout(startupTimeout)
      this.setStatus('DISCONNECTED', `Gate 页面加载失败（${errorCode}）：${errorDescription} · ${validatedUrl}`)
    })
    this.attachDebugger(window, !show)
    const initialRollSlot = Math.floor(Date.now() / PAGE_ROLL_INTERVAL_MS[5])
    void window.loadURL(GATE_PAGE_URL)
      .then(() => { this.loadedRollSlot = initialRollSlot })
      .catch((error) => {
        clearTimeout(startupTimeout)
        this.setStatus('DISCONNECTED', `Gate 页面无法打开：${error instanceof Error ? error.message : String(error)}`)
      })
  }

  private async refreshForCurrentRoll(window: BrowserWindow): Promise<void> {
    const rollSlot = Math.floor(Date.now() / PAGE_ROLL_INTERVAL_MS[5])
    if (this.loadedRollSlot === rollSlot) return
    if (this.rollPromise) return await this.rollPromise
    this.rollPromise = window.loadURL(GATE_PAGE_URL)
      .then(() => { this.loadedRollSlot = rollSlot })
      .catch((error) => {
        this.setStatus('DISCONNECTED', `Gate 新轮次页面刷新失败：${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => { this.rollPromise = undefined })
    await this.rollPromise
  }

  private attachDebugger(window: BrowserWindow, backgroundCapture: boolean): void {
    const debug = window.webContents.debugger
    try {
      if (!debug.isAttached()) debug.attach('1.3')
    } catch (error) {
      this.setStatus('DISCONNECTED', `无法启动 Gate 被动监听：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    void debug.sendCommand('Network.enable').then(() => {
      if (!backgroundCapture) return
      return debug.sendCommand('Network.setBlockedURLs', {
        urls: ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.svg', '*.woff', '*.woff2', '*.ttf', '*.mp4', '*.webm', '*google-analytics*', '*googletagmanager*', '*doubleclick*']
      })
    }).catch((error) => {
      this.setStatus('DISCONNECTED', `无法启用 Gate 网络监听：${error instanceof Error ? error.message : String(error)}`)
    })
    debug.on('message', (_event, method, rawParams) => {
      if (method === 'Network.requestWillBeSent') {
        this.handleRequest(rawParams as CdpRequestWillBeSent, window.webContents.getURL())
        return
      }
      if (method === 'Network.responseReceived') {
        void this.handleResponse(window, rawParams as CdpResponseReceived)
        return
      }
      if (method === 'Network.webSocketCreated') {
        const event = rawParams as CdpWebSocketCreated
        if (event.requestId && event.url && isGateHost(event.url)) this.socketUrls.set(event.requestId, event.url)
        return
      }
      if (method === 'Network.webSocketClosed') {
        const requestId = (rawParams as { requestId?: string }).requestId
        if (requestId) this.socketUrls.delete(requestId)
        return
      }
      if (method === 'Network.webSocketFrameReceived') this.handleFrame(rawParams as CdpWebSocketFrame)
      if (method === 'Network.webSocketFrameSent') this.handleFrame(rawParams as CdpWebSocketFrame, undefined, 'SENT')
    })
    debug.on('detach', (_event, reason) => {
      if (!this.stopping) this.setStatus('DISCONNECTED', `Gate 网络监听已断开：${reason}`)
    })
  }

  private async handleResponse(window: BrowserWindow, event: CdpResponseReceived): Promise<void> {
    const url = event.response?.url ?? ''
    if (!event.requestId || !isGateHost(url) || !['XHR', 'Fetch'].includes(event.type ?? '') || (!isGateEventResponse(url) && this.networkResponseListeners.size === 0)) return
    try {
      const result = await window.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: event.requestId }) as {
        body?: string
        base64Encoded?: boolean
      }
      if (!result.body) return
      const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body
      const captured = { url, body, requestId: event.requestId, status: event.response?.status, resourceType: event.type, receivedAt: Date.now(), pageUrl: window.webContents.getURL() }
      this.responseCount += 1
      this.lastCaptureAt = captured.receivedAt
      this.setStatus('CONNECTED', this.captureStatusMessage())
      for (const listener of this.networkResponseListeners) listener(captured)
      if (isGateEventResponse(url)) for (const listener of this.responseListeners) listener(captured)
    } catch {
      // Cached, redirected or evicted responses can disappear before CDP reads them.
    }
  }

  private handleRequest(event: CdpRequestWillBeSent, pageUrl?: string): void {
    const request = event.request
    const url = request?.url ?? ''
    const method = request?.method?.toUpperCase() ?? 'GET'
    if (!isGateHost(url)) return
    const captured: GateCapturedRequest = {
      url,
      method,
      headers: request?.headers,
      body: request?.postData,
      requestId: event.requestId,
      resourceType: event.type,
      receivedAt: Date.now(),
      pageUrl
    }
    for (const listener of this.networkRequestListeners) listener(captured)
    if (['POST', 'PUT', 'PATCH'].includes(method)) for (const listener of this.requestListeners) listener(captured)
  }

  private handleFrame(
    event: CdpWebSocketFrame,
    pageUrl = this.window?.webContents.getURL(),
    direction: 'SENT' | 'RECEIVED' = 'RECEIVED',
    knownSocketUrl?: string
  ): void {
    if (!event.requestId) return
    const url = knownSocketUrl ?? this.socketUrls.get(event.requestId)
    if (!url) return
    const payload = gateWebSocketPayload(event, direction)
    if (payload === undefined) return
    if (payload.length > 2_000_000) return
    const captured = { url, payload, requestId: event.requestId, direction, receivedAt: Date.now(), pageUrl }
    for (const listener of this.rawFrameListeners) listener(captured)
    // Regional Gate frontends use order_book, market/book, asks/bids and
    // ticker names interchangeably. Keep this broad enough for the actual
    // book stream while dropping heartbeats and UI telemetry.
    if (!/event|predict|contract|order[._-]?book|depth|market|book|asks|bids|ticker/i.test(`${url}\n${payload}`)) return
    this.webSocketFrameCount += 1
    this.lastCaptureAt = captured.receivedAt
    this.setStatus('CONNECTED', this.captureStatusMessage())
    for (const listener of this.frameListeners) listener(captured)
  }

  private async handlePlaywrightResponse(session: CDPSession, page: Page, event: CdpResponseReceived): Promise<void> {
    const url = event.response?.url ?? ''
    if (!event.requestId || !isGateHost(url) || !['XHR', 'Fetch'].includes(event.type ?? '') || (!isGateEventResponse(url) && this.networkResponseListeners.size === 0)) return
    try {
      const result = await session.send('Network.getResponseBody', { requestId: event.requestId }) as { body?: string; base64Encoded?: boolean }
      if (!result.body) return
      const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body
      const captured = { url, body, requestId: event.requestId, status: event.response?.status, resourceType: event.type, receivedAt: Date.now(), pageUrl: page.url() }
      this.responseCount += 1
      this.lastCaptureAt = captured.receivedAt
      this.setStatus('CONNECTED', this.captureStatusMessage('已接管指纹浏览器'))
      for (const listener of this.networkResponseListeners) listener(captured)
      if (isGateEventResponse(url)) for (const listener of this.responseListeners) listener(captured)
    } catch {
      // Cached, redirected or evicted responses can disappear before CDP reads them.
    }
  }

  private captureStatusMessage(prefix = '单页面'): string {
    return `Gate ${prefix}监听在线；已捕获 ${this.responseCount} 个事件合约响应、${this.webSocketFrameCount} 个 Gate WebSocket 帧，没有额外调用内部接口`
  }

  private setStatus(state: GatePageCaptureStatus['state'], message: string): void {
    const now = Date.now()
    this.status = {
      state,
      message,
      updatedAt: now,
      responseCount: this.responseCount,
      webSocketFrameCount: this.webSocketFrameCount,
      lastCaptureAt: this.lastCaptureAt
    }
    if (state === 'CONNECTED' && now - this.lastStatusNotifyAt < 500) return
    this.lastStatusNotifyAt = now
    for (const listener of this.statusListeners) listener(this.getStatus())
  }
}
