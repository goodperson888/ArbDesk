import { describe, expect, it, vi } from 'vitest'
import type { GateCredentialStore } from './gate-credential-store'
import type { GateMarketData } from './gate-market-data'
import { GatePreparationService, assertGatePreparationRequestAllowed, gateV4Headers } from './gate-preparation'

describe('Gate preparation safety', () => {
  it('allows only the documented read-only balance endpoint', () => {
    expect(() => assertGatePreparationRequestAllowed('GET', 'https://api.gateio.ws/api/v4/spot/accounts')).not.toThrow()
    expect(() => assertGatePreparationRequestAllowed('POST', 'https://api.gateio.ws/api/v4/spot/orders')).toThrow('安全联调禁止请求')
    expect(() => assertGatePreparationRequestAllowed('DELETE', 'https://api.gateio.ws/api/v4/spot/orders/1')).toThrow('安全联调禁止请求')
    expect(() => assertGatePreparationRequestAllowed('GET', 'https://example.com/api/v4/spot/accounts')).toThrow('安全联调禁止访问')
  })

  it('generates APIv4 HMAC headers without exposing the secret', () => {
    vi.setSystemTime(new Date('2026-08-22T01:00:00.000Z'))
    const headers = gateV4Headers({ apiKey: 'test-key', apiSecret: 'test-secret' }, 'GET', '/api/v4/spot/accounts')
    expect(headers).toMatchObject({ KEY: 'test-key', Timestamp: expect.any(String), SIGN: expect.stringMatching(/^[a-f0-9]{128}$/) })
    expect(JSON.stringify(headers)).not.toContain('test-secret')
    vi.useRealTimers()
  })

  it('deduplicates preparation and never attempts an order endpoint', async () => {
    let credentialReads = 0
    const credentials = { getCredentials: async () => { credentialReads += 1; return { apiKey: 'key', apiSecret: 'secret' } } } as GateCredentialStore
    const marketData = { fetchWindows: async () => [{ marketId: 'gate-market' }], getCapturedAccountSnapshot: () => ({}) } as unknown as GateMarketData
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify([{ currency: 'USDT', available: '0', locked: '0' }]), { status: 200 }))
    const service = new GatePreparationService(credentials, marketData, fetchMock as typeof fetch)

    const [left, right] = await Promise.all([service.prepare(), service.prepare()])
    expect(left).toBe(right)
    expect(left).toMatchObject({ venueId: 'GATE', orderSubmissionBlocked: true, readyExceptFunding: true, fundingReady: false, requestCount: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.gateio.ws/api/v4/spot/accounts')
    await service.prepare()
    expect(credentialReads).toBe(1)
  })
})
