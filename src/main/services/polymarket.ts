import { randomUUID } from 'node:crypto'
import type { Direction, Fill } from '../../shared/types'

export interface HedgeOrder {
  tokenId?: string
  direction: Direction
  quantity: string
  maximumPrice: string
}

export interface PolymarketBroker {
  hedge(order: HedgeOrder): Promise<Fill>
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
}
