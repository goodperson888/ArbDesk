// 常驻抓取：监听容器内 prediction.mexc.com 页面的网络请求。
// 目标1：/event/events 的完整原始响应（找 currencyId 字段）
// 目标2：order/place 请求的完整请求头+请求体（看鉴权方式）
// 输出：NDJSON，每行一个事件，写到 OUT 路径。
import { chromium } from 'playwright-core'
import { execFile } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const OUT = '/tmp/mexc-order-api-capture.ndjson'
const CONTAINER = JSON.parse(
  readFileSync(process.env.HOME + '/Library/Application Support/mexc-polymarket-arb/data/settings.json', 'utf8')
).hubstudioContainerCode

const log = (row) => appendFileSync(OUT, JSON.stringify({ t: Date.now(), ...row }) + '\n')

async function discoverCdp() {
  const ps = await new Promise((res) => execFile('ps', ['-axo', 'args='], { maxBuffer: 8 * 1024 * 1024 }, (e, so) => res(e ? '' : String(so))))
  const apiPorts = [...new Set([...ps.matchAll(/httpServer\.cjs\D+(\d{2,5})/g)].map((m) => Number(m[1])))]
  for (const port of [...apiPorts, 6873]) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/browser/all-browser-status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([CONTAINER]), signal: AbortSignal.timeout(1500)
      })
      if (!r.ok) continue
      const j = await r.json()
      const c = (j.data?.containers || []).find((x) => x.containerCode === CONTAINER)
      if (!c?.pid) continue
      const lsof = await new Promise((res) =>
        execFile('lsof', ['-Pan', '-p', String(c.pid), '-iTCP', '-sTCP:LISTEN'], { maxBuffer: 4 * 1024 * 1024 }, (e, so) => res(e ? '' : String(so))))
      const ports = [...new Set([...lsof.matchAll(/:(\d+)\s+\(LISTEN\)/g)].map((m) => Number(m[1])))]
      for (const p of ports) {
        try {
          const v = await (await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(800) })).json()
          if (v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl
        } catch {}
      }
    } catch {}
  }
  return null
}

const EVENT_URL = /\/api\/platform\/predict\/market\/web\/event\/events/
const ORDER_URL = /\/api\/platform\/predict\/orderCenter\//

function attachPage(page) {
  const tag = page.url().slice(0, 80)
  console.log(`[watch] ${tag}`)
  page.on('request', (request) => {
    const url = request.url()
    if (!ORDER_URL.test(url)) return
    void (async () => {
      try {
        log({ kind: 'order-request', url, method: request.method(), headers: await request.allHeaders(), body: request.postData() ?? '' })
        console.log(`[hit] order request ${url}`)
      } catch {}
    })()
  })
  page.on('response', (response) => {
    const url = response.url()
    const wantBody = ORDER_URL.test(url) || EVENT_URL.test(url)
    if (!wantBody) return
    void (async () => {
      try {
        const body = await response.text()
        log({ kind: 'response', url, status: response.status(), body: body.slice(0, 20000) })
        if (ORDER_URL.test(url)) console.log(`[hit] order response ${url} -> ${body.slice(0, 160)}`)
      } catch {}
    })()
  })
}

console.log(`capture -> ${OUT}`)
for (;;) {
  const ws = await discoverCdp()
  if (!ws) { await sleep(5000); continue }
  try {
    const browser = await chromium.connectOverCDP(ws)
    console.log(`[conn] ${ws}`)
    const ctx = browser.contexts()[0]
    for (const p of ctx.pages()) if (p.url().includes('prediction.mexc.com')) attachPage(p)
    ctx.on('page', (p) => { if (p.url().includes('prediction.mexc.com')) attachPage(p); p.on('domcontentloaded', () => { if (p.url().includes('prediction.mexc.com')) attachPage(p) }) })
    await new Promise((resolve) => browser.on('disconnected', resolve))
    console.log('[conn] lost, retrying...')
  } catch (e) {
    console.log(`[conn] error ${e.message}`)
  }
  await sleep(3000)
}
