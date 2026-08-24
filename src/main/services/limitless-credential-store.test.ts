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

import { LimitlessCredentialStore } from './limitless-credential-store'

const directories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('LimitlessCredentialStore', () => {
  it('encrypts secrets, derives the wallet address and preserves omitted values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'limitless-credentials-'))
    directories.push(directory)
    const filePath = join(directory, 'credentials.json')
    const store = new LimitlessCredentialStore(filePath)
    const tokenId = 'lmts_test_token_id'
    const tokenSecret = Buffer.from('test-secret-at-least-32-bytes-long').toString('base64')
    const walletPrivateKey = `0x${'11'.repeat(32)}`

    const storedSummary = await store.update({ tokenId, tokenSecret, walletPrivateKey })
    expect(storedSummary).toMatchObject({ configured: false, hasTokenSecret: true, hasWalletPrivateKey: true })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 12345, account: storedSummary.walletAddress, tradeWalletOption: 'eoa'
    }), { status: 200 })))
    const summary = await store.syncProfile()
    expect(summary).toMatchObject({ configured: true, profileId: '12345' })
    expect(summary.walletAddress).toMatch(/^0x[0-9A-Fa-f]{40}$/)
    expect(JSON.stringify(summary)).not.toContain(walletPrivateKey)

    const persisted = await readFile(filePath, 'utf8')
    expect(persisted).not.toContain(tokenId)
    expect(persisted).not.toContain(tokenSecret)
    expect(persisted).not.toContain(walletPrivateKey)

    await store.update({})
    expect(await store.getCredentials()).toMatchObject({ tokenId, tokenSecret, profileId: '12345', walletPrivateKey })
  })

  it('rejects incomplete first-time configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'limitless-credentials-'))
    directories.push(directory)
    const store = new LimitlessCredentialStore(join(directory, 'credentials.json'))
    await expect(store.update({ tokenId: 'lmts_test_token_id' })).rejects.toThrow('首次配置')
  })
})
