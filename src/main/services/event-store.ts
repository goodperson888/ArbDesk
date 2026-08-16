import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ExecutionEvent, RiskSettings } from '../../shared/types'

export class EventStore {
  private readonly eventsPath: string
  private readonly settingsPath: string

  constructor(dataDirectory: string) {
    this.eventsPath = join(dataDirectory, 'audit.ndjson')
    this.settingsPath = join(dataDirectory, 'settings.json')
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
      return { ...defaults, ...(JSON.parse(content) as Partial<RiskSettings>) }
    } catch {
      return defaults
    }
  }

  async saveSettings(settings: RiskSettings): Promise<void> {
    const temporaryPath = `${this.settingsPath}.tmp`
    await writeFile(temporaryPath, JSON.stringify(settings, null, 2), 'utf8')
    await rename(temporaryPath, this.settingsPath)
  }
}
