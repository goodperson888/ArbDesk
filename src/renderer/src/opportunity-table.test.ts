import { describe, expect, it } from 'vitest'
import { MULTI_VENUE_TABLE_COLUMNS, multiVenueExecuteLabel, multiVenueReceiptStatusLabel } from './opportunity-table'

describe('multi-venue opportunity presentation', () => {
  it('keeps only comparison columns and emphasizes all-in cost last', () => {
    const labels = MULTI_VENUE_TABLE_COLUMNS.map((column) => column.label)

    expect(labels).toEqual(['标的/窗口', '第一腿', '第二腿', '净边际/份', '预计净利润', '剩余', '状态', '双腿成本'])
    expect(labels).not.toContain('路线/方向')
    expect(labels).not.toContain('数量/深度')
  })

  it('uses explicit unprotected submission copy', () => {
    expect(multiVenueReceiptStatusLabel('UNPROTECTED_SUBMITTED')).toBe('无保护双边已提交 · 待核对')
    expect(multiVenueExecuteLabel(true, 'DOWN')).toBe('极速无保护 · 同量双边提交')
    expect(multiVenueExecuteLabel(false, 'DOWN')).toBe('执行双腿（DOWN → Kalshi）')
  })
})
