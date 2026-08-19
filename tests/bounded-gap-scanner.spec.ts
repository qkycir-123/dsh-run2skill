import { describe, expect, it, vi } from 'vitest'
import { DshSessionGapReader } from '../src/adapters/dsh-session/gap-reader.js'
import type {
  DshSessionEvent,
  DshSessionHeader,
  SessionPersistencePort,
} from '../src/adapters/dsh-session/types.js'
import {
  BoundedGapScanner,
  GAP_SCAN_MAX_EVENTS,
  GAP_SCAN_MAX_SESSIONS,
} from '../src/application/capture/bounded-gap-scanner.js'
import { RuntimeNotices } from '../src/application/capture/runtime-notices.js'
import { WriteBehindCheckpoint } from '../src/application/capture/write-behind-checkpoint.js'
import { deriveSessionLifecycleKeyFromFacts } from '../src/domain/observe/identity.js'
import { deriveSessionCwdDigest } from '../src/domain/observe/signal-key.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'

function header(id: string, createdAt = 1_000): DshSessionHeader {
  return { version: 0, id, createdAt }
}

function turn(startSeq: number, turnNumber: number): DshSessionEvent[] {
  return [
    { type: 'turn/start', seq: startSeq, time: 10_000 + startSeq, data: { turn: turnNumber } },
    {
      type: 'user/message',
      seq: startSeq + 1,
      time: 10_001 + startSeq,
      data: { id: `message-${startSeq}`, source: { kind: 'user' }, content: [] },
    },
    {
      type: 'turn/end',
      seq: startSeq + 2,
      time: 10_002 + startSeq,
      data: { turn: turnNumber, reason: { kind: 'completed' } },
    },
  ]
}

function persistenceFixture(initial: Array<{
  header: DshSessionHeader
  revision: string
  events: DshSessionEvent[]
}>): SessionPersistencePort & {
  entries: typeof initial
  readCalls: Array<{ sessionId: string; fromSeq: number }>
} {
  const readCalls: Array<{ sessionId: string; fromSeq: number }> = []
  return {
    entries: initial,
    readCalls,
    async listSnapshots() {
      return this.entries.map(({ header: value, revision }) => ({ header: value, revision }))
    },
    async readFrom(sessionId, fromSeq) {
      readCalls.push({ sessionId, fromSeq })
      const entry = this.entries.find(({ header: value }) => value.id === sessionId)
      if (entry === undefined) throw new Error('missing session')
      return { meta: entry.header, events: entry.events.filter((event) => event.seq >= fromSeq) }
    },
  }
}

describe('BoundedGapScanner', () => {
  it('persists the first activation fence before ignoring existing history', async () => {
    const persisted = persistenceFixture([{
      header: header('session-a'), revision: 'rev-1', events: turn(0, 0),
    }])
    const domain = createMemoryRun2skillDomain()
    const checkpoint = new WriteBehindCheckpoint(domain, { now: () => 0 })
    const processTurn = vi.fn()
    const scanner = new BoundedGapScanner(
      new DshSessionGapReader(persisted),
      checkpoint,
      { processTurn },
      new RuntimeNotices({ now: () => 0 }),
      { now: () => 0, heapUsed: () => 100 },
    )

    const result = await scanner.ensureActivated()

    expect(result).toMatchObject({ status: 'COMPLETE', processedSessions: 1, processedEvents: 3 })
    expect(processTurn).not.toHaveBeenCalled()
    const stored = Object.values(domain.global.get().sessions)[0]
    expect(stored).toMatchObject({
      rootSessionId: 'session-a',
      activationFenceSeq: 3,
      durableNextSeq: 3,
      observedTailSeq: 2,
      headerRevision: 'rev-1',
    })
  })

  it('skips unchanged revisions and processes only new complete turns', async () => {
    const persisted = persistenceFixture([{
      header: header('session-a'), revision: 'rev-1', events: turn(0, 0),
    }])
    const domain = createMemoryRun2skillDomain()
    const checkpoint = new WriteBehindCheckpoint(domain, { now: () => 0 })
    const processTurn = vi.fn(async ({ progress }) => {
      await checkpoint.observeCompletedRoot(progress)
    })
    const scanner = new BoundedGapScanner(
      new DshSessionGapReader(persisted),
      checkpoint,
      { processTurn },
      new RuntimeNotices({ now: () => 0 }),
      { now: () => 0, heapUsed: () => 100 },
    )
    await scanner.ensureActivated()
    persisted.readCalls.length = 0

    await expect(scanner.scanBatch()).resolves.toMatchObject({
      status: 'COMPLETE', processedSessions: 0, processedEvents: 0,
    })
    expect(persisted.readCalls).toEqual([])

    persisted.entries[0] = {
      header: header('session-a'),
      revision: 'rev-2',
      events: [...turn(0, 0), ...turn(3, 1)],
    }
    await expect(scanner.scanBatch()).resolves.toMatchObject({
      status: 'COMPLETE', processedSessions: 1, processedEvents: 3,
    })

    expect(processTurn).toHaveBeenCalledTimes(1)
    expect(processTurn.mock.calls[0]?.[0]).toMatchObject({
      turnEndSeq: 5,
      progress: { durableNextSeq: 6, observedTailSeq: 5, headerRevision: 'rev-2' },
    })
    expect(persisted.readCalls).toEqual([{ sessionId: 'session-a', fromSeq: 0 }])
    expect(domain.global.get().recovery).toEqual({ recoveryLag: false })
  })

  it('stops one batch at 64 changed sessions and resumes from a durable cursor', async () => {
    const entries = Array.from({ length: GAP_SCAN_MAX_SESSIONS + 1 }, (_, index) => ({
      header: header(`session-${index}`, 1_000 + index),
      revision: 'rev-1',
      events: turn(0, 0),
    }))
    const persisted = persistenceFixture(entries)
    const domain = createMemoryRun2skillDomain()
    const checkpoint = new WriteBehindCheckpoint(domain, { now: () => 0 })
    await checkpoint.activate([])
    const scanner = new BoundedGapScanner(
      new DshSessionGapReader(persisted),
      checkpoint,
      { processTurn: async ({ progress }) => checkpoint.observeCompletedRoot(progress) },
      new RuntimeNotices({ now: () => 0 }),
      { now: () => 0, heapUsed: () => 100 },
    )

    const first = await scanner.scanBatch()
    expect(first).toMatchObject({
      status: 'MORE', processedSessions: GAP_SCAN_MAX_SESSIONS,
    })
    expect(first.processedEvents).toBeLessThanOrEqual(GAP_SCAN_MAX_EVENTS)
    expect(domain.global.get().recovery.recoveryLag).toBe(true)

    await expect(scanner.scanBatch()).resolves.toMatchObject({
      status: 'COMPLETE', processedSessions: 1,
    })
    expect(domain.global.get().recovery).toEqual({ recoveryLag: false })
  })

  it('rolls an advanced watermark back to the current durable tail', async () => {
    const storedHeader = header('session-a')
    const digest = deriveSessionCwdDigest(storedHeader.cwd)
    const session = {
      rootSessionId: storedHeader.id,
      sessionCreatedAt: storedHeader.createdAt,
      sessionCwdDigest: digest,
      triggerPolicyVersion: 'cheap-trigger-v1' as const,
      activationFenceSeq: 0,
      durableNextSeq: 6,
      observedTailSeq: 5,
      headerRevision: 'rev-1',
    }
    const persisted = persistenceFixture([{
      header: storedHeader, revision: 'rev-2', events: turn(0, 0),
    }])
    const domain = createMemoryRun2skillDomain()
    const checkpoint = new WriteBehindCheckpoint(domain, { now: () => 0 })
    await checkpoint.activate([session])
    const scanner = new BoundedGapScanner(
      new DshSessionGapReader(persisted),
      checkpoint,
      { processTurn: async ({ progress }) => checkpoint.observeCompletedRoot(progress) },
      new RuntimeNotices({ now: () => 0 }),
      { now: () => 0, heapUsed: () => 100 },
    )

    await expect(scanner.scanBatch()).resolves.toMatchObject({ status: 'COMPLETE' })

    const lifecycleKey = deriveSessionLifecycleKeyFromFacts(session)
    expect(domain.global.get().sessions[lifecycleKey]?.durableNextSeq).toBe(3)
    expect(domain.global.get().health.lastCode).toBe('SESSION_LOG_ROLLBACK')
  })

  it('caps one logical batch at 10,000 events and resumes the partial session', async () => {
    const events = Array.from({ length: 3_334 }, (_, index) => turn(index * 3, index)).flat()
    const persisted = persistenceFixture([{
      header: header('session-large'), revision: 'rev-large', events,
    }])
    const domain = createMemoryRun2skillDomain()
    const checkpoint = new WriteBehindCheckpoint(domain, { now: () => 0 })
    await checkpoint.activate([])
    const processTurn = vi.fn(async ({ progress }) => {
      await checkpoint.observeCompletedRoot(progress)
    })
    const scanner = new BoundedGapScanner(
      new DshSessionGapReader(persisted),
      checkpoint,
      { processTurn },
      new RuntimeNotices({ now: () => 0 }),
      { now: () => 0, heapUsed: () => 100 },
    )

    const first = await scanner.scanBatch()
    expect(first).toMatchObject({ status: 'MORE', processedEvents: GAP_SCAN_MAX_EVENTS })
    if (first.status !== 'MORE') throw new Error('expected a durable partial cursor')
    expect(first.cursor.nextSeq).toBe(9_999)

    await expect(scanner.scanBatch()).resolves.toMatchObject({
      status: 'COMPLETE', processedEvents: 3,
    })
    expect(processTurn).toHaveBeenCalledTimes(3_334)
  })

  it('keeps recovery incomplete when a durable Root identity cannot be bounded safely', async () => {
    const persisted = persistenceFixture([{
      header: header('x'.repeat(1_025)), revision: 'rev-invalid', events: turn(0, 1),
    }])
    const domain = createMemoryRun2skillDomain()
    const checkpoint = new WriteBehindCheckpoint(domain, { now: () => 0 })
    const notices = new RuntimeNotices({ now: () => 0 })
    const scanner = new BoundedGapScanner(
      new DshSessionGapReader(persisted),
      checkpoint,
      { processTurn: async () => undefined },
      notices,
      { now: () => 0, heapUsed: () => 100 },
    )

    await expect(scanner.ensureActivated()).resolves.toMatchObject({
      status: 'UNAVAILABLE', healthCode: 'ROOT_IDENTITY_UNAVAILABLE',
    })
    expect(domain.global.get().lastSuccessfulStoreWriteAt).toBeUndefined()
    expect(notices.list()).toContainEqual(expect.objectContaining({
      healthCode: 'ROOT_IDENTITY_UNAVAILABLE',
    }))
  })
})
