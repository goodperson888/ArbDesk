// 只读探测：验证 prediction 页面自己是否会周期性请求 symbolsV2（被动拦截的前提）。
// 1) performance 资源时间轴里找 symbolsV2 的历史请求时刻
// 2) 现场监听 90 秒，看是否真的有请求飞过
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

// 1) 历史请求（本次页面会话内）
const history = await page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0]
  const upTo = performance.now()
  return {
    pageAgeMin: upTo / 60000,
    entries: performance.getEntriesByType('resource')
      .filter((r) => r.name.includes('symbolsV2'))
      .map((r) => ({ atMin: Number((r.startTime / 60000).toFixed(2)), size: r.transferSize, dur: Math.round(r.duration) }))
  }
})
console.log(`\n===== 页面已运行 ${history.pageAgeMin.toFixed(1)} 分钟`)
if (history.entries.length === 0) {
  console.log('历史记录：本会话没有 symbolsV2 请求')
} else {
  console.log(`历史记录：本会话共 ${history.entries.length} 次 symbolsV2 请求`)
  for (const e of history.entries) console.log(`  +${e.atMin}min 传输 ${(e.size / 1024 / 1024).toFixed(2)}MB 耗时 ${e.dur}ms`)
}

// 2) 现场监听 90 秒
console.log('\n===== 现场监听 90 秒……')
const hits = []
page.on('response', (response) => {
  const url = response.url()
  if (url.includes('symbolsV2')) hits.push({ at: new Date().toISOString().slice(11, 19), url: url.slice(0, 100) })
})
await new Promise((resolve) => setTimeout(resolve, 90_000))
console.log(`监听期内 symbolsV2 命中 ${hits.length} 次`)
for (const h of hits) console.log(`  ${h.at} ${h.url}`)
if (hits.length === 0) console.log('（90秒内页面没拉symbolsV2——可能周期更长，或只在换盘/刷新时拉）')

await browser.close()
