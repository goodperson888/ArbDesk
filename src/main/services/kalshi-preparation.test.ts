import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { KalshiCredentialStore } from './kalshi-credential-store'
import type { KalshiMarketData } from './kalshi-market-data'
import { KalshiPreparationService, assertKalshiPreparationRequestAllowed } from './kalshi-preparation'

describe('Kalshi preparation safety', () => {
  it('allows only signed read endpoints and rejects payment/order paths', () => {
    expect(() => assertKalshiPreparationRequestAllowed('GET', 'https://api.elections.kalshi.com/trade-api/v2/portfolio/balance')).not.toThrow()
    expect(() => assertKalshiPreparationRequestAllowed('GET', 'https://external-api.kalshi.com/trade-api/v2/portfolio/balance')).not.toThrow()
    expect(() => assertKalshiPreparationRequestAllowed('GET', 'https://example.com/trade-api/v2/portfolio/balance')).toThrow('安全联调禁止访问')
    expect(() => assertKalshiPreparationRequestAllowed('GET', 'https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders')).toThrow('安全联调禁止读取')
    expect(() => assertKalshiPreparationRequestAllowed('POST', 'https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders')).toThrow('安全联调禁止请求')
  })

  it('classifies account timeouts without retrying the signed balance read', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const credentials = { getCredentials: async () => ({ apiKeyId: 'kalshi_test_key_id', privateKeyPem }) } as KalshiCredentialStore
    const marketData = { fetchWindows: vi.fn() } as unknown as KalshiMarketData
    const timeoutError = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    const fetchMock = vi.fn(async () => { throw timeoutError })
    const service = new KalshiPreparationService(credentials, marketData, fetchMock as typeof fetch)

    const report = await service.prepare()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(marketData.fetchWindows).not.toHaveBeenCalled()
    expect(report.requestCount).toBe(1)
    expect(report.stages.find((stage) => stage.id === 'account-balance')).toMatchObject({
      status: 'BLOCKED',
      detail: 'Kalshi GET /portfolio/balance 连接超时（12 秒）；未自动重试'
    })
  })

  it('exposes the network cause for a fetch failure without retrying', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const credentials = { getCredentials: async () => ({ apiKeyId: 'kalshi_test_key_id', privateKeyPem }) } as KalshiCredentialStore
    const marketData = { fetchWindows: vi.fn() } as unknown as KalshiMarketData
    const fetchError = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    const fetchMock = vi.fn(async () => { throw fetchError })
    const service = new KalshiPreparationService(credentials, marketData, fetchMock as typeof fetch)

    const report = await service.prepare()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(report.stages.find((stage) => stage.id === 'account-balance')?.detail).toContain('ENOTFOUND')
    expect(report.stages.find((stage) => stage.id === 'account-balance')?.detail).toContain('未自动重试')
  })

  it('deduplicates read-only preparation and never submits an order', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const credentials = { getCredentials: async () => ({ apiKeyId: 'kalshi_test_key_id', privateKeyPem }) } as KalshiCredentialStore
    const marketData = { fetchWindows: async () => [{ marketId: 'KXBTC-5M', outcomes: { UP: { bestAsk: '0.40', askSize: '2' } } }] } as unknown as KalshiMarketData
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/balance')) return new Response(JSON.stringify({ balance: 0, portfolio_value: 0 }), { status: 200 })
      if (path.endsWith('/positions')) return new Response(JSON.stringify({ market_positions: [] }), { status: 200 })
      return new Response(JSON.stringify({ orders: [] }), { status: 200 })
    })
    const service = new KalshiPreparationService(credentials, marketData, fetchMock as typeof fetch)
    const [left, right] = await Promise.all([service.prepare(), service.prepare()])
    expect(left).toBe(right)
    expect(left).toMatchObject({ venueId: 'KALSHI', orderSubmissionBlocked: true, readyExceptFunding: true, fundingReady: false, localOrderBuilt: true, localOrderSigned: true, requestCount: 3 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/events/orders'))).toBe(false)
  })
})
