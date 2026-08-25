import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, powerMonitor, shell } from 'electron'
import { AppController } from './app-controller'
import { EventStore } from './services/event-store'
import { MexcBrowserManager } from './services/mexc-browser'
import { PolymarketCredentialStore } from './services/polymarket-credential-store'
import { PolymarketLiveBroker } from './services/polymarket-live'
import { PredictFunCredentialStore } from './services/predict-fun-credential-store'
import { LimitlessCredentialStore } from './services/limitless-credential-store'
import { GateCredentialStore } from './services/gate-credential-store'
import { GatePageCapture } from './services/gate-page-capture'
import { GateOrderCapture } from './services/gate-order-capture'
import { GateBrowserOrderTransport } from './services/gate-order-transport'
import { GateMarketData } from './services/gate-market-data'
import { GatePreparationService } from './services/gate-preparation'
import { KalshiCredentialStore } from './services/kalshi-credential-store'
import { KalshiMarketData } from './services/kalshi-market-data'
import { KalshiPreparationService } from './services/kalshi-preparation'
import { KalshiTradingService } from './services/kalshi-trading'
import { MultiVenueExecutionService } from './services/multi-venue-execution'
import { ExecutionSessionStore } from './services/execution-session-store'
import { KalshiPageCapture } from './services/kalshi-page-capture'
import { PredictFunMarketData } from './services/predict-fun-market-data'
import { PredictFunPageCapture } from './services/predict-fun-page-capture'
import { LimitlessMarketData } from './services/limitless-market-data'
import { MultiVenueMarketData } from './services/multi-venue-market-data'
import { LimitlessPreparationService, PredictFunPreparationService } from './services/venue-preparation'
import { LicenseService } from './services/license-service'
import { FingerprintBrowserRuntime } from './services/fingerprint-browser-runtime'
import { LICENSE_PUBLIC_KEY_PEM } from './license-public-key'
import { loadMarketProfile, profileAllowsVenue } from './services/market-profile'
import type { LicenseSummary } from '../shared/types'

let mainWindow: BrowserWindow | undefined

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 940,
    minWidth: 1040,
    minHeight: 720,
    title: 'ArbDesk',
    backgroundColor: '#020617',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('preload-error', preloadPath, error)
  })
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.error('renderer-error', message)
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  const screenshotPath = process.env.ARB_CAPTURE_SCREENSHOT
  if (screenshotPath) {
    const configuredDelay = Number(process.env.ARB_CAPTURE_DELAY_MS)
    const captureDelayMs = Number.isFinite(configuredDelay)
      ? Math.min(30_000, Math.max(1_000, configuredDelay))
      : 3_000
    setTimeout(async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const image = await mainWindow.webContents.capturePage()
      await writeFile(screenshotPath, image.toPNG())
      const diagnostic = await mainWindow.webContents.executeJavaScript(`(async () => JSON.stringify({
        url: location.href,
        text: document.body.innerText,
        rootHtml: document.getElementById('root')?.innerHTML,
        hasApi: typeof window.arbApp !== 'undefined',
        predictCapture: typeof window.arbApp !== 'undefined'
          ? await window.arbApp.getPredictFunPageCaptureStatus()
          : undefined,
        gateCapture: typeof window.arbApp !== 'undefined'
          ? await window.arbApp.getGatePageCaptureStatus()
          : undefined,
        platforms: typeof window.arbApp !== 'undefined'
          ? (await window.arbApp.getSnapshot()).multiVenueBoard.platforms
          : undefined
      }))()`)
      await writeFile(`${screenshotPath}.json`, diagnostic, 'utf8')
      app.quit()
    }, captureDelayMs)
  }
}

if (hasSingleInstanceLock) void app.whenReady().then(async () => {
  const dataDirectory = join(app.getPath('userData'), 'data')
  const marketProfile = await loadMarketProfile(app.isPackaged ? join(process.resourcesPath, 'market-profile.json') : process.env.ARB_MARKET_PROFILE_PATH)
  const store = new EventStore(dataDirectory)
  const executionSessionStore = new ExecutionSessionStore(dataDirectory)
  const fingerprintRuntime = new FingerprintBrowserRuntime()
  const mexcBrowser = new MexcBrowserManager(join(app.getPath('userData'), 'data', 'mexc-selectors.json'), fingerprintRuntime)
  const polymarketCredentials = new PolymarketCredentialStore(join(app.getPath('userData'), 'data', 'polymarket-credentials.json'))
  const polymarketLive = new PolymarketLiveBroker(polymarketCredentials)
  const predictFunCredentials = new PredictFunCredentialStore(join(dataDirectory, 'predict-fun-credentials.json'))
  const limitlessCredentials = new LimitlessCredentialStore(join(dataDirectory, 'limitless-credentials.json'))
  const gateCredentials = new GateCredentialStore(join(dataDirectory, 'gate-credentials.json'))
  const kalshiCredentials = new KalshiCredentialStore(join(dataDirectory, 'kalshi-credentials.json'))
  const limitlessMarketData = new LimitlessMarketData({ hmacCredentialsProvider: () => limitlessCredentials.getHmacCredentials() })
  const predictFunPageCapture = new PredictFunPageCapture()
  const predictFunMarketData = new PredictFunMarketData(
    () => predictFunCredentials.getApiKey(),
    undefined,
    // Predict.fun commonly has no API key. Keep one background passive page
    // as the default source; the capture layer throttles Chromium and filters
    // irrelevant resources/frames, and the settings page can stop it.
    { pageCapture: predictFunPageCapture, autoStartPageCapture: profileAllowsVenue(marketProfile, 'PREDICT_FUN') }
  )
  const gatePageCapture = new GatePageCapture(fingerprintRuntime)
  const gateOrderCapture = new GateOrderCapture(gatePageCapture, () => gatePageCapture.canExecuteOrders())
  try {
    const persisted = JSON.parse(await readFile(join(dataDirectory, 'gate-order-capture-trace.json'), 'utf8')) as {
      summary?: { endpoint?: string; method?: string; requestFields?: string[]; pageUrl?: string; capturedAt?: number }
    }
    gateOrderCapture.restoreSchema(persisted.summary)
  } catch {
    // No prior sanitized trace is normal on first run. Page monitoring remains available.
  }
  const gateOrderTransport = new GateBrowserOrderTransport(gateOrderCapture, gatePageCapture)
  const gateMarketData = new GateMarketData(gatePageCapture, { autoStartPageCapture: profileAllowsVenue(marketProfile, 'GATE') })
  const kalshiPageCapture = new KalshiPageCapture()
  const kalshiMarketData = new KalshiMarketData(() => kalshiCredentials.getCredentials().catch(() => undefined), kalshiPageCapture)
  // Kalshi 的 API 请求与 Polymarket 共用应用代理。直连 DNS 在部分网络环境
  // 下无法解析 Kalshi 域名；代理只改变传输路径，不增加重试或请求次数。
  let kalshiProxyUrl = process.env.KALSHI_PROXY_URL ?? process.env.POLYMARKET_PROXY_URL ?? ''
  let kalshiProxyAgentUrl = ''
  let kalshiProxyAgent: import('undici').ProxyAgent | undefined
  const kalshiFetch: typeof fetch = async (input, init) => {
    const proxyUrl = kalshiProxyUrl.trim()
    if (!proxyUrl) return await fetch(input, init)
    const { ProxyAgent, fetch: proxyFetch } = await import('undici')
    if (!kalshiProxyAgent || kalshiProxyAgentUrl !== proxyUrl) {
      kalshiProxyAgent?.close()
      kalshiProxyAgent = new ProxyAgent(proxyUrl)
      kalshiProxyAgentUrl = proxyUrl
    }
    return await proxyFetch(input as any, { ...init, dispatcher: kalshiProxyAgent } as any) as unknown as Response
  }
  const multiVenueData = new MultiVenueMarketData([
    limitlessMarketData,
    predictFunMarketData,
    gateMarketData,
    kalshiMarketData
  ], marketProfile)
  const limitlessPreparation = new LimitlessPreparationService(limitlessCredentials, limitlessMarketData)
  const predictFunPreparation = new PredictFunPreparationService(predictFunCredentials, predictFunMarketData)
  const gatePreparation = new GatePreparationService(gateCredentials, gateMarketData, fetch, gateOrderCapture)
  const kalshiPreparation = new KalshiPreparationService(kalshiCredentials, kalshiMarketData, kalshiFetch)
  const controller = new AppController(
    store,
    mexcBrowser,
    undefined,
    polymarketLive,
    app.isPackaged || process.env.ARB_ENABLE_LIVE_EXECUTION === 'true',
    multiVenueData,
    executionSessionStore,
    fingerprintRuntime,
    marketProfile
  )
  await controller.initialize()
  const kalshiTrading = new KalshiTradingService(
    kalshiCredentials,
    kalshiMarketData,
    () => controller.getSnapshot().settings,
    app.isPackaged || process.env.ARB_ENABLE_LIVE_EXECUTION === 'true',
    kalshiFetch
  )
  const multiVenueExecution = new MultiVenueExecutionService({
    mexc: mexcBrowser,
    polymarket: polymarketLive,
    kalshi: kalshiTrading,
    gate: gateOrderTransport,
    settings: () => controller.getSnapshot().settings,
    comparisonProvider: (comparisonId) => controller.getSnapshot().multiVenueBoard.comparisons.find((comparison) => comparison.id === comparisonId),
    liveExecutionEnabled: app.isPackaged || process.env.ARB_ENABLE_LIVE_EXECUTION === 'true',
    executionSessionStore
  })
  kalshiProxyUrl = controller.getSnapshot().settings.polymarketProxyUrl
  kalshiMarketData.configureProxy(kalshiProxyUrl)
  const licenseService = new LicenseService(join(dataDirectory, 'license.json'), LICENSE_PUBLIC_KEY_PEM)
  await licenseService.initialize()
  controller.setLicenseActive((await licenseService.getSummary()).status === 'ACTIVE')

  const licenseAccessSummary = async (): Promise<LicenseSummary> => {
    const summary = await licenseService.getSummary()
    return { ...summary, emergencyOnly: summary.status !== 'ACTIVE' && controller.hasRecoverableExposure() }
  }
  const requireActiveLicense = async <T>(operation: () => Promise<T> | T): Promise<T> => {
    try {
      await licenseService.requireActive()
    } catch (error) {
      await refreshLicenseState(true)
      throw error
    }
    return await operation()
  }
  const requireActiveOrEmergency = async <T>(operation: () => Promise<T> | T): Promise<T> => {
    const summary = await licenseService.getSummary()
    if (summary.status !== 'ACTIVE') await refreshLicenseState(true)
    if (summary.status !== 'ACTIVE' && !controller.hasRecoverableExposure()) throw new Error(`授权不可用：${summary.message}`)
    return await operation()
  }

  let previousLicenseStatus = (await licenseAccessSummary()).status
  let licenseExpiryTimer: NodeJS.Timeout | undefined
  let checkingLicense = false
  const scheduleLicenseExpiryCheck = (summary: LicenseSummary): void => {
    if (licenseExpiryTimer) clearTimeout(licenseExpiryTimer)
    licenseExpiryTimer = undefined
    if (summary.status !== 'ACTIVE' || !summary.validUntil) return
    // Node timers cannot safely span arbitrary 30/90-day licenses. Wake at most
    // once per day, then schedule the exact remaining interval on later passes.
    const delay = Math.max(1_000, Math.min(summary.validUntil - Date.now() + 250, 24 * 60 * 60_000))
    licenseExpiryTimer = setTimeout(() => void refreshLicenseState(), delay)
    licenseExpiryTimer.unref()
  }
  const refreshLicenseState = async (forceBroadcast = false): Promise<LicenseSummary | undefined> => {
    if (checkingLicense) return undefined
    checkingLicense = true
    try {
      const summary = await licenseAccessSummary()
      controller.setLicenseActive(summary.status === 'ACTIVE')
      if (summary.status !== 'ACTIVE') await controller.disarmAutoOpen('授权已到期或失效，自动开单已停用')
      if (forceBroadcast || summary.status !== previousLicenseStatus) {
        previousLicenseStatus = summary.status
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('license:state', summary)
      }
      scheduleLicenseExpiryCheck(summary)
      return summary
    } catch (error) {
      console.error('license-state-check-failed', error)
      return undefined
    } finally {
      checkingLicense = false
    }
  }

  controller.setBroadcaster((snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:snapshot', snapshot)
  })

  ipcMain.handle('license:summary', () => licenseAccessSummary())
  ipcMain.handle('license:activate', async (_event, activationCode) => {
    const activated = await licenseService.activate(String(activationCode ?? ''))
    controller.setLicenseActive(activated.status === 'ACTIVE')
    const summary = await licenseAccessSummary()
    previousLicenseStatus = summary.status
    scheduleLicenseExpiryCheck(summary)
    return summary
  })
  ipcMain.handle('license:deactivate', async () => {
    await controller.disarmAutoOpen('授权已退出，自动开单已停用')
    controller.setLicenseActive(false)
    await licenseService.deactivate()
    const summary = await licenseAccessSummary()
    previousLicenseStatus = summary.status
    scheduleLicenseExpiryCheck(summary)
    return summary
  })
  ipcMain.handle('license:emergency-snapshot', () => controller.getEmergencyAccessSnapshot())
  ipcMain.handle('app:get-snapshot', () => requireActiveLicense(() => controller.getSnapshot()))
  ipcMain.handle('app:refresh-opportunities', () => requireActiveLicense(() => controller.refreshOpportunities()))
  ipcMain.handle('app:set-venue-monitoring', (_event, venueId, enabled) => requireActiveLicense(() => controller.setVenueMonitoring(String(venueId), Boolean(enabled))))
  ipcMain.handle('app:execute', (_event, request) => requireActiveLicense(() => controller.execute(request)))
  ipcMain.handle('app:calculate-execution-plan', (_event, request) => requireActiveLicense(() => controller.calculateExecutionPlan(request)))
  ipcMain.handle('app:confirm-mexc-fill', (_event, fill) => requireActiveOrEmergency(() => controller.confirmMexcFill(fill)))
  ipcMain.handle('app:retry-polymarket-hedge', (_event, request) => requireActiveOrEmergency(() => controller.retryPolymarketHedge(request)))
  ipcMain.handle('app:cancel-execution', () => requireActiveOrEmergency(() => controller.cancelExecution()))
  ipcMain.handle('app:close-order', (_event, request) => requireActiveOrEmergency(() => controller.closeOrder(request)))
  ipcMain.handle('app:update-settings', (_event, request) => requireActiveLicense(async () => {
    const settings = await controller.updateSettings(request)
    if (request && typeof request === 'object' && Object.prototype.hasOwnProperty.call(request, 'polymarketProxyUrl')) {
      kalshiProxyUrl = settings.polymarketProxyUrl
      kalshiMarketData.configureProxy(kalshiProxyUrl)
    }
    return settings
  }))
  ipcMain.handle('mexc:open', () => requireActiveLicense(() => mexcBrowser.open()))
  ipcMain.handle('mexc:status', () => requireActiveLicense(() => mexcBrowser.getStatus()))
  ipcMain.handle('mexc:refresh-account', () => requireActiveLicense(() => mexcBrowser.refreshAccountState()))
  ipcMain.handle('mexc:calibrate', (_event, kind) => requireActiveLicense(() => mexcBrowser.calibrate(kind)))
  ipcMain.handle('polymarket:credential-summary', () => requireActiveLicense(() => polymarketCredentials.getSummary()))
  ipcMain.handle('polymarket:test-connection', () => requireActiveLicense(() => controller.testPolymarketConnection()))
  ipcMain.handle('polymarket:update-credentials', async (_event, request) => {
    return await requireActiveLicense(async () => {
      await controller.disarmAutoOpen('Polymarket交易身份已变更，自动开单已停用')
      return await polymarketLive.configureIdentity(request)
    })
  })
  ipcMain.handle('polymarket:validate-identity', (_event, tokenId) => requireActiveLicense(() => polymarketLive.validateIdentity(tokenId)))
  ipcMain.handle('predict-fun:credential-summary', () => requireActiveLicense(() => predictFunCredentials.getSummary()))
  ipcMain.handle('predict-fun:open-page', () => requireActiveLicense(() => predictFunMarketData.openPageCapture()))
  ipcMain.handle('predict-fun:stop-page', () => requireActiveLicense(() => { predictFunMarketData.stopPageCapture() }))
  ipcMain.handle('predict-fun:page-capture-status', () => requireActiveLicense(() => predictFunMarketData.getPageCaptureStatus()))
  ipcMain.handle('predict-fun:prepare-without-submit', () => requireActiveLicense(() => predictFunPreparation.prepare()))
  ipcMain.handle('predict-fun:update-credentials', (_event, request) => requireActiveLicense(async () => {
    const summary = await predictFunCredentials.update(request)
    predictFunMarketData.credentialsChanged()
    predictFunPreparation.credentialsChanged()
    await controller.refreshOpportunities()
    return summary
  }))
  ipcMain.handle('limitless:credential-summary', () => requireActiveLicense(() => limitlessCredentials.getSummary()))
  ipcMain.handle('limitless:prepare-without-submit', () => requireActiveLicense(() => limitlessPreparation.prepare()))
  ipcMain.handle('limitless:update-credentials', (_event, request) => requireActiveLicense(async () => {
    await limitlessCredentials.update(request)
    const summary = await limitlessCredentials.syncProfile()
    limitlessMarketData.credentialsChanged()
    limitlessPreparation.credentialsChanged()
    await controller.refreshOpportunities()
    return summary
  }))
  ipcMain.handle('gate:credential-summary', () => requireActiveLicense(() => gateCredentials.getSummary()))
  ipcMain.handle('gate:open-page', () => requireActiveLicense(() => gateMarketData.openPageCapture()))
  ipcMain.handle('gate:stop-page', () => requireActiveLicense(() => { gateMarketData.stopPageCapture() }))
  ipcMain.handle('gate:page-capture-status', () => requireActiveLicense(() => gateMarketData.getPageCaptureStatus()))
  ipcMain.handle('gate:start-order-capture', async () => requireActiveLicense(async () => {
    gateOrderCapture.startCapture()
    await gateMarketData.openPageCapture()
    return gateOrderCapture.getSummary()
  }))
  ipcMain.handle('gate:stop-order-capture', () => requireActiveLicense(() => { gateOrderCapture.stopCapture(); return gateOrderCapture.getSummary() }))
  ipcMain.handle('gate:order-capture-summary', () => requireActiveLicense(() => gateOrderCapture.getSummary()))
  ipcMain.handle('gate:export-order-capture', () => requireActiveLicense(async () => {
    const directory = join(app.getPath('userData'), 'data')
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'gate-order-capture-trace.json')
    await writeFile(path, JSON.stringify({ exportedAt: Date.now(), summary: gateOrderCapture.getSummary(), trace: gateOrderCapture.getTrace() }, null, 2), 'utf8')
    return path
  }))
  ipcMain.handle('gate:clear-order-capture', () => requireActiveLicense(() => { gateOrderCapture.clear(); return gateOrderCapture.getSummary() }))
  ipcMain.handle('gate:prepare-without-submit', () => requireActiveLicense(() => gatePreparation.prepare()))
  ipcMain.handle('gate:update-credentials', (_event, request) => requireActiveLicense(async () => {
    const summary = await gateCredentials.update(request)
    gatePreparation.credentialsChanged()
    await controller.refreshOpportunities()
    return summary
  }))
  ipcMain.handle('kalshi:credential-summary', () => requireActiveLicense(() => kalshiCredentials.getSummary()))
  ipcMain.handle('kalshi:open-page', () => requireActiveLicense(() => kalshiMarketData.openPageCapture()))
  ipcMain.handle('kalshi:stop-page', () => requireActiveLicense(() => { kalshiMarketData.stopPageCapture() }))
  ipcMain.handle('kalshi:page-capture-status', () => requireActiveLicense(() => kalshiMarketData.getPageCaptureStatus()))
  ipcMain.handle('kalshi:prepare-without-submit', () => requireActiveLicense(() => kalshiPreparation.prepare()))
  ipcMain.handle('multi-venue:execute', (_event, request) => requireActiveLicense(async () => {
    const receipt = await multiVenueExecution.execute(request)
    await controller.recordMultiVenueReceipt(receipt)
    return receipt
  }))
  ipcMain.handle('multi-venue:list-sessions', () => requireActiveLicense(() => controller.listMultiVenueExecutionSessions()))
  ipcMain.handle('multi-venue:mark-session-recovered', (_event, sessionId, note) => requireActiveLicense(() => controller.markMultiVenueExecutionSessionRecovered(sessionId, note)))
  ipcMain.handle('kalshi:update-credentials', (_event, request) => requireActiveLicense(async () => {
    const summary = await kalshiCredentials.update(request)
    kalshiPreparation.credentialsChanged()
    kalshiMarketData.credentialsChanged()
    await controller.refreshOpportunities()
    return summary
  }))

  await createWindow()
  await refreshLicenseState()
  // Low-frequency fallback only. Normal checks happen at startup, exact expiry,
  // app resume/focus, and before every protected IPC operation.
  const licenseFallbackTimer = setInterval(() => void refreshLicenseState(), 5 * 60_000)
  licenseFallbackTimer.unref()
  powerMonitor.on('resume', () => {
    void refreshLicenseState(true)
    void mexcBrowser.reconnectIfAvailable(true).then((status) => {
      if (status.open) void controller.refreshOpportunities().catch(() => undefined)
    }).catch(() => undefined)
  })
  app.on('browser-window-focus', () => {
    void refreshLicenseState()
    void mexcBrowser.reconnectIfAvailable().catch(() => undefined)
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
