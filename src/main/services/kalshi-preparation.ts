import { createHash } from 'node:crypto'
import type { VenuePreparationReport, VenuePreparationStage, VenuePreparationStageStatus } from '../../shared/types'
import type { KalshiCredentialStore, KalshiCredentials } from './kalshi-credential-store'
import { kalshiHeaders, kalshiRequestSignature } from './kalshi-auth'
import type { KalshiMarketData } from './kalshi-market-data'

const API = 'https://external-api.kalshi.com/trade-api/v2'
const REQUEST_TIMEOUT_MS = 12_000
const REPORT_CACHE_MS = 15_000
const ALLOWED_API_HOSTS = new Set(['api.elections.kalshi.com', 'external-api.kalshi.com'])

type FetchLike = typeof fetch
interface BalanceResponse {
  balance?: number
  portfolio_value?: number
  balance_breakdown?: Array<{ exchange_index?: number; balance?: number | string }>
}
interface PositionsResponse { market_positions?: unknown[] }
interface OrdersResponse { orders?: unknown[] }

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
        stages.push({ id, label, status: 'BLOCKED', durationMs: Date.now() - startedAt, detail: error instanceof Error ? error.message : String(error) })
        throw error
      }
    },
    add(id, label, status, detail) { stages.push({ id, label, status, durationMs: 0, detail }) }
  }
}

function cents(value: number | undefined): string {
  return Number.isFinite(value) ? (Number(value) / 100).toFixed(2) : '0.00'
}

function requestBody(window: { marketId: string; outcomes: Record<string, { bestAsk: string; askSize: string } | undefined> }, exchangeIndex: number): string {
  const quote = window.outcomes.UP ?? window.outcomes.DOWN
  const direction = window.outcomes.UP ? 'UP' : 'DOWN'
  const count = Math.max(0.01, Math.min(1, Math.floor(Number(quote?.askSize ?? 0) * 100) / 100))
  return JSON.stringify({
    ticker: window.marketId,
    client_order_id: `arbdesk-preview-${window.marketId}`,
    side: 'bid', count: count.toFixed(2), price: quote?.bestAsk ?? '0.01',
    outcome: direction, time_in_force: 'fill_or_kill', exchange_index: exchangeIndex
  })
}

export function assertKalshiPreparationRequestAllowed(method: string, rawUrl: string): void {
  const url = new URL(rawUrl)
  const normalizedMethod = method.toUpperCase()
  if (url.protocol !== 'https:' || !ALLOWED_API_HOSTS.has(url.hostname)) throw new Error(`KALSHI 安全联调禁止访问 ${url.origin}`)
  if (normalizedMethod !== 'GET') throw new Error(`KALSHI 安全联调禁止请求 ${normalizedMethod} ${url.pathname}；真实订单与资金操作已禁用`)
  const allowed = ['/trade-api/v2/portfolio/balance', '/trade-api/v2/portfolio/positions', '/trade-api/v2/portfolio/orders']
  if (!allowed.includes(url.pathname)) throw new Error(`KALSHI 安全联调禁止读取 ${url.pathname}`)
}

async function signedGet<T>(fetchImpl: FetchLike, credentials: KalshiCredentials, path: string): Promise<T> {
  const url = `${API}${path}`
  assertKalshiPreparationRequestAllowed('GET', url)
  try {
    const response = await fetchImpl(url, { method: 'GET', headers: kalshiHeaders(credentials, 'GET', path), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    const responseBody = await response.text()
    if (!response.ok) {
      let detail = ''
      try {
        const parsed = JSON.parse(responseBody) as { code?: string; message?: string; error?: { code?: string; message?: string } }
        const source = parsed.error ?? parsed
        detail = [source.code, source.message].filter(Boolean).join(' · ')
      } catch {
        detail = responseBody.replace(/\s+/g, ' ').trim().slice(0, 240)
      }
      throw new Error(`Kalshi GET ${path} HTTP ${response.status}${detail ? ` · ${detail}` : ''}`)
    }
    return JSON.parse(responseBody) as T
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    const message = error instanceof Error ? error.message : String(error)
    if (name === 'AbortError' || name === 'TimeoutError' || /aborted|timeout/i.test(message)) {
      const pathname = path.split('?')[0]
      throw new Error(`Kalshi GET ${pathname} 连接超时（${REQUEST_TIMEOUT_MS / 1_000} 秒）；未自动重试`)
    }
    if (/fetch failed/i.test(message)) {
      const cause = (error as { cause?: { code?: string; message?: string } }).cause
      const reason = cause?.code ?? cause?.message ?? '网络层未返回 HTTP 响应'
      const pathname = path.split('?')[0]
      throw new Error(`Kalshi GET ${pathname} 网络连接失败（${reason}）；请检查 Kalshi 域名可达性或应用代理；未自动重试`)
    }
    throw error
  }
}

interface CachedReport { value: VenuePreparationReport; cachedAt: number }

export class KalshiPreparationService {
  private inFlight?: Promise<VenuePreparationReport>
  private cached?: CachedReport

  constructor(
    private readonly credentials: KalshiCredentialStore,
    private readonly marketData: KalshiMarketData,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async prepare(): Promise<VenuePreparationReport> {
    if (this.cached && Date.now() - this.cached.cachedAt < REPORT_CACHE_MS) return this.cached.value
    if (this.inFlight) return await this.inFlight
    this.inFlight = this.run()
    try {
      const value = await this.inFlight
      this.cached = { value, cachedAt: Date.now() }
      return value
    } finally { this.inFlight = undefined }
  }

  credentialsChanged(): void { this.cached = undefined }

  private async run(): Promise<VenuePreparationReport> {
    const record = recorder()
    let requestCount = 0
    let identityVerified = false
    let marketDataReady = false
    let accountReadsReady = false
    let fundingReady = false
    let localOrderBuilt = false
    let localOrderSigned = false
    let collateralBalance: string | undefined
    let positionCount: number | undefined
    let openOrderCount: number | undefined
    let marketId: string | undefined
    let orderHash: string | undefined

    try {
      const credentials = await record.run('identity-local', '读取加密 Kalshi 身份', () => this.credentials.getCredentials(),
        (value) => `API Key ${value.apiKeyId.slice(0, 4)}…${value.apiKeyId.slice(-4)}`)
      const balance = await record.run('account-balance', '签名读取 Kalshi 账户余额', async () => {
        requestCount += 1
        return await signedGet<BalanceResponse>(this.fetchImpl, credentials, '/portfolio/balance')
      }, (value) => `可用余额 ${cents(value.balance)} USD · 组合价值 ${cents(value.portfolio_value)} USD`, (value) => Number(value.balance ?? 0) > 0 ? 'PASS' : 'WARN')
      identityVerified = true
      collateralBalance = cents(balance.balance)
      fundingReady = Number(balance.balance ?? 0) > 0

      const [positions, orders] = await Promise.all([
        record.run('positions-read', '读取 Kalshi 持仓', async () => {
          requestCount += 1
          return await signedGet<PositionsResponse>(this.fetchImpl, credentials, '/portfolio/positions?count_filter=position')
        }, (value) => `持仓 ${value.market_positions?.length ?? 0} 个市场`),
        record.run('orders-read', '读取 Kalshi 活动委托', async () => {
          requestCount += 1
          return await signedGet<OrdersResponse>(this.fetchImpl, credentials, '/portfolio/orders?status=resting&limit=100')
        }, (value) => `活动委托 ${value.orders?.length ?? 0} 个`)
      ])
      positionCount = positions.market_positions?.length ?? 0
      openOrderCount = orders.orders?.length ?? 0
      accountReadsReady = true

      const windows = await record.run('market-refresh', '刷新 Kalshi BTC 15m 市场与盘口', () => this.marketData.fetchWindows(),
        (value) => `${value.length} 个双向盘口 · 公共 API 只读`, (value) => value.length > 0 ? 'PASS' : 'WARN')
      if (!windows.length) throw new Error('当前没有可用于联调的 Kalshi BTC 15m 市场')
      marketDataReady = true
      const candidate = windows[0]
      marketId = candidate.marketId
      const exchangeIndex = this.marketData.getExchangeIndex(marketId)
      if (exchangeIndex === undefined) throw new Error('Kalshi 当前市场缺少 exchange_index；请刷新市场后重试完整联调')

      const shardBalance = balance.balance_breakdown?.find((item) => Number(item.exchange_index) === exchangeIndex)
      const shardBalanceValue = Number(shardBalance?.balance)
      record.add(
        'exchange-shard-balance',
        '检查订单目标交易分片余额',
        shardBalance && Number.isFinite(shardBalanceValue) && shardBalanceValue > 0 ? 'PASS' : 'WARN',
        shardBalance && Number.isFinite(shardBalanceValue)
          ? `目标交易分片 ${exchangeIndex} 可用余额 ${shardBalanceValue.toFixed(4)} USD`
          : `未返回目标交易分片 ${exchangeIndex} 的余额明细；订单将按 ticker 自动路由，需在 Kalshi 账户中确认该分片已预分配资金`
      )

      const body = requestBody(candidate, exchangeIndex)
      await record.run('offline-order-build', '本地构造 Kalshi 订单草稿', async () => body,
        () => `仅内存构造 ${marketId} 订单草稿（exchange_index ${exchangeIndex}）；未提交`)
      localOrderBuilt = true
      await record.run('offline-order-sign', '本地签名 Kalshi 订单草稿', async () => {
        const timestamp = String(Date.now())
        const signature = kalshiRequestSignature(credentials.privateKeyPem, timestamp, 'POST', '/trade-api/v2/portfolio/events/orders')
        return { signature, body }
      }, (value) => `RSA-PSS 签名已生成 ${createHash('sha256').update(value.signature).digest('hex').slice(0, 12)}…；未发送 POST`)
      localOrderSigned = true
      orderHash = createHash('sha256').update(`${marketId}|${body}`).digest('hex')
      record.add('payment-guard', '充值/支付与真实订单硬禁令', 'PASS', '仅允许账户 GET；POST /portfolio/events/orders、撤单、充值、提现和划转均未实现且请求前拒绝')
    } catch (error) {
      record.add('payment-guard', '充值/支付与真实订单硬禁令', 'PASS', '联调失败也不会回退到真实订单、充值、提现或资金划转')
      if (record.stages.length === 1) record.add('next-step', '非下单联调', 'BLOCKED', error instanceof Error ? error.message : String(error))
    }

    const readyExceptFunding = identityVerified && marketDataReady && accountReadsReady
    return {
      venueId: 'KALSHI', checkedAt: Date.now(), safeMode: true, orderSubmissionBlocked: true,
      identityVerified, marketDataReady, accountReadsReady, localOrderBuilt, localOrderSigned,
      fundingReady, approvalsReady: true, collateralBalance, openOrderCount, positionCount, marketId, orderHash,
      requestCount, readyExceptFunding,
      message: readyExceptFunding
        ? fundingReady ? 'Kalshi 身份、余额、持仓、委托和盘口联调通过；真实订单与支付仍被硬性禁止' : 'Kalshi 非下单联调通过，但当前账户余额为 0'
        : 'Kalshi 非下单联调仍有阻塞项，请查看阶段结果',
      stages: record.stages
    }
  }
}
