import type { Direction } from '../../shared/types'
import type { VenueAdapterCapabilities, VenueId } from '../../shared/multi-venue'

export interface VenueExecutionRequest {
  eventId?: string
  marketId: string
  outcomeId: string
  direction: Direction
  quantity: string
  limitPrice: string
  startTime: number
  endTime: number
  quoteReceivedAt: number
  timeInForce: 'FOK' | 'FAK' | 'IOC' | 'GTC'
  clientOrderId: string
  confirmed?: boolean
}

export interface VenueOrderReceipt {
  venueId: VenueId
  orderId?: string
  clientOrderId: string
  status: 'ACCEPTED' | 'PARTIAL' | 'FILLED' | 'REJECTED' | 'UNKNOWN' | 'CANCELED'
  filledQuantity: string
  averagePrice?: string
  receivedAt: number
  metadata?: Record<string, string | number | boolean>
}

export interface VenueFill {
  venueId: VenueId
  orderId: string
  direction: Direction
  quantity: string
  averagePrice: string
  filledAt: number
  verificationSource: 'PLATFORM_READBACK' | 'PASSIVE_STREAM' | 'DIRECT_RECEIPT' | 'SIMULATED'
}

export interface VenueAdapter {
  readonly venueId: VenueId
  readonly capabilities: VenueAdapterCapabilities
  preflightOrder(request: VenueExecutionRequest): Promise<void>
  submitOrder(request: VenueExecutionRequest): Promise<VenueOrderReceipt>
  waitForFill(receipt: VenueOrderReceipt, request: VenueExecutionRequest): Promise<VenueFill | undefined>
  reconcileOrder(orderId: string): Promise<VenueOrderReceipt | undefined>
  cancelOrder?(orderId: string): Promise<VenueOrderReceipt | undefined>
}

export function assertVenueCanExecute(adapter: VenueAdapter, request: VenueExecutionRequest): void {
  if (!adapter.capabilities.placeOrder || !adapter.capabilities.fillReadback) {
    throw new Error(`${adapter.venueId} 当前不具备完整下单和成交回读能力`)
  }
  if (!request.marketId.trim() || !request.outcomeId.trim()) throw new Error(`${adapter.venueId} 缺少市场或结果 ID`)
  if (!request.clientOrderId.trim()) throw new Error(`${adapter.venueId} 缺少幂等键`)
}
