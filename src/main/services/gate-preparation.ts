import { createHash, createHmac } from 'node:crypto'
import type { VenuePreparationReport, VenuePreparationStage, VenuePreparationStageStatus } from '../../shared/types'
import type { GateCredentialStore, GateCredentials } from './gate-credential-store'
import type { GateMarketData } from './gate-market-data'
import type { GateOrderCapture } from './gate-order-capture'

const GATE_API_BASE = 'https://api.gateio.ws'
const REQUEST_TIMEOUT_MS = 6_000
const REPORT_CACHE_MS = 15_000

type FetchLike = typeof fetch

interface GateSpotAccount {
  currency?: string
  available?: string
  locked?: string
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
        stages.push({ id, label, status: 'BLOCKED', durationMs: Date.now() - startedAt, detail: error instanceof Error ? error.message : String(error) })
        throw error
      }
    },
    add(id, label, status, detail) { stages.push({ id, label, status, durationMs: 0, detail }) }
  }
}

export function assertGatePreparationRequestAllowed(method: string, rawUrl: string): void {
  const url = new URL(rawUrl)
  const normalizedMethod = method.toUpperCase()
  if (url.protocol !== 'https:' || url.hostname !== 'api.gateio.ws') throw new Error(`GATE 安全联调禁止访问 ${url.origin}`)
  if (normalizedMethod !== 'GET' || url.pathname !== '/api/v4/spot/accounts') {
    throw new Error(`GATE 安全联调禁止请求 ${normalizedMethod} ${url.pathname}`)
  }
}

export function gateV4Headers(credentials: GateCredentials, method: 'GET', path: string, query = ''): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1_000))
  const bodyHash = createHash('sha512').update('').digest('hex')
  const signatureString = `${method}\n${path}\n${query}\n${bodyHash}\n${timestamp}`
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': 'ArbDesk/0.1',
    KEY: credentials.apiKey,
    Timestamp: timestamp,
    SIGN: createHmac('sha512', credentials.apiSecret).update(signatureString).digest('hex')
  }
}

interface CachedReport { value: VenuePreparationReport; cachedAt: number }

export class GatePreparationService {
  private inFlight?: Promise<VenuePreparationReport>
  private cached?: CachedReport

  constructor(
    private readonly credentials: GateCredentialStore,
    private readonly marketData: GateMarketData,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly orderCapture?: GateOrderCapture
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

  credentialsChanged(): void { this.cached = undefined }

  private async run(): Promise<VenuePreparationReport> {
    const record = recorder()
    let requestCount = 0
    let identityVerified = false
    let marketDataReady = false
    let accountReadsReady = false
    let fundingReady = false
    let collateralBalance: string | undefined
    let marketId: string | undefined
    let openOrderCount: number | undefined
    let positionCount: number | undefined

    try {
      const credentials = await record.run('identity-local', '读取加密 Gate APIv4 身份', () => this.credentials.getCredentials(),
        (value) => `API Key ${value.apiKey.slice(0, 4)}…${value.apiKey.slice(-4)}`)

      const accounts = await record.run('account-read', '签名读取 Gate 现货账户与 USDT 余额', async () => {
        const path = '/api/v4/spot/accounts'
        const url = `${GATE_API_BASE}${path}`
        assertGatePreparationRequestAllowed('GET', url)
        requestCount += 1
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: gateV4Headers(credentials, 'GET', path),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        })
        if (!response.ok) throw new Error(`Gate APIv4 身份验证失败：HTTP ${response.status}`)
        const value = await response.json() as GateSpotAccount[]
        if (!Array.isArray(value)) throw new Error('Gate 账户响应格式无效')
        return value
      }, (value) => {
        const usdt = value.find((account) => account.currency?.toUpperCase() === 'USDT')
        return `账户身份通过 · USDT 可用 ${usdt?.available ?? '0'} · 锁定 ${usdt?.locked ?? '0'}`
      }, (value) => Number(value.find((account) => account.currency?.toUpperCase() === 'USDT')?.available ?? 0) > 0 ? 'PASS' : 'WARN')
      identityVerified = true
      accountReadsReady = true
      const usdt = accounts.find((account) => account.currency?.toUpperCase() === 'USDT')
      collateralBalance = usdt?.available ?? '0'
      fundingReady = Number(collateralBalance) > 0

      const windows = await record.run('market-page', '验证 Gate 事件合约单页面与双向盘口', () => this.marketData.fetchWindows(),
        (value) => `${value.length} 个 BTC 5m/15m 双向盘口 · 网页自身流量`,
        (value) => value.length > 0 ? 'PASS' : 'BLOCKED')
      if (!windows.length) throw new Error('Gate 页面尚未捕获到完整双向盘口；请打开 Gate 单页面检查网络/登录后等待行情出现')
      marketDataReady = true
      marketId = windows[0].marketId

      const capturedAccount = this.marketData.getCapturedAccountSnapshot()
      openOrderCount = capturedAccount.openOrderCount
      positionCount = capturedAccount.positionCount
      record.add('event-account-scope', '事件合约持仓与委托只读数据', openOrderCount !== undefined || positionCount !== undefined ? 'PASS' : 'SKIPPED',
        openOrderCount !== undefined || positionCount !== undefined
          ? `来自已登录 Gate 单页面自身响应 · 持仓 ${positionCount ?? '—'} · 活动委托 ${openOrderCount ?? '—'} · 未额外请求`
          : 'Gate 公开 APIv4 尚未发布事件合约专用账户端点；页面当前也未产生账户响应，没有用现货委托冒充事件委托')
      const captureSummary = this.orderCapture?.getSummary()
      record.add('order-capture', 'Gate 事件合约订单结构捕获', captureSummary?.captured ? 'PASS' : 'SKIPPED',
        captureSummary?.captured ? `已捕获 ${captureSummary.method ?? '订单'} 结构 · ${captureSummary.requestFields?.join(', ') ?? '字段待识别'} · 未保存 Cookie、签名和完整请求体` : '尚未捕获；请在已登录指纹浏览器中开启捕获模式并手动完成一次最小订单')
      record.add('offline-order', '事件合约离线构单', 'SKIPPED', '真实下单不在本阶段；未猜测未公开订单结构，也未生成可能被误提交的载荷')
      record.add('submission-guard', '真实订单提交硬禁令', 'PASS', '仅允许 GET /api/v4/spot/accounts；POST、PUT、PATCH、DELETE 与所有订单路径均在请求前拒绝')
    } catch {
      record.add('submission-guard', '真实订单提交硬禁令', 'PASS', '联调失败也不会回退到现货或事件合约下单、撤单和资金划转')
    }

    const readyExceptFunding = identityVerified && marketDataReady && accountReadsReady
    return {
      venueId: 'GATE', checkedAt: Date.now(), safeMode: true, orderSubmissionBlocked: true,
      identityVerified, marketDataReady, accountReadsReady, localOrderBuilt: false, localOrderSigned: false,
      fundingReady, approvalsReady: true, collateralBalance, openOrderCount, positionCount,
      marketId, requestCount, readyExceptFunding,
      message: readyExceptFunding
        ? fundingReady
          ? 'Gate 公开盘口、API 身份和 USDT 账户读取通过；事件合约真实提交仍被硬性禁止'
          : 'Gate 非下单链路已通过；当前仅无 USDT 余额，事件合约真实提交仍被硬性禁止'
        : 'Gate 非下单联调仍有阻塞项，请查看阶段结果',
      stages: record.stages
    }
  }
}
