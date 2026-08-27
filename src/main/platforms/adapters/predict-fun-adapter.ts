import Decimal from 'decimal.js'
import type { PredictFunTradingService, PredictFunOrderResult } from '../../services/predict-fun-trading'
import { assertVenueCanExecute, type VenueAdapter, type VenueExecutionRequest, type VenueFill, type VenueOrderReceipt } from '../venue-adapter'

function receiptFromResult(result: PredictFunOrderResult, clientOrderId: string): VenueOrderReceipt {
  return {
    venueId: 'PREDICT_FUN', orderId: result.orderId, clientOrderId, status: result.status,
    filledQuantity: result.filledQuantity, averagePrice: result.averagePrice, receivedAt: Date.now(),
    metadata: result.orderHash ? { orderHash: result.orderHash } : undefined
  }
}

export class PredictFunVenueAdapter implements VenueAdapter {
  readonly venueId = 'PREDICT_FUN'
  readonly capabilities = {
    marketDiscovery: true, realtimeBook: true, placeOrder: true, fillReadback: true, reconcileOrder: true, cancelOrder: false
  } as const

  constructor(private readonly trading: PredictFunTradingService, private readonly liveEnabledProvider: () => boolean) {}

  async preflightOrder(request: VenueExecutionRequest): Promise<void> {
    assertVenueCanExecute(this, request)
    if (!this.liveEnabledProvider()) throw new Error('Predict.fun 实盘下单开关尚未开启')
    if (!request.confirmed) throw new Error('Predict.fun 双腿执行未完成确认')
    if (!request.marketId || !request.outcomeId) throw new Error('Predict.fun 缺少市场或结果 ID')
    const quantity = new Decimal(request.quantity)
    const price = new Decimal(request.limitPrice)
    if (!quantity.isFinite() || quantity.lte(0)) throw new Error('Predict.fun 下单数量无效')
    if (!price.isFinite() || price.lte(0) || price.gte(1)) throw new Error('Predict.fun 下单价格无效')
  }

  async submitOrder(request: VenueExecutionRequest): Promise<VenueOrderReceipt> {
    await this.preflightOrder(request)
    return receiptFromResult(await this.trading.submit(request), request.clientOrderId)
  }

  async waitForFill(receipt: VenueOrderReceipt, request: VenueExecutionRequest): Promise<VenueFill | undefined> {
    const orderHash = String(receipt.metadata?.orderHash ?? '')
    const result = await this.trading.waitForFill({
      orderId: receipt.orderId, orderHash: orderHash || undefined, status: receipt.status,
      filledQuantity: receipt.filledQuantity, averagePrice: receipt.averagePrice
    }, request)
    if (!result || !result.orderId) return undefined
    return {
      venueId: this.venueId, orderId: result.orderId, direction: request.direction,
      quantity: result.filledQuantity, averagePrice: result.averagePrice ?? request.limitPrice,
      filledAt: Date.now(), verificationSource: 'PLATFORM_READBACK'
    }
  }

  async reconcileOrder(orderId: string): Promise<VenueOrderReceipt | undefined> {
    const result = await this.trading.reconcile(orderId)
    return result ? receiptFromResult(result, `predict-reconcile-${orderId}`) : undefined
  }
}
