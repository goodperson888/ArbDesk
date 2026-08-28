import type { MultiVenueExecutionReceipt, MultiVenueExecutionSessionStatus } from '../../shared/multi-venue'

export const MULTI_VENUE_TABLE_COLUMNS = [
  { id: 'market-window', label: '标的/窗口' },
  { id: 'first-leg', label: '第一腿' },
  { id: 'second-leg', label: '第二腿' },
  { id: 'edge', label: '净边际/份' },
  { id: 'profit', label: '预计净利润' },
  { id: 'remaining', label: '剩余' },
  { id: 'status', label: '状态' },
  { id: 'all-in-cost', label: '双腿成本' }
] as const

export function multiVenueReceiptStatusLabel(
  status: MultiVenueExecutionReceipt['status'] | MultiVenueExecutionSessionStatus
): string {
  if (status === 'UNPROTECTED_SUBMITTED') return '无保护双边已提交 · 待核对'
  if (status === 'HEDGED') return '两腿已对齐'
  if (status === 'RECOVERED') return '已恢复'
  if (status === 'CANCELED') return '已取消'
  if (status === 'RECONCILE_REQUIRED') return '需要核对'
  if (status === 'RECOVERY_REQUIRED') return '需要恢复'
  return '执行中'
}

export function multiVenueExecuteLabel(unprotected: boolean, firstDirection: 'UP' | 'DOWN', secondVenue = 'Kalshi'): string {
  return unprotected ? '极速无保护 · 同量双边提交' : `执行双腿（${firstDirection} → ${secondVenue}）`
}
