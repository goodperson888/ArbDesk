import { contextBridge, ipcRenderer } from 'electron'
import type { AppSnapshot, ArbAppApi, LicenseSummary } from '../shared/types'

const api: ArbAppApi = {
  getLicenseSummary: () => ipcRenderer.invoke('license:summary'),
  activateLicense: (activationCode) => ipcRenderer.invoke('license:activate', activationCode),
  deactivateLicense: () => ipcRenderer.invoke('license:deactivate'),
  getEmergencyAccessSnapshot: () => ipcRenderer.invoke('license:emergency-snapshot'),
  getSnapshot: () => ipcRenderer.invoke('app:get-snapshot'),
  refreshOpportunities: () => ipcRenderer.invoke('app:refresh-opportunities'),
  setVenueMonitoring: (venueId, enabled) => ipcRenderer.invoke('app:set-venue-monitoring', venueId, enabled),
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
  getPredictFunCredentialSummary: () => ipcRenderer.invoke('predict-fun:credential-summary'),
  updatePredictFunCredentials: (request) => ipcRenderer.invoke('predict-fun:update-credentials', request),
  openPredictFunPage: () => ipcRenderer.invoke('predict-fun:open-page'),
  stopPredictFunPage: () => ipcRenderer.invoke('predict-fun:stop-page'),
  getPredictFunPageCaptureStatus: () => ipcRenderer.invoke('predict-fun:page-capture-status'),
  getLimitlessCredentialSummary: () => ipcRenderer.invoke('limitless:credential-summary'),
  updateLimitlessCredentials: (request) => ipcRenderer.invoke('limitless:update-credentials', request),
  prepareLimitlessWithoutSubmitting: () => ipcRenderer.invoke('limitless:prepare-without-submit'),
  preparePredictFunWithoutSubmitting: () => ipcRenderer.invoke('predict-fun:prepare-without-submit'),
  getGateCredentialSummary: () => ipcRenderer.invoke('gate:credential-summary'),
  updateGateCredentials: (request) => ipcRenderer.invoke('gate:update-credentials', request),
  openGatePage: () => ipcRenderer.invoke('gate:open-page'),
  stopGatePage: () => ipcRenderer.invoke('gate:stop-page'),
  getGatePageCaptureStatus: () => ipcRenderer.invoke('gate:page-capture-status'),
  startGateOrderCapture: () => ipcRenderer.invoke('gate:start-order-capture'),
  getGateOrderCaptureSummary: () => ipcRenderer.invoke('gate:order-capture-summary'),
  clearGateOrderCapture: () => ipcRenderer.invoke('gate:clear-order-capture'),
  prepareGateWithoutSubmitting: () => ipcRenderer.invoke('gate:prepare-without-submit'),
  getKalshiCredentialSummary: () => ipcRenderer.invoke('kalshi:credential-summary'),
  updateKalshiCredentials: (request) => ipcRenderer.invoke('kalshi:update-credentials', request),
  openKalshiPage: () => ipcRenderer.invoke('kalshi:open-page'),
  stopKalshiPage: () => ipcRenderer.invoke('kalshi:stop-page'),
  getKalshiPageCaptureStatus: () => ipcRenderer.invoke('kalshi:page-capture-status'),
  prepareKalshiWithoutSubmitting: () => ipcRenderer.invoke('kalshi:prepare-without-submit'),
  executeMultiVenue: (request) => ipcRenderer.invoke('multi-venue:execute', request),
  listMultiVenueExecutionSessions: () => ipcRenderer.invoke('multi-venue:list-sessions'),
  markMultiVenueExecutionSessionRecovered: (sessionId, note) => ipcRenderer.invoke('multi-venue:mark-session-recovered', sessionId, note),
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
