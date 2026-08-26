import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GatePageCaptureStatus } from '../../shared/types'
import { GateMarketData, parseGateMarketObject } from './gate-market-data'
import type { GateCapturedRequest, GateCapturedResponse, GateCapturedWebSocketFrame, GatePageCaptureSource } from './gate-page-capture'

class FakeGateCapture implements GatePageCaptureSource {
  status: GatePageCaptureStatus = { state: 'IDLE', message: 'idle' }
  responses: Array<(event: GateCapturedResponse) => void> = []
  frames: Array<(event: GateCapturedWebSocketFrame) => void> = []
  statuses: Array<(status: GatePageCaptureStatus) => void> = []
  requests: Array<(event: GateCapturedRequest) => void> = []
  start = vi.fn(async () => {
    this.status = { state: 'CONNECTED', message: 'single Gate page online', updatedAt: Date.now() }
    for (const listener of this.statuses) listener(this.status)
  })
  stop = vi.fn()
  getStatus(): GatePageCaptureStatus { return { ...this.status } }
  onResponse(listener: (event: GateCapturedResponse) => void): () => void { this.responses.push(listener); return () => undefined }
  onRequest(listener: (event: GateCapturedRequest) => void): () => void { this.requests.push(listener); return () => undefined }
  onWebSocketFrame(listener: (event: GateCapturedWebSocketFrame) => void): () => void { this.frames.push(listener); return () => undefined }
  onStatus(listener: (status: GatePageCaptureStatus) => void): () => void { this.statuses.push(listener); return () => undefined }
  emitResponse(value: unknown): void { for (const listener of this.responses) listener({ url: 'https://api.gateio.ws/event/markets', body: JSON.stringify(value), receivedAt: Date.now() }) }
  emitFrame(value: unknown, options: Partial<GateCapturedWebSocketFrame> = {}): void {
    for (const listener of this.frames) listener({
      url: 'wss://fx-ws.gateio.ws/ws', payload: JSON.stringify(value), receivedAt: Date.now(), ...options
    })
  }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('GateMarketData', () => {
  it('can stay idle until the user opens the passive page', async () => {
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture, { autoStartPageCapture: false })

    expect(await source.fetchWindows()).toEqual([])
    expect(capture.start).not.toHaveBeenCalled()
    expect(source.getStatus().message).toContain('点击“打开 Gate 页面”')
  })

  it('starts one passive page with in-flight deduplication and normalizes BTC 5m books', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-22T01:32:00.000Z'))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)

    await Promise.all([source.fetchWindows(), source.fetchWindows()])
    expect(capture.start).toHaveBeenCalledTimes(1)
    capture.emitResponse({ data: [{
      eventId: 'btc-5m-1', symbol: 'BTC_USDT', period: '5min',
      startTime: '2026-08-22T01:30:00.000Z', endTime: '2026-08-22T01:35:00.000Z',
      outcomes: [
        { id: 'up-contract', name: 'Up', asks: [[0.57, 20], [0.58, 30]] },
        { id: 'down-contract', name: 'Down', asks: [[0.44, 12]] }
      ]
    }] })

    expect(source.getLatestWindows()[0]).toMatchObject({ venueId: 'GATE', marketId: 'btc-5m-1', durationMinutes: 5, feeVerified: false })
    expect(source.getLatestWindows()[0].outcomes.UP).toMatchObject({ outcomeId: 'up-contract', bestAsk: '0.57', askSize: '20' })
    expect(source.getLatestWindows()[0].outcomes.DOWN?.bestAsk).toBe('0.44')
    expect(source.getLatestWindows()[0].resolution).toMatchObject({ comparisonOperator: 'GTE', tieOutcome: 'UP' })
  })

  it('parses the live Gate contract-events list shape without inventing depth', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_787_328_840_000))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    await source.fetchWindows()
    capture.emitResponse({ code: 0, data: { list: [{
      id: '881275', event_name: 'BTC 5分钟涨或跌', crypto: 'btc', period: '5m',
      start_date: 1_787_328_600, end_date: 1_787_328_900, bullish: '0.44', bearish: '0.57',
      clob_token_ids: ['up-live-token', 'down-live-token']
    }] } })

    expect(source.getLatestWindows()[0]).toMatchObject({ marketId: '881275', startTime: 1_787_328_600_000, endTime: 1_787_328_900_000 })
    expect(source.getLatestWindows()[0].outcomes.UP).toMatchObject({ outcomeId: 'up-live-token', bestAsk: '0.44', askSize: '0' })
    expect(source.getLatestWindows()[0].outcomes.DOWN).toMatchObject({ outcomeId: 'down-live-token', bestAsk: '0.57', askSize: '0' })
  })

  it('uses event duration instead of timezone-ambiguous detail creation dates', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_787_328_840_000))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    await source.fetchWindows()
    capture.emitResponse({ code: 0, data: {
      id: '881275', slug: 'btc-updown-5m-1787328600', game_start_time: '2026-08-21 16:10:00', end_date: 1_787_328_900,
      markets: [{ best_ask: 0.49, best_ask_token1: 0.54, clob_token_ids: ['up-detail', 'down-detail'] }]
    } })
    expect(source.getLatestWindows()[0]).toMatchObject({ startTime: 1_787_328_600_000, endTime: 1_787_328_900_000, durationMinutes: 5 })
  })

  it('uses the active BTC 15m page context when the frame omits timestamps', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-23T09:36:00.000Z'))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    await source.fetchWindows()
    source.ingest(JSON.stringify({ eventId: '889291', symbol: 'BTC_USDT', period: '15m', outcomes: [
      { id: 'gate-up', name: 'Up', asks: [[0.51, 8]] },
      { id: 'gate-down', name: 'Down', asks: [[0.50, 9]] }
    ] }), Date.now(), 'WebSocket', 'wss://fx-ws.gateio.ws/ws', 'https://www.gate.com/zh/trade-events/btc-updown-15m?eventId=889291&outcome=Up')

    expect(source.getLatestWindows()[0]).toMatchObject({
      marketId: '889291', durationMinutes: 15,
      startTime: new Date('2026-08-23T09:30:00.000Z').getTime(),
      endTime: new Date('2026-08-23T09:45:00.000Z').getTime()
    })
  })

  it('merges later websocket order books into an existing event context', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-22T01:32:00.000Z'))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    await source.fetchWindows()
    capture.emitResponse({
      eventId: 'btc-5m-2', asset: 'BTC/USD', duration: 5,
      start_time: 1787362200, end_time: 1787362500,
      outcomes: [{ name: 'Up' }, { name: 'Down' }]
    })
    capture.emitFrame({ marketId: 'btc-5m-2', direction: 'UP', asks: [{ price: '0.61', quantity: '9' }] })
    capture.emitFrame({ marketId: 'btc-5m-2', direction: 'DOWN', asks: [{ price: '0.40', quantity: '8' }] })

    expect(source.getLatestWindows()[0].outcomes.UP?.bestAsk).toBe('0.61')
    expect(source.getLatestWindows()[0].outcomes.DOWN?.bestAsk).toBe('0.4')
    expect(source.getStatus().message).toContain('未额外请求接口')
  })

  it('binds the live Gate book query and compact orderbook frames to each outcome', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T13:17:00.000Z'))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    await source.fetchWindows()
    const pageUrl = 'https://www.gate.com/zh/trade-events/btc-updown-5m?eventId=895711&outcome=Up'

    source.ingest(JSON.stringify({ code: 0, data: {
      asks: [{ price: '0.68', size: '98.283' }], bids: [{ price: '0.52', size: '89.85' }],
      asset_id: 'up-asset', market: 'ge_895711_3807530'
    } }), Date.now(), 'REST', 'https://www.gate.com/apiw/v2/event-contract/book?event_id=895711&market_id=3807530&outcome=Up', pageUrl)
    source.ingest(JSON.stringify({ code: 0, data: {
      asks: [{ price: '0.48', size: '89.85' }], bids: [{ price: '0.32', size: '98.283' }],
      asset_id: 'down-asset', market: 'ge_895711_3807530'
    } }), Date.now(), 'REST', 'https://www.gate.com/apiw/v2/event-contract/book?event_id=895711&market_id=3807530&outcome=Down', pageUrl)

    expect(source.getLatestWindows()[0]).toMatchObject({
      marketId: '895711',
      outcomes: {
        UP: { outcomeId: 'up-asset', bestAsk: '0.68', askSize: '98.283' },
        DOWN: { outcomeId: 'down-asset', bestAsk: '0.48', askSize: '89.85' }
      }
    })

    vi.setSystemTime(new Date('2026-08-24T13:17:02.000Z'))
    source.ingest(JSON.stringify({ channel: 'predict.poly.orderbook', event: 'update', result: {
      mk: '0xmarket', aid: 'up-asset', a: [['0.67', '44.17']], b: [['0.66', '162']]
    } }), Date.now(), 'WebSocket', 'wss://prediction-ws.gateio.ws/v1/ws/prediction/event-contract/web', pageUrl)
    source.ingest(JSON.stringify({ channel: 'predict.poly.orderbook', event: 'update', result: {
      mk: '0xmarket', aid: 'down-asset', a: [['0.34', '162']], b: [['0.33', '44.17']]
    } }), Date.now(), 'WebSocket', 'wss://prediction-ws.gateio.ws/v1/ws/prediction/event-contract/web', pageUrl)

    expect(source.getLatestWindows()[0].outcomes.UP).toMatchObject({ bestAsk: '0.67', askSize: '44.17', receivedAt: Date.now() })
    expect(source.getLatestWindows()[0].outcomes.DOWN).toMatchObject({ bestAsk: '0.34', askSize: '162', receivedAt: Date.now() })
  })

  it('maps compact websocket token IDs when Gate catalogue reports one side at 1.0', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T15:42:00.000Z'))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    await source.fetchWindows()
    const pageUrl = 'https://www.gate.com/zh/trade-events/btc-updown-5m?eventId=896000&outcome=Up'
    source.ingest(JSON.stringify({ code: 0, data: {
      id: '896000', question: 'BTC 5 Min Up or Down 23:45 (UTC+8)',
      game_start_time: '2026-08-24 15:40:00', end_date: 1787586300,
      markets: [{
        best_ask: 0.01, best_ask_token1: 1,
        clob_token_id0: 'gate-up-token', clob_token_id1: 'gate-down-token'
      }]
    } }), Date.now(), 'REST', 'https://www.gate.com/apiw/v2/event-contract/events/896000?sub_website_id=0', pageUrl)

    source.ingest(JSON.stringify({ channel: 'predict.poly.orderbook', event: 'update', result: {
      mk: '0xmarket', aid: 'gate-up-token', a: [['0.41', '98.22']]
    } }), Date.now(), 'WebSocket', 'wss://prediction-ws.gateio.ws/v1/ws/prediction/event-contract/web', pageUrl)
    source.ingest(JSON.stringify({ channel: 'predict.poly.orderbook', event: 'update', result: {
      mk: '0xmarket', aid: 'gate-down-token', a: [['0.61', '333.91']]
    } }), Date.now(), 'WebSocket', 'wss://prediction-ws.gateio.ws/v1/ws/prediction/event-contract/web', pageUrl)

    expect(source.getLatestWindows()[0]).toMatchObject({
      marketId: '896000', durationMinutes: 5,
      outcomes: {
        UP: { outcomeId: 'gate-up-token', bestAsk: '0.41', askSize: '98.22' },
        DOWN: { outcomeId: 'gate-down-token', bestAsk: '0.61', askSize: '333.91' }
      }
    })
  })

  it('refreshes quote freshness on empty incremental orderbook frames', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T15:42:00.000Z'))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    await source.fetchWindows()
    const pageUrl = 'https://www.gate.com/zh/trade-events/btc-updown-5m?eventId=896001&outcome=Up'
    const wsUrl = 'wss://prediction-ws.gateio.ws/v1/ws/prediction/event-contract/web'
    const startTime = Date.now() - 60_000
    source.ingest(JSON.stringify({ id: '896001', event_name: 'BTC 5m Up or Down', period: '5m', start_time: startTime, end_time: startTime + 300_000,
      clob_token_ids: ['gate-up-token-2', 'gate-down-token-2'] }), Date.now(), 'REST', 'https://www.gate.com/apiw/v2/event-contract/events/896001', pageUrl)
    source.ingest(JSON.stringify({ channel: 'predict.poly.orderbook', event: 'update', result: {
      aid: 'gate-up-token-2', a: [['0.41', '98.22']], b: [['0.40', '10']]
    } }), Date.now(), 'WebSocket', wsUrl, pageUrl)
    source.ingest(JSON.stringify({ channel: 'predict.poly.orderbook', event: 'update', result: {
      aid: 'gate-down-token-2', a: [['0.59', '88.22']], b: [['0.58', '10']]
    } }), Date.now(), 'WebSocket', wsUrl, pageUrl)
    const initial = source.getLatestWindows()[0].outcomes.UP
    vi.advanceTimersByTime(10_000)
    source.ingest(JSON.stringify({ channel: 'predict.poly.orderbook', event: 'update', result: {
      aid: 'gate-up-token-2', id: 'malformed-without-book-fields'
    } }), Date.now(), 'WebSocket', wsUrl, pageUrl)
    expect(source.getLatestWindows()[0].outcomes.UP?.receivedAt).toBe(initial?.receivedAt)
    source.ingest(JSON.stringify({ channel: 'predict.poly.orderbook', event: 'update', result: {
      aid: 'gate-up-token-2', a: [], b: [], id: 'book-update-2', timestamp: 1787586010000
    } }), Date.now(), 'WebSocket', wsUrl, pageUrl)

    expect(source.getLatestWindows()[0].outcomes.UP).toMatchObject({
      bestAsk: initial?.bestAsk,
      askSize: initial?.askSize,
      receivedAt: Date.now()
    })
    source.ingest(JSON.stringify({ channel: 'predict.poly.orderbook', event: 'update', result: {
      aid: 'gate-up-token-2', a: [['0.41', '0']], b: [], id: 'book-update-3'
    } }), Date.now(), 'WebSocket', wsUrl, pageUrl)
    expect(source.getLatestWindows()).toEqual([])
  })

  it('reports raw versus mapped websocket pipeline health without persisting frames', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T15:42:00.000Z'))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    await source.fetchWindows()
    source.ingest(JSON.stringify({ channel: 'predict.poly.orderbook', event: 'update', result: {
      aid: 'unmapped-gate-token', a: [['0.42', '12']], b: [['0.41', '9']]
    } }), Date.now(), 'WebSocket', 'wss://prediction-ws.gateio.ws/v1/ws/prediction/event-contract/web',
    'https://www.gate.com/zh/trade-events/btc-updown-15m?eventId=896002&outcome=Up')

    expect(source.getStatus().message).toContain('15m 原始WS 0.0秒')
    expect(source.getStatus().message).toContain('映射无')
    expect(source.getStatus().message).toContain('盘口无')
    expect(source.getStatus().message).toContain('未映射1')
  })

  it('binds websocket aid to the REST book direction through hash when catalogue IDs are absent', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T15:42:00.000Z'))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    await source.fetchWindows()
    const pageBase = 'https://www.gate.com/zh/trade-events/btc-updown-5m?eventId=896003'
    const bookUrl = 'https://www.gate.com/apiw/v2/event-contract/book?event_id=896003&market_id=3809000&outcome='
    const wsUrl = 'wss://prediction-ws.gateio.ws/v1/ws/prediction/event-contract/web'
    source.ingest(JSON.stringify({ code: 0, data: {
      hash: 'book-hash-up', asset_id: 'shared-market-asset', asks: [['0.41', '10']]
    } }), Date.now(), 'REST', `${bookUrl}Up`, `${pageBase}&outcome=Up`)
    source.ingest(JSON.stringify({ code: 0, data: {
      hash: 'book-hash-down', asset_id: 'shared-market-asset', asks: [['0.59', '11']]
    } }), Date.now(), 'REST', `${bookUrl}Down`, `${pageBase}&outcome=Down`)
    source.ingest(JSON.stringify({ channel: 'predict.poly.orderbook', event: 'update', result: {
      aid: 'ws-up-token', h: 'book-hash-up', a: [['0.40', '12']], b: []
    } }), Date.now(), 'WebSocket', wsUrl, `${pageBase}&outcome=Up`)
    source.ingest(JSON.stringify({ channel: 'predict.poly.orderbook', event: 'update', result: {
      // Reuse the aid to ensure the current book hash wins over an old aid
      // cache when Gate rotates/recycles compact token IDs.
      aid: 'ws-up-token', h: 'book-hash-down', a: [['0.60', '13']], b: []
    } }), Date.now(), 'WebSocket', wsUrl, `${pageBase}&outcome=Up`)

    expect(source.getLatestWindows()[0]).toMatchObject({
      marketId: '896003', durationMinutes: 5,
      outcomes: {
        UP: { outcomeId: 'ws-up-token', bestAsk: '0.4', askSize: '12' },
        DOWN: { outcomeId: 'ws-up-token', bestAsk: '0.6', askSize: '13' }
      }
    })
  })

  it('maps the real base-page book responses by market key when eventId is absent from the page URL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T15:42:00.000Z'))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    await source.fetchWindows()
    const pageUrl = 'https://www.gate.com/zh/trade-events/btc-updown-15m'
    const wsUrl = 'wss://prediction-ws.gateio.ws/v1/ws/prediction/event-contract/web'
    source.ingest(JSON.stringify({ code: 0, data: {
      hash: 'rest-hash-up', asset_id: 'rest-up-token', market: 'ge_896004_3810000',
      asks: [['0.41', '10']], bids: []
    } }), Date.now(), 'REST', 'https://www.gate.com/apiw/v2/event-contract/book?market_id=3810000&outcome=Up', pageUrl)
    source.ingest(JSON.stringify({ code: 0, data: {
      hash: 'rest-hash-down', asset_id: 'rest-down-token', market: 'ge_896004_3810000',
      asks: [['0.59', '11']], bids: []
    } }), Date.now(), 'REST', 'https://www.gate.com/apiw/v2/event-contract/book?market_id=3810000&outcome=Down', pageUrl)
    source.ingest(JSON.stringify({ result: {
      mk: 'ge_896004_3810000', aid: 'rest-up-token', h: 'ws-sequence-not-rest-hash',
      a: [['0.40', '12']], b: []
    } }), Date.now(), 'WebSocket', wsUrl, pageUrl)
    source.ingest(JSON.stringify({ result: {
      mk: 'ge_896004_3810000', aid: 'rest-down-token', h: 'ws-sequence-not-rest-hash-2',
      a: [['0.60', '13']], b: []
    } }), Date.now(), 'WebSocket', wsUrl, pageUrl)

    expect(source.getLatestWindows()[0]).toMatchObject({
      marketId: 'ge_896004_3810000', durationMinutes: 15,
      outcomes: {
        UP: { outcomeId: 'rest-up-token', bestAsk: '0.4', askSize: '12' },
        DOWN: { outcomeId: 'rest-down-token', bestAsk: '0.6', askSize: '13' }
      }
    })
    expect(source.getStatus().message).toContain('REST hash 2/2·方向2')
    expect(source.getStatus().message).toContain('WS h 2·命中0')
    expect(source.getStatus().message).toContain('aid 2·命中2')
    expect(source.getStatus().message).toContain('mk 2·命中2')
  })

  it('learns the shared websocket market key and maps a rotated aid on the same 15m page', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T15:42:00.000Z'))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    await source.fetchWindows()
    const pageUrl = 'https://www.gate.com/zh/trade-events/btc-updown-15m'
    const wsUrl = 'wss://prediction-ws.gateio.ws/v1/ws/prediction/event-contract/web'
    source.ingest(JSON.stringify({ data: {
      hash: 'rest-hash-up-rotated', asset_id: 'rest-up-rotated', market: 'ge_896007_3810000', asks: [['0.41', '10']], bids: []
    } }), Date.now(), 'REST', 'https://www.gate.com/apiw/v2/event-contract/book?event_id=896007&outcome=Up', pageUrl)
    source.ingest(JSON.stringify({ data: {
      hash: 'rest-hash-down-rotated', asset_id: 'rest-down-rotated', market: 'ge_896007_3810000', asks: [['0.59', '11']], bids: []
    } }), Date.now(), 'REST', 'https://www.gate.com/apiw/v2/event-contract/book?event_id=896007&outcome=Down', pageUrl)
    source.ingest(JSON.stringify({ result: {
      mk: '0xshared-rotated', aid: 'rest-up-rotated', a: [['0.41', '10']], b: []
    } }), Date.now(), 'WebSocket', wsUrl, pageUrl)
    source.ingest(JSON.stringify({ result: {
      mk: '0xshared-rotated', aid: 'rest-down-rotated', a: [['0.59', '11']], b: []
    } }), Date.now(), 'WebSocket', wsUrl, pageUrl)
    source.ingest(JSON.stringify({ result: {
      mk: '0xshared-rotated', aid: 'new-up-rotated', a: [['0.42', '15']], b: []
    } }), Date.now(), 'WebSocket', wsUrl, pageUrl)

    expect(source.getLatestWindows()[0].outcomes.UP).toMatchObject({ outcomeId: 'new-up-rotated', bestAsk: '0.42', askSize: '15' })
    expect(source.getStatus().message).toContain('未映射0')
  })

  it('maps websocket aid directly from the REST asset id when market key and hash are absent', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T15:42:00.000Z'))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    await source.fetchWindows()
    const pageUrl = 'https://www.gate.com/zh/trade-events/btc-updown-15m'
    const wsUrl = 'wss://prediction-ws.gateio.ws/v1/ws/prediction/event-contract/web'
    source.ingest(JSON.stringify({ code: 0, data: {
      market: 'ge_896006_3810000', asset_id: 'rest-only-up-token', asks: [], bids: []
    } }), Date.now(), 'REST', 'https://www.gate.com/apiw/v2/event-contract/book?event_id=896006&market_id=3810000&outcome=Up', pageUrl)
    source.ingest(JSON.stringify({ code: 0, data: {
      market: 'ge_896006_3810000', asset_id: 'rest-only-down-token', asks: [], bids: []
    } }), Date.now(), 'REST', 'https://www.gate.com/apiw/v2/event-contract/book?event_id=896006&market_id=3810000&outcome=Down', pageUrl)
    source.ingest(JSON.stringify({ result: {
      aid: 'rest-only-up-token', a: [['0.40', '12']], b: []
    } }), Date.now(), 'WebSocket', wsUrl, pageUrl)
    source.ingest(JSON.stringify({ result: {
      aid: 'rest-only-down-token', a: [['0.60', '13']], b: []
    } }), Date.now(), 'WebSocket', wsUrl, pageUrl)

    expect(source.getLatestWindows()[0]).toMatchObject({
      marketId: '896006', durationMinutes: 15,
      outcomes: {
        UP: { outcomeId: 'rest-only-up-token', bestAsk: '0.4', askSize: '12' },
        DOWN: { outcomeId: 'rest-only-down-token', bestAsk: '0.6', askSize: '13' }
      }
    })
  })

  it('uses a unique websocket market key as a safe fallback when aid and hash differ', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T15:42:00.000Z'))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    await source.fetchWindows()
    const pageUrl = 'https://www.gate.com/zh/trade-events/btc-updown-15m'
    const wsUrl = 'wss://prediction-ws.gateio.ws/v1/ws/prediction/event-contract/web'
    source.ingest(JSON.stringify({ code: 0, data: {
      hash: 'rest-hash-up', asset_id: 'rest-up-token', market: 'ge_896005_up', asks: [['0.41', '10']], bids: []
    } }), Date.now(), 'REST', 'https://www.gate.com/apiw/v2/event-contract/book?event_id=896005&outcome=Up', pageUrl)
    source.ingest(JSON.stringify({ code: 0, data: {
      hash: 'rest-hash-down', asset_id: 'rest-down-token', market: 'ge_896005_down', asks: [['0.59', '11']], bids: []
    } }), Date.now(), 'REST', 'https://www.gate.com/apiw/v2/event-contract/book?event_id=896005&outcome=Down', pageUrl)
    source.ingest(JSON.stringify({ result: {
      mk: 'ge_896005_up', aid: 'ws-up-token', h: 'ws-hash-up', a: [['0.40', '12']], b: []
    } }), Date.now(), 'WebSocket', wsUrl, pageUrl)
    source.ingest(JSON.stringify({ result: {
      mk: 'ge_896005_down', aid: 'ws-down-token', h: 'ws-hash-down', a: [['0.60', '13']], b: []
    } }), Date.now(), 'WebSocket', wsUrl, pageUrl)

    expect(source.getLatestWindows()[0]).toMatchObject({
      marketId: '896005', durationMinutes: 15,
      outcomes: {
        UP: { outcomeId: 'ws-up-token', bestAsk: '0.4', askSize: '12' },
        DOWN: { outcomeId: 'ws-down-token', bestAsk: '0.6', askSize: '13' }
      }
    })
    expect(source.getStatus().message).toContain('aid 2·命中0')
    expect(source.getStatus().message).toContain('mk 2·命中2')
  })

  it('maps subscribed websocket tokens to Gate directions by matching the REST book prices', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T04:30:00.000Z'))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    await source.fetchWindows()
    const pageUrl = 'https://www.gate.com/zh/trade-events/btc-updown-5m?eventId=899715&outcome=Up'
    const bookUrl = 'https://www.gate.com/apiw/v2/event-contract/book?event_id=899715&market_id=3830934&outcome='
    source.ingest(JSON.stringify({ code: 0, data: {
      hash: '1787632286.505', asset_id: 'ge_899715_3830934', market: 'ge_899715_3830934', asks: [{ price: '0.17', size: '14.236' }]
    } }), Date.now(), 'REST', `${bookUrl}Up`, pageUrl)
    source.ingest(JSON.stringify({ code: 0, data: {
      hash: '1787632286.514', asset_id: 'ge_899715_3830934', market: 'ge_899715_3830934', asks: [{ price: '0.84', size: '36.53' }]
    } }), Date.now(), 'REST', `${bookUrl}Down`, pageUrl)
    capture.emitFrame({ channel: 'predict.poly.orderbook', event: 'subscribe', id: 4, payload: ['poly-up-token'] }, { direction: 'SENT', pageUrl })
    capture.emitFrame({ channel: 'predict.poly.orderbook', event: 'subscribe', id: 5, payload: ['poly-down-token'] }, { direction: 'SENT', pageUrl })
    capture.emitFrame({ channel: 'predict.poly.orderbook', event: 'update', result: {
      aid: 'poly-up-token', mk: '0xcondition', h: 'book-digest-up', a: [['0.18', '20']], b: []
    } }, { direction: 'RECEIVED', pageUrl })
    capture.emitFrame({ channel: 'predict.poly.orderbook', event: 'update', result: {
      aid: 'poly-down-token', mk: '0xcondition', h: 'book-digest-down', a: [['0.83', '30']], b: []
    } }, { direction: 'RECEIVED', pageUrl })

    expect(source.getLatestWindows()[0]).toMatchObject({
      marketId: '899715',
      outcomes: {
        UP: { outcomeId: 'poly-up-token', bestAsk: '0.18', askSize: '20' },
        DOWN: { outcomeId: 'poly-down-token', bestAsk: '0.83', askSize: '30' }
      }
    })
  })

  it('matches both subscribed tokens jointly when Gate prices are close to fifty cents', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T04:35:00.000Z'))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    await source.fetchWindows()
    const pageUrl = 'https://www.gate.com/zh/trade-events/btc-updown-5m?eventId=899735&outcome=Up'
    const bookUrl = 'https://www.gate.com/apiw/v2/event-contract/book?event_id=899735&market_id=3830986&outcome='
    source.ingest(JSON.stringify({ data: { asset_id: 'ge_899735_3830986', market: 'ge_899735_3830986', asks: [{ price: '0.52', size: '100' }] } }), Date.now(), 'REST', `${bookUrl}Up`, pageUrl)
    source.ingest(JSON.stringify({ data: { asset_id: 'ge_899735_3830986', market: 'ge_899735_3830986', asks: [{ price: '0.51', size: '90' }] } }), Date.now(), 'REST', `${bookUrl}Down`, pageUrl)
    capture.emitFrame({ channel: 'predict.poly.orderbook', event: 'subscribe', payload: ['close-token-a'] }, { direction: 'SENT', pageUrl })
    capture.emitFrame({ channel: 'predict.poly.orderbook', event: 'subscribe', payload: ['close-token-b'] }, { direction: 'SENT', pageUrl })
    capture.emitFrame({ result: { aid: 'close-token-a', a: [['0.52', '80']], b: [] } }, { direction: 'RECEIVED', pageUrl })
    capture.emitFrame({ result: { aid: 'close-token-b', a: [['0.51', '70']], b: [] } }, { direction: 'RECEIVED', pageUrl })

    expect(source.getLatestWindows()[0].outcomes).toMatchObject({
      UP: { outcomeId: 'close-token-a', bestAsk: '0.52' },
      DOWN: { outcomeId: 'close-token-b', bestAsk: '0.51' }
    })
  })

  it('keeps the catalogue directions when websocket prices cannot be safely correlated', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T04:40:00.000Z'))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    await source.fetchWindows()
    const pageUrl = 'https://www.gate.com/zh/trade-events/btc-updown-5m?eventId=899852&outcome=Up'
    const bookUrl = 'https://www.gate.com/apiw/v2/event-contract/book?event_id=899852&market_id=3831000&outcome='
    source.ingest(JSON.stringify({ data: { asset_id: 'ge_899852_3831000', market: 'ge_899852_3831000', asks: [{ price: '0.28', size: '100' }] } }), Date.now(), 'REST', `${bookUrl}Up`, pageUrl)
    source.ingest(JSON.stringify({ data: { asset_id: 'ge_899852_3831000', market: 'ge_899852_3831000', asks: [{ price: '0.73', size: '90' }] } }), Date.now(), 'REST', `${bookUrl}Down`, pageUrl)
    capture.emitFrame({ channel: 'predict.poly.orderbook', event: 'subscribe', payload: ['moving-up-token'] }, { direction: 'SENT', pageUrl })
    capture.emitFrame({ channel: 'predict.poly.orderbook', event: 'subscribe', payload: ['moving-down-token'] }, { direction: 'SENT', pageUrl })
    capture.emitFrame({ result: { aid: 'moving-up-token', a: [['0.42', '80']], b: [] } }, { direction: 'RECEIVED', pageUrl })
    capture.emitFrame({ result: { aid: 'moving-down-token', a: [['0.59', '70']], b: [] } }, { direction: 'RECEIVED', pageUrl })

    expect(source.getLatestWindows()[0].outcomes).toMatchObject({
      UP: { outcomeId: 'ge_899852_3831000', bestAsk: '0.28' },
      DOWN: { outcomeId: 'ge_899852_3831000', bestAsk: '0.73' }
    })
    expect(source.getStatus().message).toContain('未映射2')
  })

  it('refreshes stream observation time when Gate sends an unchanged heartbeat frame', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T04:45:00.000Z'))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    await source.fetchWindows()
    const pageUrl = 'https://www.gate.com/zh/trade-events/btc-updown-5m?eventId=899860&outcome=Up'
    const bookUrl = 'https://www.gate.com/apiw/v2/event-contract/book?event_id=899860&market_id=3831010&outcome='
    source.ingest(JSON.stringify({ data: { asset_id: 'ge_899860_3831010', market: 'ge_899860_3831010', asks: [{ price: '0.40', size: '10' }] } }), Date.now(), 'REST', `${bookUrl}Up`, pageUrl)
    source.ingest(JSON.stringify({ data: { asset_id: 'ge_899860_3831010', market: 'ge_899860_3831010', asks: [{ price: '0.60', size: '11' }] } }), Date.now(), 'REST', `${bookUrl}Down`, pageUrl)
    const originalReceivedAt = source.getLatestWindows()[0].outcomes.UP!.receivedAt
    vi.advanceTimersByTime(23_000)
    capture.emitFrame({ channel: 'predict.poly.orderbook', event: 'heartbeat' }, { direction: 'RECEIVED', pageUrl })

    expect(source.getLatestWindows()[0].outcomes.UP).toMatchObject({ receivedAt: originalReceivedAt, observedAt: Date.now() })
    expect(source.getLatestWindows()[0].outcomes.DOWN?.observedAt).toBe(Date.now())
  })

  it('maps Gate websocket market_id tokens and removes an expired round on refresh', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-23T12:32:00.000Z'))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    await source.fetchWindows()
    source.ingest(JSON.stringify({ code: 0, data: { list: [{
      id: 'gate-current', event_name: 'BTC 5分钟涨或跌', crypto: 'btc', period: '5m',
      start_date: 1_787_488_200, end_date: 1_787_488_500,
      bullish: '0.55', bearish: '0.46', clob_token_ids: ['gate-up-token', 'gate-down-token']
    }] } }), Date.now(), 'REST', 'https://www.gate.com/api/event/markets')
    source.ingest(JSON.stringify({ market_id: 'gate-up-token', asks: [[0.54, 14]] }), Date.now(), 'WebSocket')
    source.ingest(JSON.stringify({ market_id: 'gate-down-token', asks: [[0.47, 16]] }), Date.now(), 'WebSocket')

    expect(source.getLatestWindows()[0].outcomes.UP).toMatchObject({ bestAsk: '0.54', askSize: '14' })
    expect(source.getLatestWindows()[0].outcomes.DOWN).toMatchObject({ bestAsk: '0.47', askSize: '16' })

    vi.setSystemTime(new Date('2026-08-23T12:36:00.000Z'))
    expect(await source.fetchWindows()).toEqual([])
    expect(source.getStatus().marketCount).toBe(0)
  })

  it('parses localized Gate depth outcomes and compact ask levels', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-23T12:32:00.000Z'))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    await source.fetchWindows()
    source.ingest(JSON.stringify({ eventId: 'gate-zh', event_name: 'BTC 15分钟涨或跌', period: '15m',
      start_date: 1_787_488_200, end_date: 1_787_489_100,
      bullish: '0.55', bearish: '0.46', clob_token_ids: ['zh-up', 'zh-down'],
      outcomes: [{ id: 'zh-up', name: '上涨' }, { id: 'zh-down', name: '下跌' }] }), Date.now(), 'REST', 'https://www.gate.com/zh/trade-events')
    source.ingest(JSON.stringify({ eventId: 'gate-zh', outcomes: [
      { id: 'zh-up', name: '上涨', a: [[0.51, 12]] },
      { id: 'zh-down', name: '下跌', a: [[0.48, 13]] }
    ] }), Date.now(), 'WebSocket')

    expect(parseGateMarketObject({ eventId: 'gate-zh', event_name: 'BTC 15分钟涨或跌', period: '15m',
      start_date: 1_787_488_200, end_date: 1_787_489_100,
      outcomes: [{ id: 'zh-up', name: '上涨', a: [[0.51, 12]] }, { id: 'zh-down', name: '下跌', a: [[0.48, 13]] }] }, Date.now())).toMatchObject({
      outcomes: { UP: { bestAsk: '0.51' }, DOWN: { bestAsk: '0.48' } }
    })

    expect(source.getLatestWindows()[0].outcomes.UP).toMatchObject({ bestAsk: '0.51', askSize: '12' })
    expect(source.getLatestWindows()[0].outcomes.DOWN).toMatchObject({ bestAsk: '0.48', askSize: '13' })
  })

  it('prefers an explicit outcome label over an ambiguous numeric index', () => {
    const parsed = parseGateMarketObject({
      eventId: 'gate-index-label-conflict', event_name: 'BTC 15分钟涨或跌', period: '15m',
      start_date: 1_787_488_200, end_date: 1_787_489_100,
      outcomes: [
        { id: 'label-up', index: 0, name: 'Up', asks: [[0.41, 10]] },
        // Gate has emitted zero-based indices in this shape; index 1 is DOWN.
        { id: 'label-down', index: 1, name: 'Down', asks: [[0.59, 11]] }
      ]
    }, Date.now())

    expect(parsed?.outcomes).toMatchObject({
      UP: { outcomeId: 'label-up', bestAsk: '0.41' },
      DOWN: { outcomeId: 'label-down', bestAsk: '0.59' }
    })
  })

  it('does not trust page tab order when subscribed Gate tokens arrive reversed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T05:00:00.000Z'))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    await source.fetchWindows()
    const pageUrl = 'https://www.gate.com/zh/trade-events/btc-updown-15m?eventId=899900&outcome=Up'
    const wsUrl = 'wss://prediction-ws.gateio.ws/v1/ws/prediction/event-contract/web'
    source.ingest(JSON.stringify({ data: {
      id: '899900', event_name: 'BTC 15分钟涨或跌', crypto: 'btc', period: '15m',
      start_date: 1_787_634_600, end_date: 1_787_635_500,
      bullish: '0.28', bearish: '0.73'
    } }), Date.now(), 'REST', 'https://www.gate.com/apiw/v2/event-contract/events/899900', pageUrl)

    // Gate may send the DOWN token first even though the page tab is Up.
    capture.emitFrame({ channel: 'predict.poly.orderbook', event: 'subscribe', payload: ['token-down-first'] }, { direction: 'SENT', pageUrl })
    capture.emitFrame({ channel: 'predict.poly.orderbook', event: 'subscribe', payload: ['token-up-second'] }, { direction: 'SENT', pageUrl })
    capture.emitFrame({ result: { aid: 'token-down-first', a: [['0.73', '20']], b: [] } }, { direction: 'RECEIVED', pageUrl })
    capture.emitFrame({ result: { aid: 'token-up-second', a: [['0.28', '21']], b: [] } }, { direction: 'RECEIVED', pageUrl })

    expect(source.getLatestWindows()[0].outcomes).toMatchObject({
      UP: { outcomeId: 'token-up-second', bestAsk: '0.28' },
      DOWN: { outcomeId: 'token-down-first', bestAsk: '0.73' }
    })
  })

  it('does not let a late shallow event snapshot overwrite websocket depth', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T05:30:00.000Z'))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    await source.fetchWindows()
    const pageUrl = 'https://www.gate.com/zh/trade-events/btc-updown-15m?eventId=899901&outcome=Up'
    const wsUrl = 'wss://prediction-ws.gateio.ws/v1/ws/prediction/event-contract/web'
    const event = {
      data: { id: '899901', event_name: 'BTC 15分钟涨或跌', crypto: 'btc', period: '15m',
        start_date: 1_787_636_400, end_date: 1_787_637_300,
        bullish: '0.28', bearish: '0.73', clob_token_ids: ['stable-up', 'stable-down'] }
    }
    source.ingest(JSON.stringify(event), Date.now(), 'REST', 'https://www.gate.com/apiw/v2/event-contract/events/899901', pageUrl)
    source.ingest(JSON.stringify({ result: { aid: 'stable-up', a: [['0.29', '40']], b: [] } }), Date.now(), 'WebSocket', wsUrl, pageUrl)
    source.ingest(JSON.stringify({ result: { aid: 'stable-down', a: [['0.72', '41']], b: [] } }), Date.now(), 'WebSocket', wsUrl, pageUrl)

    // A delayed catalogue response contains only shallow prices, not the
    // current orderbook. It must not erase the live WS depth.
    source.ingest(JSON.stringify(event), Date.now() + 5_000, 'REST', 'https://www.gate.com/apiw/v2/event-contract/events/899901', pageUrl)

    expect(source.getLatestWindows()[0].outcomes).toMatchObject({
      UP: { outcomeId: 'stable-up', bestAsk: '0.29', askSize: '40', levels: [{ price: '0.29', size: '40' }] },
      DOWN: { outcomeId: 'stable-down', bestAsk: '0.72', askSize: '41', levels: [{ price: '0.72', size: '41' }] }
    })
  })

  it('does not infer a rotated token as the opposite of an old token when prices drift', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T06:00:00.000Z'))
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    await source.fetchWindows()
    const pageUrl = 'https://www.gate.com/zh/trade-events/btc-updown-15m?eventId=899902&outcome=Up'
    const wsUrl = 'wss://prediction-ws.gateio.ws/v1/ws/prediction/event-contract/web'
    source.ingest(JSON.stringify({ data: {
      id: '899902', event_name: 'BTC 15分钟涨或跌', crypto: 'btc', period: '15m',
      start_date: 1_787_638_200, end_date: 1_787_639_100, bullish: '0.28', bearish: '0.73'
    } }), Date.now(), 'REST', 'https://www.gate.com/apiw/v2/event-contract/events/899902', pageUrl)
    capture.emitFrame({ channel: 'predict.poly.orderbook', event: 'subscribe', payload: ['old-up', 'old-down'] }, { direction: 'SENT', pageUrl })
    capture.emitFrame({ result: { mk: 'shared-condition', aid: 'old-up', a: [['0.28', '10']], b: [] } }, { direction: 'RECEIVED', pageUrl })
    capture.emitFrame({ result: { mk: 'shared-condition', aid: 'old-down', a: [['0.73', '11']], b: [] } }, { direction: 'RECEIVED', pageUrl })

    // Both IDs rotate and the UP price has moved beyond the catalogue
    // correlation tolerance. The new token must remain unmapped, not be
    // guessed as DOWN from the old token cache.
    capture.emitFrame({ result: { mk: 'shared-condition', aid: 'new-up', a: [['0.42', '12']], b: [] } }, { direction: 'RECEIVED', pageUrl })

    expect(source.getLatestWindows()[0].outcomes.DOWN?.outcomeId).not.toBe('new-up')
  })

  it('counts event positions and orders only from passive account response URLs', async () => {
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    source.ingest(JSON.stringify({ data: [{ id: 1 }, { id: 2 }] }), Date.now(), 'REST', 'https://api.gateio.ws/event-contract/positions')
    source.ingest(JSON.stringify({ orders: [{ id: 3 }] }), Date.now(), 'REST', 'https://api.gateio.ws/event-contract/open-orders')
    expect(source.getCapturedAccountSnapshot()).toMatchObject({ positionCount: 2, openOrderCount: 1 })
  })
})
