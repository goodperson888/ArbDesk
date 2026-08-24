import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, '')
  }
}))

import { PredictFunCredentialStore } from './predict-fun-credential-store'

const directories: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('PredictFunCredentialStore', () => {
  it('keeps the API key usable for行情 while trading credentials are incomplete', async () => {
    vi.stubEnv('PREDICT_FUN_API_KEY', '')
    const directory = await mkdtemp(join(tmpdir(), 'predict-credentials-'))
    directories.push(directory)
    const store = new PredictFunCredentialStore(join(directory, 'credentials.json'))

    const summary = await store.update({ apiKey: 'predict_test_secret' })
    expect(summary).toMatchObject({ configured: true, tradingConfigured: false, hasSignerPrivateKey: false })
  })

  it('encrypts a Predict Account signer and never returns the private key in its summary', async () => {
    vi.stubEnv('PREDICT_FUN_API_KEY', '')
    const directory = await mkdtemp(join(tmpdir(), 'predict-credentials-'))
    directories.push(directory)
    const filePath = join(directory, 'credentials.json')
    const store = new PredictFunCredentialStore(filePath)
    const apiKey = 'predict_test_secret'
    const signerPrivateKey = `0x${'22'.repeat(32)}`
    const accountAddress = `0x${'33'.repeat(20)}`

    const summary = await store.update({ apiKey, accountType: 'PREDICT_ACCOUNT', accountAddress, signerPrivateKey })
    expect(summary).toMatchObject({ configured: true, tradingConfigured: true, accountType: 'PREDICT_ACCOUNT', accountAddress })
    expect(summary.signerAddress).toMatch(/^0x[0-9A-Fa-f]{40}$/)
    expect(JSON.stringify(summary)).not.toContain(signerPrivateKey)

    const persisted = await readFile(filePath, 'utf8')
    expect(persisted).not.toContain(apiKey)
    expect(persisted).not.toContain(signerPrivateKey)
    expect(await store.getCredentials()).toMatchObject({ apiKey, accountAddress, signerPrivateKey })
  })

  it('rejects an EOA address that does not match the private key', async () => {
    vi.stubEnv('PREDICT_FUN_API_KEY', '')
    const directory = await mkdtemp(join(tmpdir(), 'predict-credentials-'))
    directories.push(directory)
    const store = new PredictFunCredentialStore(join(directory, 'credentials.json'))
    await expect(store.update({
      apiKey: 'predict_test_secret',
      accountType: 'EOA',
      accountAddress: `0x${'44'.repeat(20)}`,
      signerPrivateKey: `0x${'55'.repeat(32)}`
    })).rejects.toThrow('EOA 模式')
  })
})
