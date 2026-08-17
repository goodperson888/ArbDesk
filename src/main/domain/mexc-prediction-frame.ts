import type { OrderBookLevel } from '../../shared/types'

export interface MexcPredictionDepthFrame {
  channel: string
  symbolId: string
  asks: OrderBookLevel[]
  bids: OrderBookLevel[]
  version?: string
}

export interface MexcPredictionIndexFrame {
  channel: string
  price: string
  priceTime?: number
  periodSeconds?: number
}

export interface MexcPredictionFrame {
  channel: string
  depth?: MexcPredictionDepthFrame
  index?: MexcPredictionIndexFrame
}

class ProtobufReader {
  position = 0
  readonly bytes: Uint8Array

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  get remaining(): number {
    return this.bytes.length - this.position
  }

  readVarint(): number {
    let value = 0
    let multiplier = 1
    for (let index = 0; index < 10; index += 1) {
      if (this.position >= this.bytes.length) throw new Error('Unexpected end of protobuf varint')
      const byte = this.bytes[this.position++]
      value += (byte & 0x7f) * multiplier
      if ((byte & 0x80) === 0) return value
      multiplier *= 128
    }
    throw new Error('Invalid protobuf varint')
  }

  readBytes(): Uint8Array {
    const length = this.readVarint()
    const end = this.position + length
    if (!Number.isSafeInteger(length) || length < 0 || end > this.bytes.length) {
      throw new Error('Invalid protobuf length')
    }
    const value = this.bytes.subarray(this.position, end)
    this.position = end
    return value
  }

  readString(): string {
    return new TextDecoder().decode(this.readBytes())
  }

  skip(wireType: number): void {
    if (wireType === 0) {
      this.readVarint()
      return
    }
    if (wireType === 1) {
      this.position += 8
      return
    }
    if (wireType === 2) {
      this.readBytes()
      return
    }
    if (wireType === 5) {
      this.position += 4
      return
    }
    throw new Error(`Unsupported protobuf wire type ${wireType}`)
  }
}

function decodeDepthItem(bytes: Uint8Array): OrderBookLevel | undefined {
  const reader = new ProtobufReader(bytes)
  let price = ''
  let size = ''
  while (reader.remaining > 0) {
    const tag = reader.readVarint()
    const field = tag >>> 3
    const wireType = tag & 7
    if (field === 1 && wireType === 2) price = reader.readString()
    else if (field === 2 && wireType === 2) size = reader.readString()
    else reader.skip(wireType)
  }
  return Number(price) > 0 && Number(size) > 0 ? { price, size } : undefined
}

function decodeDepth(bytes: Uint8Array): { asks: OrderBookLevel[]; bids: OrderBookLevel[]; version?: string } {
  const reader = new ProtobufReader(bytes)
  const asks: OrderBookLevel[] = []
  const bids: OrderBookLevel[] = []
  let version: string | undefined
  while (reader.remaining > 0) {
    const tag = reader.readVarint()
    const field = tag >>> 3
    const wireType = tag & 7
    if ((field === 1 || field === 2) && wireType === 2) {
      const item = decodeDepthItem(reader.readBytes())
      if (item) (field === 1 ? asks : bids).push(item)
    } else if (field === 3 && wireType === 2) {
      version = reader.readString()
    } else {
      reader.skip(wireType)
    }
  }
  return { asks, bids, version }
}

function decodeIndex(bytes: Uint8Array): { price?: string; priceTime?: number } {
  const reader = new ProtobufReader(bytes)
  let price: string | undefined
  let priceTime: number | undefined
  while (reader.remaining > 0) {
    const tag = reader.readVarint()
    const field = tag >>> 3
    const wireType = tag & 7
    if (field === 3 && wireType === 0) priceTime = reader.readVarint()
    else if (field === 4 && wireType === 2) price = reader.readString()
    else reader.skip(wireType)
  }
  return { price, priceTime }
}

export function decodeMexcPredictionFrame(bytes: Uint8Array): MexcPredictionFrame | undefined {
  try {
    const reader = new ProtobufReader(bytes)
    let channel = ''
    let symbolId = ''
    let depthBytes: Uint8Array | undefined
    let indexBytes: Uint8Array | undefined
    while (reader.remaining > 0) {
      const tag = reader.readVarint()
      const field = tag >>> 3
      const wireType = tag & 7
      if (field === 1 && wireType === 2) channel = reader.readString()
      else if (field === 3 && wireType === 2) symbolId = reader.readString()
      else if (field === 217 && wireType === 2) depthBytes = reader.readBytes()
      else if ((field === 226 || field === 227) && wireType === 2) indexBytes = reader.readBytes()
      else reader.skip(wireType)
    }
    if (!channel.startsWith('predict@')) return undefined

    const depthMatch = channel.match(/^predict@public\.depth\.scale\.pb@([^@]+)@/)
    if (depthBytes && depthMatch) {
      const decoded = decodeDepth(depthBytes)
      const resolvedSymbolId = symbolId || depthMatch[1]
      return {
        channel,
        depth: {
          channel,
          symbolId: resolvedSymbolId,
          asks: decoded.asks.sort((left, right) => Number(left.price) - Number(right.price)),
          bids: decoded.bids.sort((left, right) => Number(right.price) - Number(left.price)),
          version: decoded.version
        }
      }
    }

    if (indexBytes && /predict@public\.index\.(?:period\.)?realtime/.test(channel)) {
      const decoded = decodeIndex(indexBytes)
      if (!decoded.price || Number(decoded.price) <= 0) return { channel }
      const period = channel.match(/@BTC@(\d+)$/)
      return {
        channel,
        index: {
          channel,
          price: decoded.price,
          priceTime: decoded.priceTime,
          periodSeconds: period ? Number(period[1]) : undefined
        }
      }
    }

    return { channel }
  } catch {
    return undefined
  }
}
