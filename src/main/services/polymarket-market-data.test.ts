import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyPolymarketStreamEvent, PolymarketMarketData, type PolymarketWindowQuote } from './polymarket-market-data'

afterEach(() => vi.unstubAllGlobals())

describe('PolymarketMarketData', () => {
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
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('gamma-api')) {
        return Response.json({
          markets: [{ active: true, closed: false, outcomes: '["Up","Down"]', clobTokenIds: '["token-up","token-down"]', feeSchedule: { rate: 0.05 } }]
        })
      }
      if (url.includes('/book?token_id=token-up')) {
        return Response.json({ timestamp: String(Date.now()), asks: [{ price: '0.55', size: '12' }, { price: '0.50', size: '8' }] })
      }
      if (url.includes('/book?token_id=token-down')) {
        return Response.json({ timestamp: String(Date.now()), asks: [{ price: '0.48', size: '6' }] })
      }
      return Response.json({ base_fee: 700 })
    }))

    const service = new PolymarketMarketData({ enableStreaming: false })
    const windows = await service.fetchWindows([{ durationMinutes: 5, startTime: 1_800_000, endTime: 2_100_000 }])

    expect(windows[0].outcomes.UP!.tokenId).toBe('token-up')
    expect(windows[0].outcomes.UP!.bestAsk).toBe('0.50')
    expect(windows[0].outcomes.DOWN!.askSize).toBe('6')
    expect(windows[0].outcomes.UP!.feeRate).toBe('0.07')
    expect(service.getStatus().connected).toBe(true)
  })

  it('reports disconnected instead of generating fallback quotes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })))
    const service = new PolymarketMarketData({ enableStreaming: false })

    await expect(service.fetchWindows([{ durationMinutes: 15, startTime: 0, endTime: 900_000 }])).rejects.toThrow('HTTP 503')
    expect(service.getStatus().connected).toBe(false)
  })

  it('applies CLOB book and incremental ask changes without a REST refresh', () => {
    const windows: PolymarketWindowQuote[] = [{
      durationMinutes: 5,
      startTime: 0,
      endTime: 300_000,
      outcomes: {
        UP: {
          direction: 'UP', tokenId: 'token-up', bestAsk: '0.50', askSize: '4',
          levels: [{ price: '0.50', size: '4' }], receivedAt: 1, feeRate: '0.07', minOrderSize: '5'
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

    expect(afterBook[0].outcomes.UP).toMatchObject({ bestAsk: '0.51', askSize: '3', minOrderSize: '6', receivedAt: 100 })
    expect(afterChange[0].outcomes.UP).toMatchObject({ bestAsk: '0.53', askSize: '8', receivedAt: 200 })
    expect(afterChange[0].outcomes.UP?.levels).toEqual([{ price: '0.53', size: '8' }])
  })
})
