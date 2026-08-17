export interface MexcAssetLogRow {
  tn?: string
  ta?: number
  bt?: number
  tt?: number
}

export interface MexcFeeCalibration {
  feeRate: string
  source: 'HISTORY' | 'UNAVAILABLE'
  sampleCount: number
}

export interface CachedMexcFeeCalibration extends MexcFeeCalibration {
  receivedAt: number
}

const MAX_SAMPLE_AGE_MS = 7 * 24 * 60 * 60 * 1_000

function normalizeTimestamp(timestamp: number): number {
  return timestamp > 0 && timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp
}

export function deriveMexcFeeRate(
  rows: MexcAssetLogRow[],
  now = Date.now(),
  allowUnpairedBuyAsZero = true
): MexcFeeCalibration {
  const grouped = new Map<string, Array<{ amount: number; businessType: number; timestamp: number }>>()
  for (const row of rows) {
    const timestamp = normalizeTimestamp(Number(row.tt))
    if (
      !row.tn ||
      !Number.isFinite(Number(row.ta)) ||
      !Number.isFinite(Number(row.bt)) ||
      !Number.isFinite(timestamp) ||
      timestamp <= 0
    ) continue
    const group = grouped.get(row.tn) ?? []
    group.push({ amount: Number(row.ta), businessType: Number(row.bt), timestamp })
    grouped.set(row.tn, group)
  }
  const samples: Array<{ ratio: number; timestamp: number }> = []
  for (const group of grouped.values()) {
    const fee = group.find((row) => row.businessType === 104)
    // The arbitrage executor always buys its MEXC leg, so sell rows (108) must not
    // influence the rate. A recent completed buy without a paired fee row is a
    // genuine zero-fee sample rather than a reason to inject a guessed fallback.
    const trade = group.find((row) => row.businessType === 107)
    if (!trade || trade.amount === 0 || now - trade.timestamp > MAX_SAMPLE_AGE_MS || trade.timestamp > now + 60_000) continue
    if (!fee && !allowUnpairedBuyAsZero) continue
    const ratio = fee ? Math.abs(fee.amount / trade.amount) : 0
    if (ratio >= 0 && ratio < 0.1) samples.push({ ratio, timestamp: trade.timestamp })
  }
  if (!samples.length) return { feeRate: '0', source: 'UNAVAILABLE', sampleCount: 0 }
  samples.sort((left, right) => right.timestamp - left.timestamp)
  return {
    feeRate: String(samples[0].ratio),
    source: 'HISTORY',
    sampleCount: samples.length
  }
}

export function updateMexcFeeCalibrationCache(
  current: CachedMexcFeeCalibration | undefined,
  rows: MexcAssetLogRow[],
  receivedAt: number,
  validForMs: number,
  allowUnpairedBuyAsZero = true
): CachedMexcFeeCalibration {
  const next = { ...deriveMexcFeeRate(rows, receivedAt, allowUnpairedBuyAsZero), receivedAt }
  if (next.source === 'HISTORY') return next
  if (current?.source === 'HISTORY' && receivedAt - current.receivedAt < validForMs) return current
  return next
}
