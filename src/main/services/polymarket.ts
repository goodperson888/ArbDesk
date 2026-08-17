import { randomUUID } from 'node:crypto'
import type { Direction, Fill } from '../../shared/types'

export interface HedgeOrder {
  tokenId?: string
  direction: Direction
  quantity: string
  maximumPrice: string
  feeRate?: string
  feeExponent?: string
}

export interface ClosePositionOrder {
  tokenId?: string
  direction: Direction
  quantity: string
  maximumSlippage: string
}

export interface PolymarketBroker {
  hedge(order: HedgeOrder): Promise<Fill>
  closePosition(order: ClosePositionOrder): Promise<Fill>
}

export class SimulatedPolymarketBroker implements PolymarketBroker {
  async hedge(order: HedgeOrder): Promise<Fill> {
    await new Promise((resolve) => setTimeout(resolve, 240))
    return {
      venue: 'POLYMARKET',
      direction: order.direction,
      quantity: order.quantity,
      averagePrice: order.maximumPrice,
      orderId: `sim-poly-${randomUUID()}`,
      filledAt: Date.now()
    }
  }


  async closePosition(order: ClosePositionOrder): Promise<Fill> {
    await new Promise((resolve) => setTimeout(resolve, 180))
    return {
      venue: 'POLYMARKET', direction: order.direction, quantity: order.quantity,
      averagePrice: '0.5000', orderId: `sim-poly-close-${randomUUID()}`, filledAt: Date.now()
    }
  }
}
