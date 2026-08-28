import { describe, expect, it, vi } from 'vitest'
import type { RiskSettings } from '../../shared/types'
import { defaultManualExecutionConditions, defaultSettlementDistanceRules } from '../../shared/defaults'
import type { MultiVenueComparison, MultiVenueExecutionRequest } from '../../shared/multi-venue'
import { MultiVenueExecutionService } from './multi-venue-execution'

function settings(overrides: Partial<RiskSettings> = {}): RiskSettings {
  return {
    mode: 'ASSISTED', kalshiLiveEnabled: true, gateLiveEnabled: true, mexcAutomationEnabled: true, polymarketLiveEnabled: true,
    maxCapitalPerTrade: '100', minConditionalReturnPct: '0', maxQuoteAgeMs: 8_000, stopBeforeExpirySeconds: 20,
    maxHedgeSlippage: '0.03', polymarketHedgeMode: 'PROTECTED_MARKET', settlementDistanceRules: defaultSettlementDistanceRules(),
    manualExecutionConditions: { ...defaultManualExecutionConditions(), feeVerification: false }, ...overrides
  } as RiskSettings
}

function comparison(overrides: Partial<MultiVenueComparison> = {}): MultiVenueComparison {
  return {
    id: 'cmp-1', asset: 'BTC/USD', durationMinutes: 15, startTime: Date.now() - 10_000, endTime: Date.now() + 60_000,
    strategy: 'COMPLEMENTARY_OUTCOMES', matchClass: 'EXACT', status: 'MANUAL_EXECUTABLE', executionProvider: 'MULTI_VENUE',
    edgeKind: 'GROSS_ONLY', allInCostPerShare: '0.90', netEdgePerShare: '0.10', conditionalReturnPct: '11.11',
    executableQuantity: '20.00', potentialProfit: '0', autoOrderPotentialProfit: '0', fixedSortKey: 'cmp-1', blockReasons: [],
    legs: [
      { venueId: 'GATE', venueLabel: 'Gate', marketId: 'gate-event', outcomeId: 'gate-token', direction: 'UP', price: '0.40', availableQuantity: '20', quoteAgeMs: 100 },
      { venueId: 'KALSHI', venueLabel: 'Kalshi', marketId: 'KXBTC15M-TEST', outcomeId: 'KXBTC15M-TEST:YES', direction: 'DOWN', price: '0.50', availableQuantity: '20', quoteAgeMs: 100 }
    ],
    ...overrides
  }
}

function request(pair: ['MEXC' | 'POLYMARKET', 'KALSHI'] = ['MEXC', 'KALSHI']): MultiVenueExecutionRequest {
  return {
    comparisonId: 'cmp-1', quantity: '2.00', startTime: Date.now() - 10_000, endTime: Date.now() + 60_000, confirmed: true,
    legs: [
      { venueId: pair[0], marketId: pair[0] === 'MEXC' ? 'mexc-event' : 'condition', outcomeId: pair[0] === 'MEXC' ? 'mexc-symbol' : 'poly-token', direction: 'UP', price: '0.40', availableQuantity: '3', quoteAgeMs: 100 },
      { venueId: 'KALSHI', marketId: 'KXBTC15M-TEST', outcomeId: 'KXBTC15M-TEST:YES', direction: 'DOWN', price: '0.50', availableQuantity: '3', quoteAgeMs: 100 }
    ]
  }
}

function comparisonForRequest(executionRequest: MultiVenueExecutionRequest): MultiVenueComparison {
  return comparison({
    id: executionRequest.comparisonId,
    startTime: executionRequest.startTime,
    endTime: executionRequest.endTime,
    allInCostPerShare: (Number(executionRequest.legs[0].price) + Number(executionRequest.legs[1].price)).toFixed(2),
    legs: executionRequest.legs.map((leg) => ({ ...leg, venueLabel: leg.venueId === 'KALSHI' ? 'Kalshi' : leg.venueId }))
  })
}

function deps() {
  const mexc = {
    prepareOrder: vi.fn(async () => ({ ok: true, orderAccepted: true, submittedAt: Date.now(), message: 'mexc accepted', orderId: 'mexc-order' })),
    waitForFill: vi.fn(async () => ({ venue: 'MEXC' as const, direction: 'UP' as const, quantity: '2.00', averagePrice: '0.40', orderId: 'mexc-fill', filledAt: Date.now() }))
  }
  const polymarket = {
    hedge: vi.fn(async () => ({ venue: 'POLYMARKET' as const, direction: 'UP' as const, quantity: '2.00', averagePrice: '0.40', orderId: 'poly-fill', filledAt: Date.now() }))
  }
  const kalshi = {
    verifyTradingAccess: vi.fn(async () => undefined),
    placeOrder: vi.fn(async () => ({ orderId: 'kalshi-order', clientOrderId: 'client', ticker: 'KXBTC15M-TEST', direction: 'DOWN' as const, side: 'ask' as const, quantity: '2.00', outcomePrice: '0.50', fillCount: '2.00', remainingCount: '0.00', status: 'EXECUTED' as const, submittedAt: Date.now(), message: 'filled' }))
  }
  const gate = {
    getSchema: vi.fn(() => ({ endpoint: 'https://www.gate.com/api/event-contract/orders', method: 'POST', requestFields: ['market_id', 'outcome_id', 'quantity', 'price'], capturedAt: Date.now() })),
    submit: vi.fn(async () => ({ orderId: 'gate-order', status: 'FILLED' as const, filledQuantity: '2.00', averagePrice: '0.40' })),
    reconcile: vi.fn(async () => undefined)
  }
  return {
    mexc, polymarket, kalshi, gate,
    kalshiCredentialsReady: vi.fn(async () => true),
    gateExecutionReady: vi.fn(() => true)
  }
}

describe('multi-venue Kalshi execution', () => {
  it('executes MEXC first and only then sends the exact fill to Kalshi', async () => {
    const mocked = deps()
    const executionRequest = request()
    const service = new MultiVenueExecutionService({ ...mocked, settings: () => settings(), liveExecutionEnabled: true, comparisonProvider: () => comparisonForRequest(executionRequest) } as never)
    const receipt = await service.execute(executionRequest)
    expect(receipt.status).toBe('HEDGED')
    expect(mocked.mexc.prepareOrder.mock.invocationCallOrder[0]).toBeLessThan(mocked.mexc.waitForFill.mock.invocationCallOrder[0])
    expect(mocked.kalshi.placeOrder).toHaveBeenCalledTimes(1)
    expect(mocked.kalshi.verifyTradingAccess).not.toHaveBeenCalled()
    expect((mocked.kalshi.placeOrder.mock.calls[0] as unknown as [Record<string, string>])[0]).toMatchObject({ quantity: '2.00', direction: 'DOWN' })
  })

  it('aligns Kalshi to the actual Polymarket fill after a partial first fill', async () => {
    const mocked = deps()
    mocked.polymarket.hedge.mockResolvedValueOnce({ venue: 'POLYMARKET', direction: 'UP', quantity: '1.00', averagePrice: '0.40', orderId: 'poly-partial', filledAt: Date.now() })
    mocked.kalshi.placeOrder.mockResolvedValueOnce({ orderId: 'kalshi-partial', clientOrderId: 'client', ticker: 'KXBTC15M-TEST', direction: 'DOWN' as const, side: 'ask' as const, quantity: '1.00', outcomePrice: '0.50', fillCount: '1.00', remainingCount: '0.00', status: 'EXECUTED' as const, submittedAt: Date.now(), message: 'filled' })
    const executionRequest = request(['POLYMARKET', 'KALSHI'])
    const service = new MultiVenueExecutionService({ ...mocked, settings: () => settings(), liveExecutionEnabled: true, comparisonProvider: () => comparisonForRequest(executionRequest) } as never)
    const receipt = await service.execute(executionRequest)
    expect(receipt.status).toBe('HEDGED')
    expect(mocked.kalshi.placeOrder).toHaveBeenCalledTimes(1)
    expect((mocked.kalshi.placeOrder.mock.calls[0] as unknown as [Record<string, string>])[0]).toMatchObject({ quantity: '1.00', direction: 'DOWN' })
    expect(receipt.message).toContain('双腿已对齐')
  })

  it('executes Gate first and then sends the exact fill to Kalshi', async () => {
    const mocked = deps()
    mocked.gate.submit.mockResolvedValueOnce({ orderId: 'gate-order', status: 'FILLED' as const, filledQuantity: '13.00', averagePrice: '0.40' })
    mocked.kalshi.placeOrder.mockResolvedValueOnce({ orderId: 'kalshi-order', clientOrderId: 'client', ticker: 'KXBTC15M-TEST', direction: 'DOWN' as const, side: 'ask' as const, quantity: '13.00', outcomePrice: '0.50', fillCount: '13.00', remainingCount: '0.00', status: 'EXECUTED' as const, submittedAt: Date.now(), message: 'filled' })
    const gateRequest: MultiVenueExecutionRequest = {
      comparisonId: 'gate-kalshi-1', quantity: '13.00', startTime: Date.now() - 10_000, endTime: Date.now() + 60_000, confirmed: true,
      legs: [
        { venueId: 'GATE', marketId: 'gate-event', outcomeId: 'gate-token', direction: 'UP', price: '0.40', availableQuantity: '13', quoteAgeMs: 100 },
        { venueId: 'KALSHI', marketId: 'KXBTC15M-TEST', outcomeId: 'KXBTC15M-TEST:YES', direction: 'DOWN', price: '0.50', availableQuantity: '13', quoteAgeMs: 100 }
      ]
    }
    const service = new MultiVenueExecutionService({ ...mocked, settings: () => settings(), liveExecutionEnabled: true, comparisonProvider: () => comparisonForRequest(gateRequest) } as never)
    const receipt = await service.execute(gateRequest)
    expect(receipt.status).toBe('HEDGED')
    expect(mocked.gate.submit).toHaveBeenCalledTimes(1)
    expect(mocked.kalshi.placeOrder).toHaveBeenCalledTimes(1)
    expect((mocked.kalshi.placeOrder.mock.calls[0] as unknown as [Record<string, string>])[0]).toMatchObject({ quantity: '13.00' })
  })

  it('executes a validated Polymarket↔Gate pair without invoking Kalshi credentials', async () => {
    const mocked = deps()
    mocked.polymarket.hedge.mockResolvedValueOnce({ venue: 'POLYMARKET', direction: 'UP', quantity: '13.00', averagePrice: '0.40', orderId: 'poly-gate-poly', filledAt: Date.now() })
    mocked.gate.submit.mockResolvedValueOnce({ orderId: 'gate-poly-gate', status: 'FILLED' as const, filledQuantity: '13.00', averagePrice: '0.40' })
    const executionRequest: MultiVenueExecutionRequest = {
      comparisonId: 'poly-gate-1', quantity: '13.00', startTime: Date.now() - 10_000, endTime: Date.now() + 60_000, confirmed: true,
      legs: [
        { venueId: 'POLYMARKET', marketId: 'poly-event', outcomeId: 'poly-token', direction: 'UP', price: '0.40', availableQuantity: '13', quoteAgeMs: 100 },
        { venueId: 'GATE', marketId: 'gate-event', outcomeId: 'gate-token', direction: 'DOWN', price: '0.40', availableQuantity: '13', quoteAgeMs: 100 }
      ]
    }
    const service = new MultiVenueExecutionService({
      ...mocked, settings: () => settings(), liveExecutionEnabled: true,
      comparisonProvider: () => comparisonForRequest(executionRequest),
      kalshiCredentialsReady: vi.fn(async () => { throw new Error('Kalshi credentials should not be read for this pair') })
    } as never)

    const receipt = await service.execute(executionRequest)
    expect(receipt.status).toBe('HEDGED')
    expect(mocked.polymarket.hedge).toHaveBeenCalledTimes(1)
    expect(mocked.gate.submit).toHaveBeenCalledTimes(1)
    expect(mocked.kalshi.placeOrder).not.toHaveBeenCalled()
  })

  it('rejects Predict.fun before any credential lookup or order submission', async () => {
    const mocked = deps()
    const executionRequest: MultiVenueExecutionRequest = {
      comparisonId: 'predict-gate-1', quantity: '13.00', startTime: Date.now() - 10_000, endTime: Date.now() + 60_000, confirmed: true,
      legs: [
        { venueId: 'PREDICT_FUN', marketId: 'predict-event', outcomeId: 'predict-token', direction: 'UP', price: '0.40', availableQuantity: '13', quoteAgeMs: 100 },
        { venueId: 'GATE', marketId: 'gate-event', outcomeId: 'gate-token', direction: 'DOWN', price: '0.40', availableQuantity: '13', quoteAgeMs: 100 }
      ]
    }
    const service = new MultiVenueExecutionService({
      ...mocked, settings: () => settings(), liveExecutionEnabled: true,
      comparisonProvider: () => comparisonForRequest(executionRequest),
      kalshiCredentialsReady: vi.fn(async () => { throw new Error('Kalshi credentials should not be read') })
    } as never)

    await expect(service.execute(executionRequest)).rejects.toThrow('Predict.fun')
    expect(mocked.gate.submit).not.toHaveBeenCalled()
    expect(mocked.kalshi.placeOrder).not.toHaveBeenCalled()
  })

  it('uses the global unprotected setting to start equal Gate and Kalshi submissions in parallel', async () => {
    const mocked = deps()
    type GateResult = Awaited<ReturnType<typeof mocked.gate.submit>>
    type KalshiResult = Awaited<ReturnType<typeof mocked.kalshi.placeOrder>>
    let resolveGate!: (result: GateResult) => void
    let resolveKalshi!: (result: KalshiResult) => void
    mocked.gate.submit.mockImplementation(() => new Promise<GateResult>((resolve) => { resolveGate = resolve }))
    mocked.kalshi.placeOrder.mockImplementation(() => new Promise<KalshiResult>((resolve) => { resolveKalshi = resolve }))
    const latest = comparison()
    const service = new MultiVenueExecutionService({
      ...mocked,
      settings: () => settings({ unprotectedExecutionEnabled: true }),
      liveExecutionEnabled: true,
      comparisonProvider: () => latest
    } as never)

    const execution = service.execute({ comparisonId: latest.id, quantity: '13.00', confirmed: true })
    await vi.waitFor(() => expect(mocked.gate.submit).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    const kalshiStartedBeforeGateResolved = mocked.kalshi.placeOrder.mock.calls.length === 1
    resolveGate({ orderId: 'gate-parallel', status: 'FILLED', filledQuantity: '13.00', averagePrice: '0.40' })
    if (!kalshiStartedBeforeGateResolved) await vi.waitFor(() => expect(mocked.kalshi.placeOrder).toHaveBeenCalledTimes(1))
    resolveKalshi({
      orderId: 'kalshi-parallel', clientOrderId: 'kalshi-client', ticker: 'KXBTC15M-TEST',
      direction: 'DOWN', side: 'ask', quantity: '13.00', outcomePrice: '0.50',
      fillCount: '13.00', remainingCount: '0.00', status: 'EXECUTED', submittedAt: Date.now(), message: 'filled'
    })
    const receipt = await execution

    expect(kalshiStartedBeforeGateResolved).toBe(true)
    expect(receipt.status).toBe('UNPROTECTED_SUBMITTED')
    expect((mocked.gate.submit.mock.calls[0] as unknown as [Record<string, string>])[0].quantity).toBe('13.00')
    expect((mocked.kalshi.placeOrder.mock.calls[0] as unknown as [Record<string, string>])[0].quantity).toBe('13.00')
  })

  it('unprotected multi-venue execution bypasses depth, freshness, fee and settlement gates', async () => {
    const mocked = deps()
    const latest = comparison({
      edgeKind: 'GROSS_ONLY',
      matchClass: 'CONDITIONAL',
      conditionalReturnPct: '-20',
      legs: comparison().legs.map((leg) => ({ ...leg, availableQuantity: '0', quoteAgeMs: 30_000 }))
    })
    const service = new MultiVenueExecutionService({
      ...mocked,
      settings: () => settings({ unprotectedExecutionEnabled: true, minConditionalReturnPct: '100' }),
      liveExecutionEnabled: true,
      comparisonProvider: () => latest
    } as never)

    const receipt = await service.execute({ comparisonId: latest.id, quantity: '13.00', confirmed: true })

    expect(receipt.status).toBe('UNPROTECTED_SUBMITTED')
    expect(mocked.gate.submit).toHaveBeenCalledTimes(1)
    expect(mocked.kalshi.placeOrder).toHaveBeenCalledTimes(1)
  })

  it('treats a two-decimal Kalshi fill as complete after a higher-precision Gate fill is rounded down', async () => {
    const mocked = deps()
    mocked.gate.submit.mockResolvedValueOnce({ orderId: 'gate-precision-order', status: 'FILLED' as const, filledQuantity: '7.192', averagePrice: '0.74' })
    mocked.kalshi.placeOrder.mockResolvedValueOnce({ orderId: 'kalshi-precision-order', clientOrderId: 'client', ticker: 'KXBTC15M-TEST', direction: 'DOWN' as const, side: 'ask' as const, quantity: '7.19', outcomePrice: '0.26', fillCount: '7.19', remainingCount: '0.00', status: 'EXECUTED' as const, submittedAt: Date.now(), message: 'filled' })
    const executionRequest: MultiVenueExecutionRequest = {
      comparisonId: 'gate-kalshi-precision', quantity: '8.00', startTime: Date.now() - 10_000, endTime: Date.now() + 60_000, confirmed: true,
      legs: [
        { venueId: 'GATE', marketId: 'gate-event', outcomeId: 'gate-token', direction: 'UP', price: '0.74', availableQuantity: '8', quoteAgeMs: 100 },
        { venueId: 'KALSHI', marketId: 'KXBTC15M-TEST', outcomeId: 'KXBTC15M-TEST:YES', direction: 'DOWN', price: '0.26', availableQuantity: '8', quoteAgeMs: 100 }
      ]
    }
    const service = new MultiVenueExecutionService({ ...mocked, settings: () => settings(), liveExecutionEnabled: true, comparisonProvider: () => comparisonForRequest(executionRequest) } as never)
    const receipt = await service.execute(executionRequest)
    expect(receipt.status).toBe('HEDGED')
    expect(receipt.message).toContain('双腿已对齐')
    expect((mocked.kalshi.placeOrder.mock.calls[0] as unknown as [Record<string, string>])[0]).toMatchObject({ quantity: '7.19' })
  })

  it('keeps a genuinely smaller second-leg fill in recovery', async () => {
    const mocked = deps()
    mocked.gate.submit.mockResolvedValueOnce({ orderId: 'gate-partial-precision-order', status: 'FILLED' as const, filledQuantity: '7.192', averagePrice: '0.74' })
    mocked.kalshi.placeOrder.mockResolvedValueOnce({ orderId: 'kalshi-partial-precision-order', clientOrderId: 'client', ticker: 'KXBTC15M-TEST', direction: 'DOWN' as const, side: 'ask' as const, quantity: '7.19', outcomePrice: '0.26', fillCount: '7.18', remainingCount: '0.01', status: 'EXECUTED' as const, submittedAt: Date.now(), message: 'partial' })
    const executionRequest: MultiVenueExecutionRequest = {
      comparisonId: 'gate-kalshi-genuine-partial', quantity: '8.00', startTime: Date.now() - 10_000, endTime: Date.now() + 60_000, confirmed: true,
      legs: [
        { venueId: 'GATE', marketId: 'gate-event', outcomeId: 'gate-token', direction: 'UP', price: '0.74', availableQuantity: '8', quoteAgeMs: 100 },
        { venueId: 'KALSHI', marketId: 'KXBTC15M-TEST', outcomeId: 'KXBTC15M-TEST:YES', direction: 'DOWN', price: '0.26', availableQuantity: '8', quoteAgeMs: 100 }
      ]
    }
    const service = new MultiVenueExecutionService({ ...mocked, settings: () => settings(), liveExecutionEnabled: true, comparisonProvider: () => comparisonForRequest(executionRequest) } as never)
    const receipt = await service.execute(executionRequest)
    expect(receipt.status).toBe('RECOVERY_REQUIRED')
    expect(receipt.message).toContain('仅成交 7.18 / 7.19')
  })

  it('使用主进程最新 comparison 并在过期时不提交第一腿', async () => {
    const mocked = deps()
    const latest = comparison({ legs: comparison().legs.map((leg) => ({ ...leg, quoteAgeMs: 9_000 })) })
    const service = new MultiVenueExecutionService({
      ...mocked, settings: () => settings(), liveExecutionEnabled: true,
      comparisonProvider: () => latest
    } as never)

    await expect(service.execute({ comparisonId: latest.id, quantity: '13.00', confirmed: true } as never)).rejects.toThrow('行情')
    expect(mocked.gate.submit).not.toHaveBeenCalled()
    expect(mocked.kalshi.placeOrder).not.toHaveBeenCalled()
  })

  it('主进程找不到最新 comparison 时不提交任何订单', async () => {
    const mocked = deps()
    const service = new MultiVenueExecutionService({
      ...mocked, settings: () => settings(), liveExecutionEnabled: true,
      comparisonProvider: () => undefined
    } as never)

    await expect(service.execute({ comparisonId: 'missing', quantity: '13.00', confirmed: true } as never)).rejects.toThrow('机会已变化')
    expect(mocked.gate.submit).not.toHaveBeenCalled()
  })

  it('本地 Kalshi 凭据或 Gate 捕获结构未就绪时不提交第一腿', async () => {
    const mocked = deps()
    const latest = comparison()
    const service = new MultiVenueExecutionService({
      ...mocked, settings: () => settings(), liveExecutionEnabled: true,
      comparisonProvider: () => latest,
      kalshiCredentialsReady: async () => false,
      gateExecutionReady: () => false
    } as never)

    await expect(service.execute({ comparisonId: latest.id, quantity: '13.00', confirmed: true })).rejects.toThrow('Kalshi')
    expect(mocked.gate.submit).not.toHaveBeenCalled()
    expect(mocked.kalshi.placeOrder).not.toHaveBeenCalled()
  })

  it('按机会周期检查 Gate 页面，5m 页面不能放行 15m 订单', async () => {
    const mocked = deps()
    const latest = comparison({ durationMinutes: 15 })
    const gateExecutionReady = vi.fn((duration: number) => duration === 5)
    const service = new MultiVenueExecutionService({
      ...mocked, settings: () => settings(), liveExecutionEnabled: true,
      comparisonProvider: () => latest,
      gateExecutionReady
    } as never)

    await expect(service.execute({ comparisonId: latest.id, quantity: '13.00', confirmed: true })).rejects.toThrow('Gate 15m')
    expect(gateExecutionReady).toHaveBeenCalledWith(15)
    expect(mocked.gate.submit).not.toHaveBeenCalled()
  })

  it('已有双腿执行进行中时拒绝并发提交，避免重复首腿订单', async () => {
    const mocked = deps()
    const latest = comparison()
    let releaseGate!: (value: { orderId: string; status: 'FILLED'; filledQuantity: string; averagePrice: string }) => void
    mocked.gate.submit.mockImplementation(() => new Promise((resolve) => { releaseGate = resolve }))
    const service = new MultiVenueExecutionService({
      ...mocked, settings: () => settings(), liveExecutionEnabled: true,
      comparisonProvider: () => latest
    } as never)
    const command = { comparisonId: latest.id, quantity: '13.00', confirmed: true }

    const first = service.execute(command)
    await vi.waitFor(() => expect(mocked.gate.submit).toHaveBeenCalledTimes(1))
    const second = service.execute(command)
    await Promise.resolve()
    releaseGate({ orderId: 'gate-once', status: 'FILLED', filledQuantity: '13.00', averagePrice: '0.40' })
    const results = await Promise.allSettled([first, second])

    expect(mocked.gate.submit).toHaveBeenCalledTimes(1)
    expect(results[0].status).toBe('fulfilled')
    expect(results[1]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('正在执行') }) })
  })

})
