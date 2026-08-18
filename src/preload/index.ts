import { contextBridge, ipcRenderer } from 'electron'
import type { AppSnapshot, ArbAppApi, LicenseSummary } from '../shared/types'

const api: ArbAppApi = {
  getLicenseSummary: () => ipcRenderer.invoke('license:summary'),
  activateLicense: (activationCode) => ipcRenderer.invoke('license:activate', activationCode),
  deactivateLicense: () => ipcRenderer.invoke('license:deactivate'),
  getEmergencyAccessSnapshot: () => ipcRenderer.invoke('license:emergency-snapshot'),
  getSnapshot: () => ipcRenderer.invoke('app:get-snapshot'),
  refreshOpportunities: () => ipcRenderer.invoke('app:refresh-opportunities'),
  testPolymarketConnection: () => ipcRenderer.invoke('polymarket:test-connection'),
  execute: (request) => ipcRenderer.invoke('app:execute', request),
  calculateExecutionPlan: (request) => ipcRenderer.invoke('app:calculate-execution-plan', request),
  confirmMexcFill: (fill) => ipcRenderer.invoke('app:confirm-mexc-fill', fill),
  retryPolymarketHedge: (request) => ipcRenderer.invoke('app:retry-polymarket-hedge', request),
  cancelExecution: () => ipcRenderer.invoke('app:cancel-execution'),
  closeOrder: (request) => ipcRenderer.invoke('app:close-order', request),
  updateSettings: (request) => ipcRenderer.invoke('app:update-settings', request),
  openMexc: () => ipcRenderer.invoke('mexc:open'),
  getMexcStatus: () => ipcRenderer.invoke('mexc:status'),
  refreshMexcAccount: () => ipcRenderer.invoke('mexc:refresh-account'),
  calibrateMexc: (kind) => ipcRenderer.invoke('mexc:calibrate', kind),
  getPolymarketCredentialSummary: () => ipcRenderer.invoke('polymarket:credential-summary'),
  updatePolymarketCredentials: (request) => ipcRenderer.invoke('polymarket:update-credentials', request),
  validatePolymarketIdentity: (tokenId) => ipcRenderer.invoke('polymarket:validate-identity', tokenId),
  onSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot): void => listener(snapshot)
    ipcRenderer.on('app:snapshot', handler)
    return () => ipcRenderer.removeListener('app:snapshot', handler)
  },
  onLicenseState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, summary: LicenseSummary): void => listener(summary)
    ipcRenderer.on('license:state', handler)
    return () => ipcRenderer.removeListener('license:state', handler)
  }
}

contextBridge.exposeInMainWorld('arbApp', api)
