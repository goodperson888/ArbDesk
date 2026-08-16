import { chromium } from 'playwright-core'

const port = Number(process.argv[2] || 59595)
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const context = browser.contexts()[0]
let lastState = ''
let lastDialog = ''

const fields = (value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.keys(value).sort()
  : []

function instrument(page) {
  if (page.__arbDeskMonitored) return
  page.__arbDeskMonitored = true
  page.on('request', (request) => {
    if (request.method() === 'GET' || !/\/api\/platform\/predict\/.*(?:order|asset)/.test(request.url())) return
    let body
    try { body = request.postDataJSON() } catch {}
    console.log('[REQUEST]', request.method(), new URL(request.url()).pathname, fields(body))
  })
  page.on('response', (response) => {
    if (response.request().method() === 'GET' || !/\/api\/platform\/predict\/.*(?:order|asset)/.test(response.url())) return
    void response.json().then((body) => {
      console.log('[RESPONSE]', response.status(), new URL(response.url()).pathname, fields(body), fields(body?.data))
    }).catch(() => undefined)
  })
  page.on('dialog', (dialog) => console.log('[DIALOG]', dialog.type(), dialog.message()))
}

for (const page of context.pages()) instrument(page)
context.on('page', instrument)

async function tick() {
  const page = context.pages().find((candidate) => candidate.url().includes('prediction.mexc.com'))
  if (!page) return
  instrument(page)
  const state = await page.evaluate(async () => {
    const get = async (path) => {
      const response = await fetch(path, { credentials: 'include', headers: { accept: 'application/json' } })
      return response.ok ? await response.json() : { status: response.status }
    }
    const [positions, orders, history] = await Promise.all([
      get('/api/platform/predict/asset/query/web/positions?mode=MIX'),
      get('/api/platform/predict/order/query/web/current/orders?orderTypes=1&states=0,1,3&pageNum=1&pageSize=100'),
      get('/api/platform/predict/asset/query/web/summaryLog?comboExclude=false&pageNum=1&pageSize=20')
    ])
    const positionRows = Array.isArray(positions.data) ? positions.data : []
    const orderRows = Array.isArray(orders.data?.resultList) ? orders.data.resultList : []
    const historyRows = Array.isArray(history.data?.result) ? history.data.result : []
    const latest = historyRows[0]
    return {
      url: location.href,
      positions: positionRows.length,
      positionFields: Object.keys(positionRows[0] ?? {}).sort(),
      orders: orderRows.length,
      orderFields: Object.keys(orderRows[0] ?? {}).sort(),
      latestHistory: latest ? { bt: latest.bt, ei: latest.ei, rft: latest.rft, ta: latest.ta, tn: latest.tn, tt: latest.tt, sif: latest.sif } : undefined
    }
  })
  const serialized = JSON.stringify(state)
  if (serialized !== lastState) {
    lastState = serialized
    console.log('[STATE]', serialized)
  }
  const dialog = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('[role="dialog"], [class*="modal" i]')]
      .filter((node) => node instanceof HTMLElement && node.offsetParent !== null)
    return nodes.map((node) => ({
      buttons: [...node.querySelectorAll('button')].map((button) => button.innerText.trim()).filter(Boolean),
      inputs: [...node.querySelectorAll('input')].map((input) => ({ type: input.type, placeholder: input.placeholder }))
    }))
  })
  const serializedDialog = JSON.stringify(dialog)
  if (serializedDialog !== lastDialog) {
    lastDialog = serializedDialog
    if (dialog.length) console.log('[NEW_UI]', serializedDialog)
  }
}

console.log('[MONITOR_READY]', { port, pages: context.pages().map((page) => page.url()) })
const timer = setInterval(() => void tick().catch((error) => console.error('[MONITOR_ERROR]', error.message)), 750)
await tick()
process.on('SIGINT', async () => {
  clearInterval(timer)
  // Do not call browser.close(): on a CDP attachment that would close the
  // user's Hubstudio environment rather than merely detaching this monitor.
  process.exit(0)
})
await new Promise(() => undefined)
