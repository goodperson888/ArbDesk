import type { Direction, OrderBookLevel } from '../../shared/types'
import type { VenueConnectionState, VenueId } from '../../shared/multi-venue'
import type { ResolutionFingerprint } from './contracts'

export interface ReadOnlyOutcomeQuote {
  direction: Direction
  outcomeId: string
  bestAsk: string
  askSize: string
  levels: OrderBookLevel[]
  receivedAt: number
  /** Latest stream/page observation, even when the price and depth are unchanged. */
  observedAt?: number
}

export interface ReadOnlyWindowQuote {
  venueId: VenueId
  marketId: string
  asset: 'BTC/USD'
  durationMinutes: 5 | 15
  startTime: number
  endTime: number
  feeRateBps?: number
  feeVerified: boolean
  resolution: ResolutionFingerprint
  outcomes: Partial<Record<Direction, ReadOnlyOutcomeQuote>>
}

export interface ReadOnlyVenueStatus {
  connectionState: VenueConnectionState
  message: string
  marketCount: number
  updatedAt?: number
}

export interface ReadOnlyVenueSource {
  readonly venueId: VenueId
  getStatus(): ReadOnlyVenueStatus
  getLatestWindows?(): ReadOnlyWindowQuote[]
  onMarketData?(listener: () => void): () => void
  setMonitoringEnabled?(enabled: boolean): void
  fetchWindows(signal?: AbortSignal): Promise<ReadOnlyWindowQuote[]>
}
