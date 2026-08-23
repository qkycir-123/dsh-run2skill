import { describe, expect, it, vi } from 'vitest'
import { derivePendingProposalCatalogV2 } from '../src/adapters/dsh-storage/v2-pending-catalog.js'
import {
  V2ProposalPublicationCoordinator,
} from '../src/application/publication/v2-proposal-publication.js'
import { deriveV2ProposalRef } from '../src/application/review/v2-proposal-review.js'
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

const NOW = '2026-08-23T05:00:00.000Z'
const EXTERNAL_RECEIPT = 'f'.repeat(64)

async function seedApproved() {
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
  const pending = ProposalLineageV2Schema.parse(fixture.nativeActiveProposalLineage)
  if (pending.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
  const proposalRef = deriveV2ProposalRef(pending)
  const proposal = pending.proposalRevisions.at(-1)!
  const reviewCatalog = {
    status: 'CURRENT' as const,
    runtimeCatalogDigest: domain.global.get().proposalCatalogLastMutation.digest,
    pendingCatalogDigest: '2'.repeat(64),
    catalogEpoch: domain.global.get().proposalCatalogEpoch,
    catalogMutationReceiptDigest: domain.global.get().proposalCatalogLastMutation.digest,
  }
  const reviewedAt = NOW
  const approved = ProposalLineageV2Schema.parse({
    ...pending,
    revision: pending.revision + 1,
    updatedAt: reviewedAt,
    proposalRevisions: [{
      ...proposal,
      reviewDecision: 'APPROVED',
      reviewedAt,
      reviewCatalog,
      reviewReceiptDigest: deriveProposalReviewReceiptDigestV2({
        proposalRef, decision: 'APPROVED', reviewedAt, reviewCatalog,
      }),
    }],
  })
  if (approved.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
  await domain.table('proposal_lineages').put(approved.lineageId, approved)
  return { domain, fixture, lineage: approved, proposalRef }
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

describe('v2 Proposal publication coordinator', () => {
  it('publishes an approved Proposal exactly once and removes it from duplicate recall', async () => {
    const seeded = await seedApproved()
    const publish = vi.fn(async () => ({ status: 'PUBLISHED' as const, externalReceiptDigest: EXTERNAL_RECEIPT }))
    const coordinator = new V2ProposalPublicationCoordinator(seeded.domain, {
      revalidate: async () => currentCatalog(seeded.domain), publish, now: () => NOW,
    })
    const request = {
      lineageId: seeded.lineage.lineageId,
      expectedLineageRevision: seeded.lineage.revision,
      proposalRef: seeded.proposalRef,
    }

    const result = await coordinator.publish(request)

    expect(result).toMatchObject({ changed: true, state: 'PUBLISHED' })
    expect(result.lineage).toMatchObject({ state: 'PUBLISHED', revision: seeded.lineage.revision + 1 })
    expect(result.lineage.proposalRevisions.at(-1)).toMatchObject({
      state: 'PUBLISHED', publishedAt: NOW, publicationExternalReceiptDigest: EXTERNAL_RECEIPT,
    })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(seeded.domain.global.get()).toMatchObject({
      proposalCatalogEpoch: 1,
      proposalCatalogLastMutation: { kind: 'PUBLICATION', ownerId: seeded.proposalRef.proposalId },
    })
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toBeUndefined()
    expect(derivePendingProposalCatalogV2(seeded.domain, seeded.fixture.proposalReadyIntent).entries)
      .toHaveLength(0)

    await expect(coordinator.publish(request)).resolves.toMatchObject({ changed: false, state: 'PUBLISHED' })
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('does not call the filesystem when Catalog revalidation is stale', async () => {
    const seeded = await seedApproved()
    const publish = vi.fn(async () => ({ status: 'PUBLISHED' as const, externalReceiptDigest: EXTERNAL_RECEIPT }))
    const coordinator = new V2ProposalPublicationCoordinator(seeded.domain, {
      revalidate: async () => ({ status: 'STALE' as const }), publish, now: () => NOW,
    })

    const result = await coordinator.publish({
      lineageId: seeded.lineage.lineageId,
      expectedLineageRevision: seeded.lineage.revision,
      proposalRef: seeded.proposalRef,
    })

    expect(result).toMatchObject({ changed: true, state: 'NEEDS_ATTENTION' })
    expect(result.lineage.proposalRevisions.at(-1)).toMatchObject({
      publicationFailureCode: 'CATALOG_CHANGED', publicationAttemptedAt: NOW,
    })
    expect(publish).not.toHaveBeenCalled()
    expect(seeded.domain.global.get().proposalCatalogEpoch).toBe(0)

    await expect(coordinator.publish({
      lineageId: result.lineage.lineageId,
      expectedLineageRevision: result.lineage.revision,
      proposalRef: seeded.proposalRef,
    })).rejects.toMatchObject({ code: 'INVALID_PUBLICATION_STATE' })
    expect(publish).not.toHaveBeenCalled()
  })

  it('does not publish when the Catalog changes after revalidation', async () => {
    const seeded = await seedApproved()
    const publish = vi.fn(async () => ({ status: 'PUBLISHED' as const, externalReceiptDigest: EXTERNAL_RECEIPT }))
    const coordinator = new V2ProposalPublicationCoordinator(seeded.domain, {
      revalidate: async () => {
        const observed = currentCatalog(seeded.domain)
        const anchor = deriveProposalCatalogMutationAnchorV2({
          ownerId: 'external-change', kind: 'PURGE', inputCatalogEpoch: observed.catalogEpoch,
        })
        await seeded.domain.global.set(GlobalV2Schema.parse({
          ...seeded.domain.global.get(),
          proposalCatalogEpoch: anchor.epoch,
          proposalCatalogLastMutation: anchor,
        }))
        return observed
      },
      publish,
      now: () => NOW,
    })

    const result = await coordinator.publish({
      lineageId: seeded.lineage.lineageId,
      expectedLineageRevision: seeded.lineage.revision,
      proposalRef: seeded.proposalRef,
    })

    expect(result).toMatchObject({ changed: true, state: 'NEEDS_ATTENTION' })
    expect(publish).not.toHaveBeenCalled()
  })

  it('keeps the approved Proposal active when the exact filesystem transaction cannot complete', async () => {
    const seeded = await seedApproved()
    const coordinator = new V2ProposalPublicationCoordinator(seeded.domain, {
      revalidate: async () => currentCatalog(seeded.domain),
      publish: async () => ({ status: 'CONFLICT' as const }),
      now: () => NOW,
    })

    const result = await coordinator.publish({
      lineageId: seeded.lineage.lineageId,
      expectedLineageRevision: seeded.lineage.revision,
      proposalRef: seeded.proposalRef,
    })

    expect(result).toMatchObject({ changed: true, state: 'NEEDS_ATTENTION' })
    expect(result.lineage.state).toBe('ACTIVE_PROPOSAL')
    expect(result.lineage.proposalRevisions.at(-1)).toMatchObject({
      reviewDecision: 'APPROVED', publicationFailureCode: 'PUBLICATION_CONFLICT',
    })
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toBeUndefined()
    expect(seeded.domain.global.get().proposalCatalogEpoch).toBe(0)

    await expect(coordinator.publish({
      lineageId: result.lineage.lineageId,
      expectedLineageRevision: result.lineage.revision,
      proposalRef: seeded.proposalRef,
    })).rejects.toMatchObject({ code: 'INVALID_PUBLICATION_STATE' })
  })

  it('durably fences a non-retryable outcome before recording it on the lineage', async () => {
    const seeded = await seedApproved()
    const lineages = seeded.domain.table('proposal_lineages')
    const durableUpdate = lineages.update.bind(lineages)
    let blockLineageWrites = true
    lineages.update = async (key, transform) => {
      if (blockLineageWrites) throw new Error('synthetic failure after refresh fence')
      return await durableUpdate(key, transform)
    }
    const coordinator = new V2ProposalPublicationCoordinator(seeded.domain, {
      revalidate: async () => currentCatalog(seeded.domain),
      publish: async () => ({ status: 'CONFLICT' as const }),
      now: () => NOW,
    })

    await expect(coordinator.publish({
      lineageId: seeded.lineage.lineageId,
      expectedLineageRevision: seeded.lineage.revision,
      proposalRef: seeded.proposalRef,
    })).rejects.toThrow('synthetic failure after refresh fence')

    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toMatchObject({
      kind: 'PUBLICATION',
      phase: 'NEEDS_REFRESH',
      failureCode: 'PUBLICATION_CONFLICT',
    })
    blockLineageWrites = false
    await expect(coordinator.recover()).resolves.toBe('RECOVERED')
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toBeUndefined()
    const recovered = ProposalLineageV2Schema.parse(lineages.get(seeded.lineage.lineageId))
    if (recovered.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
    expect(recovered.proposalRevisions.at(-1)).toMatchObject({
      publicationFailureCode: 'PUBLICATION_CONFLICT',
    })
    await expect(coordinator.publish({
      lineageId: recovered.lineageId,
      expectedLineageRevision: recovered.revision,
      proposalRef: seeded.proposalRef,
    })).rejects.toMatchObject({ code: 'INVALID_PUBLICATION_STATE' })
  })

  it('revalidates the full Catalog before recovering a prepared publication', async () => {
    const seeded = await seedApproved()
    const mutationId = deriveProposalCatalogMutationIdV2({
      ownerId: seeded.proposalRef.proposalId,
      kind: 'PUBLICATION',
      inputCatalogEpoch: 0,
    })
    await seeded.domain.global.set(GlobalV2Schema.parse({
      ...seeded.domain.global.get(),
      proposalCatalogMutationJournal: {
        schemaVersion: 1,
        mutationId,
        ownerId: seeded.proposalRef.proposalId,
        kind: 'PUBLICATION',
        phase: 'PREPARED',
        preparedAt: NOW,
      },
    }))
    const publish = vi.fn(async input => {
      expect(input.attemptId).toBe(mutationId)
      return { status: 'PUBLISHED' as const, externalReceiptDigest: EXTERNAL_RECEIPT }
    })
    const revalidate = vi.fn(async () => currentCatalog(seeded.domain))
    const coordinator = new V2ProposalPublicationCoordinator(seeded.domain, {
      revalidate,
      publish,
      now: () => NOW,
    })

    await expect(coordinator.recover()).resolves.toBe('RECOVERED')
    expect(revalidate).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(seeded.domain.table('proposal_lineages').get(seeded.lineage.lineageId))
      .toMatchObject({ state: 'PUBLISHED', revision: seeded.lineage.revision + 1 })
    expect(seeded.domain.global.get()).toMatchObject({
      proposalCatalogEpoch: 1,
      proposalCatalogLastMutation: { kind: 'PUBLICATION' },
    })
  })

  it('does not replay a prepared publication when recovery Catalog revalidation is stale', async () => {
    const seeded = await seedApproved()
    const mutationId = deriveProposalCatalogMutationIdV2({
      ownerId: seeded.proposalRef.proposalId,
      kind: 'PUBLICATION',
      inputCatalogEpoch: 0,
    })
    await seeded.domain.global.set(GlobalV2Schema.parse({
      ...seeded.domain.global.get(),
      proposalCatalogMutationJournal: {
        schemaVersion: 1,
        mutationId,
        ownerId: seeded.proposalRef.proposalId,
        kind: 'PUBLICATION',
        phase: 'PREPARED',
        preparedAt: NOW,
      },
    }))
    const publish = vi.fn(async () => ({ status: 'PUBLISHED' as const, externalReceiptDigest: EXTERNAL_RECEIPT }))
    const coordinator = new V2ProposalPublicationCoordinator(seeded.domain, {
      revalidate: async () => ({ status: 'STALE' as const }),
      publish,
      now: () => NOW,
    })

    await expect(coordinator.recover()).resolves.toBe('RECOVERED')
    expect(publish).not.toHaveBeenCalled()
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toBeUndefined()
    expect(seeded.domain.table('proposal_lineages').get(seeded.lineage.lineageId))
      .toMatchObject({
        state: 'ACTIVE_PROPOSAL',
        proposalRevisions: [{ publicationFailureCode: 'CATALOG_CHANGED' }],
      })
  })

  it('retains an uncertain external attempt and never replays it against a stale Catalog', async () => {
    const seeded = await seedApproved()
    const publish = vi.fn()
      .mockResolvedValueOnce({ status: 'UNAVAILABLE' as const })
      .mockResolvedValueOnce({ status: 'PUBLISHED' as const, externalReceiptDigest: EXTERNAL_RECEIPT })
    let recoveryCatalog: 'CURRENT' | 'STALE' = 'CURRENT'
    const coordinator = new V2ProposalPublicationCoordinator(seeded.domain, {
      revalidate: async () => recoveryCatalog === 'CURRENT'
        ? currentCatalog(seeded.domain)
        : { status: 'STALE' as const },
      publish,
      now: () => NOW,
    })

    const result = await coordinator.publish({
      lineageId: seeded.lineage.lineageId,
      expectedLineageRevision: seeded.lineage.revision,
      proposalRef: seeded.proposalRef,
    })

    expect(result).toMatchObject({ state: 'NEEDS_ATTENTION' })
    const retained = seeded.domain.global.get().proposalCatalogMutationJournal
    expect(retained).toMatchObject({
      kind: 'PUBLICATION',
      phase: 'EXECUTING',
      executionStartedAt: NOW,
    })
    expect(publish).toHaveBeenCalledTimes(1)

    recoveryCatalog = 'STALE'
    await expect(coordinator.recover()).resolves.toBe('RECOVERED')
    expect(publish).toHaveBeenCalledTimes(1)
    expect(seeded.domain.global.get().proposalCatalogMutationJournal?.mutationId).toBe(retained?.mutationId)

    recoveryCatalog = 'CURRENT'
    await expect(coordinator.recover()).resolves.toBe('RECOVERED')
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish.mock.calls[1]?.[0].attemptId).toBe(publish.mock.calls[0]?.[0].attemptId)
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toBeUndefined()
    expect(seeded.domain.table('proposal_lineages').get(seeded.lineage.lineageId))
      .toMatchObject({ state: 'PUBLISHED' })
  })

  it('treats an unknown runtime outcome as outcome-unknown and retains its attempt', async () => {
    const seeded = await seedApproved()
    const publish = vi.fn(async () => ({ status: 'BROKEN_ADAPTER_RESPONSE' }))
    const coordinator = new V2ProposalPublicationCoordinator(seeded.domain, {
      revalidate: async () => currentCatalog(seeded.domain),
      publish,
      now: () => NOW,
    })

    const result = await coordinator.publish({
      lineageId: seeded.lineage.lineageId,
      expectedLineageRevision: seeded.lineage.revision,
      proposalRef: seeded.proposalRef,
    })

    expect(result).toMatchObject({ state: 'NEEDS_ATTENTION' })
    expect(result.lineage.proposalRevisions.at(-1)).toMatchObject({
      publicationFailureCode: 'PUBLICATION_UNAVAILABLE',
    })
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toMatchObject({
      kind: 'PUBLICATION',
      phase: 'EXECUTING',
      executionStartedAt: NOW,
    })
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('recovers when the exact filesystem write succeeds before the lineage write fails', async () => {
    const seeded = await seedApproved()
    const lineages = seeded.domain.table('proposal_lineages')
    const durableUpdate = lineages.update.bind(lineages)
    let lineageWriteFailed = false
    lineages.update = async (key, transform) => {
      if (!lineageWriteFailed) {
        lineageWriteFailed = true
        throw new Error('synthetic lineage write failure')
      }
      return await durableUpdate(key, transform)
    }
    const attempts: string[] = []
    const coordinator = new V2ProposalPublicationCoordinator(seeded.domain, {
      revalidate: async () => currentCatalog(seeded.domain),
      publish: async input => {
        attempts.push(input.attemptId)
        return { status: 'PUBLISHED', externalReceiptDigest: EXTERNAL_RECEIPT }
      },
      now: () => NOW,
    })

    await expect(coordinator.publish({
      lineageId: seeded.lineage.lineageId,
      expectedLineageRevision: seeded.lineage.revision,
      proposalRef: seeded.proposalRef,
    })).rejects.toThrow('synthetic lineage write failure')

    expect(attempts).toHaveLength(2)
    expect(new Set(attempts)).toHaveLength(1)
    expect(seeded.domain.table('proposal_lineages').get(seeded.lineage.lineageId))
      .toMatchObject({ state: 'PUBLISHED', revision: seeded.lineage.revision + 1 })
    expect(seeded.domain.global.get()).toMatchObject({
      proposalCatalogEpoch: 1,
      proposalCatalogLastMutation: { kind: 'PUBLICATION' },
    })
  })

  it('lets the original request finish a publication journal left after finalize write failures', async () => {
    const seeded = await seedApproved()
    const durableSet = seeded.domain.global.set.bind(seeded.domain.global)
    let remainingFinalizeFailures = 2
    seeded.domain.global.set = async value => {
      if (
        remainingFinalizeFailures > 0
        && seeded.domain.global.get().proposalCatalogMutationJournal?.kind === 'PUBLICATION'
        && value.proposalCatalogMutationJournal === undefined
      ) {
        remainingFinalizeFailures -= 1
        throw new Error('synthetic publication finalize failure')
      }
      await durableSet(value)
    }
    const publish = vi.fn(async () => ({ status: 'PUBLISHED' as const, externalReceiptDigest: EXTERNAL_RECEIPT }))
    const coordinator = new V2ProposalPublicationCoordinator(seeded.domain, {
      revalidate: async () => currentCatalog(seeded.domain), publish, now: () => NOW,
    })
    const request = {
      lineageId: seeded.lineage.lineageId,
      expectedLineageRevision: seeded.lineage.revision,
      proposalRef: seeded.proposalRef,
    }

    await expect(coordinator.publish(request)).rejects.toThrow('synthetic publication finalize failure')
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toMatchObject({ kind: 'PUBLICATION' })

    await expect(coordinator.publish(request)).resolves.toMatchObject({ changed: false, state: 'PUBLISHED' })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(seeded.domain.global.get()).toMatchObject({
      proposalCatalogEpoch: 1,
      proposalCatalogLastMutation: { kind: 'PUBLICATION' },
    })
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toBeUndefined()
  })
})
