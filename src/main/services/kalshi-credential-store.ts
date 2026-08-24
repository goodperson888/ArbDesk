import { createPrivateKey } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import type { KalshiCredentialSummary, UpdateKalshiCredentialsRequest } from '../../shared/types'

interface StoredKalshiCredentials {
  version: 1
  apiKeyIdEncrypted?: string
  privateKeyPemEncrypted?: string
}

export interface KalshiCredentials {
  apiKeyId: string
  privateKeyPem: string
}

export class KalshiCredentialStore {
  constructor(private readonly filePath: string) {}

  async getSummary(): Promise<KalshiCredentialSummary> {
    const encryptionAvailable = safeStorage.isEncryptionAvailable()
    const stored = await this.load()
    let apiKeyIdMasked: string | undefined
    try {
      if (stored?.apiKeyIdEncrypted && encryptionAvailable) apiKeyIdMasked = this.mask(this.decrypt(stored.apiKeyIdEncrypted))
    } catch {
      apiKeyIdMasked = undefined
    }
    const configured = Boolean(encryptionAvailable && apiKeyIdMasked && stored?.privateKeyPemEncrypted)
    return {
      configured,
      encryptionAvailable,
      apiKeyIdMasked,
      hasPrivateKey: Boolean(stored?.privateKeyPemEncrypted),
      message: !encryptionAvailable
        ? '系统安全存储不可用，已禁止保存 Kalshi 凭据'
        : configured
          ? 'Kalshi API Key ID 与 RSA 私钥已使用系统安全存储加密保存；真实下单仍需单独开启并逐单确认'
          : '尚未配置 Kalshi API Key ID 与 RSA 私钥；公开市场和盘口仍可读取'
    }
  }

  async update(request: UpdateKalshiCredentialsRequest): Promise<KalshiCredentialSummary> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，不能保存 Kalshi 凭据')
    const existing = await this.load()
    const apiKeyId = request.apiKeyId?.trim()
    const privateKeyPem = request.privateKeyPem?.trim()
    if (apiKeyId && apiKeyId.length < 8) throw new Error('Kalshi API Key ID 格式无效')
    if (privateKeyPem) {
      try {
        const key = createPrivateKey(privateKeyPem)
        if (key.asymmetricKeyType !== 'rsa') throw new Error('不是 RSA 私钥')
      } catch (error) {
        throw new Error(`Kalshi RSA 私钥格式无效：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const stored: StoredKalshiCredentials = {
      version: 1,
      apiKeyIdEncrypted: apiKeyId ? this.encrypt(apiKeyId) : existing?.apiKeyIdEncrypted,
      privateKeyPemEncrypted: privateKeyPem ? this.encrypt(privateKeyPem) : existing?.privateKeyPemEncrypted
    }
    if (!stored.apiKeyIdEncrypted || !stored.privateKeyPemEncrypted) {
      throw new Error('首次配置需要填写 Kalshi API Key ID 和 RSA 私钥 PEM')
    }
    await this.save(stored)
    return await this.getSummary()
  }

  async getCredentials(): Promise<KalshiCredentials> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用')
    const stored = await this.load()
    if (!stored?.apiKeyIdEncrypted || !stored.privateKeyPemEncrypted) throw new Error('Kalshi 身份尚未配置')
    return {
      apiKeyId: this.decrypt(stored.apiKeyIdEncrypted),
      privateKeyPem: this.decrypt(stored.privateKeyPemEncrypted)
    }
  }

  private async load(): Promise<StoredKalshiCredentials | undefined> {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8')) as StoredKalshiCredentials
    } catch {
      return undefined
    }
  }

  private async save(stored: StoredKalshiCredentials): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    await writeFile(temporaryPath, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, this.filePath)
  }

  private encrypt(value: string): string { return safeStorage.encryptString(value).toString('base64') }
  private decrypt(value: string): string { return safeStorage.decryptString(Buffer.from(value, 'base64')) }
  private mask(value: string): string { return value.length <= 8 ? '••••••••' : `${value.slice(0, 4)}••••${value.slice(-4)}` }
}
