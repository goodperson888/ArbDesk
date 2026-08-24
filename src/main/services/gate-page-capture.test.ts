import { describe, expect, it } from 'vitest'
import { isGateBtcEventUrl, isGateEventResponse, isGateHost } from './gate-page-capture'

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
  })

  it('rejects the featured index and non-BTC event pages', () => {
    expect(isGateBtcEventUrl('https://www.gate.com/zh/trade-events')).toBe(false)
    expect(isGateBtcEventUrl('https://www.gate.com/zh/trade-events/eth-updown-15m?eventId=895454')).toBe(false)
    expect(isGateBtcEventUrl('https://evil.example/zh/trade-events/btc-updown-5m')).toBe(false)
  })
})
