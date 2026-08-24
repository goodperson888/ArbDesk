import { describe, expect, it, vi } from 'vitest'
import { FingerprintBrowserRuntime, type FingerprintBrowserBackend } from './fingerprint-browser-runtime'

function page(url: string): { url: () => string; isClosed: () => boolean; goto: (target: string) => Promise<void>; on: ReturnType<typeof vi.fn> } {
  return { url: () => url, isClosed: () => false, goto: vi.fn(async () => undefined), on: vi.fn() }
}

describe('FingerprintBrowserRuntime', () => {
  it('adopts one running Hubstudio browser for multiple venue pages', async () => {
    const gatePage = page('https://www.gate.com/zh/trade-events/btc-updown-15m')
    const mexcPage = page('https://prediction.mexc.com/prediction-markets/all')
    const context = { pages: () => [gatePage, mexcPage], newPage: vi.fn(async () => gatePage) }
    const browser = { contexts: () => [context], isConnected: () => true, on: vi.fn() }
    const backend: FingerprintBrowserBackend = {
      resolveRunningPort: vi.fn(async () => 9333),
      connect: vi.fn(async () => browser as never),
      start: vi.fn(async () => ({ debuggingPort: 9333 }))
    }
    const runtime = new FingerprintBrowserRuntime(backend)
    runtime.configure({ containerCode: 'container-1' })

    const first = await runtime.attach('GATE', { hosts: ['gate.com'] })
    const second = await runtime.attach('MEXC', { hosts: ['prediction.mexc.com'] })

    expect(first).toBe(gatePage)
    expect(second).toBe(mexcPage)
    expect(backend.connect).toHaveBeenCalledTimes(1)
    expect(backend.resolveRunningPort).toHaveBeenCalledWith('container-1')
  })

  it('does not create an unrelated page when an existing venue page is required', async () => {
    const context = { pages: () => [page('https://example.com')], newPage: vi.fn() }
    const browser = { contexts: () => [context], isConnected: () => true, on: vi.fn() }
    const backend: FingerprintBrowserBackend = {
      resolveRunningPort: vi.fn(async () => 9333),
      connect: vi.fn(async () => browser as never),
      start: vi.fn(async () => ({ debuggingPort: 9333 }))
    }
    const runtime = new FingerprintBrowserRuntime(backend)
    runtime.configure({ containerCode: 'container-1' })

    await expect(runtime.attach('GATE', { hosts: ['gate.com'], createIfMissing: false }))
      .rejects.toThrow('没有找到 GATE 指纹浏览器标签页')
    expect(context.newPage).not.toHaveBeenCalled()
  })

  it('creates a missing venue page at its passive startup URL', async () => {
    const startupUrl = 'https://www.gate.com/zh/trade-events/btc-updown-5m'
    const createdPage = page('about:blank')
    const context = { pages: () => [], newPage: vi.fn(async () => createdPage) }
    const browser = { contexts: () => [context], isConnected: () => true, on: vi.fn() }
    const backend: FingerprintBrowserBackend = {
      resolveRunningPort: vi.fn(async () => 9333),
      connect: vi.fn(async () => browser as never),
      start: vi.fn(async () => ({ debuggingPort: 9333 }))
    }
    const runtime = new FingerprintBrowserRuntime(backend)
    runtime.configure({ containerCode: 'container-1' })

    await runtime.attach('GATE', { hosts: ['gate.com'], createIfMissing: true, startupUrl })

    expect(context.newPage).toHaveBeenCalledTimes(1)
    expect(createdPage.goto).toHaveBeenCalledWith(startupUrl, { waitUntil: 'domcontentloaded' })
  })

  it('requires a configured fingerprint container', async () => {
    const backend: FingerprintBrowserBackend = {
      resolveRunningPort: vi.fn(),
      connect: vi.fn(),
      start: vi.fn()
    }
    const runtime = new FingerprintBrowserRuntime(backend)

    await expect(runtime.attach('GATE', { hosts: ['gate.com'] }))
      .rejects.toThrow('请先配置指纹浏览器环境ID')
    expect(backend.resolveRunningPort).not.toHaveBeenCalled()
  })
})
