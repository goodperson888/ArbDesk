import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import { privateKeyToAccount } from 'viem/accounts'
import type {
  PolymarketCredentialSummary,
  PolymarketSignatureType,
  UpdatePolymarketCredentialsRequest
} from '../../shared/types'

interface StoredPolymarketCredentials {
  version: 1
  signatureType: PolymarketSignatureType
  funderAddress: string
  signerAddress?: string
  apiKeyEncrypted?: string
  signerPrivateKeyEncrypted?: string
  apiSecretEncrypted?: string
  apiPassphraseEncrypted?: string
}

export interface PolymarketCredentials {
  signatureType: PolymarketSignatureType
  funderAddress: string
  signerPrivateKey: string
  apiKey: string
  apiSecret: string
  apiPassphrase: string
}

export class PolymarketCredentialStore {
  constructor(private readonly filePath: string) {}

  async getSummary(): Promise<PolymarketCredentialSummary> {
    const stored = await this.load()
    const encryptionAvailable = safeStorage.isEncryptionAvailable()
    let apiKeyMasked: string | undefined
    try {
      if (stored?.apiKeyEncrypted && encryptionAvailable) apiKeyMasked = this.mask(this.decrypt(stored.apiKeyEncrypted))
    } catch {
      apiKeyMasked = undefined
    }
    const configured = Boolean(
      encryptionAvailable &&
      stored?.funderAddress &&
      apiKeyMasked &&
      stored.signerPrivateKeyEncrypted &&
      stored.apiSecretEncrypted &&
      stored.apiPassphraseEncrypted
    )
    return {
      configured,
      encryptionAvailable,
      signatureType: stored?.signatureType,
      funderAddress: stored?.funderAddress,
      signerAddress: stored?.signerAddress,
      apiKeyMasked,
      hasSignerPrivateKey: Boolean(stored?.signerPrivateKeyEncrypted),
      hasApiSecret: Boolean(stored?.apiSecretEncrypted),
      hasApiPassphrase: Boolean(stored?.apiPassphraseEncrypted),
      message: !encryptionAvailable
        ? '系统安全存储不可用，已禁止保存秘密凭据'
        : configured
          ? '交易身份已使用系统安全存储加密保存；尚未进行联网下单验证'
          : '尚未完整配置真实下单身份'
    }
  }

  async update(request: UpdatePolymarketCredentialsRequest): Promise<PolymarketCredentialSummary> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，不能保存 Polymarket 秘密凭据')
    const funderAddress = request.funderAddress.trim()
    if (![0, 1, 2, 3].includes(request.signatureType)) throw new Error('Polymarket 签名类型无效')
    if (!/^0x[0-9a-fA-F]{40}$/.test(funderAddress)) throw new Error('funder 地址格式无效')

    const existing = await this.load()
    const privateKey = request.signerPrivateKey?.trim()
    if (privateKey && !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('签名私钥必须是 0x 开头的 32 字节十六进制值')
    const signerAddress = privateKey
      ? privateKeyToAccount(privateKey as `0x${string}`).address
      : existing?.signerAddress
    if (request.signatureType === 0 && signerAddress?.toLowerCase() !== funderAddress.toLowerCase()) {
      throw new Error('EOA 签名类型要求 funder 地址与签名私钥对应地址一致')
    }
    const stored: StoredPolymarketCredentials = {
      version: 1,
      signatureType: request.signatureType,
      funderAddress,
      signerAddress,
      apiKeyEncrypted: request.apiKey?.trim() ? this.encrypt(request.apiKey.trim()) : existing?.apiKeyEncrypted,
      signerPrivateKeyEncrypted: privateKey ? this.encrypt(privateKey) : existing?.signerPrivateKeyEncrypted,
      apiSecretEncrypted: request.apiSecret?.trim() ? this.encrypt(request.apiSecret.trim()) : existing?.apiSecretEncrypted,
      apiPassphraseEncrypted: request.apiPassphrase?.trim() ? this.encrypt(request.apiPassphrase.trim()) : existing?.apiPassphraseEncrypted
    }
    if (!stored.apiKeyEncrypted || !stored.signerPrivateKeyEncrypted || !stored.apiSecretEncrypted || !stored.apiPassphraseEncrypted) {
      throw new Error('首次配置需要填写签名私钥、API key、API secret 和 passphrase')
    }
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    await writeFile(temporaryPath, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, this.filePath)
    return await this.getSummary()
  }

  async getCredentials(): Promise<PolymarketCredentials> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用')
    const stored = await this.load()
    if (!stored?.signerPrivateKeyEncrypted || !stored.apiSecretEncrypted || !stored.apiPassphraseEncrypted || !stored.apiKeyEncrypted) {
      throw new Error('Polymarket 交易身份尚未完整配置')
    }
    return {
      signatureType: stored.signatureType,
      funderAddress: stored.funderAddress,
      signerPrivateKey: this.decrypt(stored.signerPrivateKeyEncrypted),
      apiKey: this.decrypt(stored.apiKeyEncrypted),
      apiSecret: this.decrypt(stored.apiSecretEncrypted),
      apiPassphrase: this.decrypt(stored.apiPassphraseEncrypted)
    }
  }

  private async load(): Promise<StoredPolymarketCredentials | undefined> {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8')) as StoredPolymarketCredentials
    } catch {
      return undefined
    }
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
