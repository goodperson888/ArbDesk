import { describe, expect, it } from 'vitest'
import type { MultiVenueExecutionSession } from '../../shared/multi-venue'
import { undismissedRecoverySessions } from './recovery-banner'

function session(sessionId: string): MultiVenueExecutionSession {
  return {
    sessionId,
    comparisonId: `comparison-${sessionId}`,
    status: 'RECOVERY_REQUIRED',
    createdAt: 1,
    updatedAt: 1
  }
}

describe('跨平台恢复提示', () => {
  it('关闭当前恢复会话后保持隐藏，但新增会话会重新显示', () => {
    const dismissed = new Set(['old-a', 'old-b'])

    expect(undismissedRecoverySessions([session('old-a'), session('old-b')], dismissed)).toEqual([])
    expect(undismissedRecoverySessions([session('old-a'), session('old-b'), session('new-c')], dismissed).map((item) => item.sessionId)).toEqual(['new-c'])
  })
})
