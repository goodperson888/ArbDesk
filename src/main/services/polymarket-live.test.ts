import { describe, expect, it, vi } from 'vitest'
import { AssetType, OrderType, type ClobClient } from '@polymarket/clob-client-v2'
import type { PolymarketCredentialStore, PolymarketCredentials } from './polymarket-credential-store'
import { PolymarketLiveBroker } from './polymarket-live'

const PRIVATE_KEY = `0x${'1'.padStart(64, '0')}`
const CREDENTIALS: PolymarketCredentials = {
  signatureType: 0,
  funderAddress: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
  signerPrivateKey: PRIVATE_KEY,
  apiKey: 'test-api-key',
  apiSecret: 'test-secret',
  apiPassphrase: 'test-passphrase'
}

function credentialStore(): PolymarketCredentialStore {
  return {
    getCredentials: vi.fn(async () => CREDENTIALS),
    getSummary: vi.fn(async () => ({ configured: true })),
    update: vi.fn()
  } as unknown as PolymarketCredentialStore
}

function orderBook() {
  return {
    market: 'condition',
    asset_id: 'token',
    timestamp: String(Date.now()),
    bids: [],
    asks: [{ price: '0.55', size: '100' }],
    min_order_size: '5',
    tick_size: '0.01',
    neg_risk: false,
    hash: 'hash',
    last_trade_price: '0.54'
  } as const
}

describe('PolymarketLiveBroker', () => {
  it('derives API credentials from the private key and never returns secrets to the UI', async () => {
    const store = credentialStore()
    const update = vi.mocked(store.update)
    update.mockResolvedValue({
      configured: true,
      encryptionAvailable: true,
      signatureType: 0,
      funderAddress: CREDENTIALS.funderAddress,
      signerAddress: CREDENTIALS.funderAddress,
      apiKeyMasked: 'test••••-key',
      hasSignerPrivateKey: true,
      hasApiSecret: true,
      hasApiPassphrase: true,
      message: 'saved'
    })
    const client = {
      createOrDeriveApiKey: vi.fn(async () => ({
        key: CREDENTIALS.apiKey,
        secret: CREDENTIALS.apiSecret,
        passphrase: CREDENTIALS.apiPassphrase
      }))
    } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(store, () => client)

    const summary = await broker.configureIdentity({
      signatureType: 0,
      funderAddress: CREDENTIALS.funderAddress,
      signerPrivateKey: PRIVATE_KEY
    })

    expect(summary).not.toHaveProperty('apiSecret')
    expect(summary).not.toHaveProperty('signerPrivateKey')
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: CREDENTIALS.apiKey,
      apiSecret: CREDENTIALS.apiSecret,
      apiPassphrase: CREDENTIALS.apiPassphrase
    }))
  })

  it('supports a Magic email proxy whose signer and funder addresses differ', async () => {
    const store = credentialStore()
    const update = vi.mocked(store.update)
    const proxyFunder = '0x1111111111111111111111111111111111111111'
    update.mockResolvedValue({
      configured: true,
      encryptionAvailable: true,
      signatureType: 1,
      funderAddress: proxyFunder,
      signerAddress: CREDENTIALS.funderAddress,
      apiKeyMasked: 'test••••-key',
      hasSignerPrivateKey: true,
      hasApiSecret: true,
      hasApiPassphrase: true,
      message: 'saved'
    })
    const client = {
      createOrDeriveApiKey: vi.fn(async () => ({
        key: CREDENTIALS.apiKey,
        secret: CREDENTIALS.apiSecret,
        passphrase: CREDENTIALS.apiPassphrase
      }))
    } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(store, () => client)

    await expect(broker.configureIdentity({
      signatureType: 1,
      funderAddress: proxyFunder,
      signerPrivateKey: PRIVATE_KEY
    })).resolves.toEqual(expect.objectContaining({ signatureType: 1, funderAddress: proxyFunder }))
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      signatureType: 1,
      funderAddress: proxyFunder,
      signerPrivateKey: PRIVATE_KEY
    }))
  })

  it('validates authentication and signs locally without posting an order', async () => {
    const postOrder = vi.fn()
    const client = {
      getApiKeys: vi.fn(async () => ({ apiKeys: [{ key: CREDENTIALS.apiKey, secret: '', passphrase: '' }] })),
      getClosedOnlyMode: vi.fn(async () => ({ closed_only: false })),
      getBalanceAllowance: vi.fn(async ({ asset_type }: { asset_type: AssetType }) => {
        expect(asset_type).toBe(AssetType.COLLATERAL)
        return { balance: '59000000', allowances: { exchange: '1000000000' } }
      }),
      getOpenOrders: vi.fn(async () => []),
      getTrades: vi.fn(async () => []),
      getOrderBook: vi.fn(async () => orderBook()),
      createOrder: vi.fn(async () => ({ version: 2 })),
      postOrder
    } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(credentialStore(), () => client)

    const result = await broker.validateIdentity('token')

    expect(result.ok).toBe(true)
    expect(result.collateralBalance).toBe('59')
    expect(result.localOrderSigned).toBe(true)
    expect(postOrder).not.toHaveBeenCalled()
  })

  it('accepts successful L2 authentication even when the API-key list does not echo the current key', async () => {
    const client = {
      getApiKeys: vi.fn(async () => ({ apiKeys: [{ key: 'another-key', secret: '', passphrase: '' }] })),
      getClosedOnlyMode: vi.fn(async () => ({ closed_only: false })),
      getBalanceAllowance: vi.fn(async () => ({
        balance: '59000000',
        allowances: { exchange: '1000000000' }
      })),
      getOpenOrders: vi.fn(async () => []),
      getTrades: vi.fn(async () => [])
    } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(credentialStore(), () => client)

    const result = await broker.validateIdentity()

    expect(result.apiAuthenticated).toBe(true)
    expect(result.ok).toBe(true)
  })

  it('refreshes maximum-order capacity with only balance and closed-only requests, then reuses the cache', async () => {
    const getBalanceAllowance = vi.fn(async () => ({
      balance: '42000000', allowances: { exchange: '1000000000' }
    }))
    const getClosedOnlyMode = vi.fn(async () => ({ closed_only: false }))
    const client = { getBalanceAllowance, getClosedOnlyMode } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(credentialStore(), () => client)

    await expect(broker.ensureTradingCapacity()).resolves.toEqual(expect.objectContaining({
      collateralBalance: '42', allowanceReady: true, closedOnly: false
    }))
    await broker.ensureTradingCapacity()

    expect(getBalanceAllowance).toHaveBeenCalledTimes(1)
    expect(getClosedOnlyMode).toHaveBeenCalledTimes(1)
  })

  it('prefetches the order book and balance so the hedge hot path does not re-request them', async () => {
    const getOrderBook = vi.fn(async () => orderBook())
    const getBalanceAllowance = vi.fn(async () => ({
      balance: '100000000',
      allowances: { '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e': '1000000000' }
    }))
    const client = {
      getOrderBook,
      getBalanceAllowance,
      getClosedOnlyMode: vi.fn(async () => ({ closed_only: false })),
      createMarketOrder: vi.fn(async () => ({ version: 2 })),
      postOrder: vi.fn(async () => ({
        success: true, orderID: 'cached-order', status: 'matched', takingAmount: '10', makingAmount: '5.5'
      }))
    } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(credentialStore(), () => client)

    await Promise.all([
      broker.ensureTradingCapacity(0),
      broker.prefetchOrderBooks(['token'])
    ])
    await broker.hedge({ tokenId: 'token', direction: 'DOWN', quantity: '10', maximumPrice: '0.57' })

    expect(getOrderBook).toHaveBeenCalledTimes(1)
    expect(getBalanceAllowance).toHaveBeenCalledTimes(1)
  })

  it('prefetches V2 market metadata by condition id on the authenticated execution client', async () => {
    const getClobMarketInfo = vi.fn(async () => ({ condition_id: 'condition-1' }))
    const client = {
      getOrderBook: vi.fn(async () => orderBook()),
      getClobMarketInfo
    } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(credentialStore(), () => client)

    await broker.prefetchMarkets([{ conditionId: 'condition-1', tokenIds: ['token'] }])

    expect(getClobMarketInfo).toHaveBeenCalledWith('condition-1')
    expect(client.getOrderBook).toHaveBeenCalledWith('token')
  })

  it('deduplicates concurrent prefetches and keeps condition metadata warm for the market lifetime', async () => {
    let releaseMarketInfo!: () => void
    const marketInfoPending = new Promise<void>((resolve) => { releaseMarketInfo = resolve })
    const getClobMarketInfo = vi.fn(async () => {
      await marketInfoPending
      return { condition_id: 'condition-1' }
    })
    const getOrderBook = vi.fn(async () => orderBook())
    const client = { getOrderBook, getClobMarketInfo } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(credentialStore(), () => client)

    const first = broker.prefetchMarkets([{ conditionId: 'condition-1', tokenIds: ['token'] }])
    const second = broker.prefetchMarkets([{ conditionId: 'condition-1', tokenIds: ['token'] }])
    releaseMarketInfo()
    await Promise.all([first, second])
    await broker.prefetchMarkets([{ conditionId: 'condition-1', tokenIds: ['token'] }])

    expect(getClobMarketInfo).toHaveBeenCalledTimes(1)
    expect(getOrderBook).toHaveBeenCalledTimes(1)
  })

  it('opens a cooldown circuit after a CLOB 429 instead of immediately requesting again', async () => {
    const rateLimited = Object.assign(new Error('rate limited'), {
      response: { status: 429, headers: { 'retry-after': '60' } }
    })
    const getClobMarketInfo = vi.fn(async () => { throw rateLimited })
    const client = {
      getOrderBook: vi.fn(async () => orderBook()),
      getClobMarketInfo
    } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(credentialStore(), () => client)

    await expect(broker.prefetchMarkets([{ conditionId: 'condition-1', tokenIds: ['token'] }]))
      .rejects.toThrow('已暂停自动请求')
    await expect(broker.prefetchMarkets([{ conditionId: 'condition-2', tokenIds: [] }]))
      .rejects.toThrow('请求保护已触发')

    expect(getClobMarketInfo).toHaveBeenCalledTimes(1)
  })

  it('caches the CLOB server-time offset and reuses the authenticated client', async () => {
    const getServerTime = vi.fn(async () => Date.now() + 1_234)
    const client = {
      getServerTime,
      getOrderBook: vi.fn(async () => orderBook()),
      getBalanceAllowance: vi.fn(async () => ({
        balance: '100000000',
        allowances: { '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e': '1000000000' }
      })),
      getClosedOnlyMode: vi.fn(async () => ({ closed_only: false }))
    } as unknown as ClobClient
    const factory = vi.fn(() => client)
    const broker = new PolymarketLiveBroker(credentialStore(), factory)

    await broker.prefetchServerTime()
    await broker.prefetchServerTime()
    await broker.ensureTradingCapacity(0)

    expect(getServerTime).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('probes read-only balances and recommends the funded signature type', async () => {
    const proxyFunder = '0x1111111111111111111111111111111111111111'
    const proxyCredentials: PolymarketCredentials = {
      ...CREDENTIALS,
      signatureType: 1,
      funderAddress: proxyFunder
    }
    const store = {
      getCredentials: vi.fn(async () => proxyCredentials),
      getSummary: vi.fn(async () => ({ configured: true })),
      update: vi.fn()
    } as unknown as PolymarketCredentialStore
    const broker = new PolymarketLiveBroker(store, (options) => ({
      getApiKeys: vi.fn(async () => ({ apiKeys: [] })),
      getClosedOnlyMode: vi.fn(async () => ({ closed_only: false })),
      getBalanceAllowance: vi.fn(async () => ({
        balance: options.signatureType === 2 ? '59120000' : '0',
        allowances: {}
      })),
      getOpenOrders: vi.fn(async () => []),
      getTrades: vi.fn(async () => [])
    }) as unknown as ClobClient)

    const result = await broker.validateIdentity()

    expect(result.ok).toBe(false)
    expect(result.suggestedSignatureType).toBe(2)
    expect(result.message).toContain('抵押资产59.12')
  })

  it('submits the target shares only at the current best ask instead of spending the full hedge cap', async () => {
    const postOrder = vi.fn(async (_signed, orderType) => {
      expect(orderType).toBe(OrderType.FAK)
      return {
        success: true,
        errorMsg: '',
        orderID: 'poly-order-1',
        status: 'matched',
        takingAmount: '10',
        makingAmount: '5.5'
      }
    })
    const client = {
      getOrderBook: vi.fn(async () => orderBook()),
      getBalanceAllowance: vi.fn(async () => ({
        balance: '100000000',
        allowances: {
          '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e': '1000000000'
        }
      })),
      createMarketOrder: vi.fn(async (order) => {
        expect(order).toEqual(expect.objectContaining({
          amount: 5.5,
          price: 0.55,
          orderType: OrderType.FAK,
          userUSDCBalance: 100
        }))
        return { version: 2 }
      }),
      postOrder
    } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(credentialStore(), () => client)

    const fill = await broker.hedge({ tokenId: 'token', direction: 'DOWN', quantity: '10', maximumPrice: '0.57' })

    expect(fill).toEqual(expect.objectContaining({
      venue: 'POLYMARKET',
      direction: 'DOWN',
      quantity: '10',
      averagePrice: '0.55',
      orderId: 'poly-order-1'
    }))
    expect(client.createMarketOrder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ version: 2 }))
    expect(postOrder).toHaveBeenCalledOnce()
  })

  it('does not trust a delayed async response amount and reads the actual fill back by order id', async () => {
    const getTrades = vi.fn(async () => [{
      id: 'trade-delayed', taker_order_id: 'delayed-order', asset_id: 'token', side: 'BUY',
      size: '4', price: '0.55', status: 'MATCHED', match_time: new Date().toISOString()
    }])
    const client = {
      getOrderBook: vi.fn(async () => orderBook()),
      getBalanceAllowance: vi.fn(async () => ({
        balance: '100000000', allowances: { '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e': '1000000000' }
      })),
      createMarketOrder: vi.fn(async () => ({ version: 2 })),
      postOrder: vi.fn(async () => ({
        success: true, orderID: 'delayed-order', status: 'delayed', takingAmount: '10', makingAmount: '5.5'
      })),
      getTrades
    } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(credentialStore(), () => client)

    const fill = await broker.hedge({ tokenId: 'token', direction: 'DOWN', quantity: '10', maximumPrice: '0.57' })

    expect(getTrades).toHaveBeenCalledOnce()
    expect(fill).toMatchObject({ orderId: 'delayed-order', quantity: '4', averagePrice: '0.55' })
  })

  it('returns the actual partial FAK fill instead of treating it as a failed all-or-none hedge', async () => {
    const createMarketOrder = vi.fn(async () => ({ version: 2 }))
    const client = {
      getOrderBook: vi.fn(async () => orderBook()),
      getBalanceAllowance: vi.fn(async () => ({
        balance: '100000000',
        allowances: {
          '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e': '1000000000'
        }
      })),
      createMarketOrder,
      postOrder: vi.fn(async () => ({
        success: true,
        errorMsg: '',
        orderID: 'poly-order-2',
        status: 'matched',
        takingAmount: '5.265957',
        makingAmount: '4.95'
      }))
    } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(credentialStore(), () => client)

    const fill = await broker.hedge({ tokenId: 'token', direction: 'UP', quantity: '10', maximumPrice: '0.94' })

    expect(createMarketOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: 5.5, price: 0.55 }), expect.anything())
    expect(fill.quantity).toBe('5.265957')
    expect(Number(fill.quantity)).toBeLessThan(10)
  })

  it('signs a four-decimal-price BUY with a maker amount limited to whole cents', async () => {
    const createMarketOrder = vi.fn(async () => ({ version: 2 }))
    const client = {
      getOrderBook: vi.fn(async () => ({
        ...orderBook(),
        asks: [{ price: '0.6175', size: '100' }],
        tick_size: '0.0025'
      })),
      getBalanceAllowance: vi.fn(async () => ({
        balance: '100000000',
        allowances: { '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e': '1000000000' }
      })),
      createMarketOrder,
      postOrder: vi.fn(async () => ({
        success: true, errorMsg: '', orderID: 'cent-maker-order', status: 'matched',
        takingAmount: '53.991902', makingAmount: '33.34'
      }))
    } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(credentialStore(), () => client)

    await broker.hedge({ tokenId: 'token', direction: 'UP', quantity: '54', maximumPrice: '0.62' })

    expect(createMarketOrder).toHaveBeenCalledWith(expect.objectContaining({
      amount: 33.34,
      price: 0.6175,
      orderType: OrderType.FAK
    }), expect.anything())
  })

  it('reports the live best ask when price protection prevents a stale FAK retry', async () => {
    const createMarketOrder = vi.fn()
    const client = {
      getOrderBook: vi.fn(async () => ({
        ...orderBook(),
        asks: [{ price: '0.64', size: '100' }]
      })),
      getBalanceAllowance: vi.fn(async () => ({
        balance: '100000000', allowances: { exchange: '1000000000' }
      })),
      createMarketOrder
    } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(credentialStore(), () => client)

    await expect(broker.hedge({
      tokenId: 'token', direction: 'UP', quantity: '54', maximumPrice: '0.62'
    })).rejects.toThrow('当前最优卖价0.64已超过最高可接受价0.62')
    expect(createMarketOrder).not.toHaveBeenCalled()
  })

  it('submits the venue minimum when the best level is smaller and accepts the actual partial fill', async () => {
    const createMarketOrder = vi.fn(async () => ({ version: 2 }))
    const postOrder = vi.fn(async () => ({
      success: true, errorMsg: '', orderID: 'small-best-level', status: 'matched',
      takingAmount: '1.77', makingAmount: '0.9735'
    }))
    const client = {
      getOrderBook: vi.fn(async () => ({
        ...orderBook(),
        asks: [{ price: '0.55', size: '1.77' }, { price: '0.56', size: '100' }]
      })),
      getBalanceAllowance: vi.fn(async () => ({
        balance: '100000000',
        allowances: { '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e': '1000000000' }
      })),
      createMarketOrder,
      postOrder
    } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(credentialStore(), () => client)

    const fill = await broker.hedge({
      tokenId: 'token', direction: 'DOWN', quantity: '48.29', maximumPrice: '0.57'
    })

    expect(createMarketOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: 2.75, price: 0.55 }), expect.anything())
    expect(postOrder).toHaveBeenCalledWith(expect.anything(), OrderType.FAK, false, true)
    expect(fill).toMatchObject({ quantity: '1.77', averagePrice: '0.55' })
  })

  it('uses fresh WebSocket levels and sweeps only to the protected market price', async () => {
    const createMarketOrder = vi.fn(async () => ({ version: 2 }))
    const getOrderBook = vi.fn(async () => orderBook())
    const client = {
      getOrderBook,
      getBalanceAllowance: vi.fn(async () => ({
        balance: '100000000',
        allowances: { '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e': '1000000000' }
      })),
      createMarketOrder,
      postOrder: vi.fn(async () => ({
        success: true, errorMsg: '', orderID: 'protected-market', status: 'matched',
        takingAmount: '9.64', makingAmount: '5.4948'
      }))
    } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(credentialStore(), () => client)

    const fill = await broker.hedge({
      tokenId: 'token', direction: 'DOWN', quantity: '10', maximumPrice: '0.57',
      mode: 'PROTECTED_MARKET', quoteReceivedAt: Date.now(),
      levels: [{ price: '0.55', size: '4' }, { price: '0.56', size: '4' }, { price: '0.57', size: '100' }]
    })

    expect(createMarketOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: 5.49, price: 0.57 }), expect.anything())
    expect(fill.executionDetails).toMatchObject({ quoteSource: 'WEBSOCKET', levelsUsed: 3 })
  })

  it('attempts a 54-share protected hedge in one FAK instead of a fixed 50-share batch', async () => {
    const createMarketOrder = vi.fn(async () => ({ version: 2 }))
    const client = {
      getOrderBook: vi.fn(async () => orderBook()),
      getBalanceAllowance: vi.fn(async () => ({
        balance: '100000000',
        allowances: { '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e': '1000000000' }
      })),
      createMarketOrder,
      postOrder: vi.fn(async () => ({
        success: true, errorMsg: '', orderID: 'full-54-order', status: 'matched',
        takingAmount: '54', makingAmount: '29.7'
      }))
    } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(credentialStore(), () => client)

    const fill = await broker.hedge({
      tokenId: 'token', direction: 'DOWN', quantity: '54', maximumPrice: '0.57',
      mode: 'PROTECTED_MARKET', quoteReceivedAt: Date.now(),
      levels: [{ price: '0.55', size: '100' }]
    })

    expect(createMarketOrder).toHaveBeenCalledWith(expect.objectContaining({
      amount: 29.7,
      price: 0.55
    }), expect.anything())
    expect(fill.quantity).toBe('54')
  })

  it('ignores stale supplied levels and refreshes the REST order book', async () => {
    const createMarketOrder = vi.fn(async () => ({ version: 2 }))
    const getOrderBook = vi.fn(async () => orderBook())
    const client = {
      getOrderBook,
      getBalanceAllowance: vi.fn(async () => ({
        balance: '100000000',
        allowances: { '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e': '1000000000' }
      })),
      createMarketOrder,
      postOrder: vi.fn(async () => ({
        success: true, errorMsg: '', orderID: 'rest-fallback', status: 'matched',
        takingAmount: '5', makingAmount: '2.75'
      }))
    } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(credentialStore(), () => client)

    const fill = await broker.hedge({
      tokenId: 'token', direction: 'DOWN', quantity: '5', maximumPrice: '0.57',
      quoteReceivedAt: Date.now() - 5_000, levels: [{ price: '0.40', size: '100' }]
    })

    expect(getOrderBook).toHaveBeenCalledOnce()
    expect(createMarketOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: 2.75, price: 0.55 }), expect.anything())
    expect(fill.executionDetails).toMatchObject({ quoteSource: 'REST' })
  })

  it('recovers a timed-out submission from recent authenticated trades instead of reposting', async () => {
    const matchedAt = new Date().toISOString()
    const postOrder = vi.fn(async () => { throw new Error('request timeout') })
    const getTrades = vi.fn(async () => [{
      id: 'trade-1', taker_order_id: 'timed-out-order', asset_id: 'token', side: 'BUY',
      size: '5', price: '0.55', match_time: matchedAt
    }])
    const client = {
      getOrderBook: vi.fn(async () => orderBook()),
      getBalanceAllowance: vi.fn(async () => ({
        balance: '100000000',
        allowances: { '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e': '1000000000' }
      })),
      createMarketOrder: vi.fn(async () => ({ version: 2 })),
      postOrder,
      getTrades
    } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(credentialStore(), () => client)

    const fill = await broker.hedge({ tokenId: 'token', direction: 'DOWN', quantity: '5', maximumPrice: '0.57' })

    expect(postOrder).toHaveBeenCalledOnce()
    expect(getTrades).toHaveBeenCalledOnce()
    expect(fill).toMatchObject({ orderId: 'timed-out-order', quantity: '5', averagePrice: '0.55' })
    expect(fill.executionDetails).toMatchObject({ timeoutRecovered: true })
  })

  it('limits each FAK attempt to the shares available at the current best price level', async () => {
    const createMarketOrder = vi.fn(async () => ({ version: 2 }))
    const client = {
      getOrderBook: vi.fn(async () => ({
        ...orderBook(),
        asks: [{ price: '0.55', size: '6' }, { price: '0.56', size: '100' }]
      })),
      getBalanceAllowance: vi.fn(async () => ({
        balance: '100000000',
        allowances: { '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e': '1000000000' }
      })),
      createMarketOrder,
      postOrder: vi.fn(async () => ({
        success: true, errorMsg: '', orderID: 'best-level-only', status: 'matched',
        takingAmount: '6', makingAmount: '3.3'
      }))
    } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(credentialStore(), () => client)

    const fill = await broker.hedge({ tokenId: 'token', direction: 'DOWN', quantity: '10', maximumPrice: '0.57' })

    expect(createMarketOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: 3.3, price: 0.55 }), expect.anything())
    expect(fill).toMatchObject({ quantity: '6', averagePrice: '0.55', verificationSource: 'PLATFORM_READBACK' })
  })

  it('includes the V2 curve fee in the collateral balance check', async () => {
    const createMarketOrder = vi.fn()
    const client = {
      getOrderBook: vi.fn(async () => orderBook()),
      getBalanceAllowance: vi.fn(async () => ({
        balance: '5600000',
        allowances: {
          '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e': '1000000000'
        }
      })),
      createMarketOrder
    } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(credentialStore(), () => client)

    await expect(broker.hedge({
      tokenId: 'token', direction: 'DOWN', quantity: '10', maximumPrice: '0.57',
      feeRate: '0.07', feeExponent: '1'
    })).rejects.toThrow('余额不足')
    expect(createMarketOrder).not.toHaveBeenCalled()
  })

  it('rejects a hedge below the live Polymarket minimum before posting', async () => {
    const postOrder = vi.fn()
    const client = {
      getOrderBook: vi.fn(async () => orderBook()),
      getBalanceAllowance: vi.fn(async () => ({ balance: '100000000', allowances: {} })),
      postOrder
    } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(credentialStore(), () => client)

    await expect(broker.hedge({ tokenId: 'token', direction: 'DOWN', quantity: '3.4', maximumPrice: '0.70' }))
      .rejects.toThrow('最小下单量为5份')
    expect(postOrder).not.toHaveBeenCalled()
  })

  it('sells the exact outcome-token quantity with FOK and slippage protection', async () => {
    const createMarketOrder = vi.fn(async () => ({ version: 2 }))
    const client = {
      getOrderBook: vi.fn(async () => ({
        ...orderBook(),
        bids: [{ price: '0.48', size: '100' }]
      })),
      getBalanceAllowance: vi.fn(async ({ asset_type, token_id }) => {
        expect(asset_type).toBe(AssetType.CONDITIONAL)
        expect(token_id).toBe('token')
        return {
          balance: '10000000',
          allowances: { '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e': '1000000000' }
        }
      }),
      createMarketOrder,
      postOrder: vi.fn(async () => ({
        success: true, errorMsg: '', orderID: 'poly-sell-1', status: 'matched',
        makingAmount: '5', takingAmount: '2.35'
      }))
    } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(credentialStore(), () => client)

    const fill = await broker.closePosition({
      tokenId: 'token', direction: 'UP', quantity: '5', maximumSlippage: '0.03'
    })

    expect(createMarketOrder).toHaveBeenCalledWith(expect.objectContaining({
      amount: 5, price: 0.45, side: expect.anything(), orderType: OrderType.FOK
    }), expect.anything())
    expect(fill).toMatchObject({ quantity: '5', averagePrice: '0.47', orderId: 'poly-sell-1' })
  })

  it('rejects a marketable BUY below the one-dollar maker minimum before signing', async () => {
    const createMarketOrder = vi.fn()
    const postOrder = vi.fn()
    const client = {
      getOrderBook: vi.fn(async () => ({ ...orderBook(), asks: [{ price: '0.04', size: '100' }] })),
      getBalanceAllowance: vi.fn(async () => ({
        balance: '100000000',
        allowances: { exchange: '1000000000' }
      })),
      createMarketOrder,
      postOrder
    } as unknown as ClobClient
    const broker = new PolymarketLiveBroker(credentialStore(), () => client)

    await expect(broker.hedge({ tokenId: 'token', direction: 'DOWN', quantity: '5', maximumPrice: '0.04' }))
      .rejects.toThrow('BUY至少需要1抵押资产')
    expect(createMarketOrder).not.toHaveBeenCalled()
    expect(postOrder).not.toHaveBeenCalled()
  })
})
