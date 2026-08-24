import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import type { GateCredentialSummary, UpdateGateCredentialsRequest } from '../../shared/types'

interface StoredGateCredentials {
  version: 1
  apiKeyEncrypted?: string
  apiSecretEncrypted?: string
}

export interface GateCredentials {
  apiKey: string
  apiSecret: string
}

export class GateCredentialStore {
  constructor(private readonly filePath: string) {}

  async getSummary(): Promise<GateCredentialSummary> {
    const encryptionAvailable = safeStorage.isEncryptionAvailable()
    const stored = await this.load()
    let apiKeyMasked: string | undefined
    try {
      if (stored?.apiKeyEncrypted && encryptionAvailable) apiKeyMasked = this.mask(this.decrypt(stored.apiKeyEncrypted))
    } catch {
      apiKeyMasked = undefined
    }
    const configured = Boolean(encryptionAvailable && apiKeyMasked && stored?.apiSecretEncrypted)
    return {
      configured,
      encryptionAvailable,
      apiKeyMasked,
      hasApiSecret: Boolean(stored?.apiSecretEncrypted),
      message: !encryptionAvailable
        ? '系统安全存储不可用，已禁止保存 Gate API 凭据'
        : configured
          ? 'Gate APIv4 Key 与 Secret 已使用系统安全存储加密保存；仅允许只读账户请求'
          : '尚未配置 Gate APIv4 Key 与 Secret；公开事件盘口仍可通过单页面被动扫描'
    }
  }

  async update(request: UpdateGateCredentialsRequest): Promise<GateCredentialSummary> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，不能保存 Gate API 凭据')
    const existing = await this.load()
    const apiKey = request.apiKey?.trim()
    const apiSecret = request.apiSecret?.trim()
    if (apiKey && apiKey.length < 8) throw new Error('Gate API Key 格式无效')
    if (apiSecret && apiSecret.length < 16) throw new Error('Gate API Secret 格式无效')
    const stored: StoredGateCredentials = {
      version: 1,
      apiKeyEncrypted: apiKey ? this.encrypt(apiKey) : existing?.apiKeyEncrypted,
      apiSecretEncrypted: apiSecret ? this.encrypt(apiSecret) : existing?.apiSecretEncrypted
    }
    if (!stored.apiKeyEncrypted || !stored.apiSecretEncrypted) throw new Error('首次配置需要填写 Gate APIv4 Key 与 Secret')
    await this.save(stored)
    return await this.getSummary()
  }

  async getCredentials(): Promise<GateCredentials> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用')
    const stored = await this.load()
    if (!stored?.apiKeyEncrypted || !stored.apiSecretEncrypted) throw new Error('Gate APIv4 身份尚未配置')
    return { apiKey: this.decrypt(stored.apiKeyEncrypted), apiSecret: this.decrypt(stored.apiSecretEncrypted) }
  }

  private async load(): Promise<StoredGateCredentials | undefined> {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8')) as StoredGateCredentials
    } catch {
      return undefined
    }
  }

  private async save(stored: StoredGateCredentials): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    await writeFile(temporaryPath, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, this.filePath)
  }

  private encrypt(value: string): string {
    return safeStorage.encryptString(value).toString('base64')
  }

  private decrypt(value: string): string {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  }

  private mask(value: string): string {
    return value.length <= 8 ? '••••••••' : `${value.slice(0, 4)}••••${value.slice(-4)}`
  }
}
