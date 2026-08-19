// 被动监听 Hubstudio 中 MEXC 页面的余额更新途径:REST / WebSocket / 无请求。
// 只监听不下单,需人工在页面上下一笔小单。
// 用法: node scripts/capture-mexc-balance.mjs [cdp端口,默认60642]
import { chromium } from 'playwright-core'

const endpoint = `http://127.0.0.1:${process.argv[2] ?? '60642'}`
// 余额/资产相关的 REST 路径
const BALANCE_PATTERN = /balance|asset|wallet|account|query\/web/i
const HOST_PATTERN = /mexc/i

const browser = await chromium.connectOverCDP(endpoint)
console.log(`[sniffer] connected: ${endpoint}`)

function short(body, max = 600) {
  return body.length > max ? `${body.slice(0, max)}...` : body
}

async function hookPage(page) {
  const label = (await page.title().catch(() => '')).slice(0, 40) || page.url().slice(0, 60)
  console.log(`[sniffer] hook: ${label}`)

  page.on('response', async (response) => {
    const url = response.url()
    if (!HOST_PATTERN.test(url)) return
    if (response.request().resourceType() !== 'xhr' && response.request().resourceType() !== 'fetch') return
    // 记录两类:明确余额相关的;以及所有 XHR 的简要行(方便发现未知端点)
    const interesting = BALANCE_PATTERN.test(url)
    if (!interesting && !/\/api\//.test(url)) return
    try {
      const body = await response.text()
      if (interesting) {
        console.log(`\n=== BALANCE-REST ${new Date().toISOString()} [${label}]`)
        console.log(`${response.request().method()} ${url} -> ${response.status()}`)
        console.log(short(body))
      } else {
        console.log(`[xhr] ${url.replace(/^https?:\/\/[^/]+/, '')} -> ${response.status()}`)
      }
    } catch { /* body 不可用则跳过 */ }
  })

  page.on('websocket', (ws) => {
    const url = ws.url()
    console.log(`\n[ws-open] ${url}`)
    ws.on('framereceived', (frame) => {
      const payload = frame.payload
      if (typeof payload !== 'string') return
      // 只打印疑似含余额/资产的帧,避免刷屏
      if (/"balance|"asset|available|usdt/i.test(payload)) {
        console.log(`[ws-frame <= ] ${new Date().toISOString()} ${short(payload, 800)}`)
      }
    })
    ws.on('close', () => console.log(`[ws-close] ${url}`))
  })

  page.on('close', () => console.log(`[sniffer] page closed: ${label}`))
}

for (const context of browser.contexts()) {
  for (const page of context.pages()) await hookPage(page)
  context.on('page', hookPage)
}

console.log(`[sniffer] listening on ${browser.contexts().reduce((n, c) => n + c.pages().length, 0)} pages...`)
console.log('[sniffer] 请确认我们应用已断开MEXC连接(否则15秒一次的余额请求会干扰判断),然后在页面上下一笔小单')
setInterval(() => {}, 60_000)
