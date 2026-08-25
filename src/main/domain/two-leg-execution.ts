import { randomUUID } from 'node:crypto'
import Decimal from 'decimal.js'
import type {
  MultiVenueExecutionLegReceipt,
  MultiVenueExecutionReceipt,
  MultiVenueExecutionRequest
} from '../../shared/multi-venue'
import type { VenueAdapter, VenueExecutionRequest, VenueFill, VenueOrderReceipt } from '../platforms/venue-adapter'
import { PreSubmitBlockedError } from './execution-errors'

const MAX_QUOTE_AGE_MS = 8_000

function isUnknownError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /未知|unknown|indeterminate|timeout|timed out|aborted|未确认|无法确认|未返回订单号|状态不明/i.test(message)
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
    const stopBeforeExpirySeconds = request.stopBeforeExpirySeconds ?? 20
    const maxQuoteAgeMs = request.maxQuoteAgeMs ?? MAX_QUOTE_AGE_MS
    if (request.endTime - Date.now() < stopBeforeExpirySeconds * 1_000) throw new Error(`市场距离结算不足 ${stopBeforeExpirySeconds} 秒，已拒绝双腿下单`)
    for (const leg of request.legs) {
      if (!Number.isFinite(leg.quoteAgeMs) || leg.quoteAgeMs > maxQuoteAgeMs) throw new Error(`${leg.venueId} 行情已过期，已拒绝双腿下单`)
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
    let firstSubmissionConfirmed = false
    let secondReceipt: MultiVenueExecutionLegReceipt | undefined
    try {
      await firstAdapter.preflightOrder(firstRequest)
      firstOrder = await firstAdapter.submitOrder(firstRequest)
      if (!firstOrder.orderId) {
        firstReceipt = setVenue({ ...firstReceipt, status: 'UNKNOWN', orderId: undefined }, firstAdapter.venueId)
        throw new Error(`${firstAdapter.venueId} 下单响应未返回订单号，无法确认是否提交；请先在平台核对，未自动重试`)
      }
      firstSubmissionConfirmed = true
      firstReceipt = setVenue({ ...firstReceipt, orderId: firstOrder.orderId, status: firstOrder.status === 'UNKNOWN' ? 'UNKNOWN' : 'SUBMITTED' }, firstAdapter.venueId)
      const firstFill = await firstAdapter.waitForFill(firstOrder, firstRequest)
      if (!firstFill) throw new Error(`${firstAdapter.venueId} 首腿已提交但未读取到真实成交`)
      firstReceipt = setVenue(legReceipt(firstRequest, quantity, new Decimal(firstFill.quantity).gte(quantity) ? 'FILLED' : 'PARTIAL', firstFill), firstAdapter.venueId)
      const filledQuantity = new Decimal(firstFill.quantity)
      if (filledQuantity.gt(quantity.add('0.000001'))) {
        return { sessionId, comparisonId: request.comparisonId, status: 'RECOVERY_REQUIRED', firstLeg: firstReceipt, message: `${firstAdapter.venueId} 出现超额成交，未发送第二腿；请人工核对` }
      }
      if (filledQuantity.lte(0)) {
        const secondLabel = secondAdapter.venueId === 'KALSHI' ? 'Kalshi' : secondAdapter.venueId
        return { sessionId, comparisonId: request.comparisonId, status: 'RECOVERY_REQUIRED', firstLeg: firstReceipt, message: `${firstAdapter.venueId} 未产生有效成交，未发送 ${secondLabel}；请人工核对订单` }
      }

      // The first venue can report more precision than the second venue accepts.
      // Normalize once, then use the same target for the order, receipt, and
      // completion comparison; otherwise 7.19 would be judged smaller than
      // the raw first fill 7.192 even though the second leg is fully aligned.
      const secondQuantity = filledQuantity.toDecimalPlaces(2, Decimal.ROUND_DOWN)
      if (secondQuantity.lt(1)) {
        return { sessionId, comparisonId: request.comparisonId, status: 'RECOVERY_REQUIRED', firstLeg: firstReceipt, message: `${firstAdapter.venueId} 实际成交 ${filledQuantity.toFixed(3)} 份，按第二腿精度归一化后不足 1 份，未发送第二腿；请人工处理` }
      }
      const secondRequest = executionRequest(request, secondIndex, secondQuantity, sessionId)
      secondReceipt = setVenue(legReceipt(secondRequest, secondQuantity), secondAdapter.venueId)
      await secondAdapter.preflightOrder(secondRequest)
      const secondOrder = await secondAdapter.submitOrder(secondRequest)
      if (!secondOrder.orderId) {
        secondReceipt = setVenue({ ...secondReceipt, status: 'UNKNOWN', orderId: undefined }, secondAdapter.venueId)
        throw new Error(`${secondAdapter.venueId} 第二腿下单响应未返回订单号，无法确认是否提交；未自动重试`)
      }
      secondReceipt = setVenue({ ...secondReceipt, orderId: secondOrder.orderId, status: secondOrder.status === 'UNKNOWN' ? 'UNKNOWN' : 'SUBMITTED' }, secondAdapter.venueId)
      const secondFill = await secondAdapter.waitForFill(secondOrder, secondRequest)
      if (!secondFill) throw new Error(`${secondAdapter.venueId} 第二腿已提交但未读取到真实成交`)
      secondReceipt = setVenue(legReceipt(secondRequest, secondQuantity, new Decimal(secondFill.quantity).gte(secondQuantity) ? 'FILLED' : 'PARTIAL', secondFill), secondAdapter.venueId)
      if (new Decimal(secondFill.quantity).gte(secondQuantity)) {
        const partialNote = filledQuantity.lt(quantity) ? `（首腿原计划${quantity.toFixed(2)}份，实际成交${filledQuantity.toFixed(3)}份）` : ''
        const precisionNote = filledQuantity.gt(secondQuantity) ? `（按第二腿精度对齐${secondQuantity.toFixed(2)}份）` : ''
        return { sessionId, comparisonId: request.comparisonId, status: 'HEDGED', firstLeg: firstReceipt, secondLeg: secondReceipt, message: `双腿已对齐：${firstAdapter.venueId} ${secondQuantity.toFixed(2)} 份 → ${secondAdapter.venueId} ${secondReceipt.filledQuantity} 份${partialNote}${precisionNote}` }
      }
      return { sessionId, comparisonId: request.comparisonId, status: 'RECOVERY_REQUIRED', firstLeg: firstReceipt, secondLeg: secondReceipt, message: `第一腿已成交，但 ${secondAdapter.venueId} 仅成交 ${secondReceipt.filledQuantity} / ${secondQuantity.toFixed(2)} 份；已进入恢复态，未自动重试` }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const preSubmitBlocked = !firstSubmissionConfirmed && error instanceof PreSubmitBlockedError
      const status = preSubmitBlocked ? 'CANCELED' : isUnknownError(error) ? 'RECONCILE_REQUIRED' : 'RECOVERY_REQUIRED'
      secondReceipt ??= setVenue(legReceipt(executionRequest(request, secondIndex, quantity, sessionId), quantity), secondAdapter.venueId)
      return {
        sessionId, comparisonId: request.comparisonId, status, firstLeg: firstReceipt, secondLeg: firstSubmissionConfirmed ? secondReceipt : undefined,
        message: `${firstSubmissionConfirmed ? '首腿已提交但第二腿未完成' : preSubmitBlocked ? '首腿未提交' : '首腿未确认提交'}：${message}`
      }
    }
  }
}
