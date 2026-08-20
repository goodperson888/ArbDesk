// 只读探测：在容器内 prediction 页面查 current/orders 各 states 的返回形态，
// 对照 summaryLog，判断“已成交/部分成交”的 state 枚举值。
import { chromium } from 'playwright-core'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'

const CONTAINER = JSON.parse(
  readFileSync(process.env.HOME + '/Library/Application Support/mexc-polymarket-arb/data/settings.json', 'utf8')
).hubstudioContainerCode

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

const ws = await discoverCdp()
if (!ws) { console.log('no CDP'); process.exit(1) }
const browser = await chromium.connectOverCDP(ws)
const ctx = browser.contexts()[0]
const page = ctx.pages().find((p) => p.url().includes('prediction.mexc.com'))
if (!page) { console.log('no prediction page'); process.exit(1) }
console.log('page:', page.url().slice(0, 60))

const probe = async (states) => {
  const url = `/api/platform/predict/order/query/web/current/orders?orderTypes=1&states=${states}&pageNum=1&pageSize=20`
  return await page.evaluate(async (u) => {
    const r = await fetch(u, { headers: { accept: 'application/json' }, credentials: 'include' })
    return { status: r.status, body: await r.text() }
  }, url)
}

for (const states of ['0,1,3', '0,1,2,3,4,5', '2', '4', '5']) {
  try {
    const r = await probe(states)
    const body = JSON.parse(r.body)
    const rows = body?.data?.result ?? body?.data ?? []
    console.log(`\n===== states=${states} HTTP ${r.status} code=${body?.code} rows=${Array.isArray(rows) ? rows.length : '?'}`)
    if (Array.isArray(rows)) {
      for (const row of rows.slice(0, 6)) console.log(JSON.stringify(row).slice(0, 400))
    } else {
      console.log(r.body.slice(0, 600))
    }
  } catch (e) {
    console.log(`states=${states} error: ${e.message}`)
  }
}

// 对照：summaryLog 最近的 107 买入行
const log = await page.evaluate(async () => {
  const r = await fetch('/api/platform/predict/asset/query/web/summaryLog?comboExclude=false&pageNum=1&pageSize=20', { headers: { accept: 'application/json' }, credentials: 'include' })
  const b = await r.json()
  return (b.data?.result ?? []).filter((row) => Number(row.bt) === 107).slice(0, 5)
})
console.log('\n===== summaryLog bt=107 最近买入')
for (const row of log) console.log(JSON.stringify(row).slice(0, 400))

await browser.close()
