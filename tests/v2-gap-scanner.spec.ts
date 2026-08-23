import { describe, expect, it, vi } from 'vitest'
import { DshSessionGapReader } from '../src/adapters/dsh-session/gap-reader.js'
import {
  DshV2GapScanner,
  activateFreshRun2skillV2,
} from '../src/adapters/dsh-session/v2-gap-scanner.js'
import type {
  DshSessionEvent,
  DshSessionHeader,
  SessionPersistencePort,
} from '../src/adapters/dsh-session/types.js'
import { RuntimeNotices } from '../src/application/capture/runtime-notices.js'
import { deriveSessionCwdDigest, deriveSessionLifecycleKey } from '../src/domain/observe/signal-key.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'

const CREATED_AT = 1_725_000_000_000

function header(id = 'session-v2'): DshSessionHeader {
  return { version: 1, id, createdAt: CREATED_AT, cwd: 'D:\\workspace' }
}

function turn(startSeq: number, turnNumber: number): DshSessionEvent[] {
  return [
    { type: 'turn/start', seq: startSeq, time: CREATED_AT + startSeq, data: { turn: turnNumber } },
    {
      type: 'request/header', seq: startSeq + 1, time: CREATED_AT + startSeq + 1,
      data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-chat' } } },
    },
    {
      type: 'user/message', seq: startSeq + 2, time: CREATED_AT + startSeq + 2,
      data: {
        id: `user-${turnNumber}`,
        source: { kind: 'user' },
        content: [{ type: 'text', text: `完成第 ${turnNumber + 1} 步。` }],
      },
    },
    {
      type: 'assistant/message', seq: startSeq + 3, time: CREATED_AT + startSeq + 3,
      data: {
        turn: turnNumber,
        message: {
          id: `assistant-${turnNumber}`, role: 'assistant', source: { kind: 'assistant' },
          content: [{ type: 'text', text: `已完成第 ${turnNumber + 1} 步。` }],
        },
      },
    },
    {
      type: 'turn/end', seq: startSeq + 4, time: CREATED_AT + startSeq + 4,
      data: { turn: turnNumber, reason: { kind: 'completed' } },
    },
  ]
}

function persistenceFixture(events: DshSessionEvent[]): SessionPersistencePort & {
  events: DshSessionEvent[]
  revision: string
  readCalls: number[]
} {
  const fixture = {
    events,
    revision: 'rev-1',
    readCalls: [] as number[],
    async listSnapshots() {
      return [{ header: header(), revision: fixture.revision }]
    },
    async readFrom(_sessionId: string, fromSeq: number) {
      fixture.readCalls.push(fromSeq)
      return { meta: header(), events: fixture.events.filter(event => event.seq >= fromSeq) }
    },
  }
  return fixture
}

function lifecycleKey(): string {
  const value = header()
  return deriveSessionLifecycleKey({
    rootSessionId: value.id,
    sessionCreatedAt: value.createdAt,
    sessionCwdDigest: deriveSessionCwdDigest(value.cwd),
  })
}

describe('DshV2GapScanner', () => {
  it('fresh activation discards old Run2Skill cache and starts after current durable Session history', async () => {
    const persisted = persistenceFixture(turn(0, 0))
    const domain = createMemoryRun2skillV2Domain()

    await expect(activateFreshRun2skillV2(
      domain,
      new DshSessionGapReader(persisted),
      { now: () => new Date(CREATED_AT + 100).toISOString() },
    )).resolves.toMatchObject({ status: 'ACTIVATED', observedSessions: 1 })

    expect(domain.global.get()).toMatchObject({
      migration: { phase: 'COMMITTED', counts: { workItems: 0, lineages: 0, activeLegacyProposals: 0 } },
      sessions: {
        [lifecycleKey()]: { observedThroughTurnEndSeq: 4, detectedThroughTurnEndSeq: 4 },
      },
      activation: {
        observerStartWatermarks: { [lifecycleKey()]: { nextSeq: 5, observedTailSeq: 4 } },
        legacyPendingCandidateCount: 0,
      },
    })
    expect(domain.turnObservations.size).toBe(0)
    expect(domain.legacyItems.size).toBe(0)
  })

  it('observes only new complete Turns and resumes from the durable v2 cursor without duplicates', async () => {
    const persisted = persistenceFixture(turn(0, 0))
    const domain = createMemoryRun2skillV2Domain()
    const reader = new DshSessionGapReader(persisted)
    await activateFreshRun2skillV2(domain, reader, {
      now: () => new Date(CREATED_AT + 100).toISOString(),
    })
    persisted.events.push(...turn(5, 1))
    persisted.revision = 'rev-2'
    persisted.readCalls.length = 0
    const prepareSessionWindow = vi.fn(async () => undefined)
    const observeTurn = vi.fn(async (_header: DshSessionHeader, _events: readonly DshSessionEvent[], turnEndSeq: number) => {
      const global = domain.global.get()
      await domain.global.set({
        ...global,
        sessions: {
          ...global.sessions,
          [lifecycleKey()]: {
            ...global.sessions[lifecycleKey()]!,
            observedThroughTurnEndSeq: turnEndSeq,
            updatedAt: new Date(CREATED_AT + 200).toISOString(),
          },
        },
      })
      return { status: 'OBSERVED' as const }
    })
    const scanner = new DshV2GapScanner(reader, domain, {
      prepareSessionWindow,
      observeTurn,
    }, {
      resolve: async () => ({ status: 'BOUND', workspaceId: 'workspace-1', canonicalPath: 'D:\\workspace' }),
    }, new RuntimeNotices({ now: () => CREATED_AT + 200 }), {
      now: () => CREATED_AT + 200,
      heapUsed: () => 100,
    })

    await expect(scanner.scanBatch()).resolves.toMatchObject({
      status: 'COMPLETE', processedSessions: 1, processedEvents: 5,
    })
    expect(persisted.readCalls).toEqual([5])
    expect(prepareSessionWindow).toHaveBeenCalledTimes(1)
    expect(observeTurn).toHaveBeenCalledTimes(1)
    expect(observeTurn).toHaveBeenCalledWith(
      header(), turn(5, 1), 9, expect.any(Object),
    )

    await expect(scanner.scanBatch()).resolves.toMatchObject({ status: 'COMPLETE' })
    expect(observeTurn).toHaveBeenCalledTimes(1)
    expect(persisted.readCalls.at(-1)).toBe(10)
  })

  it('fails closed when durable Session history cannot be read', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const persistence: SessionPersistencePort = {
      listSnapshots: async () => [{ header: header(), revision: 'rev-1' }],
      readFrom: async () => { throw new Error('offline') },
    }

    await expect(activateFreshRun2skillV2(
      domain,
      new DshSessionGapReader(persistence),
    )).rejects.toThrow('SESSION_LOG_UNAVAILABLE')
    expect(domain.global.get().migration.phase).toBe('NOT_STARTED')
  })

  it('accepts a closed seeded Session tail but delays activation for an open Turn', async () => {
    const seeded = persistenceFixture([
      ...turn(0, 0),
      { type: 'session/end-seed', seq: 5, time: CREATED_AT + 5, data: {} },
      { type: 'todo/write', seq: 6, time: CREATED_AT + 6, data: { todos: [] } },
    ])
    const activated = createMemoryRun2skillV2Domain()
    await expect(activateFreshRun2skillV2(
      activated,
      new DshSessionGapReader(seeded),
      { now: () => new Date(CREATED_AT + 100).toISOString() },
    )).resolves.toMatchObject({ status: 'ACTIVATED' })
    expect(activated.global.get().sessions[lifecycleKey()]).toMatchObject({
      observedThroughTurnEndSeq: 6,
      detectedThroughTurnEndSeq: 6,
    })

    const open = persistenceFixture(turn(0, 0).slice(0, -1))
    const delayed = createMemoryRun2skillV2Domain()
    await expect(activateFreshRun2skillV2(
      delayed,
      new DshSessionGapReader(open),
    )).rejects.toThrow('SESSION_NOT_QUIESCENT')
    expect(delayed.global.get().migration.phase).toBe('NOT_STARTED')
  })

  it('does not absorb a Turn that completed after the live listener fence', async () => {
    const persisted = persistenceFixture([
      ...turn(0, 0),
      ...turn(5, 1),
    ])
    const domain = createMemoryRun2skillV2Domain()
    await activateFreshRun2skillV2(domain, new DshSessionGapReader(persisted), {
      now: () => new Date(CREATED_AT + 100).toISOString(),
      activationFenceTime: CREATED_AT + 5,
    })

    expect(domain.global.get().sessions[lifecycleKey()]).toMatchObject({
      observedThroughTurnEndSeq: 4,
      detectedThroughTurnEndSeq: 4,
    })
  })
})
