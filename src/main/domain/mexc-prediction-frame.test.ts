import { describe, expect, it } from 'vitest'
import { decodeMexcPredictionFrame } from './mexc-prediction-frame'

function varint(value: number): number[] {
  const bytes: number[] = []
  let remaining = value
  while (remaining >= 128) {
    bytes.push((remaining % 128) | 0x80)
    remaining = Math.floor(remaining / 128)
  }
  bytes.push(remaining)
  return bytes
}

function fieldBytes(field: number, value: Uint8Array): number[] {
  return [...varint((field << 3) | 2), ...varint(value.length), ...value]
}

function fieldString(field: number, value: string): number[] {
  return fieldBytes(field, new TextEncoder().encode(value))
}

function fieldVarint(field: number, value: number): number[] {
  return [...varint(field << 3), ...varint(value)]
}

describe('MEXC prediction websocket decoder', () => {
  it('decodes full depth frames', () => {
    const ask = new Uint8Array([...fieldString(1, '0.49'), ...fieldString(2, '12.5')])
    const bid = new Uint8Array([...fieldString(1, '0.48'), ...fieldString(2, '9')])
    const depth = new Uint8Array([
      ...fieldBytes(1, ask),
      ...fieldBytes(2, bid),
      ...fieldString(3, '123456')
    ])
    const channel = 'predict@public.depth.scale.pb@symbol-up@0.01@30'
    const frame = new Uint8Array([
      ...fieldString(1, channel),
      ...fieldString(3, 'symbol-up'),
      ...fieldBytes(217, depth)
    ])

    expect(decodeMexcPredictionFrame(frame)).toEqual({
      channel,
      depth: {
        channel,
        symbolId: 'symbol-up',
        asks: [{ price: '0.49', size: '12.5' }],
        bids: [{ price: '0.48', size: '9' }],
        version: '123456'
      }
    })
  })

  it('decodes period index frames', () => {
    const index = new Uint8Array([
      ...fieldString(1, 'BTC'),
      ...fieldVarint(3, 1_234_567),
      ...fieldString(4, '64000.25')
    ])
    const channel = 'predict@public.index.realtime.period.pb@BTC@300'
    const frame = new Uint8Array([
      ...fieldString(1, channel),
      ...fieldBytes(227, index)
    ])

    expect(decodeMexcPredictionFrame(frame)).toEqual({
      channel,
      index: {
        channel,
        price: '64000.25',
        priceTime: 1_234_567,
        periodSeconds: 300
      }
    })
  })
})
