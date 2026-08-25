import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MultiVenueExecutionReceipt } from '../../shared/multi-venue'
import { ExecutionSessionStore } from './execution-session-store'

const receipt: MultiVenueExecutionReceipt = {
  sessionId: 'session-1', comparisonId: 'route-1', status: 'RECOVERY_REQUIRED',
  firstLeg: { venueId: 'MEXC', direction: 'UP', requestedQuantity: '2', filledQuantity: '1', status: 'PARTIAL' },
  message: 'partial'
}

describe('execution session store', () => {
  it('persists a receipt and lists unfinished sessions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arbdesk-sessions-'))
    const store = new ExecutionSessionStore(directory)
    await store.initialize()
    await store.begin('session-1', 'route-1')
    await store.recordReceipt(receipt)

    expect((await store.listUnfinished()).map((session) => session.sessionId)).toEqual(['session-1'])
    await store.markRecovered('session-1', '人工已核对')
    expect(await store.listUnfinished()).toEqual([])
  })

  it('lists completed and unfinished sessions together for history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arbdesk-sessions-history-'))
    const store = new ExecutionSessionStore(directory)
    await store.initialize()
    await store.begin('unfinished', 'route-unfinished')
    await store.recordReceipt({ ...receipt, sessionId: 'unfinished', comparisonId: 'route-unfinished' })
    await store.begin('completed', 'route-completed')
    await store.recordReceipt({ ...receipt, sessionId: 'completed', comparisonId: 'route-completed', status: 'HEDGED', secondLeg: { venueId: 'KALSHI', direction: 'DOWN', requestedQuantity: '1', filledQuantity: '1', status: 'FILLED' }, message: 'hedged' })
    await store.markRecovered('unfinished', '人工已核对')

    expect((await store.listAll()).map((session) => session.sessionId).sort()).toEqual(['completed', 'unfinished'])
    expect((await store.listUnfinished()).map((session) => session.sessionId)).toEqual([])
  })

  it('ignores corrupt records instead of failing startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arbdesk-sessions-corrupt-'))
    const store = new ExecutionSessionStore(directory)
    await store.initialize()
    await writeFile(store.getFilePath(), JSON.stringify({ version: 1, sessions: [{ sessionId: 'ok', comparisonId: 'route', status: 'STARTED', createdAt: 1, updatedAt: 1 }, null, { bad: true }] }), 'utf8')
    expect((await store.list()).map((session) => session.sessionId)).toEqual(['ok'])
  })
})
