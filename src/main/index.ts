import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { AppController } from './app-controller'
import { EventStore } from './services/event-store'
import { MexcBrowserManager } from './services/mexc-browser'
import { PolymarketCredentialStore } from './services/polymarket-credential-store'
import { PolymarketLiveBroker } from './services/polymarket-live'

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
  const store = new EventStore(join(app.getPath('userData'), 'data'))
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

  controller.setBroadcaster((snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:snapshot', snapshot)
  })

  ipcMain.handle('app:get-snapshot', () => controller.getSnapshot())
  ipcMain.handle('app:refresh-opportunities', () => controller.refreshOpportunities())
  ipcMain.handle('app:execute', (_event, request) => controller.execute(request))
  ipcMain.handle('app:confirm-mexc-fill', (_event, fill) => controller.confirmMexcFill(fill))
  ipcMain.handle('app:cancel-execution', () => controller.cancelExecution())
  ipcMain.handle('app:close-order', (_event, request) => controller.closeOrder(request))
  ipcMain.handle('app:update-settings', (_event, request) => controller.updateSettings(request))
  ipcMain.handle('mexc:open', () => mexcBrowser.open())
  ipcMain.handle('mexc:status', () => mexcBrowser.getStatus())
  ipcMain.handle('mexc:refresh-account', () => mexcBrowser.refreshAccountState())
  ipcMain.handle('mexc:calibrate', (_event, kind) => mexcBrowser.calibrate(kind))
  ipcMain.handle('polymarket:credential-summary', () => polymarketCredentials.getSummary())
  ipcMain.handle('polymarket:test-connection', () => controller.testPolymarketConnection())
  ipcMain.handle('polymarket:update-credentials', (_event, request) => polymarketLive.configureIdentity(request))
  ipcMain.handle('polymarket:validate-identity', (_event, tokenId) => polymarketLive.validateIdentity(tokenId))

  await createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
