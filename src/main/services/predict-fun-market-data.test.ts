import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { type ClientOptions } from 'ws'
import { PredictFunMarketData } from './predict-fun-market-data'
import type {
  PredictFunCapturedResponse,
  PredictFunCapturedWebSocketFrame,
  PredictFunPageCaptureSource,
  PredictFunPageCaptureStatus
} from './predict-fun-page-capture'

class FakePredictPageCapture implements PredictFunPageCaptureSource {
  status: PredictFunPageCaptureStatus = { state: 'IDLE', message: 'idle' }
  responseListeners: Array<(event: PredictFunCapturedResponse) => void> = []
  frameListeners: Array<(event: PredictFunCapturedWebSocketFrame) => void> = []
  statusListeners: Array<(status: PredictFunPageCaptureStatus) => void> = []
  start = vi.fn(async () => {
    this.status = { state: 'CONNECTED', message: 'single page connected', updatedAt: Date.now() }
    for (const listener of this.statusListeners) listener(this.status)
  })
  stop = vi.fn()

  getStatus(): PredictFunPageCaptureStatus { return { ...this.status } }
  onResponse(listener: (event: PredictFunCapturedResponse) => void): () => void {
    this.responseListeners.push(listener)
    return () => { this.responseListeners = this.responseListeners.filter((candidate) => candidate !== listener) }
  }
  onWebSocketFrame(listener: (event: PredictFunCapturedWebSocketFrame) => void): () => void {
    this.frameListeners.push(listener)
    return () => { this.frameListeners = this.frameListeners.filter((candidate) => candidate !== listener) }
  }
  onStatus(listener: (status: PredictFunPageCaptureStatus) => void): () => void {
    this.statusListeners.push(listener)
    return () => { this.statusListeners = this.statusListeners.filter((candidate) => candidate !== listener) }
  }
  emitResponse(url: string, body: unknown, metadata: Partial<PredictFunCapturedResponse> = {}): void {
    for (const listener of this.responseListeners) listener({ url, body: JSON.stringify(body), receivedAt: Date.now(), ...metadata })
  }
  emitFrame(message: unknown): void {
    for (const listener of this.frameListeners) listener({ url: 'wss://ws.predict.fun/ws', payload: JSON.stringify(message), receivedAt: Date.now() })
  }
}

class FakePredictSocket {
  readyState: number = WebSocket.CONNECTING
  handlers = new Map<string, Array<(...args: never[]) => void>>()
  send = vi.fn()
  close = vi.fn(() => { this.readyState = WebSocket.CLOSED })

  on(event: string, handler: (...args: never[]) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    return this
  }

  trigger(event: string, payload?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload as never)
  }

  open(): void {
    this.readyState = WebSocket.OPEN
    this.trigger('open')
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('PredictFunMarketData', () => {
  it('can stay idle until the user opens the passive page', async () => {
    const capture = new FakePredictPageCapture()
    const source = new PredictFunMarketData(async () => undefined, undefined, { pageCapture: capture, autoStartPageCapture: false })

    expect(await source.fetchWindows()).toEqual([])
    expect(capture.start).not.toHaveBeenCalled()
    expect(source.getStatus().message).toContain('点击“打开 Predict.fun 页面”')
  })

  it('does not make any request until the mainnet API key is configured', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const source = new PredictFunMarketData(async () => undefined, undefined, { enableStreaming: false })

    expect(await source.fetchWindows()).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(source.getStatus().connectionState).toBe('NOT_CONFIGURED')
  })

  it('uses one passive page with zero extra fetches when no API key is configured', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T11:32:00.000Z'))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const capture = new FakePredictPageCapture()
    const source = new PredictFunMarketData(async () => undefined, undefined, { pageCapture: capture })
    const listener = vi.fn()
    source.onMarketData(listener)

    await Promise.all([source.fetchWindows(), source.fetchWindows()])
    expect(capture.start).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()

    const category = {
      slug: 'btc-updown-5m', startsAt: '2026-08-21T11:30:00.000Z', endsAt: '2026-08-21T11:35:00.000Z',
      status: 'OPEN', marketVariant: 'CRYPTO_UP_DOWN', variantData: { type: 'CRYPTO_UP_DOWN', priceFeedId: 'feed', priceFeedSymbol: 'BTCUSDT' },
      markets: [{ id: 42, feeRateBps: 200, tradingStatus: 'OPEN', decimalPrecision: 3, outcomes: [
        { name: 'Up', onChainId: 'up' }, { name: 'Down', onChainId: 'down' }
      ] }]
    }
    capture.emitResponse('https://api.predict.fun/v1/categories?status=OPEN', { success: true, data: [category] })
    capture.emitResponse('https://api.predict.fun/v1/markets/42/orderbook', {
      success: true, data: { marketId: 42, updateTimestampMs: Date.now(), asks: [[0.61, 10]], bids: [[0.54, 12]] }
    })
    expect(source.getLatestWindows()[0].outcomes.UP?.bestAsk).toBe('0.61')
    expect(source.getLatestWindows()[0].outcomes.DOWN?.bestAsk).toBe('0.46')

    capture.emitFrame({
      type: 'M', topic: 'predictOrderbook/42',
      data: { marketId: 42, updateTimestampMs: Date.now(), asks: [[0.58, 20]], bids: [[0.55, 30]] }
    })
    expect(source.getLatestWindows()[0].outcomes.UP?.bestAsk).toBe('0.58')
    expect(source.getStatus().message).toContain('未额外请求接口')
    expect(listener).toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('discovers the current BTC windows from the new page GraphQL response before applying passive websocket books', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T11:32:00.000Z'))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const capture = new FakePredictPageCapture()
    const source = new PredictFunMarketData(async () => undefined, undefined, { pageCapture: capture })
    await source.fetchWindows()

    capture.emitResponse('https://api.predict.fun/graphql', { data: { categories: { edges: [{ node: {
        id: 'btc-updown-5m-1787302200', slug: 'btc-updown-5m-1787302200',
        startsAt: '2026-08-21T11:30:00.000Z', endsAt: '2026-08-21T11:35:00.000Z',
        status: 'ACTIVE', resolutionProvider: 'CHAINLINK',
        marketData: [{ marketId: '42', priceFeedId: '1', priceFeedSymbol: 'BTCUSDT', priceFeedProvider: 'CHAINLINK' }],
        markets: { edges: [{ node: {
          id: '42', decimalPrecision: 3, takerFeeBps: 200, status: 'REGISTERED'
        } }] }
      } }] } } })
    expect(source.getStatus().message).toContain('GraphQL')

    capture.emitFrame({
      type: 'M', topic: 'predictOrderbook/42',
      data: { marketId: 42, updateTimestampMs: Date.now(), asks: [[0.612, 11]], bids: [[0.557, 13]] }
    })
    expect(source.getLatestWindows()[0]).toMatchObject({ marketId: '42', durationMinutes: 5, feeRateBps: 200 })
    expect(source.getLatestWindows()[0].outcomes.UP?.bestAsk).toBe('0.612')
    expect(source.getLatestWindows()[0].outcomes.DOWN?.bestAsk).toBe('0.443')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the crypto marketData marketId when GraphQL node id differs from the websocket id', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T11:32:00.000Z'))
    const capture = new FakePredictPageCapture()
    const source = new PredictFunMarketData(async () => undefined, undefined, { pageCapture: capture })
    await source.fetchWindows()

    capture.emitResponse('https://graphql.predict.fun/graphql', { data: { category: {
      id: 'btc-updown-15m-id-mismatch', slug: 'btc-updown-15m-id-mismatch',
      startsAt: '2026-08-21T11:30:00.000Z', endsAt: '2026-08-21T11:45:00.000Z',
      status: 'ACTIVE', marketVariant: 'CRYPTO_UP_DOWN',
      marketData: [{ marketId: '1738399', priceFeedId: '1', priceFeedSymbol: 'BTCUSDT' }],
      markets: { edges: [{ node: { id: 'graphql-node-id', decimalPrecision: 3, status: 'REGISTERED' } }] }
    } } })
    capture.emitFrame({
      type: 'M', topic: 'predictOrderbook/1738399',
      data: { marketId: 1738399, updateTimestampMs: Date.now(), asks: [[0.61, 10]], bids: [[0.54, 12]] }
    })

    expect(source.getLatestWindows()).toHaveLength(1)
    expect(source.getLatestWindows()[0].marketId).toBe('1738399')
  })

  it('maps localized zh-CN outcomes by their stable index before applying the page websocket book', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-23T12:32:00.000Z'))
    const capture = new FakePredictPageCapture()
    const source = new PredictFunMarketData(async () => undefined, undefined, { pageCapture: capture })
    await source.fetchWindows()

    capture.emitResponse('https://api.predict.fun/graphql', { data: { category: {
      id: 'btc-updown-15m-1787488200', slug: 'btc-updown-15m-1787488200',
      startsAt: '2026-08-23T12:30:00.000Z', endsAt: '2026-08-23T12:45:00.000Z',
      status: 'OPEN', marketVariant: 'CRYPTO_UP_DOWN',
      marketData: [{ marketId: '1622449', priceFeedId: '1', priceFeedSymbol: 'BTCUSDT' }],
      markets: { edges: [{ node: {
        id: '1622449', decimalPrecision: 3, takerFeeBps: 200, status: 'REGISTERED', isTradingEnabled: true,
        outcomes: { edges: [
          { node: { id: '3182898', name: '涨', index: 1, onChainId: 'up-chain-id' } },
          { node: { id: '3182899', name: '跌', index: 2, onChainId: 'down-chain-id' } }
        ] }
      } }] }
    } } })
    capture.emitFrame({
      type: 'M', topic: 'predictOrderbook/1622449',
      data: { version: 1, marketId: 1622449, updateTimestampMs: Date.now(), asks: [[0.66, 18]], bids: [[0.38, 21]] }
    })

    expect(source.getLatestWindows()[0]).toMatchObject({ marketId: '1622449', durationMinutes: 15 })
    expect(source.getLatestWindows()[0].outcomes.UP).toMatchObject({ outcomeId: 'up-chain-id', bestAsk: '0.66', askSize: '18' })
    expect(source.getLatestWindows()[0].outcomes.DOWN).toMatchObject({ outcomeId: 'down-chain-id', bestAsk: '0.62', askSize: '21' })
  })

  it('keeps an active page market when a later GraphQL response only contains an unrelated or expired BTC category', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T11:32:00.000Z'))
    const capture = new FakePredictPageCapture()
    const source = new PredictFunMarketData(async () => undefined, undefined, { pageCapture: capture })
    await source.fetchWindows()

    capture.emitResponse('https://graphql.predict.fun/graphql', { data: { category: {
      id: 'btc-updown-15m-current', slug: 'btc-updown-15m-current',
      startsAt: '2026-08-21T11:30:00.000Z', endsAt: '2026-08-21T11:45:00.000Z',
      status: 'OPEN', marketVariant: 'CRYPTO_UP_DOWN',
      marketData: [{ marketId: '99', priceFeedId: '1', priceFeedSymbol: 'BTCUSDT' }],
      markets: { edges: [{ node: { id: '99', decimalPrecision: 3, status: 'REGISTERED', isTradingEnabled: true } }] }
    } } })
    capture.emitFrame({
      type: 'M', topic: 'predictOrderbook/99',
      data: { marketId: 99, updateTimestampMs: Date.now(), asks: [[0.61, 10]], bids: [[0.54, 12]] }
    })
    expect(source.getLatestWindows()).toHaveLength(1)

    capture.emitResponse('https://graphql.predict.fun/graphql', { data: { category: {
      // The page also emits a compact market-status response using the same
      // slug but without the category times. It must not erase the directory
      // record captured above.
      id: 'btc-updown-15m-current', slug: 'btc-updown-15m-current',
      status: 'OPEN', marketVariant: 'CRYPTO_UP_DOWN',
      marketData: [{ marketId: '99', priceFeedId: '1', priceFeedSymbol: 'BTCUSDT' }],
      markets: { edges: [{ node: { id: '99', decimalPrecision: 3, status: 'REGISTERED', isTradingEnabled: true } }] }
    } } })

    expect(source.getLatestWindows()).toHaveLength(1)
    expect(source.getLatestWindows()[0].marketId).toBe('99')
  })

  it('normalizes numeric-second category times from the current 15m page/API shape', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_787_477_000_000)
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/categories')) return Response.json({ success: true, data: [{
        slug: 'btc-updown-15m-1787477400', startsAt: '1787477400', endsAt: '1787478300',
        status: 'OPEN', marketVariant: 'CRYPTO_UP_DOWN', variantData: { priceFeedSymbol: 'BTCUSDT' },
        markets: [{ id: 889291, feeRateBps: 200, tradingStatus: 'OPEN', decimalPrecision: 3, outcomes: [
          { name: 'Up', onChainId: 'up-15m' }, { name: 'Down', onChainId: 'down-15m' }
        ] }]
      }] })
      return Response.json({ success: true, data: { marketId: 889291, updateTimestampMs: Date.now(), asks: [[0.61, 10]], bids: [[0.54, 12]] } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const source = new PredictFunMarketData(async () => 'predict-key', undefined, { enableStreaming: false })

    const windows = await source.fetchWindows()

    expect(windows[0]).toMatchObject({ marketId: '889291', durationMinutes: 15, startTime: 1_787_477_400_000 })
  })

  it('derives a rolling 5m window when the page omits explicit category timestamps', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_787_477_000_000)
    const capture = new FakePredictPageCapture()
    const source = new PredictFunMarketData(async () => undefined, undefined, { pageCapture: capture })
    await source.fetchWindows()
    capture.emitResponse('https://api.predict.fun/graphql', { data: { category: {
      slug: 'btc-updown-5m-1787477400', status: 'OPEN', marketVariant: 'CRYPTO_UP_DOWN',
      marketData: [{ marketId: '501', priceFeedSymbol: 'BTCUSDT' }],
      markets: { edges: [{ node: { id: 'graphql-id', status: 'REGISTERED', outcomes: { edges: [
        { node: { name: 'Up', index: 1, onChainId: 'up-501' } },
        { node: { name: 'Down', index: 2, onChainId: 'down-501' } }
      ] } } }] }
    } } })
    capture.emitFrame({ type: 'M', topic: 'predictOrderbook/501', data: { marketId: 501, asks: [[0.6, 3]], bids: [[0.4, 3]] } })
    expect(source.getLatestWindows()[0]).toMatchObject({ marketId: '501', durationMinutes: 5, startTime: 1_787_477_400_000, endTime: 1_787_477_700_000 })
  })

  it('accepts the single-object marketData shape emitted by newer GraphQL pages', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T11:32:00.000Z'))
    const capture = new FakePredictPageCapture()
    const source = new PredictFunMarketData(async () => undefined, undefined, { pageCapture: capture })
    await source.fetchWindows()
    capture.emitResponse('https://graphql.predict.fun/graphql', { data: { category: {
      slug: 'btc-updown-5m-1787302200', startsAt: '2026-08-21T11:30:00.000Z', endsAt: '2026-08-21T11:35:00.000Z',
      status: 'OPEN', marketVariant: 'CRYPTO_UP_DOWN', marketData: { marketId: '777', priceFeedSymbol: 'BTCUSDT' },
      markets: { edges: [{ node: { id: 'graphql-id', status: 'REGISTERED' } }] }
    } } })
    capture.emitFrame({ type: 'M', topic: 'predictOrderbook/777', data: { marketId: 777, asks: [[0.6, 3]], bids: [[0.4, 3]] } })
    expect(source.getLatestWindows()[0]).toMatchObject({ marketId: '777', durationMinutes: 5 })
  })

  it('maps the official standalone Market schema to the websocket market id', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T11:32:00.000Z'))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const capture = new FakePredictPageCapture()
    const source = new PredictFunMarketData(async () => undefined, undefined, { pageCapture: capture })
    await source.fetchWindows()

    capture.emitResponse('https://graphql.predict.fun/graphql', { data: { markets: [{
      id: 1740936,
      tradingStatus: 'OPEN',
      status: 'REGISTERED',
      feeRateBps: 200,
      categorySlug: 'btc-updown-5m-1787311800',
      marketVariant: 'CRYPTO_UP_DOWN',
      variantData: {
        type: 'CRYPTO_UP_DOWN',
        priceFeedProvider: 'CHAINLINK',
        priceFeedId: 'btc-usd',
        priceFeedSymbol: 'BTCUSDT'
      },
      decimalPrecision: 3,
      outcomes: [
        { name: 'Yes', indexSet: 1, onChainId: 'up-official' },
        { name: 'No', indexSet: 2, onChainId: 'down-official' }
      ]
    }] } })
    capture.emitFrame({
      type: 'M', topic: 'predictOrderbook/1740936',
      data: { marketId: 1740936, updateTimestampMs: Date.now(), asks: [[0.612, 11]], bids: [[0.557, 13]] }
    })

    expect(source.getLatestWindows()).toHaveLength(1)
    expect(source.getLatestWindows()[0]).toMatchObject({ marketId: '1740936', durationMinutes: 5, feeRateBps: 200 })
    expect(source.getLatestWindows()[0].outcomes.UP).toMatchObject({ outcomeId: 'up-official', bestAsk: '0.612' })
    expect(source.getLatestWindows()[0].outcomes.DOWN).toMatchObject({ outcomeId: 'down-official', bestAsk: '0.443' })
    expect(source.getStatus().message).toContain('GraphQL目录 1/1')
    expect(source.getStatus().message).toContain('categorySlug')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps the compact page Market response when the GraphQL request carries the rolling slug', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T00:37:00.000Z'))
    const capture = new FakePredictPageCapture()
    const source = new PredictFunMarketData(async () => undefined, undefined, { pageCapture: capture })
    await source.fetchWindows()

    capture.emitResponse('https://predict.fun/graphql', {
      data: { market: {
        id: 1741179,
        status: 'REGISTERED',
        tradingStatus: 'OPEN',
        outcomes: [
          { name: 'Yes', indexSet: 1, onChainId: 'up-compact' },
          { name: 'No', indexSet: 2, onChainId: 'down-compact' }
        ]
      }}
    }, { operationName: 'MarketBySlug', requestSlugs: ['btc-updown-15m-1787877000'] })
    capture.emitFrame({
      type: 'M', topic: 'predictOrderbook/1741179',
      data: { marketId: 1741179, updateTimestampMs: Date.now(), asks: [[0.61, 4]], bids: [[0.55, 5]] }
    })

    expect(source.getLatestWindows()).toHaveLength(1)
    expect(source.getLatestWindows()[0]).toMatchObject({ marketId: '1741179', durationMinutes: 15 })
  })

  it('keeps the official API ahead of page capture when a key exists', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T11:32:00.000Z'))
    const capture = new FakePredictPageCapture()
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).includes('/categories')
      ? new Response(JSON.stringify({ success: true, data: [] }), { status: 200 })
      : new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const source = new PredictFunMarketData(async () => 'mainnet-key', undefined, { enableStreaming: false, pageCapture: capture })

    await source.fetchWindows()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(capture.start).not.toHaveBeenCalled()
  })

  it('applies API key changes immediately instead of waiting for the snapshot cache', async () => {
    let apiKey: string | undefined
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const source = new PredictFunMarketData(async () => apiKey, undefined, { enableStreaming: false })

    await source.fetchWindows()
    apiKey = 'new-secret-key'
    source.credentialsChanged()
    await source.fetchWindows()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(source.getStatus().connectionState).toBe('CONNECTED')

    apiKey = undefined
    source.credentialsChanged()
    await source.fetchWindows()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(source.getStatus().connectionState).toBe('NOT_CONFIGURED')
  })

  it('normalizes crypto categories and respects decimal precision when deriving DOWN asks', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T11:32:00.000Z'))
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/v1/categories')) return new Response(JSON.stringify({ success: true, data: [{
        slug: 'btc-updown-5m', startsAt: '2026-08-21T11:30:00.000Z', endsAt: '2026-08-21T11:35:00.000Z',
        status: 'OPEN', marketVariant: 'CRYPTO_UP_DOWN', resolutionProvider: 'CHAINLINK',
        variantData: { type: 'CRYPTO_UP_DOWN', priceFeedProvider: 'CHAINLINK', priceFeedId: 'feed', priceFeedSymbol: 'BTCUSDT' },
        markets: [{ id: 42, feeRateBps: 200, tradingStatus: 'OPEN', decimalPrecision: 3, outcomes: [
          { name: 'Up', onChainId: 'up-token' }, { name: 'Down', onChainId: 'down-token' }
        ] }]
      }] }), { status: 200 })
      return new Response(JSON.stringify({ success: true, data: {
        marketId: 42, updateTimestampMs: Date.now(), asks: [[0.612, 10]], bids: [[0.557, 8]]
      } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const source = new PredictFunMarketData(async () => 'secret-key', undefined, { enableStreaming: false })

    const windows = await source.fetchWindows()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(windows[0]).toMatchObject({ venueId: 'PREDICT_FUN', marketId: '42', durationMinutes: 5, feeRateBps: 200 })
    expect(windows[0].outcomes.UP?.bestAsk).toBe('0.612')
    expect(windows[0].outcomes.DOWN?.bestAsk).toBe('0.443')
    expect(windows[0].resolution).toMatchObject({ comparisonOperator: 'GT', tieOutcome: 'SPLIT' })
  })

  it('authenticates websocket by header, echoes heartbeats, streams books and reconnects', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T11:32:00.000Z'))
    const category = {
      slug: 'btc-updown-5m', startsAt: '2026-08-21T11:30:00.000Z', endsAt: '2026-08-21T11:35:00.000Z',
      status: 'OPEN', marketVariant: 'CRYPTO_UP_DOWN', variantData: { type: 'CRYPTO_UP_DOWN', priceFeedId: 'feed', priceFeedSymbol: 'BTCUSDT' },
      markets: [{ id: 42, feeRateBps: 200, tradingStatus: 'OPEN', decimalPrecision: 3, outcomes: [
        { name: 'Up', onChainId: 'up' }, { name: 'Down', onChainId: 'down' }
      ] }]
    }
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).includes('/categories')
      ? new Response(JSON.stringify({ success: true, data: [category] }), { status: 200 })
      : new Response(JSON.stringify({ success: true, data: { marketId: 42, updateTimestampMs: Date.now(), asks: [[0.6, 10]], bids: [[0.5, 12]] } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const sockets: FakePredictSocket[] = []
    const factory = vi.fn((_url: string, _options: ClientOptions) => {
      const socket = new FakePredictSocket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    })
    const source = new PredictFunMarketData(async () => 'secret-key', undefined, { webSocketFactory: factory })
    const listener = vi.fn()
    source.onMarketData(listener)

    await source.fetchWindows()
    expect(factory.mock.calls[0][1]?.headers).toMatchObject({ 'x-api-key': 'secret-key' })
    sockets[0].open()
    expect(sockets[0].send).toHaveBeenCalledWith(expect.stringContaining('predictOrderbook/42'))

    sockets[0].trigger('message', Buffer.from(JSON.stringify({ type: 'M', topic: 'heartbeat', data: 12345 })))
    expect(sockets[0].send).toHaveBeenCalledWith(JSON.stringify({ method: 'heartbeat', data: 12345 }))
    sockets[0].trigger('message', Buffer.from(JSON.stringify({
      type: 'M', topic: 'predictOrderbook/42', data: { marketId: 42, updateTimestampMs: Date.now(), asks: [[0.57, 20]], bids: [[0.54, 30]] }
    })))
    expect(source.getLatestWindows()[0].outcomes.UP?.bestAsk).toBe('0.57')
    expect(listener).toHaveBeenCalled()

    vi.advanceTimersByTime(16_000)
    await source.fetchWindows()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/orderbook'))).toHaveLength(1)

    sockets[0].readyState = WebSocket.CLOSED
    sockets[0].trigger('close')
    vi.advanceTimersByTime(1_000)
    expect(factory).toHaveBeenCalledTimes(2)
  })
})
