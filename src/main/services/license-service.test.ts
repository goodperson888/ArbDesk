import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LicenseService, machineCodeFromIdentity, type LicenseCrypto } from './license-service'

const directories: string[] = []
const crypto: LicenseCrypto = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(value).toString('base64'),
  decrypt: (value) => Buffer.from(value, 'base64').toString('utf8')
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true })
})

describe('LicenseService', () => {
  it('activates only a correctly signed license for the current machine and expires it by time', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arbdesk-license-test-'))
    directories.push(directory)
    const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    })
    let now = 1_800_000_000_000
    const machineCode = machineCodeFromIdentity('test-machine')
    const payload = Buffer.from(JSON.stringify({
      version: 1, licenseId: 'license-1', customer: '测试客户', machineCode,
      issuedAt: now, validFrom: now - 1_000, validUntil: now + 60_000,
      features: ['ARBDESK_DESKTOP']
    }))
    const activationCode = `ARB1.${payload.toString('base64url')}.${sign(null, payload, privateKey).toString('base64url')}`
    const service = new LicenseService(join(directory, 'license.json'), publicKey, crypto, () => 'test-machine', () => now)
    await service.initialize()

    await expect(service.activate(activationCode)).resolves.toEqual(expect.objectContaining({ status: 'ACTIVE', customer: '测试客户' }))
    now += 60_001
    await expect(service.getSummary()).resolves.toEqual(expect.objectContaining({ status: 'EXPIRED' }))
  })

  it('rejects a signed license created for another machine', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arbdesk-license-machine-test-'))
    directories.push(directory)
    const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    })
    const now = Date.now()
    const payload = Buffer.from(JSON.stringify({
      version: 1, licenseId: 'license-2', customer: '其他机器', machineCode: machineCodeFromIdentity('other-machine'),
      issuedAt: now, validFrom: now - 1_000, validUntil: now + 60_000,
      features: ['ARBDESK_DESKTOP']
    }))
    const activationCode = `ARB1.${payload.toString('base64url')}.${sign(null, payload, privateKey).toString('base64url')}`
    const service = new LicenseService(join(directory, 'license.json'), publicKey, crypto, () => 'this-machine', () => now)
    await service.initialize()

    await expect(service.activate(activationCode)).rejects.toThrow('机器码不匹配')
  })

  it('blocks a significant local clock rollback after activation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arbdesk-license-clock-test-'))
    directories.push(directory)
    const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    })
    let now = 1_800_000_000_000
    const payload = Buffer.from(JSON.stringify({
      version: 1, licenseId: 'license-clock', customer: '时钟测试', machineCode: machineCodeFromIdentity('clock-machine'),
      issuedAt: now, validFrom: now - 1_000, validUntil: now + 86_400_000,
      features: ['ARBDESK_DESKTOP']
    }))
    const activationCode = `ARB1.${payload.toString('base64url')}.${sign(null, payload, privateKey).toString('base64url')}`
    const service = new LicenseService(join(directory, 'license.json'), publicKey, crypto, () => 'clock-machine', () => now)
    await service.initialize()
    await service.activate(activationCode)

    now -= 6 * 60_000
    await expect(service.getSummary()).resolves.toEqual(expect.objectContaining({ status: 'CLOCK_ERROR' }))
  })
})
