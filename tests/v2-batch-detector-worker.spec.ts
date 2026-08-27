import { describe, expect, it } from 'vitest'
import { BatchDetectorWorker, type BatchDetectorClient } from '../src/application/detection/index.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'
import { canonicalJson } from '../src/domain/learn/identity.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import {
  RUN2SKILL_V2_LIMITS,
  SessionBatchV2Schema,
  TurnObservationV2Schema,
  deriveSessionBatchIdV2,
  deriveTurnObservationContentDigestV2,
  deriveTurnObservationIdV2,
} from '../src/domain/v2/index.js'

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
  it('leaves ordinary frozen batches untouched while automatic learning is off', async () => {
    const { domain, fixtures } = await seedFrozenBatch()
    domain.sessionBatches.set(fixtures.sessionBatch.batchId, SessionBatchV2Schema.parse({
      ...fixtures.sessionBatch,
      triggerReasons: ['THRESHOLD'],
    }))
    const model = client({ result: 'NONE' })
    const worker = new BatchDetectorWorker(domain, {
      client: model,
      permitBatch: batch => batch.triggerReasons.includes('EXPLICIT'),
    })

    expect(await worker.runOnce()).toBe('IDLE')
    expect(model.calls).toBe(0)
    expect(domain.sessionBatches.get(fixtures.sessionBatch.batchId)?.state).toBe('FROZEN')
  })

  it('does not claim a frozen batch while clear-all owns the purge fence', async () => {
    const { domain, fixtures } = await seedFrozenBatch()
    await domain.global.set({
      ...domain.global.get(),
      purgeJournal: {
        schemaVersion: 1,
        purgeId: `purge_${'a'.repeat(64)}`,
        scopeBinding: { scope: 'ALL' },
        hideBefore: '2026-08-23T12:00:00.000Z',
        phase: 'QUIESCED',
        updatedAt: '2026-08-23T12:00:00.000Z',
      },
    })
    const model = client({ result: 'NONE' })
    const worker = new BatchDetectorWorker(domain, { client: model })

    expect(await worker.runOnce()).toBe('IDLE')
    expect(model.calls).toBe(0)
    expect(domain.sessionBatches.get(fixtures.sessionBatch.batchId)?.state).toBe('FROZEN')
  })

  it('still detects an explicit save batch while automatic learning is off', async () => {
    const { domain, fixtures } = await seedFrozenBatch()
    domain.sessionBatches.set(fixtures.sessionBatch.batchId, SessionBatchV2Schema.parse({
      ...fixtures.sessionBatch,
      triggerReasons: ['EXPLICIT'],
    }))
    const model = client({ result: 'NONE' })
    const worker = new BatchDetectorWorker(domain, {
      client: model,
      permitBatch: batch => batch.triggerReasons.includes('EXPLICIT'),
    })

    expect(await worker.runOnce()).toBe('PROCESSED')
    expect(model.calls).toBe(1)
  })

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

  it('normalizes safe detector envelope drift and direct-evidence digests without another model call', async () => {
    const { domain, fixtures } = await seedFrozenBatch()
    const excerptDigest = fixtures.turnObservation.directUserEvidence[0]!.excerptDigest
    const model = client({
      result: 'READY',
      diagnosticNote: 'ignored adapter-only drift',
      intents: [{
        persistenceScope: 'PROJECT',
        experienceType: 'WORKFLOW',
        applicabilitySummary: '制作网页小游戏时使用这套流程。',
        keySteps: ['先分析需求', '再设计架构', '编写代码', '最后测试'],
        prohibitions: ['不得跳过测试'],
        evidenceDigests: [excerptDigest],
        completeness: { status: 'COMPLETE', blockers: [], diagnosticNote: 'ignored' },
        diagnosticNote: 'ignored',
      }],
    })
    const worker = new BatchDetectorWorker(domain, { client: model })

    await worker.runOnce()

    expect(model.calls).toBe(1)
    expect(domain.sessionBatches.get(fixtures.sessionBatch.batchId)).toMatchObject({
      state: 'COMMITTED_READY',
      detector: { result: 'READY' },
    })
    expect([...domain.experienceIntents.values()][0]).toMatchObject({
      evidenceDigests: [fixtures.turnObservation.evidenceDigest],
    })
  })

  it('still rejects detector evidence that belongs to neither an observation nor its direct evidence', async () => {
    const { domain, fixtures } = await seedFrozenBatch()
    const model = client({
      result: 'READY',
      intents: [{
        persistenceScope: 'PROJECT',
        experienceType: 'WORKFLOW',
        applicabilitySummary: '制作网页小游戏时使用这套流程。',
        keySteps: ['先分析需求', '再设计架构', '编写代码', '最后测试'],
        prohibitions: [],
        evidenceDigests: ['f'.repeat(64)],
        completeness: { status: 'COMPLETE', blockers: [] },
      }],
    })
    const worker = new BatchDetectorWorker(domain, { client: model })

    await worker.runOnce()

    expect(model.calls).toBe(1)
    expect(domain.sessionBatches.get(fixtures.sessionBatch.batchId)).toMatchObject({
      state: 'NEEDS_ATTENTION', detector: { failureCode: 'INVALID_DETECTOR_OUTPUT' },
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

  it('claims the exact projected input that the detector client receives', async () => {
    const { domain, fixtures } = await seedFrozenBatch()
    let received: Parameters<BatchDetectorClient['detect']>[0] | undefined
    const model: BatchDetectorClient = {
      projectInput: input => ({
        ...input,
        observations: input.observations.map(item => ({ ...item, assistantOutcomeSummary: '' })),
      }),
      detect: async input => {
        received = input
        return { result: 'NONE' }
      },
    }

    await new BatchDetectorWorker(domain, { client: model }).runOnce()

    expect(received).toBeDefined()
    expect(domain.sessionBatches.get(fixtures.sessionBatch.batchId)?.detector.calls[0]?.inputDigest)
      .toBe(sha256Utf8(canonicalJson(received)))
  })

  it('keeps detector evidence within one strict batch budget without adding a model call', async () => {
    const { domain, fixtures } = await seedFrozenBatch()
    const importantTails = [
      'Please capture this workflow as a Skill.',
      `Never skip verification. ${'Do not save this workflow as a Skill. '.repeat(20)}`,
      `Acceptance criteria: typecheck, lint, and all tests pass. ${'Explain how to save this workflow as a Skill. '.repeat(20)}`,
      `Required steps: first inspect, then change, finally read the value back. Only change the target field. ${'The docs say "save this workflow as a Skill". '.repeat(20)}`,
      'TRUE_BATCH_TAIL: the user finally corrected the publication directory.',
    ]
    const observations = importantTails.map((importantTail, index) => {
      const excerpt = `${'irrelevant background. '.repeat(260)}${importantTail}`
      const directUserEvidence = [{
        source: 'USER_DIRECT' as const,
        messageSeq: index + 1,
        excerpt,
        excerptDigest: sha256Utf8(excerpt),
        redactionKinds: [],
        truncated: false,
      }]
      const turnEndSeq = 8 + index
      const turnInstanceDigest = sha256Utf8(`issue-143-turn-${index}`)
      const evidenceDigest = sha256Utf8(canonicalJson(directUserEvidence))
      const content = {
        outcomeKind: fixtures.turnObservation.outcomeKind,
        assistantOutcomeSummary: fixtures.turnObservation.assistantOutcomeSummary,
        toolOutcomeSummary: fixtures.turnObservation.toolOutcomeSummary,
        routeObservation: fixtures.turnObservation.routeObservation,
        completeness: 'COMPLETE' as const,
        explicitSaveRequested: true,
        scopeBinding: fixtures.turnObservation.scopeBinding,
        evidenceDigest,
      }
      return TurnObservationV2Schema.parse({
        ...fixtures.turnObservation,
        turn: index + 1,
        turnStartSeq: turnEndSeq - 1,
        turnEndSeq,
        turnInstanceDigest,
        observationId: deriveTurnObservationIdV2({
          sessionLifecycleKey: fixtures.turnObservation.sessionLifecycleKey,
          turnEndSeq,
          turnInstanceDigest,
        }),
        directUserEvidence,
        evidenceDigest,
        explicitSaveRequested: true,
        contentDigest: deriveTurnObservationContentDigestV2(content),
      })
    })
    const observationManifest = observations.map(item => ({
      observationId: item.observationId,
      turnStartSeq: item.turnStartSeq,
      turnEndSeq: item.turnEndSeq,
      evidenceDigest: item.evidenceDigest,
      completeness: item.completeness,
    }))
    const batchFacts = {
      sessionLifecycleKey: fixtures.sessionBatch.sessionLifecycleKey,
      firstTurnEndSeq: observations[0]!.turnEndSeq,
      lastTurnEndSeq: observations.at(-1)!.turnEndSeq,
      detectorPolicyVersion: fixtures.sessionBatch.detectorPolicyVersion,
    }
    const batch = SessionBatchV2Schema.parse({
      ...fixtures.sessionBatch,
      ...batchFacts,
      batchId: deriveSessionBatchIdV2(batchFacts),
      observationManifest,
      observationManifestDigest: sha256Utf8(canonicalJson(observationManifest)),
    })
    domain.turnObservations.clear()
    for (const observation of observations) domain.turnObservations.set(observation.observationId, observation)
    domain.sessionBatches.clear()
    domain.sessionBatches.set(batch.batchId, batch)
    const global = domain.global.get()
    await domain.global.set({
      ...global,
      sessions: {
        [batch.sessionLifecycleKey]: {
          ...global.sessions[batch.sessionLifecycleKey]!,
          observedThroughTurnEndSeq: batch.lastTurnEndSeq,
          activeBatchId: batch.batchId,
        },
      },
    })
    let received: Parameters<BatchDetectorClient['detect']>[0] | undefined
    const model = {
      calls: 0,
      detect: async (input: Parameters<BatchDetectorClient['detect']>[0]) => {
        model.calls += 1
        received = input
        return { result: 'NONE' as const }
      },
    }
    const worker = new BatchDetectorWorker(domain, { client: model })

    await worker.runOnce()

    const evidenceBytes = received?.observations
      .flatMap(item => item.directUserEvidence)
      .reduce((total, item) => total + Buffer.byteLength(item.excerpt, 'utf8'), 0) ?? 0
    const selectedText = received?.observations.flatMap(item => item.directUserEvidence)
      .map(item => item.excerpt).join('\n') ?? ''
    expect(model.calls).toBe(1)
    expect(evidenceBytes).toBeLessThanOrEqual(RUN2SKILL_V2_LIMITS.maxBatchEvidenceTotalBytes)
    expect(selectedText).toContain('Please capture this workflow as a Skill')
    expect(selectedText).toContain('Never skip verification')
    expect(selectedText).toContain('Acceptance criteria')
    expect(selectedText).toContain('first inspect, then change, finally read the value back')
    expect(selectedText).toContain('Only change the target field')
    expect(selectedText).toContain('TRUE_BATCH_TAIL')
  })

  it('fails a minimum-envelope projection closed without invoking the detector', async () => {
    const { domain, fixtures } = await seedFrozenBatch()
    let calls = 0
    const failure = Object.assign(new Error('minimum envelope is too large'), {
      code: 'INPUT_BUDGET_EXCEEDED',
    })
    const worker = new BatchDetectorWorker(domain, {
      client: {
        projectInput: () => { throw failure },
        detect: async () => {
          calls += 1
          return { result: 'NONE' }
        },
      },
    })

    await expect(worker.runOnce()).resolves.toBe('PROCESSED')

    expect(calls).toBe(0)
    expect(domain.sessionBatches.get(fixtures.sessionBatch.batchId)).toMatchObject({
      state: 'NEEDS_ATTENTION',
      detector: {
        failureCode: 'INPUT_BUDGET_EXCEEDED',
        calls: [{ outcome: 'FAILED', failureCode: 'INPUT_BUDGET_EXCEEDED' }],
      },
    })
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

  it('preserves a bounded model failure code instead of collapsing it to MODEL_CALL_FAILED', async () => {
    const { domain, fixtures } = await seedFrozenBatch()
    const failure = Object.assign(new Error('timed out'), { code: 'MODEL_TIMEOUT' })
    const worker = new BatchDetectorWorker(domain, {
      client: { detect: async () => { throw failure } },
    })

    await worker.runOnce()

    expect(domain.sessionBatches.get(fixtures.sessionBatch.batchId)).toMatchObject({
      state: 'NEEDS_ATTENTION',
      detector: { failureCode: 'MODEL_TIMEOUT', calls: [{ failureCode: 'MODEL_TIMEOUT' }] },
    })
  })
})
