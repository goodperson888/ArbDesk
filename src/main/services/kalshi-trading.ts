import { randomUUID } from 'node:crypto'
import Decimal from 'decimal.js'
import type { Direction, KalshiOrderReceipt, PlaceKalshiOrderRequest, RiskSettings } from '../../shared/types'
import type { KalshiCredentialStore } from './kalshi-credential-store'
import { kalshiHeaders } from './kalshi-auth'
import type { KalshiMarketData } from './kalshi-market-data'

const API = 'https://api.elections.kalshi.com/trade-api/v2'
const ORDER_PATH = '/portfolio/events/orders'
const REQUEST_TIMEOUT_MS = 10_000
const MAX_QUOTE_AGE_MS = 8_000
const ALLOWED_API_HOSTS = new Set(['api.elections.kalshi.com', 'external-api.kalshi.com'])

type FetchLike = typeof fetch
type KalshiBookSide = 'bid' | 'ask'

interface CreateOrderResponse {
  order_id?: string
  client_order_id?: string
  fill_count?: string
  remaining_count?: string
  ts_ms?: number
}

function decimal(value: string, name: string): Decimal {
  const result = new Decimal(value)
  if (!result.isFinite()) throw new Error(`Kalshi ${name}必须是有效数字`)
  return result
}

function fixedPrice(value: Decimal): string { return value.toDecimalPlaces(4).toFixed(4) }
function fixedCount(value: Decimal): string { return value.toDecimalPlaces(2).toFixed(2) }

export function assertKalshiTradingRequestAllowed(method: string, rawUrl: string): void {
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:' || !ALLOWED_API_HOSTS.has(url.hostname)) {
    throw new Error(`Kalshi 实盘下单禁止访问 ${url.origin}`)
  }
  if (method.toUpperCase() !== 'POST' || url.pathname !== `/trade-api/v2${ORDER_PATH}`) {
    throw new Error(`Kalshi 实盘下单禁止请求 ${method.toUpperCase()} ${url.pathname}`)
  }
}

function messageForHttp(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string; code?: string; details?: string }
    return [parsed.code, parsed.message, parsed.details].filter(Boolean).join(' · ') || `HTTP ${status}`
  } catch { return `HTTP ${status}` }
}

function outcomeToBook(direction: Direction, outcomePrice: Decimal): { side: KalshiBookSide; yesPrice: Decimal } {
  // V2 quotes everything from the YES book. Buying DOWN/NO is represented by
  // selling YES at 1 - outcome price (Kalshi's documented semantics).
  return direction === 'UP'
    ? { side: 'bid', yesPrice: outcomePrice }
    : { side: 'ask', yesPrice: new Decimal(1).minus(outcomePrice) }
}

export class KalshiTradingService {
  private readonly inFlight = new Map<string, Promise<KalshiOrderReceipt>>()

  constructor(
    private readonly credentials: KalshiCredentialStore,
    private readonly marketData: KalshiMarketData,
    private readonly settingsProvider: () => RiskSettings,
    private readonly liveExecutionEnabled: boolean,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async placeOrder(request: PlaceKalshiOrderRequest): Promise<KalshiOrderReceipt> {
    const settings = this.settingsProvider()
    if (!this.liveExecutionEnabled) throw new Error('当前开发环境未开启实盘执行门禁；请使用正式构建或明确设置 ARB_ENABLE_LIVE_EXECUTION=true')
    if (!settings.kalshiLiveEnabled) throw new Error('Kalshi 实盘下单开关已关闭；请先在设置中明确开启')
    if (settings.mode === 'SIMULATION') throw new Error('当前为模拟模式，不允许发送 Kalshi 真实订单')
    if (!request.confirmed) throw new Error('未完成 Kalshi 真实下单二次确认')

    const ticker = request.ticker.trim()
    if (!/^[A-Z0-9][A-Z0-9_.-]{2,79}$/.test(ticker)) throw new Error('Kalshi ticker 格式无效')
    if (request.direction !== 'UP' && request.direction !== 'DOWN') throw new Error('Kalshi 方向无效')
    const quantity = decimal(request.quantity, '下单数量')
    const outcomePrice = decimal(request.outcomePrice, '下单价格')
    if (quantity.lt(1) || quantity.gt(10_000)) throw new Error('Kalshi 下单数量必须在 1 至 10000 份之间')
    if (outcomePrice.lt('0.01') || outcomePrice.gt('0.99')) throw new Error('Kalshi outcome 价格必须在 0.01 至 0.99 之间')
    if (!Number.isFinite(request.quoteReceivedAt) || Date.now() - request.quoteReceivedAt > MAX_QUOTE_AGE_MS) {
      throw new Error(`Kalshi 行情已超过 ${MAX_QUOTE_AGE_MS / 1_000} 秒，已拒绝下单；请重新选择机会`)
    }
    if (!Number.isFinite(request.marketEndTime) || request.marketEndTime - Date.now() < 20_000) {
      throw new Error('Kalshi 市场距离结算不足 20 秒，已拒绝下单')
    }

    const current = this.marketData.getLatestWindows().find((window) => window.marketId === ticker)
    const currentQuote = current?.outcomes[request.direction]
    if (!current || !currentQuote) throw new Error('Kalshi 当前市场或对应方向盘口已消失，请刷新后重试')
    if (Date.now() - currentQuote.receivedAt > MAX_QUOTE_AGE_MS) throw new Error('Kalshi 当前盘口已过期，已拒绝下单')
    if (current.endTime - Date.now() < 20_000) throw new Error('Kalshi 当前市场即将结算，已拒绝下单')
    if (currentQuote.bestAsk !== request.outcomePrice && new Decimal(currentQuote.bestAsk).gt(outcomePrice)) {
      throw new Error(`Kalshi 价格保护已触发：当前卖一 ${currentQuote.bestAsk} 高于确认价格 ${request.outcomePrice}`)
    }
    const available = decimal(currentQuote.askSize, '盘口深度')
    if (available.lt(quantity)) throw new Error(`Kalshi 盘口深度不足：当前 ${available.toFixed(2)} 份，计划 ${quantity.toFixed(2)} 份`)
    const estimatedCost = quantity.mul(outcomePrice)
    if (estimatedCost.gt(decimal(settings.maxCapitalPerTrade, '单笔本金上限'))) {
      throw new Error(`Kalshi 预计本金 ${estimatedCost.toFixed(2)} USD 超过单笔上限 ${settings.maxCapitalPerTrade} USD`)
    }

    const key = [ticker, request.direction, fixedCount(quantity), fixedPrice(outcomePrice)].join('|')
    const existing = this.inFlight.get(key)
    if (existing) return await existing
    const operation = this.submit({ ...request, ticker }, quantity, outcomePrice)
    this.inFlight.set(key, operation)
    try { return await operation } finally { this.inFlight.delete(key) }
  }

  private async submit(request: PlaceKalshiOrderRequest, quantity: Decimal, outcomePrice: Decimal): Promise<KalshiOrderReceipt> {
    const credentials = await this.credentials.getCredentials()
    const { side, yesPrice } = outcomeToBook(request.direction, outcomePrice)
    const clientOrderId = `arbdesk-${randomUUID()}`
    const body = JSON.stringify({
      ticker: request.ticker,
      client_order_id: clientOrderId,
      side,
      count: fixedCount(quantity),
      price: fixedPrice(yesPrice),
      time_in_force: 'fill_or_kill',
      self_trade_prevention_type: 'taker_at_cross',
      post_only: false,
      reduce_only: false,
      subaccount: 0,
      exchange_index: 0
    })
    const url = `${API}${ORDER_PATH}`
    assertKalshiTradingRequestAllowed('POST', url)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: kalshiHeaders(credentials, 'POST', ORDER_PATH),
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/aborted|timeout|fetch failed/i.test(message)) {
        throw new Error(`Kalshi 订单提交结果未知（client_order_id ${clientOrderId}）；未自动重试，请到 Kalshi 订单页核对后再操作`)
      }
      throw error
    }
    const responseBody = await response.text()
    if (!response.ok) throw new Error(`Kalshi 下单失败：${messageForHttp(response.status, responseBody)}；未自动重试`)
    let payload: CreateOrderResponse
    try { payload = JSON.parse(responseBody) as CreateOrderResponse } catch { throw new Error('Kalshi 下单返回无法解析；请到订单页核对，未自动重试') }
    if (!payload.order_id) throw new Error('Kalshi 下单返回缺少 order_id；结果需人工核对，未自动重试')
    const fillCount = payload.fill_count ?? '0.00'
    const remainingCount = payload.remaining_count ?? fixedCount(quantity)
    const fill = decimal(fillCount, '成交数量')
    const remaining = decimal(remainingCount, '剩余数量')
    const status: KalshiOrderReceipt['status'] = fill.gte(quantity)
      ? 'EXECUTED'
      : fill.gt(0) ? 'PARTIAL' : remaining.eq(0) ? 'CANCELED' : 'RESTING'
    return {
      orderId: payload.order_id,
      clientOrderId: payload.client_order_id ?? clientOrderId,
      ticker: request.ticker,
      direction: request.direction,
      side,
      quantity: fixedCount(quantity),
      outcomePrice: fixedPrice(outcomePrice),
      fillCount,
      remainingCount,
      status,
      submittedAt: Number(payload.ts_ms) || Date.now(),
      message: status === 'EXECUTED'
        ? 'Kalshi FOK 订单已即时成交'
        : status === 'PARTIAL' ? 'Kalshi 返回部分成交，请核对订单状态' : status === 'CANCELED' ? 'Kalshi 未成交，FOK 剩余份额已取消' : 'Kalshi 订单已提交但仍有剩余份额'
    }
  }
}
