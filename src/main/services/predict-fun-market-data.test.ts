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
  emitFrame(message: unknown, pageUrl?: string): void {
    for (const listener of this.frameListeners) listener({ url: 'wss://ws.predict.fun/ws', payload: JSON.stringify(message), receivedAt: Date.now(), pageUrl })
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
      data: { marketId: 42, updateTimestampMs: Date.now() - 60_000, asks: [[0.58, 20]], bids: [[0.55, 30]] }
    })
    expect(source.getLatestWindows()[0].outcomes.UP?.bestAsk).toBe('0.58')
    expect(source.getLatestWindows()[0].outcomes.UP?.observedAt).toBe(Date.now())
    expect(source.getStatus().message).toContain('未额外请求接口')
    expect(listener).toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('joins the Predict Chainlink price stream with the category startPrice', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T11:32:00.000Z'))
    const capture = new FakePredictPageCapture()
    const source = new PredictFunMarketData(async () => undefined, undefined, { pageCapture: capture })
    await source.fetchWindows()
    const category = {
      slug: 'btc-updown-5m-1787311800', startsAt: '2026-08-21T11:30:00.000Z', endsAt: '2026-08-21T11:35:00.000Z',
      status: 'OPEN', marketVariant: 'CRYPTO_UP_DOWN',
      variantDetails: { crypto: { priceFeedProvider: 'CHAINLINK', priceFeedId: '1', priceFeedSymbol: 'BTC/USD', startPrice: 80400 } },
      markets: [{ id: 42, tradingStatus: 'OPEN', outcomes: [{ name: 'Up', index: 1, onChainId: 'up' }, { name: 'Down', index: 2, onChainId: 'down' }] }]
    }
    capture.emitResponse('https://api.predict.fun/v1/categories?status=OPEN', { success: true, data: [category] })
    capture.emitResponse('https://api.predict.fun/v1/markets/42/orderbook', {
      success: true, data: { marketId: 42, updateTimestampMs: Date.now(), asks: [[0.61, 10]], bids: [[0.54, 12]] }
    })
    expect(source.getLatestWindows()[0].settlementObservation).toBeUndefined()
    capture.emitFrame({ type: 'M', topic: 'chainlinkAssetPriceUpdate/1', data: { price: 80435.42, priceFeedId: 1, publishTime: 1787311920 } })
    expect(source.getLatestWindows()[0].settlementObservation).toEqual({ baselineValue: '80400', currentValue: '80435.42', observedAt: Date.now() })
    vi.useRealTimers()
  })

  it('retains an opening Chainlink tick when the passive market directory arrives after the round starts', async () => {
    vi.useFakeTimers()
    const start = new Date('2026-08-21T11:30:00.000Z').getTime()
    vi.setSystemTime(new Date('2026-08-21T11:32:00.000Z'))
    const capture = new FakePredictPageCapture()
    const source = new PredictFunMarketData(async () => undefined, undefined, { pageCapture: capture })
    await source.fetchWindows()

    // The page subscribes to Chainlink before its GetMarket GraphQL response
    // is processed. The old implementation kept only the latest 11:32 tick,
    // so it could never recover the 11:30 opening value afterwards.
    capture.emitFrame({ type: 'M', topic: 'chainlinkAssetPriceUpdate/1', data: { price: 80400, priceFeedId: 1, publishTime: Math.round(start / 1_000), timestamp: Math.round(start / 1_000) } })
    vi.setSystemTime(new Date('2026-08-21T11:32:01.000Z'))
    capture.emitFrame({ type: 'M', topic: 'chainlinkAssetPriceUpdate/1', data: { price: 80435, priceFeedId: 1, publishTime: Math.round(Date.now() / 1_000), timestamp: Math.round(Date.now() / 1_000) } })
    capture.emitResponse('https://graphql.predict.fun/graphql', { data: { market: {
      id: '42', status: 'REGISTERED', tradingStatus: 'OPEN', outcomes: { edges: [
        { node: { name: 'Up', index: 1, onChainId: 'up' } }, { node: { name: 'Down', index: 2, onChainId: 'down' } }
      ] }, category: { id: 'btc-updown-5m-1787302200', startsAt: '2026-08-21T11:30:00.000Z', endsAt: '2026-08-21T11:35:00.000Z' }
    } } }, { operationName: 'GetMarket', requestMarketIds: ['42'], requestSlugs: ['btc-updown-5m-1787302200'] })
    capture.emitFrame({ type: 'M', topic: 'predictOrderbook/42', data: { marketId: 42, asks: [[0.61, 10]], bids: [[0.54, 12]] } })

    expect(source.getLatestWindows()[0].settlementObservation).toEqual({ baselineValue: '80400', currentValue: '80435', observedAt: Date.now() })
    vi.useRealTimers()
  })

  it('binds an early passive websocket frame to the rolling page slug before the directory arrives', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T00:34:00.000Z'))
    const capture = new FakePredictPageCapture()
    const source = new PredictFunMarketData(async () => undefined, undefined, { pageCapture: capture })
    await source.fetchWindows()

    capture.emitFrame({
      type: 'M', topic: 'predictOrderbook/1761139',
      data: { marketId: 1761139, updateTimestampMs: Date.now(), asks: [[0.61, 4]], bids: [[0.55, 5]] }
    }, 'https://predict.fun/zh-cn/market/btc-updown-15m-1787877000')

    expect(source.getLatestWindows()).toHaveLength(1)
    expect(source.getLatestWindows()[0]).toMatchObject({ marketId: '1761139', durationMinutes: 15 })
    expect(source.getStatus().message).toContain('页面绑定 1')
  })

  it('unwraps page websocket envelopes and exposes the exact unmapped frame in diagnostics', async () => {
    const capture = new FakePredictPageCapture()
    const source = new PredictFunMarketData(async () => undefined, undefined, { pageCapture: capture })
    await source.fetchWindows()

    capture.emitFrame({ data: { type: 'M', topic: 'predictOrderbook/999999', data: { marketId: 999999, asks: [[0.61, 2]], bids: [[0.55, 3]] } } })
    // A normal board refresh must not overwrite the useful parser diagnosis
    // with the page capture's generic frame counter.
    await source.fetchWindows()

    const message = source.getStatus().message
    expect(message).toContain('最近WS topic=predictOrderbook/999999 marketId=999999')
    expect(message).toContain('未映射 1')
    expect(message).toContain('目录 空')
  })

  it('treats a new unknown frame on the 15m page as the next 5m roll after the old 5m window ends', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T00:34:00.000Z'))
    const capture = new FakePredictPageCapture()
    const source = new PredictFunMarketData(async () => undefined, undefined, { pageCapture: capture })
    await source.fetchWindows()

    capture.emitResponse('https://api.predict.fun/v1/categories/page-metadata', {
      success: true,
      data: [
        { slug: 'btc-updown-5m-1787877000', startsAt: '2026-08-28T00:30:00.000Z', endsAt: '2026-08-28T00:35:00.000Z', status: 'OPEN', marketVariant: 'CRYPTO_UP_DOWN', markets: [{ id: 1761000, tradingStatus: 'OPEN', outcomes: [{ name: 'Up', index: 1, onChainId: 'old-up' }, { name: 'Down', index: 2, onChainId: 'old-down' }] }] },
        { slug: 'btc-updown-15m-1787877000', startsAt: '2026-08-28T00:30:00.000Z', endsAt: '2026-08-28T00:45:00.000Z', status: 'OPEN', marketVariant: 'CRYPTO_UP_DOWN', markets: [{ id: 1761001, tradingStatus: 'OPEN', outcomes: [{ name: 'Up', index: 1, onChainId: 'fifteen-up' }, { name: 'Down', index: 2, onChainId: 'fifteen-down' }] }] }
      ]
    })
    capture.emitFrame({ type: 'M', topic: 'predictOrderbook/1761000', data: { marketId: 1761000, asks: [[0.60, 4]], bids: [[0.56, 5]] } }, 'https://predict.fun/zh-cn/market/btc-updown-15m-1787877000')
    vi.setSystemTime(new Date('2026-08-28T00:37:00.000Z'))
    capture.emitFrame({ type: 'M', topic: 'predictOrderbook/1761001', data: { marketId: 1761001, asks: [[0.61, 4]], bids: [[0.55, 5]] } }, 'https://predict.fun/zh-cn/market/btc-updown-15m-1787877000')
    capture.emitFrame({ type: 'M', topic: 'predictOrderbook/1761139', data: { marketId: 1761139, asks: [[0.62, 4]], bids: [[0.54, 5]] } }, 'https://predict.fun/zh-cn/market/btc-updown-15m-1787877000')

    expect(source.getLatestWindows().some((window) => window.marketId === '1761139' && window.durationMinutes === 5)).toBe(true)
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

  it('maps the current GetMarket response whose category exposes only the rolling category id', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T14:46:00.000Z'))
    const capture = new FakePredictPageCapture()
    const source = new PredictFunMarketData(async () => undefined, undefined, { pageCapture: capture })
    await source.fetchWindows()

    // This is the shape captured from the live Predict.fun page on
    // 2026-08-28: GetMarket has the complete market/outcome metadata, while
    // market.category contains id/startsAt/endsAt but no slug or variant.
    capture.emitResponse('https://graphql.predict.fun/graphql', {
      data: { market: {
        id: '1766727', decimalPrecision: 2, takerFeeBps: 200,
        isTradingEnabled: true, status: 'REGISTERED',
        outcomes: { edges: [
          { node: { id: '3471450', name: '涨', index: 1, onChainId: 'up-live' } },
          { node: { id: '3471451', name: '跌', index: 2, onChainId: 'down-live' } }
        ] },
        category: {
          id: 'btc-updown-5m-1787928300',
          startsAt: '2026-08-28T14:45:00.000Z',
          endsAt: '2026-08-28T14:50:00.000Z',
          isNegRisk: false, isYieldBearing: false
        }
      }}
    }, {
      operationName: 'GetMarket',
      requestMarketIds: ['1766727'],
      requestSlugs: ['btc-updown-5m-1787928300']
    })
    capture.emitFrame({
      type: 'M', topic: 'predictOrderbook/1766727',
      data: { marketId: 1766727, updateTimestampMs: Date.now(), asks: [[0.45, 12]], bids: [[0.54, 8]] }
    }, 'https://predict.fun/zh-cn/market/btc-updown-5m-1787928300')

    expect(source.getLatestWindows()).toHaveLength(1)
    expect(source.getLatestWindows()[0]).toMatchObject({ marketId: '1766727', durationMinutes: 5, feeRateBps: 200 })
    expect(source.getLatestWindows()[0].outcomes.UP?.outcomeId).toBe('up-live')
    expect(source.getLatestWindows()[0].outcomes.DOWN?.outcomeId).toBe('down-live')
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

  it('does not treat match/event logs as market directory responses', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T00:37:00.000Z'))
    const capture = new FakePredictPageCapture()
    const source = new PredictFunMarketData(async () => undefined, undefined, { pageCapture: capture })
    await source.fetchWindows()
    capture.emitResponse('https://predict.fun/graphql', {
      data: { market: { id: 1741179, status: 'REGISTERED', outcomes: [{ name: 'Yes', indexSet: 1, onChainId: 'up' }] } }
    }, { operationName: 'GetMatchEventLog', requestSlugs: ['btc-updown-15m-1787877000'] })
    expect(source.getStatus().message).toContain('GraphQL目录 0/1')
    expect(source.getLatestWindows()).toEqual([])
  })

  it('maps GetMatchEventLog when it carries the complete current market outcomes', async () => {
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
          { name: 'Yes', indexSet: 1, onChainId: 'up-event-log' },
          { name: 'No', indexSet: 2, onChainId: 'down-event-log' }
        ]
      }}
    }, { operationName: 'GetMatchEventLog', requestSlugs: ['btc-updown-15m-1787877000'] })
    capture.emitFrame({
      type: 'M', topic: 'predictOrderbook/1741179',
      data: { marketId: 1741179, updateTimestampMs: Date.now(), asks: [[0.61, 4]], bids: [[0.55, 5]] }
    })

    expect(source.getLatestWindows()).toHaveLength(1)
    expect(source.getLatestWindows()[0]).toMatchObject({ marketId: '1741179', durationMinutes: 15 })
    expect(source.getLatestWindows()[0].outcomes.UP?.outcomeId).toBe('up-event-log')
    expect(source.getLatestWindows()[0].outcomes.DOWN?.outcomeId).toBe('down-event-log')
  })

  it('builds a market context when a category response only exposes marketData.marketId', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T00:37:00.000Z'))
    const capture = new FakePredictPageCapture()
    const source = new PredictFunMarketData(async () => undefined, undefined, { pageCapture: capture })
    await source.fetchWindows()
    capture.emitResponse('https://predict.fun/graphql', {
      data: { category: {
        id: 'btc-updown-15m-1787877000', slug: 'btc-updown-15m-1787877000',
        startsAt: '2026-08-28T00:30:00.000Z', endsAt: '2026-08-28T00:45:00.000Z',
        status: 'OPEN', marketVariant: 'CRYPTO_UP_DOWN',
        marketData: { marketId: '1741179', priceFeedSymbol: 'BTCUSDT' }
      } }
    }, { operationName: 'GetMatchEventLog', requestSlugs: ['btc-updown-15m-1787877000'] })
    capture.emitFrame({
      type: 'M', topic: 'predictOrderbook/1741179',
      data: { marketId: 1741179, updateTimestampMs: Date.now(), asks: [[0.61, 4]], bids: [[0.55, 5]] }
    }, 'https://predict.fun/zh-cn/market/btc-updown-15m-1787877000')

    expect(source.getLatestWindows()).toHaveLength(1)
    expect(source.getLatestWindows()[0]).toMatchObject({ marketId: '1741179', durationMinutes: 15 })
  })

  it('uses bestAsk values embedded in GraphQL outcomes when no page websocket frame arrives', async () => {
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
        categorySlug: 'btc-updown-15m-1787877000',
        marketVariant: 'CRYPTO_UP_DOWN',
        outcomes: [
          { name: 'Yes', indexSet: 1, onChainId: 'up-embedded', bestAsk: { price: 0.61, size: 4 } },
          { name: 'No', indexSet: 2, onChainId: 'down-embedded', bestAsk: { price: 0.39, size: 5 } }
        ]
      }}
    }, { operationName: 'GetMatchEventLog', requestSlugs: ['btc-updown-15m-1787877000'] })

    expect(source.getLatestWindows()).toHaveLength(1)
    expect(source.getLatestWindows()[0].outcomes.UP).toMatchObject({ bestAsk: '0.61', askSize: '4' })
    expect(source.getLatestWindows()[0].outcomes.DOWN).toMatchObject({ bestAsk: '0.39', askSize: '5' })
  })

  it('binds a current-page marketId-only GraphQL response to the rolling slug', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T00:37:00.000Z'))
    const capture = new FakePredictPageCapture()
    const source = new PredictFunMarketData(async () => undefined, undefined, { pageCapture: capture })
    await source.fetchWindows()
    capture.emitResponse('https://predict.fun/graphql', {
      data: { matchEventLog: { marketId: 1741179 } }
    }, { operationName: 'GetMatchEventLog', requestSlugs: ['btc-updown-15m-1787877000'] })
    capture.emitFrame({
      type: 'M', topic: 'predictOrderbook/1741179',
      data: { marketId: 1741179, updateTimestampMs: Date.now(), asks: [[0.61, 4]], bids: [[0.55, 5]] }
    })

    expect(source.getLatestWindows()).toHaveLength(1)
    expect(source.getLatestWindows()[0]).toMatchObject({ marketId: '1741179', durationMinutes: 15 })
  })

  it('does not use portfolio marketIds as the current market directory', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T00:37:00.000Z'))
    const capture = new FakePredictPageCapture()
    const source = new PredictFunMarketData(async () => undefined, undefined, { pageCapture: capture })
    await source.fetchWindows()
    capture.emitResponse('https://predict.fun/graphql', {
      data: { portfolio: { marketId: 1741179, outcomes: [
        { name: 'Yes', indexSet: 1, onChainId: 'up-portfolio' },
        { name: 'No', indexSet: 2, onChainId: 'down-portfolio' }
      ] } }
    }, { operationName: 'GetPortfolioSummary', requestSlugs: ['btc-updown-15m-1787877000'] })
    expect(source.getLatestWindows()).toEqual([])
  })

  it('captures the official REST market detail endpoint when the page omits a market GraphQL query', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T00:37:00.000Z'))
    const capture = new FakePredictPageCapture()
    const source = new PredictFunMarketData(async () => undefined, undefined, { pageCapture: capture })
    await source.fetchWindows()
    capture.emitResponse('https://api.predict.fun/v1/markets/1760624', {
      success: true,
      data: {
        id: 1760624,
        categorySlug: 'btc-updown-15m-1787877000',
        marketVariant: 'CRYPTO_UP_DOWN',
        variantData: { type: 'CRYPTO_UP_DOWN', priceFeedSymbol: 'BTCUSDT' },
        tradingStatus: 'OPEN',
        status: 'REGISTERED',
        outcomes: [
          { name: 'Yes', indexSet: 1, onChainId: 'up-rest' },
          { name: 'No', indexSet: 2, onChainId: 'down-rest' }
        ]
      }
    })
    capture.emitFrame({
      type: 'M', topic: 'predictOrderbook/1760624',
      data: { marketId: 1760624, updateTimestampMs: Date.now(), asks: [[0.62, 4]], bids: [[0.53, 5]] }
    })
    expect(source.getLatestWindows()[0]).toMatchObject({ marketId: '1760624', durationMinutes: 15 })
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
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(capture.start).not.toHaveBeenCalled()
    expect(source.getStatus().message).toContain('目录0')
  })

  it('does not let a late passive page response contaminate API mode', async () => {
    const capture = new FakePredictPageCapture()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const source = new PredictFunMarketData(async () => 'mainnet-key', undefined, { enableStreaming: false, pageCapture: capture })

    await source.fetchWindows()
    capture.emitResponse('https://api.predict.fun/v1/categories?status=OPEN', { success: true, data: [{
      slug: 'btc-updown-5m-1787302200', startsAt: '2026-08-21T11:30:00.000Z', endsAt: '2026-08-21T11:35:00.000Z', status: 'OPEN',
      marketVariant: 'CRYPTO_UP_DOWN', markets: [{ id: 42, tradingStatus: 'OPEN', outcomes: [{ name: 'Up', index: 1, onChainId: 'up' }, { name: 'Down', index: 2, onChainId: 'down' }] }]
    }] })
    capture.emitFrame({ type: 'M', topic: 'predictOrderbook/42', data: { marketId: 42, asks: [[0.61, 10]], bids: [[0.54, 10]] } })
    expect(source.getLatestWindows()).toEqual([])
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
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(source.getStatus().connectionState).toBe('CONNECTED')

    apiKey = undefined
    source.credentialsChanged()
    await source.fetchWindows()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(source.getStatus().connectionState).toBe('NOT_CONFIGURED')
  })

  it('falls back to official BTC search and accepts variantDetails.crypto categories', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-02T06:30:00.000Z'))
    const category = {
      id: 101,
      slug: 'rolling-five-minute-market', startsAt: '2026-09-02T06:30:00.000Z', endsAt: '2026-09-02T06:35:00.000Z',
      status: 'OPEN', marketVariant: 'CRYPTO_UP_DOWN',
      variantDetails: { crypto: { priceFeedProvider: 'PYTH', priceFeedId: 'btc-feed', priceFeedSymbol: 'BTCUSDT' } },
      markets: [{ id: 77, feeRateBps: 100, tradingStatus: 'OPEN', decimalPrecision: 2, outcomes: [
        { name: 'Up', indexSet: 1, onChainId: 'up-77' }, { name: 'Down', indexSet: 2, onChainId: 'down-77' }
      ] }]
    }
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('marketVariant=CRYPTO_UP_DOWN')) return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 })
      if (url.includes('/v1/search')) return new Response(JSON.stringify({ success: true, data: { categories: [category], markets: [] } }), { status: 200 })
      if (url.includes('/orderbook')) return new Response(JSON.stringify({ success: true, data: {
        marketId: 77, updateTimestampMs: Date.now(), asks: [[0.58, 8]], bids: [[0.48, 9]]
      } }), { status: 200 })
      throw new Error(`unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const source = new PredictFunMarketData(async () => 'secret-key', undefined, { enableStreaming: false })

    const windows = await source.fetchWindows()

    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({ marketId: '77', durationMinutes: 5 })
    expect(windows[0].resolution.baselineSource).toBe('PYTH:btc-feed')
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/v1/categories?first=100&status=OPEN') && !String(url).includes('marketVariant'))).toBe(false)
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
