import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { KalshiCredentialStore } from './kalshi-credential-store'
import type { KalshiMarketData } from './kalshi-market-data'
import { KalshiTradingService, assertKalshiTradingRequestAllowed } from './kalshi-trading'
import type { PlaceKalshiOrderRequest, RiskSettings } from '../../shared/types'

function settings(overrides: Partial<RiskSettings> = {}): RiskSettings {
  return { mode: 'ASSISTED', kalshiLiveEnabled: true, maxCapitalPerTrade: '100', ...overrides } as RiskSettings
}

function request(overrides: Partial<PlaceKalshiOrderRequest> = {}): PlaceKalshiOrderRequest {
  return {
    ticker: 'KXBTC15M-TEST', direction: 'UP', quantity: '2.00', outcomePrice: '0.40',
    quoteReceivedAt: Date.now(), marketEndTime: Date.now() + 60_000, confirmed: true, ...overrides
  }
}

function fixture() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const credentials = { getCredentials: async () => ({ apiKeyId: 'kalshi_test_key_id', privateKeyPem }) } as KalshiCredentialStore
  const marketData = {
    getLatestWindows: () => [{
      marketId: 'KXBTC15M-TEST', endTime: Date.now() + 60_000,
      outcomes: { UP: { bestAsk: '0.40', askSize: '3', receivedAt: Date.now() }, DOWN: { bestAsk: '0.60', askSize: '3', receivedAt: Date.now() } }
    }]
  } as unknown as KalshiMarketData
  return { credentials, marketData }
}

describe('Kalshi real order guard', () => {
  it('allows only the documented V2 create-order endpoint', () => {
    expect(() => assertKalshiTradingRequestAllowed('POST', 'https://api.elections.kalshi.com/trade-api/v2/portfolio/events/orders')).not.toThrow()
    expect(() => assertKalshiTradingRequestAllowed('GET', 'https://api.elections.kalshi.com/trade-api/v2/portfolio/events/orders')).toThrow()
    expect(() => assertKalshiTradingRequestAllowed('POST', 'https://example.com/trade-api/v2/portfolio/events/orders')).toThrow()
  })

  it('submits one FOK order and maps DOWN to the YES ask at 1-price', async () => {
    const { credentials, marketData } = fixture()
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders')
      const body = JSON.parse(String(init?.body)) as Record<string, string>
      expect(body).toMatchObject({ ticker: 'KXBTC15M-TEST', side: 'ask', count: '2.00', price: '0.4000', time_in_force: 'fill_or_kill' })
      return new Response(JSON.stringify({ order_id: 'order-1', client_order_id: body.client_order_id, fill_count: '2.00', remaining_count: '0.00', ts_ms: 123 }), { status: 201 })
    })
    const service = new KalshiTradingService(credentials, marketData, () => settings(), true, fetchMock as typeof fetch)
    const receipt = await service.placeOrder(request({ direction: 'DOWN', outcomePrice: '0.60' }))
    expect(receipt).toMatchObject({ orderId: 'order-1', direction: 'DOWN', side: 'ask', status: 'EXECUTED', fillCount: '2.00' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('preflights Kalshi authentication once within the short cache window', async () => {
    const { credentials, marketData } = fixture()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ balance: 100 }), { status: 200 }))
    const service = new KalshiTradingService(credentials, marketData, () => settings(), true, fetchMock as typeof fetch)
    await service.verifyTradingAccess()
    await service.verifyTradingAccess()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 'GET' }))
  })

  it('never retries an ambiguous POST and rejects simulation/unchecked requests', async () => {
    const { credentials, marketData } = fixture()
    const fetchMock = vi.fn(async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } }) })
    const service = new KalshiTradingService(credentials, marketData, () => settings(), true, fetchMock as typeof fetch)
    await expect(service.placeOrder(request())).rejects.toThrow('结果未知')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await expect(new KalshiTradingService(credentials, marketData, () => settings({ mode: 'SIMULATION' }), true, fetchMock as typeof fetch).placeOrder(request())).rejects.toThrow('模拟模式')
    await expect(new KalshiTradingService(credentials, marketData, () => settings(), true, fetchMock as typeof fetch).placeOrder(request({ confirmed: false }))).rejects.toThrow('二次确认')
  })
})
