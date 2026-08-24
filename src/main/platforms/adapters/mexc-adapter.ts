import Decimal from 'decimal.js'
import type { MexcBrowserManager } from '../../services/mexc-browser'
import type { Fill, MarketDuration } from '../../../shared/types'
import { assertVenueCanExecute, type VenueAdapter, type VenueExecutionRequest, type VenueFill, type VenueOrderReceipt } from '../venue-adapter'

function durationMinutes(request: VenueExecutionRequest): MarketDuration {
  const duration = request.endTime - request.startTime
  if (duration === 300_000) return 5
  if (duration === 900_000) return 15
  // Keep the legacy coordinator's fallback for synthetic/manual routes. Real
  // BTC catalog events are always exactly 5m or 15m and are validated earlier.
  return 5
}

function fromFill(fill: Fill): VenueFill {
  return {
    venueId: 'MEXC', orderId: fill.orderId, direction: fill.direction, quantity: fill.quantity,
    averagePrice: fill.averagePrice, filledAt: fill.filledAt, verificationSource: 'PLATFORM_READBACK'
  }
}

export class MexcVenueAdapter implements VenueAdapter {
  readonly venueId = 'MEXC'
  readonly capabilities = {
    marketDiscovery: true, realtimeBook: true, placeOrder: true, fillReadback: true, reconcileOrder: false, cancelOrder: false
  } as const

  constructor(private readonly mexc: MexcBrowserManager) {}

  async preflightOrder(request: VenueExecutionRequest): Promise<void> {
    assertVenueCanExecute(this, request)
    if (!request.eventId) throw new Error('MEXC 缺少 eventId')
    if (new Decimal(request.quantity).mul(request.limitPrice).lte(0)) throw new Error('MEXC 下单数量或价格无效')
  }

  async submitOrder(request: VenueExecutionRequest): Promise<VenueOrderReceipt> {
    await this.preflightOrder(request)
    if (!request.eventId) throw new Error('MEXC 缺少 eventId')
    const submitted = await this.mexc.prepareOrder({
      direction: request.direction,
      amount: new Decimal(request.quantity).mul(request.limitPrice).toFixed(4),
      allowSubmit: true,
      durationMinutes: durationMinutes(request),
      startTime: request.startTime,
      eventId: request.eventId,
      maximumPrice: request.limitPrice
    })
    if (!submitted.ok || !submitted.orderAccepted || !submitted.submittedAt) throw new Error(submitted.message || 'MEXC 下单未获得成功回执')
    return {
      venueId: this.venueId, orderId: submitted.orderId, clientOrderId: request.clientOrderId, status: 'ACCEPTED', filledQuantity: '0',
      receivedAt: Date.now(), metadata: { submittedAt: submitted.submittedAt, eventId: request.eventId, outcomeId: request.outcomeId }
    }
  }

  async waitForFill(receipt: VenueOrderReceipt, request: VenueExecutionRequest): Promise<VenueFill | undefined> {
    if (!request.eventId) throw new Error('MEXC 缺少 eventId')
    const submittedAfter = Number(receipt.metadata?.submittedAt ?? Date.now())
    const fill = await this.mexc.waitForFill({
      eventId: request.eventId, symbolId: request.outcomeId, direction: request.direction,
      submittedAfter: submittedAfter - 1_500, orderId: receipt.orderId
    })
    return fill ? fromFill(fill) : undefined
  }

  async reconcileOrder(): Promise<VenueOrderReceipt | undefined> {
    return undefined
  }
}
