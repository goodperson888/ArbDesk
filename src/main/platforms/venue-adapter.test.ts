import { describe, expect, it } from 'vitest'
import { assertVenueCanExecute, type VenueAdapter, type VenueExecutionRequest } from './venue-adapter'

const request: VenueExecutionRequest = {
  eventId: 'event-btc-15m', marketId: 'market', outcomeId: 'outcome', direction: 'UP',
  quantity: '2', limitPrice: '0.5', startTime: Date.now(), endTime: Date.now() + 900_000,
  quoteReceivedAt: Date.now(), timeInForce: 'FOK', clientOrderId: 'route-1-leg-1'
}

describe('venue adapter contract', () => {
  it('allows an order only when all required capabilities are present', () => {
    const adapter: VenueAdapter = {
      venueId: 'TEST',
      capabilities: { marketDiscovery: true, realtimeBook: true, placeOrder: true, fillReadback: true, reconcileOrder: true, cancelOrder: false },
      preflightOrder: async () => undefined,
      submitOrder: async () => ({ venueId: 'TEST', orderId: 'order', clientOrderId: request.clientOrderId, status: 'FILLED', filledQuantity: '2', receivedAt: Date.now() }),
      waitForFill: async () => undefined,
      reconcileOrder: async () => undefined
    }
    expect(() => assertVenueCanExecute(adapter, request)).not.toThrow()
  })

  it('blocks a read-only adapter before any order call', () => {
    const adapter: VenueAdapter = {
      venueId: 'READ_ONLY',
      capabilities: { marketDiscovery: true, realtimeBook: true, placeOrder: false, fillReadback: false, reconcileOrder: false, cancelOrder: false },
      preflightOrder: async () => undefined,
      submitOrder: async () => { throw new Error('must not submit') },
      waitForFill: async () => undefined,
      reconcileOrder: async () => undefined
    }
    expect(() => assertVenueCanExecute(adapter, request)).toThrow('READ_ONLY')
  })
})
