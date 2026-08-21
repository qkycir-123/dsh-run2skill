import { describe, expect, it } from 'vitest'
import { canonicalJson } from '../src/domain/learn/identity.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import {
  deriveTurnObservationContentDigestV2,
  deriveTurnObservationIdV2,
  type TurnObservationV2,
} from '../src/domain/v2/index.js'
import {
  SessionBatchCoordinator,
  SessionBatchIdentityConflictError,
} from '../src/application/batch/index.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

const MINUTE = 60_000
const IDLE = 30 * MINUTE

function observation(options: {
  seq: number
  observedAt: number
  complete?: boolean
  explicit?: boolean
}): TurnObservationV2 {
  const base = createMinimalV2Fixtures().turnObservation
  const completeness = options.complete === false ? 'INCOMPLETE' as const : 'COMPLETE' as const
  const turnInstanceDigest = sha256Utf8(`turn-${options.seq}`)
  const value = {
    ...base,
    observationId: deriveTurnObservationIdV2({
      sessionLifecycleKey: base.sessionLifecycleKey,
      turnEndSeq: options.seq,
      turnInstanceDigest,
    }),
    turn: options.seq,
    turnEndSeq: options.seq,
    turnInstanceDigest,
    observedAt: new Date(options.observedAt).toISOString(),
    assistantOutcomeSummary: `outcome-${options.seq}`,
    explicitSaveRequested: options.explicit ?? false,
    completeness,
    directUserEvidence: completeness === 'COMPLETE' ? base.directUserEvidence : [],
    evidenceDigest: completeness === 'COMPLETE'
      ? base.evidenceDigest
      : sha256Utf8(canonicalJson([])),
  }
  return {
    ...value,
    contentDigest: deriveTurnObservationContentDigestV2(value),
  }
}

function context() {
  return {
    batchManifestBaseline: {
      observedAt: '2026-08-22T00:00:00.000Z',
      rootManifestDigest: '1'.repeat(64),
      runtimeCatalogDigest: '2'.repeat(64),
      complete: true,
    },
    routeSnapshot: {
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      policyVersion: 'batch-detector-v1',
      maxInputBytes: 128 * 1024,
      maxOutputBytes: 8 * 1024,
    },
  }
}

describe('v2 SessionBatch coordinator', () => {
  it('persists ordinary turns without a model claim and freezes exactly at the fifth complete turn', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const coordinator = new SessionBatchCoordinator(domain, { freezeContext: async () => context() })
    let latest
    for (let index = 1; index <= 5; index += 1) {
      latest = await coordinator.recordObservation(observation({ seq: index * 10, observedAt: index * MINUTE }))
      expect(latest.batchChanged).toBe(index === 5)
    }
    expect(domain.turnObservations.size).toBe(5)
    expect(domain.sessionBatches.size).toBe(1)
    expect(latest?.batch).toMatchObject({
      firstTurnEndSeq: 10,
      lastTurnEndSeq: 50,
      triggerReasons: ['THRESHOLD'],
      state: 'FROZEN',
      detector: { result: 'NOT_RUN', calls: [] },
    })
  })

  it('freezes explicit save immediately and merges simultaneous threshold reason into one deterministic batch', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const coordinator = new SessionBatchCoordinator(domain, { freezeContext: async () => context() })
    for (let index = 1; index < 5; index += 1) {
      await coordinator.recordObservation(observation({ seq: index, observedAt: index * MINUTE }))
    }
    const result = await coordinator.recordObservation(observation({ seq: 5, observedAt: 5 * MINUTE, explicit: true }))
    expect(result.batch?.triggerReasons).toEqual(['EXPLICIT', 'THRESHOLD'])
    expect(domain.sessionBatches.size).toBe(1)
    const replay = await coordinator.recordObservation(observation({ seq: 5, observedAt: 5 * MINUTE, explicit: true }))
    expect(replay.observationChanged).toBe(false)
    expect(replay.batchChanged).toBe(false)
    expect(domain.sessionBatches.size).toBe(1)
  })

  it('uses the durable last activity for idle flush and stale timer wakeups cannot freeze a newer session tail', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const coordinator = new SessionBatchCoordinator(domain, { freezeContext: async () => context() })
    await coordinator.recordObservation(observation({ seq: 10, observedAt: 0 }))
    expect(coordinator.nextIdleAt()).toBe(IDLE)
    await coordinator.recordObservation(observation({ seq: 20, observedAt: IDLE - 1 }))
    expect(await coordinator.flushIdle(IDLE)).toEqual([])
    expect(domain.sessionBatches.size).toBe(0)
    const frozen = await coordinator.flushIdle((IDLE - 1) + IDLE)
    expect(frozen).toHaveLength(1)
    expect(frozen[0]).toMatchObject({ firstTurnEndSeq: 10, lastTurnEndSeq: 20, triggerReasons: ['IDLE'] })
  })

  it('does not count incomplete turns as threshold progress or skip them out of a later frozen range', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const coordinator = new SessionBatchCoordinator(domain, { freezeContext: async () => context() })
    for (let index = 1; index <= 4; index += 1) {
      await coordinator.recordObservation(observation({ seq: index, observedAt: index, complete: index !== 3 }))
    }
    expect(domain.sessionBatches.size).toBe(0)
    await coordinator.recordObservation(observation({ seq: 5, observedAt: 5 }))
    expect(domain.sessionBatches.size).toBe(0)
    const result = await coordinator.recordObservation(observation({ seq: 6, observedAt: 6 }))
    expect(result.batch?.observationManifest.map(entry => entry.completeness))
      .toEqual(['COMPLETE', 'COMPLETE', 'INCOMPLETE', 'COMPLETE', 'COMPLETE', 'COMPLETE'])
  })

  it('recovers an idle durable tail once and reattaches a batch written before the cursor update', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const first = new SessionBatchCoordinator(domain, { freezeContext: async () => context() })
    for (let index = 1; index <= 3; index += 1) {
      await first.recordObservation(observation({ seq: index, observedAt: index * MINUTE }))
    }
    const recovered = new SessionBatchCoordinator(domain, { freezeContext: async () => context() })
    expect(await recovered.recover(40 * MINUTE)).toHaveLength(1)
    expect(await recovered.recover(40 * MINUTE)).toHaveLength(0)

    const batch = [...domain.sessionBatches.values()][0]!
    const global = domain.global.get()
    await domain.global.set({
      ...global,
      sessions: {
        ...global.sessions,
        [batch.sessionLifecycleKey]: {
          ...global.sessions[batch.sessionLifecycleKey]!,
          activeBatchId: undefined,
        },
      },
    })
    const reattached = new SessionBatchCoordinator(domain, { freezeContext: async () => context() })
    await reattached.recover(40 * MINUTE)
    expect(domain.global.get().sessions[batch.sessionLifecycleKey]?.activeBatchId).toBe(batch.batchId)
    expect(domain.sessionBatches.size).toBe(1)
  })

  it('coalesces concurrent startup recovery so a frozen batch is dispatched once', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const first = new SessionBatchCoordinator(domain, { freezeContext: async () => context() })
    await first.recordObservation(observation({ seq: 1, observedAt: 0 }))
    const recovered = new SessionBatchCoordinator(domain, { freezeContext: async () => context() })
    const [left, right] = await Promise.all([
      recovered.recover(40 * MINUTE),
      recovered.recover(40 * MINUTE),
    ])
    expect([...left, ...right]).toHaveLength(1)
    expect(domain.sessionBatches.size).toBe(1)
  })

  it('rejects changed facts at an existing observation identity', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const coordinator = new SessionBatchCoordinator(domain, { freezeContext: async () => context() })
    const original = observation({ seq: 10, observedAt: 0 })
    await coordinator.recordObservation(original)
    await expect(coordinator.recordObservation({
      ...original,
      assistantOutcomeSummary: 'forged without changing identity',
      contentDigest: original.contentDigest,
    })).rejects.toBeInstanceOf(SessionBatchIdentityConflictError)
  })
})
