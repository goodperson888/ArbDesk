import { contextBridge, ipcRenderer } from 'electron'
import type { AppSnapshot, ArbAppApi } from '../shared/types'

const api: ArbAppApi = {
  getSnapshot: () => ipcRenderer.invoke('app:get-snapshot'),
  refreshOpportunities: () => ipcRenderer.invoke('app:refresh-opportunities'),
  testPolymarketConnection: () => ipcRenderer.invoke('polymarket:test-connection'),
  execute: (request) => ipcRenderer.invoke('app:execute', request),
  confirmMexcFill: (fill) => ipcRenderer.invoke('app:confirm-mexc-fill', fill),
  cancelExecution: () => ipcRenderer.invoke('app:cancel-execution'),
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
  }
}

contextBridge.exposeInMainWorld('arbApp', api)
