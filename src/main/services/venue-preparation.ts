import { createHmac } from 'node:crypto'
import {
  OrderBuilder as LimitlessOrderBuilder,
  OrderSigner as LimitlessOrderSigner,
  Side as LimitlessSide
} from '@limitless-exchange/sdk'
import {
  AddressesByChainId,
  ChainId as PredictChainId,
  OrderBuilder as PredictOrderBuilder,
  Side as PredictSide
} from '@predictdotfun/sdk'
import { Contract, JsonRpcProvider, Wallet, formatEther, formatUnits, keccak256, parseEther } from 'ethers'
import type { VenuePreparationReport, VenuePreparationStage, VenuePreparationStageStatus } from '../../shared/types'
import type { LimitlessCredentialStore, LimitlessCredentials } from './limitless-credential-store'
import type { PredictFunCredentialStore, PredictFunCredentials } from './predict-fun-credential-store'
import type { LimitlessMarketData, LimitlessPreparationCandidate } from './limitless-market-data'
import type { PredictFunMarketData, PredictFunPreparationCandidate } from './predict-fun-market-data'

const REQUEST_TIMEOUT_MS = 6_000
const REPORT_CACHE_MS = 15_000
const BASE_RPC_URL = 'https://mainnet.base.org'
const BNB_RPC_URL = 'https://bsc-dataseed.binance.org'
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)'
]

type FetchLike = typeof fetch

interface ApiListResponse {
  data?: unknown[]
  orders?: unknown[]
  positions?: unknown[]
  history?: unknown[]
}

interface LimitlessProfileResponse {
  id?: number
  account?: string
  tradeWalletOption?: string | null
  rank?: { feeRateBps?: number }
}

interface PredictAuthMessageResponse {
  success?: boolean
  data?: { message?: string }
}

interface PredictAuthResponse {
  success?: boolean
  data?: { token?: string }
}

interface PredictAccountResponse {
  success?: boolean
  data?: { address?: string }
}

interface PredictAccountBundle {
  account: PredictAccountResponse
  orders: ApiListResponse
  positions: ApiListResponse
}

interface StageRecorder {
  stages: VenuePreparationStage[]
  run<T>(id: string, label: string, task: () => Promise<T>, detail: (value: T) => string, status?: (value: T) => VenuePreparationStageStatus): Promise<T>
  add(id: string, label: string, status: VenuePreparationStageStatus, detail: string): void
}

function recorder(): StageRecorder {
  const stages: VenuePreparationStage[] = []
  return {
    stages,
    async run(id, label, task, detail, status = () => 'PASS') {
      const startedAt = Date.now()
      try {
        const value = await task()
        stages.push({ id, label, status: status(value), durationMs: Date.now() - startedAt, detail: detail(value) })
        return value
      } catch (error) {
        stages.push({
          id,
          label,
          status: 'BLOCKED',
          durationMs: Date.now() - startedAt,
          detail: error instanceof Error ? error.message : String(error)
        })
        throw error
      }
    },
    add(id, label, status, detail) {
      stages.push({ id, label, status, durationMs: 0, detail })
    }
  }
}

function listLength(value: ApiListResponse | undefined): number {
  if (!value) return 0
  const candidates = [value.data, value.orders, value.positions, value.history]
  return candidates.find(Array.isArray)?.length ?? 0
}

function combinedSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function normalizeQuantity(value: string): number {
  const available = Number(value)
  if (!Number.isFinite(available) || available <= 0) throw new Error('当前盘口没有可用于离线构单的深度')
  const quantity = Math.min(1, Math.floor(available * 1_000) / 1_000)
  if (quantity < 0.01) throw new Error('当前盘口深度低于 0.01 份，无法构造有效测试订单')
  return quantity
}

function limitlessPrice(value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) throw new Error('Limitless 最优卖价无效')
  return Math.min(0.999, Math.ceil(parsed * 1_000) / 1_000)
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

export function assertPreparationRequestAllowed(venue: 'LIMITLESS' | 'PREDICT_FUN', method: string, url: string): void {
  const parsed = new URL(url)
  const normalizedMethod = method.toUpperCase()
  const expectedHost = venue === 'LIMITLESS' ? 'api.limitless.exchange' : 'api.predict.fun'
  if (parsed.protocol !== 'https:' || parsed.hostname !== expectedHost) {
    throw new Error(`${venue} 安全联调禁止访问 ${parsed.origin}`)
  }
  if (normalizedMethod === 'GET') return
  if (venue === 'PREDICT_FUN' && normalizedMethod === 'POST' && parsed.pathname === '/v1/auth') return
  throw new Error(`${venue} 安全联调禁止请求 ${normalizedMethod} ${parsed.pathname}`)
}

async function safeJson<T>(venue: 'LIMITLESS' | 'PREDICT_FUN', fetchImpl: FetchLike, url: string, init: RequestInit = {}): Promise<T> {
  const method = String(init.method ?? 'GET').toUpperCase()
  assertPreparationRequestAllowed(venue, method, url)
  const response = await fetchImpl(url, { ...init, method, signal: combinedSignal(init.signal ?? undefined) })
  if (!response.ok) throw new Error(`${new URL(url).hostname} ${method} HTTP ${response.status}`)
  return await response.json() as T
}

function limitlessHeaders(credentials: Pick<LimitlessCredentials, 'tokenId' | 'tokenSecret'>, path: string): Record<string, string> {
  const timestamp = new Date().toISOString()
  const signature = createHmac('sha256', Buffer.from(credentials.tokenSecret, 'base64'))
    .update(`${timestamp}\nGET\n${path}\n`)
    .digest('base64')
  return {
    accept: 'application/json',
    'user-agent': 'ArbDesk/0.1',
    'lmts-api-key': credentials.tokenId,
    'lmts-timestamp': timestamp,
    'lmts-signature': signature
  }
}

async function limitlessGet<T>(fetchImpl: FetchLike, credentials: LimitlessCredentials, path: string): Promise<T> {
  return await safeJson<T>('LIMITLESS', fetchImpl, `https://api.limitless.exchange${path}`, {
    headers: limitlessHeaders(credentials, path)
  })
}

interface CachedReport {
  value: VenuePreparationReport
  cachedAt: number
}

export class LimitlessPreparationService {
  private inFlight?: Promise<VenuePreparationReport>
  private cached?: CachedReport

  constructor(
    private readonly credentials: LimitlessCredentialStore,
    private readonly marketData: LimitlessMarketData,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseRpcUrl = BASE_RPC_URL
  ) {}

  async prepare(): Promise<VenuePreparationReport> {
    if (this.cached && Date.now() - this.cached.cachedAt < REPORT_CACHE_MS) return this.cached.value
    if (this.inFlight) return await this.inFlight
    this.inFlight = this.run()
    try {
      const value = await this.inFlight
      this.cached = { value, cachedAt: Date.now() }
      return value
    } finally {
      this.inFlight = undefined
    }
  }

  credentialsChanged(): void {
    this.cached = undefined
  }

  private async run(): Promise<VenuePreparationReport> {
    const record = recorder()
    let requestCount = 0
    let identityVerified = false
    let marketDataReady = false
    let accountReadsReady = false
    let localOrderBuilt = false
    let localOrderSigned = false
    let chainReadReady = false
    let fundingReady = false
    let approvalsReady = false
    let collateralBalance: string | undefined
    let nativeBalance: string | undefined
    let openOrderCount: number | undefined
    let positionCount: number | undefined
    let candidate: LimitlessPreparationCandidate | undefined
    let orderHash: string | undefined

    try {
      const credentials = await record.run('identity-local', '读取加密身份', () => this.credentials.getCredentials(),
        (value) => `Profile ${value.profileId} · 钱包 ${value.walletAddress.slice(0, 8)}…`)
      const profile = await record.run('identity-api', '验证 HMAC 与 EOA 身份', async () => {
        requestCount += 1
        return await limitlessGet<LimitlessProfileResponse>(this.fetchImpl, credentials, '/profiles/me')
      }, (value) => `Profile ${value.id ?? '—'} · EOA 模式`)
      if (profile.account?.toLowerCase() !== credentials.walletAddress.toLowerCase()) throw new Error('Token 所属账户与私钥地址不一致')
      if (profile.tradeWalletOption && profile.tradeWalletOption !== 'eoa') throw new Error('当前不是 EOA 交易模式')
      identityVerified = true

      await record.run('market-refresh', '刷新可交易市场与盘口', async () => {
        await this.marketData.fetchWindows()
        candidate = this.marketData.getPreparationCandidate()
        if (!candidate) throw new Error('当前没有带动态 exchange 地址的 BTC 5m/15m CLOB 盘口')
        return candidate
      }, (value) => `${value.marketId} · ${value.direction} ${value.bestAsk}`)
      marketDataReady = true

      const accountBundle = await record.run('account-reads', '读取持仓、历史与当前市场委托', async () => {
        requestCount += 3
        const [positions, history, orders] = await Promise.all([
          limitlessGet<ApiListResponse>(this.fetchImpl, credentials, '/portfolio/positions'),
          limitlessGet<ApiListResponse>(this.fetchImpl, credentials, '/portfolio/history'),
          limitlessGet<ApiListResponse>(this.fetchImpl, credentials, `/markets/${encodeURIComponent(candidate!.marketId)}/user-orders`)
        ])
        return { positions, history, orders }
      }, (value) => `持仓 ${listLength(value.positions)} · 委托 ${listLength(value.orders)} · 历史 ${listLength(value.history)}`)
      positionCount = listLength(accountBundle.positions)
      openOrderCount = listLength(accountBundle.orders)
      accountReadsReady = true

      try {
        const chain = await record.run('chain-readiness', '读取 Base 余额与动态授权', async () => {
          const provider = new JsonRpcProvider(this.baseRpcUrl, 8453, { staticNetwork: true })
          const token = new Contract(candidate!.collateralAddress, ERC20_ABI, provider)
          try {
            const [native, balance, allowance] = await Promise.all([
              provider.getBalance(credentials.walletAddress),
              token.balanceOf(credentials.walletAddress) as Promise<bigint>,
              token.allowance(credentials.walletAddress, candidate!.exchangeAddress) as Promise<bigint>
            ])
            return { native, balance, allowance }
          } finally {
            provider.destroy()
          }
        }, (value) => `USDC ${formatUnits(value.balance, candidate!.collateralDecimals)} · Base ETH ${formatEther(value.native)} · allowance ${formatUnits(value.allowance, candidate!.collateralDecimals)}`,
        (value) => value.balance > 0n && value.native > 0n && value.allowance > 0n ? 'PASS' : 'WARN')
        collateralBalance = formatUnits(chain.balance, candidate!.collateralDecimals)
        nativeBalance = formatEther(chain.native)
        fundingReady = chain.balance > 0n && chain.native > 0n
        approvalsReady = chain.allowance > 0n
        chainReadReady = true
      } catch {
        // Chain RPC readiness is useful diagnostics, but a provider outage must not
        // prevent local order construction/signing from being verified.
      }

      const signed = await record.run('offline-order', '官方 SDK 离线构单与 EIP-712 签名', async () => {
        const quantity = normalizeQuantity(candidate!.availableQuantity)
        const price = limitlessPrice(candidate!.bestAsk)
        const feeRateBps = Number(profile.rank?.feeRateBps ?? 300)
        const builder = new LimitlessOrderBuilder(credentials.walletAddress, feeRateBps, 0.001)
        const unsigned = builder.buildOrder({
          tokenId: candidate!.outcomeId,
          price,
          size: quantity,
          side: LimitlessSide.BUY
        })
        localOrderBuilt = true
        const signer = new LimitlessOrderSigner(new Wallet(credentials.walletPrivateKey))
        const signature = await signer.signOrder(unsigned, { chainId: 8453, contractAddress: candidate!.exchangeAddress })
        return { unsigned, signature, quantity, price }
      }, (value) => `FAK 参数已构建并签名 · ${value.quantity}份 @ ${value.price} · 未发送`)
      localOrderSigned = /^0x[0-9a-f]+$/i.test(signed.signature)
      orderHash = keccak256(signed.signature as `0x${string}`)
      record.add('submission-guard', '真实订单提交硬禁令', 'PASS', '没有 POST /orders、撤单或链上授权入口；签名仅保留在本次主进程内存')
    } catch {
      record.add('submission-guard', '真实订单提交硬禁令', 'PASS', '联调失败也不会回退到真实下单、撤单或授权交易')
    }

    const readyExceptFunding = identityVerified && marketDataReady && accountReadsReady && chainReadReady && localOrderBuilt && localOrderSigned
    return {
      venueId: 'LIMITLESS', checkedAt: Date.now(), safeMode: true, orderSubmissionBlocked: true,
      identityVerified, marketDataReady, accountReadsReady, localOrderBuilt, localOrderSigned,
      fundingReady, approvalsReady, collateralBalance, nativeBalance, openOrderCount, positionCount,
      marketId: candidate?.marketId, outcomeId: candidate?.outcomeId, orderHash, requestCount, readyExceptFunding,
      message: readyExceptFunding
        ? fundingReady && approvalsReady
          ? '非下单链路全部通过；真实提交仍被代码硬性禁止'
          : '非下单链路已通过；目前只缺资金/授权和最后的小额真实提交验证'
        : '非下单联调仍有阻塞项，请查看下面的阶段结果',
      stages: record.stages
    }
  }
}

export class PredictFunPreparationService {
  private inFlight?: Promise<VenuePreparationReport>
  private cached?: CachedReport
  private jwt?: { token: string; expiresAt: number; accountAddress: string }

  constructor(
    private readonly credentials: PredictFunCredentialStore,
    private readonly marketData: PredictFunMarketData,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly bnbRpcUrl = BNB_RPC_URL
  ) {}

  async prepare(): Promise<VenuePreparationReport> {
    if (this.cached && Date.now() - this.cached.cachedAt < REPORT_CACHE_MS) return this.cached.value
    if (this.inFlight) return await this.inFlight
    this.inFlight = this.run()
    try {
      const value = await this.inFlight
      this.cached = { value, cachedAt: Date.now() }
      return value
    } finally {
      this.inFlight = undefined
    }
  }

  credentialsChanged(): void {
    this.cached = undefined
    this.jwt = undefined
  }

  private async predictJson<T>(credentials: PredictFunCredentials, path: string, jwt?: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    headers.set('user-agent', 'ArbDesk/0.1')
    headers.set('x-api-key', credentials.apiKey)
    if (jwt) headers.set('authorization', `Bearer ${jwt}`)
    return await safeJson<T>('PREDICT_FUN', this.fetchImpl, `https://api.predict.fun${path}`, { ...init, headers })
  }

  private async getJwt(credentials: PredictFunCredentials, builder: PredictOrderBuilder): Promise<{ token: string; requests: number }> {
    if (this.jwt && this.jwt.accountAddress.toLowerCase() === credentials.accountAddress.toLowerCase() && this.jwt.expiresAt > Date.now() + 30_000) {
      return { token: this.jwt.token, requests: 0 }
    }
    const authMessage = await this.predictJson<PredictAuthMessageResponse>(credentials, '/v1/auth/message')
    const message = authMessage.data?.message
    if (!message) throw new Error('Predict.fun 鉴权响应缺少待签名消息')
    const signer = new Wallet(credentials.signerPrivateKey)
    const signature = credentials.accountType === 'PREDICT_ACCOUNT'
      ? await (builder as unknown as { signPredictAccountMessage(value: string): Promise<string> }).signPredictAccountMessage(message)
      : await signer.signMessage(message)
    const response = await this.predictJson<PredictAuthResponse>(credentials, '/v1/auth', undefined, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signer: credentials.accountAddress, signature, message })
    })
    const token = response.data?.token
    if (!token) throw new Error('Predict.fun 鉴权响应缺少 JWT')
    this.jwt = { token, expiresAt: jwtExpiry(token) ?? Date.now() + 5 * 60_000, accountAddress: credentials.accountAddress }
    return { token, requests: 2 }
  }

  private async run(): Promise<VenuePreparationReport> {
    const record = recorder()
    let requestCount = 0
    let identityVerified = false
    let marketDataReady = false
    let accountReadsReady = false
    let localOrderBuilt = false
    let localOrderSigned = false
    let chainReadReady = false
    let fundingReady = false
    let approvalsReady = false
    let collateralBalance: string | undefined
    let nativeBalance: string | undefined
    let openOrderCount: number | undefined
    let positionCount: number | undefined
    let candidate: PredictFunPreparationCandidate | undefined
    let orderHash: string | undefined

    try {
      const credentials = await record.run('identity-local', '读取加密身份', () => this.credentials.getCredentials(),
        (value) => `${value.accountType} · account ${value.accountAddress.slice(0, 8)}… · signer ${value.signerAddress.slice(0, 8)}…`)
      await record.run('market-refresh', '刷新官方/网页市场与盘口', async () => {
        await this.marketData.fetchWindows()
        candidate = this.marketData.getPreparationCandidate()
        if (!candidate) throw new Error('当前没有可用于离线构单的 BTC 5m/15m 盘口；网页被动行情只能扫描，官方 Key 模式才能完成账户联调')
        return candidate
      }, (value) => `Market ${value.marketId} · ${value.direction} ${value.bestAsk}`)
      marketDataReady = true

      const rpcProvider = new JsonRpcProvider(this.bnbRpcUrl, 56, { staticNetwork: true })
      const signer = new Wallet(credentials.signerPrivateKey, rpcProvider)
      const builder = await record.run('builder-identity', '验证 signer / Predict Account 控制关系', async () => {
        return await PredictOrderBuilder.make(PredictChainId.BnbMainnet, signer, credentials.accountType === 'PREDICT_ACCOUNT'
          ? { predictAccount: credentials.accountAddress }
          : undefined)
      }, () => '官方 SDK 账户构建器已初始化')

      const jwt = await record.run('jwt-auth', '签名动态消息并获取 JWT', async () => {
        const result = await this.getJwt(credentials, builder)
        requestCount += result.requests
        return result.token
      }, () => '动态鉴权通过；JWT 只保存在主进程内存')

      const accountBundle = await record.run('account-reads', '读取账户、持仓与委托', async () => {
        requestCount += 3
        const [account, orders, positions] = await Promise.all([
          this.predictJson<PredictAccountResponse>(credentials, '/v1/account', jwt),
          this.predictJson<ApiListResponse>(credentials, '/v1/orders?first=20&status=OPEN', jwt),
          this.predictJson<ApiListResponse>(credentials, '/v1/positions?first=20&isResolved=false', jwt)
        ])
        return { account, orders, positions } satisfies PredictAccountBundle
      }, (value) => `持仓 ${listLength(value.positions)} · 活动委托 ${listLength(value.orders)}`)
      if (accountBundle.account.data?.address?.toLowerCase() !== credentials.accountAddress.toLowerCase()) {
        throw new Error('JWT 返回账户与配置的 Predict Account/EOA 地址不一致')
      }
      identityVerified = true
      positionCount = listLength(accountBundle.positions)
      openOrderCount = listLength(accountBundle.orders)
      accountReadsReady = true

      try {
        const chain = await record.run('chain-readiness', '读取 BNB、USDT 与交易授权', async () => {
          const steps = builder.getApprovalSteps({
            operation: 'TRADE', isNegRisk: candidate!.isNegRisk, isYieldBearing: candidate!.isYieldBearing, side: PredictSide.BUY
          })
          const [native, balance, approvalChecks] = await Promise.all([
            rpcProvider.getBalance(credentials.signerAddress),
            builder.balanceOf('USDT', credentials.accountAddress),
            builder.checkApprovals(steps)
          ])
          return { native, balance, approvalChecks }
        }, (value) => `USDT ${formatUnits(value.balance, 18)} · BNB ${formatEther(value.native)} · 授权 ${value.approvalChecks.filter((item) => item.satisfied).length}/${value.approvalChecks.length}`,
        (value) => value.balance > 0n && value.native > 0n && value.approvalChecks.every((item) => item.satisfied) ? 'PASS' : 'WARN')
        collateralBalance = formatUnits(chain.balance, 18)
        nativeBalance = formatEther(chain.native)
        fundingReady = chain.balance > 0n && chain.native > 0n
        approvalsReady = chain.approvalChecks.every((item) => item.satisfied)
        chainReadReady = true
      } catch {
        // Keep validating the offline signed payload when only the public RPC is unavailable.
      }

      const signed = await record.run('offline-order', '官方 SDK 离线构单与 EIP-712 签名', async () => {
        const quantity = normalizeQuantity(candidate!.availableQuantity)
        const price = Number(candidate!.bestAsk)
        if (!Number.isFinite(price) || price <= 0 || price >= 1) throw new Error('Predict.fun 最优卖价无效')
        const amounts = builder.getLimitOrderAmounts({
          side: PredictSide.BUY,
          pricePerShareWei: parseEther(price.toString()),
          quantityWei: parseEther(quantity.toString())
        })
        const order = builder.buildOrder('LIMIT', {
          side: PredictSide.BUY,
          tokenId: candidate!.outcomeId,
          makerAmount: amounts.makerAmount,
          takerAmount: amounts.takerAmount,
          feeRateBps: candidate!.feeRateBps,
          nonce: 0n
        })
        localOrderBuilt = true
        const typedData = builder.buildTypedData(order, {
          isNegRisk: candidate!.isNegRisk,
          isYieldBearing: candidate!.isYieldBearing
        })
        const signedOrder = await builder.signTypedDataOrder(typedData)
        return { hash: builder.buildTypedDataHash(typedData), signature: signedOrder.signature, quantity, price }
      }, (value) => `LIMIT 参数已构建并签名 · ${value.quantity}份 @ ${value.price} · 未发送`)
      localOrderSigned = /^0x[0-9a-f]+$/i.test(signed.signature)
      orderHash = signed.hash
      rpcProvider.destroy()
      record.add('submission-guard', '真实订单提交硬禁令', 'PASS', '只允许 GET 与 JWT /v1/auth；POST /v1/orders、撤单和授权交易均被拒绝')
    } catch {
      record.add('submission-guard', '真实订单提交硬禁令', 'PASS', '联调失败也不会回退到真实下单、撤单或链上授权交易')
    }

    const readyExceptFunding = identityVerified && marketDataReady && accountReadsReady && chainReadReady && localOrderBuilt && localOrderSigned
    return {
      venueId: 'PREDICT_FUN', checkedAt: Date.now(), safeMode: true, orderSubmissionBlocked: true,
      identityVerified, marketDataReady, accountReadsReady, localOrderBuilt, localOrderSigned,
      fundingReady, approvalsReady, collateralBalance, nativeBalance, openOrderCount, positionCount,
      marketId: candidate?.marketId, outcomeId: candidate?.outcomeId, orderHash, requestCount, readyExceptFunding,
      message: readyExceptFunding
        ? fundingReady && approvalsReady
          ? '非下单链路全部通过；真实提交仍被代码硬性禁止'
          : '非下单链路已通过；目前只缺资金/授权和最后的小额真实提交验证'
        : '非下单联调仍有阻塞项，请查看下面的阶段结果',
      stages: record.stages
    }
  }
}
