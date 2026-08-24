import Decimal from 'decimal.js'
import type { GateOrderSchema } from '../../services/gate-order-capture'
import { assertVenueCanExecute, type VenueAdapter, type VenueExecutionRequest, type VenueFill, type VenueOrderReceipt } from '../venue-adapter'

export type GateOrderStatus = 'ACCEPTED' | 'FILLED' | 'PARTIAL' | 'REJECTED' | 'UNKNOWN' | 'CANCELED'

export interface GateOrderResult {
  orderId?: string
  status: GateOrderStatus
  filledQuantity: string
  averagePrice?: string
  message?: string
}

export interface GateOrderTransport {
  getSchema(): GateOrderSchema | undefined
  canExecutePageOrders?(): boolean
  submit(request: VenueExecutionRequest): Promise<GateOrderResult>
  reconcile(orderId: string): Promise<GateOrderResult | undefined>
}

function hasField(fields: string[], names: string[]): boolean {
  const normalized = new Set(fields.map((field) => field.toLowerCase().split('.').pop() ?? field))
  return names.some((name) => normalized.has(name.toLowerCase()))
}

function receiptFromResult(result: GateOrderResult, clientOrderId: string): VenueOrderReceipt {
  return {
    venueId: 'GATE', orderId: result.orderId, clientOrderId, status: result.status,
    filledQuantity: result.filledQuantity, averagePrice: result.averagePrice, receivedAt: Date.now(),
    metadata: result.message ? { message: result.message } : undefined
  }
}

export class GateVenueAdapter implements VenueAdapter {
  readonly venueId = 'GATE'
  readonly capabilities = {
    marketDiscovery: true, realtimeBook: true, placeOrder: true, fillReadback: true, reconcileOrder: true, cancelOrder: false
  } as const

  constructor(private readonly transport: GateOrderTransport, private readonly options: { liveEnabled?: boolean; liveEnabledProvider?: () => boolean } = {}) {}

  async preflightOrder(request: VenueExecutionRequest): Promise<void> {
    assertVenueCanExecute(this, request)
    const schema = this.transport.getSchema()
    const pageOrderReady = this.transport.canExecutePageOrders?.() ?? false
    if (!schema && !pageOrderReady) throw new Error('Gate 页面下单不可用；请先接管已登录的指纹浏览器 Gate 标签页')
    if (schema) {
      if (schema.method !== 'POST' && schema.method !== 'PUT' && schema.method !== 'PATCH') throw new Error('Gate 捕获到的订单方法不受支持')
      if (!hasField(schema.requestFields, ['market_id', 'marketId', 'event_id', 'eventId', 'contract_id', 'contractId'])) throw new Error('Gate 订单结构缺少市场字段，未允许下单')
      if (!hasField(schema.requestFields, ['outcome_id', 'outcomeId', 'token_id', 'tokenId', 'contract_token_id', 'contractTokenId'])) throw new Error('Gate 订单结构缺少结果字段，未允许下单')
      if (!hasField(schema.requestFields, ['quantity', 'qty', 'size', 'amount'])) throw new Error('Gate 订单结构缺少数量字段，未允许下单')
      if (!hasField(schema.requestFields, ['price', 'limit_price', 'limitPrice', 'outcome_price', 'outcomePrice', 'total_cost', 'totalCost', 'cost'])) throw new Error('Gate 订单结构缺少价格或总成本字段，未允许下单')
    }
    if (!(this.options.liveEnabledProvider?.() ?? this.options.liveEnabled ?? false)) throw new Error('Gate 实盘下单开关尚未开启')
    if (!request.confirmed) throw new Error('Gate 双腿执行未完成二次确认')
    const quantity = new Decimal(request.quantity)
    const price = new Decimal(request.limitPrice)
    if (!quantity.isFinite() || quantity.lte(0)) throw new Error('Gate 下单数量无效')
    if (!price.isFinite() || price.lte(0) || price.gte(1)) throw new Error('Gate 下单价格无效')
    if (request.endTime <= Date.now()) throw new Error('Gate 市场已过期')
  }

  async submitOrder(request: VenueExecutionRequest): Promise<VenueOrderReceipt> {
    await this.preflightOrder(request)
    return receiptFromResult(await this.transport.submit(request), request.clientOrderId)
  }

  async waitForFill(receipt: VenueOrderReceipt, request: VenueExecutionRequest): Promise<VenueFill | undefined> {
    if (receipt.status === 'FILLED' || receipt.status === 'PARTIAL') {
      if (!receipt.orderId || !receipt.averagePrice) return undefined
      return {
        venueId: 'GATE', orderId: receipt.orderId, direction: request.direction, quantity: receipt.filledQuantity,
        averagePrice: receipt.averagePrice, filledAt: receipt.receivedAt, verificationSource: 'DIRECT_RECEIPT'
      }
    }
    if (!receipt.orderId) return undefined
    const reconciled = await this.transport.reconcile(receipt.orderId)
    if (!reconciled || (reconciled.status !== 'FILLED' && reconciled.status !== 'PARTIAL') || !reconciled.averagePrice) return undefined
    return {
      venueId: 'GATE', orderId: receipt.orderId, direction: request.direction, quantity: reconciled.filledQuantity,
      averagePrice: reconciled.averagePrice, filledAt: Date.now(), verificationSource: 'PLATFORM_READBACK'
    }
  }

  async reconcileOrder(orderId: string): Promise<VenueOrderReceipt | undefined> {
    const result = await this.transport.reconcile(orderId)
    return result ? receiptFromResult(result, `gate-reconcile-${orderId}`) : undefined
  }
}
