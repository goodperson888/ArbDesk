import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { hostname, platform, arch } from 'node:os'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import type { LicenseStatus, LicenseSummary } from '../../shared/types'

interface LicensePayload {
  version: 1
  licenseId: string
  customer: string
  machineCode: string
  issuedAt: number
  validFrom: number
  validUntil: number
  features: string[]
}

interface StoredLicenseState {
  version: 1
  activationCodeEncrypted?: string
  lastSeenAtEncrypted?: string
}

export interface LicenseCrypto {
  isAvailable(): boolean
  encrypt(value: string): string
  decrypt(value: string): string
}

const electronLicenseCrypto: LicenseCrypto = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
  decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64'))
}

const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60_000

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

function readPlatformMachineIdentity(): string {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8' })
      const match = output.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i)
      if (match?.[1]) return `windows:${match[1].trim()}`
    }
    if (process.platform === 'darwin') {
      const output = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' })
      const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
      if (match?.[1]) return `macos:${match[1]}`
    }
    if (process.platform === 'linux') {
      const output = readFileSync('/etc/machine-id', 'utf8')
      if (output.trim()) return `linux:${output.trim()}`
    }
  } catch {
    // Fall back to a less stable identifier when the OS-specific source is unavailable.
  }
  return `fallback:${platform()}:${arch()}:${hostname()}`
}

export function machineCodeFromIdentity(identity: string): string {
  const digest = createHash('sha256').update(`ArbDesk-License-v1:${identity}`).digest('hex').slice(0, 24).toUpperCase()
  return `ARB-${digest.match(/.{1,4}/g)?.join('-') ?? digest}`
}

export class LicenseService {
  private state: StoredLicenseState = { version: 1 }
  private machineCode = ''

  constructor(
    private readonly filePath: string,
    private readonly publicKeyPem: string,
    private readonly crypto: LicenseCrypto = electronLicenseCrypto,
    private readonly machineIdentityProvider: () => string = readPlatformMachineIdentity,
    private readonly nowProvider: () => number = Date.now
  ) {}

  async initialize(): Promise<LicenseSummary> {
    this.machineCode = machineCodeFromIdentity(this.machineIdentityProvider())
    this.state = await this.load()
    return await this.getSummary()
  }

  async getSummary(): Promise<LicenseSummary> {
    if (!this.machineCode) this.machineCode = machineCodeFromIdentity(this.machineIdentityProvider())
    if (!this.crypto.isAvailable()) return this.summary('STORAGE_ERROR', '系统安全存储不可用，无法验证或保存授权')
    if (!this.state.activationCodeEncrypted) return this.summary('UNLICENSED', '请输入与你的机器码匹配的限时授权码')
    let activationCode: string
    try {
      activationCode = this.crypto.decrypt(this.state.activationCodeEncrypted)
    } catch {
      return this.summary('INVALID', '本机授权数据无法解密，请重新输入授权码')
    }
    return await this.evaluateCode(activationCode, true)
  }

  async activate(activationCodeInput: string): Promise<LicenseSummary> {
    if (!this.crypto.isAvailable()) throw new Error('系统安全存储不可用，无法保存授权')
    const activationCode = activationCodeInput.trim().replace(/\s+/g, '')
    const summary = await this.evaluateCode(activationCode, false)
    if (summary.status !== 'ACTIVE') throw new Error(summary.message)
    this.state = {
      version: 1,
      activationCodeEncrypted: this.crypto.encrypt(activationCode),
      lastSeenAtEncrypted: this.crypto.encrypt(String(this.nowProvider()))
    }
    await this.save()
    return await this.getSummary()
  }

  async deactivate(): Promise<LicenseSummary> {
    this.state = { version: 1 }
    await this.save()
    return await this.getSummary()
  }

  async requireActive(): Promise<LicenseSummary> {
    const summary = await this.getSummary()
    if (summary.status !== 'ACTIVE') throw new Error(`授权不可用：${summary.message}`)
    return summary
  }

  private async evaluateCode(activationCode: string, persistLastSeen: boolean): Promise<LicenseSummary> {
    let payload: LicensePayload
    try {
      const [prefix, payloadEncoded, signatureEncoded] = activationCode.split('.')
      if (prefix !== 'ARB1' || !payloadEncoded || !signatureEncoded) throw new Error('授权码结构无效')
      if (this.publicKeyPem.includes('REPLACE_WITH_')) throw new Error('软件发行版尚未配置授权公钥')
      const payloadBytes = base64UrlDecode(payloadEncoded)
      const signature = base64UrlDecode(signatureEncoded)
      const validSignature = verify(null, payloadBytes, createPublicKey(this.publicKeyPem), signature)
      if (!validSignature) throw new Error('授权签名校验失败')
      payload = JSON.parse(payloadBytes.toString('utf8')) as LicensePayload
      if (
        payload.version !== 1 || !payload.licenseId || !payload.customer ||
        payload.machineCode !== this.machineCode || !Number.isFinite(payload.validFrom) ||
        !Number.isFinite(payload.validUntil) || payload.validUntil <= payload.validFrom
      ) throw new Error(payload.machineCode !== this.machineCode ? '授权码与本机机器码不匹配' : '授权内容无效')
    } catch (error) {
      return this.summary('INVALID', error instanceof Error ? error.message : '授权码无效')
    }

    const now = this.nowProvider()
    const lastSeenAt = this.readLastSeenAt()
    if (lastSeenAt && now + CLOCK_ROLLBACK_TOLERANCE_MS < lastSeenAt) {
      return this.summary('CLOCK_ERROR', '检测到系统时间明显回退，请校准系统时间后重新打开软件', payload)
    }
    if (now < payload.validFrom) return this.summary('INVALID', '授权尚未到生效时间，请检查系统时间', payload)
    if (now >= payload.validUntil) {
      if (persistLastSeen) {
        try { await this.persistLastSeen(Math.max(now, lastSeenAt)) } catch {
          return this.summary('STORAGE_ERROR', '授权状态无法写入系统安全存储，请检查本机权限', payload)
        }
      }
      return this.summary('EXPIRED', `授权已于${new Date(payload.validUntil).toLocaleString('zh-CN')}到期`, payload)
    }
    if (persistLastSeen) {
      try { await this.persistLastSeen(Math.max(now, lastSeenAt)) } catch {
        return this.summary('STORAGE_ERROR', '授权状态无法写入系统安全存储，请检查本机权限', payload)
      }
    }
    return this.summary('ACTIVE', `授权有效至${new Date(payload.validUntil).toLocaleString('zh-CN')}`, payload)
  }

  private summary(status: LicenseStatus, message: string, payload?: LicensePayload): LicenseSummary {
    const now = this.nowProvider()
    return {
      status,
      machineCode: this.machineCode,
      licenseId: payload?.licenseId,
      customer: payload?.customer,
      validFrom: payload?.validFrom,
      validUntil: payload?.validUntil,
      remainingSeconds: payload ? Math.max(0, Math.floor((payload.validUntil - now) / 1_000)) : undefined,
      emergencyOnly: false,
      encryptionAvailable: this.crypto.isAvailable(),
      message
    }
  }

  private readLastSeenAt(): number {
    try {
      if (!this.state.lastSeenAtEncrypted) return 0
      const parsed = Number(this.crypto.decrypt(this.state.lastSeenAtEncrypted))
      return Number.isFinite(parsed) ? parsed : 0
    } catch {
      return 0
    }
  }

  private async persistLastSeen(value: number): Promise<void> {
    if (!this.state.activationCodeEncrypted) return
    const previous = this.readLastSeenAt()
    if (value - previous < 60_000) return
    this.state.lastSeenAtEncrypted = this.crypto.encrypt(String(value))
    await this.save()
  }

  private async load(): Promise<StoredLicenseState> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as StoredLicenseState
      return parsed.version === 1 ? parsed : { version: 1 }
    } catch {
      return { version: 1 }
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, this.filePath)
  }
}
