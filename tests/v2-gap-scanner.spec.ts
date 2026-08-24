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
import { GAP_SCAN_MAX_EVENTS } from '../src/application/capture/bounded-gap-scanner.js'

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

function turnWithoutRoute(startSeq: number, turnNumber: number): DshSessionEvent[] {
  return [
    { type: 'turn/start', seq: startSeq, time: CREATED_AT + startSeq, data: { turn: turnNumber } },
    {
      type: 'user/message', seq: startSeq + 1, time: CREATED_AT + startSeq + 1,
      data: {
        id: `user-${turnNumber}`,
        source: { kind: 'user' },
        content: [{ type: 'text', text: '把这个流程保存成 Skill。' }],
      },
    },
    {
      type: 'assistant/message', seq: startSeq + 2, time: CREATED_AT + startSeq + 2,
      data: {
        turn: turnNumber,
        message: {
          id: `assistant-${turnNumber}`, role: 'assistant', source: { kind: 'assistant' },
          content: [{ type: 'text', text: '已确认交给 Run2Skill。' }],
        },
      },
    },
    {
      type: 'turn/end', seq: startSeq + 3, time: CREATED_AT + startSeq + 3,
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

  it('normalizes storage-domain lifecycle errors before recording runtime health', async () => {
    const persisted = persistenceFixture([])
    const domain = createMemoryRun2skillV2Domain()
    const notices = new RuntimeNotices({ now: () => CREATED_AT + 200 })
    vi.spyOn(domain.global, 'get').mockImplementation(() => {
      throw new Error("domain 'run2skill_v2' is closed")
    })
    const scanner = new DshV2GapScanner(
      new DshSessionGapReader(persisted),
      domain,
      { observeTurn: async () => ({ status: 'OBSERVED' }) },
      { resolve: async () => ({ status: 'UNAVAILABLE' }) },
      notices,
    )

    await expect(scanner.ensureActivated()).resolves.toMatchObject({
      status: 'UNAVAILABLE',
      healthCode: 'V2_ACTIVATION_UNAVAILABLE',
    })
    expect(notices.list()).toContainEqual(expect.objectContaining({
      healthCode: 'V2_ACTIVATION_UNAVAILABLE',
      sessionId: 'global',
    }))
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
    const observeTurn = vi.fn(async (
      _header: DshSessionHeader,
      _events: readonly DshSessionEvent[],
      turnEndSeq: number,
      _workspace: unknown,
      recovery: { readonly headerRevision: string; readonly observedLogPrefixDigest: string },
      _inheritedRoute?: unknown,
    ) => {
      const global = domain.global.get()
      await domain.global.set({
        ...global,
        sessions: {
          ...global.sessions,
          [lifecycleKey()]: {
            ...global.sessions[lifecycleKey()]!,
            observedThroughTurnEndSeq: turnEndSeq,
            ...recovery,
            updatedAt: new Date(CREATED_AT + 200).toISOString(),
          },
        },
      })
      return { status: 'OBSERVED' as const }
    })
    const sink = {
      prepareSessionWindow,
      observeTurn,
    }
    const scanner = new DshV2GapScanner(reader, domain, sink, {
      resolve: async () => ({ status: 'BOUND', workspaceId: 'workspace-1', canonicalPath: 'D:\\workspace' }),
    }, new RuntimeNotices({ now: () => CREATED_AT + 200 }), {
      now: () => CREATED_AT + 200,
      heapUsed: () => 100,
    })

    await expect(scanner.scanBatch()).resolves.toMatchObject({
      status: 'COMPLETE', processedSessions: 1, processedEvents: 5,
    })
    expect(persisted.readCalls).toEqual([0])
    expect(prepareSessionWindow).not.toHaveBeenCalled()
    expect(observeTurn).toHaveBeenCalledTimes(1)
    expect(observeTurn).toHaveBeenCalledWith(
      header(), turn(5, 1), 9, expect.any(Object), {
        headerRevision: 'rev-2',
        observedLogPrefixDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      }, expect.objectContaining({
        requestHeaderSeq: 6,
        provider: 'deepseek-official',
        model: 'deepseek-chat',
        complete: true,
      }),
    )

    await expect(scanner.scanBatch()).resolves.toMatchObject({ status: 'COMPLETE' })
    expect(observeTurn).toHaveBeenCalledTimes(1)
    expect(persisted.readCalls.at(-1)).toBe(10)
  })

  it('inherits the latest request route when a later Turn omits request/header', async () => {
    const persisted = persistenceFixture(turn(0, 0))
    const domain = createMemoryRun2skillV2Domain()
    const reader = new DshSessionGapReader(persisted)
    await activateFreshRun2skillV2(domain, reader, {
      now: () => new Date(CREATED_AT + 100).toISOString(),
    })
    persisted.events.push(...turnWithoutRoute(5, 1))
    persisted.events.push({
      type: 'request/header', seq: 9, time: CREATED_AT + 9,
      data: { header: { config: { provider: 'future-provider', model: 'future-model' } } },
    })
    persisted.revision = 'rev-2'
    persisted.readCalls.length = 0
    const observeTurn = vi.fn(async (
      _header: DshSessionHeader,
      _events: readonly DshSessionEvent[],
      turnEndSeq: number,
      _workspace: unknown,
      recovery: { readonly headerRevision: string; readonly observedLogPrefixDigest: string },
      _inheritedRoute?: unknown,
    ) => {
      const global = domain.global.get()
      await domain.global.set({
        ...global,
        sessions: {
          ...global.sessions,
          [lifecycleKey()]: {
            ...global.sessions[lifecycleKey()]!,
            observedThroughTurnEndSeq: turnEndSeq,
            ...recovery,
            updatedAt: new Date(CREATED_AT + 200).toISOString(),
          },
        },
      })
      return { status: 'OBSERVED' as const }
    })
    const scanner = new DshV2GapScanner(reader, domain, { observeTurn }, {
      resolve: async () => ({ status: 'BOUND', workspaceId: 'workspace-1', canonicalPath: 'D:\\workspace' }),
    }, new RuntimeNotices({ now: () => CREATED_AT + 200 }), {
      now: () => CREATED_AT + 200,
      heapUsed: () => 100,
    })

    await expect(scanner.scanBatch()).resolves.toMatchObject({ status: 'COMPLETE' })
    expect(persisted.readCalls).toEqual([0])
    expect(observeTurn).toHaveBeenCalledOnce()
    expect(observeTurn.mock.calls[0]?.[1].map(event => [event.seq, event.type])).toEqual([
      [5, 'turn/start'],
      [6, 'user/message'],
      [7, 'assistant/message'],
      [8, 'turn/end'],
    ])
    expect(observeTurn.mock.calls[0]?.[5]).toMatchObject({
      requestHeaderSeq: 1,
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      complete: true,
    })
  })

  it('recovers an inherited route after restart when the current revision is already pinned', async () => {
    const persisted = persistenceFixture(turn(0, 0))
    const domain = createMemoryRun2skillV2Domain()
    const reader = new DshSessionGapReader(persisted)
    await activateFreshRun2skillV2(domain, reader, {
      now: () => new Date(CREATED_AT + 100).toISOString(),
    })
    persisted.events.push(...turnWithoutRoute(5, 1))
    persisted.revision = 'rev-2'
    const before = domain.global.get()
    await domain.global.set({
      ...before,
      sessions: {
        ...before.sessions,
        [lifecycleKey()]: {
          ...before.sessions[lifecycleKey()]!,
          headerRevision: 'rev-2',
        },
      },
    })
    persisted.readCalls.length = 0
    const observeTurn = vi.fn(async (
      _header: DshSessionHeader,
      _events: readonly DshSessionEvent[],
      turnEndSeq: number,
      _workspace: unknown,
      recovery: { readonly headerRevision: string; readonly observedLogPrefixDigest: string },
      _inheritedRoute?: unknown,
    ) => {
      const global = domain.global.get()
      await domain.global.set({
        ...global,
        sessions: {
          ...global.sessions,
          [lifecycleKey()]: {
            ...global.sessions[lifecycleKey()]!,
            observedThroughTurnEndSeq: turnEndSeq,
            ...recovery,
            updatedAt: new Date(CREATED_AT + 200).toISOString(),
          },
        },
      })
      return { status: 'OBSERVED' as const }
    })
    const scanner = new DshV2GapScanner(reader, domain, { observeTurn }, {
      resolve: async () => ({ status: 'UNAVAILABLE' }),
    }, new RuntimeNotices({ now: () => CREATED_AT + 200 }), {
      now: () => CREATED_AT + 200,
      heapUsed: () => 100,
    })

    await expect(scanner.scanBatch()).resolves.toMatchObject({ status: 'COMPLETE' })
    expect(persisted.readCalls).toEqual([5, 0])
    expect(observeTurn).toHaveBeenCalledOnce()
    expect(observeTurn.mock.calls[0]?.[1].map(event => event.seq)).toEqual([5, 6, 7, 8])
    expect(observeTurn.mock.calls[0]?.[5]).toMatchObject({
      requestHeaderSeq: 1,
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      complete: true,
    })
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

  it('fails closed when a changed durable log no longer matches the committed v2 prefix', async () => {
    const persisted = persistenceFixture([...turn(0, 0), ...turn(5, 1)])
    const domain = createMemoryRun2skillV2Domain()
    const reader = new DshSessionGapReader(persisted)
    await activateFreshRun2skillV2(domain, reader, {
      now: () => new Date(CREATED_AT + 100).toISOString(),
    })
    persisted.events = [...turn(0, 0), ...turn(5, 99)]
    persisted.revision = 'rev-rewritten'
    const observeTurn = vi.fn(async () => ({ status: 'OBSERVED' as const }))
    const scanner = new DshV2GapScanner(reader, domain, {
      observeTurn,
    }, {
      resolve: async () => ({ status: 'UNAVAILABLE' }),
    }, new RuntimeNotices({ now: () => CREATED_AT + 200 }), {
      now: () => CREATED_AT + 200,
      heapUsed: () => 100,
    })

    await expect(scanner.scanBatch()).resolves.toMatchObject({
      status: 'UNAVAILABLE', healthCode: 'SESSION_LOG_ROLLBACK',
    })
    expect(observeTurn).not.toHaveBeenCalled()
  })

  it('does not report a rollback after crashing between observation and scanner bookkeeping', async () => {
    const persisted = persistenceFixture(turn(0, 0))
    const domain = createMemoryRun2skillV2Domain()
    const reader = new DshSessionGapReader(persisted)
    await activateFreshRun2skillV2(domain, reader, {
      now: () => new Date(CREATED_AT + 100).toISOString(),
    })
    persisted.events.push(...turn(5, 1))
    persisted.revision = 'rev-2'
    const observeTurn = vi.fn(async (
      _header: DshSessionHeader,
      _events: readonly DshSessionEvent[],
      turnEndSeq: number,
      _workspace: unknown,
      recovery: { readonly headerRevision: string; readonly observedLogPrefixDigest: string },
    ) => {
      const global = domain.global.get()
      await domain.global.set({
        ...global,
        sessions: {
          ...global.sessions,
          [lifecycleKey()]: {
            ...global.sessions[lifecycleKey()]!,
            observedThroughTurnEndSeq: turnEndSeq,
            ...recovery,
            updatedAt: new Date(CREATED_AT + 200).toISOString(),
          },
        },
      })
      throw new Error('synthetic crash after durable observation')
    })
    const dependencies = [
      reader,
      domain,
      { observeTurn },
      { resolve: async () => ({ status: 'UNAVAILABLE' as const }) },
      new RuntimeNotices({ now: () => CREATED_AT + 200 }),
      { now: () => CREATED_AT + 200, heapUsed: () => 100 },
    ] as const

    await expect(new DshV2GapScanner(...dependencies).scanBatch())
      .rejects.toThrow('synthetic crash after durable observation')
    await expect(new DshV2GapScanner(...dependencies).scanBatch())
      .resolves.toMatchObject({ status: 'COMPLETE' })
    expect(observeTurn).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    'rescans an unverified zero cursor left by a failed first observation (baseline complete=%s)',
    async (baselineComplete) => {
    const persisted = persistenceFixture([])
    const domain = createMemoryRun2skillV2Domain()
    const reader = new DshSessionGapReader(persisted)
    await activateFreshRun2skillV2(domain, reader, {
      now: () => new Date(CREATED_AT + 100).toISOString(),
    })
    const current = domain.global.get()
    await domain.global.set({
      ...current,
      sessions: {
        [lifecycleKey()]: {
          observedThroughTurnEndSeq: 0,
          detectedThroughTurnEndSeq: 0,
          batchManifestBaseline: {
            observedAt: new Date(CREATED_AT + 100).toISOString(),
            rootManifestDigest: 'a'.repeat(64),
            runtimeCatalogDigest: 'b'.repeat(64),
            complete: baselineComplete,
            afterTurnEndSeq: 0,
          },
          openExperienceCarry: [],
          updatedAt: new Date(CREATED_AT + 100).toISOString(),
        },
      },
    })
    persisted.events = turn(0, 0)
    persisted.readCalls.length = 0
    const observeTurn = vi.fn(async (
      _header: DshSessionHeader,
      _events: readonly DshSessionEvent[],
      turnEndSeq: number,
      _workspace: unknown,
      recovery: { readonly headerRevision: string; readonly observedLogPrefixDigest: string },
    ) => {
      const global = domain.global.get()
      await domain.global.set({
        ...global,
        sessions: {
          ...global.sessions,
          [lifecycleKey()]: {
            ...global.sessions[lifecycleKey()]!,
            observedThroughTurnEndSeq: turnEndSeq,
            ...recovery,
            updatedAt: new Date(CREATED_AT + 200).toISOString(),
          },
        },
      })
      return { status: 'OBSERVED' as const }
    })
    const scanner = new DshV2GapScanner(reader, domain, {
      observeTurn,
    }, {
      resolve: async () => ({ status: 'UNAVAILABLE' }),
    }, new RuntimeNotices({ now: () => CREATED_AT + 200 }), {
      now: () => CREATED_AT + 200,
      heapUsed: () => 100,
    })

    await expect(scanner.scanBatch()).resolves.toMatchObject({ status: 'COMPLETE' })
    expect(persisted.readCalls).toEqual([0])
    expect(observeTurn).toHaveBeenCalledTimes(1)
    expect(domain.global.get().sessions[lifecycleKey()]).toMatchObject({
      observedThroughTurnEndSeq: 4,
      headerRevision: 'rev-1',
      observedLogPrefixDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    },
  )

  it('returns MORE when the time slice ends before all changed Sessions are visited', async () => {
    const first = header('session-a')
    const second = header('session-b')
    const entries = [
      { header: first, revision: 'rev-1', events: turn(0, 0) },
      { header: second, revision: 'rev-1', events: turn(0, 0) },
    ]
    const persistence: SessionPersistencePort = {
      listSnapshots: async () => entries.map(({ header: value, revision }) => ({ header: value, revision })),
      readFrom: async (sessionId, fromSeq) => {
        const entry = entries.find(item => item.header.id === sessionId)!
        return { meta: entry.header, events: entry.events.filter(event => event.seq >= fromSeq) }
      },
    }
    const domain = createMemoryRun2skillV2Domain()
    const reader = new DshSessionGapReader(persistence)
    await activateFreshRun2skillV2(domain, reader, {
      now: () => new Date(CREATED_AT + 100).toISOString(),
    })
    entries[0]!.events.push(...turn(5, 1))
    entries[1]!.events.push(...turn(5, 1))
    entries[0]!.revision = 'rev-2'
    entries[1]!.revision = 'rev-2'
    let ticks = 0
    const observeTurn = vi.fn(async (_header: DshSessionHeader, _events: readonly DshSessionEvent[], turnEndSeq: number) => {
      const key = lifecycleKeyFor(_header)
      const global = domain.global.get()
      await domain.global.set({
        ...global,
        sessions: {
          ...global.sessions,
          [key]: { ...global.sessions[key]!, observedThroughTurnEndSeq: turnEndSeq, updatedAt: new Date(CREATED_AT + 200).toISOString() },
        },
      })
      return { status: 'OBSERVED' as const }
    })
    const scanner = new DshV2GapScanner(reader, domain, {
      observeTurn,
    }, {
      resolve: async () => ({ status: 'UNAVAILABLE' }),
    }, new RuntimeNotices({ now: () => CREATED_AT + 200 }), {
      now: () => (ticks++ === 0 ? 0 : 51),
      heapUsed: () => 100,
      activationFenceTime: 0,
    })

    await expect(scanner.scanBatch()).resolves.toMatchObject({ status: 'MORE', processedSessions: 1 })
    expect(observeTurn).toHaveBeenCalledTimes(1)
  })

  it('does not let an already-inspected end-seed tail starve a later changed Session', async () => {
    const orderedHeaders = [header('session-a'), header('session-b')]
      .sort((left, right) => lifecycleKeyFor(left).localeCompare(lifecycleKeyFor(right)))
    const first = orderedHeaders[0]!
    const second = orderedHeaders[1]!
    const entries = [
      { header: first, revision: 'rev-1', events: turn(0, 0) },
      { header: second, revision: 'rev-1', events: turn(0, 0) },
    ]
    const persistence: SessionPersistencePort = {
      listSnapshots: async () => entries.map(({ header: value, revision }) => ({ header: value, revision })),
      readFrom: async (sessionId, fromSeq) => {
        const entry = entries.find(item => item.header.id === sessionId)!
        return { meta: entry.header, events: entry.events.filter(event => event.seq >= fromSeq) }
      },
    }
    const domain = createMemoryRun2skillV2Domain()
    const reader = new DshSessionGapReader(persistence)
    await activateFreshRun2skillV2(domain, reader, {
      now: () => new Date(CREATED_AT + 100).toISOString(),
    })
    entries[0]!.events.push({
      type: 'session/end-seed', seq: 5, time: CREATED_AT + 5, data: {},
    })
    entries[1]!.events.push(...turn(5, 1))
    entries[0]!.revision = 'rev-2'
    entries[1]!.revision = 'rev-2'
    let clockCall = 0
    const observeTurn = vi.fn(async (_header: DshSessionHeader, _events: readonly DshSessionEvent[], turnEndSeq: number) => {
      const key = lifecycleKeyFor(_header)
      const global = domain.global.get()
      await domain.global.set({
        ...global,
        sessions: {
          ...global.sessions,
          [key]: {
            ...global.sessions[key]!,
            observedThroughTurnEndSeq: turnEndSeq,
            updatedAt: new Date(CREATED_AT + 200).toISOString(),
          },
        },
      })
      return { status: 'OBSERVED' as const }
    })
    const scanner = new DshV2GapScanner(reader, domain, { observeTurn }, {
      resolve: async () => ({ status: 'UNAVAILABLE' }),
    }, new RuntimeNotices({ now: () => CREATED_AT + 200 }), {
      now: () => {
        const cycle = Math.floor(clockCall / 4)
        const offset = [0, 0, 0, 51][clockCall % 4]!
        clockCall += 1
        return cycle * 100 + offset
      },
      heapUsed: () => 100,
      activationFenceTime: 0,
    })

    await expect(scanner.scanBatch()).resolves.toMatchObject({ status: 'MORE' })
    expect(observeTurn).not.toHaveBeenCalled()
    await expect(scanner.scanBatch()).resolves.toMatchObject({ status: 'COMPLETE' })
    expect(observeTurn).toHaveBeenCalledTimes(1)
    expect(observeTurn.mock.calls[0]?.[0].id).toBe(second.id)
  })

  it('drops a partial cursor when its Session disappears from durable snapshots', async () => {
    const events: DshSessionEvent[] = [
      { type: 'turn/start', seq: 0, time: CREATED_AT, data: { turn: 0 } },
      ...Array.from({ length: GAP_SCAN_MAX_EVENTS }, (_, index): DshSessionEvent => ({
        type: 'assistant/chunk', seq: index + 1, time: CREATED_AT + index + 1, data: {},
      })),
      {
        type: 'turn/end', seq: GAP_SCAN_MAX_EVENTS + 1, time: CREATED_AT + GAP_SCAN_MAX_EVENTS + 1,
        data: { turn: 0, reason: { kind: 'completed' } },
      },
    ]
    let present = false
    const persistence: SessionPersistencePort = {
      listSnapshots: async () => present ? [{ header: header(), revision: 'rev-long' }] : [],
      readFrom: async (_sessionId, fromSeq) => ({ meta: header(), events: events.filter(event => event.seq >= fromSeq) }),
    }
    const domain = createMemoryRun2skillV2Domain()
    const scanner = new DshV2GapScanner(new DshSessionGapReader(persistence), domain, {
      observeTurn: async () => ({ status: 'OBSERVED' as const }),
    }, {
      resolve: async () => ({ status: 'UNAVAILABLE' }),
    }, new RuntimeNotices({ now: () => CREATED_AT + 200 }), {
      now: () => CREATED_AT + 200,
      heapUsed: () => 100,
      activationFenceTime: CREATED_AT - 1,
    })
    await scanner.ensureActivated()
    present = true
    await expect(scanner.scanBatch()).resolves.toMatchObject({ status: 'MORE' })
    present = false
    await expect(scanner.scanBatch()).resolves.toMatchObject({
      status: 'COMPLETE', processedSessions: 0, processedEvents: 0,
    })
  })
})

function lifecycleKeyFor(value: DshSessionHeader): string {
  return deriveSessionLifecycleKey({
    rootSessionId: value.id,
    sessionCreatedAt: value.createdAt,
    sessionCwdDigest: deriveSessionCwdDigest(value.cwd),
  })
}
