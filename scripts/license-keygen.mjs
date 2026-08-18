import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const privateKeyPath = resolve('.license-private/license-private-key.pem')
const publicSourcePath = resolve('src/main/license-public-key.ts')
if (existsSync(privateKeyPath) && !process.argv.includes('--force')) {
  throw new Error(`私钥已存在：${privateKeyPath}。如确认轮换全部授权密钥，请显式添加 --force`)
}
const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
})
mkdirSync(dirname(privateKeyPath), { recursive: true })
writeFileSync(privateKeyPath, privateKey, { encoding: 'utf8', mode: 0o600 })
writeFileSync(publicSourcePath, `// Generated public key. The matching private key must never be committed.\nexport const LICENSE_PUBLIC_KEY_PEM = \`${publicKey.trim()}\`\n`, 'utf8')
process.stdout.write(`授权密钥已生成。\n私钥：${privateKeyPath}\n公钥源码：${publicSourcePath}\n请离线备份私钥；丢失后无法为现有安装续期。\n`)
