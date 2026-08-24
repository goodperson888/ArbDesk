import { app, BrowserWindow, shell } from 'electron'
import type { GatePageCaptureStatus } from '../../shared/types'

// The duration-specific route only keeps the 15m contract stream active on
// current Gate builds. The event-contract index page carries both BTC 5m and
// 15m lists while remaining a single passive page/capture surface.
const GATE_PAGE_URL = 'https://www.gate.com/zh/trade-events'
const PAGE_START_TIMEOUT_MS = 25_000
const PAGE_ROLL_INTERVAL_MS = 5 * 60_000

export interface GateCapturedResponse {
  url: string
  body: string
  receivedAt: number
  /** The visible/hidden page URL that initiated the request. */
  pageUrl?: string
}

export interface GateCapturedWebSocketFrame {
  url: string
  payload: string
  receivedAt: number
  /** The visible/hidden page URL that owns the socket. */
  pageUrl?: string
}

export interface GatePageCaptureSource {
  getStatus(): GatePageCaptureStatus
  onResponse(listener: (event: GateCapturedResponse) => void): () => void
  onWebSocketFrame(listener: (event: GateCapturedWebSocketFrame) => void): () => void
  onStatus(listener: (status: GatePageCaptureStatus) => void): () => void
  start(show?: boolean): Promise<void>
  stop(): void
}

interface CdpResponseReceived {
  requestId?: string
  type?: string
  response?: { url?: string; mimeType?: string; status?: number }
}

interface CdpWebSocketCreated {
  requestId?: string
  url?: string
}

interface CdpWebSocketFrame {
  requestId?: string
  response?: { opcode?: number; payloadData?: string }
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
  private startPromise?: Promise<void>
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
  private responseListeners = new Set<(event: GateCapturedResponse) => void>()
  private frameListeners = new Set<(event: GateCapturedWebSocketFrame) => void>()
  private statusListeners = new Set<(status: GatePageCaptureStatus) => void>()

  constructor() {
    app.once('before-quit', () => {
      this.stopping = true
      this.window?.destroy()
    })
  }

  getStatus(): GatePageCaptureStatus { return { ...this.status } }

  onResponse(listener: (event: GateCapturedResponse) => void): () => void {
    this.responseListeners.add(listener)
    return () => this.responseListeners.delete(listener)
  }

  onWebSocketFrame(listener: (event: GateCapturedWebSocketFrame) => void): () => void {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  onStatus(listener: (status: GatePageCaptureStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  async start(show = false): Promise<void> {
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
    const window = this.window
    if (!window || window.isDestroyed()) return
    this.destroying = true
    window.destroy()
  }

  open(): void {
    if (!this.window || this.window.isDestroyed()) {
      void this.start(true)
      return
    }
    this.window.show()
    this.window.focus()
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
    const initialRollSlot = Math.floor(Date.now() / PAGE_ROLL_INTERVAL_MS)
    void window.loadURL(GATE_PAGE_URL)
      .then(() => { this.loadedRollSlot = initialRollSlot })
      .catch((error) => {
        clearTimeout(startupTimeout)
        this.setStatus('DISCONNECTED', `Gate 页面无法打开：${error instanceof Error ? error.message : String(error)}`)
      })
  }

  private async refreshForCurrentRoll(window: BrowserWindow): Promise<void> {
    const rollSlot = Math.floor(Date.now() / PAGE_ROLL_INTERVAL_MS)
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
    })
    debug.on('detach', (_event, reason) => {
      if (!this.stopping) this.setStatus('DISCONNECTED', `Gate 网络监听已断开：${reason}`)
    })
  }

  private async handleResponse(window: BrowserWindow, event: CdpResponseReceived): Promise<void> {
    const url = event.response?.url ?? ''
    if (!event.requestId || !isGateEventResponse(url) || !['XHR', 'Fetch'].includes(event.type ?? '')) return
    try {
      const result = await window.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: event.requestId }) as {
        body?: string
        base64Encoded?: boolean
      }
      if (!result.body) return
      const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body
      const captured = { url, body, receivedAt: Date.now(), pageUrl: window.webContents.getURL() }
      this.responseCount += 1
      this.lastCaptureAt = captured.receivedAt
      this.setStatus('CONNECTED', this.captureStatusMessage())
      for (const listener of this.responseListeners) listener(captured)
    } catch {
      // Cached, redirected or evicted responses can disappear before CDP reads them.
    }
  }

  private handleFrame(event: CdpWebSocketFrame): void {
    if (!event.requestId || event.response?.opcode !== 1 || typeof event.response.payloadData !== 'string') return
    const url = this.socketUrls.get(event.requestId)
    if (!url) return
    const payload = event.response.payloadData
    if (payload.length > 2_000_000) return
    // Regional Gate frontends use order_book, market/book, asks/bids and
    // ticker names interchangeably. Keep this broad enough for the actual
    // book stream while dropping heartbeats and UI telemetry.
    if (!/event|predict|contract|order[._-]?book|depth|market|book|asks|bids|ticker/i.test(`${url}\n${payload}`)) return
    const captured = { url, payload, receivedAt: Date.now(), pageUrl: this.window?.webContents.getURL() }
    this.webSocketFrameCount += 1
    this.lastCaptureAt = captured.receivedAt
    this.setStatus('CONNECTED', this.captureStatusMessage())
    for (const listener of this.frameListeners) listener(captured)
  }

  private captureStatusMessage(): string {
    return `Gate 单页面被动监听在线；已捕获 ${this.responseCount} 个事件合约响应、${this.webSocketFrameCount} 个 Gate WebSocket 帧，没有额外调用内部接口`
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
