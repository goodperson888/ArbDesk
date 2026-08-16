import { describe, expect, it } from 'vitest'
import { assertTransition, canTransition } from './execution-machine'

describe('execution state machine', () => {
  it('allows hedging only after a MEXC fill state', () => {
    expect(canTransition('MEXC_FILLED', 'POLY_HEDGING')).toBe(true)
    expect(canTransition('MEXC_SUBMITTED', 'POLY_HEDGING')).toBe(false)
  })

  it('rejects invalid transitions', () => {
    expect(() => assertTransition('IDLE', 'HEDGED')).toThrow('非法执行状态迁移')
  })
})
