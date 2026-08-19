// 通过CDP Network域被动监听MEXC页面所有WebSocket帧(与ArbDesk生产代码同机制)。
// 过滤行情噪音,转储predict@私有频道与wbs@私有频道,用于逆向账户/余额推送。
// 用法: node scripts/capture-mexc-ws-frames2.mjs [cdp端口,默认60642]
import { chromium } from 'playwright-core'

const endpoint = `http://127.0.0.1:${process.argv[2] ?? '60642'}`
const browser = await chromium.connectOverCDP(endpoint)
console.log(`[ws-dump2] connected: ${endpoint}`)

const NOISE = /predict@public\.depth|predict@public\.index|spot@public\.|spot@private\.deals|PONG/

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

const printable = (t) => /^[\x20-\x7e\u00a0-\uffff\n\r\t]*$/.test(t)

function dumpFields(bytes, depth = 0) {
  const state = { pos: 0 }
  const out = []
  while (state.pos < bytes.length) {
    let tag
    try { tag = readVarint(bytes, state) } catch { out.push('@trunc@'); break }
    const field = Number(tag >> 3n)
    const wireType = Number(tag & 7n)
    try {
      if (wireType === 0) out.push(`${field}:${readVarint(bytes, state).toString()}`)
      else if (wireType === 1) { state.pos += 8; out.push(`${field}:<f64>`) }
      else if (wireType === 5) { state.pos += 4; out.push(`${field}:<f32>`) }
      else if (wireType === 2) {
        const len = Number(readVarint(bytes, state))
        const sub = bytes.subarray(state.pos, state.pos + len)
        state.pos += len
        if (state.pos > bytes.length) { out.push(`${field}:<ovf>`); break }
        const text = new TextDecoder('utf-8', { fatal: false }).decode(sub)
        if (printable(text) && text.length > 0 && /[a-zA-Z0-9]/.test(text)) out.push(`${field}:"${text.slice(0, 150)}"`)
        else if (depth < 3 && sub.length > 1) out.push(`${field}:{${dumpFields(sub, depth + 1).slice(0, 500)}}`)
        else out.push(`${field}:<${sub.length}b ${Buffer.from(sub).toString('hex').slice(0, 80)}>`)
      } else { out.push(`@w${wireType}@`); break }
    } catch { out.push('@err@'); break }
  }
  return out.join(' ')
}

function channelOf(bytes) {
  const state = { pos: 0 }
  try {
    const tag = readVarint(bytes, state)
    if (Number(tag >> 3n) !== 1 || Number(tag & 7n) !== 2) return undefined
    const len = Number(readVarint(bytes, state))
    return new TextDecoder().decode(bytes.subarray(state.pos, state.pos + len))
  } catch { return undefined }
}

async function hookPage(page) {
  const label = (await page.title().catch(() => '')).slice(0, 30) || page.url().slice(0, 50)
  const session = await page.context().newCDPSession(page)
  const socketUrls = new Map()
  await session.send('Network.enable')
  session.on('Network.webSocketCreated', (e) => socketUrls.set(e.requestId, e.url))
  session.on('Network.webSocketClosed', (e) => socketUrls.delete(e.requestId))
  session.on('Network.webSocketFrameReceived', (e) => {
    const url = socketUrls.get(e.requestId) ?? ''
    if (url && !/prediction\.mexc\.com|wbs\.mexc\.com/.test(url)) return
    const { opcode, payloadData } = e.response
    if (opcode === 2) {
      const bytes = new Uint8Array(Buffer.from(payloadData, 'base64'))
      const channel = channelOf(bytes)
      if (channel === undefined) {
        console.log(`[${label} bin ${bytes.length}b] <no-channel> ${dumpFields(bytes)}`)
        return
      }
      if (NOISE.test(channel)) return
      console.log(`\n[${label} bin ${new Date().toISOString()}] ch=${channel}`)
      console.log(`  ${dumpFields(bytes)}`)
    } else {
      const text = String(payloadData)
      if (text.trim() && !NOISE.test(text)) console.log(`[${label} text] ${text.slice(0, 400)}`)
    }
  })
  console.log(`[ws-dump2] hook: ${label}`)
}

for (const context of browser.contexts()) {
  for (const page of context.pages()) await hookPage(page).catch(() => undefined)
  context.on('page', (page) => void hookPage(page).catch(() => undefined))
}
console.log('[ws-dump2] listening; 已过滤行情噪音;去页面下单/等余额变化')
setInterval(() => {}, 60_000)
