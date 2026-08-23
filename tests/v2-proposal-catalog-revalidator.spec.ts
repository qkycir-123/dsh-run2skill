import { describe, expect, it, vi } from 'vitest'
import { V2ProposalCatalogRevalidator } from '../src/application/review/v2-proposal-catalog-revalidator.js'
import type { V2ProposalPublicationInput } from '../src/application/publication/index.js'
import { deriveV2ProposalRef } from '../src/application/review/index.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import { ProposalLineageV2Schema, SessionBatchV2Schema } from '../src/domain/v2/index.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

function fixture() {
  const minimal = createMinimalV2Fixtures()
  const lineage = ProposalLineageV2Schema.parse(minimal.nativeActiveProposalLineage)
  if (lineage.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
  const proposal = lineage.proposalRevisions[0]!
  const snapshot = {
    complete: true,
    runtimeCatalogDigest: proposal.runtimeCatalogDigest,
    pendingCatalogDigest: 'a'.repeat(64),
    externalPendingDigest: 'b'.repeat(64),
    catalogEpoch: proposal.catalogEpoch,
    catalogMutationReceiptDigest: proposal.catalogMutationReceiptDigest,
  }
  const input = {
    lineage,
    proposal,
    proposalRef: deriveV2ProposalRef(lineage),
    intent: minimal.proposalReadyIntent,
    batch: SessionBatchV2Schema.parse(minimal.sessionBatch),
  }
  return { input, snapshot }
}

describe('v2 Proposal Catalog revalidator', () => {
  it('accepts only a complete stable Catalog at the Proposal mutation anchor', async () => {
    const seeded = fixture()
    const snapshot = vi.fn(async () => seeded.snapshot)
    const revalidator = new V2ProposalCatalogRevalidator({ snapshot, read: vi.fn() })

    await expect(revalidator.revalidate(seeded.input)).resolves.toEqual({
      status: 'CURRENT',
      runtimeCatalogDigest: seeded.snapshot.runtimeCatalogDigest,
      pendingCatalogDigest: seeded.snapshot.pendingCatalogDigest,
      catalogEpoch: seeded.snapshot.catalogEpoch,
      catalogMutationReceiptDigest: seeded.snapshot.catalogMutationReceiptDigest,
    })
    expect(snapshot).toHaveBeenCalledOnce()
  })

  it('fails closed as unavailable when the complete current Catalog cannot be proven', async () => {
    const seeded = fixture()
    const revalidator = new V2ProposalCatalogRevalidator({
      snapshot: async () => ({ ...seeded.snapshot, complete: false }),
      read: vi.fn(),
    })

    await expect(revalidator.revalidate(seeded.input)).resolves.toEqual({ status: 'UNAVAILABLE' })
  })

  it('uses only the exact Proposal publication-recovery snapshot when its journal blocks the normal Catalog', async () => {
    const seeded = fixture()
    const recovery = vi.fn(async () => seeded.snapshot)
    const revalidator = new V2ProposalCatalogRevalidator({
      snapshot: async () => ({ ...seeded.snapshot, complete: false }),
      read: vi.fn(),
    }, { snapshot: recovery })

    await expect(revalidator.revalidate(seeded.input)).resolves.toMatchObject({ status: 'CURRENT' })
    expect(recovery).toHaveBeenCalledWith({
      batch: seeded.input.batch,
      intent: seeded.input.intent,
      proposalId: seeded.input.proposal.proposalId,
    })
  })

  it.each([
    { field: 'runtimeCatalogDigest', value: 'c'.repeat(64) },
    { field: 'catalogEpoch', value: 999 },
    { field: 'catalogMutationReceiptDigest', value: 'd'.repeat(64) },
  ] as const)('marks a changed $field as stale', async ({ field, value }) => {
    const seeded = fixture()
    const revalidator = new V2ProposalCatalogRevalidator({
      snapshot: async () => ({ ...seeded.snapshot, [field]: value }),
      read: vi.fn(),
    })

    await expect(revalidator.revalidate(seeded.input)).resolves.toEqual({ status: 'STALE' })
  })

  it('re-reads an exact MERGE base and rejects body drift before publication', async () => {
    const seeded = fixture()
    const candidateId = `cand_${'e'.repeat(64)}`
    const content = '# Existing Skill\n'
    const exactDigest = sha256Utf8(content)
    const mergeInput = {
      ...seeded.input,
      proposal: {
        ...seeded.input.proposal,
        action: 'MERGE',
        targetIdentityDigest: sha256Utf8(content),
        baseSkillBytes: content,
        baseSkillBytesDigest: exactDigest,
      },
      intent: {
        ...seeded.input.intent,
        coverage: { ...seeded.input.intent.coverage, targetCandidateId: candidateId },
      },
    } as V2ProposalPublicationInput
    let currentContent = content
    const snapshot = vi.fn(async () => seeded.snapshot)
    const revalidator = new V2ProposalCatalogRevalidator({
      snapshot,
      read: async () => ({
        candidateId,
        name: 'existing',
        description: 'Existing Skill.',
        provider: 'filesystem',
        source: 'project-dsh',
        scope: 'PROJECT',
        writable: true,
        rootIdentityDigest: '1'.repeat(64),
        content: currentContent,
        skillBytesDigest: exactDigest,
      }),
    })

    await expect(revalidator.revalidate(mergeInput)).resolves.toMatchObject({ status: 'CURRENT' })
    expect(snapshot).toHaveBeenCalledTimes(2)

    currentContent = '# Changed Skill\n'
    await expect(revalidator.revalidate(mergeInput)).resolves.toEqual({ status: 'STALE' })
  })
})
