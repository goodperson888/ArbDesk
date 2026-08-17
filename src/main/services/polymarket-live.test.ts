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

  it('submits a two-decimal FOK spend that covers the exact hedge quantity', async () => {
    const postOrder = vi.fn(async (_signed, orderType) => {
      expect(orderType).toBe(OrderType.FOK)
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
          amount: 5.7,
          price: 0.57,
          orderType: OrderType.FOK
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
    expect(postOrder).toHaveBeenCalledOnce()
  })

  it('rounds the BUY maker amount upward to two decimals instead of under-hedging', async () => {
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

    const fill = await broker.hedge({ tokenId: 'token', direction: 'UP', quantity: '5.26', maximumPrice: '0.94' })

    expect(createMarketOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: 4.95 }), expect.anything())
    expect(fill.quantity).toBe('5.265957')
    expect(Number(fill.quantity)).toBeGreaterThanOrEqual(5.26)
  })

  it('includes the V2 curve fee in the collateral balance check', async () => {
    const createMarketOrder = vi.fn()
    const client = {
      getOrderBook: vi.fn(async () => orderBook()),
      getBalanceAllowance: vi.fn(async () => ({
        balance: '5750000',
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
      getOrderBook: vi.fn(async () => orderBook()),
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
