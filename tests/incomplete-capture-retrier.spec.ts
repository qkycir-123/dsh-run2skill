import { describe, expect, it } from 'vitest'
import { DshSessionGapReader } from '../src/adapters/dsh-session/gap-reader.js'
import type { SessionPersistencePort } from '../src/adapters/dsh-session/types.js'
import { DurableCaptureStore } from '../src/adapters/dsh-storage/durable-capture-store.js'
import { IncompleteCaptureRetrier } from '../src/application/capture/incomplete-capture-retrier.js'
import { DurableCaptureCoordinator } from '../src/application/capture/durable-capture-coordinator.js'
import { RuntimeNotices } from '../src/application/capture/runtime-notices.js'
import { TurnCaptureProcessor } from '../src/application/capture/turn-capture-processor.js'
import { WriteBehindCheckpoint } from '../src/application/capture/write-behind-checkpoint.js'
import { analyzeCheapTriggerV1 } from '../src/domain/observe/trigger.js'
import { deriveSessionCwdDigest } from '../src/domain/observe/signal-key.js'
import type { SessionCheckpointV1 } from '../src/domain/observe/schemas.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'

const header = {
  version: 1,
  id: 'retry-root',
  createdAt: 1_725_000_000_000,
  cwd: 'D:/work/retry',
} as const

const events = [
  { type: 'turn/start', seq: 10, time: 1_725_000_001_000, data: { turn: 3 } },
  {
    type: 'user/message', seq: 11, time: 1_725_000_001_010,
    data: {
      id: 'message-1', source: { kind: 'user' },
      content: [{ type: 'text', text: '把这个流程保存成 Skill。' }],
    },
  },
  {
    type: 'turn/end', seq: 12, time: 1_725_000_002_000,
    data: { turn: 3, reason: { kind: 'completed' } },
  },
] as const

function progress(): SessionCheckpointV1 {
  return {
    rootSessionId: header.id,
    sessionCreatedAt: header.createdAt,
    sessionCwdDigest: deriveSessionCwdDigest(header.cwd),
    triggerPolicyVersion: 'cheap-trigger-v1',
    activationFenceSeq: 10,
    durableNextSeq: 13,
    observedTailSeq: 12,
  }
}

function persistence(): SessionPersistencePort {
  return {
    async listSnapshots() {
      return [{ header, revision: 'revision-1' }]
    },
    async readFrom(sessionId, fromSeq) {
      if (sessionId !== header.id) throw new Error('unknown session')
      return { meta: header, events: events.filter(event => event.seq >= fromSeq) }
    },
  }
}

describe('IncompleteCaptureRetrier', () => {
  it('recovers an explicit save after repeated incomplete scans and a runtime restart', async () => {
    const domain = createMemoryRun2skillDomain()
    let attempts = 0
    const analyzer: typeof analyzeCheapTriggerV1 = (messages, options) => {
      attempts += 1
      return attempts <= 4
        ? { status: 'INCOMPLETE', captureBlockers: ['REDACTION_UNAVAILABLE'], triggerHits: [], evidenceRefs: [] }
        : analyzeCheapTriggerV1(messages, options)
    }
    const notices = new RuntimeNotices()
    const checkpoint = new WriteBehindCheckpoint(domain)
    await checkpoint.activate([{ ...progress(), durableNextSeq: 10, observedTailSeq: 9 }])
    const store = new DurableCaptureStore(domain)
    const coordinator = new DurableCaptureCoordinator(store, checkpoint, notices)
    const processor = new TurnCaptureProcessor(
      coordinator,
      notices,
      { resolve: async () => ({ status: 'UNREGISTERED' }) },
      { snapshot: () => ({ automaticLearning: false }) },
      analyzer,
    )

    await processor.processTurn({ header, events, turnEndSeq: 12, progress: progress() })
    await checkpoint.setRecoveryCursor()
    expect(store.getIncomplete(64)).toHaveLength(1)

    const firstRuntime = new IncompleteCaptureRetrier(
      new DshSessionGapReader(persistence()),
      store,
      new WriteBehindCheckpoint(domain),
      processor,
      notices,
    )
    await expect(firstRuntime.retryBatch()).resolves.toMatchObject({ attempted: 1, remaining: 1 })

    const restartedCheckpoint = new WriteBehindCheckpoint(domain)
    const restartedCoordinator = new DurableCaptureCoordinator(store, restartedCheckpoint, notices)
    const restartedProcessor = new TurnCaptureProcessor(
      restartedCoordinator,
      notices,
      { resolve: async () => ({ status: 'UNREGISTERED' }) },
      { snapshot: () => ({ automaticLearning: false }) },
      analyzer,
    )
    const restartedRuntime = new IncompleteCaptureRetrier(
      new DshSessionGapReader(persistence()),
      store,
      restartedCheckpoint,
      restartedProcessor,
      notices,
    )

    await expect(restartedRuntime.retryBatch()).resolves.toMatchObject({ attempted: 1, remaining: 0 })
    expect([...domain.table('work_items').entries()][0]?.[1]).toMatchObject({
      scanStatus: 'COMPLETE',
      processingState: 'CAPTURED',
    })
    expect([...domain.table('work_items').entries()][0]?.[1].triggerHits)
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'EXPLICIT_SAVE' })]))
  })

  it('resolves an incomplete ordinary signal without learning when policy is OFF', async () => {
    const domain = createMemoryRun2skillDomain()
    let attempts = 0
    const analyzer: typeof analyzeCheapTriggerV1 = (messages, options) => {
      attempts += 1
      return attempts <= 2
        ? { status: 'INCOMPLETE', captureBlockers: ['REDACTION_UNAVAILABLE'], triggerHits: [], evidenceRefs: [] }
        : analyzeCheapTriggerV1(messages, options)
    }
    const ordinaryEvents = events.map(event => event.seq !== 11 ? event : ({
      ...event,
      data: {
        id: 'message-1', source: { kind: 'user' },
        content: [{ type: 'text', text: '这个项目以后必须统一使用 pnpm。' }],
      },
    }))
    const notices = new RuntimeNotices()
    const checkpoint = new WriteBehindCheckpoint(domain)
    await checkpoint.activate([{ ...progress(), durableNextSeq: 10, observedTailSeq: 9 }])
    const store = new DurableCaptureStore(domain)
    const coordinator = new DurableCaptureCoordinator(store, checkpoint, notices)
    const processor = new TurnCaptureProcessor(
      coordinator,
      notices,
      { resolve: async () => ({ status: 'UNREGISTERED' }) },
      { snapshot: () => ({ automaticLearning: false }) },
      analyzer,
    )
    const reader = new DshSessionGapReader({
      ...persistence(),
      async readFrom(sessionId, fromSeq) {
        if (sessionId !== header.id) throw new Error('unknown session')
        return { meta: header, events: ordinaryEvents.filter(event => event.seq >= fromSeq) }
      },
    })

    await processor.processTurn({ header, events: ordinaryEvents, turnEndSeq: 12, progress: progress() })
    const retrier = new IncompleteCaptureRetrier(reader, store, checkpoint, processor, notices)
    await retrier.retryBatch()

    expect([...domain.table('work_items').entries()][0]?.[1]).toMatchObject({
      scanStatus: 'COMPLETE', processingState: 'RESOLVED_NO_SIGNAL', triggerHits: [],
    })
  })
})
