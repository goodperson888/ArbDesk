import type { VenueCapabilities, VenueDescriptor, VenueId } from '../../shared/multi-venue'

type RegisteredVenue = Omit<VenueDescriptor, 'connectionState'>

const fullClobCapabilities: VenueCapabilities = {
  marketDiscovery: true,
  realtimeBook: true,
  placeOrder: true,
  cancelOrder: true,
  fillStream: true,
  exitPosition: true,
  splitMerge: false
}

const venues: RegisteredVenue[] = [
  {
    id: 'MEXC',
    label: 'MEXC',
    integrationState: 'LIVE',
    supportedSubjects: ['BTC'],
    supportedIntervals: ['5m', '15m'],
    capabilities: {
      marketDiscovery: true,
      realtimeBook: true,
      placeOrder: true,
      cancelOrder: false,
      fillStream: true,
      exitPosition: true,
      splitMerge: false
    }
  },
  {
    id: 'POLYMARKET',
    label: 'Polymarket',
    integrationState: 'LIVE',
    supportedSubjects: ['BTC'],
    supportedIntervals: ['5m', '15m'],
    capabilities: { ...fullClobCapabilities, splitMerge: true }
  },
  {
    id: 'LIMITLESS',
    label: 'Limitless',
    integrationState: 'READ_ONLY',
    supportedSubjects: ['BTC'],
    supportedIntervals: ['5m', '15m'],
    capabilities: {
      marketDiscovery: true,
      realtimeBook: true,
      placeOrder: false,
      cancelOrder: false,
      fillStream: false,
      exitPosition: false,
      splitMerge: false
    }
  },
  {
    id: 'PREDICT_FUN',
    label: 'Predict.fun',
    integrationState: 'READ_ONLY',
    supportedSubjects: ['BTC'],
    supportedIntervals: ['5m', '15m'],
    capabilities: {
      marketDiscovery: true,
      realtimeBook: true,
      placeOrder: false,
      cancelOrder: false,
      fillStream: false,
      exitPosition: false,
      splitMerge: false
    }
  },
  {
    id: 'GATE',
    label: 'Gate',
    // The adapter is live-capable, but the runtime keeps the live switch off
    // until a user-captured event-order schema is verified.
    integrationState: 'LIVE',
    supportedSubjects: ['BTC'],
    supportedIntervals: ['5m', '15m'],
    capabilities: {
      marketDiscovery: true,
      realtimeBook: true,
      placeOrder: true,
      cancelOrder: false,
      fillStream: true,
      exitPosition: false,
      splitMerge: false
    }
  },
  {
    id: 'KALSHI',
    label: 'Kalshi',
    // Kalshi has a live KXBTC15M series. Only explicitly confirmed manual
    // FOK entry is enabled; auto-order, cancel and exit flows remain off.
    integrationState: 'LIVE',
    supportedDurations: [15],
    supportedSubjects: ['BTC'],
    supportedIntervals: ['15m'],
    capabilities: {
      marketDiscovery: true,
      realtimeBook: true,
      placeOrder: true,
      cancelOrder: false,
      fillStream: false,
      exitPosition: false,
      splitMerge: false
    }
  }
]

export function getVenueDescriptor(id: VenueId): RegisteredVenue {
  return venues.find((venue) => venue.id === id) ?? {
    id,
    label: id,
    integrationState: 'PLANNED',
    capabilities: {
      marketDiscovery: false,
      realtimeBook: false,
      placeOrder: false,
      cancelOrder: false,
      fillStream: false,
      exitPosition: false,
      splitMerge: false
    }
  }
}

export function listRegisteredVenues(): RegisteredVenue[] {
  return venues.map((venue) => ({ ...venue, capabilities: { ...venue.capabilities } }))
}
