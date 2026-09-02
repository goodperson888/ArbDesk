import Decimal from 'decimal.js'
import type { PredictFunTradingService, PredictFunOrderResult } from '../../services/predict-fun-trading'
import { assertVenueCanExecute, type VenueAdapter, type VenueExecutionRequest, type VenueFill, type VenueOrderReceipt } from '../venue-adapter'

function receiptFromResult(result: PredictFunOrderResult, clientOrderId: string): VenueOrderReceipt {
  const metadata: Record<string, string | number | boolean> = {}
  if (result.orderHash) metadata.orderHash = result.orderHash
  if (result.transport) metadata.transport = result.transport
  return {
    venueId: 'PREDICT_FUN', orderId: result.orderId, clientOrderId, status: result.status,
    filledQuantity: result.filledQuantity, averagePrice: result.averagePrice, receivedAt: Date.now(),
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined
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
    const duration = Math.round((request.endTime - request.startTime) / 60_000)
    if (duration !== 5 && duration !== 15) throw new Error(`Predict.fun 不支持 ${duration} 分钟周期`)
    const mode = typeof this.trading.executionMode === 'function'
      ? await this.trading.executionMode(duration)
      : 'API'
    if (mode === 'UNAVAILABLE') throw new Error('Predict.fun 未配置 API 交易身份，且已登录页面下单不可用；请打开对应 5m/15m 页面并登录')
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
      filledQuantity: receipt.filledQuantity, averagePrice: receipt.averagePrice,
      transport: receipt.metadata?.transport === 'PAGE' ? 'PAGE' : receipt.metadata?.transport === 'API' ? 'API' : undefined
    }, request)
    if (!result || !result.orderId) return undefined
    if (result.status === 'REJECTED' || result.status === 'CANCELED') {
      throw new Error(result.message ?? `Predict.fun 订单 ${result.orderId} 未成交`)
    }
    if (!new Decimal(result.filledQuantity).isFinite() || new Decimal(result.filledQuantity).lte(0)) return undefined
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
