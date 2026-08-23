import { describe, expect, it, vi } from 'vitest'
import { ATTENTION_ENDPOINT } from '../src/adapters/dsh-connection/attention-rpc.js'
import { V2CurrentScopeAuthorizer } from '../src/adapters/dsh-connection/v2-current-scope-authorizer.js'
import {
  PROPOSALS_APPROVE_ENDPOINT,
  PROPOSALS_GET_ENDPOINT,
  PROPOSALS_LIST_ENDPOINT,
  safeProposalSchema,
} from '../src/adapters/dsh-connection/proposal-review-rpc.js'
import { createV2ProposalRpcHandler } from '../src/adapters/dsh-connection/v2-proposal-rpc.js'
import { V2ProposalPublicationCoordinator } from '../src/application/publication/index.js'
import { V2ProposalReviewCoordinator } from '../src/application/review/index.js'
import { canonicalJson } from '../src/domain/learn/identity.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import { deriveProjectScopeIdentityDigest } from '../src/domain/purge/index.js'
import {
  GlobalV2Schema,
  ProposalLineageV2Schema,
  SessionBatchV2Schema,
} from '../src/domain/v2/index.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

const NOW = '2026-08-23T03:00:00.000Z'
const currentScope = { kind: 'WORKSPACE' as const, generation: 1, workspaceId: 'workspace-v2' }

async function seed(options: { readonly committed?: boolean } = {}) {
  const domain = createMemoryRun2skillV2Domain()
  const fixture = createMinimalV2Fixtures()
  if (options.committed !== false) {
    await domain.global.set(GlobalV2Schema.parse({
      ...domain.global.get(),
      migration: {
        schemaVersion: 1,
        phase: 'COMMITTED',
        source: { domainName: 'run2skill_v1', domainVersion: 2, globalSchemaVersion: 1 },
        sourceFingerprint: 'a'.repeat(64),
        counts: { workItems: 0, lineages: 0, activeLegacyProposals: 0 },
        startedAt: NOW,
        updatedAt: NOW,
        committedAt: NOW,
        activationFenceDigest: 'b'.repeat(64),
      },
      activation: {
        committedAt: NOW,
        sourceFingerprint: 'a'.repeat(64),
        observerStartWatermarks: {},
        observerStartWatermarkDigest: sha256Utf8(canonicalJson({})),
        legacyPendingCatalogDigest: sha256Utf8(canonicalJson([])),
        legacyPendingCandidateCount: 0,
      },
    }))
  }
  const lineage = ProposalLineageV2Schema.parse({
    ...fixture.nativeActiveProposalLineage,
    proposalRevisions: fixture.nativeActiveProposalLineage.proposalRevisions.map(proposal => ({
      ...proposal,
      projectScopeBinding: {
        workspaceId: currentScope.workspaceId,
        scopeIdentityDigest: deriveProjectScopeIdentityDigest('D:\\repo'),
      },
    })),
  })
  if (lineage.origin !== 'RUN2SKILL_V2') throw new Error('expected native v2 lineage')
  await domain.table('session_batches').put(
    fixture.sessionBatch.batchId,
    SessionBatchV2Schema.parse(fixture.sessionBatch),
  )
  await domain.table('experience_intents').put(fixture.proposalReadyIntent.intentId, fixture.proposalReadyIntent)
  await domain.table('proposal_lineages').put(lineage.lineageId, lineage)
  return { domain, fixture, lineage }
}

function currentCatalog(domain: ReturnType<typeof createMemoryRun2skillV2Domain>) {
  const global = domain.global.get()
  return {
    status: 'CURRENT' as const,
    runtimeCatalogDigest: '1'.repeat(64),
    pendingCatalogDigest: '2'.repeat(64),
    catalogEpoch: global.proposalCatalogEpoch,
    catalogMutationReceiptDigest: global.proposalCatalogLastMutation.digest,
  }
}

function createHandler(
  seeded: Awaited<ReturnType<typeof seed>>,
  options: {
    readonly firstPublicationUnavailable?: boolean
    readonly publicationServiceUnavailable?: boolean
  } = {},
) {
  const published = options.firstPublicationUnavailable
    ? vi.fn()
        .mockResolvedValueOnce({ status: 'UNAVAILABLE' as const })
        .mockResolvedValue({ status: 'PUBLISHED' as const, externalReceiptDigest: '5'.repeat(64) })
    : vi.fn(async () => ({
        status: 'PUBLISHED' as const,
        externalReceiptDigest: '5'.repeat(64),
      }))
  const fallback = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'not-found' as const, message: 'legacy fallback', details: {} },
  }))
  const authorizer = new V2CurrentScopeAuthorizer(async workspaceId => (
    workspaceId === currentScope.workspaceId
      ? { workspaceId, canonicalPath: 'D:\\repo' }
      : undefined
  ))
  const handler = createV2ProposalRpcHandler(() => seeded.domain, {
    authorizer,
    reviews: domain => new V2ProposalReviewCoordinator(domain, {
      revalidate: async () => currentCatalog(domain as ReturnType<typeof createMemoryRun2skillV2Domain>),
      now: () => NOW,
    }),
    present: async ({ lineage, proposal, intent, batch }) => ({
      proposal: safeProposalSchema.parse({
        schemaVersion: 1,
        revision: proposal.revision,
        createdAt: proposal.createdAt,
        sourceLearningProposalId: `lp_${'1'.repeat(64)}`,
        kind: proposal.action,
        name: proposal.body.name,
        description: proposal.body.description,
        whenToUse: proposal.body.whenToUse,
        invocation: { modelInvocable: true, userInvocable: false },
        exactSkillBytes: proposal.body.exactSkillBytes,
        skillBytesDigest: proposal.body.skillBytesDigest,
        rendererVersion: 'v2-compatible-presenter-v1',
        persistenceScope: lineage.persistenceScope,
        workspaceBinding: { workspaceId: currentScope.workspaceId },
        supportingExperienceIds: [`exp_${'2'.repeat(64)}`],
        catalogObservationDigest: proposal.runtimeCatalogDigest,
        curationRationale: 'Generated from the complete v2 session evidence.',
        actionBinding: {
          kind: 'CREATE',
          rootBinding: {
            state: 'EXISTING',
            scope: 'PROJECT',
            expectedProvider: 'filesystem',
            expectedSource: 'project-dsh',
            resolverVersion: 'v2-compatible-presenter-v1',
            rootContractVersion: 'dsh-stock-v1',
            resolutionContractDigest: '3'.repeat(64),
          },
          targetBinding: { skillName: proposal.body.name },
          expectedAbsence: { observedAt: proposal.createdAt },
        },
        proposalId: proposal.proposalId,
        digest: '4'.repeat(64),
      }),
      sessionCoordinate: {
        rootSessionId: intent.sessionLifecycleKey,
        sessionCreatedAt: 0,
        turn: 0,
        turnEndSeq: batch.lastTurnEndSeq,
      },
      evidenceRefs: [],
      experiences: [],
    }),
    publications: domain => options.publicationServiceUnavailable
      ? undefined
      : new V2ProposalPublicationCoordinator(domain, {
          revalidate: async () => currentCatalog(domain as ReturnType<typeof createMemoryRun2skillV2Domain>),
          publish: published,
          now: () => NOW,
        }),
  }, fallback)
  return { handler, fallback, published }
}

async function attentionAction(handler: ReturnType<typeof createHandler>['handler']) {
  const response = await handler(ATTENTION_ENDPOINT, {
    apiVersion: 1,
    currentScope,
  }, new AbortController().signal)
  expect(response).toMatchObject({ ok: true, value: { actions: { length: 1 } } })
  if (!response.ok) throw new Error('expected v2 Attention response')
  const value = response.value as {
    actions: Array<{
      actionKey: string
      subjectId: string
      kind: 'REVIEW_PROPOSAL' | 'RETRY_PUBLICATION'
      proposalRef: { proposalId: string; revision: number; digest: string }
    }>
  }
  const { actionKey, subjectId, kind, proposalRef } = value.actions[0]!
  return { actionKey, subjectId, kind, proposalRef }
}

describe('v2 Proposal RPC compatibility bridge', () => {
  it('delegates to v1 until the v2 migration activation is committed', async () => {
    const seeded = await seed({ committed: false })
    const { handler, fallback } = createHandler(seeded)

    await expect(handler(PROPOSALS_LIST_ENDPOINT, {
      apiVersion: 1, currentScope,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false, error: { message: 'legacy fallback' },
    })
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('lists and presents an activated native v2 Proposal through the existing RPC contract', async () => {
    const seeded = await seed()
    const { handler, fallback } = createHandler(seeded)
    const action = await attentionAction(handler)

    await expect(handler(PROPOSALS_LIST_ENDPOINT, {
      apiVersion: 1, currentScope,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: {
        items: [{
          workItemId: action.subjectId,
          workItemRevision: seeded.lineage.revision,
          proposalRef: action.proposalRef,
          kind: 'CREATE',
          processingState: 'READY_FOR_REVIEW',
          publicationOutcome: 'PENDING_REVIEW',
        }],
      },
    })
    await expect(handler(PROPOSALS_GET_ENDPOINT, {
      apiVersion: 1,
      currentScope,
      action,
      proposalId: seeded.lineage.proposalRevisions[0]!.proposalId,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: {
        workItemId: action.subjectId,
        proposal: {
          name: 'fixture-v2',
          exactSkillBytes: seeded.lineage.proposalRevisions[0]!.body.exactSkillBytes,
        },
      },
    })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('approves once, requests publication with the durable new revision, and rejects the stale action', async () => {
    const seeded = await seed()
    const { handler, published } = createHandler(seeded)
    const action = await attentionAction(handler)
    const request = {
      apiVersion: 1 as const,
      workItemId: action.subjectId,
      workItemRevision: seeded.lineage.revision,
      proposalRef: action.proposalRef,
      currentScope,
      action,
    }

    const approved = await handler(PROPOSALS_APPROVE_ENDPOINT, request, new AbortController().signal)
    expect(approved).toMatchObject({
      ok: true,
      value: {
        changed: true,
        workItemRevision: seeded.lineage.revision + 2,
        processingState: 'TERMINAL',
        reviewDecision: 'APPROVED',
        publicationOutcome: 'PUBLISHED',
      },
    })
    expect(published).toHaveBeenCalledOnce()
    expect(published).toHaveBeenCalledWith(expect.objectContaining({
      lineage: expect.objectContaining({ lineageId: seeded.lineage.lineageId }),
      proposalRef: action.proposalRef,
      attemptId: expect.stringMatching(/^pcm_[a-f0-9]{64}$/),
    }))

    await expect(handler(PROPOSALS_APPROVE_ENDPOINT, request, new AbortController().signal)).resolves.toMatchObject({
      ok: false, error: { code: 'conflict' },
    })
    expect(published).toHaveBeenCalledOnce()
  })

  it('retains one uncertain attempt and recovers it through the retry action without a duplicate write id', async () => {
    const seeded = await seed()
    const { handler, published } = createHandler(seeded, { firstPublicationUnavailable: true })
    const reviewAction = await attentionAction(handler)
    const reviewRequest = {
      apiVersion: 1 as const,
      workItemId: reviewAction.subjectId,
      workItemRevision: seeded.lineage.revision,
      proposalRef: reviewAction.proposalRef,
      currentScope,
      action: reviewAction,
    }

    await expect(handler(PROPOSALS_APPROVE_ENDPOINT, reviewRequest, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: {
        workItemRevision: seeded.lineage.revision + 2,
        processingState: 'NEEDS_ATTENTION',
        publicationOutcome: 'PUBLISH_FAILED',
      },
    })
    const retryAction = await attentionAction(handler)
    expect(retryAction).toMatchObject({ kind: 'RETRY_PUBLICATION' })
    const retainedAttemptId = published.mock.calls[0]?.[0].attemptId

    await expect(handler('proposals/retry', {
      apiVersion: 1,
      workItemId: retryAction.subjectId,
      workItemRevision: seeded.lineage.revision + 2,
      proposalRef: retryAction.proposalRef,
      currentScope,
      action: retryAction,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: {
        processingState: 'TERMINAL',
        publicationOutcome: 'PUBLISHED',
      },
    })
    expect(published).toHaveBeenCalledTimes(2)
    expect(published.mock.calls[1]?.[0].attemptId).toBe(retainedAttemptId)
  })

  it('keeps an approved Proposal actionable when publication handoff is unavailable', async () => {
    const seeded = await seed()
    const { handler, published } = createHandler(seeded, { publicationServiceUnavailable: true })
    const reviewAction = await attentionAction(handler)

    await expect(handler(PROPOSALS_APPROVE_ENDPOINT, {
      apiVersion: 1,
      workItemId: reviewAction.subjectId,
      workItemRevision: seeded.lineage.revision,
      proposalRef: reviewAction.proposalRef,
      currentScope,
      action: reviewAction,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false, error: { code: 'internal' },
    })
    await expect(attentionAction(handler)).resolves.toMatchObject({
      kind: 'RETRY_PUBLICATION',
    })
    expect(published).not.toHaveBeenCalled()
  })
})
