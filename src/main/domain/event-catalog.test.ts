import { describe, expect, it } from 'vitest'
import { canonicalEventId } from './canonical-event'
import { EventCatalog, registerBtcCryptoEvents, resolveMarketMapping } from './event-catalog'

describe('BTC event catalog', () => {
  it('registers distinct BTC 5m and 15m events', () => {
    const catalog = registerBtcCryptoEvents(1_787_477_400_000)
    expect(catalog.list()).toHaveLength(2)
    expect(catalog.list().map((event) => event.interval)).toEqual(['5m', '15m'])
  })

  it('resolves a venue market only when its event identity matches', () => {
    const catalog = new EventCatalog()
    const eventId = canonicalEventId({
      category: 'CRYPTO', subject: 'BTC', interval: '15m', startTime: 1000, endTime: 901000,
      settlementSource: 'CHAINLINK-BTC-USD', outcomes: ['UP', 'DOWN']
    })
    catalog.register({
      eventId, category: 'CRYPTO', subject: 'BTC', interval: '15m', startTime: 1000, endTime: 901000,
      settlementSource: 'CHAINLINK-BTC-USD', outcomes: [{ id: 'UP', label: 'UP' }, { id: 'DOWN', label: 'DOWN' }]
    })
    catalog.mapMarket({ venueId: 'POLYMARKET', marketId: 'market-15m', eventId })

    expect(resolveMarketMapping(catalog, eventId, 'POLYMARKET')).toMatchObject({ marketId: 'market-15m' })
    expect(() => catalog.mapMarket({ venueId: 'MEXC', marketId: 'market-5m', eventId: `${eventId}-wrong` })).toThrow('event')
  })
})
