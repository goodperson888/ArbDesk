import {
  ChainId as PredictChainId,
  OrderBuilder as PredictOrderBuilder,
  Side as PredictSide
} from '@predictdotfun/sdk'
import { FallbackProvider, JsonRpcProvider, Wallet, parseEther } from 'ethers'
import Decimal from 'decimal.js'
import type { PredictFunCredentialStore, PredictFunCredentials } from './predict-fun-credential-store'
import type { PredictFunMarketData } from './predict-fun-market-data'
import type { PredictFunPageCaptureSource } from './predict-fun-page-capture'
import type { VenueExecutionRequest } from '../platforms/venue-adapter'

const API_BASE = 'https://api.predict.fun'
const BNB_RPC_URL = 'https://bsc-dataseed.bnbchain.org/'
const BNB_RPC_FALLBACKS = [
  BNB_RPC_URL,
  'https://bsc-dataseed.binance.org/',
  'https://bsc-dataseed1.binance.org/',
  'https://bsc-dataseed2.binance.org/'
]
const REQUEST_TIMEOUT_MS = 6_000
// A confirmed page fill took about three seconds in the live sample. Keep API
// reconciliation inside the same ten-second envelope instead of giving up
// after the previous ~0.6 seconds.
const FILL_POLL_ATTEMPTS = 40
const FILL_POLL_INTERVAL_MS = 250

interface PredictAuthMessageResponse { data?: { message?: string } }
interface PredictAuthResponse { data?: { token?: string } }
interface PredictOrderResponse {
  data?: { orderId?: string; orderHash?: string; code?: string }
}
interface PredictOrderStatusResponse {
  data?: {
    order?: Record<string, unknown>
    id?: string
    marketId?: number
    amount?: string | number
    amountFilled?: string | number
    status?: string
    pricePerShare?: string | number
  }
}

export interface PredictFunOrderResult {
  orderId?: string
  orderHash?: string
  transport?: 'API' | 'PAGE'
  status: 'ACCEPTED' | 'PARTIAL' | 'FILLED' | 'REJECTED' | 'UNKNOWN' | 'CANCELED'
  filledQuantity: string
  averagePrice?: string
  message?: string
}

function createBnbProvider(preferredUrl: string): FallbackProvider {
  const urls = [preferredUrl, ...BNB_RPC_FALLBACKS].filter((url, index, all) => Boolean(url) && all.indexOf(url) === index)
  return new FallbackProvider(urls.map((url, index) => ({
    provider: new JsonRpcProvider(url, 56, { staticNetwork: true }),
    priority: index + 1,
    stallTimeout: index === 0 ? 1_500 : 2_500,
    weight: 1
  })), 56, { quorum: 1 })
}

export class PredictFunTradingService {
  private jwt?: { token: string; expiresAt: number; accountAddress: string }
  private builder?: { key: string; value: PredictOrderBuilder }
  private authInFlight?: Promise<string>
  private builderInFlight?: Promise<PredictOrderBuilder>
  private readonly provider: FallbackProvider

  constructor(
    private readonly credentials: PredictFunCredentialStore,
    private readonly marketData: PredictFunMarketData,
    private readonly fetchImpl: typeof fetch = fetch,
    rpcUrl = BNB_RPC_URL,
    private readonly pageExecutor?: PredictFunPageCaptureSource
  ) {
    this.provider = createBnbProvider(rpcUrl)
  }

  credentialsChanged(): void {
    this.jwt = undefined
    this.builder = undefined
  }

  /**
   * Warm the signing builder and JWT outside the opportunity hot path. This
   * never places an order; failures are logged and left for the normal submit
   * path to report with its usual safety checks.
   */
  async warmUp(): Promise<void> {
    const startedAt = Date.now()
    try {
      const credentials = await this.credentials.getCredentials()
      const builderStartedAt = Date.now()
      const builder = await this.getBuilder(credentials)
      const builderMs = Date.now() - builderStartedAt
      const authStartedAt = Date.now()
      await this.getJwt(credentials, builder)
      const authMs = Date.now() - authStartedAt
      console.info(`[Predict预热] ${JSON.stringify({ ok: true, builderMs, authMs, totalMs: Date.now() - startedAt })}`)
    } catch (error) {
      // Missing credentials is normal when the user is using page mode. Do
      // not turn background warming into a visible execution failure.
      console.info(`[Predict预热] ${JSON.stringify({ ok: false, elapsedMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) })}`)
    }
  }

  async submit(request: VenueExecutionRequest): Promise<PredictFunOrderResult> {
    const startedAt = Date.now()
    const timed = async <T>(phase: string, operation: () => Promise<T>, details: Record<string, string | number | boolean> = {}): Promise<T> => {
      const phaseStartedAt = Date.now()
      try {
        const result = await operation()
        console.info(`[Predict耗时] ${JSON.stringify({ phase, elapsedMs: Date.now() - phaseStartedAt, ok: true, ...details })}`)
        return result
      } catch (error) {
        console.info(`[Predict耗时] ${JSON.stringify({ phase, elapsedMs: Date.now() - phaseStartedAt, ok: false, error: error instanceof Error ? error.message : String(error), ...details })}`)
        throw error
      }
    }
    let credentials: PredictFunCredentials | undefined
    try {
      credentials = await this.credentials.getCredentials()
    } catch (error) {
      if (this.pageExecutor?.executePageOrder && this.pageExecutor.canExecutePageOrders?.(durationFromRequest(request))) {
        return await this.submitThroughPage(request)
      }
      throw error
    }
    if (!credentials) throw new Error('Predict.fun 交易身份尚未完整配置')
    const metadata = this.marketData.getTradingMetadata(request.marketId)
    if (!metadata) throw new Error(`Predict.fun 市场 ${request.marketId} 未找到交易元数据`)
    const price = new Decimal(request.limitPrice)
    const quantity = new Decimal(request.quantity)
    if (!price.isFinite() || price.lte(0) || price.gte(1)) throw new Error('Predict.fun 下单价格无效')
    if (!quantity.isFinite() || quantity.lte(0)) throw new Error('Predict.fun 下单数量无效')

    const builder = await timed('builder', () => this.getBuilder(credentials!), { marketId: request.marketId })
    const amounts = builder.getLimitOrderAmounts({
      side: PredictSide.BUY,
      pricePerShareWei: parseEther(price.toString()),
      quantityWei: parseEther(quantity.toString())
    })
    const expiresAt = new Date(Math.min(request.endTime, Date.now() + 5 * 60_000))
    const order = builder.buildOrder('LIMIT', {
      side: PredictSide.BUY,
      tokenId: request.outcomeId,
      makerAmount: amounts.makerAmount,
      takerAmount: amounts.takerAmount,
      feeRateBps: metadata.feeRateBps,
      nonce: 0n,
      expiresAt
    })
    const typedData = builder.buildTypedData(order, {
      isNegRisk: metadata.isNegRisk,
      isYieldBearing: metadata.isYieldBearing
    })
    const signed = await timed('sign', () => builder.signTypedDataOrder(typedData), { marketId: request.marketId })
    const orderHash = builder.buildTypedDataHash(typedData)
    const jwt = await timed('auth', () => this.getJwt(credentials!, builder))
    const response = await timed(
      'order.post',
      () => this.request<PredictOrderResponse>('/v1/orders', credentials!, jwt, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          data: {
            order: { ...signed, hash: orderHash },
            pricePerShare: amounts.pricePerShare.toString(),
            strategy: 'LIMIT'
          }
        })
      }),
      { marketId: request.marketId, quantity: request.quantity }
    )
    const orderId = response.data?.orderId
    const returnedHash = response.data?.orderHash ?? orderHash
    if (!orderId) throw new Error(`Predict.fun 下单响应未返回订单号（${response.data?.code ?? 'unknown'}）`)
    console.info(`[Predict耗时] ${JSON.stringify({ phase: 'submit.total', elapsedMs: Date.now() - startedAt, ok: true, marketId: request.marketId })}`)
    return { orderId, orderHash: returnedHash, transport: 'API', status: 'ACCEPTED', filledQuantity: '0', averagePrice: price.toString() }
  }

  async executionMode(durationMinutes: 5 | 15): Promise<'API' | 'PAGE' | 'UNAVAILABLE'> {
    try {
      const summary = await this.credentials.getSummary()
      if (summary.tradingConfigured) return 'API'
    } catch {
      // Fall through to page mode. A missing API key is expected for many
      // Predict.fun accounts.
    }
    return this.pageExecutor?.canExecutePageOrders?.(durationMinutes) ? 'PAGE' : 'UNAVAILABLE'
  }

  private async submitThroughPage(request: VenueExecutionRequest): Promise<PredictFunOrderResult> {
    if (!this.pageExecutor?.executePageOrder) throw new Error('Predict.fun 页面下单执行器不可用')
    const response = await this.pageExecutor.executePageOrder({
      marketId: request.marketId,
      outcomeId: request.outcomeId,
      direction: request.direction,
      quantity: request.quantity,
      limitPrice: request.limitPrice,
      clientOrderId: request.clientOrderId,
      startTime: request.startTime,
      durationMinutes: durationFromRequest(request),
      allowSubmit: true
    })
    const parsed = parsePageOrderResult(response.body, response.status)
    return { ...parsed, transport: 'PAGE' }
  }

  async reconcile(orderHash: string): Promise<PredictFunOrderResult | undefined> {
    const credentials = await this.credentials.getCredentials()
    const jwt = await this.getJwt(credentials, await this.getBuilder(credentials))
    const response = await this.request<PredictOrderStatusResponse>(`/v1/orders/${encodeURIComponent(orderHash)}`, credentials, jwt)
    const data = response.data
    if (!data) return undefined
    const requestedQuantity = normalizeTokenQuantity(data.amount)
    const rawStatus = String(data.status ?? '').toUpperCase()
    const filledQuantity = normalizeTokenQuantity(data.amountFilled ?? (['FILLED', 'MATCHED', 'COMPLETED'].includes(rawStatus) ? data.amount ?? 0 : 0)).toString()
    const filled = new Decimal(filledQuantity)
    const status: PredictFunOrderResult['status'] = filled.gt(0) && requestedQuantity.gt(0) && filled.gte(requestedQuantity)
      ? 'FILLED'
      : filled.gt(0)
        ? 'PARTIAL'
        : ['FILLED', 'MATCHED', 'COMPLETED'].includes(rawStatus)
          ? 'FILLED'
        : ['CANCELED', 'CANCELLED', 'EXPIRED'].includes(rawStatus)
          ? 'CANCELED'
          : ['REJECTED', 'FAILED'].includes(rawStatus) ? 'REJECTED' : 'ACCEPTED'
    return {
      orderId: data.id ?? orderHash,
      orderHash,
      status,
      filledQuantity,
      averagePrice: data.pricePerShare !== undefined ? normalizeSharePrice(data.pricePerShare).toString() : undefined,
      message: rawStatus || undefined
    }
  }

  async waitForFill(result: PredictFunOrderResult, request: VenueExecutionRequest): Promise<PredictFunOrderResult | undefined> {
    // Page mode consumes the private wallet WebSocket already opened by the
    // logged-in page. It does not add an HTTP poll or require an API key.
    if (result.transport === 'PAGE') {
      if (new Decimal(result.filledQuantity).gt(0)) return result
      if (!result.orderId || !this.pageExecutor?.waitForPageOrderFill) return undefined
      const fill = await this.pageExecutor.waitForPageOrderFill(result.orderId)
      if (!fill) return undefined
      if (fill.status === 'REJECTED') {
        return {
          orderId: result.orderId,
          orderHash: fill.orderHash ?? result.orderHash,
          transport: 'PAGE',
          status: 'REJECTED',
          filledQuantity: '0',
          message: fill.message ?? 'Predict.fun 撮合失败，平台未产生持仓'
        }
      }
      const filled = new Decimal(fill.filledQuantity)
      const requested = new Decimal(request.quantity)
      return {
        orderId: result.orderId,
        orderHash: fill.orderHash ?? result.orderHash,
        transport: 'PAGE',
        status: filled.gte(requested) ? 'FILLED' : 'PARTIAL',
        filledQuantity: fill.filledQuantity,
        averagePrice: fill.averagePrice ?? request.limitPrice,
        message: `${fill.source}${fill.feeQuantity ? `；已扣除 ${fill.feeQuantity} 份手续费` : ''}`
      }
    }
    if (!result.orderHash && !result.orderId) return undefined
    let latest = result
    const startedAt = Date.now()
    let attempts = 0
    let terminalStatus: PredictFunOrderResult['status'] | 'NONE' = 'NONE'
    const lookup = result.orderHash ?? result.orderId!
    try {
      for (let attempt = 0; attempt < FILL_POLL_ATTEMPTS; attempt += 1) {
        attempts = attempt + 1
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, FILL_POLL_INTERVAL_MS))
        const current = await this.reconcile(lookup)
        if (!current) continue
        latest = current
        if (current.status === 'FILLED' || current.status === 'PARTIAL' || current.status === 'CANCELED' || current.status === 'REJECTED') {
          terminalStatus = current.status
          break
        }
      }
    } finally {
      console.info(`[Predict耗时] ${JSON.stringify({ phase: 'fill.readback', elapsedMs: Date.now() - startedAt, attempts, terminalStatus, orderId: result.orderId })}`)
    }
    if (new Decimal(latest.filledQuantity).lte(0)) return undefined
    if (!latest.averagePrice) latest.averagePrice = request.limitPrice
    return latest
  }

  private async getBuilder(credentials: PredictFunCredentials): Promise<PredictOrderBuilder> {
    const key = `${credentials.accountType}:${credentials.accountAddress.toLowerCase()}:${credentials.signerAddress.toLowerCase()}`
    if (this.builder?.key === key) return this.builder.value
    if (this.builderInFlight) return await this.builderInFlight
    this.builderInFlight = (async () => {
      const signer = new Wallet(credentials.signerPrivateKey, this.provider)
      const value = await PredictOrderBuilder.make(PredictChainId.BnbMainnet, signer,
        credentials.accountType === 'PREDICT_ACCOUNT' ? { predictAccount: credentials.accountAddress } : undefined)
      this.builder = { key, value }
      return value
    })()
    try {
      return await this.builderInFlight
    } finally {
      this.builderInFlight = undefined
    }
  }

  private async getJwt(credentials: PredictFunCredentials, builder: PredictOrderBuilder): Promise<string> {
    if (this.jwt && this.jwt.accountAddress.toLowerCase() === credentials.accountAddress.toLowerCase() && this.jwt.expiresAt > Date.now() + 30_000) return this.jwt.token
    if (this.authInFlight) return await this.authInFlight
    this.authInFlight = (async () => {
      const authMessage = await this.request<PredictAuthMessageResponse>('/v1/auth/message', credentials)
      const message = authMessage.data?.message
      if (!message) throw new Error('Predict.fun 鉴权响应缺少待签名消息')
      const signer = new Wallet(credentials.signerPrivateKey, this.provider)
      const signature = credentials.accountType === 'PREDICT_ACCOUNT'
        ? await (builder as unknown as { signPredictAccountMessage(value: string): Promise<string> }).signPredictAccountMessage(message)
        : await signer.signMessage(message)
      const response = await this.request<PredictAuthResponse>('/v1/auth', credentials, undefined, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        // Predict Account auth identifies the Smart Wallet/deposit address;
        // the wrapped signature proves control by the exported signer.
        body: JSON.stringify({ signer: credentials.accountAddress, signature, message })
      })
      const token = response.data?.token
      if (!token) throw new Error('Predict.fun 鉴权响应缺少 JWT')
      this.jwt = { token, expiresAt: jwtExpiry(token) ?? Date.now() + 5 * 60_000, accountAddress: credentials.accountAddress }
      return token
    })()
    try {
      return await this.authInFlight
    } finally {
      this.authInFlight = undefined
    }
  }

  private async request<T>(path: string, credentials: PredictFunCredentials, jwt?: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    headers.set('user-agent', 'ArbDesk/0.1')
    headers.set('x-api-key', credentials.apiKey)
    if (jwt) headers.set('authorization', `Bearer ${jwt}`)
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const response = await this.fetchImpl(`${API_BASE}${path}`, { ...init, headers, signal: timeout })
    if (!response.ok) {
      let detail = ''
      try {
        const payload = await response.json() as { message?: string; error?: string; code?: string; data?: { message?: string; code?: string } }
        const code = payload.code ?? payload.data?.code
        const message = payload.message ?? payload.error ?? payload.data?.message
        detail = [code, message].filter(Boolean).join(': ')
      } catch {
        // Preserve the status even when the gateway returns a non-JSON body.
      }
      throw new Error(`api.predict.fun ${path} HTTP ${response.status}${detail ? ` (${detail})` : ''}`)
    }
    return await response.json() as T
  }
}

function jwtExpiry(token: string): number | undefined {
  try {
    const payload = token.split('.')[1]
    if (!payload) return undefined
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number }
    return Number.isFinite(parsed.exp) ? Number(parsed.exp) * 1_000 : undefined
  } catch {
    return undefined
  }
}

// Predict's REST readback returns token amounts and, on some API versions,
// prices as 18-decimal wei strings. Keep the execution layer in human units;
// otherwise a 3.2-share fill would be reported as 3.2e18 shares and could
// trigger an unsafe hedge quantity.
function normalizeTokenQuantity(value: unknown): Decimal {
  const parsed = new Decimal(String(value ?? 0))
  if (!parsed.isFinite()) return new Decimal(0)
  return parsed.abs().gte(new Decimal(10).pow(12)) ? parsed.div(new Decimal(10).pow(18)) : parsed
}

function normalizeSharePrice(value: unknown): Decimal {
  const parsed = new Decimal(String(value ?? 0))
  if (!parsed.isFinite()) return new Decimal(0)
  return parsed.abs().gt(1) ? parsed.div(new Decimal(10).pow(18)) : parsed
}

function durationFromRequest(request: VenueExecutionRequest): 5 | 15 {
  const duration = Math.round((request.endTime - request.startTime) / 60_000)
  if (duration !== 5 && duration !== 15) throw new Error(`Predict.fun 不支持 ${duration} 分钟周期`)
  return duration
}

function parsePageOrderResult(body: string, httpStatus: number): PredictFunOrderResult {
  let root: unknown
  try { root = JSON.parse(body) as unknown } catch { root = undefined }
  const values: unknown[] = []
  const walk = (value: unknown, depth = 0): void => {
    if (depth > 6 || value === null || value === undefined) return
    values.push(value)
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return }
    if (typeof value === 'object') for (const item of Object.values(value as Record<string, unknown>)) walk(item, depth + 1)
  }
  walk(root)
  const records = values.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value)))
  const read = (keys: string[]): string | undefined => {
    for (const record of records) for (const key of keys) {
      const value = record[key]
      if (typeof value === 'string' || typeof value === 'number') return String(value)
    }
    return undefined
  }
  const orderId = read(['orderId', 'order_id', 'id'])
  const orderHash = read(['orderHash', 'order_hash', 'hash'])
  const filledQuantity = read(['filledQuantity', 'filled_quantity', 'amountFilled', 'filled', 'quantityFilled']) ?? '0'
  const averagePrice = read(['averagePrice', 'average_price', 'pricePerShare', 'price'])
  const rawStatus = (read(['status', 'state', 'orderStatus']) ?? '').toUpperCase()
  const message = read(['message', 'reason', 'error', 'code'])
  const status: PredictFunOrderResult['status'] = ['FILLED', 'MATCHED', 'COMPLETED'].includes(rawStatus)
    ? 'FILLED'
    : ['PARTIAL', 'PARTIALLY_FILLED'].includes(rawStatus)
      ? 'PARTIAL'
      : ['REJECTED', 'FAILED', 'ERROR'].includes(rawStatus) || httpStatus >= 400
        ? 'REJECTED'
        : ['CANCELED', 'CANCELLED', 'EXPIRED'].includes(rawStatus)
          ? 'CANCELED'
          : 'ACCEPTED'
  if (!orderId && !orderHash) {
    if (httpStatus >= 400) throw new Error(`Predict.fun 页面下单失败（HTTP ${httpStatus}）`)
    throw new Error('Predict.fun 页面已点击买入但响应未返回订单号；订单状态不明，禁止重试')
  }
  return { orderId, orderHash, status, filledQuantity, averagePrice, message }
}
