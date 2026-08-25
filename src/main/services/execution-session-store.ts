import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MultiVenueExecutionReceipt, MultiVenueExecutionSession, MultiVenueExecutionSessionStatus } from '../../shared/multi-venue'

const VERSION = 1
const MAX_SESSIONS = 200

interface PersistedSessions {
  version: number
  sessions: unknown[]
}

function isSession(value: unknown): value is MultiVenueExecutionSession {
  if (!value || typeof value !== 'object') return false
  const session = value as Partial<MultiVenueExecutionSession>
  return typeof session.sessionId === 'string' && typeof session.comparisonId === 'string' &&
    typeof session.createdAt === 'number' && typeof session.updatedAt === 'number' &&
    ['STARTED', 'HEDGED', 'RECOVERY_REQUIRED', 'RECONCILE_REQUIRED', 'CANCELED', 'RECOVERED'].includes(String(session.status))
}

function statusForReceipt(receipt: MultiVenueExecutionReceipt): MultiVenueExecutionSessionStatus {
  return receipt.status
}

export class ExecutionSessionStore {
  private readonly filePath: string
  private writeChain: Promise<void> = Promise.resolve()

  constructor(dataDirectory: string) {
    this.filePath = join(dataDirectory, 'execution-sessions.json')
  }

  getFilePath(): string { return this.filePath }

  async initialize(): Promise<void> {
    await mkdir(join(this.filePath, '..'), { recursive: true })
    try { await readFile(this.filePath, 'utf8') } catch { await this.write([]) }
  }

  async list(): Promise<MultiVenueExecutionSession[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<PersistedSessions>
      if (parsed.version !== VERSION || !Array.isArray(parsed.sessions)) return []
      return parsed.sessions.filter(isSession).map((session) => ({ ...session, receipt: session.receipt ? { ...session.receipt } : undefined }))
    } catch {
      return []
    }
  }

  async listAll(): Promise<MultiVenueExecutionSession[]> {
    return (await this.list()).sort((left, right) => right.updatedAt - left.updatedAt)
  }

  async listUnfinished(): Promise<MultiVenueExecutionSession[]> {
    const sessions = await this.listAll()
    return sessions.filter((session) => session.status === 'STARTED' || session.status === 'RECOVERY_REQUIRED' || session.status === 'RECONCILE_REQUIRED')
  }

  async begin(sessionId: string, comparisonId: string): Promise<MultiVenueExecutionSession> {
    const sessions = await this.list()
    if (sessions.some((session) => session.sessionId === sessionId)) throw new Error(`执行会话 ID 重复：${sessionId}`)
    const now = Date.now()
    const session: MultiVenueExecutionSession = { sessionId, comparisonId, status: 'STARTED', createdAt: now, updatedAt: now }
    await this.write([...sessions, session].slice(-MAX_SESSIONS))
    return session
  }

  async recordReceipt(receipt: MultiVenueExecutionReceipt): Promise<MultiVenueExecutionSession> {
    const sessions = await this.list()
    const now = Date.now()
    const current = sessions.find((session) => session.sessionId === receipt.sessionId)
    const updated: MultiVenueExecutionSession = {
      sessionId: receipt.sessionId,
      comparisonId: receipt.comparisonId,
      status: statusForReceipt(receipt),
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      receipt,
      recoveryNote: receipt.status === 'HEDGED' || receipt.status === 'CANCELED' ? undefined : receipt.message
    }
    const next = sessions.filter((session) => session.sessionId !== receipt.sessionId)
    await this.write([...next, updated].slice(-MAX_SESSIONS))
    return updated
  }

  async markRecovered(sessionId: string, note = '人工确认已完成'): Promise<MultiVenueExecutionSession> {
    const sessions = await this.list()
    const current = sessions.find((session) => session.sessionId === sessionId)
    if (!current) throw new Error(`执行会话不存在：${sessionId}`)
    const updated = { ...current, status: 'RECOVERED' as const, recoveryNote: note, updatedAt: Date.now() }
    await this.write(sessions.map((session) => session.sessionId === sessionId ? updated : session))
    return updated
  }

  private async write(sessions: MultiVenueExecutionSession[]): Promise<void> {
    const write = async (): Promise<void> => {
      const temporaryPath = `${this.filePath}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
      await writeFile(temporaryPath, JSON.stringify({ version: VERSION, sessions }, null, 2), 'utf8')
      await rename(temporaryPath, this.filePath)
    }
    this.writeChain = this.writeChain.then(write, write)
    return this.writeChain
  }
}
