import Decimal from 'decimal.js'
import { defaultSettlementDistanceRules } from '../../shared/defaults'
import type { SettlementDistanceRule } from '../../shared/types'

const MAX_RULES = 20
const MAX_REMAINING_SECONDS = 86_400
const MAX_BPS = 10_000

export function normalizeSettlementDistanceRules(value: unknown): SettlementDistanceRule[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('动态安全距离至少保留一个规则节点')
  if (value.length > MAX_RULES) throw new Error(`动态安全距离最多允许${MAX_RULES}个规则节点`)

  const seenSeconds = new Set<number>()
  const seenIds = new Set<string>()
  const normalized = value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') throw new Error(`第${index + 1}个动态安全距离规则格式无效`)
    const rule = candidate as Partial<SettlementDistanceRule>
    const remainingSeconds = Number(rule.remainingSeconds)
    const minimumBps = new Decimal(rule.minimumBps ?? Number.NaN)
    if (!Number.isInteger(remainingSeconds) || remainingSeconds < 0 || remainingSeconds > MAX_REMAINING_SECONDS) {
      throw new Error(`第${index + 1}行剩余秒数须为0至${MAX_REMAINING_SECONDS}的整数`)
    }
    if (!minimumBps.isFinite() || minimumBps.lt(0) || minimumBps.gt(MAX_BPS)) {
      throw new Error(`第${index + 1}行最低bps须在0至${MAX_BPS}之间`)
    }
    if (seenSeconds.has(remainingSeconds)) throw new Error(`剩余${remainingSeconds}秒存在重复规则`)
    seenSeconds.add(remainingSeconds)

    let id = typeof rule.id === 'string' ? rule.id.trim() : ''
    if (!id || seenIds.has(id)) id = `rule-${remainingSeconds}-${index}`
    seenIds.add(id)
    return { id, remainingSeconds, minimumBps: minimumBps.toDecimalPlaces(4).toString() }
  })

  return normalized.sort((left, right) => right.remainingSeconds - left.remainingSeconds)
}

export function settlementDistanceBpsForRemaining(
  rules: readonly SettlementDistanceRule[],
  remainingSeconds: number
): Decimal {
  const normalized = normalizeSettlementDistanceRules(rules)
  const remaining = Math.max(0, remainingSeconds)
  const first = normalized[0]
  const last = normalized.at(-1) ?? first
  if (remaining >= first.remainingSeconds) return new Decimal(first.minimumBps)
  if (remaining <= last.remainingSeconds) return new Decimal(last.minimumBps)

  for (let index = 0; index < normalized.length - 1; index += 1) {
    const upper = normalized[index]
    const lower = normalized[index + 1]
    if (remaining > upper.remainingSeconds || remaining < lower.remainingSeconds) continue
    const progress = new Decimal(remaining - lower.remainingSeconds)
      .div(upper.remainingSeconds - lower.remainingSeconds)
    return new Decimal(lower.minimumBps)
      .add(new Decimal(upper.minimumBps).minus(lower.minimumBps).mul(progress))
  }
  return new Decimal(last.minimumBps)
}

export function settlementDistanceBpsAt(
  rules: readonly SettlementDistanceRule[] = defaultSettlementDistanceRules(),
  endTime: number,
  evaluationTime = Date.now()
): Decimal {
  return settlementDistanceBpsForRemaining(rules, (endTime - evaluationTime) / 1_000)
}
