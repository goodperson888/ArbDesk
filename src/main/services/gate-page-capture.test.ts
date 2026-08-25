import { describe, expect, it } from 'vitest'
import { gatePageDuration, gateRollDelayMs, gateWebSocketPayload, isGateBtcEventUrl, isGateEventResponse, isGateHost, selectGatePageDuration, selectGatePageUrl } from './gate-page-capture'

describe('Gate page routing', () => {
  it('accepts only Gate-owned hosts and event-contract responses', () => {
    expect(isGateHost('https://www.gate.com/trade-events')).toBe(true)
    expect(isGateHost('wss://fx-ws.gateio.ws/v4/ws/usdt')).toBe(true)
    expect(isGateHost('https://gate.com.evil.example/event')).toBe(false)
    expect(isGateEventResponse('https://api.gateio.ws/api/v4/event_contract/markets')).toBe(true)
    expect(isGateEventResponse('https://api.gateio.ws/api/v4/spot/orders')).toBe(false)
    expect(isGateEventResponse('https://example.com/event_contract/markets')).toBe(false)
  })

  it('recognizes BTC event pages for either supported duration', () => {
    expect(isGateBtcEventUrl('https://www.gate.com/zh/trade-events/btc-updown-5m')).toBe(true)
    expect(isGateBtcEventUrl('https://www.gate.com/zh/trade-events/btc-updown-15m?eventId=889291')).toBe(true)
    expect(gatePageDuration('https://www.gate.com/zh/trade-events/btc-updown-5m')).toBe(5)
    expect(gatePageDuration('https://www.gate.com/zh/trade-events/btc-updown-15m?eventId=889291')).toBe(15)
  })

  it('rejects the featured index and non-BTC event pages', () => {
    expect(isGateBtcEventUrl('https://www.gate.com/zh/trade-events')).toBe(false)
    expect(isGateBtcEventUrl('https://www.gate.com/zh/trade-events/eth-updown-15m?eventId=895454')).toBe(false)
    expect(isGateBtcEventUrl('https://evil.example/zh/trade-events/btc-updown-5m')).toBe(false)
    expect(gatePageDuration('https://www.gate.com/zh/trade-events/eth-updown-15m?eventId=895454')).toBeUndefined()
  })

  it('never falls back to the wrong duration for execution', () => {
    expect(selectGatePageDuration([15], 5)).toBeUndefined()
    expect(selectGatePageDuration([5, 15], 15)).toBe(15)
    expect(selectGatePageDuration([15], undefined)).toBe(15)
  })

  it('schedules the next passive page roll at the next five-minute boundary', () => {
    const now = new Date('2026-08-25T00:02:30.000Z').getTime()
    expect(gateRollDelayMs(now)).toBe(150_000)
    expect(gateRollDelayMs(new Date('2026-08-25T00:04:59.000Z').getTime())).toBe(1_000)
  })

  it('prefers the newest same-duration Gate tab when duplicate old event tabs exist', () => {
    expect(selectGatePageUrl([
      'https://www.gate.com/zh/trade-events/btc-updown-15m?eventId=889291&outcome=Up',
      'https://www.gate.com/zh/trade-events/btc-updown-5m?eventId=896245&outcome=Up',
      'https://www.gate.com/zh/trade-events/btc-updown-15m?eventId=896282&outcome=Up'
    ], 15)).toContain('eventId=896282')
  })

  it('reads CDP sent websocket frames from the response property', () => {
    expect(gateWebSocketPayload({ response: { opcode: 1, payloadData: '{"channel":"predict.poly.orderbook"}' } }, 'SENT'))
      .toBe('{"channel":"predict.poly.orderbook"}')
  })
})
