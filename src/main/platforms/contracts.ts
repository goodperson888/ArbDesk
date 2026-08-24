import type { MultiVenueLeg, VenueDescriptor, VenueId } from '../../shared/multi-venue'

export interface ResolutionFingerprint {
  asset: string
  startTime: number
  endTime: number
  baselineValue?: string
  baselineSource: string
  settlementSource: string
  observationMethod: string
  comparisonOperator: 'GT' | 'GTE' | 'LT' | 'LTE'
  tieOutcome: 'UP' | 'DOWN' | 'VOID' | 'SPLIT'
  voidRule: string
  staleDataRule: string
  timezone: string
  ruleVersion: string
  evidenceUrl?: string
}

export interface NormalizedMarket {
  venueId: VenueId
  marketId: string
  asset: string
  durationMinutes: 5 | 15
  startTime: number
  endTime: number
  outcomes: Array<{ id: string; direction: 'UP' | 'DOWN' }>
  resolution: ResolutionFingerprint
}

export interface NormalizedOrderBook {
  venueId: VenueId
  marketId: string
  outcomeId: string
  direction: 'UP' | 'DOWN'
  bids: Array<{ price: string; quantity: string }>
  asks: Array<{ price: string; quantity: string }>
  sequence?: string
  receivedAt: number
}

export interface VenueOrderRequest extends Pick<MultiVenueLeg, 'venueId' | 'direction'> {
  marketId: string
  outcomeId: string
  quantity: string
  limitPrice: string
  timeInForce: 'FOK' | 'FAK' | 'IOC' | 'GTC'
  clientOrderId: string
}

export interface VenueOrderResult {
  venueId: VenueId
  orderId: string
  clientOrderId: string
  status: 'ACCEPTED' | 'PARTIAL' | 'FILLED' | 'REJECTED' | 'UNKNOWN'
  filledQuantity: string
  averagePrice?: string
  receivedAt: number
}

export interface VenueMarketDataConnector {
  readonly descriptor: VenueDescriptor
  listMarkets(signal?: AbortSignal): Promise<NormalizedMarket[]>
  getOrderBook(marketId: string, outcomeId: string, signal?: AbortSignal): Promise<NormalizedOrderBook>
  subscribeOrderBooks(
    markets: Array<{ marketId: string; outcomeId: string }>,
    listener: (book: NormalizedOrderBook) => void
  ): () => void
}

export interface VenueTradingConnector {
  readonly descriptor: VenueDescriptor
  placeOrder(request: VenueOrderRequest, signal?: AbortSignal): Promise<VenueOrderResult>
  cancelOrder(orderId: string, signal?: AbortSignal): Promise<VenueOrderResult>
  getOrder(orderId: string, signal?: AbortSignal): Promise<VenueOrderResult>
}
