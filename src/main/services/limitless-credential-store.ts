import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import { createHmac } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'
import type { LimitlessCredentialSummary, UpdateLimitlessCredentialsRequest } from '../../shared/types'

interface StoredLimitlessCredentials {
  version: 2
  tokenIdEncrypted?: string
  tokenSecretEncrypted?: string
  profileId?: string
  walletAddress?: string
  walletPrivateKeyEncrypted?: string
}

export interface LimitlessCredentials {
  tokenId: string
  tokenSecret: string
  profileId: string
  walletAddress: string
  walletPrivateKey: string
}

export class LimitlessCredentialStore {
  constructor(private readonly filePath: string) {}

  async getSummary(): Promise<LimitlessCredentialSummary> {
    const encryptionAvailable = safeStorage.isEncryptionAvailable()
    const stored = await this.load()
    let tokenIdMasked: string | undefined
    try {
      if (stored?.tokenIdEncrypted && encryptionAvailable) tokenIdMasked = this.mask(this.decrypt(stored.tokenIdEncrypted))
    } catch {
      tokenIdMasked = undefined
    }
    const configured = Boolean(
      encryptionAvailable && tokenIdMasked && stored?.tokenSecretEncrypted && stored.profileId && stored.walletAddress && stored.walletPrivateKeyEncrypted
    )
    return {
      configured,
      encryptionAvailable,
      tokenIdMasked,
      hasTokenSecret: Boolean(stored?.tokenSecretEncrypted),
      profileId: stored?.profileId,
      walletAddress: stored?.walletAddress,
      hasWalletPrivateKey: Boolean(stored?.walletPrivateKeyEncrypted),
      message: !encryptionAvailable
        ? '系统安全存储不可用，已禁止保存 Limitless 交易凭据'
        : configured
          ? 'HMAC Token 与钱包签名身份已使用系统安全存储加密保存；等待联网验证'
          : '尚未完整配置 Limitless Token ID、Token Secret、Profile ID 和钱包签名私钥'
    }
  }

  async update(request: UpdateLimitlessCredentialsRequest): Promise<LimitlessCredentialSummary> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，不能保存 Limitless 交易凭据')
    const existing = await this.load()
    const tokenId = request.tokenId?.trim()
    const tokenSecret = request.tokenSecret?.trim()
    if (tokenId && tokenId.length < 8) throw new Error('Limitless Token ID 格式无效')
    if (tokenSecret && Buffer.from(tokenSecret, 'base64').length < 16) throw new Error('Limitless Token Secret 格式无效')
    const privateKey = request.walletPrivateKey?.trim()
    if (privateKey && !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Limitless 钱包私钥必须是 0x 开头的 32 字节十六进制值')
    const walletAddress = privateKey
      ? privateKeyToAccount(privateKey as `0x${string}`).address
      : existing?.walletAddress
    const stored: StoredLimitlessCredentials = {
      version: 2,
      tokenIdEncrypted: tokenId ? this.encrypt(tokenId) : existing?.tokenIdEncrypted,
      tokenSecretEncrypted: tokenSecret ? this.encrypt(tokenSecret) : existing?.tokenSecretEncrypted,
      profileId: existing?.profileId,
      walletAddress,
      walletPrivateKeyEncrypted: privateKey ? this.encrypt(privateKey) : existing?.walletPrivateKeyEncrypted
    }
    if (!stored.tokenIdEncrypted || !stored.tokenSecretEncrypted || !stored.walletPrivateKeyEncrypted) {
      throw new Error('首次配置需要填写 Limitless Token ID、Token Secret 和钱包私钥')
    }
    await this.save(stored)
    return await this.getSummary()
  }

  async syncProfile(signal?: AbortSignal): Promise<LimitlessCredentialSummary> {
    const stored = await this.load()
    const credentials = await this.getHmacCredentials()
    if (!stored?.walletAddress || !credentials) throw new Error('请先保存 Limitless Token 和钱包私钥')
    const path = '/profiles/me'
    const timestamp = new Date().toISOString()
    const signature = createHmac('sha256', Buffer.from(credentials.tokenSecret, 'base64'))
      .update(`${timestamp}\nGET\n${path}\n`)
      .digest('base64')
    const timeout = AbortSignal.timeout(6_000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const response = await fetch(`https://api.limitless.exchange${path}`, {
      headers: {
        accept: 'application/json',
        'lmts-api-key': credentials.tokenId,
        'lmts-timestamp': timestamp,
        'lmts-signature': signature
      },
      signal: combined
    })
    if (!response.ok) throw new Error(`Limitless 身份验证失败：HTTP ${response.status}`)
    const profile = await response.json() as { id?: number; account?: string; tradeWalletOption?: string | null }
    if (!Number.isInteger(profile.id)) throw new Error('Limitless 身份响应缺少 Profile ID')
    if (profile.account?.toLowerCase() !== stored.walletAddress.toLowerCase()) {
      throw new Error('Limitless Token 所属账户与钱包私钥地址不一致')
    }
    if (profile.tradeWalletOption && profile.tradeWalletOption !== 'eoa') {
      throw new Error('Limitless 当前不是 EOA 交易模式；请在官网切换后重试')
    }
    await this.save({ ...stored, profileId: String(profile.id) })
    return await this.getSummary()
  }

  async getCredentials(): Promise<LimitlessCredentials> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用')
    const stored = await this.load()
    if (!stored?.tokenIdEncrypted || !stored.tokenSecretEncrypted || !stored.profileId || !stored.walletAddress || !stored.walletPrivateKeyEncrypted) {
      throw new Error('Limitless 交易身份尚未完整配置')
    }
    return {
      tokenId: this.decrypt(stored.tokenIdEncrypted),
      tokenSecret: this.decrypt(stored.tokenSecretEncrypted),
      profileId: stored.profileId,
      walletAddress: stored.walletAddress,
      walletPrivateKey: this.decrypt(stored.walletPrivateKeyEncrypted)
    }
  }

  async getHmacCredentials(): Promise<{ tokenId: string; tokenSecret: string } | undefined> {
    if (!safeStorage.isEncryptionAvailable()) return undefined
    const stored = await this.load()
    return stored?.tokenIdEncrypted && stored.tokenSecretEncrypted
      ? { tokenId: this.decrypt(stored.tokenIdEncrypted), tokenSecret: this.decrypt(stored.tokenSecretEncrypted) }
      : undefined
  }

  private async load(): Promise<StoredLimitlessCredentials | undefined> {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8')) as StoredLimitlessCredentials
    } catch {
      return undefined
    }
  }

  private async save(stored: StoredLimitlessCredentials): Promise<void> {
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
