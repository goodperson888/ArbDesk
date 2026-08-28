import { app, BrowserWindow, shell } from 'electron'
import type { PredictFunPageCaptureStatus } from '../../shared/types'

export type { PredictFunPageCaptureStatus } from '../../shared/types'

const PAGE_START_TIMEOUT_MS = 20_000
// The page is anchored to the current 15m URL, but the 5m market IDs exposed
// by that page rotate every five minutes. Reload once at the 5m boundary so
// its GraphQL directory and WebSocket subscriptions advance together. This is
// a page-owned refresh, not an additional application API poll.
const PAGE_ROLL_INTERVAL_MS = 5 * 60_000
const PAGE_ROLL_SETTLE_MS = 1_250

function currentPredictMarketUrl(now = Date.now()): string {
  const slot = Math.floor(now / 900_000) * 900
  return `https://predict.fun/zh-cn/market/btc-updown-15m-${slot}`
}

export interface PredictFunCapturedResponse {
  url: string
  body: string
  receivedAt: number
  pageUrl?: string
  operationName?: string
  requestSlugs?: string[]
  requestMarketIds?: string[]
}

export interface PredictFunCapturedWebSocketFrame {
  url: string
  payload: string
  receivedAt: number
}

export interface PredictFunPageCaptureSource {
  getStatus(): PredictFunPageCaptureStatus
  onResponse(listener: (event: PredictFunCapturedResponse) => void): () => void
  onWebSocketFrame(listener: (event: PredictFunCapturedWebSocketFrame) => void): () => void
  onStatus(listener: (status: PredictFunPageCaptureStatus) => void): () => void
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
  request?: { url?: string; postData?: string }
}

interface PredictGraphqlRequestMetadata {
  operationName?: string
  slugs: string[]
  marketIds: string[]
}

function graphqlRequestMetadata(postData: string | undefined): PredictGraphqlRequestMetadata | undefined {
  if (!postData) return undefined
  try {
    const body = JSON.parse(postData) as unknown
    const operations = Array.isArray(body) ? body : [body]
    const slugs = new Set<string>()
    const marketIds = new Set<string>()
    let operationName: string | undefined
    const walk = (value: unknown, parentKey = '', depth = 0): void => {
      if (depth > 8 || value === null || value === undefined) return
      if (typeof value === 'string' || typeof value === 'number') {
        if (/^(?:category)?slug$/i.test(parentKey) && /^btc-updown-(?:5|15)m-\d+$/i.test(String(value))) slugs.add(String(value))
        if (/^marketId$/i.test(parentKey) && /^\d+$/.test(String(value))) marketIds.add(String(value))
        return
      }
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry, parentKey, depth + 1)
        return
      }
      if (typeof value !== 'object') return
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) walk(entry, key, depth + 1)
    }
    for (const operation of operations) {
      if (!operation || typeof operation !== 'object') continue
      const record = operation as Record<string, unknown>
      if (!operationName && typeof record.operationName === 'string') operationName = record.operationName
      walk(record.variables)
    }
    return { operationName, slugs: [...slugs], marketIds: [...marketIds] }
  } catch {
    return undefined
  }
}

interface CdpWebSocketCreated {
  requestId?: string
  url?: string
}

interface CdpWebSocketFrame {
  requestId?: string
  response?: { opcode?: number; payloadData?: string }
}

function isPredictHost(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase()
    return hostname === 'predict.fun' || hostname.endsWith('.predict.fun')
  } catch {
    return false
  }
}

function isUsefulResponse(rawUrl: string): boolean {
  if (!isPredictHost(rawUrl)) return false
  try {
    const url = new URL(rawUrl)
    const path = url.pathname
    return path.includes('/v1/categories') || /^\/v1\/markets\/\d+\/orderbook$/.test(path) ||
      path.endsWith('/graphql')
  } catch {
    return false
  }
}

export class PredictFunPageCapture implements PredictFunPageCaptureSource {
  private window?: BrowserWindow
  private startPromise?: Promise<void>
  private stopping = false
  private destroying = false
  private status: PredictFunPageCaptureStatus = { state: 'IDLE', message: 'Predict.fun 网页被动行情尚未启动' }
  private socketUrls = new Map<string, string>()
  private graphqlRequests = new Map<string, PredictGraphqlRequestMetadata>()
  private responseCount = 0
  private webSocketFrameCount = 0
  private lastCaptureAt?: number
  private lastStatusNotifyAt = 0
  private loadedRollSlot?: number
  private lastPageRollAt?: number
  private rollPromise?: Promise<void>
  private rollTimer?: NodeJS.Timeout
  private responseListeners = new Set<(event: PredictFunCapturedResponse) => void>()
  private frameListeners = new Set<(event: PredictFunCapturedWebSocketFrame) => void>()
  private statusListeners = new Set<(status: PredictFunPageCaptureStatus) => void>()

  constructor() {
    app.once('before-quit', () => {
      this.stopping = true
      this.window?.destroy()
    })
  }

  getStatus(): PredictFunPageCaptureStatus {
    return { ...this.status }
  }

  onResponse(listener: (event: PredictFunCapturedResponse) => void): () => void {
    this.responseListeners.add(listener)
    return () => this.responseListeners.delete(listener)
  }

  onWebSocketFrame(listener: (event: PredictFunCapturedWebSocketFrame) => void): () => void {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  onStatus(listener: (status: PredictFunPageCaptureStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  async start(show = false): Promise<void> {
    if (this.window && !this.window.isDestroyed()) {
      await this.refreshForCurrentRoll(this.window)
      if (show) {
        this.window.show()
        this.window.focus()
      }
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
    if (this.rollTimer) clearTimeout(this.rollTimer)
    this.rollTimer = undefined
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
    this.setStatus('STARTING', '正在启动单个 Predict.fun 网页；只监听网页自身请求')
    const window = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 900,
      minHeight: 640,
      show,
      title: 'Predict.fun · ArbDesk 被动行情',
      backgroundColor: '#020617',
      webPreferences: {
        partition: 'persist:predict-fun-arbdesk',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // This window is a hidden passive network source. Allow Chromium to
        // throttle page timers when it is not visible; CDP network events and
        // the WebSocket remain available while reducing idle CPU/heat.
        backgroundThrottling: true
      }
    })
    this.window = window
    const startupTimeout = setTimeout(() => {
      if (this.window === window && this.status.state === 'STARTING') {
        this.setStatus(
          'DISCONNECTED',
          'Predict.fun 页面 20 秒内未完成加载；扫描流程未被阻塞。请打开该单页面检查网络或完成人机验证，加载成功后会自动恢复监听'
        )
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
      if (this.rollTimer) clearTimeout(this.rollTimer)
      this.rollTimer = undefined
      if (this.window === window) this.window = undefined
      this.socketUrls.clear()
      const wasDestroying = this.destroying
      this.destroying = false
      this.setStatus(wasDestroying ? 'IDLE' : 'DISCONNECTED', wasDestroying ? 'Predict.fun 网页监听已停止；页面资源已释放' : 'Predict.fun 网页监听窗口已关闭')
    })
    window.webContents.on('did-finish-load', () => {
      clearTimeout(startupTimeout)
      this.setStatus('CONNECTED', this.captureStatusMessage())
    })
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame) return
      clearTimeout(startupTimeout)
      this.setStatus('DISCONNECTED', `Predict.fun 页面加载失败（${errorCode}）：${errorDescription} · ${validatedUrl}`)
    })
    this.attachDebugger(window, !show)
    const initialRollSlot = Math.floor(Date.now() / PAGE_ROLL_INTERVAL_MS)
    void window.loadURL(currentPredictMarketUrl())
      .then(() => {
        this.loadedRollSlot = initialRollSlot
        this.lastPageRollAt = Date.now()
        this.scheduleNextRoll(window)
      })
      .catch((error) => {
        clearTimeout(startupTimeout)
        this.setStatus('DISCONNECTED', `Predict.fun 页面无法打开：${error instanceof Error ? error.message : String(error)}`)
      })
  }

  private async refreshForCurrentRoll(window: BrowserWindow): Promise<void> {
    const rollSlot = Math.floor(Date.now() / PAGE_ROLL_INTERVAL_MS)
    if (this.loadedRollSlot === rollSlot) return
    if (this.rollPromise) return await this.rollPromise
    this.rollPromise = window.loadURL(currentPredictMarketUrl())
      .then(() => {
        this.loadedRollSlot = rollSlot
        this.lastPageRollAt = Date.now()
      })
      .catch((error) => {
        this.setStatus('DISCONNECTED', `Predict.fun 新轮次页面刷新失败：${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => { this.rollPromise = undefined })
    await this.rollPromise
  }

  private scheduleNextRoll(window: BrowserWindow): void {
    if (this.rollTimer) clearTimeout(this.rollTimer)
    const now = Date.now()
    const nextBoundary = (Math.floor(now / PAGE_ROLL_INTERVAL_MS) + 1) * PAGE_ROLL_INTERVAL_MS
    this.rollTimer = setTimeout(async () => {
      this.rollTimer = undefined
      if (this.window !== window || window.isDestroyed()) return
      await this.refreshForCurrentRoll(window)
      if (this.window === window && !window.isDestroyed()) this.scheduleNextRoll(window)
    }, Math.max(1_000, nextBoundary - now + PAGE_ROLL_SETTLE_MS))
    this.rollTimer.unref()
  }

  private attachDebugger(window: BrowserWindow, backgroundCapture: boolean): void {
    const debug = window.webContents.debugger
    try {
      if (!debug.isAttached()) debug.attach('1.3')
    } catch (error) {
      this.setStatus('DISCONNECTED', `无法启动 Predict.fun 被动监听：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    void debug.sendCommand('Network.enable').then(() => {
      if (!backgroundCapture) return
      return debug.sendCommand('Network.setBlockedURLs', {
        urls: ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.svg', '*.woff', '*.woff2', '*.ttf', '*.mp4', '*.webm', '*google-analytics*', '*googletagmanager*', '*doubleclick*']
      })
    }).catch((error) => {
      this.setStatus('DISCONNECTED', `无法启用 Predict.fun 网络监听：${error instanceof Error ? error.message : String(error)}`)
    })
    debug.on('message', (_event, method, rawParams) => {
      if (method === 'Network.requestWillBeSent') {
        const event = rawParams as CdpRequestWillBeSent
        const url = event.request?.url ?? ''
        if (event.requestId && isPredictHost(url) && url.includes('/graphql')) {
          const metadata = graphqlRequestMetadata(event.request?.postData)
          if (metadata) this.graphqlRequests.set(event.requestId, metadata)
        }
        return
      }
      if (method === 'Network.responseReceived') {
        void this.handleResponse(window, rawParams as CdpResponseReceived)
        return
      }
      if (method === 'Network.webSocketCreated') {
        const event = rawParams as CdpWebSocketCreated
        if (event.requestId && event.url && isPredictHost(event.url)) {
          this.socketUrls.set(event.requestId, event.url)
        }
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
      if (!this.stopping) this.setStatus('DISCONNECTED', `Predict.fun 网络监听已断开：${reason}`)
    })
  }

  private async handleResponse(window: BrowserWindow, event: CdpResponseReceived): Promise<void> {
    const url = event.response?.url ?? ''
    if (!event.requestId || !isUsefulResponse(url) || !['XHR', 'Fetch'].includes(event.type ?? '')) return
    try {
      const result = await window.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: event.requestId }) as {
        body?: string
        base64Encoded?: boolean
      }
      if (!result.body) return
      const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body
      const requestMetadata = this.graphqlRequests.get(event.requestId)
      this.graphqlRequests.delete(event.requestId)
      const captured: PredictFunCapturedResponse = {
        url,
        body,
        receivedAt: Date.now(),
        pageUrl: window.webContents.getURL(),
        operationName: requestMetadata?.operationName,
        requestSlugs: requestMetadata?.slugs,
        requestMarketIds: requestMetadata?.marketIds
      }
      this.responseCount += 1
      this.lastCaptureAt = captured.receivedAt
      this.setStatus('CONNECTED', this.captureStatusMessage())
      for (const listener of this.responseListeners) listener(captured)
    } catch {
      // Cached, redirected or already-evicted responses can disappear before getResponseBody.
    }
  }

  private handleFrame(event: CdpWebSocketFrame): void {
    if (!event.requestId || event.response?.opcode !== 1 || typeof event.response.payloadData !== 'string') return
    const url = this.socketUrls.get(event.requestId)
    if (!url) return
    const payload = event.response.payloadData
    // Predict.fun pages also carry heartbeats, presence and UI telemetry.
    // Only forward likely orderbook frames to the JSON parser; no API key is
    // required for this passive page path.
    if (payload.length > 2_000_000 || !/predictOrderbook|predict(?:Trading|Market)Status|order[._:/-]?book|"type"\s*:\s*"M"/i.test(payload)) return
    const captured = { url, payload, receivedAt: Date.now() }
    this.webSocketFrameCount += 1
    this.lastCaptureAt = captured.receivedAt
    this.setStatus('CONNECTED', this.captureStatusMessage())
    for (const listener of this.frameListeners) listener(captured)
  }

  private captureStatusMessage(): string {
    const roll = this.lastPageRollAt ? `；页面目录最近换轮 ${new Date(this.lastPageRollAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''
    return `Predict.fun 单页面被动监听在线；已捕获 ${this.responseCount} 个目标 REST/GraphQL 响应、${this.webSocketFrameCount} 个 WebSocket 帧${roll}，没有额外调用内部接口`
  }

  private setStatus(state: PredictFunPageCaptureStatus['state'], message: string): void {
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
