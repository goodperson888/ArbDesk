import { chromium } from 'playwright-core'
import { execFileSync } from 'node:child_process'

// 1. 发现Hubstudio Local API端口
const ps = execFileSync('ps', ['-axo', 'args='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const apiPorts = [...new Set([...ps.matchAll(/httpServer\.cjs\D+(\d{2,5})/g)].map(m => Number(m[1])))]
apiPorts.push(6873)
let apiBase = ''
for (const port of apiPorts) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/browser/all-browser-status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(['1588617301']), signal: AbortSignal.timeout(1500)
    })
    if (r.ok) { apiBase = `http://127.0.0.1:${port}`; break }
  } catch {}
}
if (!apiBase) { console.log('未找到Hubstudio Local API'); process.exit(1) }
console.log(`Hubstudio API: ${apiBase}`)

// 2. 拿容器pid -> lsof监听端口 -> 探测CDP
const status = await (await fetch(`${apiBase}/api/v1/browser/all-browser-status`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(['1588617301'])
})).json()
const container = status.data?.containers?.find(c => c.containerCode === '1588617301')
const pid = Number(container?.pid)
console.log(`container pid: ${pid}`)
let cdpPort = 0
if (pid > 0) {
  const lsof = execFileSync('lsof', ['-Pan', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' }).toString()
  const ports = [...new Set([...lsof.matchAll(/:(\d+)\s+\(LISTEN\)/g)].map(m => Number(m[1])))]
  for (const port of ports) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) })
      if (r.ok && (await r.json()).webSocketDebuggerUrl) { cdpPort = port; break }
    } catch {}
  }
}
if (!cdpPort) { console.log('未找到CDP端口'); process.exit(1) }
console.log(`CDP端口: ${cdpPort}`)

// 3. 连接检查页面与Cookie
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
for (const context of browser.contexts()) {
  const cookies = await context.cookies(['https://prediction.mexc.com'])
  const byName = new Map()
  for (const c of cookies) byName.set(c.name, (byName.get(c.name) ?? 0) + 1)
  const dupNames = [...byName.entries()].filter(([, n]) => n > 3).map(([name, n]) => `${name}x${n}`)
  const totalBytes = cookies.reduce((n, c) => n + c.name.length + c.value.length + 2, 0)
  console.log(`prediction.mexc.com cookies: ${cookies.length}个, 约${totalBytes}B, 重复>3: [${dupNames.join(', ')}]`)
  for (const page of context.pages()) {
    const title = await page.title().catch(() => '')
    const url = page.url()
    const err = /^\s*(400|401|403|502|504)\b|Request Header Or Cookie/i.test(title) ? '  <-- 错误页!' : ''
    console.log(`page: "${title.slice(0, 60)}" || ${url.slice(0, 90)}${err}`)
  }
}
await browser.close()
