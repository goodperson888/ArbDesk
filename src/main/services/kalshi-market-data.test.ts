import { describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { KALSHI_WEBSOCKET_URL, KalshiMarketData, kalshiWebSocketOptions, parseKalshiCandidate } from './kalshi-market-data'

describe('Kalshi market normalization', () => {
  it('uses Kalshi dedicated websocket host for the native authenticated stream', () => {
    expect(KALSHI_WEBSOCKET_URL).toBe('wss://external-api-ws.kalshi.com/trade-api/ws/v2')
  })

  it('passes the configured HTTP proxy to the native websocket instead of bypassing it', () => {
    const agent = new HttpsProxyAgent('http://127.0.0.1:7890')
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(kalshiWebSocketOptions({ apiKeyId: 'key', privateKeyPem }, agent)).toMatchObject({ agent })
    agent.destroy()
  })

  it('accepts only the live BTC 15m directional binary market', () => {
    expect(parseKalshiCandidate({
      ticker: 'KXBTC-26AUG221230-5M-UP', market_type: 'binary', status: 'open',
      title: 'Bitcoin up or down in 5 minutes?',
      open_time: '2026-08-22T04:00:00.000Z', close_time: '2026-08-22T04:05:00.000Z'
    })).toBeUndefined()
    expect(parseKalshiCandidate({
      ticker: 'KXBTC15M-26AUG221230-30', market_type: 'binary', status: 'open',
      title: 'Bitcoin up or down in 15 minutes?',
      open_time: '2026-08-22T04:00:00.000Z', close_time: '2026-08-22T04:15:00.000Z'
    })).toMatchObject({ durationMinutes: 15, yesDirection: 'UP' })
    expect(parseKalshiCandidate({
      ticker: 'KXBTC-DAILY', market_type: 'binary', status: 'open', title: 'Bitcoin daily close above target?',
      open_time: '2026-08-22T04:00:00.000Z', close_time: '2026-08-23T04:00:00.000Z'
    })).toBeUndefined()
  })

  it('rejects ambiguous BTC threshold markets without a directional rule', () => {
    expect(parseKalshiCandidate({
      ticker: 'KXBTC-5M', market_type: 'binary', status: 'open', title: 'Bitcoin price in 5 minutes',
      open_time: '2026-08-22T04:00:00.000Z', close_time: '2026-08-22T04:05:00.000Z'
    })).toBeUndefined()
  })

  it('accepts the live KXBTC15M series shape even when the API omits a title', () => {
    const candidate = parseKalshiCandidate({
      ticker: 'KXBTC15M-26AUG230330-30', market_type: 'binary', status: 'active',
      open_time: '2026-08-23T03:15:00.000Z', close_time: '2026-08-23T03:30:00.000Z'
    })
    expect(candidate).toMatchObject({ durationMinutes: 15, yesDirection: 'UP' })
  })

  it('keeps an unchanged quote fresh while the Kalshi page WebSocket remains active', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T04:50:00.000Z'))
    const source = new KalshiMarketData()
    source.ingest(JSON.stringify({
      ticker: 'KXBTC15M-26AUG250450-30', market_ticker: 'KXBTC15M-26AUG250450-30', market_type: 'binary', status: 'open',
      title: 'Bitcoin up or down in 15 minutes?',
      open_time: '2026-08-25T04:45:00.000Z', close_time: '2026-08-25T05:00:00.000Z',
      yes_ask_dollars: '0.40', yes_ask_size_fp: '10', no_ask_dollars: '0.60', no_ask_size_fp: '11'
    }), Date.now(), 'REST')
    const originalReceivedAt = source.getLatestWindows()[0].outcomes.UP!.receivedAt
    vi.advanceTimersByTime(23_000)
    source.ingest(JSON.stringify({ type: 'heartbeat' }), Date.now(), 'WebSocket')

    expect(source.getLatestWindows()[0].outcomes.UP).toMatchObject({ receivedAt: originalReceivedAt, observedAt: Date.now() })
    vi.useRealTimers()
  })

  it('keeps an unchanged quote fresh when the authenticated stream sends a control ping', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T04:50:00.000Z'))
    const source = new KalshiMarketData()
    source.ingest(JSON.stringify({
      ticker: 'KXBTC15M-26AUG250450-30', market_ticker: 'KXBTC15M-26AUG250450-30', market_type: 'binary', status: 'open',
      title: 'Bitcoin up or down in 15 minutes?',
      open_time: '2026-08-25T04:45:00.000Z', close_time: '2026-08-25T05:00:00.000Z',
      yes_ask_dollars: '0.40', yes_ask_size_fp: '10', no_ask_dollars: '0.60', no_ask_size_fp: '11'
    }), Date.now(), 'REST')
    const originalReceivedAt = source.getLatestWindows()[0].outcomes.UP!.receivedAt
    vi.advanceTimersByTime(23_000)
    source.observeStreamActivity(Date.now())

    expect(source.getLatestWindows()[0].outcomes.UP).toMatchObject({ receivedAt: originalReceivedAt, observedAt: Date.now() })
    expect(source.getStatus().message).toContain('保活在线')
    vi.useRealTimers()
  })
})
