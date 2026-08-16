import type { ArbAppApi } from './types'

declare global {
  interface Window {
    arbApp: ArbAppApi
  }
}

export {}
