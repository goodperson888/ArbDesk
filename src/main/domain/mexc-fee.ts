export interface MexcAssetLogRow {
  tn?: string
  ta?: number
  bt?: number
}

export interface MexcFeeCalibration {
  feeRate: string
  source: 'HISTORY' | 'CONSERVATIVE_FALLBACK'
  sampleCount: number
}

export function deriveMexcFeeRate(rows: MexcAssetLogRow[], fallback = '0.015'): MexcFeeCalibration {
  const grouped = new Map<string, Array<{ amount: number; businessType: number }>>()
  for (const row of rows) {
    if (!row.tn || !Number.isFinite(Number(row.ta)) || !Number.isFinite(Number(row.bt))) continue
    const group = grouped.get(row.tn) ?? []
    group.push({ amount: Number(row.ta), businessType: Number(row.bt) })
    grouped.set(row.tn, group)
  }
  const ratios: number[] = []
  for (const group of grouped.values()) {
    const fee = group.find((row) => row.businessType === 104)
    const trade = group.find((row) => row.businessType === 107 || row.businessType === 108)
    if (!fee || !trade || trade.amount === 0) continue
    const ratio = Math.abs(fee.amount / trade.amount)
    if (ratio > 0 && ratio < 0.1) ratios.push(ratio)
  }
  if (!ratios.length) return { feeRate: fallback, source: 'CONSERVATIVE_FALLBACK', sampleCount: 0 }
  ratios.sort((left, right) => left - right)
  return {
    feeRate: String(ratios[Math.floor(ratios.length / 2)]),
    source: 'HISTORY',
    sampleCount: ratios.length
  }
}
