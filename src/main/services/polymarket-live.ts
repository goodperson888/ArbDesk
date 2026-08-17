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

function formatCollateral(raw: string): string {
  const amount = new Decimal(raw || 0).div(TOKEN_SCALE)
  return amount.toDecimalPlaces(6).toString()
}

function allowanceValues(response: BalanceAllowanceResponse): Decimal[] {
  return Object.values(response.allowances ?? {}).map((value) => new Decimal(value || 0))
}

export class PolymarketLiveBroker implements PolymarketBroker {
  private proxyAgent?: HttpsProxyAgent<string>

  constructor(
    private readonly credentialStore: PolymarketCredentialStore,
    private readonly clientFactory: (options: ConstructorParameters<typeof ClobClient>[0]) => ClobClient = (options) => new ClobClient(options)
  ) {}

  configureProxy(proxyUrl: string): void {
    this.proxyAgent?.destroy()
    this.proxyAgent = undefined
    const normalized = proxyUrl.trim()
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
    return await this.credentialStore.update({
      signatureType: request.signatureType,
      funderAddress,
      signerPrivateKey: privateKey,
      apiKey: derived.key,
      apiSecret: derived.secret,
      apiPassphrase: derived.passphrase
    })
  }

  async validateIdentity(tokenId?: string): Promise<PolymarketIdentityValidation> {
    const credentials = await this.credentialStore.getCredentials()
    const signer = this.createSigner(credentials.signerPrivateKey)
    const client = this.createAuthenticatedClient(credentials, signer)
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

    const credentials = await this.credentialStore.getCredentials()
    const signer = this.createSigner(credentials.signerPrivateKey)
    const client = this.createAuthenticatedClient(credentials, signer)
    const [book, balance] = await Promise.all([
      client.getOrderBook(order.tokenId),
      client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL })
    ])
    const minimumSize = new Decimal(book.min_order_size || 1)
    if (quantity.lt(minimumSize)) {
      throw new Error(`Polymarket当前最小下单量为${minimumSize.toString()}份，MEXC实际成交仅${quantity.toString()}份；未提交第二腿`)
    }
    // A BUY market/FOK order is expressed as the collateral maker amount. Polymarket
    // accepts at most two decimal places for that value. Round upward so the
    // resulting token amount cannot under-hedge the confirmed MEXC share count.
    const spendAmount = maximumPrice.mul(quantity).toDecimalPlaces(2, Decimal.ROUND_UP)
    if (spendAmount.lt(MIN_MARKETABLE_BUY_AMOUNT)) {
      throw new Error(`Polymarket可立即成交的BUY至少需要1抵押资产；当前${quantity.toString()}份按最高价${maximumPrice.toString()}仅为${spendAmount.toFixed(2)}。第一腿成交量不足，未提交第二腿`)
    }
    const estimatedFee = this.estimateFeeOnSpend(
      spendAmount,
      maximumPrice,
      book,
      new Decimal(order.feeRate ?? 0),
      new Decimal(order.feeExponent ?? 1)
    )
    this.assertBuyingPower(balance, spendAmount.add(estimatedFee), book)

    const signedOrder = await client.createMarketOrder({
      tokenID: order.tokenId,
      price: maximumPrice.toNumber(),
      amount: spendAmount.toNumber(),
      side: Side.BUY,
      orderType: OrderType.FOK
    }, {
      tickSize: book.tick_size as TickSize,
      negRisk: book.neg_risk
    })
    const response = await client.postOrder(signedOrder, OrderType.FOK)
    if (!response.success) throw new Error(`Polymarket FOK失败：${response.errorMsg || response.status || '未知原因'}`)

    // The order response returns human-readable token/collateral amounts. Balance and
    // allowance responses use 6-decimal integers, but applying that scale here
    // turns a valid 4.26-share fill into 0.00000426 shares.
    const filledQuantity = new Decimal(response.takingAmount || 0)
    const spent = new Decimal(response.makingAmount || 0)
    if (filledQuantity.lt(quantity)) {
      throw new Error(`Polymarket FOK返回数量不足：需要${quantity.toString()}，返回${filledQuantity.toString()}`)
    }
    if (!response.orderID) throw new Error('Polymarket订单成功但未返回orderID')
    return {
      venue: 'POLYMARKET',
      direction: order.direction,
      quantity: filledQuantity.toDecimalPlaces(6).toString(),
      averagePrice: spent.div(filledQuantity).toDecimalPlaces(6).toString(),
      orderId: response.orderID,
      filledAt: Date.now()
    }
  }

  async closePosition(order: ClosePositionOrder): Promise<Fill> {
    if (!order.tokenId) throw new Error('Polymarket 平仓缺少 tokenId')
    const quantity = new Decimal(order.quantity)
    const maximumSlippage = new Decimal(order.maximumSlippage)
    if (!quantity.isFinite() || quantity.lte(0)) throw new Error('Polymarket 平仓数量无效')
    if (!maximumSlippage.isFinite() || maximumSlippage.lt(0) || maximumSlippage.gte(1)) {
      throw new Error('Polymarket 平仓滑点设置无效')
    }

    const credentials = await this.credentialStore.getCredentials()
    const signer = this.createSigner(credentials.signerPrivateKey)
    const client = this.createAuthenticatedClient(credentials, signer)
    const [book, balance] = await Promise.all([
      client.getOrderBook(order.tokenId),
      client.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: order.tokenId })
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
    const response = await client.postOrder(signedOrder, OrderType.FOK)
    if (!response.success) throw new Error(`Polymarket SELL FOK失败：${response.errorMsg || response.status || '未知原因'}`)
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
      filledAt: Date.now()
    }
  }

  private createSigner(privateKey: string): WalletClient {
    const account = privateKeyToAccount(privateKey as `0x${string}`)
    return createWalletClient({ account, transport: http(POLYGON_RPC) })
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
      retryOnError: true,
      throwOnError: true
    })
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
