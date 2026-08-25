import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { KalshiCredentialStore } from './kalshi-credential-store'
import type { KalshiMarketData } from './kalshi-market-data'
import { KalshiTradingService, assertKalshiTradingRequestAllowed } from './kalshi-trading'
import type { PlaceKalshiOrderRequest, RiskSettings } from '../../shared/types'

function settings(overrides: Partial<RiskSettings> = {}): RiskSettings {
  return { mode: 'ASSISTED', kalshiLiveEnabled: true, maxCapitalPerTrade: '100', maxHedgeSlippage: '0.0300', ...overrides } as RiskSettings
}

function request(overrides: Partial<PlaceKalshiOrderRequest> = {}): PlaceKalshiOrderRequest {
  return {
    ticker: 'KXBTC15M-TEST', direction: 'UP', quantity: '2.00', outcomePrice: '0.40',
    quoteReceivedAt: Date.now(), marketEndTime: Date.now() + 60_000, confirmed: true, ...overrides
  }
}

function fixture(currentUp = '0.40') {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const credentials = { getCredentials: async () => ({ apiKeyId: 'kalshi_test_key_id', privateKeyPem }) } as KalshiCredentialStore
  const marketData = {
    getExchangeIndex: () => 2,
    getLatestWindows: () => [{
      marketId: 'KXBTC15M-TEST', endTime: Date.now() + 60_000,
      outcomes: { UP: { bestAsk: currentUp, askSize: '3', receivedAt: Date.now() }, DOWN: { bestAsk: '0.60', askSize: '3', receivedAt: Date.now() } }
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
      expect(body).toMatchObject({
        ticker: 'KXBTC15M-TEST', side: 'ask', count: '2.00', price: '0.4000',
        time_in_force: 'fill_or_kill', exchange_index: 2
      })
      expect(body).not.toHaveProperty('subaccount')
      return new Response(JSON.stringify({ order_id: 'order-1', client_order_id: body.client_order_id, fill_count: '2.00', remaining_count: '0.00', ts_ms: 123 }), { status: 201 })
    })
    const service = new KalshiTradingService(credentials, marketData, () => settings(), true, fetchMock as typeof fetch)
    const receipt = await service.placeOrder(request({ direction: 'DOWN', outcomePrice: '0.60' }))
    expect(receipt).toMatchObject({ orderId: 'order-1', direction: 'DOWN', side: 'ask', status: 'EXECUTED', fillCount: '2.00' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reprices to the current Kalshi ask when it moves within configured hedge slippage', async () => {
    const { credentials, marketData } = fixture('0.0620')
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body).toMatchObject({ ticker: 'KXBTC15M-TEST', side: 'bid', price: '0.0620', exchange_index: 2 })
      return new Response(JSON.stringify({ order_id: 'order-tolerated', client_order_id: body.client_order_id, fill_count: '2.00', remaining_count: '0.00' }), { status: 201 })
    })
    const service = new KalshiTradingService(credentials, marketData, () => settings(), true, fetchMock as typeof fetch)

    await expect(service.placeOrder(request({ outcomePrice: '0.0320' }))).resolves.toMatchObject({ orderId: 'order-tolerated', outcomePrice: '0.0620' })
  })

  it('still rejects a Kalshi ask beyond the configured hedge slippage', async () => {
    const { credentials, marketData } = fixture('0.0630')
    const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
    const service = new KalshiTradingService(credentials, marketData, () => settings(), true, fetchMock as typeof fetch)

    await expect(service.placeOrder(request({ outcomePrice: '0.0320' }))).rejects.toThrow('最高接受价 0.0620')
    expect(fetchMock).not.toHaveBeenCalled()
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

  it('surfaces Kalshi nested API errors instead of hiding them behind the HTTP status', async () => {
    const { credentials, marketData } = fixture()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'market_not_found', message: 'market not found on exchange index' }
    }), { status: 404 }))
    const service = new KalshiTradingService(credentials, marketData, () => settings(), true, fetchMock as typeof fetch)

    await expect(service.placeOrder(request())).rejects.toThrow('market_not_found · market not found on exchange index')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('explains a Kalshi user_not_found as an environment or credential identity mismatch', async () => {
    const { credentials, marketData } = fixture()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'user_not_found', details: '_d313aac4-936e-443f-93ec-d984b174a844', message: 'user not found: d313aac4-936e-443f-93ec-d984b174a844' }
    }), { status: 404 }))
    const service = new KalshiTradingService(credentials, marketData, () => settings(), true, fetchMock as typeof fetch)

    await expect(service.placeOrder(request())).rejects.toThrow('生产/Demo 环境或 API Key ID 与 RSA 私钥不匹配')
  })
})
