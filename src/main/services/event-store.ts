import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ArbitrageOrderRecord, ExecutionEvent, RiskSettings } from '../../shared/types'
import { defaultManualExecutionConditions } from '../../shared/defaults'

export class EventStore {
  private readonly eventsPath: string
  private readonly settingsPath: string
  private readonly ordersPath: string

  constructor(dataDirectory: string) {
    this.eventsPath = join(dataDirectory, 'audit.ndjson')
    this.settingsPath = join(dataDirectory, 'settings.json')
    this.ordersPath = join(dataDirectory, 'orders.json')
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.eventsPath), { recursive: true })
  }

  async appendEvent(event: ExecutionEvent): Promise<void> {
    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, 'utf8')
  }

  async loadRecentEvents(limit = 100): Promise<ExecutionEvent[]> {
    try {
      const content = await readFile(this.eventsPath, 'utf8')
      return content
        .trim()
        .split('\n')
        .filter(Boolean)
        .slice(-limit)
        .map((line) => JSON.parse(line) as ExecutionEvent)
        .reverse()
    } catch {
      return []
    }
  }

  async loadSettings(defaults: RiskSettings): Promise<RiskSettings> {
    try {
      const content = await readFile(this.settingsPath, 'utf8')
      const stored = JSON.parse(content) as Partial<RiskSettings>
      const current = { ...stored } as Partial<RiskSettings> & Record<string, unknown>
      delete current.minNetEdgePerShare
      return {
        ...defaults,
        ...current,
        manualExecutionConditions: defaultManualExecutionConditions(stored.manualExecutionConditions)
      }
    } catch {
      return defaults
    }
  }

  async saveSettings(settings: RiskSettings): Promise<void> {
    const temporaryPath = `${this.settingsPath}.tmp`
    await writeFile(temporaryPath, JSON.stringify(settings, null, 2), 'utf8')
    await rename(temporaryPath, this.settingsPath)
  }

  async loadOrderHistory(): Promise<ArbitrageOrderRecord[]> {
    try {
      const content = await readFile(this.ordersPath, 'utf8')
      const parsed = JSON.parse(content) as unknown
      return Array.isArray(parsed) ? parsed as ArbitrageOrderRecord[] : []
    } catch {
      return []
    }
  }

  async saveOrderHistory(orders: ArbitrageOrderRecord[]): Promise<void> {
    const write = async (): Promise<void> => {
      const temporaryPath = `${this.ordersPath}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
      await writeFile(temporaryPath, JSON.stringify(orders, null, 2), 'utf8')
      await rename(temporaryPath, this.ordersPath)
    }
    this.orderSaveChain = this.orderSaveChain.then(write, write)
    return this.orderSaveChain
  }

  private orderSaveChain: Promise<void> = Promise.resolve()
}
