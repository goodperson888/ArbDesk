import { describe, expect, it } from 'vitest'
import { parseLatestMexcSettlement, parseMexcFill } from './mexc-fill'

describe('MEXC fill parser', () => {
  const rows = [{
    bt: 107,
    ei: 3000378544483,
    rft: 'Up',
    tn: '717334792135258112X1',
    tt: 1786808178000,
    sif: JSON.stringify({
      symbolId: 'f398d8cb551a49a682929b59c0434399',
      quantity: 5.05,
      ei: 3000378544483,
      rf: 1,
      price: 0.99,
      gn: 1
    })
  }]

  it('parses the captured market fill and ignores the paired fee row', () => {
    const fill = parseMexcFill([
      { ...rows[0], bt: 104 },
      ...rows
    ], {
      eventId: '3000378544483',
      symbolId: 'f398d8cb551a49a682929b59c0434399',
      direction: 'UP',
      submittedAfter: 1786808170000
    })
    expect(fill).toEqual({
      venue: 'MEXC', direction: 'UP', quantity: '5.05', averagePrice: '0.99',
      orderId: '717334792135258112X1', filledAt: 1786808178000
    })
  })

  it('does not accept an old fill or a fill from another event', () => {
    expect(parseMexcFill(rows, {
      eventId: 'other', direction: 'UP', submittedAfter: 1786808170000
    })).toBeUndefined()
    expect(parseMexcFill(rows, {
      eventId: '3000378544483', direction: 'UP', submittedAfter: 1786808180000
    })).toBeUndefined()
  })

  it('distinguishes winning and losing settlement rows', () => {
    expect(parseLatestMexcSettlement([{
      bt: 106, ta: 5.05, ei: 3000378544483, rft: 'Up', tt: 1786808401000,
      tn: 'SETTLESHORT_3000378544483',
      sif: JSON.stringify({ quantity: 5.05, ei: 3000378544483, rf: 1 })
    }])).toMatchObject({ result: 'WON', payout: '5.05', quantity: '5.05' })
    expect(parseLatestMexcSettlement([{
      bt: 1061, ta: 0, ei: 3000376400199, rft: 'Up', tt: 1786713601000,
      tn: 'SETTLESHORT_3000376400199',
      sif: JSON.stringify({ quantity: 183.28, ei: 3000376400199, rf: 1 })
    }])).toMatchObject({ result: 'LOST', payout: '0' })
  })
})
