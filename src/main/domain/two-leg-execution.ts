import { randomUUID } from 'node:crypto'
import Decimal from 'decimal.js'
import type {
  MultiVenueExecutionLegReceipt,
  MultiVenueExecutionReceipt,
  MultiVenueExecutionRequest
} from '../../shared/multi-venue'
import type { VenueAdapter, VenueExecutionRequest, VenueFill, VenueOrderReceipt } from '../platforms/venue-adapter'

const MAX_QUOTE_AGE_MS = 8_000

function isUnknownError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /未知|unknown|indeterminate|timeout|timed out|aborted/i.test(message)
}

function legReceipt(request: VenueExecutionRequest, quantity: Decimal, status: MultiVenueExecutionLegReceipt['status'] = 'NOT_SUBMITTED', fill?: VenueFill): MultiVenueExecutionLegReceipt {
  return {
    venueId: 'UNKNOWN',
    direction: request.direction,
    requestedQuantity: quantity.toFixed(2),
    filledQuantity: fill?.quantity ?? '0',
    averagePrice: fill?.averagePrice,
    orderId: fill?.orderId,
    status
  }
}

function setVenue(receipt: MultiVenueExecutionLegReceipt, venueId: string): MultiVenueExecutionLegReceipt {
  return { ...receipt, venueId }
}

function executionRequest(
  request: MultiVenueExecutionRequest,
  legIndex: number,
  quantity: Decimal,
  sessionId: string
): VenueExecutionRequest {
  const leg = request.legs[legIndex]
  return {
    eventId: leg.marketId,
    marketId: leg.marketId ?? '',
    outcomeId: leg.outcomeId ?? '',
    direction: leg.direction,
    quantity: quantity.toFixed(2),
    limitPrice: leg.price,
    startTime: request.startTime,
    endTime: request.endTime,
    quoteReceivedAt: Date.now() - leg.quoteAgeMs,
    timeInForce: 'FOK',
    clientOrderId: `arbdesk-${sessionId}-leg-${legIndex + 1}`,
    confirmed: request.confirmed
  }
}

export class TwoLegExecutionMachine {
  async execute(request: MultiVenueExecutionRequest, adapters: Map<string, VenueAdapter>): Promise<MultiVenueExecutionReceipt> {
    const sessionId = request.sessionId ?? randomUUID()
    if (!request.confirmed) throw new Error('未完成双腿真实下单二次确认')
    if (!Array.isArray(request.legs) || request.legs.length !== 2) throw new Error('双腿执行必须提供两个平台腿')
    const quantity = new Decimal(request.quantity)
    if (!quantity.isFinite() || quantity.lt(1)) throw new Error('双腿执行数量必须至少为 1 份')
    if (request.endTime - Date.now() < 20_000) throw new Error('市场距离结算不足 20 秒，已拒绝双腿下单')
    for (const leg of request.legs) {
      if (!Number.isFinite(leg.quoteAgeMs) || leg.quoteAgeMs > MAX_QUOTE_AGE_MS) throw new Error(`${leg.venueId} 行情已过期，已拒绝双腿下单`)
      if (!leg.marketId || !leg.outcomeId) throw new Error(`${leg.venueId} 缺少市场或结果 ID`)
    }
    const firstIndex = request.firstLegIndex ?? 0
    const secondIndex = firstIndex === 0 ? 1 : 0
    const firstLeg = request.legs[firstIndex]
    const secondLeg = request.legs[secondIndex]
    const firstAdapter = adapters.get(firstLeg.venueId)
    const secondAdapter = adapters.get(secondLeg.venueId)
    if (!firstAdapter || !secondAdapter) throw new Error(`路线缺少平台适配器：${!firstAdapter ? firstLeg.venueId : secondLeg.venueId}`)

    const firstRequest = executionRequest(request, firstIndex, quantity, sessionId)
    let firstReceipt = setVenue(legReceipt(firstRequest, quantity), firstAdapter.venueId)
    let firstOrder: VenueOrderReceipt | undefined
    try {
      await firstAdapter.preflightOrder(firstRequest)
      firstOrder = await firstAdapter.submitOrder(firstRequest)
      firstReceipt = setVenue({ ...firstReceipt, orderId: firstOrder.orderId, status: firstOrder.status === 'UNKNOWN' ? 'UNKNOWN' : 'SUBMITTED' }, firstAdapter.venueId)
      const firstFill = await firstAdapter.waitForFill(firstOrder, firstRequest)
      if (!firstFill) throw new Error(`${firstAdapter.venueId} 首腿已提交但未读取到真实成交`)
      firstReceipt = setVenue(legReceipt(firstRequest, quantity, new Decimal(firstFill.quantity).gte(quantity) ? 'FILLED' : 'PARTIAL', firstFill), firstAdapter.venueId)
      const filledQuantity = new Decimal(firstFill.quantity)
      if (filledQuantity.gt(quantity.add('0.000001'))) {
        return { sessionId, comparisonId: request.comparisonId, status: 'RECOVERY_REQUIRED', firstLeg: firstReceipt, message: `${firstAdapter.venueId} 出现超额成交，未发送第二腿；请人工核对` }
      }
      if (filledQuantity.lt(quantity)) {
        const secondLabel = secondAdapter.venueId === 'KALSHI' ? 'Kalshi' : secondAdapter.venueId
        return { sessionId, comparisonId: request.comparisonId, status: 'RECOVERY_REQUIRED', firstLeg: firstReceipt, message: `${firstAdapter.venueId} 仅成交 ${filledQuantity.toFixed(2)} / ${quantity.toFixed(2)} 份，未发送 ${secondLabel}；请人工处理剩余单腿敞口` }
      }

      const secondQuantity = filledQuantity
      const secondRequest = executionRequest(request, secondIndex, secondQuantity, sessionId)
      let secondReceipt = setVenue(legReceipt(secondRequest, secondQuantity), secondAdapter.venueId)
      await secondAdapter.preflightOrder(secondRequest)
      const secondOrder = await secondAdapter.submitOrder(secondRequest)
      secondReceipt = setVenue({ ...secondReceipt, orderId: secondOrder.orderId, status: secondOrder.status === 'UNKNOWN' ? 'UNKNOWN' : 'SUBMITTED' }, secondAdapter.venueId)
      const secondFill = await secondAdapter.waitForFill(secondOrder, secondRequest)
      if (!secondFill) throw new Error(`${secondAdapter.venueId} 第二腿已提交但未读取到真实成交`)
      secondReceipt = setVenue(legReceipt(secondRequest, secondQuantity, new Decimal(secondFill.quantity).gte(secondQuantity) ? 'FILLED' : 'PARTIAL', secondFill), secondAdapter.venueId)
      if (new Decimal(secondFill.quantity).gte(secondQuantity)) {
        return { sessionId, comparisonId: request.comparisonId, status: 'HEDGED', firstLeg: firstReceipt, secondLeg: secondReceipt, message: `双腿已完成：${firstAdapter.venueId} ${secondQuantity.toFixed(2)} 份 → ${secondAdapter.venueId} ${secondReceipt.filledQuantity} 份` }
      }
      return { sessionId, comparisonId: request.comparisonId, status: 'RECOVERY_REQUIRED', firstLeg: firstReceipt, secondLeg: secondReceipt, message: `第一腿已成交，但 ${secondAdapter.venueId} 仅成交 ${secondReceipt.filledQuantity} / ${secondQuantity.toFixed(2)} 份；已进入恢复态，未自动重试` }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = isUnknownError(error) ? 'RECONCILE_REQUIRED' : 'RECOVERY_REQUIRED'
      const secondReceipt = setVenue(legReceipt(executionRequest(request, secondIndex, quantity, sessionId), quantity), secondAdapter.venueId)
      return {
        sessionId, comparisonId: request.comparisonId, status, firstLeg: firstReceipt, secondLeg: firstOrder ? secondReceipt : undefined,
        message: `${firstOrder ? '首腿已提交但第二腿未完成' : '首腿未完成'}：${message}`
      }
    }
  }
}
