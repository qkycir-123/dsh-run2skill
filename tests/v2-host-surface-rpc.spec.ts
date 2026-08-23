import { describe, expect, it } from 'vitest'
import { createV2RecentSkillActivityRpcHandler } from '../src/adapters/dsh-connection/v2-recent-skill-activity-rpc.js'
import { V2PurgeService } from '../src/application/purge/index.js'
import { V2ProposalPublicationCoordinator } from '../src/application/publication/index.js'
import { V2ProposalReviewCoordinator, deriveV2ProposalRef } from '../src/application/review/index.js'
import { deriveProjectScopeIdentityDigest } from '../src/domain/purge/index.js'
import {
  ExperienceIntentV2Schema,
  GlobalV2Schema,
  ProposalLineageV2Schema,
  SessionBatchV2Schema,
} from '../src/domain/v2/index.js'
import { canonicalJson } from '../src/domain/learn/identity.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

const NOW = '2026-08-23T12:00:00.000Z'

describe('v2 settings Host surfaces', () => {
  it('derives recent activity from a published native v2 Skill', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const fixture = createMinimalV2Fixtures()
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
    const active = ProposalLineageV2Schema.parse({
      ...fixture.nativeActiveProposalLineage,
      proposalRevisions: fixture.nativeActiveProposalLineage.proposalRevisions.map(proposal => ({
        ...proposal,
        projectScopeBinding: {
          workspaceId: 'workspace-v2',
          scopeIdentityDigest: deriveProjectScopeIdentityDigest('D:/workspace'),
        },
      })),
    })
    if (active.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
    await domain.table('session_batches').put(
      fixture.sessionBatch.batchId,
      SessionBatchV2Schema.parse(fixture.sessionBatch),
    )
    await domain.table('experience_intents').put(
      fixture.proposalReadyIntent.intentId,
      ExperienceIntentV2Schema.parse(fixture.proposalReadyIntent),
    )
    await domain.table('proposal_lineages').put(active.lineageId, active)
    const currentCatalog = () => ({
      status: 'CURRENT' as const,
      runtimeCatalogDigest: active.proposalRevisions[0]!.runtimeCatalogDigest,
      pendingCatalogDigest: active.proposalRevisions[0]!.pendingCatalogDigest,
      catalogEpoch: domain.global.get().proposalCatalogEpoch,
      catalogMutationReceiptDigest: domain.global.get().proposalCatalogLastMutation.digest,
    })
    const reviews = new V2ProposalReviewCoordinator(domain, { revalidate: async () => currentCatalog(), now: () => NOW })
    const approved = await reviews.approve({
      lineageId: active.lineageId,
      expectedLineageRevision: active.revision,
      proposalRef: deriveV2ProposalRef(active),
    })
    const publications = new V2ProposalPublicationCoordinator(domain, {
      revalidate: async () => currentCatalog(),
      publish: async () => ({ status: 'PUBLISHED', externalReceiptDigest: '5'.repeat(64) }),
      recover: async () => ({ status: 'PUBLISHED', externalReceiptDigest: '5'.repeat(64) }),
      now: () => NOW,
    })
    await publications.publish({
      lineageId: approved.lineage.lineageId,
      expectedLineageRevision: approved.lineage.revision,
      proposalRef: deriveV2ProposalRef(approved.lineage),
    })
    const handler = createV2RecentSkillActivityRpcHandler(
      () => domain,
      async workspaceId => ({ workspaceId, canonicalPath: 'D:/workspace' }),
      undefined,
      () => NOW,
    )
    const response = await handler('recent-activity/list', {
      apiVersion: 1,
      currentScope: { kind: 'WORKSPACE', generation: 1, workspaceId: 'workspace-v2' },
    }, new AbortController().signal)

    expect(response).toMatchObject({
      ok: true,
      value: {
        items: [{
          skillName: active.proposalRevisions[0]!.body.name,
          operation: 'CREATED',
          scope: 'PROJECT',
          occurredAt: NOW,
        }],
      },
    })
  })

  it('clears only v2 cache records while preserving activation and advancing the catalog epoch', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const fixture = createMinimalV2Fixtures()
    await domain.table('turn_observations').put(fixture.turnObservation.observationId, fixture.turnObservation)
    await domain.table('session_batches').put(fixture.sessionBatch.batchId, SessionBatchV2Schema.parse(fixture.sessionBatch))
    await domain.table('experience_intents').put(
      fixture.experienceIntent.intentId,
      ExperienceIntentV2Schema.parse(fixture.experienceIntent),
    )
    await domain.table('proposal_lineages').put(fixture.nativeActiveProposalLineage.lineageId, fixture.nativeActiveProposalLineage)
    const beforeEpoch = domain.global.get().proposalCatalogEpoch
    const service = new V2PurgeService(domain, () => Date.parse('2026-08-24T00:00:00.000Z'))
    const preview = await service.preview('ALL')
    const receipt = await service.confirm(preview.previewId, preview.digest, { scope: 'ALL' })

    expect(receipt).toMatchObject({ state: 'COMPLETED', deletedWorkItems: 1, deletedLineages: 1 })
    expect(domain.turnObservations.size).toBe(0)
    expect(domain.sessionBatches.size).toBe(0)
    expect(domain.experienceIntents.size).toBe(0)
    expect(domain.proposalLineages.size).toBe(0)
    expect(domain.global.get()).toMatchObject({
      migration: fixture.global.migration,
      proposalCatalogEpoch: beforeEpoch + 1,
    })
    expect(domain.global.get().purgeJournal).toBeUndefined()
  })

  it('rejects a stale clear preview instead of deleting newly changed cache facts', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const fixture = createMinimalV2Fixtures()
    const service = new V2PurgeService(domain, () => Date.parse('2026-08-24T00:00:00.000Z'))
    const preview = await service.preview('ALL')
    await domain.table('turn_observations').put(fixture.turnObservation.observationId, fixture.turnObservation)

    await expect(service.confirm(preview.previewId, preview.digest, { scope: 'ALL' }))
      .rejects.toMatchObject({ code: 'PURGE_PREVIEW_STALE' })
    expect(domain.turnObservations.size).toBe(1)
  })
})
