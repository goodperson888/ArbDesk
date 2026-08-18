import type { ManualExecutionConditions, SettlementDistanceRule } from './types'

export const DEFAULT_SETTLEMENT_DISTANCE_RULES: readonly SettlementDistanceRule[] = [
  { id: 'default-120', remainingSeconds: 120, minimumBps: '2' },
  { id: 'default-20', remainingSeconds: 20, minimumBps: '0.5' }
]

export function defaultSettlementDistanceRules(): SettlementDistanceRule[] {
  return DEFAULT_SETTLEMENT_DISTANCE_RULES.map((rule) => ({ ...rule }))
}

export function defaultManualExecutionConditions(
  overrides: Partial<ManualExecutionConditions> = {}
): ManualExecutionConditions {
  return {
    conditionalReturn: overrides.conditionalReturn ?? true,
    settlementRisk: overrides.settlementRisk ?? true,
    feeVerification: overrides.feeVerification ?? true,
    quoteFreshness: overrides.quoteFreshness ?? true,
    expiryCutoff: overrides.expiryCutoff ?? true
  }
}
