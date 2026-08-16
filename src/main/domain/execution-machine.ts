import type { ExecutionState } from '../../shared/types'

const allowedTransitions: Record<ExecutionState, ExecutionState[]> = {
  IDLE: ['MEXC_OPENING', 'CANCELLED'],
  MEXC_OPENING: ['MEXC_SUBMITTING', 'RECOVERY_REQUIRED', 'CANCELLED'],
  MEXC_SUBMITTING: ['MEXC_SUBMITTED', 'MEXC_PARTIAL', 'MEXC_FILLED', 'RECOVERY_REQUIRED', 'CANCELLED'],
  MEXC_SUBMITTED: ['MEXC_PARTIAL', 'MEXC_FILLED', 'RECOVERY_REQUIRED', 'CANCELLED'],
  MEXC_PARTIAL: ['POLY_HEDGING', 'RECOVERY_REQUIRED'],
  MEXC_FILLED: ['POLY_HEDGING', 'RECOVERY_REQUIRED'],
  POLY_HEDGING: ['HEDGED', 'RECOVERY_REQUIRED'],
  HEDGED: [],
  RECOVERY_REQUIRED: ['POLY_HEDGING', 'CANCELLED'],
  CANCELLED: []
}

export function canTransition(from: ExecutionState, to: ExecutionState): boolean {
  return allowedTransitions[from].includes(to)
}

export function assertTransition(from: ExecutionState, to: ExecutionState): void {
  if (!canTransition(from, to)) {
    throw new Error(`非法执行状态迁移: ${from} -> ${to}`)
  }
}
