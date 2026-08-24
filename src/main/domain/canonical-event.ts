import { createHash } from 'node:crypto'
import type { CanonicalEvent, CanonicalEventCategory, CanonicalOutcome } from '../../shared/multi-venue'

export interface CanonicalEventInput {
  category: CanonicalEventCategory
  subject: string
  interval?: string
  startTime: number
  endTime: number
  settlementSource?: string
  outcomes: Array<string | Omit<CanonicalOutcome, 'id'> & { id?: string }>
}

export interface MarketMatchKey {
  subject: string
  interval?: string
  startTime: number
  endTime: number
  settlementSource?: string
  outcomeIds: string[]
}

const INTERVAL_PATTERN = /^(\d+)([mhd])$/i

function normalizeText(value: string, field: string): string {
  const normalized = value.trim().toUpperCase()
  if (!normalized) throw new Error(`${field} 不能为空`)
  return normalized
}

function normalizeInterval(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  const match = INTERVAL_PATTERN.exec(normalized)
  if (!match || Number(match[1]) <= 0) throw new Error(`interval 无效: ${value}`)
  return `${Number(match[1])}${match[2]}`
}

function normalizeOutcomes(outcomes: CanonicalEventInput['outcomes']): CanonicalOutcome[] {
  const normalized = outcomes.map((outcome): CanonicalOutcome => {
    if (typeof outcome === 'string') {
      const id = normalizeText(outcome, 'outcome')
      const direction: CanonicalOutcome['direction'] = id === 'UP' || id === 'DOWN' ? id : undefined
      return { id, label: id, ...(direction ? { direction } : {}) }
    }
    const id = normalizeText(outcome.id ?? outcome.label, 'outcome')
    const label = normalizeText(outcome.label, 'outcome label')
    const direction: CanonicalOutcome['direction'] = outcome.direction === 'UP' || outcome.direction === 'DOWN' ? outcome.direction : undefined
    return { id, label, ...(direction ? { direction } : {}) }
  })
  const ids = new Set(normalized.map((outcome) => outcome.id))
  if (normalized.length < 2 || ids.size !== normalized.length) throw new Error('outcomes 至少需要两个且不能重复')
  return normalized.sort((left, right) => left.id.localeCompare(right.id))
}

export function normalizeCanonicalEvent(input: CanonicalEventInput): CanonicalEvent {
  if (!Number.isFinite(input.startTime) || !Number.isFinite(input.endTime) || input.endTime <= input.startTime) {
    throw new Error('event 时间范围无效')
  }
  const category = input.category
  if (!['CRYPTO', 'SPORTS', 'POLITICS', 'FINANCE', 'OTHER'].includes(category)) throw new Error('event category 无效')
  const subject = normalizeText(input.subject, 'subject')
  const interval = normalizeInterval(input.interval)
  const outcomes = normalizeOutcomes(input.outcomes)
  const settlementSource = input.settlementSource ? normalizeText(input.settlementSource, 'settlementSource') : undefined
  return {
    eventId: canonicalEventId({ ...input, subject, interval, settlementSource, outcomes }),
    category,
    subject,
    ...(interval ? { interval } : {}),
    startTime: input.startTime,
    endTime: input.endTime,
    ...(settlementSource ? { settlementSource } : {}),
    outcomes
  }
}

export function marketMatchKey(event: CanonicalEvent): MarketMatchKey {
  return {
    subject: event.subject,
    ...(event.interval ? { interval: event.interval } : {}),
    startTime: event.startTime,
    endTime: event.endTime,
    ...(event.settlementSource ? { settlementSource: event.settlementSource } : {}),
    outcomeIds: event.outcomes.map((outcome) => outcome.id).sort()
  }
}

export function canonicalEventId(input: CanonicalEventInput): string {
  const subject = normalizeText(input.subject, 'subject')
  const interval = normalizeInterval(input.interval)
  const outcomes = normalizeOutcomes(input.outcomes).map((outcome) => outcome.id)
  const settlementSource = input.settlementSource ? normalizeText(input.settlementSource, 'settlementSource') : undefined
  const payload = JSON.stringify({
    category: input.category,
    subject,
    interval,
    startTime: input.startTime,
    endTime: input.endTime,
    settlementSource,
    outcomes
  })
  return `evt_${createHash('sha256').update(payload).digest('hex').slice(0, 24)}`
}
