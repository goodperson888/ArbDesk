import type { SettlementDistanceRule } from './types'

export const DEFAULT_SETTLEMENT_DISTANCE_RULES: readonly SettlementDistanceRule[] = [
  { id: 'default-120', remainingSeconds: 120, minimumBps: '2' },
  { id: 'default-20', remainingSeconds: 20, minimumBps: '0.5' }
]

export function defaultSettlementDistanceRules(): SettlementDistanceRule[] {
  return DEFAULT_SETTLEMENT_DISTANCE_RULES.map((rule) => ({ ...rule }))
}
