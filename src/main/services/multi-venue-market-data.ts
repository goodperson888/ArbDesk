import type { VenueId } from '../../shared/multi-venue'
import type { MarketProfile } from '../../shared/market-profile'
import type { ReadOnlyVenueSource, ReadOnlyVenueStatus, ReadOnlyWindowQuote } from '../platforms/read-only-types'
import { profileAllowsVenue, profileAllowsWindow } from './market-profile'

export class MultiVenueMarketData {
  private readonly sources: ReadOnlyVenueSource[]
  private windowsByVenue = new Map<VenueId, ReadOnlyWindowQuote[]>()
  private enabledByVenue = new Map<VenueId, boolean>()
  private inFlight?: Promise<ReadOnlyWindowQuote[]>
  private listeners = new Set<() => void>()

  constructor(sources: ReadOnlyVenueSource[], private readonly profile?: MarketProfile) {
    this.sources = profile ? sources.filter((source) => profileAllowsVenue(profile, source.venueId)) : sources
    for (const source of this.sources) {
      this.enabledByVenue.set(source.venueId, true)
      source.onMarketData?.(() => {
        if (source.getLatestWindows) this.windowsByVenue.set(source.venueId, this.filterWindows(source.getLatestWindows()))
        for (const listener of this.listeners) listener()
      })
    }
  }

  onMarketData(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getWindows(): ReadOnlyWindowQuote[] {
    return this.sources.flatMap((source) => this.enabledByVenue.get(source.venueId) === false ? [] : this.windowsByVenue.get(source.venueId) ?? [])
  }

  setVenueMonitoring(venueId: VenueId, enabled: boolean): void {
    const source = this.sources.find((candidate) => candidate.venueId === venueId)
    if (!source) throw new Error(`未注册平台 ${venueId}`)
    this.enabledByVenue.set(venueId, enabled)
    source.setMonitoringEnabled?.(enabled)
    if (!enabled) this.windowsByVenue.delete(venueId)
    for (const listener of this.listeners) listener()
  }

  isVenueMonitoringEnabled(venueId: VenueId): boolean {
    return this.enabledByVenue.get(venueId) !== false
  }

  getStatuses(): Record<VenueId, ReadOnlyVenueStatus> {
    return Object.fromEntries(this.sources.map((source) => {
      if (!this.isVenueMonitoringEnabled(source.venueId)) {
        return [source.venueId, {
          ...source.getStatus(), connectionState: 'DISCONNECTED' as const, marketCount: 0,
          message: `${source.getStatus().message.split('；')[0]}；监控已暂停，不会主动请求市场数据`
        }]
      }
      return [source.venueId, source.getStatus()]
    }))
  }

  async refresh(signal?: AbortSignal): Promise<ReadOnlyWindowQuote[]> {
    if (this.inFlight) return await this.inFlight
    this.inFlight = this.load(signal)
    try {
      return await this.inFlight
    } finally {
      this.inFlight = undefined
    }
  }

  private async load(signal?: AbortSignal): Promise<ReadOnlyWindowQuote[]> {
    const activeSources = this.sources.filter((source) => this.isVenueMonitoringEnabled(source.venueId))
    const results = await Promise.allSettled(activeSources.map((source) => source.fetchWindows(signal)))
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') this.windowsByVenue.set(activeSources[index].venueId, this.filterWindows(result.value))
    })
    return this.getWindows()
  }

  private filterWindows(windows: ReadOnlyWindowQuote[]): ReadOnlyWindowQuote[] {
    return this.profile ? windows.filter((window) => profileAllowsWindow(this.profile!, window)) : windows
  }
}
