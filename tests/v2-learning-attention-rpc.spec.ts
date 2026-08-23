import { describe, expect, it } from 'vitest'
import { V2LearningAttentionService } from '../src/adapters/dsh-connection/v2-learning-attention-rpc.js'
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

describe('v2 learning Attention RPC', () => {
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
  })
})
