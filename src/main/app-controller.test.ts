import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppController } from './app-controller'
import { EventStore } from './services/event-store'
import type { MexcBrowserManager } from './services/mexc-browser'
import type { PolymarketMarketData } from './services/polymarket-market-data'
import type { PolymarketLiveBroker } from './services/polymarket-live'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true })
  }
})

describe('AppController simulation', () => {
  it('never hedges before a MEXC fill and finishes with aligned quantities', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arbdesk-test-'))
    temporaryDirectories.push(directory)
    // Use the next complete window so this test cannot enter the stop-before-expiry guard near a 5m boundary.
    const startTime = Math.ceil(Date.now() / 300_000) * 300_000
    const confirmMexcQuote = vi.fn(async () => undefined)
    const confirmPolymarketQuote = vi.fn(async () => undefined)
    const mexcBrowser = {
      configure: () => undefined,
      getCalibration: () => ({ amountInput: false, upButton: false, downButton: false, submitButton: false }),
      getStatus: () => ({
        mode: 'EMBEDDED',
        open: false,
        authenticated: false,
        automationAvailable: false,
        monitoring: false,
        calibrated: { amountInput: false, upButton: false, downButton: false, submitButton: false },
        message: 'test'
      }),
      getCachedAccountState: () => ({ checkedAt: Date.now(), reachable: true, authenticated: true, availableUsdt: '100', positionCount: 0, openOrderCount: 0, historyCount: 0, positionFields: [], openOrderFields: [], historyFields: [], fillReadbackReady: true, message: 'test' }),
      ensureAccountBalance: async () => ({ checkedAt: Date.now(), reachable: true, authenticated: true, availableUsdt: '100', positionCount: 0, openOrderCount: 0, historyCount: 0, positionFields: [], openOrderFields: [], historyFields: [], fillReadbackReady: true, message: 'test' }),
      confirmMarketQuote: confirmMexcQuote,
      fetchActiveBtcWindows: async () => [{
        eventId: 'mexc-test',
        durationMinutes: 5,
        startTime,
        endTime: startTime + 300_000,
        baselinePrice: '60000', indexPrice: '60030', indexReceivedAt: Date.now(), feeRate: '0.015', feeRateSource: 'HISTORY',
        outcomes: {
          UP: { direction: 'UP', symbolId: 'up', bestAsk: '0.40', askSize: '100', levels: [], receivedAt: Date.now() },
          DOWN: { direction: 'DOWN', symbolId: 'down', bestAsk: '0.60', askSize: '100', levels: [], receivedAt: Date.now() }
        }
      }]
    } as unknown as MexcBrowserManager
    const polymarketData = {
      configureProxy: () => undefined,
      getStatus: () => ({ connected: true, message: 'test' }),
      confirmOutcomeQuote: confirmPolymarketQuote,
      fetchWindows: async () => [{
        durationMinutes: 5,
        startTime,
        endTime: startTime + 300_000,
        baselinePrice: '60000', indexPrice: '60030', indexReceivedAt: Date.now(),
        outcomes: {
          UP: { direction: 'UP', tokenId: 'poly-up', bestAsk: '0.55', askSize: '100', levels: [], receivedAt: Date.now(), feeRate: '0.07' },
          DOWN: { direction: 'DOWN', tokenId: 'poly-down', bestAsk: '0.50', askSize: '100', levels: [], receivedAt: Date.now(), feeRate: '0.07', minOrderSize: '5' }
        }
      }]
    } as unknown as PolymarketMarketData
    const controller = new AppController(new EventStore(directory), mexcBrowser, polymarketData)
    await controller.initialize()
    await controller.refreshOpportunities()
    const opportunity = controller.getSnapshot().opportunities[0]

    await controller.updateSettings({ minConditionalReturnPct: '100' })
    await expect(controller.execute({ opportunityId: opportunity.id, quantity: '5' })).rejects.toThrow('条件收益率')
    await controller.updateSettings({ minConditionalReturnPct: '0' })
    const session = await controller.execute({ opportunityId: opportunity.id, quantity: '5' })

    expect(confirmMexcQuote).toHaveBeenCalledWith('up')
    expect(confirmPolymarketQuote).toHaveBeenCalledWith('poly-down')
    expect(session.state).toBe('HEDGED')
    expect(session.mexcFill?.quantity).toBe('5.00')
    expect(session.polymarketFill?.quantity).toBe('5.00')
    const events = controller.getSnapshot().recentEvents.map((event) => event.state).reverse()
    expect(events).toEqual(['MEXC_OPENING', 'MEXC_SUBMITTING', 'MEXC_FILLED', 'POLY_HEDGING', 'HEDGED'])
    const openOrder = controller.getSnapshot().orderHistory[0]
    expect(openOrder).toMatchObject({ status: 'OPEN' })
    expect(openOrder.mexc.openQuantity).toBe('5.00')
    expect(openOrder.polymarket.openQuantity).toBe('5.00')

    const closedOrder = await controller.closeOrder({ orderId: openOrder.id, target: 'BOTH' })
    expect(closedOrder.status).toBe('CLOSED')
    expect(closedOrder.mexc.openQuantity).toBe('0')
    expect(closedOrder.polymarket.openQuantity).toBe('0')
    expect((await new EventStore(directory).loadOrderHistory())[0].status).toBe('CLOSED')
  })

  it('persists and applies the selected MEXC browser mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arbdesk-browser-test-'))
    temporaryDirectories.push(directory)
    const configurations: Array<{ mode: string; hubstudioContainerCode: string; elementMode: string }> = []
    const mexcBrowser = {
      configure: (configuration: { mode: string; hubstudioContainerCode: string; elementMode: string }) => configurations.push(configuration),
      getCalibration: () => ({ amountInput: false, upButton: false, downButton: false, submitButton: false }),
      getStatus: () => ({
        mode: 'EMBEDDED',
        open: false,
        authenticated: false,
        automationAvailable: false,
        monitoring: false,
        calibrated: { amountInput: false, upButton: false, downButton: false, submitButton: false },
        message: 'test'
      })
    } as unknown as MexcBrowserManager
    const store = new EventStore(directory)
    const controller = new AppController(store, mexcBrowser)
    await controller.initialize()

    const settings = await controller.updateSettings({
      mexcBrowserMode: 'HUBSTUDIO',
      hubstudioContainerCode: ' 223012801 ',
      maxCapitalPerTrade: '250.5',
      minConditionalReturnPct: '1.234',
      maxQuoteAgeMs: 9_000
    })

    expect(settings.mexcBrowserMode).toBe('HUBSTUDIO')
    expect(settings.hubstudioContainerCode).toBe('223012801')
    expect(settings.maxCapitalPerTrade).toBe('250.50')
    expect(settings.minConditionalReturnPct).toBe('1.23')
    expect(settings.maxQuoteAgeMs).toBe(9_000)
    expect(configurations.at(-1)).toEqual({ mode: 'HUBSTUDIO', hubstudioContainerCode: '223012801', elementMode: 'AUTO' })
    await expect(controller.updateSettings({ maxCapitalPerTrade: '0' })).rejects.toThrow('单笔最大本金')
    await expect(controller.updateSettings({ maxCapitalPerTrade: '1000001' })).rejects.toThrow('单笔最大本金')
    await expect(controller.updateSettings({ minConditionalReturnPct: '-1' })).rejects.toThrow('最低条件收益率')
    await expect(controller.updateSettings({ minConditionalReturnPct: '101' })).rejects.toThrow('最低条件收益率')
    await expect(controller.updateSettings({ maxQuoteAgeMs: 2_000 })).rejects.toThrow('行情最长未确认时间')
    await expect(controller.updateSettings({ maxQuoteAgeMs: 31_000 })).rejects.toThrow('行情最长未确认时间')
  })

  it('matches 5m and 15m quotes only within the same duration and round', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arbdesk-duration-match-test-'))
    temporaryDirectories.push(directory)
    const startTime = Math.ceil(Date.now() / 900_000) * 900_000
    const makeMexcWindow = (durationMinutes: 5 | 15) => ({
      eventId: `mexc-${durationMinutes}m`, durationMinutes, startTime,
      endTime: startTime + durationMinutes * 60_000,
      baselinePrice: '60000', indexPrice: '60030', indexReceivedAt: Date.now(),
      feeRate: '0.015', feeRateSource: 'HISTORY' as const,
      outcomes: {
        UP: { direction: 'UP' as const, symbolId: `${durationMinutes}-up`, bestAsk: '0.40', askSize: '100', levels: [], receivedAt: Date.now() },
        DOWN: { direction: 'DOWN' as const, symbolId: `${durationMinutes}-down`, bestAsk: '0.60', askSize: '100', levels: [], receivedAt: Date.now() }
      }
    })
    const mexcBrowser = {
      configure: () => undefined,
      getCalibration: () => ({ amountInput: false, upButton: false, downButton: false, submitButton: false }),
      getStatus: () => ({
        mode: 'HUBSTUDIO', open: true, authenticated: true, automationAvailable: true, monitoring: true,
        calibrated: { amountInput: false, upButton: false, downButton: false, submitButton: false }, message: 'test'
      }),
      fetchActiveBtcWindows: async () => [makeMexcWindow(5), makeMexcWindow(15)]
    } as unknown as MexcBrowserManager
    const makePolyWindow = (durationMinutes: 5 | 15, roundStart: number) => ({
      durationMinutes, startTime: roundStart, endTime: roundStart + durationMinutes * 60_000,
      baselinePrice: '60000', indexPrice: '60030', indexReceivedAt: Date.now(),
      outcomes: {
        UP: { direction: 'UP' as const, tokenId: `${durationMinutes}-poly-up`, bestAsk: '0.55', askSize: '100', levels: [], receivedAt: Date.now(), feeRate: '0.07', minOrderSize: '5' },
        DOWN: { direction: 'DOWN' as const, tokenId: `${durationMinutes}-poly-down`, bestAsk: '0.50', askSize: '100', levels: [], receivedAt: Date.now(), feeRate: '0.07', minOrderSize: '5' }
      }
    })
    const polymarketData = {
      configureProxy: () => undefined,
      getStatus: () => ({ connected: true, message: 'test' }),
      fetchWindows: async () => [makePolyWindow(5, startTime), makePolyWindow(15, startTime + 300_000)]
    } as unknown as PolymarketMarketData
    const controller = new AppController(new EventStore(directory), mexcBrowser, polymarketData)
    await controller.initialize()

    const snapshot = await controller.refreshOpportunities()

    expect(snapshot.opportunities).toHaveLength(2)
    expect(snapshot.opportunities.every((opportunity) => opportunity.durationMinutes === 5)).toBe(true)
    expect(snapshot.opportunities.map((opportunity) => opportunity.mexcDirection)).toEqual(['UP', 'DOWN'])
    expect(snapshot.connectionDetails.mexc).toContain('5m/15m 并行监控')
  })

  it('allows supervised automatic clicking without manual selectors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arbdesk-auto-detect-test-'))
    temporaryDirectories.push(directory)
    const mexcBrowser = {
      configure: () => undefined,
      getCalibration: () => ({ amountInput: false, upButton: false, downButton: false, submitButton: false }),
      getStatus: () => ({
        mode: 'HUBSTUDIO',
        open: true,
        authenticated: true,
        automationAvailable: true,
        monitoring: true,
        calibrated: { amountInput: false, upButton: false, downButton: false, submitButton: false },
        message: 'test'
      })
    } as unknown as MexcBrowserManager
    const controller = new AppController(new EventStore(directory), mexcBrowser)
    await controller.initialize()
    await controller.updateSettings({ mode: 'ASSISTED' })

    await controller.updateSettings({ mexcElementMode: 'MANUAL' })
    await expect(controller.updateSettings({ mexcAutomationEnabled: true }))
      .rejects.toThrow('手动校准模式需要完成')
    await controller.updateSettings({ mexcElementMode: 'AUTO' })

    const settings = await controller.updateSettings({ mexcAutomationEnabled: true })

    expect(settings.mexcAutomationEnabled).toBe(true)
  })

  it('uses the real Polymarket broker only after supervised live hedging is enabled', async () => {
    vi.stubEnv('ARB_ENABLE_LIVE_EXECUTION', 'true')
    const directory = await mkdtemp(join(tmpdir(), 'arbdesk-live-broker-test-'))
    temporaryDirectories.push(directory)
    const startTime = Math.ceil(Date.now() / 300_000) * 300_000
    const mexcBrowser = {
      configure: () => undefined,
      getCalibration: () => ({ amountInput: false, upButton: false, downButton: false, submitButton: false }),
      getStatus: () => ({
        mode: 'HUBSTUDIO', open: true, authenticated: true, automationAvailable: true, monitoring: true,
        calibrated: { amountInput: false, upButton: false, downButton: false, submitButton: false }, message: 'test'
      }),
      getCachedAccountState: () => ({ checkedAt: Date.now(), reachable: true, authenticated: true, availableUsdt: '100', positionCount: 0, openOrderCount: 0, historyCount: 0, positionFields: [], openOrderFields: [], historyFields: [], fillReadbackReady: true, message: 'test' }),
      ensureAccountBalance: async () => ({ checkedAt: Date.now(), reachable: true, authenticated: true, availableUsdt: '100', positionCount: 0, openOrderCount: 0, historyCount: 0, positionFields: [], openOrderFields: [], historyFields: [], fillReadbackReady: true, message: 'test' }),
      fetchActiveBtcWindows: async () => [{
        eventId: 'mexc-live-test', durationMinutes: 5, startTime, endTime: startTime + 300_000,
        baselinePrice: '60000', indexPrice: '60030', indexReceivedAt: Date.now(), feeRate: '0.015', feeRateSource: 'HISTORY',
        outcomes: {
          UP: { direction: 'UP', symbolId: 'up', bestAsk: '0.40', askSize: '100', levels: [], receivedAt: Date.now() },
          DOWN: { direction: 'DOWN', symbolId: 'down', bestAsk: '0.60', askSize: '100', levels: [], receivedAt: Date.now() }
        }
      }],
      open: async () => undefined,
      prepareOrder: async () => ({ ok: true, message: 'prepared', matched: {} })
    } as unknown as MexcBrowserManager
    const polymarketData = {
      configureProxy: () => undefined,
      getStatus: () => ({ connected: true, message: 'test' }),
      fetchWindows: async () => [{
        durationMinutes: 5, startTime, endTime: startTime + 300_000,
        baselinePrice: '60000', indexPrice: '60030', indexReceivedAt: Date.now(),
        outcomes: {
          UP: { direction: 'UP', tokenId: 'poly-up', bestAsk: '0.55', askSize: '100', levels: [], receivedAt: Date.now(), feeRate: '0.07' },
          DOWN: { direction: 'DOWN', tokenId: 'poly-down', bestAsk: '0.50', askSize: '100', levels: [], receivedAt: Date.now(), feeRate: '0.07' }
        }
      }]
    } as unknown as PolymarketMarketData
    const hedge = vi.fn(async (order) => ({
      venue: 'POLYMARKET' as const,
      direction: order.direction,
      quantity: order.quantity,
      averagePrice: '0.51',
      orderId: 'poly-live-order',
      filledAt: Date.now()
    }))
    const liveBroker = {
      configureProxy: () => undefined,
      isConfigured: async () => true,
      getCachedTradingCapacity: () => ({ checkedAt: Date.now(), collateralBalance: '100', allowanceReady: true, closedOnly: false }),
      ensureTradingCapacity: async () => ({ checkedAt: Date.now(), collateralBalance: '100', allowanceReady: true, closedOnly: false }),
      hedge
    } as unknown as PolymarketLiveBroker
    const controller = new AppController(new EventStore(directory), mexcBrowser, polymarketData, liveBroker)
    await controller.initialize()
    await controller.updateSettings({ mode: 'ASSISTED', polymarketLiveEnabled: true })
    await controller.refreshOpportunities()
    const opportunity = controller.getSnapshot().opportunities[0]
    await controller.execute({ opportunityId: opportunity.id, quantity: '10' })

    const session = await controller.confirmMexcFill({ quantity: '10', averagePrice: '0.40', orderId: 'mexc-fill' })

    expect(hedge).toHaveBeenCalledWith(expect.objectContaining({
      tokenId: 'poly-down', direction: 'DOWN', quantity: '10.00', maximumPrice: '0.5000'
    }))
    expect(session.state).toBe('HEDGED')
    expect(session.polymarketFill?.orderId).toBe('poly-live-order')
  })

  it('waits 500ms using cached quotes before automatic opening performs lightweight balance checks', async () => {
    vi.useFakeTimers()
    const now = 1_800_000_000_000
    vi.setSystemTime(now)
    const store = {
      initialize: async () => undefined,
      loadSettings: async (defaults: unknown) => defaults,
      saveSettings: async () => undefined,
      loadRecentEvents: async () => [],
      loadOrderHistory: async () => [],
      saveOrderHistory: async () => undefined,
      appendEvent: async () => undefined
    } as unknown as EventStore
    const startTime = now - 60_000
    const ensureMexcBalance = vi.fn(async () => ({
      checkedAt: Date.now(), reachable: true, authenticated: true, availableUsdt: '100',
      positionCount: 0, openOrderCount: 0, historyCount: 0, positionFields: [], openOrderFields: [], historyFields: [],
      fillReadbackReady: true, message: 'test'
    }))
    const prepareOrder = vi.fn(async () => ({ ok: true, orderAccepted: true, submittedAt: Date.now(), message: 'accepted', matched: {} }))
    const mexcBrowser = {
      configure: () => undefined,
      onMarketData: () => () => undefined,
      getCalibration: () => ({ amountInput: false, upButton: false, downButton: false, submitButton: false }),
      getStatus: () => ({
        mode: 'HUBSTUDIO', open: true, authenticated: true, automationAvailable: true, monitoring: true,
        calibrated: { amountInput: false, upButton: false, downButton: false, submitButton: false }, message: 'test'
      }),
      getCachedAccountState: () => undefined,
      ensureAccountBalance: ensureMexcBalance,
      fetchActiveBtcWindows: async () => [{
        eventId: 'mexc-auto', durationMinutes: 5, startTime, endTime: startTime + 300_000,
        baselinePrice: '60000', indexPrice: '60060', indexReceivedAt: Date.now(), feeRate: '0.015', feeRateSource: 'HISTORY',
        outcomes: {
          UP: { direction: 'UP', symbolId: 'mexc-up', bestAsk: '0.35', askSize: '20', levels: [{ price: '0.35', size: '20' }], receivedAt: Date.now() },
          DOWN: { direction: 'DOWN', symbolId: 'mexc-down', bestAsk: '0.65', askSize: '20', levels: [{ price: '0.65', size: '20' }], receivedAt: Date.now() }
        }
      }],
      open: async () => undefined,
      prepareOrder,
      waitForFill: async () => undefined
    } as unknown as MexcBrowserManager
    const polymarketData = {
      configureProxy: () => undefined,
      onMarketData: () => () => undefined,
      getStatus: () => ({ connected: true, message: 'test' }),
      fetchWindows: async () => [{
        durationMinutes: 5, startTime, endTime: startTime + 300_000,
        baselinePrice: '60000', indexPrice: '60060', indexReceivedAt: Date.now(),
        outcomes: {
          UP: { direction: 'UP', tokenId: 'poly-up', bestAsk: '0.70', askSize: '20', levels: [{ price: '0.70', size: '20' }], receivedAt: Date.now(), feeRate: '0.07', feeExponent: '1', minOrderSize: '1' },
          DOWN: { direction: 'DOWN', tokenId: 'poly-down', bestAsk: '0.45', askSize: '20', levels: [{ price: '0.45', size: '20' }], receivedAt: Date.now(), feeRate: '0.07', feeExponent: '1', minOrderSize: '1' }
        }
      }]
    } as unknown as PolymarketMarketData
    const ensurePolyCapacity = vi.fn(async () => ({ checkedAt: Date.now(), collateralBalance: '100', allowanceReady: true, closedOnly: false }))
    const liveBroker = {
      configureProxy: () => undefined,
      isConfigured: async () => true,
      getCachedTradingCapacity: () => undefined,
      ensureTradingCapacity: ensurePolyCapacity
    } as unknown as PolymarketLiveBroker
    const controller = new AppController(store, mexcBrowser, polymarketData, liveBroker, true)
    await controller.initialize()
    await controller.updateSettings({
      mode: 'ASSISTED', mexcAutomationEnabled: true, polymarketLiveEnabled: true,
      minNetEdgePerShare: '0', minConditionalReturnPct: '0', autoOpenEnabled: true,
      autoOpenQuantityMode: 'FIXED', autoOpenFixedQuantity: '5'
    })
    const automaticSnapshot = await controller.refreshOpportunities()
    expect(automaticSnapshot.opportunities).toHaveLength(2)
    expect(automaticSnapshot.autoOpenState.status).toBe('STABILIZING')

    await vi.advanceTimersByTimeAsync(499)
    expect(prepareOrder).not.toHaveBeenCalled()
    expect(ensureMexcBalance).not.toHaveBeenCalled()
    expect(ensurePolyCapacity).not.toHaveBeenCalled()

    await vi.runOnlyPendingTimersAsync()
    expect(prepareOrder).toHaveBeenCalledTimes(1)
    expect(ensureMexcBalance).toHaveBeenCalledTimes(1)
    expect(ensurePolyCapacity).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().autoOpenState.status).toBe('COOLDOWN')
  })
})
