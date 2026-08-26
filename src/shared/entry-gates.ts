import Decimal from 'decimal.js'
import type { MultiVenueMatchClass } from './multi-venue'
import type { ManualExecutionConditions } from './types'

export type EntryGateEvaluationMode = 'MANUAL' | 'AUTO'

export interface EntryGateLeg {
  venueId: string
  venueLabel: string
  marketId?: string
  outcomeId?: string
  price: string
  availableQuantity: string
  quoteAgeMs: number
  minimumQuantity?: string
  minimumNotionalUsd?: string
}

export interface EntryGateReadiness {
  id: string
  label: string
  passed: boolean
  blockReason: string
}

export interface EntryGateInput {
  mode: EntryGateEvaluationMode
  quantity: string
  allInCostPerShare: string
  conditionalReturnPct: string
  edgeKind: 'NET_VERIFIED' | 'GROSS_ONLY'
  matchClass: MultiVenueMatchClass
  endTime: number
  now: number
  maxCapitalPerTrade: string
  minConditionalReturnPct: string
  maxQuoteAgeMs: number
  stopBeforeExpirySeconds: number
  manualConditions: ManualExecutionConditions
  executionIdle: boolean
  readiness: EntryGateReadiness[]
  legs: EntryGateLeg[]
  feeVerificationApplicable?: boolean
  settlementRiskApplicable?: boolean
  depthLimitApplicable?: boolean
}

export interface EntryGateCheck {
  id: string
  label: string
  passed: boolean
  applicable: boolean
  locked: boolean
  condition?: keyof ManualExecutionConditions
  enabled: boolean
  blockReason?: string
}

export interface EntryGateReport {
  allowed: boolean
  checks: EntryGateCheck[]
  activeCount: number
  passedCount: number
  ignoredCount: number
  firstBlockReason?: string
  minimumQuantity: string
  requestedCapital: string
}

function decimal(value: Decimal.Value): Decimal {
  try {
    return new Decimal(value)
  } catch {
    return new Decimal(Number.NaN)
  }
}

function legMinimumQuantity(leg: EntryGateLeg): Decimal {
  let minimum = decimal(leg.minimumQuantity ?? 0)
  if (!minimum.isFinite() || minimum.lt(0)) minimum = new Decimal(0)
  if (leg.minimumNotionalUsd) {
    const price = decimal(leg.price)
    const notional = decimal(leg.minimumNotionalUsd)
    if (!price.isFinite() || price.lte(0) || !notional.isFinite() || notional.lt(0)) return new Decimal(Infinity)
    minimum = Decimal.max(minimum, notional.div(price).toDecimalPlaces(2, Decimal.ROUND_UP))
  }
  return minimum
}

export function entryGateMinimumQuantity(legs: EntryGateLeg[]): Decimal {
  return legs.reduce((maximum, leg) => Decimal.max(maximum, legMinimumQuantity(leg)), new Decimal(0))
}

function hardCheck(id: string, passed: boolean, label: string, blockReason: string, applicable = true): EntryGateCheck {
  return { id, passed, label, blockReason, applicable, locked: true, enabled: applicable }
}

function configurableCheck(
  input: EntryGateInput,
  id: string,
  condition: keyof ManualExecutionConditions,
  passed: boolean,
  label: string,
  blockReason: string,
  applicable = true
): EntryGateCheck {
  return {
    id, condition, passed, label, blockReason, applicable, locked: false,
    enabled: applicable && (input.mode === 'AUTO' || input.manualConditions[condition] !== false)
  }
}

function finiteFixed(value: Decimal, places: number): string {
  return value.isFinite() ? value.toFixed(places) : '—'
}

export function evaluateEntryGates(input: EntryGateInput): EntryGateReport {
  const quantity = decimal(input.quantity)
  const quantityPositive = quantity.isFinite() && quantity.gt(0)
  const minimumQuantity = entryGateMinimumQuantity(input.legs)
  const minimumPassed = quantityPositive && minimumQuantity.isFinite() && quantity.gte(minimumQuantity)
  const limitingMinimum = input.legs
    .map((leg) => ({ leg, quantity: legMinimumQuantity(leg) }))
    .sort((left, right) => right.quantity.comparedTo(left.quantity))[0]
  const minimumDetail = limitingMinimum?.leg.minimumNotionalUsd
    ? `${limitingMinimum.leg.venueLabel} 最低金额 $${decimal(limitingMinimum.leg.minimumNotionalUsd).toFixed(2)} 需 ${finiteFixed(limitingMinimum.quantity, 2)} 份`
    : `${limitingMinimum?.leg.venueLabel ?? '平台'} 最低 ${finiteFixed(minimumQuantity, 2)} 份`
  const depth = input.legs.length > 0
    ? Decimal.min(...input.legs.map((leg) => decimal(leg.availableQuantity)))
    : new Decimal(0)
  const depthPassed = quantityPositive && depth.isFinite() && quantity.lte(depth)
  const capital = quantityPositive ? quantity.mul(decimal(input.allInCostPerShare)) : new Decimal(Number.NaN)
  const capitalLimit = decimal(input.maxCapitalPerTrade)
  const capitalPassed = capital.isFinite() && capitalLimit.isFinite() && capital.lte(capitalLimit)
  const identityPassed = input.legs.length === 2 && input.legs.every((leg) => Boolean(leg.marketId && leg.outcomeId))
  const returnPct = decimal(input.conditionalReturnPct)
  const minimumReturnPct = decimal(input.minConditionalReturnPct)
  const returnPassed = returnPct.isFinite() && minimumReturnPct.isFinite() && returnPct.gte(minimumReturnPct)
  const feePassed = input.edgeKind === 'NET_VERIFIED'
  const settlementPassed = input.matchClass === 'EXACT'
  const slowestQuoteAgeMs = input.legs.length > 0 ? Math.max(...input.legs.map((leg) => leg.quoteAgeMs)) : Infinity
  const freshnessPassed = Number.isFinite(slowestQuoteAgeMs) && slowestQuoteAgeMs <= input.maxQuoteAgeMs
  const remainingSeconds = (input.endTime - input.now) / 1_000
  const expiryPassed = Number.isFinite(remainingSeconds) && remainingSeconds > input.stopBeforeExpirySeconds

  const checks: EntryGateCheck[] = [
    hardCheck('quantity-positive', quantityPositive, `输入份额 ${quantityPositive ? quantity.toFixed(2) : input.quantity || '0'} > 0`, '请输入大于 0 的双腿份额'),
    hardCheck('minimum-order', minimumPassed, `最小委托：输入 ${quantityPositive ? quantity.toFixed(2) : '0.00'} 份；${minimumDetail}`, `${minimumDetail}，当前输入不足`),
    hardCheck('depth-limit', depthPassed, `盘口深度：输入 ${quantityPositive ? quantity.toFixed(2) : '0.00'} ≤ ${finiteFixed(depth, 2)} 份`, `输入份额超过当前任一平台盘口深度 ${finiteFixed(depth, 2)} 份`, input.depthLimitApplicable !== false),
    hardCheck('capital-limit', capitalPassed, `预计本金 $${finiteFixed(capital, 2)} ≤ $${finiteFixed(capitalLimit, 2)}`, `预计本金 $${finiteFixed(capital, 2)} 超过单笔上限 $${finiteFixed(capitalLimit, 2)}`),
    hardCheck('market-identity', identityPassed, identityPassed ? '两条腿市场身份完整' : '至少一条腿缺少市场或结果 ID', '市场身份不完整，未发送订单'),
    ...input.readiness.map((item) => hardCheck(item.id, item.passed, item.label, item.blockReason)),
    hardCheck('execution-idle', input.executionIdle, input.executionIdle ? '当前无冲突执行' : '已有执行中的套利组', '已有执行中的套利组，不能重复开仓'),
    configurableCheck(input, 'conditional-return', 'conditionalReturn', returnPassed, `条件收益率 ${finiteFixed(returnPct, 2)}% ≥ ${finiteFixed(minimumReturnPct, 2)}%`, `条件收益率 ${finiteFixed(returnPct, 2)}% 低于入场阀值 ${finiteFixed(minimumReturnPct, 2)}%`),
    configurableCheck(input, 'fee-verification', 'feeVerification', feePassed, feePassed ? '手续费模型已验证' : '手续费模型未验证，当前仅有毛边际', '手续费模型尚未验证', input.feeVerificationApplicable !== false),
    configurableCheck(input, 'settlement-risk', 'settlementRisk', settlementPassed, settlementPassed ? '两平台结算规则完全一致' : '两平台结算规则存在差异', '两平台结算规则存在差异', input.settlementRiskApplicable !== false),
    configurableCheck(input, 'quote-freshness', 'quoteFreshness', freshnessPassed, `最慢一腿 ${Number.isFinite(slowestQuoteAgeMs) ? (slowestQuoteAgeMs / 1_000).toFixed(1) : '—'} 秒 ≤ ${(input.maxQuoteAgeMs / 1_000).toFixed(0)} 秒`, `行情已过期：最慢一腿 ${Number.isFinite(slowestQuoteAgeMs) ? Math.round(slowestQuoteAgeMs / 1_000) : '—'} 秒未收到有效观测`),
    configurableCheck(input, 'expiry-cutoff', 'expiryCutoff', expiryPassed, `距离到期 ${Number.isFinite(remainingSeconds) ? remainingSeconds.toFixed(0) : '—'} 秒 > ${input.stopBeforeExpirySeconds} 秒`, `距离到期不足 ${input.stopBeforeExpirySeconds} 秒，禁止新开仓`)
  ]
  const activeChecks = checks.filter((check) => check.applicable && (check.locked || check.enabled))
  const failed = activeChecks.find((check) => !check.passed)
  return {
    allowed: !failed,
    checks,
    activeCount: activeChecks.length,
    passedCount: activeChecks.filter((check) => check.passed).length,
    ignoredCount: checks.filter((check) => check.applicable && !check.locked && !check.enabled).length,
    firstBlockReason: failed?.blockReason ?? failed?.label,
    minimumQuantity: finiteFixed(minimumQuantity, 2),
    requestedCapital: finiteFixed(capital, 2)
  }
}
