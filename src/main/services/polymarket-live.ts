import axios from 'axios'
import Decimal from 'decimal.js'
import { HttpsProxyAgent } from 'https-proxy-agent'
import {
  AssetType,
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  createL1Headers,
  getContractConfig,
  type ApiKeyCreds,
  type BalanceAllowanceResponse,
  type OrderBookSummary,
  type OrderResponse,
  type Trade,
  type TickSize
} from '@polymarket/clob-client-v2'
import { createWalletClient, http, type WalletClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type {
  Fill,
  PolymarketCredentialSummary,
  PolymarketIdentityValidation,
  PolymarketSignatureType,
  UpdatePolymarketCredentialsRequest
} from '../../shared/types'
import type { ClosePositionOrder, HedgeOrder, PolymarketBroker } from './polymarket'
import type { PolymarketCredentialStore, PolymarketCredentials } from './polymarket-credential-store'

const CLOB_API = 'https://clob.polymarket.com'
const POLYGON_RPC = 'https://polygon-rpc.com'
const TOKEN_SCALE = new Decimal(1_000_000)
const MIN_MARKETABLE_BUY_AMOUNT = new Decimal(1)
const CLOB_REQUEST_TIMEOUT_MS = 3_000
const CLOB_RATE_LIMIT_COOLDOWN_MS = 60_000
const CLOB_FORBIDDEN_COOLDOWN_MS = 15 * 60_000

class RequestTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RequestTimeoutError(`${label}超过${timeoutMs}毫秒`)), timeoutMs)
        timer.unref()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface PolymarketTradingCapacity {
  checkedAt: number
  collateralBalance: string
  allowanceReady: boolean
  closedOnly: boolean
}

function formatCollateral(raw: string): string {
  const amount = new Decimal(raw || 0).div(TOKEN_SCALE)
  return amount.toDecimalPlaces(6).toString()
}

function allowanceValues(response: BalanceAllowanceResponse): Decimal[] {
  return Object.values(response.allowances ?? {}).map((value) => new Decimal(value || 0))
}

export class PolymarketLiveBroker implements PolymarketBroker {
  private proxyAgent?: HttpsProxyAgent<string>
  private cachedTradingCapacity?: PolymarketTradingCapacity
  private cachedBalanceAllowance?: BalanceAllowanceResponse
  private orderBookCache = new Map<string, { checkedAt: number; book: OrderBookSummary }>()
  private orderBookRequests = new Map<string, Promise<OrderBookSummary>>()
  private warmedConditionIds = new Set<string>()
  private conditionInfoRequests = new Map<string, Promise<void>>()
  private tradingCapacityRequest?: Promise<PolymarketTradingCapacity>
  private cachedClient?: ClobClient
  private cachedClientKey?: string
  private cachedCredentials?: PolymarketCredentials
  private cachedSigner?: WalletClient
  private serverTimeOffsetMs?: number
  private serverTimeSyncedAt = 0
  private clobRequestsBlockedUntil = 0
  private proxyUrl = ''

  constructor(
    private readonly credentialStore: PolymarketCredentialStore,
    private readonly clientFactory: (options: ConstructorParameters<typeof ClobClient>[0]) => ClobClient = (options) => new ClobClient(options)
  ) {}

  configureProxy(proxyUrl: string): void {
    const normalized = proxyUrl.trim()
    axios.defaults.timeout = CLOB_REQUEST_TIMEOUT_MS
    if (normalized === this.proxyUrl) return
    this.proxyUrl = normalized
    this.proxyAgent?.destroy()
    this.proxyAgent = undefined
    this.cachedTradingCapacity = undefined
    this.cachedBalanceAllowance = undefined
    this.orderBookCache.clear()
    this.orderBookRequests.clear()
    this.warmedConditionIds.clear()
    this.conditionInfoRequests.clear()
    this.tradingCapacityRequest = undefined
    if (normalized) {
      this.proxyAgent = new HttpsProxyAgent(normalized)
      axios.defaults.httpAgent = this.proxyAgent
      axios.defaults.httpsAgent = this.proxyAgent
      axios.defaults.proxy = false
      return
    }
    delete axios.defaults.httpAgent
    delete axios.defaults.httpsAgent
    delete axios.defaults.proxy
  }

  async isConfigured(): Promise<boolean> {
    return (await this.credentialStore.getSummary()).configured
  }

  async configureIdentity(request: UpdatePolymarketCredentialsRequest): Promise<PolymarketCredentialSummary> {
    const privateKey = await this.resolvePrivateKey(request.signerPrivateKey)
    if (![0, 1, 2, 3].includes(request.signatureType)) throw new Error('Polymarket签名类型无效')
    const funderAddress = request.funderAddress.trim()
    if (!/^0x[0-9a-fA-F]{40}$/.test(funderAddress)) throw new Error('funder地址格式无效')
    const signerAddress = privateKeyToAccount(privateKey as `0x${string}`).address
    if (request.signatureType === 0 && signerAddress.toLowerCase() !== funderAddress.toLowerCase()) {
      throw new Error('EOA签名类型要求funder地址与签名私钥对应地址一致')
    }
    const signer = this.createSigner(privateKey)
    const bootstrapClient = this.clientFactory({
      host: CLOB_API,
      chain: Chain.POLYGON,
      signer,
      useServerTime: true
    })
    const derived = await bootstrapClient.createOrDeriveApiKey()
    if (!derived?.key || !derived.secret || !derived.passphrase) {
      throw new Error('Polymarket 未返回完整 API 凭据；请检查代理、私钥和系统时间')
    }
    const updated = await this.credentialStore.update({
      signatureType: request.signatureType,
      funderAddress,
      signerPrivateKey: privateKey,
      apiKey: derived.key,
      apiSecret: derived.secret,
      apiPassphrase: derived.passphrase
    })
    this.cachedTradingCapacity = undefined
    this.cachedBalanceAllowance = undefined
    this.cachedClient = undefined
    this.cachedClientKey = undefined
    this.cachedCredentials = undefined
    this.cachedSigner = undefined
    this.orderBookCache.clear()
    this.orderBookRequests.clear()
    this.warmedConditionIds.clear()
    this.conditionInfoRequests.clear()
    this.tradingCapacityRequest = undefined
    return updated
  }

  getCachedTradingCapacity(): PolymarketTradingCapacity | undefined {
    return this.cachedTradingCapacity
  }

  async prefetchOrderBooks(tokenIds: string[], maximumAgeMs = 20_000): Promise<void> {
    const missing = [...new Set(tokenIds.filter(Boolean))].filter((tokenId) => {
      const cached = this.orderBookCache.get(tokenId)
      return !cached || Date.now() - cached.checkedAt > maximumAgeMs
    })
    if (missing.length === 0) return
    const { client } = await this.getTradingContext()
    await Promise.all(missing.map((tokenId) => this.fetchOrderBook(client, tokenId, 'Polymarket盘口预热')))
  }

  async prefetchMarkets(
    markets: Array<{ conditionId?: string; tokenIds: string[] }>,
    maximumAgeMs = 20_000
  ): Promise<void> {
    const tokenIds = [...new Set(markets.flatMap((market) => market.tokenIds).filter(Boolean))]
    const conditionIds = [...new Set(markets.map((market) => market.conditionId).filter((id): id is string => Boolean(id)))]
    const { client } = await this.getTradingContext()
    await Promise.all([
      this.prefetchOrderBooks(tokenIds, maximumAgeMs),
      ...conditionIds.map((conditionId) => this.prefetchConditionInfo(client, conditionId))
    ])
  }

  async ensureTradingCapacity(maximumAgeMs = 30_000): Promise<PolymarketTradingCapacity> {
    if (this.cachedTradingCapacity && Date.now() - this.cachedTradingCapacity.checkedAt <= maximumAgeMs) {
      return this.cachedTradingCapacity
    }
    if (this.tradingCapacityRequest) return await this.tradingCapacityRequest
    const { client } = await this.getTradingContext()
    const request = (async () => {
      const [balance, closedOnlyResult] = await Promise.all([
        this.withClobProtection(() => client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL })),
        this.withClobProtection(() => client.getClosedOnlyMode())
      ])
      this.cachedBalanceAllowance = balance
      const capacity = {
        checkedAt: Date.now(),
        collateralBalance: formatCollateral(balance.balance),
        allowanceReady: allowanceValues(balance).some((value) => value.gt(0)),
        closedOnly: Boolean(closedOnlyResult.closed_only)
      }
      this.cachedTradingCapacity = capacity
      return capacity
    })()
    this.tradingCapacityRequest = request
    try {
      return await request
    } finally {
      if (this.tradingCapacityRequest === request) this.tradingCapacityRequest = undefined
    }
  }

  async validateIdentity(tokenId?: string): Promise<PolymarketIdentityValidation> {
    const { credentials, signer, client } = await this.getTradingContext()
    await createL1Headers(signer, Chain.POLYGON)

    const [, closedOnlyResult, balance, openOrders, trades] = await Promise.all([
      client.getApiKeys(),
      client.getClosedOnlyMode(),
      client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
      client.getOpenOrders(undefined, true),
      client.getTrades(undefined, true)
    ])
    // Every request above is protected by the current L2 API key and HMAC signature.
    // A successful response is the authoritative authentication signal. The API-key
    // listing is informational and may omit or reshape the key that authenticated it.
    const apiAuthenticated = true

    let localOrderSigned = false
    if (tokenId) {
      const book = await client.getOrderBook(tokenId)
      const bestAsk = this.bestAsk(book)
      const minimumSize = Math.max(Number(book.min_order_size || 1), 1)
      await client.createOrder({
        tokenID: tokenId,
        price: bestAsk,
        size: minimumSize,
        side: Side.BUY,
        expiration: Math.floor(Date.now() / 1_000) + 60
      }, {
        tickSize: book.tick_size as TickSize,
        negRisk: book.neg_risk
      })
      localOrderSigned = true
    }

    const allowances = allowanceValues(balance)
    const allowanceReady = allowances.some((value) => value.gt(0))
    const collateralBalance = formatCollateral(balance.balance)
    const hasCollateral = new Decimal(collateralBalance).gt(0)
    const fundedAlternative = hasCollateral
      ? undefined
      : await this.findFundedSignatureType(credentials, signer)
    const closedOnly = Boolean(closedOnlyResult.closed_only)
    this.cachedTradingCapacity = {
      checkedAt: Date.now(),
      collateralBalance,
      allowanceReady,
      closedOnly
    }
    const ok = apiAuthenticated && allowanceReady && hasCollateral && !closedOnly && (!tokenId || localOrderSigned)
    const message = closedOnly
      ? '身份认证成功，但Polymarket账户当前仅允许平仓，不能执行新的BUY对冲'
      : fundedAlternative
        ? `身份认证成功；检测到签名类型${fundedAlternative.signatureType}可读取抵押资产${fundedAlternative.balance}，当前类型${credentials.signatureType}不匹配。软件已推荐正确类型，请重新保存后再验证`
      : !hasCollateral
      ? '身份认证与本地签名通过，但四种签名类型均未读取到funder可用抵押资产；请检查该地址是否确为当前登录账户的个人资料Address'
      : !allowanceReady
        ? '身份认证与本地签名通过，但CLOB allowance尚未就绪'
        : tokenId && !localOrderSigned
          ? '身份认证通过，但当前市场订单签名未完成'
          : '身份、余额、授权、只读账户接口与本地订单签名均已通过；没有提交订单'

    return {
      ok,
      checkedAt: Date.now(),
      signerAddress: privateKeyToAccount(credentials.signerPrivateKey as `0x${string}`).address,
      funderAddress: credentials.funderAddress,
      apiAuthenticated,
      localSignatureVerified: true,
      localOrderSigned,
      closedOnly,
      collateralBalance,
      allowanceReady,
      allowanceCount: allowances.filter((value) => value.gt(0)).length,
      openOrderCount: openOrders.length,
      recentTradeCount: trades.length,
      tokenId,
      suggestedSignatureType: fundedAlternative?.signatureType,
      message
    }
  }

  async hedge(order: HedgeOrder): Promise<Fill> {
    if (!order.tokenId) throw new Error('Polymarket 对冲缺少 tokenId')
    const quantity = new Decimal(order.quantity)
    const maximumPrice = new Decimal(order.maximumPrice)
    if (!quantity.isFinite() || quantity.lte(0)) throw new Error('Polymarket 对冲数量无效')
    if (!maximumPrice.isFinite() || maximumPrice.lte(0) || maximumPrice.gte(1)) {
      throw new Error('Polymarket 对冲最高价格必须在0和1之间')
    }

    const startedAt = Date.now()
    const { client } = await this.getTradingContext()
    const cachedBook = this.orderBookCache.get(order.tokenId)
    const liveLevelsFresh = Boolean(
      order.levels?.length && order.quoteReceivedAt && Date.now() - order.quoteReceivedAt <= 4_000
    )
    const cachedBookFresh = Boolean(cachedBook && Date.now() - cachedBook.checkedAt <= 1_500)
    const bookStartedAt = Date.now()
    const bookPromise = cachedBook && (liveLevelsFresh || cachedBookFresh)
      ? Promise.resolve(cachedBook.book)
      : this.fetchOrderBook(client, order.tokenId, 'Polymarket盘口元数据读取')
    const balanceStartedAt = Date.now()
    const balancePromise = this.cachedBalanceAllowance && this.cachedTradingCapacity && Date.now() - this.cachedTradingCapacity.checkedAt <= 30_000
      ? Promise.resolve(this.cachedBalanceAllowance)
      : this.withClobProtection(() => withTimeout(
        client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
        CLOB_REQUEST_TIMEOUT_MS,
        'Polymarket余额读取'
      )).then((balance) => {
        this.cachedBalanceAllowance = balance
        return balance
      })
    const [book, balance] = await Promise.all([bookPromise, balancePromise])
    const metadataAndBalanceCompletedAt = Date.now()
    const minimumSize = new Decimal(order.minimumOrderSize ?? book.min_order_size ?? '1')
    const availableAsks = (liveLevelsFresh ? order.levels! : book.asks)
      .map((level) => ({ price: new Decimal(level.price || 0), size: new Decimal(level.size || 0) }))
      .filter((level) => level.price.gt(0) && level.price.lt(1) && level.size.gt(0))
      .sort((left, right) => left.price.comparedTo(right.price))
    const executableAsks = availableAsks.filter((level) => level.price.lte(maximumPrice))
    const bestLevel = executableAsks[0]
    if (!bestLevel) {
      const liveBestAsk = availableAsks[0]?.price
      if (liveBestAsk?.gt(maximumPrice)) {
        throw new Error(
          `Polymarket价格保护已触发：当前最优卖价${liveBestAsk.toString()}已超过最高可接受价${maximumPrice.toString()}，未继续追价`
        )
      }
      throw new Error(`Polymarket当前没有价格不高于${maximumPrice.toString()}的可成交卖盘`)
    }
    let submissionPrice = bestLevel.price
    let submissionQuantity = Decimal.min(quantity, bestLevel.size)
    let levelsUsed = 1
    if (order.mode === 'PROTECTED_MARKET') {
      // Attempt the full remaining hedge in one FAK. The previous fixed 50-share
      // batch guaranteed an unnecessary second order for cases such as the 54-share
      // hedge in the execution log, increasing both latency and tail-risk.
      const batchTarget = quantity
      let cumulative = new Decimal(0)
      for (const [index, level] of executableAsks.entries()) {
        cumulative = cumulative.add(level.size)
        submissionPrice = level.price
        levelsUsed = index + 1
        if (cumulative.gte(batchTarget)) break
      }
      // BUY orders commit collateral at the signed limit price. Scale the signed
      // share amount so a fill at today's best ask cannot exceed the remaining target.
      const priceImprovementSafeQuantity = batchTarget.mul(bestLevel.price).div(submissionPrice)
      submissionQuantity = Decimal.min(priceImprovementSafeQuantity, cumulative)
    }
    submissionQuantity = submissionQuantity.toDecimalPlaces(2, Decimal.ROUND_FLOOR)
    const minimumByNotional = MIN_MARKETABLE_BUY_AMOUNT.div(submissionPrice).toDecimalPlaces(2, Decimal.ROUND_CEIL)
    const minimumSubmission = Decimal.max(minimumSize, minimumByNotional)
    if (submissionQuantity.lt(minimumSubmission)) {
      const partialFillCannotOverrunTarget = bestLevel.size.lte(quantity)
      if (quantity.gte(minimumSubmission) || partialFillCannotOverrunTarget || order.allowTailOverhedge) {
        submissionQuantity = minimumSubmission
        submissionPrice = bestLevel.price
        levelsUsed = 1
      } else {
        const minimumReason = minimumByNotional.gt(minimumSize)
          ? `Polymarket BUY至少需要1抵押资产（按当前价格需提交${minimumByNotional.toString()}份）`
          : `Polymarket最小下单量为${minimumSize.toString()}份`
        throw new Error(
          `${minimumReason}；剩余目标${quantity.toString()}份、当前最优档${bestLevel.size.toString()}份，自动买满会造成更大的反向敞口`
        )
      }
    }
    // FAK BUY is a market order with a protected limit price. Polymarket requires
    // the maker (USDC) amount of a market BUY to have at most two decimals. Using
    // createOrder(size × price) can produce a 4-6 decimal maker amount and the CLOB
    // rejects it before matching. Commit an exact cent amount through the SDK's
    // market-order builder instead; flooring keeps the signed order within both the
    // requested quantity and the configured price protection.
    const spendAmount = submissionPrice.mul(submissionQuantity).toDecimalPlaces(2, Decimal.ROUND_FLOOR)
    if (spendAmount.lt(MIN_MARKETABLE_BUY_AMOUNT)) {
      throw new Error(`Polymarket BUY可提交金额${spendAmount.toFixed(2)}低于1 USDC最小值`)
    }
    const signedMaximumQuantity = spendAmount.div(submissionPrice)
    const estimatedFee = this.estimateFeeOnSpend(
      spendAmount,
      submissionPrice,
      book,
      new Decimal(order.feeRate ?? 0),
      new Decimal(order.feeExponent ?? 1)
    )
    this.assertBuyingPower(balance, spendAmount.add(estimatedFee), book)

    const signingStartedAt = Date.now()
    const signedOrder = await withTimeout(client.createMarketOrder({
      tokenID: order.tokenId,
      price: submissionPrice.toNumber(),
      amount: spendAmount.toNumber(),
      side: Side.BUY,
      orderType: OrderType.FAK,
      userUSDCBalance: Number(formatCollateral(balance.balance))
    }, {
      tickSize: book.tick_size as TickSize,
      negRisk: book.neg_risk,
      version: 2
    }), CLOB_REQUEST_TIMEOUT_MS, 'Polymarket订单签名')
    const signedAt = Date.now()
    if (!liveLevelsFresh) this.orderBookCache.delete(order.tokenId)
    let response: OrderResponse
    let responseAt = 0
    let verificationMs = 0
    try {
      response = await withTimeout(
        this.withClobProtection(() => client.postOrder(signedOrder, OrderType.FAK, false, true)),
        CLOB_REQUEST_TIMEOUT_MS + 500,
        'Polymarket FAK提交'
      )
      responseAt = Date.now()
    } catch (error) {
      if (!this.isTimeoutLike(error)) {
        if (this.isNoMatchLike(error)) {
          throw new Error('Polymarket盘口已变化：FAK没有撮合到可用卖盘')
        }
        throw error
      }
      const verificationStartedAt = Date.now()
      const recovered = await this.findRecentTimedOutBuy(
        client,
        order.tokenId,
        startedAt,
        submissionPrice,
        signedMaximumQuantity,
        order.direction
      )
      verificationMs = Date.now() - verificationStartedAt
      if (recovered) {
        return {
          ...recovered,
          executionDetails: {
            quoteSource: liveLevelsFresh ? 'WEBSOCKET' : 'REST',
            levelsUsed,
            bookAndBalanceMs: metadataAndBalanceCompletedAt - Math.min(bookStartedAt, balanceStartedAt),
            signingMs: signedAt - signingStartedAt,
            submissionMs: verificationStartedAt - signedAt,
            confirmationMs: verificationMs,
            timeoutVerificationMs: verificationMs,
            timeoutRecovered: true
          }
        }
      }
      throw new Error(`POLY_SUBMISSION_UNCERTAIN: Polymarket提交超时，成交查询未发现明确回执；已停止自动重复下单，请核对平台成交记录`)
    }
    if (!response.success) {
      const reason = response.errorMsg || response.status || '未知原因'
      if (this.isNoMatchLike(reason)) {
        throw new Error('Polymarket盘口已变化：FAK没有撮合到可用卖盘')
      }
      throw new Error(`Polymarket FAK失败：${reason}`)
    }

    const confirmationStartedAt = Date.now()
    const confirmedFill = await this.confirmPostedBuy(
      client,
      response,
      order.tokenId,
      startedAt,
      submissionPrice,
      order.direction
    )
    return {
      ...confirmedFill,
      executionDetails: {
        quoteSource: liveLevelsFresh ? 'WEBSOCKET' : 'REST',
        levelsUsed,
        committedSpend: spendAmount.toFixed(2),
        bookAndBalanceMs: metadataAndBalanceCompletedAt - Math.min(bookStartedAt, balanceStartedAt),
        signingMs: signedAt - signingStartedAt,
        submissionMs: responseAt - signedAt,
        confirmationMs: Date.now() - confirmationStartedAt,
        timeoutVerificationMs: verificationMs,
        timeoutRecovered: false
      }
    }
  }

  private isTimeoutLike(error: unknown): boolean {
    if (error instanceof RequestTimeoutError) return true
    const message = error instanceof Error ? error.message : String(error)
    return /timeout|timed out|ECONNABORTED|ETIMEDOUT|超过\d+毫秒/i.test(message)
  }

  private isNoMatchLike(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return /no orders found to match|no match is found|没有撮合到|没有成交任何份额/i.test(message)
  }

  private async confirmPostedBuy(
    client: ClobClient,
    response: OrderResponse,
    tokenId: string,
    startedAt: number,
    maximumPrice: Decimal,
    direction: HedgeOrder['direction']
  ): Promise<Fill> {
    const status = String(response.status || '').trim().toUpperCase()
    if (status === 'MATCHED') {
      // Order responses use human-readable token/collateral amounts. Balance and
      // allowance responses use 6-decimal integers, so no token scaling belongs here.
      let filledQuantity = new Decimal(0)
      let spent = new Decimal(0)
      try {
        filledQuantity = new Decimal(response.takingAmount || 0)
        spent = new Decimal(response.makingAmount || 0)
      } catch { /* malformed async response falls through to authoritative trade readback */ }
      if (filledQuantity.gt(0) && spent.gt(0) && response.orderID) {
        return {
          venue: 'POLYMARKET', direction,
          quantity: filledQuantity.toDecimalPlaces(6).toString(),
          averagePrice: spent.div(filledQuantity).toDecimalPlaces(6).toString(),
          orderId: response.orderID,
          filledAt: Date.now(),
          verificationSource: 'PLATFORM_READBACK'
        }
      }
    }

    if (!response.orderID) {
      throw new Error(`POLY_SUBMISSION_UNCERTAIN: Polymarket异步提交返回${status || '未知状态'}且缺少orderID；请核对平台成交记录`)
    }
    let lastReadbackError: unknown
    const confirmationDeadline = Date.now() + 3_200
    for (const delay of [0, 75, 200, 500, 900]) {
      if (delay > 0) {
        const remainingBeforeDelay = confirmationDeadline - Date.now()
        if (remainingBeforeDelay <= delay) break
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
      const remaining = confirmationDeadline - Date.now()
      if (remaining <= 0) break
      let trades: Trade[]
      try {
        trades = await withTimeout(
          this.withClobProtection(() => client.getTrades({ asset_id: tokenId, after: new Date(startedAt - 1_000).toISOString() }, true)),
          Math.min(CLOB_REQUEST_TIMEOUT_MS, remaining),
          'Polymarket异步成交核验'
        )
      } catch (error) {
        lastReadbackError = error
        continue
      }
      const matching = trades.filter((trade) =>
        trade.taker_order_id === response.orderID &&
        this.matchesConfirmedBuy(trade, tokenId, maximumPrice)
      )
      if (matching.length === 0) continue
      const quantity = Decimal.sum(0, ...matching.map((trade) => new Decimal(trade.size || 0)))
      const spend = Decimal.sum(0, ...matching.map((trade) => new Decimal(trade.size || 0).mul(trade.price || 0)))
      if (quantity.lte(0) || spend.lte(0)) continue
      return {
        venue: 'POLYMARKET', direction,
        quantity: quantity.toDecimalPlaces(6).toString(),
        averagePrice: spend.div(quantity).toDecimalPlaces(6).toString(),
        orderId: response.orderID,
        filledAt: Math.max(...matching.map((trade) => Date.parse(trade.match_time) || Date.now())),
        verificationSource: 'PLATFORM_READBACK'
      }
    }
    const readbackReason = lastReadbackError
      ? `；最近一次成交查询失败：${lastReadbackError instanceof Error ? lastReadbackError.message : String(lastReadbackError)}`
      : ''
    throw new Error(`POLY_SUBMISSION_UNCERTAIN: Polymarket订单${response.orderID}返回${status || '未知状态'}，成交查询未发现明确回执${readbackReason}；已停止自动重复下单`)
  }

  private matchesConfirmedBuy(trade: Trade, tokenId: string, maximumPrice: Decimal): boolean {
    const status = String(trade.status || '').toUpperCase()
    try {
      return trade.asset_id === tokenId &&
        String(trade.side).toUpperCase() === 'BUY' &&
        ['MATCHED', 'MINED', 'CONFIRMED'].includes(status) &&
        new Decimal(trade.price || 0).lte(maximumPrice)
    } catch {
      return false
    }
  }

  private async findRecentTimedOutBuy(
    client: ClobClient,
    tokenId: string,
    startedAt: number,
    maximumPrice: Decimal,
    expectedQuantity: Decimal,
    direction: HedgeOrder['direction']
  ): Promise<Fill | undefined> {
    let lastError: unknown
    for (const delay of [250, 1_000]) {
      await new Promise((resolve) => setTimeout(resolve, delay))
      try {
        const trades = await withTimeout(
          this.withClobProtection(() => client.getTrades({ asset_id: tokenId, after: new Date(startedAt - 1_000).toISOString() }, true)),
          CLOB_REQUEST_TIMEOUT_MS,
          'Polymarket超时成交核验'
        )
        const matching = trades.filter((trade) => this.matchesTimedOutBuy(trade, tokenId, startedAt, maximumPrice))
        if (matching.length === 0) continue
        const grouped = new Map<string, Trade[]>()
        for (const trade of matching) {
          const key = trade.taker_order_id || trade.id
          grouped.set(key, [...(grouped.get(key) ?? []), trade])
        }
        const candidate = [...grouped.entries()]
          .map(([orderId, orderTrades]) => {
            const quantity = Decimal.sum(0, ...orderTrades.map((trade) => new Decimal(trade.size || 0)))
            const spend = Decimal.sum(0, ...orderTrades.map((trade) => new Decimal(trade.size || 0).mul(trade.price || 0)))
            const latest = Math.max(...orderTrades.map((trade) => Date.parse(trade.match_time) || startedAt))
            return { orderId, quantity, spend, latest }
          })
          .filter((candidate) => candidate.quantity.gt(0) && candidate.quantity.lte(expectedQuantity.mul('1.05')))
          .sort((left, right) => right.latest - left.latest)[0]
        if (!candidate) continue
        return {
          venue: 'POLYMARKET',
          direction,
          quantity: candidate.quantity.toDecimalPlaces(6).toString(),
          averagePrice: candidate.spend.div(candidate.quantity).toDecimalPlaces(6).toString(),
          orderId: candidate.orderId,
          filledAt: candidate.latest,
          verificationSource: 'PLATFORM_READBACK'
        }
      } catch (error) {
        lastError = error
      }
    }
    if (lastError) throw new Error(`POLY_SUBMISSION_UNCERTAIN: Polymarket提交超时且成交核验失败：${lastError instanceof Error ? lastError.message : String(lastError)}`)
    return undefined
  }

  private matchesTimedOutBuy(
    trade: Trade,
    tokenId: string,
    startedAt: number,
    maximumPrice: Decimal
  ): boolean {
    const matchedAt = Date.parse(trade.match_time)
    return trade.asset_id === tokenId &&
      String(trade.side).toUpperCase() === 'BUY' &&
      Number.isFinite(matchedAt) && matchedAt >= startedAt - 1_000 &&
      new Decimal(trade.price || 0).lte(maximumPrice)
  }

  async closePosition(order: ClosePositionOrder): Promise<Fill> {
    if (!order.tokenId) throw new Error('Polymarket 平仓缺少 tokenId')
    const quantity = new Decimal(order.quantity)
    const maximumSlippage = new Decimal(order.maximumSlippage)
    if (!quantity.isFinite() || quantity.lte(0)) throw new Error('Polymarket 平仓数量无效')
    if (!maximumSlippage.isFinite() || maximumSlippage.lt(0) || maximumSlippage.gte(1)) {
      throw new Error('Polymarket 平仓滑点设置无效')
    }

    const { client } = await this.getTradingContext()
    const [book, balance] = await Promise.all([
      this.fetchOrderBook(client, order.tokenId, 'Polymarket平仓盘口读取'),
      this.withClobProtection(() => client.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: order.tokenId }))
    ])
    const minimumSize = new Decimal(book.min_order_size || 1)
    if (quantity.lt(minimumSize)) throw new Error(`Polymarket当前最小卖出量为${minimumSize.toString()}份`)
    const bidPrices = book.bids
      .map((level) => new Decimal(level.price || 0))
      .filter((price) => price.gt(0) && price.lt(1))
    if (bidPrices.length === 0) throw new Error('Polymarket当前没有可成交买盘，未提交SELL')
    const bestBid = Decimal.max(...bidPrices)
    const minimumPrice = Decimal.max(new Decimal('0.01'), bestBid.minus(maximumSlippage))
    this.assertConditionalBalance(balance, quantity, book)

    const signedOrder = await client.createMarketOrder({
      tokenID: order.tokenId,
      price: minimumPrice.toNumber(),
      amount: quantity.toNumber(),
      side: Side.SELL,
      orderType: OrderType.FOK
    }, {
      tickSize: book.tick_size as TickSize,
      negRisk: book.neg_risk
    })
    const response = await this.withClobProtection(() => client.postOrder(signedOrder, OrderType.FOK))
    if (!response.success) throw new Error(`Polymarket SELL FOK失败：${response.errorMsg || response.status || '未知原因'}`)
    if (String(response.status || '').toUpperCase() !== 'MATCHED') {
      throw new Error(`POLY_SUBMISSION_UNCERTAIN: Polymarket SELL FOK返回${response.status || '未知状态'}；请核对平台成交记录`)
    }
    const filledQuantity = new Decimal(response.makingAmount || 0)
    const proceeds = new Decimal(response.takingAmount || 0)
    if (filledQuantity.lt(quantity)) {
      throw new Error(`Polymarket SELL FOK返回数量不足：需要${quantity.toString()}，返回${filledQuantity.toString()}`)
    }
    if (!response.orderID) throw new Error('Polymarket卖出成功但未返回orderID')
    return {
      venue: 'POLYMARKET', direction: order.direction,
      quantity: filledQuantity.toDecimalPlaces(6).toString(),
      averagePrice: proceeds.div(filledQuantity).toDecimalPlaces(6).toString(),
      orderId: response.orderID,
      filledAt: Date.now(),
      verificationSource: 'PLATFORM_READBACK'
    }
  }

  private createSigner(privateKey: string): WalletClient {
    const account = privateKeyToAccount(privateKey as `0x${string}`)
    return createWalletClient({ account, transport: http(POLYGON_RPC) })
  }

  private fetchOrderBook(client: ClobClient, tokenId: string, label: string): Promise<OrderBookSummary> {
    const active = this.orderBookRequests.get(tokenId)
    if (active) return active
    let request: Promise<OrderBookSummary>
    request = this.withClobProtection(() => withTimeout(
      client.getOrderBook(tokenId),
      CLOB_REQUEST_TIMEOUT_MS,
      label
    )).then((book) => {
      this.orderBookCache.set(tokenId, { checkedAt: Date.now(), book })
      return book
    }).finally(() => {
      if (this.orderBookRequests.get(tokenId) === request) this.orderBookRequests.delete(tokenId)
    })
    this.orderBookRequests.set(tokenId, request)
    return request
  }

  private prefetchConditionInfo(client: ClobClient, conditionId: string): Promise<void> {
    if (this.warmedConditionIds.has(conditionId)) return Promise.resolve()
    const active = this.conditionInfoRequests.get(conditionId)
    if (active) return active
    let request: Promise<void>
    request = this.withClobProtection(() => client.getClobMarketInfo(conditionId))
      .then(() => { this.warmedConditionIds.add(conditionId) })
      .finally(() => {
        if (this.conditionInfoRequests.get(conditionId) === request) this.conditionInfoRequests.delete(conditionId)
      })
    this.conditionInfoRequests.set(conditionId, request)
    return request
  }

  private assertClobRequestsAvailable(): void {
    const remainingMs = this.clobRequestsBlockedUntil - Date.now()
    if (remainingMs <= 0) return
    throw new Error(`Polymarket请求保护已触发，暂停自动请求约${Math.ceil(remainingMs / 1_000)}秒；不会自动重试下单`)
  }

  private async withClobProtection<T>(request: () => Promise<T>): Promise<T> {
    this.assertClobRequestsAvailable()
    try {
      return await request()
    } catch (error) {
      const status = this.httpStatus(error)
      if (status !== 403 && status !== 429) throw error
      const retryAfterMs = this.retryAfterMs(error)
      const fallback = status === 429 ? CLOB_RATE_LIMIT_COOLDOWN_MS : CLOB_FORBIDDEN_COOLDOWN_MS
      this.clobRequestsBlockedUntil = Math.max(this.clobRequestsBlockedUntil, Date.now() + (retryAfterMs ?? fallback))
      throw new Error(`Polymarket返回HTTP ${status}，已暂停自动请求且不会快速重试`)
    }
  }

  private httpStatus(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined
    const candidate = error as { status?: unknown; response?: { status?: unknown } }
    const status = Number(candidate.response?.status ?? candidate.status)
    return Number.isFinite(status) ? status : undefined
  }

  private retryAfterMs(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined
    const response = (error as { response?: { headers?: unknown } }).response
    const headers = response?.headers as { get?: (name: string) => unknown; [key: string]: unknown } | undefined
    const raw = headers?.get?.('retry-after') ?? headers?.['retry-after']
    if (typeof raw !== 'string' && typeof raw !== 'number') return undefined
    const seconds = Number(raw)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1_000, seconds * 1_000)
    const dateMs = Date.parse(String(raw))
    return Number.isFinite(dateMs) ? Math.max(1_000, dateMs - Date.now()) : undefined
  }

  private async getTradingContext(): Promise<{
    credentials: PolymarketCredentials
    signer: WalletClient
    client: ClobClient
  }> {
    if (!this.cachedCredentials || !this.cachedSigner) {
      this.cachedCredentials = await this.credentialStore.getCredentials()
      this.cachedSigner = this.createSigner(this.cachedCredentials.signerPrivateKey)
    }
    return {
      credentials: this.cachedCredentials,
      signer: this.cachedSigner,
      client: this.getAuthenticatedClient(this.cachedCredentials, this.cachedSigner)
    }
  }

  private createAuthenticatedClient(credentials: PolymarketCredentials, signer: WalletClient): ClobClient {
    const creds: ApiKeyCreds = {
      key: credentials.apiKey,
      secret: credentials.apiSecret,
      passphrase: credentials.apiPassphrase
    }
    return this.clientFactory({
      host: CLOB_API,
      chain: Chain.POLYGON,
      signer,
      creds,
      signatureType: credentials.signatureType as SignatureTypeV2,
      funderAddress: credentials.funderAddress,
      useServerTime: true,
      retryOnError: false,
      throwOnError: true
    })
  }

  private getAuthenticatedClient(credentials: PolymarketCredentials, signer: WalletClient): ClobClient {
    const key = [
      credentials.apiKey, credentials.apiSecret, credentials.apiPassphrase,
      credentials.signatureType, credentials.funderAddress, credentials.signerPrivateKey
    ].join('|')
    if (this.cachedClient && this.cachedClientKey === key) return this.cachedClient
    const client = this.createAuthenticatedClient(credentials, signer)
    // useServerTime makes the SDK await GET /time before every signed request,
    // adding a full CLOB round trip to each hedge submission. Cache the measured
    // local-clock offset for 5 minutes instead; the periodic capacity refresh
    // keeps the offset warm so the order path skips the extra round trip.
    const remoteServerTime = typeof client.getServerTime === 'function'
      ? client.getServerTime.bind(client) as () => Promise<number>
      : undefined
    if (remoteServerTime) {
      client.getServerTime = async (): Promise<number> => {
        if (this.serverTimeOffsetMs !== undefined && Date.now() - this.serverTimeSyncedAt < 300_000) {
          return Date.now() + this.serverTimeOffsetMs
        }
        const remote = await remoteServerTime()
        this.serverTimeOffsetMs = remote - Date.now()
        this.serverTimeSyncedAt = Date.now()
        return remote
      }
    }
    this.cachedClient = client
    this.cachedClientKey = key
    return client
  }

  async prefetchServerTime(): Promise<void> {
    if (this.serverTimeOffsetMs !== undefined && Date.now() - this.serverTimeSyncedAt < 120_000) return
    try {
      const { credentials, client } = await this.getTradingContext()
      if (!credentials.apiKey || !credentials.signerPrivateKey) return
      await this.withClobProtection(() => client.getServerTime())
    } catch {
      // 预热失败不影响下单路径：真实下单时会再次请求服务器时间
    }
  }

  private async findFundedSignatureType(
    credentials: PolymarketCredentials,
    signer: WalletClient
  ): Promise<{ signatureType: PolymarketSignatureType; balance: string } | undefined> {
    const candidates = ([0, 1, 2, 3] as PolymarketSignatureType[])
      .filter((signatureType) => signatureType !== credentials.signatureType)
    const results = await Promise.all(candidates.map(async (signatureType) => {
      try {
        const client = this.createAuthenticatedClient({ ...credentials, signatureType }, signer)
        const balance = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL })
        return { signatureType, rawBalance: new Decimal(balance.balance || 0) }
      } catch {
        return undefined
      }
    }))
    const funded = results
      .filter((result): result is { signatureType: PolymarketSignatureType; rawBalance: Decimal } => Boolean(result?.rawBalance.gt(0)))
      .sort((left, right) => right.rawBalance.comparedTo(left.rawBalance))[0]
    return funded
      ? { signatureType: funded.signatureType, balance: formatCollateral(funded.rawBalance.toString()) }
      : undefined
  }

  private async resolvePrivateKey(privateKey?: string): Promise<string> {
    const normalized = privateKey?.trim()
    if (normalized) return normalized
    try {
      return (await this.credentialStore.getCredentials()).signerPrivateKey
    } catch {
      throw new Error('首次配置需要填写订单签名私钥')
    }
  }

  private bestAsk(book: OrderBookSummary): number {
    const asks = book.asks.map((level) => Number(level.price)).filter((price) => price > 0 && price < 1)
    if (!asks.length) throw new Error('当前Polymarket市场没有可签名测试的卖盘')
    return Math.min(...asks)
  }

  private assertBuyingPower(balance: BalanceAllowanceResponse, required: Decimal, book: OrderBookSummary): void {
    const requiredRaw = required.mul(TOKEN_SCALE).ceil()
    const availableRaw = new Decimal(balance.balance || 0)
    if (availableRaw.lt(requiredRaw)) {
      throw new Error(`Polymarket余额不足：需要约${required.toFixed(2)}，可用${formatCollateral(balance.balance)}`)
    }
    const contracts = getContractConfig(Chain.POLYGON)
    const possibleExchanges = book.neg_risk
      ? [contracts.negRiskExchange, contracts.negRiskExchangeV2, contracts.exchangeV3]
      : [contracts.exchange, contracts.exchangeV2, contracts.exchangeV3]
    const allowances = Object.fromEntries(
      Object.entries(balance.allowances ?? {}).map(([address, value]) => [address.toLowerCase(), new Decimal(value || 0)])
    )
    const ready = possibleExchanges.some((address) => allowances[address.toLowerCase()]?.gte(requiredRaw))
    if (!ready) throw new Error('Polymarket抵押资产授权不足；未提交订单')
  }

  private assertConditionalBalance(balance: BalanceAllowanceResponse, required: Decimal, book: OrderBookSummary): void {
    const requiredRaw = required.mul(TOKEN_SCALE).ceil()
    const availableRaw = new Decimal(balance.balance || 0)
    if (availableRaw.lt(requiredRaw)) {
      throw new Error(`Polymarket持仓不足：需要${required.toString()}份，可用${formatCollateral(balance.balance)}份`)
    }
    const contracts = getContractConfig(Chain.POLYGON)
    const possibleExchanges = book.neg_risk
      ? [contracts.negRiskExchange, contracts.negRiskExchangeV2, contracts.exchangeV3]
      : [contracts.exchange, contracts.exchangeV2, contracts.exchangeV3]
    const allowances = Object.fromEntries(
      Object.entries(balance.allowances ?? {}).map(([address, value]) => [address.toLowerCase(), new Decimal(value || 0)])
    )
    if (!possibleExchanges.some((address) => allowances[address.toLowerCase()]?.gte(requiredRaw))) {
      throw new Error('Polymarket条件代币卖出授权不足；未提交SELL')
    }
  }

  private estimateFeeOnSpend(
    spendAmount: Decimal,
    maximumPrice: Decimal,
    book: OrderBookSummary,
    feeRate: Decimal,
    feeExponent: Decimal
  ): Decimal {
    if (feeRate.lte(0) || spendAmount.lte(0)) return new Decimal(0)
    const prices = book.asks
      .map((level) => new Decimal(level.price || 0))
      .filter((price) => price.gt(0) && price.lte(maximumPrice))
    prices.push(maximumPrice)
    // For e > 1, the fee-per-collateral curve can peak inside the quoted range.
    // Include that stationary point so the balance check remains conservative.
    if (feeExponent.gt(1)) {
      const criticalPrice = feeExponent.minus(1).div(feeExponent.mul(2).minus(1))
      if (criticalPrice.gt(0) && criticalPrice.lte(maximumPrice)) prices.push(criticalPrice)
    }
    const maximumEffectiveRate = Decimal.max(...prices.map((price) => (
      price.mul(new Decimal(1).minus(price)).pow(feeExponent).mul(feeRate).div(price)
    )))
    return spendAmount.mul(maximumEffectiveRate)
  }
}
