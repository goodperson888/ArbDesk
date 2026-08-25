import { generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { KalshiCredentials } from './kalshi-credential-store'
import { kalshiHeaders } from './kalshi-auth'

describe('Kalshi request authentication', () => {
  it('signs relative V2 API paths with the full trade-api prefix', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const credentials: KalshiCredentials = {
      apiKeyId: 'kalshi_test_key_id',
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    }
    const headers = kalshiHeaders(credentials, 'GET', '/portfolio/balance')
    const message = `${headers['KALSHI-ACCESS-TIMESTAMP']}GET/trade-api/v2/portfolio/balance`
    expect(verify('sha256', Buffer.from(message), {
      key: publicKey,
      padding: 6,
      saltLength: 32
    }, Buffer.from(headers['KALSHI-ACCESS-SIGNATURE'], 'base64'))).toBe(true)
  })
})
