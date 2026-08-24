import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import { privateKeyToAccount } from 'viem/accounts'
import type { PredictFunCredentialSummary, UpdatePredictFunCredentialsRequest } from '../../shared/types'

interface StoredPredictFunCredentials {
  version: 1 | 2
  apiKeyEncrypted?: string
  accountType?: 'PREDICT_ACCOUNT' | 'EOA'
  accountAddress?: string
  signerAddress?: string
  signerPrivateKeyEncrypted?: string
}

export interface PredictFunCredentials {
  apiKey: string
  accountType: 'PREDICT_ACCOUNT' | 'EOA'
  accountAddress: string
  signerAddress: string
  signerPrivateKey: string
}

export class PredictFunCredentialStore {
  constructor(private readonly filePath: string) {}

  async getSummary(): Promise<PredictFunCredentialSummary> {
    const environmentKey = process.env.PREDICT_FUN_API_KEY?.trim()
    const encryptionAvailable = safeStorage.isEncryptionAvailable()
    const stored = await this.load()
    let apiKeyMasked: string | undefined
    try {
      apiKeyMasked = environmentKey
        ? this.mask(environmentKey)
        : stored?.apiKeyEncrypted && encryptionAvailable
          ? this.mask(this.decrypt(stored.apiKeyEncrypted))
          : undefined
    } catch {
      apiKeyMasked = undefined
    }
    const configured = Boolean(encryptionAvailable && apiKeyMasked)
    const tradingConfigured = Boolean(
      configured && stored?.accountType && stored.accountAddress && stored.signerAddress && stored.signerPrivateKeyEncrypted
    )
    return {
      configured,
      tradingConfigured,
      encryptionAvailable,
      apiKeyMasked,
      source: environmentKey ? 'ENVIRONMENT' : apiKeyMasked ? 'KEYCHAIN' : undefined,
      accountType: stored?.accountType,
      accountAddress: stored?.accountAddress,
      signerAddress: stored?.signerAddress,
      hasSignerPrivateKey: Boolean(stored?.signerPrivateKeyEncrypted),
      message: !encryptionAvailable
        ? '系统安全存储不可用，已禁止保存 Predict.fun API Key'
        : tradingConfigured
          ? 'API Key 与交易签名身份已使用系统安全存储加密保存；等待联网验证'
          : apiKeyMasked
            ? 'API Key 已加密保存；补充账户地址和签名私钥后可验证交易身份'
          : '尚未配置 Predict.fun 主网 API Key'
    }
  }

  async update(request: UpdatePredictFunCredentialsRequest): Promise<PredictFunCredentialSummary> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，不能保存 Predict.fun API Key')
    const existing = await this.load()
    const apiKey = request.apiKey?.trim()
    if (apiKey && apiKey.length < 8) throw new Error('Predict.fun API Key 格式无效')
    const accountType = request.accountType ?? existing?.accountType
    const accountAddress = request.accountAddress?.trim() || existing?.accountAddress
    if (accountAddress && !/^0x[0-9a-fA-F]{40}$/.test(accountAddress)) throw new Error('Predict.fun 账户地址格式无效')
    const privateKey = request.signerPrivateKey?.trim()
    if (privateKey && !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Predict.fun 签名私钥必须是 0x 开头的 32 字节十六进制值')
    const signerAddress = privateKey
      ? privateKeyToAccount(privateKey as `0x${string}`).address
      : existing?.signerAddress
    if (accountType === 'EOA' && accountAddress && signerAddress?.toLowerCase() !== accountAddress.toLowerCase()) {
      throw new Error('EOA 模式要求账户地址与签名私钥对应地址一致')
    }
    const stored: StoredPredictFunCredentials = {
      version: 2,
      apiKeyEncrypted: apiKey ? this.encrypt(apiKey) : existing?.apiKeyEncrypted,
      accountType,
      accountAddress,
      signerAddress,
      signerPrivateKeyEncrypted: privateKey ? this.encrypt(privateKey) : existing?.signerPrivateKeyEncrypted
    }
    if (!stored.apiKeyEncrypted && !process.env.PREDICT_FUN_API_KEY?.trim()) throw new Error('首次配置需要填写 Predict.fun API Key')
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    await writeFile(temporaryPath, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, this.filePath)
    return await this.getSummary()
  }

  async getApiKey(): Promise<string | undefined> {
    const environmentKey = process.env.PREDICT_FUN_API_KEY?.trim()
    if (environmentKey) return environmentKey
    if (!safeStorage.isEncryptionAvailable()) return undefined
    const stored = await this.load()
    return stored?.apiKeyEncrypted ? this.decrypt(stored.apiKeyEncrypted) : undefined
  }

  async getCredentials(): Promise<PredictFunCredentials> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用')
    const stored = await this.load()
    const apiKey = await this.getApiKey()
    if (!apiKey || !stored?.accountType || !stored.accountAddress || !stored.signerAddress || !stored.signerPrivateKeyEncrypted) {
      throw new Error('Predict.fun 交易身份尚未完整配置')
    }
    return {
      apiKey,
      accountType: stored.accountType,
      accountAddress: stored.accountAddress,
      signerAddress: stored.signerAddress,
      signerPrivateKey: this.decrypt(stored.signerPrivateKeyEncrypted)
    }
  }

  private async load(): Promise<StoredPredictFunCredentials | undefined> {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8')) as StoredPredictFunCredentials
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
