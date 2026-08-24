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
  emitFrame(value: unknown): void { for (const listener of this.frames) listener({ url: 'wss://fx-ws.gateio.ws/ws', payload: JSON.stringify(value), receivedAt: Date.now() }) }
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
    expect(source.getStatus().message).toContain('未映射1')
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

  it('counts event positions and orders only from passive account response URLs', async () => {
    const capture = new FakeGateCapture()
    const source = new GateMarketData(capture)
    source.ingest(JSON.stringify({ data: [{ id: 1 }, { id: 2 }] }), Date.now(), 'REST', 'https://api.gateio.ws/event-contract/positions')
    source.ingest(JSON.stringify({ orders: [{ id: 3 }] }), Date.now(), 'REST', 'https://api.gateio.ws/event-contract/open-orders')
    expect(source.getCapturedAccountSnapshot()).toMatchObject({ positionCount: 2, openOrderCount: 1 })
  })
})
