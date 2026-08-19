// 被动监听 Hubstudio 浏览器中 MEXC 下单相关请求/响应,不点击、不下单。
// 用法: node scripts/capture-mexc-order.mjs [cdp端口,默认60642]
import { chromium } from 'playwright-core'

const endpoint = `http://127.0.0.1:${process.argv[2] ?? '60642'}`
const ORDER_PATTERN = /\/order|place|trade|execute/i
const HOST_PATTERN = /mexc/i

const browser = await chromium.connectOverCDP(endpoint)
console.log(`[sniffer] connected: ${endpoint}`)

async function safeBody(response) {
  try {
    return (await response.text()).slice(0, 2000)
  } catch {
    return '<body unavailable>'
  }
}

async function hookPage(page) {
  const label = (await page.title().catch(() => '')).slice(0, 40) || page.url().slice(0, 60)
  page.on('response', async (response) => {
    const url = response.url()
    if (!HOST_PATTERN.test(url) || !ORDER_PATTERN.test(url)) return
    const request = response.request()
    let postData = request.postData() ?? ''
    try {
      const parsed = JSON.parse(postData)
      for (const key of Object.keys(parsed)) {
        if (/token|sign|secret|auth/i.test(key)) parsed[key] = '***'
      }
      postData = JSON.stringify(parsed)
    } catch { /* 非JSON原文输出 */ }
    console.log(`\n=== ${new Date().toISOString()} [${label}]`)
    console.log(`${request.method()} ${url} -> ${response.status()}`)
    if (postData) console.log(`request: ${postData.slice(0, 500)}`)
    console.log(`response: ${await safeBody(response)}`)
  })
  page.on('close', () => console.log(`[sniffer] page closed: ${label}`))
}

for (const context of browser.contexts()) {
  for (const page of context.pages()) await hookPage(page)
  context.on('page', hookPage)
}

console.log(`[sniffer] listening on ${browser.contexts().reduce((n, c) => n + c.pages().length, 0)} pages...`)
setInterval(() => {}, 60_000)
