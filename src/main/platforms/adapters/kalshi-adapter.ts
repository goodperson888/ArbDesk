import type { KalshiTradingService } from '../../services/kalshi-trading'
import { assertVenueCanExecute, type VenueAdapter, type VenueExecutionRequest, type VenueFill, type VenueOrderReceipt } from '../venue-adapter'

export class KalshiVenueAdapter implements VenueAdapter {
  readonly venueId = 'KALSHI'
  readonly capabilities = {
    marketDiscovery: true, realtimeBook: true, placeOrder: true, fillReadback: true, reconcileOrder: false, cancelOrder: false
  } as const

  constructor(private readonly kalshi: KalshiTradingService) {}

  async preflightOrder(request: VenueExecutionRequest): Promise<void> {
    assertVenueCanExecute(this, request)
    if (!request.confirmed) throw new Error('Kalshi 双腿执行未完成二次确认')
  }

  async submitOrder(request: VenueExecutionRequest): Promise<VenueOrderReceipt> {
    await this.preflightOrder(request)
    const result = await this.kalshi.placeOrder({
      ticker: request.marketId,
      direction: request.direction,
      quantity: request.quantity,
      outcomePrice: request.limitPrice,
      quoteReceivedAt: request.quoteReceivedAt,
      marketEndTime: request.endTime,
      confirmed: true
    })
    const status: VenueOrderReceipt['status'] = result.status === 'EXECUTED'
      ? 'FILLED'
      : result.status === 'PARTIAL' ? 'PARTIAL'
        : result.status === 'UNKNOWN' ? 'UNKNOWN'
          : result.status === 'CANCELED' ? 'CANCELED' : 'ACCEPTED'
    return {
      venueId: this.venueId, orderId: result.orderId, clientOrderId: result.clientOrderId, status,
      filledQuantity: result.fillCount, averagePrice: result.outcomePrice, receivedAt: Date.now()
    }
  }

  async waitForFill(receipt: VenueOrderReceipt, request: VenueExecutionRequest): Promise<VenueFill | undefined> {
    if (!receipt.orderId || (receipt.status !== 'FILLED' && receipt.status !== 'PARTIAL')) return undefined
    return {
      venueId: this.venueId, orderId: receipt.orderId, direction: request.direction, quantity: receipt.filledQuantity,
      averagePrice: receipt.averagePrice ?? request.limitPrice, filledAt: receipt.receivedAt, verificationSource: 'DIRECT_RECEIPT'
    }
  }

  async reconcileOrder(): Promise<VenueOrderReceipt | undefined> {
    return undefined
  }
}
