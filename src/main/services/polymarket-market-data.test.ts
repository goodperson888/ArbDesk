import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyPolymarketStreamEvent, parsePolymarketTwapEvent, PolymarketMarketData, type PolymarketWindowQuote } from './polymarket-market-data'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

class FakeSocket {
  readyState = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly sent: string[] = []
  private listeners = new Map<string, Array<(event: { data?: unknown }) => void>>()

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(data: string): void {
    this.sent.push(data)
  }

  open(): void {
    this.readyState = this.OPEN
    this.emit('open')
  }

  message(data: string): void {
    this.emit('message', { data })
  }

  close(): void {
    this.readyState = 3
    this.emit('close')
  }

  private emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

describe('PolymarketMarketData', () => {
  it('parses the exact E18 Chainlink 60-second BTC TWAP and rejects unrelated updates', () => {
    const quote = parsePolymarketTwapEvent(JSON.stringify({
      topic: 'crypto_prices_twap_sixty', type: 'update',
      payload: {
        symbol: 'btc/usd', value: 60_010, full_accuracy_value: '60010123456789000000000',
        timestamp: 1_800_000_123_000, window_s: 60
      }
    }), 1_800_000_123_050)

    expect(quote).toEqual({
      value: '60010.123456789', observedAt: 1_800_000_123_000,
      receivedAt: 1_800_000_123_050, windowSeconds: 60
    })
    expect(parsePolymarketTwapEvent(JSON.stringify({
      type: 'update', payload: { symbol: 'eth/usd', value: 2_000, timestamp: 1_800_000_123_000, window_s: 60 }
    }))).toBeUndefined()
  })

  it('uses one deduplicated RTDS socket for 5m/15m, updates memory, heartbeats, and reconnects without disk writes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_123_000)
    const sockets: Array<{ url: string; socket: FakeSocket }> = []
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      requested.push(url)
      if (url.includes('gamma-api')) return Response.json({ markets: [{
        conditionId: `condition-${url.includes('15m') ? '15' : '5'}`, active: true, closed: false,
        outcomes: '["Up","Down"]', clobTokenIds: `["up-${url.includes('15m') ? '15' : '5'}","down-${url.includes('15m') ? '15' : '5'}"]`
      }] })
      if (url.includes('/clob-markets/')) return Response.json({ fd: { r: 0.07, e: 1 } })
      if (url.includes('/book?')) return Response.json({ asks: [{ price: '0.5', size: '10' }] })
      if (url.includes('/api/crypto/crypto-price?')) {
        return Response.json({ openPrice: 60_000, closePrice: 60_005, timestamp: 1_800_000_122 })
      }
      return Response.json([])
    }))
    const service = new PolymarketMarketData({
      webSocketFactory: (url) => {
        const socket = new FakeSocket()
        sockets.push({ url, socket })
        return socket
      }
    })
    const windows = [
      { durationMinutes: 5 as const, startTime: 1_800_000_000_000, endTime: 1_800_000_300_000 },
      { durationMinutes: 15 as const, startTime: 1_800_000_000_000, endTime: 1_800_000_900_000 }
    ]

    await service.fetchWindows(windows)
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    const rtds = sockets.find(({ url }) => url === 'wss://ws-live-data.polymarket.com')!.socket
    rtds.open()
    expect(JSON.parse(rtds.sent[0])).toMatchObject({
      action: 'subscribe',
      subscriptions: [{ topic: 'crypto_prices_twap_sixty', type: 'update', filters: '{"symbol":"btc/usd"}' }]
    })
    rtds.message(JSON.stringify({
      topic: 'crypto_prices_twap_sixty', type: 'update',
      payload: { symbol: 'btc/usd', full_accuracy_value: '60010000000000000000000', timestamp: 1_800_000_123_000, window_s: 60 }
    }))
    expect(service.getLatestWindows().map((window) => window.indexPrice)).toEqual(['60010', '60010'])

    const referenceRequests = (): number => requested.filter((url) => url.includes('/api/crypto/crypto-price?')).length
    expect(referenceRequests()).toBe(2)
    await service.fetchWindows(windows)
    await vi.waitFor(() => expect(sockets.filter(({ url }) => url === 'wss://ws-live-data.polymarket.com')).toHaveLength(1))
    expect(referenceRequests()).toBe(2)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(rtds.sent).toContain('PING')
    rtds.close()
    await vi.advanceTimersByTimeAsync(1_500)
    await vi.waitFor(() => expect(sockets.filter(({ url }) => url === 'wss://ws-live-data.polymarket.com')).toHaveLength(2))
    service.configureProxy('http://127.0.0.1:7890')
  })

  it('tests Gamma and CLOB independently from MEXC market windows', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      requested.push(url)
      return Response.json(url.includes('/time') ? Math.floor(Date.now() / 1_000) : [{ id: 'market' }])
    }))
    const service = new PolymarketMarketData({ enableStreaming: false })

    const status = await service.testConnection()

    expect(status.connected).toBe(true)
    expect(requested).toEqual(expect.arrayContaining([
      expect.stringContaining('gamma-api.polymarket.com/markets'),
      expect.stringContaining('clob.polymarket.com/time')
    ]))
  })

  it('discovers the exact rolling window and uses real CLOB asks and fee rate', async () => {
    let upPrice = '0.50'
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('gamma-api')) {
        return Response.json({
          markets: [{
            conditionId: 'condition-1', active: true, closed: false,
            outcomes: '["Up","Down"]', clobTokenIds: '["token-up","token-down"]'
          }]
        })
      }
      if (url.includes('/clob-markets/condition-1')) return Response.json({ fd: { r: 0.07, e: 1, to: true } })
      if (url.includes('/book?token_id=token-up')) {
        return Response.json({ timestamp: String(Date.now()), asks: [{ price: '0.55', size: '12' }, { price: upPrice, size: '8' }] })
      }
      if (url.includes('/book?token_id=token-down')) {
        return Response.json({ timestamp: String(Date.now()), asks: [{ price: '0.48', size: '6' }] })
      }
      return Response.json({})
    }))

    const service = new PolymarketMarketData({ enableStreaming: false })
    const windows = await service.fetchWindows([{ durationMinutes: 5, startTime: 1_800_000, endTime: 2_100_000 }])

    expect(windows[0].outcomes.UP!.tokenId).toBe('token-up')
    expect(windows[0].conditionId).toBe('condition-1')
    expect(windows[0].outcomes.UP!.bestAsk).toBe('0.50')
    expect(windows[0].outcomes.DOWN!.askSize).toBe('6')
    expect(windows[0].outcomes.UP!.feeRate).toBe('0.07')
    expect(windows[0].outcomes.UP!.feeExponent).toBe('1')
    expect(service.getStatus().connected).toBe(true)

    upPrice = '0.47'
    await service.confirmOutcomeQuote('token-up', -1)
    expect(service.getLatestWindows()[0].outcomes.UP?.bestAsk).toBe('0.47')
  })

  it('keeps the official reference-price source timestamp instead of masking stale data as fresh', async () => {
    const sourceSeconds = 1_800_000_123
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('gamma-api')) return Response.json({ markets: [{
        conditionId: 'condition-1', active: true, closed: false,
        outcomes: '["Up","Down"]', clobTokenIds: '["token-up","token-down"]'
      }] })
      if (url.includes('/clob-markets/')) return Response.json({ fd: { r: 0.07, e: 1 } })
      if (url.includes('/book?')) return Response.json({ asks: [{ price: '0.5', size: '10' }] })
      if (url.includes('/api/crypto/crypto-price?')) {
        return Response.json({ openPrice: 60_000, closePrice: 60_010, timestamp: sourceSeconds })
      }
      if (url.includes('/api/crypto/price-history?')) return Response.json([])
      return Response.json({})
    }))
    const service = new PolymarketMarketData({ enableStreaming: false })

    const [window] = await service.fetchWindows([{ durationMinutes: 5, startTime: 1_800_000, endTime: 2_100_000 }])

    expect(window.indexReceivedAt).toBe(sourceSeconds * 1_000)
  })

  it('reports disconnected instead of generating fallback quotes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })))
    const service = new PolymarketMarketData({ enableStreaming: false })

    await expect(service.fetchWindows([{ durationMinutes: 15, startTime: 0, endTime: 900_000 }])).rejects.toThrow('HTTP 503')
    expect(service.getStatus().connected).toBe(false)
  })

  it('falls back once to the containing quarter-hour slug for a misaligned 15m window', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      requested.push(url)
      if (url.includes('gamma-api')) {
        if (url.includes('btc-updown-15m-1800000300')) return new Response('missing', { status: 404 })
        return Response.json({ markets: [{
          conditionId: 'quarter-hour-condition', active: true, closed: false,
          outcomes: '["Up","Down"]', clobTokenIds: '["up-quarter","down-quarter"]'
        }] })
      }
      if (url.includes('/clob-markets/')) return Response.json({ fd: { r: 0.07, e: 1 } })
      if (url.includes('/book?')) return Response.json({ asks: [{ price: '0.50', size: '4' }] })
      return Response.json({})
    }))
    const service = new PolymarketMarketData({ enableStreaming: false })

    const [window] = await service.fetchWindows([{ durationMinutes: 15, startTime: 1_800_000_300_000, endTime: 1_800_001_200_000 }])

    expect(window.startTime).toBe(1_800_000_000_000)
    expect(window.endTime).toBe(1_800_000_900_000)
    expect(requested.filter((url) => url.includes('gamma-api'))).toHaveLength(2)
  })

  it('rechecks the current quarter-hour after a previously cached 15m slug expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_001_000)
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      requested.push(url)
      if (url.includes('gamma-api')) {
        if (url.includes('btc-updown-15m-1800000000')) return Response.json({ markets: [{
          conditionId: 'old-condition', active: true, closed: false,
          outcomes: '["Up","Down"]', clobTokenIds: '["old-up","old-down"]'
        }] })
        if (url.includes('btc-updown-15m-1800000900')) return Response.json({ markets: [{
          conditionId: 'new-condition', active: true, closed: false,
          outcomes: '["Up","Down"]', clobTokenIds: '["new-up","new-down"]'
        }] })
        return new Response('missing', { status: 404 })
      }
      if (url.includes('/clob-markets/')) return Response.json({ fd: { r: 0.07, e: 1 } })
      if (url.includes('/book?')) return Response.json({ asks: [{ price: '0.50', size: '4' }] })
      return Response.json({})
    }))
    const service = new PolymarketMarketData({ enableStreaming: false })
    const window = { durationMinutes: 15 as const, startTime: 1_800_000_000_000, endTime: 1_800_000_900_000 }

    await service.fetchWindows([window])
    vi.setSystemTime(1_800_000_900_000)
    const [current] = await service.fetchWindows([window])

    expect(current.conditionId).toBe('new-condition')
    expect(requested.filter((url) => url.includes('gamma-api'))).toEqual(expect.arrayContaining([
      expect.stringContaining('btc-updown-15m-1800000900')
    ]))
  })

  it('falls back once to the official market-by-slug endpoint when a 15m event response is empty', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_001_000)
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      requested.push(url)
      if (url.includes('/events/slug/')) return Response.json({ markets: [] })
      if (url.includes('/markets/slug/')) return Response.json({
        conditionId: 'market-slug-condition', active: true, closed: false, acceptingOrders: true,
        outcomes: '["Up","Down"]', clobTokenIds: '["slug-up","slug-down"]'
      })
      if (url.includes('/clob-markets/')) return Response.json({ fd: { r: 0.07, e: 1 } })
      if (url.includes('/book?')) return Response.json({ asks: [{ price: '0.50', size: '4' }] })
      return Response.json({})
    }))
    const service = new PolymarketMarketData({ enableStreaming: false })
    const [window] = await service.fetchWindows([{ durationMinutes: 15, startTime: 1_800_000_000_000, endTime: 1_800_000_900_000 }])

    expect(window.conditionId).toBe('market-slug-condition')
    expect(requested.filter((url) => url.includes('/markets/slug/'))).toHaveLength(1)
  })

  it('rejects a market whose V2 fee parameters cannot be verified', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('gamma-api')) {
        return Response.json({
          markets: [{ active: true, closed: false, outcomes: '["Up","Down"]', clobTokenIds: '["up","down"]' }]
        })
      }
      return Response.json({})
    }))
    const service = new PolymarketMarketData({ enableStreaming: false })

    await expect(service.fetchWindows([{ durationMinutes: 5, startTime: 0, endTime: 300_000 }]))
      .rejects.toThrow('无法验证手续费')
  })

  it('applies CLOB book and incremental ask changes without a REST refresh', () => {
    const windows: PolymarketWindowQuote[] = [{
      durationMinutes: 5,
      startTime: 0,
      endTime: 300_000,
      outcomes: {
        UP: {
          direction: 'UP', tokenId: 'token-up', bestAsk: '0.50', askSize: '4',
          levels: [{ price: '0.50', size: '4' }], receivedAt: 1,
          feeRate: '0.07', feeExponent: '1', minOrderSize: '5'
        }
      }
    }]
    const afterBook = applyPolymarketStreamEvent(windows, {
      event_type: 'book', asset_id: 'token-up', timestamp: '100', min_order_size: '6',
      asks: [{ price: '0.53', size: '8' }, { price: '0.51', size: '3' }]
    })
    const afterChange = applyPolymarketStreamEvent(afterBook, {
      event_type: 'price_change', timestamp: '200',
      price_changes: [{ asset_id: 'token-up', side: 'SELL', price: '0.51', size: '0', best_ask: '0.53' }]
    })

    expect(afterBook[0].outcomes.UP).toMatchObject({ bestAsk: '0.51', askSize: '3', minOrderSize: '6' })
    expect(afterBook[0].outcomes.UP?.receivedAt).toBeGreaterThan(1)
    expect(afterChange[0].outcomes.UP).toMatchObject({ bestAsk: '0.53', askSize: '8' })
    expect(afterChange[0].outcomes.UP?.receivedAt).toBeGreaterThanOrEqual(afterBook[0].outcomes.UP?.receivedAt ?? 0)
    expect(afterChange[0].outcomes.UP?.levels).toEqual([{ price: '0.53', size: '8' }])
  })
})
