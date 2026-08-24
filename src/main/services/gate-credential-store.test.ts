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

import { GateCredentialStore } from './gate-credential-store'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('GateCredentialStore', () => {
  it('encrypts both Gate secrets and preserves omitted values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gate-credentials-'))
    directories.push(directory)
    const filePath = join(directory, 'credentials.json')
    const store = new GateCredentialStore(filePath)
    const apiKey = 'gate_test_api_key'
    const apiSecret = 'gate_test_secret_at_least_16'

    const summary = await store.update({ apiKey, apiSecret })
    expect(summary).toMatchObject({ configured: true, hasApiSecret: true, apiKeyMasked: expect.any(String) })
    expect(JSON.stringify(summary)).not.toContain(apiSecret)
    const persisted = await readFile(filePath, 'utf8')
    expect(persisted).not.toContain(apiKey)
    expect(persisted).not.toContain(apiSecret)

    await store.update({})
    expect(await store.getCredentials()).toEqual({ apiKey, apiSecret })
  })

  it('rejects incomplete first-time configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gate-credentials-'))
    directories.push(directory)
    const store = new GateCredentialStore(join(directory, 'credentials.json'))
    await expect(store.update({ apiKey: 'gate_test_api_key' })).rejects.toThrow('首次配置')
  })
})
