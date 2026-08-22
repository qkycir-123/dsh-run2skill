import { describe, expect, it } from 'vitest'
import { canonicalJson } from '../src/domain/learn/identity.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import {
  deriveTurnObservationContentDigestV2,
  deriveTurnObservationIdV2,
  type SessionBatchV2,
  type TurnObservationV2,
} from '../src/domain/v2/index.js'
import {
  SessionBatchCoordinator,
  SessionBatchIdentityConflictError,
} from '../src/application/batch/index.js'
import { DshV2RouteSnapshotAdapter } from '../src/adapters/dsh-llm/v2-route-snapshot.js'
import type { DshLlmPort } from '../src/adapters/dsh-llm/restricted-learning-client.js'
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

function coordinatorOptions(overrides?: {
  readonly captureBaseline?: () => Promise<ReturnType<typeof context>['batchManifestBaseline']>
  readonly captureRouteSnapshot?: (
    sessionLifecycleKey: string,
    observations: readonly TurnObservationV2[],
  ) => Promise<SessionBatchV2['routeSnapshot']>
}) {
  return {
    captureBaseline: overrides?.captureBaseline ?? (async () => context().batchManifestBaseline),
    captureRouteSnapshot: overrides?.captureRouteSnapshot ?? (async () => context().routeSnapshot),
  }
}

describe('v2 SessionBatch coordinator', () => {
  it('persists ordinary turns without a model claim and freezes exactly at the fifth complete turn', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const coordinator = new SessionBatchCoordinator(domain, coordinatorOptions())
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
    const coordinator = new SessionBatchCoordinator(domain, coordinatorOptions())
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
    const coordinator = new SessionBatchCoordinator(domain, coordinatorOptions())
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
    const coordinator = new SessionBatchCoordinator(domain, coordinatorOptions())
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
    const first = new SessionBatchCoordinator(domain, coordinatorOptions())
    for (let index = 1; index <= 3; index += 1) {
      await first.recordObservation(observation({ seq: index, observedAt: index * MINUTE }))
    }
    const recovered = new SessionBatchCoordinator(domain, coordinatorOptions())
    await recovered.recover(40 * MINUTE)
    await recovered.recover(40 * MINUTE)
    expect(domain.sessionBatches.size).toBe(1)

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
    const reattached = new SessionBatchCoordinator(domain, coordinatorOptions())
    await reattached.recover(40 * MINUTE)
    expect(domain.global.get().sessions[batch.sessionLifecycleKey]?.activeBatchId).toBe(batch.batchId)
    expect(domain.sessionBatches.size).toBe(1)
  })

  it('coalesces concurrent startup recovery so a frozen batch is dispatched once', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const first = new SessionBatchCoordinator(domain, coordinatorOptions())
    await first.recordObservation(observation({ seq: 1, observedAt: 0 }))
    const recovered = new SessionBatchCoordinator(domain, coordinatorOptions())
    await Promise.all([
      recovered.recover(40 * MINUTE),
      recovered.recover(40 * MINUTE),
    ])
    expect(domain.sessionBatches.size).toBe(1)
  })

  it('durably captures the batch baseline before the first Agent turn and never refreshes it at freeze', async () => {
    const domain = createMemoryRun2skillV2Domain()
    let digest = '1'.repeat(64)
    const coordinator = new SessionBatchCoordinator(domain, coordinatorOptions({
      captureBaseline: async () => ({ ...context().batchManifestBaseline, rootManifestDigest: digest }),
    }))
    await coordinator.prepareSessionWindow(createMinimalV2Fixtures().turnObservation.sessionLifecycleKey)
    digest = '2'.repeat(64)
    for (let index = 1; index <= 5; index += 1) {
      await coordinator.recordObservation(observation({ seq: index, observedAt: index }))
    }
    expect([...domain.sessionBatches.values()][0]?.batchManifestBaseline.rootManifestDigest).toBe('1'.repeat(64))
  })

  it('marks a late baseline incomplete when activation missed the pre-turn boundary', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const coordinator = new SessionBatchCoordinator(domain, coordinatorOptions())
    for (let index = 1; index <= 5; index += 1) {
      await coordinator.recordObservation(observation({ seq: index, observedAt: index }))
    }
    expect([...domain.sessionBatches.values()][0]?.batchManifestBaseline.complete).toBe(false)
  })

  it('commits route-unavailable attention without blocking later observations', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const blocked: DshLlmPort = {
      resolveModelInfo: async () => await new Promise<never>(() => undefined),
      stream: async function * () { yield* [] },
    }
    const route = new DshV2RouteSnapshotAdapter(blocked, { internalTimeoutMs: 5 })
    const coordinator = new SessionBatchCoordinator(domain, coordinatorOptions({
      captureRouteSnapshot: (lifecycleKey, observations) => route.capture(lifecycleKey, observations),
    }))
    for (let index = 1; index <= 5; index += 1) {
      await expect(coordinator.recordObservation(observation({ seq: index, observedAt: index }))).resolves.toBeDefined()
    }

    expect(domain.turnObservations.size).toBe(5)
    const batch = [...domain.sessionBatches.values()][0]
    expect(batch).toMatchObject({
      state: 'NEEDS_ATTENTION',
      routeSnapshot: { failureCode: 'ROUTE_UNAVAILABLE' },
      detector: { result: 'NEEDS_ATTENTION', failureCode: 'ROUTE_UNAVAILABLE', calls: [] },
    })
    const lifecycleKey = observation({ seq: 1, observedAt: 1 }).sessionLifecycleKey
    expect(domain.global.get().sessions[lifecycleKey]?.detectedThroughTurnEndSeq).toBe(5)
    expect(domain.global.get().sessions[lifecycleKey]?.activeBatchId).toBeUndefined()

    await expect(coordinator.recordObservation(observation({ seq: 6, observedAt: 6 }))).resolves.toMatchObject({
      observationChanged: true,
      batchChanged: false,
    })
    expect(domain.turnObservations.size).toBe(6)
  })

  it('recovers a route-unavailable batch written before its cursor commit without recapturing the route', async () => {
    const domain = createMemoryRun2skillV2Domain()
    let routeCaptures = 0
    const options = coordinatorOptions({
      captureRouteSnapshot: async () => {
        routeCaptures += 1
        throw new Error('route unavailable')
      },
    })
    const coordinator = new SessionBatchCoordinator(domain, options)
    for (let index = 1; index <= 4; index += 1) {
      await coordinator.recordObservation(observation({ seq: index, observedAt: index }))
    }
    const beforeBatchCommit = domain.global.get()
    await coordinator.recordObservation(observation({ seq: 5, observedAt: 5 }))
    await domain.global.set(beforeBatchCommit)

    const recovered = new SessionBatchCoordinator(domain, options)
    await recovered.recover(5)
    const lifecycleKey = observation({ seq: 1, observedAt: 1 }).sessionLifecycleKey
    expect(routeCaptures).toBe(1)
    expect(domain.sessionBatches.size).toBe(1)
    expect(domain.global.get().sessions[lifecycleKey]?.detectedThroughTurnEndSeq).toBe(5)
    expect(domain.global.get().sessions[lifecycleKey]?.activeBatchId).toBeUndefined()
  })

  it('keeps a missing pre-turn baseline incomplete after an observation-only crash window', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const value = observation({ seq: 1, observedAt: 1 })
    await domain.table('turn_observations').put(value.observationId, value)
    const recovered = new SessionBatchCoordinator(domain, coordinatorOptions())
    await recovered.recover(1)
    const lifecycleKey = value.sessionLifecycleKey
    expect(domain.global.get().sessions[lifecycleKey]?.batchManifestBaseline).toMatchObject({
      afterTurnEndSeq: 0,
      complete: false,
    })
    expect(await recovered.prepareSessionWindow(lifecycleKey)).toBe(false)
    expect(domain.global.get().sessions[lifecycleKey]?.batchManifestBaseline?.complete).toBe(false)
  })

  it('does not reuse the consumed baseline after a batch-only crash window', async () => {
    const domain = createMemoryRun2skillV2Domain()
    let digest = '1'.repeat(64)
    const options = coordinatorOptions({
      captureBaseline: async () => ({ ...context().batchManifestBaseline, rootManifestDigest: digest }),
    })
    const first = new SessionBatchCoordinator(domain, options)
    const lifecycleKey = createMinimalV2Fixtures().turnObservation.sessionLifecycleKey
    await first.prepareSessionWindow(lifecycleKey)
    for (let index = 1; index <= 4; index += 1) {
      await first.recordObservation(observation({ seq: index, observedAt: index }))
    }
    const beforeBatchCommit = domain.global.get()
    await first.recordObservation(observation({ seq: 5, observedAt: 5 }))
    await domain.global.set(beforeBatchCommit)
    digest = '2'.repeat(64)

    const recovered = new SessionBatchCoordinator(domain, options)
    await recovered.recover(5)
    expect(domain.global.get().sessions[lifecycleKey]?.activeBatchId).toBeDefined()
    expect(domain.global.get().sessions[lifecycleKey]?.batchManifestBaseline).toBeUndefined()
    expect(await recovered.prepareSessionWindow(lifecycleKey)).toBe(true)
    expect(domain.global.get().sessions[lifecycleKey]?.batchManifestBaseline).toMatchObject({
      afterTurnEndSeq: 5,
      rootManifestDigest: '2'.repeat(64),
      complete: true,
    })
  })

  it('rejects changed facts at an existing observation identity', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const coordinator = new SessionBatchCoordinator(domain, coordinatorOptions())
    const original = observation({ seq: 10, observedAt: 0 })
    await coordinator.recordObservation(original)
    await expect(coordinator.recordObservation({
      ...original,
      assistantOutcomeSummary: 'forged without changing identity',
      contentDigest: original.contentDigest,
    })).rejects.toBeInstanceOf(SessionBatchIdentityConflictError)
  })
})
