import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, powerMonitor, shell } from 'electron'
import { AppController } from './app-controller'
import { EventStore } from './services/event-store'
import { MexcBrowserManager } from './services/mexc-browser'
import { PolymarketCredentialStore } from './services/polymarket-credential-store'
import { PolymarketLiveBroker } from './services/polymarket-live'
import { LicenseService } from './services/license-service'
import { LICENSE_PUBLIC_KEY_PEM } from './license-public-key'
import type { LicenseSummary } from '../shared/types'

let mainWindow: BrowserWindow | undefined

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
    setTimeout(async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const image = await mainWindow.webContents.capturePage()
      await writeFile(screenshotPath, image.toPNG())
      const diagnostic = await mainWindow.webContents.executeJavaScript(`JSON.stringify({
        url: location.href,
        text: document.body.innerText,
        rootHtml: document.getElementById('root')?.innerHTML,
        hasApi: typeof window.arbApp !== 'undefined'
      })`)
      await writeFile(`${screenshotPath}.json`, diagnostic, 'utf8')
      app.quit()
    }, 3_000)
  }
}

app.whenReady().then(async () => {
  const dataDirectory = join(app.getPath('userData'), 'data')
  const store = new EventStore(dataDirectory)
  const mexcBrowser = new MexcBrowserManager(join(app.getPath('userData'), 'data', 'mexc-selectors.json'))
  const polymarketCredentials = new PolymarketCredentialStore(join(app.getPath('userData'), 'data', 'polymarket-credentials.json'))
  const polymarketLive = new PolymarketLiveBroker(polymarketCredentials)
  const controller = new AppController(
    store,
    mexcBrowser,
    undefined,
    polymarketLive,
    app.isPackaged || process.env.ARB_ENABLE_LIVE_EXECUTION === 'true'
  )
  await controller.initialize()
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
  ipcMain.handle('app:execute', (_event, request) => requireActiveLicense(() => controller.execute(request)))
  ipcMain.handle('app:calculate-execution-plan', (_event, request) => requireActiveLicense(() => controller.calculateExecutionPlan(request)))
  ipcMain.handle('app:confirm-mexc-fill', (_event, fill) => requireActiveOrEmergency(() => controller.confirmMexcFill(fill)))
  ipcMain.handle('app:retry-polymarket-hedge', () => requireActiveOrEmergency(() => controller.retryPolymarketHedge()))
  ipcMain.handle('app:cancel-execution', () => requireActiveOrEmergency(() => controller.cancelExecution()))
  ipcMain.handle('app:close-order', (_event, request) => requireActiveOrEmergency(() => controller.closeOrder(request)))
  ipcMain.handle('app:update-settings', (_event, request) => requireActiveLicense(() => controller.updateSettings(request)))
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
