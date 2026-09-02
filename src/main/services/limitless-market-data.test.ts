import { afterEach, describe, expect, it, vi } from 'vitest'
import { io, type Socket } from 'socket.io-client'
import { LimitlessMarketData } from './limitless-market-data'

class FakeLimitlessSocket {
  connected = false
  handlers = new Map<string, Array<(...args: never[]) => void>>()
  emit = vi.fn()
  close = vi.fn()

  on(event: string, handler: (...args: never[]) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    return this
  }

  trigger(event: string, payload?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload as never)
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('LimitlessMarketData', () => {
  it('normalizes YES book and derives NO asks without duplicate refresh requests', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T11:32:00.000Z'))
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/markets/active')) return new Response(JSON.stringify({ data: [{
        slug: 'btc-up-or-down-5-min-1787311800', startAt: '2026-08-21T11:30:00.000Z', expirationTimestamp: Date.parse('2026-08-21T11:35:00.000Z'),
        tradeType: 'clob', automationType: 'lumy', tokens: { yes: 'yes-token', no: 'no-token' },
        metadata: { minutesDeadline: 5, openPrice: '80400', chainlinkDataStream: { pair: 'BTC/USD', feedId: 'feed', toleranceSeconds: 5 } },
        priceOracleMetadata: { ticker: 'BTC', chainlinkFeedId: 'feed', chainlinkPair: 'BTC/USD' }
      }] }), { status: 200 })
      return new Response(JSON.stringify({
        asks: [{ price: 0.61, size: 20_000_000 }], bids: [{ price: 0.55, size: 30_000_000 }], tokenId: 'yes-token'
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const source = new LimitlessMarketData({ enableStreaming: false })

    const [first, second] = await Promise.all([source.fetchWindows(), source.fetchWindows()])

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(second).toBe(first)
    expect(first[0]).toMatchObject({ venueId: 'LIMITLESS', durationMinutes: 5, feeVerified: false })
    expect(first[0].outcomes.UP).toMatchObject({ bestAsk: '0.61', askSize: '20' })
    expect(first[0].outcomes.DOWN).toMatchObject({ bestAsk: '0.45', askSize: '30' })
    expect(first[0].resolution).toMatchObject({ comparisonOperator: 'GTE', tieOutcome: 'UP', baselineValue: '80400' })

    await source.fetchWindows()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses one websocket subscription and reduces REST books to a 30 second audit', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T11:32:00.000Z'))
    let activeMarkets = [{
      slug: 'btc-5m', startAt: '2026-08-21T11:30:00.000Z', expirationTimestamp: Date.parse('2026-08-21T11:35:00.000Z'),
      tradeType: 'clob', automationType: 'lumy', tokens: { yes: 'yes', no: 'no' },
      metadata: { minutesDeadline: 5, openPrice: '80400', chainlinkDataStream: { pair: 'BTC/USD', feedId: 'feed' } },
      priceOracleMetadata: { ticker: 'BTC' }
    }]
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/markets/active')) return new Response(JSON.stringify({ data: activeMarkets }), { status: 200 })
      return new Response(JSON.stringify({ asks: [{ price: 0.6, size: 10_000_000 }], bids: [{ price: 0.5, size: 12_000_000 }] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const socket = new FakeLimitlessSocket()
    const socketFactory = vi.fn((_url: string, _options: Parameters<typeof io>[1]) => socket as unknown as Socket)
    const tokenSecret = Buffer.from('test-secret-at-least-32-bytes-long').toString('base64')
    const source = new LimitlessMarketData({ hmacCredentialsProvider: async () => ({ tokenId: 'lmts_token', tokenSecret }), socketFactory })
    const listener = vi.fn()
    source.onMarketData(listener)

    await source.fetchWindows()
    expect(socketFactory.mock.calls[0][1]?.extraHeaders).toMatchObject({
      'lmts-api-key': 'lmts_token',
      'lmts-timestamp': expect.any(String),
      'lmts-signature': expect.any(String)
    })
    socket.connected = true
    socket.trigger('connect')
    expect(socket.emit).toHaveBeenCalledWith('subscribe_market_prices', { marketSlugs: ['btc-5m'] })
    expect(socket.emit).toHaveBeenCalledWith('subscribe_market_lifecycle')

    socket.trigger('orderbookUpdate', {
      marketSlug: 'btc-5m', orderbook: { asks: [{ price: 0.58, size: 20_000_000 }], bids: [{ price: 0.56, size: 30_000_000 }] }
    })
    expect(source.getLatestWindows()[0].outcomes.UP?.bestAsk).toBe('0.58')
    expect(listener).toHaveBeenCalled()

    socket.trigger('oraclePriceData', { marketSlug: 'btc-5m', value: 80435.42, timestamp: Date.now() })
    expect(source.getLatestWindows()[0].settlementObservation).toEqual({
      baselineValue: '80400', currentValue: '80435.42', observedAt: Date.now()
    })

    activeMarkets = []
    vi.advanceTimersByTime(16_000)
    await source.fetchWindows()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/orderbook'))).toHaveLength(1)
    expect(socket.emit).toHaveBeenCalledWith('subscribe_market_prices', { marketSlugs: [] })
  })
})
