import { describe, expect, it } from 'vitest'
import { isGateEventResponse, isGateHost } from './gate-page-capture'

describe('Gate page capture allowlist', () => {
  it('accepts only Gate-owned hosts and event-contract responses', () => {
    expect(isGateHost('https://www.gate.com/trade-events')).toBe(true)
    expect(isGateHost('wss://fx-ws.gateio.ws/v4/ws/usdt')).toBe(true)
    expect(isGateHost('https://gate.com.evil.example/event')).toBe(false)
    expect(isGateEventResponse('https://api.gateio.ws/api/v4/event_contract/markets')).toBe(true)
    expect(isGateEventResponse('https://api.gateio.ws/api/v4/spot/orders')).toBe(false)
    expect(isGateEventResponse('https://example.com/event_contract/markets')).toBe(false)
  })
})
