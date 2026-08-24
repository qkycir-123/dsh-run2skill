import { describe, expect, it } from 'vitest'
import {
  SessionQuiescenceCoordinator,
  type SessionActivityObservationPort,
} from '../src/application/quiescence/index.js'
import {
  ExperienceIntentV2Schema,
  SessionBatchV2Schema,
  deriveSessionQuiescenceFenceDigestV2,
} from '../src/domain/v2/index.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

const BASE = Date.parse('2026-08-22T00:00:00.000Z')
const IDLE_MS = 30 * 60 * 1000

function activity(initial = {
  complete: true,
  activeAgent: false,
  activityRevision: 'process-a:4',
  durableLatestTurnEndSeq: 8,
  durableOpenTurn: false,
}) {
  let current = initial
  const port: SessionActivityObservationPort & { set(value: typeof initial): void } = {
    observe: async () => ({ ...current }),
    set(value) { current = value },
  }
  return port
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

async function seedWaiting(options: { explicit?: boolean; lastActivityAt?: string } = {}) {
  const domain = createMemoryRun2skillV2Domain()
  const fixture = createMinimalV2Fixtures()
  const batch = SessionBatchV2Schema.parse({
    ...fixture.sessionBatch,
    revision: 2,
    triggerReasons: options.explicit === false ? ['THRESHOLD'] : ['EXPLICIT'],
    detector: {
      result: 'READY',
      calls: [{
        stage: 'DETECTION', callId: `call_${'3'.repeat(64)}`, ordinal: 1,
        inputDigest: '4'.repeat(64), provider: fixture.sessionBatch.routeSnapshot.provider,
        model: fixture.sessionBatch.routeSnapshot.model,
        policyVersion: fixture.sessionBatch.routeSnapshot.policyVersion,
        outcome: 'SUCCEEDED', outputDigest: '5'.repeat(64),
      }],
      intentIds: [fixture.experienceIntent.intentId], carry: [],
    },
    state: 'COMMITTED_READY',
  })
  const intent = ExperienceIntentV2Schema.parse({
    ...fixture.experienceIntent,
    explicitSave: options.explicit !== false,
    quiescence: {
      state: 'WAITING',
      batchLastTurnEndSeq: batch.lastTurnEndSeq,
      requiredIdleMs: IDLE_MS,
    },
    status: 'WAITING_FOR_QUIESCENCE',
  })
  await domain.table('session_batches').put(batch.batchId, batch)
  await domain.table('experience_intents').put(intent.intentId, intent)
  const global = domain.global.get()
  await domain.global.set({
    ...global,
    sessions: {
      [batch.sessionLifecycleKey]: {
        observedThroughTurnEndSeq: batch.lastTurnEndSeq,
        detectedThroughTurnEndSeq: batch.lastTurnEndSeq,
        lastActivityAt: options.lastActivityAt ?? new Date(BASE).toISOString(),
        openExperienceCarry: [],
        updatedAt: new Date(BASE).toISOString(),
      },
    },
  })
  return { domain, batch, intent }
}

describe('v2 Session quiescence fence', () => {
  it('keeps a threshold READY Intent waiting until 30 minutes of idle', async () => {
    const seeded = await seedWaiting({ explicit: false })
    const port = activity()
    const early = new SessionQuiescenceCoordinator(seeded.domain, { activity: port, now: () => BASE + IDLE_MS - 1 })

    expect(await early.runOnce()).toBe('IDLE')
    expect(seeded.domain.experienceIntents.get(seeded.intent.intentId)?.status).toBe('WAITING_FOR_QUIESCENCE')

    const ready = new SessionQuiescenceCoordinator(seeded.domain, { activity: port, now: () => BASE + IDLE_MS })
    expect(await ready.runOnce()).toBe('PROCESSED')
    expect(seeded.domain.experienceIntents.get(seeded.intent.intentId)).toMatchObject({
      status: 'READY',
      quiescence: {
        state: 'SATISFIED', observedThroughTurnEndSeq: seeded.batch.lastTurnEndSeq,
        detectedThroughTurnEndSeq: seeded.batch.lastTurnEndSeq, activityRevision: 'process-a:4',
      },
    })
  })

  it('releases an explicit save immediately after its Turn when no Agent is active', async () => {
    const seeded = await seedWaiting({ explicit: true, lastActivityAt: new Date(BASE).toISOString() })
    const worker = new SessionQuiescenceCoordinator(seeded.domain, { activity: activity(), now: () => BASE + 1 })
    expect(await worker.runOnce()).toBe('PROCESSED')
    expect(seeded.domain.experienceIntents.get(seeded.intent.intentId)?.status).toBe('READY')
  })

  it('does not release while an Agent is active or any newer Turn has appeared', async () => {
    const seeded = await seedWaiting({ explicit: false })
    const port = activity({
      complete: true, activeAgent: true, activityRevision: 'process-a:5',
      durableLatestTurnEndSeq: 8, durableOpenTurn: false,
    })
    const worker = new SessionQuiescenceCoordinator(seeded.domain, { activity: port, now: () => BASE + IDLE_MS })
    expect(await worker.runOnce()).toBe('IDLE')

    port.set({
      complete: true, activeAgent: false, activityRevision: 'process-a:6',
      durableLatestTurnEndSeq: 10, durableOpenTurn: false,
    })
    const global = seeded.domain.global.get()
    await seeded.domain.global.set({
      ...global,
      sessions: {
        ...global.sessions,
        [seeded.batch.sessionLifecycleKey]: {
          ...global.sessions[seeded.batch.sessionLifecycleKey]!,
          observedThroughTurnEndSeq: seeded.batch.lastTurnEndSeq + 2,
        },
      },
    })
    expect(await worker.runOnce()).toBe('IDLE')
    const caughtUp = seeded.domain.global.get()
    await seeded.domain.global.set({
      ...caughtUp,
      sessions: {
        ...caughtUp.sessions,
        [seeded.batch.sessionLifecycleKey]: {
          ...caughtUp.sessions[seeded.batch.sessionLifecycleKey]!,
          detectedThroughTurnEndSeq: seeded.batch.lastTurnEndSeq + 2,
        },
      },
    })
    expect(await worker.runOnce()).toBe('IDLE')
    expect(seeded.domain.experienceIntents.get(seeded.intent.intentId)?.status).toBe('WAITING_FOR_QUIESCENCE')
  })

  it('binds the durable fence to exact Session and live Agent activity facts', async () => {
    const seeded = await seedWaiting({ explicit: false })
    const port = activity()
    const worker = new SessionQuiescenceCoordinator(seeded.domain, { activity: port, now: () => BASE + IDLE_MS })
    await worker.runOnce()
    const ready = ExperienceIntentV2Schema.parse(seeded.domain.experienceIntents.get(seeded.intent.intentId))
    expect(ready.quiescence.state).toBe('SATISFIED')
    if (ready.quiescence.state !== 'SATISFIED') return
    expect(ready.quiescence.fenceDigest).toBe(deriveSessionQuiescenceFenceDigestV2({
      intentId: ready.intentId,
      batchId: ready.batchId,
      sessionLifecycleKey: ready.sessionLifecycleKey,
      batchLastTurnEndSeq: ready.quiescence.batchLastTurnEndSeq,
      observedThroughTurnEndSeq: ready.quiescence.observedThroughTurnEndSeq,
      detectedThroughTurnEndSeq: ready.quiescence.detectedThroughTurnEndSeq,
      activityRevision: ready.quiescence.activityRevision,
    }))
    await expect(worker.validate(ready.intentId)).resolves.toBe('VALID')

    port.set({
      complete: true, activeAgent: true, activityRevision: 'process-a:5',
      durableLatestTurnEndSeq: 8, durableOpenTurn: false,
    })
    await expect(worker.validate(ready.intentId)).resolves.toBe('STALE')
  })

  it('fails closed when the live activity observation is incomplete', async () => {
    const seeded = await seedWaiting({ explicit: true })
    const worker = new SessionQuiescenceCoordinator(seeded.domain, {
      activity: activity({
        complete: false, activeAgent: false, activityRevision: 'process-a:4',
        durableLatestTurnEndSeq: 8, durableOpenTurn: false,
      }),
      now: () => BASE + IDLE_MS,
    })
    expect(await worker.runOnce()).toBe('IDLE')
    expect(seeded.domain.experienceIntents.get(seeded.intent.intentId)?.status).toBe('WAITING_FOR_QUIESCENCE')
  })

  it('schedules a bounded retry when an explicit save first races an active Agent', async () => {
    const seeded = await seedWaiting({ explicit: true })
    const port = activity({
      complete: true, activeAgent: true, activityRevision: 'process-a:active',
      durableLatestTurnEndSeq: 8, durableOpenTurn: false,
    })
    let now = BASE + 1
    const worker = new SessionQuiescenceCoordinator(seeded.domain, { activity: port, now: () => now })

    expect(await worker.runOnce()).toBe('IDLE')
    const retryAt = worker.nextEligibleAt()
    expect(retryAt).toBeGreaterThan(now)

    // An agent/disposed wake may arrive before the timer. It must be allowed to
    // re-check immediately instead of waiting for the retry deadline.
    port.set({
      complete: true, activeAgent: false, activityRevision: 'process-a:disposed',
      durableLatestTurnEndSeq: 8, durableOpenTurn: false,
    })
    expect(await worker.runOnce()).toBe('PROCESSED')
    expect(seeded.domain.experienceIntents.get(seeded.intent.intentId)?.status).toBe('READY')
    expect(worker.nextEligibleAt()).toBeUndefined()
  })

  it('backs incomplete idle checks off to a capped low-frequency retry', async () => {
    const seeded = await seedWaiting({ explicit: false })
    let now = BASE + IDLE_MS
    const worker = new SessionQuiescenceCoordinator(seeded.domain, {
      activity: activity({
        complete: false, activeAgent: false, activityRevision: 'process-a:incomplete',
        durableLatestTurnEndSeq: 8, durableOpenTurn: false,
      }),
      now: () => now,
    })

    const delays: number[] = []
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(await worker.runOnce()).toBe('IDLE')
      const retryAt = worker.nextEligibleAt()
      expect(retryAt).toBeGreaterThan(now)
      delays.push(retryAt! - now)
      now = retryAt!
    }

    expect(delays.slice(0, 3)).toEqual([1_000, 1_000, 1_000])
    expect(delays[3]).toBe(30_000)
    expect(delays.at(-1)).toBe(5 * 60 * 1_000)
    expect(delays.every(delay => delay <= 5 * 60 * 1_000)).toBe(true)
    expect(seeded.domain.experienceIntents.get(seeded.intent.intentId)?.status).toBe('WAITING_FOR_QUIESCENCE')
  })

  it('does not release a waiting Intent when a new Turn arrives during live activity observation', async () => {
    const seeded = await seedWaiting({ explicit: true })
    const entered = deferred<void>()
    const observation = deferred<unknown>()
    const worker = new SessionQuiescenceCoordinator(seeded.domain, {
      activity: {
        observe: async () => {
          entered.resolve()
          return observation.promise
        },
      },
      now: () => BASE + 1,
    })
    const pending = worker.runOnce()
    await entered.promise
    const global = seeded.domain.global.get()
    await seeded.domain.global.set({
      ...global,
      sessions: {
        ...global.sessions,
        [seeded.batch.sessionLifecycleKey]: {
          ...global.sessions[seeded.batch.sessionLifecycleKey]!,
          observedThroughTurnEndSeq: seeded.batch.lastTurnEndSeq + 1,
          detectedThroughTurnEndSeq: seeded.batch.lastTurnEndSeq + 1,
        },
      },
    })
    observation.resolve({
      complete: true, activeAgent: false, activityRevision: 'process-a:4',
      durableLatestTurnEndSeq: seeded.batch.lastTurnEndSeq + 1, durableOpenTurn: false,
    })

    await expect(pending).resolves.toBe('IDLE')
    expect(seeded.domain.experienceIntents.get(seeded.intent.intentId)?.status).toBe('WAITING_FOR_QUIESCENCE')
  })

  it('returns STALE when durable Turn watermarks change during fence validation', async () => {
    const seeded = await seedWaiting({ explicit: false })
    const release = new SessionQuiescenceCoordinator(seeded.domain, {
      activity: activity(), now: () => BASE + IDLE_MS,
    })
    await release.runOnce()
    const entered = deferred<void>()
    const observation = deferred<unknown>()
    const validator = new SessionQuiescenceCoordinator(seeded.domain, {
      activity: {
        observe: async () => {
          entered.resolve()
          return observation.promise
        },
      },
      now: () => BASE + IDLE_MS,
    })
    const pending = validator.validate(seeded.intent.intentId)
    await entered.promise
    const global = seeded.domain.global.get()
    await seeded.domain.global.set({
      ...global,
      sessions: {
        ...global.sessions,
        [seeded.batch.sessionLifecycleKey]: {
          ...global.sessions[seeded.batch.sessionLifecycleKey]!,
          observedThroughTurnEndSeq: seeded.batch.lastTurnEndSeq + 1,
          detectedThroughTurnEndSeq: seeded.batch.lastTurnEndSeq + 1,
        },
      },
    })
    observation.resolve({
      complete: true, activeAgent: false, activityRevision: 'process-a:4',
      durableLatestTurnEndSeq: seeded.batch.lastTurnEndSeq + 1, durableOpenTurn: false,
    })

    await expect(pending).resolves.toBe('STALE')
  })

  it.each([
    { latest: 10, open: false },
    { latest: 8, open: true },
  ])('does not release when durable Session facts are ahead or open: %o', async ({ latest, open }) => {
    const seeded = await seedWaiting({ explicit: true })
    const worker = new SessionQuiescenceCoordinator(seeded.domain, {
      activity: activity({
        complete: true, activeAgent: false, activityRevision: `durable:${latest}:${open}`,
        durableLatestTurnEndSeq: latest, durableOpenTurn: open,
      }),
      now: () => BASE + 1,
    })

    expect(await worker.runOnce()).toBe('IDLE')
    expect(seeded.domain.experienceIntents.get(seeded.intent.intentId)?.status).toBe('WAITING_FOR_QUIESCENCE')
  })
})
