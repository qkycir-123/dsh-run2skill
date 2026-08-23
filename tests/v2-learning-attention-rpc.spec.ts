import { describe, expect, it } from 'vitest'
import { V2LearningAttentionService } from '../src/adapters/dsh-connection/v2-learning-attention-rpc.js'
import { CompleteCoverageWorker } from '../src/application/coverage-analysis/index.js'
import { CompleteCatalogRecallWorker, deriveRecallCandidateId } from '../src/application/recall/index.js'
import { deriveTurnObservationContentDigestV2, ExperienceIntentV2Schema, SessionBatchV2Schema } from '../src/domain/v2/index.js'
import { deriveProjectScopeIdentityDigest } from '../src/domain/purge/index.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

const scope = { kind: 'WORKSPACE' as const, generation: 1, workspaceId: 'workspace-v2' }
const now = '2026-08-23T12:00:00.000Z'

async function seededObservation(domain: ReturnType<typeof createMemoryRun2skillV2Domain>) {
  const fixture = createMinimalV2Fixtures()
  const scopeBinding = {
    status: 'PROJECT' as const,
    workspaceId: scope.workspaceId,
    scopeIdentityDigest: deriveProjectScopeIdentityDigest('D:/workspace'),
  }
  const observation = {
    ...fixture.turnObservation,
    scopeBinding,
    contentDigest: deriveTurnObservationContentDigestV2({
      outcomeKind: fixture.turnObservation.outcomeKind,
      assistantOutcomeSummary: fixture.turnObservation.assistantOutcomeSummary,
      toolOutcomeSummary: fixture.turnObservation.toolOutcomeSummary,
      routeObservation: fixture.turnObservation.routeObservation,
      completeness: fixture.turnObservation.completeness,
      explicitSaveRequested: fixture.turnObservation.explicitSaveRequested,
      scopeBinding,
      evidenceDigest: fixture.turnObservation.evidenceDigest,
    }),
  }
  await domain.table('turn_observations').put(observation.observationId, observation)
  return { fixture, observation }
}

async function seedCoveredIntent(domain: ReturnType<typeof createMemoryRun2skillV2Domain>) {
  const { fixture } = await seededObservation(domain)
  const owned = ExperienceIntentV2Schema.parse({
    ...fixture.proposalReadyIntent,
    revision: 1,
    status: 'RUN2SKILL_OWNED',
    recall: { state: 'NOT_STARTED', complete: false, summaryScanComplete: false, candidates: [] },
    coverage: { state: 'NOT_STARTED', retryUsed: false },
    generation: { state: 'NOT_STARTED', userRetryUsed: false, staleRefreshUsed: false, receipts: [] },
    stageCalls: [],
    lineageId: undefined,
  })
  const batch = SessionBatchV2Schema.parse(fixture.sessionBatch)
  const summaryFacts = {
    name: 'covered-skill',
    description: 'Already covers the requested workflow',
    whenToUse: 'Use for the same workflow',
    provider: 'filesystem',
    source: 'project-dsh',
    scope: 'PROJECT' as const,
    writable: true,
    rootIdentityDigest: 'd'.repeat(64),
  }
  const summary = { candidateId: deriveRecallCandidateId(summaryFacts), ...summaryFacts }
  const catalog = {
    snapshot: async () => ({
      complete: true as const,
      runtimeCatalogDigest: '1'.repeat(64),
      pendingCatalogDigest: '2'.repeat(64),
      catalogEpoch: 4,
      catalogMutationReceiptDigest: '3'.repeat(64),
      summaries: [summary],
    }),
    read: async () => ({ ...summary, content: '# covered-skill\ncomplete body' }),
  }
  await domain.table('experience_intents').put(owned.intentId, owned)
  await domain.table('session_batches').put(batch.batchId, batch)
  await new CompleteCatalogRecallWorker(domain, {
    catalog,
    classifier: { classify: async () => ({
      classifications: [{ candidateId: summary.candidateId, classification: 'RELEVANT' as const }],
    }) },
  }).runOnce()
  await new CompleteCoverageWorker(domain, {
    catalog,
    classifier: { classify: async () => ({
      decisions: [{ candidateId: summary.candidateId, decision: 'COVERED' as const, reason: 'already covered' }],
    }) },
  }).runOnce()
  return ExperienceIntentV2Schema.parse(domain.experienceIntents.get(owned.intentId))
}

describe('v2 learning Attention RPC', () => {
  it('durably authorizes one idempotent COVERED dispute retry and never a second retry loop', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const covered = await seedCoveredIntent(domain)
    expect(covered.status).toBe('COVERED_NEEDS_CONFIRMATION')
    const service = new V2LearningAttentionService(
      domain,
      async workspaceId => ({ workspaceId, canonicalPath: 'D:/workspace' }),
      () => now,
    )
    const action = (await service.project(scope))[0]!
    expect(action).toMatchObject({
      kind: 'RETRY_LEARNING',
      reasonCode: 'COVERED_NEEDS_CONFIRMATION',
      availableActions: ['RETRY', 'DISMISS'],
    })
    const request = {
      apiVersion: 1 as const,
      workItemId: action.subjectId,
      workItemRevision: covered.revision,
      currentScope: scope,
      action: { actionKey: action.actionKey, subjectId: action.subjectId, kind: action.kind },
    }
    const handler = service.handler()

    await expect(handler('learning/issues/retry', request, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: { changed: true, processingState: 'CAPTURED', disposition: 'RETRY_QUEUED' },
    })
    expect(domain.experienceIntents.get(covered.intentId)).toMatchObject({
      status: 'COVERAGE_RETRY_AUTHORIZED',
      coverage: { state: 'ANALYZING', retryUsed: true },
      reasonReceipts: [{ reasonCode: 'DISPUTE_COVERAGE' }],
    })
    await expect(handler('learning/issues/retry', request, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: { changed: false, disposition: 'RETRY_QUEUED' },
    })
  })

  it('projects a generation failure and durably dismisses its duplicate barrier facts', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const { fixture } = await seededObservation(domain)
    const intent = ExperienceIntentV2Schema.parse(fixture.staleAttentionIntent)
    await domain.table('experience_intents').put(intent.intentId, intent)
    const service = new V2LearningAttentionService(
      domain,
      async workspaceId => ({ workspaceId, canonicalPath: 'D:/workspace' }),
      () => now,
    )
    const projected = await service.project(scope)
    expect(projected).toMatchObject([{
      kind: 'DISMISS_LEARNING',
      reasonCode: 'STALE_RESULT',
      availableActions: ['DISMISS'],
    }])
    const action = projected[0]!
    const handler = service.handler()
    const list = await handler('learning/issues/list', {
      apiVersion: 1,
      currentScope: scope,
      limit: 20,
    }, new AbortController().signal)
    expect(list).toMatchObject({ ok: true, value: { items: [{ failureCode: 'STALE_RESULT', retryable: false }] } })
    const beforeEpoch = domain.global.get().proposalCatalogEpoch
    const dismissed = await handler('learning/issues/dismiss', {
      apiVersion: 1,
      workItemId: action.subjectId,
      workItemRevision: intent.revision,
      currentScope: scope,
      action: { actionKey: action.actionKey, subjectId: action.subjectId, kind: action.kind },
      confirm: true,
    }, new AbortController().signal)

    expect(dismissed).toMatchObject({ ok: true, value: { processingState: 'TERMINAL', disposition: 'IGNORED' } })
    expect(domain.experienceIntents.get(intent.intentId)).toMatchObject({
      status: 'DISCARDED',
      generation: { state: 'NOT_STARTED' },
      reasonReceipts: [{ reasonCode: 'DISMISS_GENERATION' }],
    })
    expect(domain.global.get()).toMatchObject({
      proposalCatalogEpoch: beforeEpoch + 1,
      proposalCatalogLastMutation: { kind: 'USER_ACTION', ownerId: intent.intentId },
    })
    expect(domain.global.get().proposalCatalogMutationJournal).toBeUndefined()
    expect(await service.project(scope)).toEqual([])
  })

  it('projects and closes a terminal detector failure without invoking a model', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const { fixture } = await seededObservation(domain)
    const batch = SessionBatchV2Schema.parse({
      ...fixture.sessionBatch,
      detector: {
        result: 'NEEDS_ATTENTION',
        failureCode: 'DETECTOR_INPUT_UNAVAILABLE',
        calls: [],
        intentIds: [],
        carry: [],
      },
      state: 'NEEDS_ATTENTION',
    })
    await domain.table('session_batches').put(batch.batchId, batch)
    await domain.global.set({
      ...domain.global.get(),
      sessions: {
        [batch.sessionLifecycleKey]: {
          observedThroughTurnEndSeq: batch.lastTurnEndSeq,
          detectedThroughTurnEndSeq: 0,
          activeBatchId: batch.batchId,
          lastActivityAt: batch.updatedAt,
          openExperienceCarry: [],
          updatedAt: batch.updatedAt,
        },
      },
    })
    const service = new V2LearningAttentionService(
      domain,
      async workspaceId => ({ workspaceId, canonicalPath: 'D:/workspace' }),
      () => now,
    )
    const action = (await service.project(scope))[0]!
    const response = await service.handler()('learning/issues/dismiss', {
      apiVersion: 1,
      workItemId: action.subjectId,
      workItemRevision: batch.revision,
      currentScope: scope,
      action: { actionKey: action.actionKey, subjectId: action.subjectId, kind: action.kind },
      confirm: true,
    }, new AbortController().signal)

    expect(response).toMatchObject({ ok: true, value: { disposition: 'IGNORED' } })
    expect(domain.sessionBatches.has(batch.batchId)).toBe(false)
    expect(domain.global.get().sessions[batch.sessionLifecycleKey]).toMatchObject({
      detectedThroughTurnEndSeq: batch.lastTurnEndSeq,
    })
    expect(domain.global.get().sessions[batch.sessionLifecycleKey]?.activeBatchId).toBeUndefined()
  })
})
