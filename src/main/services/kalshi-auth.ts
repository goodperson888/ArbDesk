import { constants, createPrivateKey, sign } from 'node:crypto'
import type { KalshiCredentials } from './kalshi-credential-store'

export function kalshiRequestSignature(privateKeyPem: string, timestamp: string, method: string, path: string): string {
  const message = `${timestamp}${method.toUpperCase()}${path.split('?')[0]}`
  const key = createPrivateKey(privateKeyPem)
  return sign('sha256', Buffer.from(message, 'utf8'), {
    key,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST
  }).toString('base64')
}

export function kalshiHeaders(credentials: KalshiCredentials, method: string, path: string): Record<string, string> {
  const timestamp = String(Date.now())
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': 'ArbDesk/0.1',
    'KALSHI-ACCESS-KEY': credentials.apiKeyId,
    'KALSHI-ACCESS-SIGNATURE': kalshiRequestSignature(credentials.privateKeyPem, timestamp, method, path),
    'KALSHI-ACCESS-TIMESTAMP': timestamp
  }
}
