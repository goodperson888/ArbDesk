import { describe, expect, it } from 'vitest'
import { parsePredictAccountEventFills, parsePredictAccountPositions, parsePredictPageOrderFillEvent } from './predict-fun-page-capture'

describe('Predict.fun passive page fill readback', () => {
  it('parses the confirmed wallet websocket event captured from the live page', () => {
    const result = parsePredictPageOrderFillEvent(JSON.stringify({
      type: 'M',
      topic: 'predictWalletEvents/header.payload.signature',
      data: {
        type: 'orderTransactionSuccess',
        orderId: '2892348198',
        orderHash: '0xorder',
        timestamp: 1788080873000,
        details: { quantityFilled: '10.540', price: '0.600' },
        fee: { type: 'SHARES', amountWei: '210800000000000000' },
        fill: {
          executedPriceWei: '610000000000000000',
          executedSizeWei: '10540000000000000000'
        }
      }
    }))

    expect(result).toEqual({
      orderId: '2892348198', orderHash: '0xorder', status: 'FILLED',
      filledQuantity: '10.3292', grossFilledQuantity: '10.54', feeQuantity: '0.2108', averagePrice: '0.61',
      filledAt: 1788080873000, source: 'WALLET_WEBSOCKET'
    })
  })

  it('turns the wallet failure event into an explicit rejected outcome', () => {
    expect(parsePredictPageOrderFillEvent(JSON.stringify({ data: {
      type: 'orderTransactionFailed', orderId: 'order-failed', orderHash: '0xfailed', timestamp: 1788080874000,
      details: { reason: 'minimum output not met' }
    } }))).toEqual({
      orderId: 'order-failed', orderHash: '0xfailed', status: 'REJECTED', filledQuantity: '0',
      filledAt: 1788080874000, source: 'WALLET_WEBSOCKET', message: 'minimum output not met'
    })
  })

  it('aggregates multiple MATCH_SUCCESS account events for the same order', () => {
    const results = parsePredictAccountEventFills(JSON.stringify({
      data: { account: { ordersEventLog: { edges: [
        { node: { event: 'MATCH_SUCCESS', timestamp: '2026-08-30T09:07:53.000Z', transactionHash: '0xa', amountFilled: '5000000000000000000', priceExecuted: '600000000000000000', order: { id: 'order-1' } } },
        { node: { event: 'MATCH_SUCCESS', timestamp: '2026-08-30T09:07:54.000Z', transactionHash: '0xb', amountFilled: '5000000000000000000', priceExecuted: '620000000000000000', order: { id: 'order-1' } } }
      ] } } }
    }))

    expect(results).toEqual([expect.objectContaining({
      orderId: 'order-1', status: 'FILLED', filledQuantity: '10', averagePrice: '0.61', source: 'ACCOUNT_EVENT_LOG'
    })])
  })

  it('uses position edges even when Predict.fun reports totalCount zero', () => {
    expect(parsePredictAccountPositions(JSON.stringify({ data: { account: { positions: {
      totalCount: 0,
      edges: [{ node: {
        shares: '7538454000000000000', averageBuyPriceUsd: 0,
        outcome: { index: 1, name: '涨' }, market: { id: '1863805' }
      } }]
    } } } }))).toEqual([{ marketId: '1863805', direction: 'UP', shares: '7.538454', averagePrice: undefined }])
  })

  it('ignores accepted or planned events until a positive fill is confirmed', () => {
    expect(parsePredictPageOrderFillEvent(JSON.stringify({ data: {
      type: 'orderAccepted', orderId: 'order-1', details: { quantityFilled: '0.000' }
    } }))).toBeUndefined()
  })
})
