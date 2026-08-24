import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Browser, Page } from 'playwright-core'
import type { VenueId } from '../../shared/multi-venue'

const DEFAULT_HUBSTUDIO_API = 'http://127.0.0.1:6873'
const execFileAsync = promisify(execFile)

export interface FingerprintBrowserBackend {
  resolveRunningPort(containerCode: string): Promise<number>
  start(containerCode: string, startupUrl?: string): Promise<{ debuggingPort: number }>
  connect(debuggingPort: number): Promise<Browser>
}

export interface FingerprintBrowserRuntimeConfig {
  containerCode: string
  provider?: 'HUBSTUDIO'
}

export interface AttachPageOptions {
  hosts: string[]
  createIfMissing?: boolean
  startupUrl?: string
}

function hostMatches(rawUrl: string, hosts: string[]): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase()
    return hosts.some((candidate) => {
      const normalized = candidate.toLowerCase().replace(/^\*\./, '')
      return hostname === normalized || hostname.endsWith(`.${normalized}`)
    })
  } catch {
    return false
  }
}

async function discoverHubstudioApiBase(): Promise<string> {
  const candidates = new Set<number>([6873])
  try {
    const result = process.platform === 'win32'
      ? await execFileAsync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='Hubstudio.exe'\" | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8' })
      : await execFileAsync('ps', ['-axo', 'args='], { encoding: 'utf8' })
    for (const match of String(result.stdout).matchAll(/httpServer\.cjs\D+(\d{2,5})/g)) candidates.add(Number(match[1]))
  } catch {
    // Fixed port remains the compatible fallback.
  }
  for (const port of candidates) {
    const base = `http://127.0.0.1:${port}`
    try {
      const response = await fetch(`${base}/api/v1/browser/all-browser-status`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]', signal: AbortSignal.timeout(1_500)
      })
      if (response.ok && typeof (await response.json() as { code?: unknown }).code === 'number') return base
    } catch {
      // Continue probing the next candidate.
    }
  }
  return DEFAULT_HUBSTUDIO_API
}

async function callHubstudio<T>(base: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) throw new Error(`Hubstudio Local API 返回 HTTP ${response.status}`)
  return await response.json() as T
}

interface HubstudioStatusResponse { code: number; data?: { containers?: Array<{ containerCode?: string; pid?: number; debuggingPort?: number }> } }
interface HubstudioStartResponse { code: number; msg?: string; data?: { debuggingPort?: number } }

async function resolvePortFromPid(pid: number): Promise<number> {
  try {
    const command = process.platform === 'win32' ? 'netstat' : 'lsof'
    const args = process.platform === 'win32' ? ['-ano', '-p', 'TCP'] : ['-Pan', '-p', String(pid), '-iTCP', '-sTCP:LISTEN']
    const result = await execFileAsync(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    const ports = process.platform === 'win32'
      ? String(result.stdout).split('\n').filter((line) => line.trim().endsWith(String(pid))).map((line) => Number(line.match(/:(\d+)\s+LISTENING/i)?.[1]))
      : Array.from(String(result.stdout).matchAll(/:(\d+)\s+\(LISTEN\)/g), (match) => Number(match[1]))
    for (const port of [...new Set(ports.filter((value) => Number.isInteger(value) && value > 0))]) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) })
        if (response.ok && (await response.json() as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl) return port
      } catch {
        // This listener is not a Chromium DevTools endpoint.
      }
    }
  } catch {
    // Process inspection is unavailable; caller may start/adopt again later.
  }
  return 0
}

const defaultBackend: FingerprintBrowserBackend = {
  async resolveRunningPort(containerCode) {
    const base = await discoverHubstudioApiBase()
    const status = await callHubstudio<HubstudioStatusResponse>(base, '/api/v1/browser/all-browser-status', [containerCode])
    const container = status.data?.containers?.find((candidate) => candidate.containerCode === containerCode)
    const direct = Number(container?.debuggingPort)
    if (Number.isInteger(direct) && direct > 0) return direct
    const pid = Number(container?.pid)
    return Number.isInteger(pid) && pid > 0 ? await resolvePortFromPid(pid) : 0
  },
  async start(containerCode, startupUrl) {
    const base = await discoverHubstudioApiBase()
    const result = await callHubstudio<HubstudioStartResponse>(base, '/api/v1/browser/start', {
      containerCode, isHeadless: false, isWebDriverReadOnlyMode: false, ...(startupUrl ? { containerTabs: [startupUrl] } : {})
    })
    const debuggingPort = Number(result.data?.debuggingPort)
    if (result.code !== 0 || !Number.isInteger(debuggingPort) || debuggingPort <= 0) {
      throw new Error(`Hubstudio 环境启动失败（${result.code}）：${result.msg ?? '未返回调试端口'}`)
    }
    return { debuggingPort }
  },
  async connect(debuggingPort) {
    const { chromium } = await import('playwright-core')
    return await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`)
  }
}

export class FingerprintBrowserRuntime {
  private config?: FingerprintBrowserRuntimeConfig
  private browser?: Browser
  private connectedContainerCode?: string
  private attachPromise?: Promise<Browser>
  private pages = new Map<VenueId, Page>()

  constructor(private readonly backend: FingerprintBrowserBackend = defaultBackend) {}

  configure(config: FingerprintBrowserRuntimeConfig): void {
    const containerCode = config.containerCode.trim()
    if (this.connectedContainerCode && this.connectedContainerCode !== containerCode) this.disconnect()
    this.config = { provider: 'HUBSTUDIO', ...config, containerCode }
  }

  async attach(venueId: VenueId, options: AttachPageOptions): Promise<Page> {
    const containerCode = this.config?.containerCode
    if (!containerCode) throw new Error('请先配置指纹浏览器环境ID')
    const current = this.pages.get(venueId)
    if (current && !current.isClosed() && hostMatches(current.url(), options.hosts)) return current

    const browser = await this.ensureBrowser(containerCode, options.startupUrl)
    const context = browser.contexts()[0]
    if (!context) throw new Error('指纹浏览器没有可用的浏览器上下文')
    let page = context.pages().find((candidate) => !candidate.isClosed() && hostMatches(candidate.url(), options.hosts))
    if (!page && options.createIfMissing !== false) {
      page = await context.newPage()
      if (options.startupUrl) await page.goto(options.startupUrl, { waitUntil: 'domcontentloaded' })
    }
    if (!page) throw new Error(`没有找到 ${venueId} 指纹浏览器标签页`)
    this.pages.set(venueId, page)
    page.on('close', () => { if (this.pages.get(venueId) === page) this.pages.delete(venueId) })
    return page
  }

  getPage(venueId: VenueId): Page | undefined {
    const page = this.pages.get(venueId)
    return page && !page.isClosed() ? page : undefined
  }

  isConfigured(): boolean { return Boolean(this.config?.containerCode) }

  disconnect(): void {
    this.pages.clear()
    this.browser = undefined
    this.connectedContainerCode = undefined
    // The browser is owned by Hubstudio/the user. Dropping local Playwright
    // references must not close the user's logged-in fingerprint environment.
  }

  private async ensureBrowser(containerCode: string, startupUrl?: string): Promise<Browser> {
    if (this.browser?.isConnected() && this.connectedContainerCode === containerCode) return this.browser
    if (this.attachPromise) return await this.attachPromise
    this.attachPromise = (async () => {
      let debuggingPort = await this.backend.resolveRunningPort(containerCode)
      if (!debuggingPort) debuggingPort = (await this.backend.start(containerCode, startupUrl)).debuggingPort
      const browser = await this.backend.connect(debuggingPort)
      this.browser = browser
      this.connectedContainerCode = containerCode
      browser.on('disconnected', () => {
        if (this.browser === browser) {
          this.browser = undefined
          this.connectedContainerCode = undefined
          this.pages.clear()
        }
      })
      return browser
    })().finally(() => { this.attachPromise = undefined })
    return await this.attachPromise
  }
}
