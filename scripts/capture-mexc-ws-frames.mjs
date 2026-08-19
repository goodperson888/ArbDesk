// 被动监听 MEXC 预测页 WebSocket 二进制帧:解析protobuf顶层字段,列出所有频道,
// 过滤掉已知的depth/index行情频道,转储其余帧用于逆向账户/余额推送格式。
// 用法: node scripts/capture-mexc-ws-frames.mjs [cdp端口,默认60642]
import { chromium } from 'playwright-core'

const endpoint = `http://127.0.0.1:${process.argv[2] ?? '60642'}`
const WS_HOSTS = /prediction\.mexc\.com|wbs\.mexc\.com/

const browser = await chromium.connectOverCDP(endpoint)
console.log(`[ws-dump] connected: ${endpoint}`)

// ---- 通用 protobuf 顶层转储 ----
function readVarint(bytes, state) {
  let value = 0n
  let multiplier = 1n
  for (let i = 0; i < 10; i++) {
    if (state.pos >= bytes.length) throw new Error('eof')
    const byte = bytes[state.pos++]
    value += BigInt(byte & 0x7f) * multiplier
    if ((byte & 0x80) === 0) return value
    multiplier *= 128n
  }
  throw new Error('bad varint')
}

function printable(text) {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e\u00a0-\uffff\n\r\t]*$/.test(text)
}

function dumpFields(bytes, depth = 0, maxDepth = 3) {
  const state = { pos: 0 }
  const out = []
  while (state.pos < bytes.length) {
    const start = state.pos
    let tag
    try {
      tag = readVarint(bytes, state)
    } catch {
      out.push(`@truncated@`)
      break
    }
    const field = Number(tag >> 3n)
    const wireType = Number(tag & 7n)
    try {
      if (wireType === 0) {
        out.push(`${field}:${readVarint(bytes, state).toString()}`)
      } else if (wireType === 1) {
        state.pos += 8
        out.push(`${field}:<fixed64>`)
      } else if (wireType === 5) {
        state.pos += 4
        out.push(`${field}:<fixed32>`)
      } else if (wireType === 2) {
        const len = Number(readVarint(bytes, state))
        const sub = bytes.subarray(state.pos, state.pos + len)
        state.pos += len
        if (state.pos > bytes.length) { out.push(`${field}:<overflow ${len}>`); break }
        const asText = new TextDecoder('utf-8', { fatal: false }).decode(sub)
        if (printable(asText) && asText.length > 0 && /[a-zA-Z0-9]/.test(asText)) {
          out.push(`${field}:"${asText.slice(0, 120)}"`)
        } else if (depth < maxDepth && sub.length > 1) {
          out.push(`${field}:{${dumpFields(sub, depth + 1, maxDepth).slice(0, 400)}}`)
        } else {
          out.push(`${field}:<${sub.length}b ${Buffer.from(sub).toString('hex').slice(0, 60)}>`)
        }
      } else {
        out.push(`@wire${wireType}@`)
        break
      }
    } catch {
      out.push(`@err@`)
      break
    }
    if (state.pos - start > bytes.length) break
  }
  return out.join(' ')
}

function analyzeFrame(payload) {
  const bytes = new Uint8Array(payload)
  // 顶层字段1是channel字符串
  const state = { pos: 0 }
  try {
    const tag = readVarint(bytes, state)
    if (Number(tag >> 3n) !== 1 || Number(tag & 7n) !== 2) return undefined
    const len = Number(readVarint(bytes, state))
    const channel = new TextDecoder().decode(bytes.subarray(state.pos, state.pos + len))
    return { channel, dump: dumpFields(bytes) }
  } catch {
    return undefined
  }
}

const KNOWN_NOISE = /predict@public\.depth|predict@public\.index/

async function hookPage(page) {
  const label = (await page.title().catch(() => '')).slice(0, 30) || page.url().slice(0, 50)
  page.on('websocket', (ws) => {
    if (!WS_HOSTS.test(ws.url())) return
    const tag = ws.url().includes('wsToken') ? 'auth' : ws.url().includes('wbs.') ? 'wbs' : 'pub'
    ws.on('framereceived', (frame) => {
      const payload = frame.payload
      if (typeof payload === 'string') {
        if (!/^\s*$/.test(payload) && payload.length < 500) {
          console.log(`[${tag} text] ${payload.slice(0, 300)}`)
        }
        return
      }
      const analyzed = analyzeFrame(payload)
      if (!analyzed) {
        console.log(`[${tag} bin ${payload.length}b] <unparsed> ${Buffer.from(payload).toString('hex').slice(0, 120)}`)
        return
      }
      if (KNOWN_NOISE.test(analyzed.channel)) return
      console.log(`\n[${tag} ${new Date().toISOString()}] ch=${analyzed.channel}`)
      console.log(`  ${analyzed.dump}`)
    })
  })
}

for (const context of browser.contexts()) {
  for (const page of context.pages()) await hookPage(page)
  context.on('page', hookPage)
}
console.log(`[ws-dump] listening on ${browser.contexts().reduce((n, c) => n + c.pages().length, 0)} pages...`)
console.log('[ws-dump] 已过滤depth/index行情频道;现在去页面上下单/等余额变化')
setInterval(() => {}, 60_000)
