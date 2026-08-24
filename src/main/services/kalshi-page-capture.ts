import { app, BrowserWindow, shell } from 'electron'
import type { KalshiPageCaptureStatus } from '../../shared/types'

const KALSHI_PAGE_URL = 'https://kalshi.com/markets'
const PAGE_START_TIMEOUT_MS = 25_000

export interface KalshiCapturedResponse { url: string; body: string; receivedAt: number }
export interface KalshiCapturedWebSocketFrame { url: string; payload: string; receivedAt: number }

export interface KalshiPageCaptureSource {
  getStatus(): KalshiPageCaptureStatus
  onResponse(listener: (event: KalshiCapturedResponse) => void): () => void
  onWebSocketFrame(listener: (event: KalshiCapturedWebSocketFrame) => void): () => void
  onStatus(listener: (status: KalshiPageCaptureStatus) => void): () => void
  start(show?: boolean): Promise<void>
  stop(): void
  open(): void
}

interface CdpResponseReceived { requestId?: string; type?: string; response?: { url?: string; status?: number } }
interface CdpWebSocketCreated { requestId?: string; url?: string }
interface CdpWebSocketFrame { requestId?: string; response?: { opcode?: number; payloadData?: string } }

export function isKalshiHost(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase()
    return hostname === 'kalshi.com' || hostname.endsWith('.kalshi.com') || hostname.endsWith('.kalshi.co')
  } catch { return false }
}

export function isKalshiMarketResponse(rawUrl: string): boolean {
  if (!isKalshiHost(rawUrl)) return false
  try {
    const url = new URL(rawUrl)
    return /trade-api|market|event|orderbook|ticker|portfolio/i.test(`${url.pathname}${url.search}`)
  } catch { return false }
}

export class KalshiPageCapture implements KalshiPageCaptureSource {
  private window?: BrowserWindow
  private startPromise?: Promise<void>
  private stopping = false
  private destroying = false
  private status: KalshiPageCaptureStatus = { state: 'IDLE', message: 'Kalshi 网页被动行情尚未启动' }
  private socketUrls = new Map<string, string>()
  private responseCount = 0
  private webSocketFrameCount = 0
  private lastCaptureAt?: number
  private lastStatusNotifyAt = 0
  private responseListeners = new Set<(event: KalshiCapturedResponse) => void>()
  private frameListeners = new Set<(event: KalshiCapturedWebSocketFrame) => void>()
  private statusListeners = new Set<(status: KalshiPageCaptureStatus) => void>()

  constructor() {
    app.once('before-quit', () => { this.stopping = true; this.window?.destroy() })
  }

  getStatus(): KalshiPageCaptureStatus { return { ...this.status } }
  onResponse(listener: (event: KalshiCapturedResponse) => void): () => void { this.responseListeners.add(listener); return () => this.responseListeners.delete(listener) }
  onWebSocketFrame(listener: (event: KalshiCapturedWebSocketFrame) => void): () => void { this.frameListeners.add(listener); return () => this.frameListeners.delete(listener) }
  onStatus(listener: (status: KalshiPageCaptureStatus) => void): () => void { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener) }

  async start(show = false): Promise<void> {
    if (this.window && !this.window.isDestroyed()) { if (show) this.open(); return }
    if (this.startPromise) { await this.startPromise; if (show) this.open(); return }
    this.startPromise = this.createWindow(show)
    try { await this.startPromise } finally { this.startPromise = undefined }
  }

  stop(): void {
    const window = this.window
    if (!window || window.isDestroyed()) return
    this.destroying = true
    window.destroy()
  }

  open(): void {
    if (!this.window || this.window.isDestroyed()) { void this.start(true); return }
    this.window.show(); this.window.focus()
  }

  private async createWindow(show: boolean): Promise<void> {
    this.setStatus('STARTING', '正在启动单个 Kalshi 网页；优先监听网页自身请求')
    const window = new BrowserWindow({
      width: 1280, height: 860, minWidth: 900, minHeight: 640, show,
      title: 'Kalshi · ArbDesk 被动行情', backgroundColor: '#020617',
      webPreferences: { partition: 'persist:kalshi-arbdesk', contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true }
    })
    this.window = window
    const startupTimeout = setTimeout(() => {
      if (this.window === window && this.status.state === 'STARTING') this.setStatus('DISCONNECTED', 'Kalshi 页面加载超时；请打开单页面检查网络或登录状态')
    }, PAGE_START_TIMEOUT_MS)
    startupTimeout.unref()
    window.webContents.setAudioMuted(true)
    window.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith('https://')) void shell.openExternal(url); return { action: 'deny' } })
    window.on('close', (event) => { if (!this.stopping && !this.destroying) { event.preventDefault(); window.hide() } })
    window.on('closed', () => {
      clearTimeout(startupTimeout)
      if (this.window === window) this.window = undefined
      this.socketUrls.clear()
      const wasDestroying = this.destroying
      this.destroying = false
      this.setStatus(wasDestroying ? 'IDLE' : 'DISCONNECTED', wasDestroying ? 'Kalshi 网页监听已停止；页面资源已释放' : 'Kalshi 网页监听窗口已关闭')
    })
    window.webContents.on('did-finish-load', () => { clearTimeout(startupTimeout); this.setStatus('CONNECTED', this.captureStatusMessage()) })
    window.webContents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => { if (isMainFrame) { clearTimeout(startupTimeout); this.setStatus('DISCONNECTED', `Kalshi 页面加载失败（${code}）：${description} · ${validatedUrl}`) } })
    this.attachDebugger(window)
    void window.loadURL(KALSHI_PAGE_URL).catch((error) => { clearTimeout(startupTimeout); this.setStatus('DISCONNECTED', `Kalshi 页面无法打开：${error instanceof Error ? error.message : String(error)}`) })
  }

  private attachDebugger(window: BrowserWindow): void {
    const debug = window.webContents.debugger
    try { if (!debug.isAttached()) debug.attach('1.3') } catch (error) { this.setStatus('DISCONNECTED', `无法启动 Kalshi 被动监听：${error instanceof Error ? error.message : String(error)}`); return }
    void debug.sendCommand('Network.enable').catch((error) => this.setStatus('DISCONNECTED', `无法启用 Kalshi 网络监听：${error instanceof Error ? error.message : String(error)}`))
    debug.on('message', (_event, method, rawParams) => {
      if (method === 'Network.responseReceived') { void this.handleResponse(window, rawParams as CdpResponseReceived); return }
      if (method === 'Network.webSocketCreated') { const event = rawParams as CdpWebSocketCreated; if (event.requestId && event.url && isKalshiHost(event.url)) this.socketUrls.set(event.requestId, event.url); return }
      if (method === 'Network.webSocketClosed') { const requestId = (rawParams as { requestId?: string }).requestId; if (requestId) this.socketUrls.delete(requestId); return }
      if (method === 'Network.webSocketFrameReceived') this.handleFrame(rawParams as CdpWebSocketFrame)
    })
    debug.on('detach', (_event, reason) => { if (!this.stopping) this.setStatus('DISCONNECTED', `Kalshi 网络监听已断开：${reason}`) })
  }

  private async handleResponse(window: BrowserWindow, event: CdpResponseReceived): Promise<void> {
    const url = event.response?.url ?? ''
    if (!event.requestId || !isKalshiMarketResponse(url) || !['XHR', 'Fetch'].includes(event.type ?? '')) return
    try {
      const result = await window.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: event.requestId }) as { body?: string; base64Encoded?: boolean }
      if (!result.body) return
      const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body
      const captured = { url, body, receivedAt: Date.now() }
      this.responseCount += 1; this.lastCaptureAt = captured.receivedAt; this.setStatus('CONNECTED', this.captureStatusMessage())
      for (const listener of this.responseListeners) listener(captured)
    } catch { /* response body may already be evicted */ }
  }

  private handleFrame(event: CdpWebSocketFrame): void {
    if (!event.requestId || event.response?.opcode !== 1 || typeof event.response.payloadData !== 'string') return
    const url = this.socketUrls.get(event.requestId); if (!url) return
    const captured = { url, payload: event.response.payloadData, receivedAt: Date.now() }
    this.webSocketFrameCount += 1; this.lastCaptureAt = captured.receivedAt; this.setStatus('CONNECTED', this.captureStatusMessage())
    for (const listener of this.frameListeners) listener(captured)
  }

  private captureStatusMessage(): string { return `Kalshi 单页面被动监听在线；已捕获 ${this.responseCount} 个目标响应、${this.webSocketFrameCount} 个 WebSocket 帧，没有额外调用内部接口` }
  private setStatus(state: KalshiPageCaptureStatus['state'], message: string): void {
    const now = Date.now()
    this.status = { state, message, updatedAt: Date.now(), responseCount: this.responseCount, webSocketFrameCount: this.webSocketFrameCount, lastCaptureAt: this.lastCaptureAt }
    if (state === 'CONNECTED' && now - this.lastStatusNotifyAt < 500) return
    this.lastStatusNotifyAt = now
    for (const listener of this.statusListeners) listener(this.getStatus())
  }
}
