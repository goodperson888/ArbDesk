import { randomUUID, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const argument = (name) => {
  const direct = process.argv.find((value) => value.startsWith(`--${name}=`))
  if (direct) return direct.slice(name.length + 3)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const machineCode = String(argument('machine') ?? '').trim().toUpperCase()
const customer = String(argument('customer') ?? '').trim()
const days = Number(argument('days') ?? 0)
const validUntilInput = argument('until')
if (!/^ARB-(?:[A-F0-9]{4}-){5}[A-F0-9]{4}$/.test(machineCode)) throw new Error('请传入软件显示的有效机器码：--machine ARB-XXXX-...')
if (!customer) throw new Error('请传入客户标识：--customer "客户名"')
if (!(days > 0) && !validUntilInput) throw new Error('请传入授权天数 --days 30，或到期时间 --until 2026-12-31T23:59:59+08:00')
const now = Date.now()
const validUntil = validUntilInput ? Date.parse(validUntilInput) : now + days * 24 * 60 * 60 * 1_000
if (!Number.isFinite(validUntil) || validUntil <= now) throw new Error('授权到期时间必须晚于当前时间')
const payload = {
  version: 1,
  licenseId: randomUUID(),
  customer,
  machineCode,
  issuedAt: now,
  validFrom: now - 60_000,
  validUntil,
  features: ['ARBDESK_DESKTOP']
}
const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8')
const privateKey = readFileSync(resolve('.license-private/license-private-key.pem'), 'utf8')
const signature = sign(null, payloadBytes, privateKey)
process.stdout.write(`ARB1.${payloadBytes.toString('base64url')}.${signature.toString('base64url')}\n`)
