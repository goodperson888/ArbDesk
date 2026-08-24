import type { CanonicalEvent, VenueId } from '../../shared/multi-venue'
import { canonicalEventId, normalizeCanonicalEvent, type CanonicalEventInput } from './canonical-event'

export interface MarketMapping {
  venueId: VenueId
  marketId: string
  eventId: string
  outcomeIds?: string[]
}

export class EventCatalog {
  private readonly events = new Map<string, CanonicalEvent>()
  private readonly mappings = new Map<string, MarketMapping>()

  register(input: CanonicalEvent | CanonicalEventInput): CanonicalEvent {
    const event = 'eventId' in input ? input : normalizeCanonicalEvent(input)
    this.events.set(event.eventId, event)
    return event
  }

  mapMarket(mapping: MarketMapping): MarketMapping {
    if (!this.events.has(mapping.eventId)) throw new Error(`market event 不存在: ${mapping.eventId}`)
    if (!mapping.venueId.trim() || !mapping.marketId.trim()) throw new Error('market mapping 缺少平台或市场 ID')
    const key = `${mapping.eventId}:${mapping.venueId}`
    const stored = { ...mapping, outcomeIds: mapping.outcomeIds ? [...mapping.outcomeIds] : undefined }
    this.mappings.set(key, stored)
    return { ...stored, outcomeIds: stored.outcomeIds ? [...stored.outcomeIds] : undefined }
  }

  get(eventId: string): CanonicalEvent | undefined {
    return this.events.get(eventId)
  }

  list(): CanonicalEvent[] {
    return [...this.events.values()].sort((left, right) => left.startTime - right.startTime || intervalMinutes(left.interval) - intervalMinutes(right.interval))
  }

  getMapping(eventId: string, venueId: VenueId): MarketMapping | undefined {
    const mapping = this.mappings.get(`${eventId}:${venueId}`)
    return mapping ? { ...mapping, outcomeIds: mapping.outcomeIds ? [...mapping.outcomeIds] : undefined } : undefined
  }
}

function intervalMinutes(interval: string | undefined): number {
  if (!interval) return Number.MAX_SAFE_INTEGER
  const match = /^(\d+)([mhd])$/i.exec(interval)
  if (!match) return Number.MAX_SAFE_INTEGER
  const value = Number(match[1])
  return match[2].toLowerCase() === 'm' ? value : match[2].toLowerCase() === 'h' ? value * 60 : value * 1_440
}

export function resolveMarketMapping(catalog: EventCatalog, eventId: string, venueId: VenueId): MarketMapping {
  const event = catalog.get(eventId)
  if (!event) throw new Error(`event 不存在: ${eventId}`)
  const mapping = catalog.getMapping(eventId, venueId)
  if (!mapping) throw new Error(`${venueId} 尚未映射 event ${eventId}`)
  return mapping
}

export function registerBtcCryptoEvents(startTime = Date.now()): EventCatalog {
  const catalog = new EventCatalog()
  for (const [interval, durationMs] of [['5m', 300_000], ['15m', 900_000] ] as const) {
    const input: CanonicalEventInput = {
      category: 'CRYPTO',
      subject: 'BTC',
      interval,
      startTime,
      endTime: startTime + durationMs,
      settlementSource: 'CHAINLINK-BTC-USD',
      outcomes: ['UP', 'DOWN']
    }
    const event = catalog.register(input)
    // Computing the ID here makes the catalog contract explicit and guards
    // against callers accidentally constructing a non-canonical event object.
    if (event.eventId !== canonicalEventId(input)) throw new Error('BTC event ID 生成不一致')
  }
  return catalog
}
