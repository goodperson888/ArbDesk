import { describe, expect, it } from 'vitest'
import { getVenueDescriptor, listRegisteredVenues } from './registry'

describe('venue registry', () => {
  it('keeps current live venues and future venues explicit', () => {
    expect(getVenueDescriptor('MEXC').integrationState).toBe('LIVE')
    expect(getVenueDescriptor('POLYMARKET').integrationState).toBe('LIVE')
    expect(getVenueDescriptor('LIMITLESS').integrationState).toBe('READ_ONLY')
    expect(getVenueDescriptor('PREDICT_FUN')).toMatchObject({
      integrationState: 'READ_ONLY',
      capabilities: { marketDiscovery: true, realtimeBook: true, placeOrder: false }
    })
    expect(getVenueDescriptor('GATE')).toMatchObject({
      integrationState: 'LIVE',
      capabilities: { marketDiscovery: true, realtimeBook: true, placeOrder: true }
    })
    expect(getVenueDescriptor('KALSHI')).toMatchObject({
      integrationState: 'LIVE',
      capabilities: { marketDiscovery: true, realtimeBook: true, placeOrder: true }
    })
  })

  it('returns defensive capability copies', () => {
    const first = listRegisteredVenues()
    first[0].capabilities.placeOrder = false

    expect(listRegisteredVenues()[0].capabilities.placeOrder).toBe(true)
  })

  it('does not grant capabilities to an unknown venue', () => {
    expect(getVenueDescriptor('UNKNOWN')).toMatchObject({
      integrationState: 'PLANNED',
      capabilities: { marketDiscovery: false, placeOrder: false }
    })
  })
})
