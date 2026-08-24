import type { PolymarketLiveBroker } from '../../services/polymarket-live'
import type { Fill } from '../../../shared/types'
import { assertVenueCanExecute, type VenueAdapter, type VenueExecutionRequest, type VenueFill, type VenueOrderReceipt } from '../venue-adapter'

function fromFill(fill: Fill, clientOrderId: string): VenueOrderReceipt {
  return {
    venueId: 'POLYMARKET', orderId: fill.orderId, clientOrderId, status: 'FILLED', filledQuantity: fill.quantity,
    averagePrice: fill.averagePrice, receivedAt: fill.filledAt,
    metadata: { direction: fill.direction, verificationSource: fill.verificationSource ?? 'PLATFORM_READBACK' }
  }
}

function fillFromReceipt(receipt: VenueOrderReceipt, request: VenueExecutionRequest): VenueFill | undefined {
  if (!receipt.orderId || receipt.status !== 'FILLED' || !receipt.averagePrice) return undefined
  return {
    venueId: 'POLYMARKET', orderId: receipt.orderId, direction: request.direction, quantity: receipt.filledQuantity,
    averagePrice: receipt.averagePrice, filledAt: receipt.receivedAt, verificationSource: 'DIRECT_RECEIPT'
  }
}

export class PolymarketVenueAdapter implements VenueAdapter {
  readonly venueId = 'POLYMARKET'
  readonly capabilities = {
    marketDiscovery: true, realtimeBook: true, placeOrder: true, fillReadback: true, reconcileOrder: false, cancelOrder: false
  } as const

  constructor(private readonly polymarket: PolymarketLiveBroker) {}

  async preflightOrder(request: VenueExecutionRequest): Promise<void> {
    assertVenueCanExecute(this, request)
    if (!request.outcomeId) throw new Error('Polymarket 缺少 tokenId')
  }

  async submitOrder(request: VenueExecutionRequest): Promise<VenueOrderReceipt> {
    await this.preflightOrder(request)
    const fill = await this.polymarket.hedge({
      tokenId: request.outcomeId,
      direction: request.direction,
      quantity: request.quantity,
      maximumPrice: request.limitPrice,
      quoteReceivedAt: request.quoteReceivedAt,
      minimumOrderSize: '1'
    })
    return fromFill(fill, request.clientOrderId)
  }

  async waitForFill(receipt: VenueOrderReceipt, request: VenueExecutionRequest): Promise<VenueFill | undefined> {
    return fillFromReceipt(receipt, request)
  }

  async reconcileOrder(): Promise<VenueOrderReceipt | undefined> {
    return undefined
  }
}
