import { describe, expect, it } from 'vitest'
import type { LimitlessCredentialStore } from './limitless-credential-store'
import type { LimitlessMarketData } from './limitless-market-data'
import type { PredictFunCredentialStore } from './predict-fun-credential-store'
import type { PredictFunMarketData } from './predict-fun-market-data'
import {
  LimitlessPreparationService,
  PredictFunPreparationService,
  assertPreparationRequestAllowed
} from './venue-preparation'

describe('venue preparation request guard', () => {
  it('allows reads and only the Predict.fun JWT exchange POST', () => {
    expect(() => assertPreparationRequestAllowed('LIMITLESS', 'GET', 'https://api.limitless.exchange/portfolio/positions')).not.toThrow()
    expect(() => assertPreparationRequestAllowed('PREDICT_FUN', 'GET', 'https://api.predict.fun/v1/orders')).not.toThrow()
    expect(() => assertPreparationRequestAllowed('PREDICT_FUN', 'POST', 'https://api.predict.fun/v1/auth')).not.toThrow()
  })

  it('blocks order submission, cancellation and approval mutations', () => {
    expect(() => assertPreparationRequestAllowed('LIMITLESS', 'POST', 'https://api.limitless.exchange/orders')).toThrow('安全联调禁止请求')
    expect(() => assertPreparationRequestAllowed('LIMITLESS', 'DELETE', 'https://api.limitless.exchange/orders/order-id')).toThrow('安全联调禁止请求')
    expect(() => assertPreparationRequestAllowed('PREDICT_FUN', 'POST', 'https://api.predict.fun/v1/orders')).toThrow('安全联调禁止请求')
    expect(() => assertPreparationRequestAllowed('PREDICT_FUN', 'POST', 'https://api.predict.fun/v1/orders/remove')).toThrow('安全联调禁止请求')
    expect(() => assertPreparationRequestAllowed('LIMITLESS', 'GET', 'https://example.com/portfolio/positions')).toThrow('安全联调禁止访问')
  })
})

describe('venue preparation request deduplication', () => {
  it('deduplicates and caches Limitless preparation attempts', async () => {
    let calls = 0
    const credentials = {
      getCredentials: async () => {
        calls += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
        throw new Error('not configured')
      }
    } as unknown as LimitlessCredentialStore
    const service = new LimitlessPreparationService(credentials, {} as LimitlessMarketData)
    const [left, right] = await Promise.all([service.prepare(), service.prepare()])
    expect(left).toBe(right)
    expect(left.orderSubmissionBlocked).toBe(true)
    expect(calls).toBe(1)
    await service.prepare()
    expect(calls).toBe(1)
  })

  it('deduplicates and caches Predict.fun preparation attempts', async () => {
    let calls = 0
    const credentials = {
      getCredentials: async () => {
        calls += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
        throw new Error('not configured')
      }
    } as unknown as PredictFunCredentialStore
    const service = new PredictFunPreparationService(credentials, {} as PredictFunMarketData)
    const [left, right] = await Promise.all([service.prepare(), service.prepare()])
    expect(left).toBe(right)
    expect(left.orderSubmissionBlocked).toBe(true)
    expect(calls).toBe(1)
    await service.prepare()
    expect(calls).toBe(1)
  })
})
