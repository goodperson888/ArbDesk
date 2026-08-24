import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, '')
  }
}))

import { generateKeyPairSync } from 'node:crypto'
import { KalshiCredentialStore } from './kalshi-credential-store'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

describe('KalshiCredentialStore', () => {
  it('encrypts the API key ID and RSA private key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kalshi-credentials-'))
    directories.push(directory)
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const store = new KalshiCredentialStore(join(directory, 'credentials.json'))
    const summary = await store.update({ apiKeyId: 'kalshi_test_key_id', privateKeyPem })
    expect(summary).toMatchObject({ configured: true, hasPrivateKey: true })
    const persisted = await readFile(join(directory, 'credentials.json'), 'utf8')
    expect(persisted).not.toContain(privateKeyPem)
    expect(await store.getCredentials()).toEqual({ apiKeyId: 'kalshi_test_key_id', privateKeyPem: privateKeyPem.trim() })
  })
})
