import type { Direction, Fill, MexcSettlement } from '../../shared/types'

export interface MexcFillLogRow {
  bt?: number
  ei?: number | string
  rft?: string
  tn?: string
  tt?: number
  sif?: string
  /** 订单号，与下单接口返回的data一致 */
  si?: string
}

interface MexcFillPayload {
  symbolId?: string
  quantity?: number | string
  ei?: number | string
  rf?: number
  price?: number | string
}

export interface MexcFillMatch {
  eventId: string
  symbolId?: string
  direction: Direction
  submittedAfter: number
  /** 直连下单时place响应返回的订单号，与流水行的si字段同源；优先按它精确匹配。 */
  orderId?: string
}

export function parseMexcFill(rows: MexcFillLogRow[], match: MexcFillMatch): Fill | undefined {
  for (const row of rows) {
    if ([104, 106, 1061].includes(Number(row.bt)) || !row.tn || Number(row.tt) < match.submittedAfter) continue
    let payload: MexcFillPayload
    try {
      payload = JSON.parse(row.sif ?? '{}') as MexcFillPayload
    } catch {
      continue
    }
    if (match.orderId) {
      // 订单号是place接口返回的原始ID，与流水si一一对应，比事件+方向+时间窗更严格。
      if (String(row.si ?? '') !== match.orderId) continue
    } else {
      const eventId = String(payload.ei ?? row.ei ?? '')
      const direction = String(row.rft ?? '').toUpperCase()
      const symbolMatches = !match.symbolId || !payload.symbolId || payload.symbolId === match.symbolId
      if (eventId !== match.eventId || direction !== match.direction || !symbolMatches) continue
    }
    const quantity = Number(payload.quantity)
    const price = Number(payload.price)
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0 || price >= 1) continue
    return {
      venue: 'MEXC',
      direction: match.direction,
      quantity: String(payload.quantity),
      averagePrice: String(payload.price),
      orderId: row.tn,
      filledAt: Number(row.tt) || Date.now(),
      verificationSource: 'PLATFORM_READBACK'
    }
  }
  return undefined
}

export function parseLatestMexcSettlement(rows: Array<MexcFillLogRow & { ta?: number }>): MexcSettlement | undefined {
  const sorted = [...rows].sort((left, right) => Number(right.tt) - Number(left.tt))
  for (const row of sorted) {
    if (![106, 1061].includes(Number(row.bt)) || !row.tn) continue
    let payload: MexcFillPayload
    try {
      payload = JSON.parse(row.sif ?? '{}') as MexcFillPayload
    } catch {
      continue
    }
    const quantity = Number(payload.quantity)
    const eventId = String(payload.ei ?? row.ei ?? '')
    const direction = String(row.rft ?? '').toUpperCase()
    if (!eventId || !Number.isFinite(quantity) || quantity <= 0 || !['UP', 'DOWN'].includes(direction)) continue
    const payout = Number(row.ta)
    return {
      eventId,
      direction: direction as Direction,
      quantity: String(payload.quantity),
      payout: Number.isFinite(payout) ? String(payout) : '0',
      result: Number(row.bt) === 106 ? 'WON' : 'LOST',
      transactionId: row.tn,
      settledAt: Number(row.tt) || Date.now()
    }
  }
  return undefined
}
