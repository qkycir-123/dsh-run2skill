import { describe, expect, it } from 'vitest'
import { derivePendingProposalCatalogV2 } from '../src/adapters/dsh-storage/v2-pending-catalog.js'
import {
  V2ProposalReviewCoordinator,
  deriveV2ProposalRef,
} from '../src/application/review/v2-proposal-review.js'
import { canonicalJson } from '../src/domain/learn/identity.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import {
  GlobalV2Schema,
  ProposalLineageV2Schema,
  SessionBatchV2Schema,
  deriveProposalCatalogMutationAnchorV2,
  deriveProposalCatalogMutationIdV2,
  deriveProposalReviewReceiptDigestV2,
} from '../src/domain/v2/index.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

const NOW = '2026-08-23T03:00:00.000Z'

async function seed() {
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
  await domain.table('turn_observations').put(fixture.turnObservation.observationId, fixture.turnObservation)
  await domain.table('session_batches').put(
    fixture.sessionBatch.batchId,
    SessionBatchV2Schema.parse(fixture.sessionBatch),
  )
  await domain.table('experience_intents').put(fixture.proposalReadyIntent.intentId, fixture.proposalReadyIntent)
  await domain.table('proposal_lineages').put(
    fixture.nativeActiveProposalLineage.lineageId,
    fixture.nativeActiveProposalLineage,
  )
  const lineage = ProposalLineageV2Schema.parse(fixture.nativeActiveProposalLineage)
  if (lineage.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
  return { domain, fixture, lineage, proposalRef: deriveV2ProposalRef(lineage) }
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

describe('v2 Proposal review coordinator', () => {
  it('approves only after a complete Catalog revalidation and keeps the Proposal in duplicate recall', async () => {
    const seeded = await seed()
    const coordinator = new V2ProposalReviewCoordinator(seeded.domain, {
      revalidate: async () => currentCatalog(seeded.domain),
      now: () => NOW,
    })

    const approved = await coordinator.approve({
      lineageId: seeded.lineage.lineageId,
      expectedLineageRevision: seeded.lineage.revision,
      proposalRef: seeded.proposalRef,
    })

    expect(approved).toMatchObject({ changed: true, state: 'APPROVED' })
    expect(approved.lineage.revision).toBe(seeded.lineage.revision + 1)
    expect(approved.lineage.proposalRevisions.at(-1)).toMatchObject({
      reviewDecision: 'APPROVED',
      reviewedAt: NOW,
      reviewCatalog: currentCatalog(seeded.domain),
    })
    expect(derivePendingProposalCatalogV2(seeded.domain, seeded.fixture.proposalReadyIntent).entries)
      .toHaveLength(1)
    expect(seeded.domain.global.get().proposalCatalogEpoch).toBe(0)

    await expect(coordinator.approve({
      lineageId: approved.lineage.lineageId,
      expectedLineageRevision: seeded.lineage.revision,
      proposalRef: seeded.proposalRef,
    })).resolves.toMatchObject({ changed: false, state: 'APPROVED' })
  })

  it('recovers an approved journal when the original request is retried after finalize failures', async () => {
    const seeded = await seed()
    const durableSet = seeded.domain.global.set.bind(seeded.domain.global)
    let remainingFinalizeFailures = 2
    seeded.domain.global.set = async value => {
      if (
        remainingFinalizeFailures > 0
        && seeded.domain.global.get().proposalCatalogMutationJournal?.kind === 'REVIEW'
        && value.proposalCatalogMutationJournal === undefined
      ) {
        remainingFinalizeFailures -= 1
        throw new Error('synthetic review finalize failure')
      }
      await durableSet(value)
    }
    const coordinator = new V2ProposalReviewCoordinator(seeded.domain, {
      revalidate: async () => currentCatalog(seeded.domain),
      now: () => NOW,
    })
    const request = {
      lineageId: seeded.lineage.lineageId,
      expectedLineageRevision: seeded.lineage.revision,
      proposalRef: seeded.proposalRef,
    }

    await expect(coordinator.approve(request)).rejects.toThrow('synthetic review finalize failure')
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toMatchObject({ kind: 'REVIEW' })

    await expect(coordinator.approve(request)).resolves.toMatchObject({ changed: false, state: 'APPROVED' })
    expect(seeded.domain.global.get().proposalCatalogEpoch).toBe(0)
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toBeUndefined()
  })

  it('does not approve when the Catalog changes after revalidation', async () => {
    const seeded = await seed()
    const coordinator = new V2ProposalReviewCoordinator(seeded.domain, {
      revalidate: async () => {
        const observed = currentCatalog(seeded.domain)
        const anchor = deriveProposalCatalogMutationAnchorV2({
          ownerId: 'external-publication', kind: 'PUBLICATION', inputCatalogEpoch: 0,
        })
        await seeded.domain.global.set(GlobalV2Schema.parse({
          ...seeded.domain.global.get(),
          proposalCatalogEpoch: anchor.epoch,
          proposalCatalogLastMutation: anchor,
        }))
        return observed
      },
      now: () => NOW,
    })

    const result = await coordinator.approve({
      lineageId: seeded.lineage.lineageId,
      expectedLineageRevision: seeded.lineage.revision,
      proposalRef: seeded.proposalRef,
    })

    expect(result).toMatchObject({ changed: true, state: 'NEEDS_ATTENTION' })
    expect(result.lineage.proposalRevisions.at(-1)).toMatchObject({
      reviewFailureCode: 'CATALOG_CHANGED',
    })
    expect(result.lineage.proposalRevisions.at(-1)?.reviewDecision).toBeUndefined()
  })

  it('keeps a stale or unavailable Proposal active and visible instead of approving it', async () => {
    const seeded = await seed()
    const coordinator = new V2ProposalReviewCoordinator(seeded.domain, {
      revalidate: async () => ({ status: 'STALE' }),
      now: () => NOW,
    })

    const result = await coordinator.approve({
      lineageId: seeded.lineage.lineageId,
      expectedLineageRevision: seeded.lineage.revision,
      proposalRef: seeded.proposalRef,
    })

    expect(result).toMatchObject({ changed: true, state: 'NEEDS_ATTENTION' })
    expect(result.lineage.state).toBe('ACTIVE_PROPOSAL')
    expect(result.lineage.proposalRevisions.at(-1)).toMatchObject({
      reviewFailureCode: 'CATALOG_CHANGED',
      reviewAttemptedAt: NOW,
    })
    expect(result.lineage.proposalRevisions.at(-1)?.reviewDecision).toBeUndefined()
    expect(derivePendingProposalCatalogV2(seeded.domain, seeded.fixture.proposalReadyIntent).entries)
      .toHaveLength(1)
  })

  it('rejects with one journaled Catalog membership mutation and is idempotent', async () => {
    const seeded = await seed()
    const coordinator = new V2ProposalReviewCoordinator(seeded.domain, {
      revalidate: async () => { throw new Error('reject must not call Catalog revalidation') },
      now: () => NOW,
    })

    const rejected = await coordinator.reject({
      lineageId: seeded.lineage.lineageId,
      expectedLineageRevision: seeded.lineage.revision,
      proposalRef: seeded.proposalRef,
    })

    expect(rejected).toMatchObject({ changed: true, state: 'REJECTED' })
    expect(rejected.lineage).toMatchObject({ state: 'TERMINAL', revision: seeded.lineage.revision + 1 })
    expect(rejected.lineage.proposalRevisions.at(-1)).toMatchObject({
      state: 'TERMINAL', reviewDecision: 'REJECTED', reviewedAt: NOW,
    })
    expect(derivePendingProposalCatalogV2(seeded.domain, seeded.fixture.proposalReadyIntent).entries)
      .toHaveLength(0)
    expect(seeded.domain.global.get()).toMatchObject({
      proposalCatalogEpoch: 1,
      proposalCatalogLastMutation: {
        kind: 'REVIEW', ownerId: seeded.proposalRef.proposalId, epoch: 1,
      },
    })
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toBeUndefined()

    await expect(coordinator.reject({
      lineageId: rejected.lineage.lineageId,
      expectedLineageRevision: rejected.lineage.revision,
      proposalRef: seeded.proposalRef,
    })).resolves.toMatchObject({ changed: false, state: 'REJECTED' })
  })

  it('finishes the rejection journal when an idempotent retry follows a finalize write failure', async () => {
    const seeded = await seed()
    const durableSet = seeded.domain.global.set.bind(seeded.domain.global)
    let remainingFinalizeFailures = 2
    seeded.domain.global.set = async value => {
      if (
        remainingFinalizeFailures > 0
        && seeded.domain.global.get().proposalCatalogMutationJournal?.kind === 'REVIEW'
        && value.proposalCatalogMutationJournal === undefined
      ) {
        remainingFinalizeFailures -= 1
        throw new Error('synthetic review finalize failure')
      }
      await durableSet(value)
    }
    const coordinator = new V2ProposalReviewCoordinator(seeded.domain, {
      revalidate: async () => currentCatalog(seeded.domain),
      now: () => NOW,
    })

    await expect(coordinator.reject({
      lineageId: seeded.lineage.lineageId,
      expectedLineageRevision: seeded.lineage.revision,
      proposalRef: seeded.proposalRef,
    })).rejects.toThrow('synthetic review finalize failure')
    const rejected = ProposalLineageV2Schema.parse(
      seeded.domain.table('proposal_lineages').get(seeded.lineage.lineageId),
    )
    expect(rejected).toMatchObject({ state: 'TERMINAL', revision: seeded.lineage.revision + 1 })
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toMatchObject({ kind: 'REVIEW' })

    await expect(coordinator.reject({
      lineageId: rejected.lineageId,
      expectedLineageRevision: seeded.lineage.revision,
      proposalRef: seeded.proposalRef,
    })).resolves.toMatchObject({ changed: false, state: 'REJECTED' })
    expect(seeded.domain.global.get()).toMatchObject({
      proposalCatalogEpoch: 1,
      proposalCatalogLastMutation: { kind: 'REVIEW', ownerId: seeded.proposalRef.proposalId },
    })
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toBeUndefined()
  })

  it('finishes a durable rejected lineage after a crash left the review journal prepared', async () => {
    const seeded = await seed()
    const latest = seeded.lineage.proposalRevisions.at(-1)!
    const receipt = deriveProposalReviewReceiptDigestV2({
      proposalRef: seeded.proposalRef,
      decision: 'REJECTED',
      reviewedAt: NOW,
    })
    await seeded.domain.table('proposal_lineages').put(seeded.lineage.lineageId, ProposalLineageV2Schema.parse({
      ...seeded.lineage,
      revision: seeded.lineage.revision + 1,
      state: 'TERMINAL',
      updatedAt: NOW,
      proposalRevisions: [{
        ...latest,
        state: 'TERMINAL',
        reviewDecision: 'REJECTED',
        reviewedAt: NOW,
        reviewReceiptDigest: receipt,
      }],
    }))
    const mutationId = deriveProposalCatalogMutationIdV2({
      ownerId: seeded.proposalRef.proposalId,
      kind: 'REVIEW',
      inputCatalogEpoch: 0,
    })
    await seeded.domain.global.set(GlobalV2Schema.parse({
      ...seeded.domain.global.get(),
      proposalCatalogMutationJournal: {
        schemaVersion: 1,
        mutationId,
        ownerId: seeded.proposalRef.proposalId,
        kind: 'REVIEW',
        phase: 'PREPARED',
        preparedAt: NOW,
      },
    }))
    const coordinator = new V2ProposalReviewCoordinator(seeded.domain, {
      revalidate: async () => currentCatalog(seeded.domain),
      now: () => NOW,
    })

    await expect(coordinator.recover()).resolves.toBe('RECOVERED')
    expect(seeded.domain.global.get()).toMatchObject({
      proposalCatalogEpoch: 1,
      proposalCatalogLastMutation: { kind: 'REVIEW', ownerId: seeded.proposalRef.proposalId },
    })
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toBeUndefined()
  })

  it('clears a prepared review journal after an approved lineage was already persisted', async () => {
    const seeded = await seed()
    const latest = seeded.lineage.proposalRevisions.at(-1)!
    const reviewCatalog = currentCatalog(seeded.domain)
    const receipt = deriveProposalReviewReceiptDigestV2({
      proposalRef: seeded.proposalRef,
      decision: 'APPROVED',
      reviewedAt: NOW,
      reviewCatalog,
    })
    await seeded.domain.table('proposal_lineages').put(seeded.lineage.lineageId, ProposalLineageV2Schema.parse({
      ...seeded.lineage,
      revision: seeded.lineage.revision + 1,
      updatedAt: NOW,
      proposalRevisions: [{
        ...latest,
        reviewDecision: 'APPROVED',
        reviewedAt: NOW,
        reviewReceiptDigest: receipt,
        reviewCatalog,
      }],
    }))
    const mutationId = deriveProposalCatalogMutationIdV2({
      ownerId: seeded.proposalRef.proposalId,
      kind: 'REVIEW',
      inputCatalogEpoch: 0,
    })
    await seeded.domain.global.set(GlobalV2Schema.parse({
      ...seeded.domain.global.get(),
      proposalCatalogMutationJournal: {
        schemaVersion: 1,
        mutationId,
        ownerId: seeded.proposalRef.proposalId,
        kind: 'REVIEW',
        phase: 'PREPARED',
        preparedAt: NOW,
      },
    }))
    const coordinator = new V2ProposalReviewCoordinator(seeded.domain, {
      revalidate: async () => currentCatalog(seeded.domain),
      now: () => NOW,
    })

    await expect(coordinator.recover()).resolves.toBe('RECOVERED')
    expect(seeded.domain.global.get().proposalCatalogEpoch).toBe(0)
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toBeUndefined()
    expect(seeded.domain.table('proposal_lineages').get(seeded.lineage.lineageId))
      .toMatchObject({ revision: seeded.lineage.revision + 1, state: 'ACTIVE_PROPOSAL' })
  })

  it('fails closed on stale refs, revisions, or a concurrent generation lease', async () => {
    const seeded = await seed()
    const coordinator = new V2ProposalReviewCoordinator(seeded.domain, {
      revalidate: async () => currentCatalog(seeded.domain),
      now: () => NOW,
    })

    await expect(coordinator.approve({
      lineageId: seeded.lineage.lineageId,
      expectedLineageRevision: seeded.lineage.revision + 1,
      proposalRef: seeded.proposalRef,
    })).rejects.toThrow(/REVIEW_REVISION_CONFLICT/)
    await expect(coordinator.approve({
      lineageId: seeded.lineage.lineageId,
      expectedLineageRevision: seeded.lineage.revision,
      proposalRef: { ...seeded.proposalRef, digest: 'f'.repeat(64) },
    })).rejects.toThrow(/STALE_PROPOSAL_REF/)

    const fixtureLease = seeded.fixture.proposalReadyIntent.generation
    await seeded.domain.global.set(GlobalV2Schema.parse({
      ...seeded.domain.global.get(),
      proposalGenerationLease: {
        schemaVersion: 1,
        leaseId: fixtureLease.leaseId,
        ownerIntentId: seeded.fixture.proposalReadyIntent.intentId,
        ownerRevision: seeded.fixture.proposalReadyIntent.revision,
        generationRevision: fixtureLease.generationRevision,
        action: fixtureLease.action,
        inputDigest: fixtureLease.inputDigest,
        externalPendingDigest: fixtureLease.externalPendingDigest,
        catalogEpoch: fixtureLease.catalogEpoch,
        acquiredAt: NOW,
        state: 'NOT_CALLED',
      },
    }))
    await expect(coordinator.reject({
      lineageId: seeded.lineage.lineageId,
      expectedLineageRevision: seeded.lineage.revision,
      proposalRef: seeded.proposalRef,
    })).rejects.toThrow(/REVIEW_BUSY/)
  })
})
