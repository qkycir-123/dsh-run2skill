import { describe, expect, it } from 'vitest'
import { BatchDetectorWorker, type BatchDetectorClient } from '../src/application/detection/index.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'
import { SessionBatchV2Schema } from '../src/domain/v2/index.js'

async function seedFrozenBatch() {
  const domain = createMemoryRun2skillV2Domain()
  const fixtures = createMinimalV2Fixtures()
  await domain.table('turn_observations').put(fixtures.turnObservation.observationId, fixtures.turnObservation)
  const batch = SessionBatchV2Schema.parse(fixtures.sessionBatch)
  await domain.table('session_batches').put(batch.batchId, batch)
  await domain.global.set({
    ...domain.global.get(),
    sessions: {
      [fixtures.sessionBatch.sessionLifecycleKey]: {
        observedThroughTurnEndSeq: fixtures.sessionBatch.lastTurnEndSeq,
        detectedThroughTurnEndSeq: 0,
        activeBatchId: fixtures.sessionBatch.batchId,
        lastActivityAt: fixtures.turnObservation.observedAt,
        openExperienceCarry: [],
        updatedAt: fixtures.sessionBatch.updatedAt,
      },
    },
  })
  return { domain, fixtures: { ...fixtures, sessionBatch: batch } }
}

function client(result: Awaited<ReturnType<BatchDetectorClient['detect']>>) {
  let calls = 0
  return {
    get calls() { return calls },
    detect: async () => {
      calls += 1
      return result
    },
  }
}

describe('v2 Batch Detector worker', () => {
  it('reserves one call and commits NONE without downstream work', async () => {
    const { domain, fixtures } = await seedFrozenBatch()
    const model = client({ result: 'NONE' })
    const worker = new BatchDetectorWorker(domain, { client: model, now: () => 1 })
    expect(await worker.runOnce()).toBe('PROCESSED')
    expect(await worker.runOnce()).toBe('IDLE')
    expect(model.calls).toBe(1)
    expect(domain.sessionBatches.get(fixtures.sessionBatch.batchId)).toMatchObject({
      state: 'COMMITTED_NONE',
      detector: { result: 'NONE', calls: [{ outcome: 'SUCCEEDED' }], intentIds: [], carry: [] },
    })
    expect(domain.global.get().sessions[fixtures.sessionBatch.sessionLifecycleKey]).toMatchObject({
      detectedThroughTurnEndSeq: fixtures.sessionBatch.lastTurnEndSeq,
      openExperienceCarry: [],
    })
  })

  it('commits bounded DEFER carry into both batch and session cursor', async () => {
    const { domain, fixtures } = await seedFrozenBatch()
    const carry = {
      summary: '用户正在形成一个可复用流程，但当前结果尚未完成。',
      behaviorSignatureDraft: 'a'.repeat(64),
      evidenceDigests: [fixtures.turnObservation.evidenceDigest],
    }
    const worker = new BatchDetectorWorker(domain, { client: client({ result: 'DEFER', carry: [carry] }) })
    await worker.runOnce()
    expect(domain.sessionBatches.get(fixtures.sessionBatch.batchId)).toMatchObject({
      state: 'COMMITTED_DEFER',
      detector: { result: 'DEFER', carry: [{ ...carry, remainingBatches: 2 }] },
    })
    expect(domain.global.get().sessions[fixtures.sessionBatch.sessionLifecycleKey]?.openExperienceCarry)
      .toEqual([{ ...carry, remainingBatches: 2 }])
    expect(domain.experienceIntents.size).toBe(0)
  })

  it('materializes READY intents once and commits their deterministic identities', async () => {
    const { domain, fixtures } = await seedFrozenBatch()
    const model = client({
      result: 'READY',
      intents: [{
        persistenceScope: 'PROJECT',
        experienceType: 'WORKFLOW',
        applicabilitySummary: '制作网页小游戏时使用这套流程。',
        keySteps: ['先分析需求', '再设计架构', '编写代码', '最后测试'],
        prohibitions: ['不得跳过测试'],
        evidenceDigests: [fixtures.turnObservation.evidenceDigest],
        completeness: { status: 'COMPLETE', blockers: [] },
      }],
    })
    const first = new BatchDetectorWorker(domain, { client: model })
    const second = new BatchDetectorWorker(domain, { client: model })
    await Promise.all([first.runOnce(), second.runOnce()])
    expect(model.calls).toBe(1)
    expect(domain.experienceIntents.size).toBe(1)
    const intent = [...domain.experienceIntents.values()][0]!
    expect(intent).toMatchObject({
      batchId: fixtures.sessionBatch.batchId,
      status: 'WAITING_FOR_QUIESCENCE',
      revision: 2,
      quiescence: { state: 'WAITING', batchLastTurnEndSeq: fixtures.sessionBatch.lastTurnEndSeq },
    })
    expect(domain.sessionBatches.get(fixtures.sessionBatch.batchId)).toMatchObject({
      state: 'COMMITTED_READY',
      detector: { result: 'READY', intentIds: [intent.intentId] },
    })
  })

  it('fails closed on invalid output and never spends a second call', async () => {
    const { domain, fixtures } = await seedFrozenBatch()
    const model = client({ result: 'READY', intents: [] })
    const worker = new BatchDetectorWorker(domain, { client: model })
    await worker.runOnce()
    expect(await worker.runOnce()).toBe('IDLE')
    expect(model.calls).toBe(1)
    expect(domain.sessionBatches.get(fixtures.sessionBatch.batchId)).toMatchObject({
      state: 'NEEDS_ATTENTION',
      detector: { result: 'NEEDS_ATTENTION', calls: [{ failureCode: 'INVALID_DETECTOR_OUTPUT' }] },
    })
  })

  it('turns a crash-left RESERVED call into OUTCOME_UNKNOWN without calling the model', async () => {
    const { domain, fixtures } = await seedFrozenBatch()
    const batch = fixtures.sessionBatch
    await domain.table('session_batches').put(batch.batchId, {
      ...batch,
      revision: 2,
      state: 'DETECTION_CLAIMED',
      detector: {
        result: 'NOT_RUN',
        calls: [{
          stage: 'DETECTION', callId: `call_${'c'.repeat(64)}`, ordinal: 1,
          inputDigest: 'd'.repeat(64), provider: batch.routeSnapshot.provider,
          model: batch.routeSnapshot.model, policyVersion: batch.routeSnapshot.policyVersion,
          outcome: 'RESERVED',
        }],
        intentIds: [],
        carry: [],
      },
    })
    const model = client({ result: 'NONE' })
    const worker = new BatchDetectorWorker(domain, { client: model })
    await worker.recover()
    expect(model.calls).toBe(0)
    expect(domain.sessionBatches.get(batch.batchId)).toMatchObject({
      state: 'NEEDS_ATTENTION',
      detector: { result: 'NEEDS_ATTENTION', calls: [{ outcome: 'OUTCOME_UNKNOWN', failureCode: 'CALL_OUTCOME_UNKNOWN' }] },
    })
  })

  it('fails closed before reserve when a frozen observation is unavailable', async () => {
    const { domain, fixtures } = await seedFrozenBatch()
    await domain.table('turn_observations').delete(fixtures.turnObservation.observationId)
    const model = client({ result: 'NONE' })
    const worker = new BatchDetectorWorker(domain, { client: model })
    expect(await worker.runOnce()).toBe('PROCESSED')
    expect(model.calls).toBe(0)
    expect(domain.sessionBatches.get(fixtures.sessionBatch.batchId)).toMatchObject({
      state: 'NEEDS_ATTENTION',
      detector: { result: 'NEEDS_ATTENTION', failureCode: 'DETECTOR_INPUT_UNAVAILABLE', calls: [] },
    })
  })

  it('passes the exact frozen route to the detector client', async () => {
    const { domain, fixtures } = await seedFrozenBatch()
    let route: unknown
    const worker = new BatchDetectorWorker(domain, {
      client: { detect: async input => { route = input.route; return { result: 'NONE' } } },
    })
    await worker.runOnce()
    expect(route).toEqual(fixtures.sessionBatch.routeSnapshot)
  })

  it('rejects whitespace-only READY semantics', async () => {
    const { domain, fixtures } = await seedFrozenBatch()
    const worker = new BatchDetectorWorker(domain, { client: client({
      result: 'READY',
      intents: [{
        persistenceScope: 'PROJECT', experienceType: 'WORKFLOW', applicabilitySummary: '   ',
        keySteps: ['\t'], prohibitions: [],
        evidenceDigests: [fixtures.turnObservation.evidenceDigest],
        completeness: { status: 'COMPLETE', blockers: [] },
      }],
    }) })
    await worker.runOnce()
    expect(domain.sessionBatches.get(fixtures.sessionBatch.batchId)).toMatchObject({
      state: 'NEEDS_ATTENTION', detector: { failureCode: 'INVALID_DETECTOR_OUTPUT' },
    })
  })

  it('preserves prior carry when the detector call fails', async () => {
    const { domain, fixtures } = await seedFrozenBatch()
    const carry = [{
      summary: '尚未完成的既有经验', behaviorSignatureDraft: 'e'.repeat(64),
      evidenceDigests: [fixtures.turnObservation.evidenceDigest], remainingBatches: 1 as const,
    }]
    const global = domain.global.get()
    await domain.global.set({
      ...global,
      sessions: {
        ...global.sessions,
        [fixtures.sessionBatch.sessionLifecycleKey]: {
          ...global.sessions[fixtures.sessionBatch.sessionLifecycleKey]!, openExperienceCarry: carry,
        },
      },
    })
    const worker = new BatchDetectorWorker(domain, {
      client: { detect: async () => { throw new Error('offline') } },
    })
    await worker.runOnce()
    expect(domain.global.get().sessions[fixtures.sessionBatch.sessionLifecycleKey]?.openExperienceCarry).toEqual(carry)
  })
})
