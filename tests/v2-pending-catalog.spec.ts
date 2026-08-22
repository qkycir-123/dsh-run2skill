import { describe, expect, it } from 'vitest'
import { canonicalJson } from '../src/domain/learn/identity.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import {
  GlobalV2Schema,
  deriveTurnObservationContentDigestV2,
  deriveTurnObservationIdV2,
  deriveNativeProposalLineageIdV2,
} from '../src/domain/v2/index.js'
import { derivePendingProposalCatalogV2 } from '../src/adapters/dsh-storage/v2-pending-catalog.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

async function activate(domain: ReturnType<typeof createMemoryRun2skillV2Domain>): Promise<void> {
  const current = domain.global.get()
  await domain.global.set(GlobalV2Schema.parse({
    ...current,
    migration: {
      schemaVersion: 1,
      phase: 'COMMITTED',
      source: { domainName: 'run2skill_v1', domainVersion: 2, globalSchemaVersion: 1 },
      sourceFingerprint: 'a'.repeat(64),
      counts: { workItems: 0, lineages: 0, activeLegacyProposals: 0 },
      startedAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
      committedAt: '2026-08-22T00:00:00.000Z',
      activationFenceDigest: 'b'.repeat(64),
    },
    activation: {
      committedAt: '2026-08-22T00:00:00.000Z',
      sourceFingerprint: 'a'.repeat(64),
      observerStartWatermarks: {},
      observerStartWatermarkDigest: sha256Utf8(canonicalJson({})),
      legacyPendingCatalogDigest: sha256Utf8(canonicalJson([])),
      legacyPendingCandidateCount: 0,
    },
  }))
}

async function seedIntent(domain: ReturnType<typeof createMemoryRun2skillV2Domain>) {
  const fixture = createMinimalV2Fixtures()
  await activate(domain)
  await domain.table('turn_observations').put(fixture.turnObservation.observationId, fixture.turnObservation)
  await domain.table('experience_intents').put(fixture.experienceIntent.intentId, fixture.experienceIntent)
  return fixture
}

describe('v2 authoritative Pending Proposal catalog', () => {
  it('keeps one active native Proposal body and does not duplicate its consumed sealed result', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const fixture = await seedIntent(domain)
    await domain.table('experience_intents').put(fixture.proposalReadyIntent.intentId, fixture.proposalReadyIntent)
    await domain.table('proposal_lineages').put(
      fixture.nativeActiveProposalLineage.lineageId,
      fixture.nativeActiveProposalLineage,
    )

    const catalog = derivePendingProposalCatalogV2(domain, fixture.proposalReadyIntent)
    expect(catalog.complete).toBe(true)
    expect(catalog.entries).toHaveLength(1)
    expect(catalog.entries[0]).toMatchObject({
      candidateKey: fixture.proposalReadyIntent.generation.proposalId,
      source: 'active-proposal',
      capability: 'FULL_BODY',
      exactSkillBytes: fixture.nativeActiveProposalLineage.proposalRevisions[0]!.body.exactSkillBytes,
    })
  })

  it('surfaces an orphan sealed result and an unresolved barrier without truncating large bodies', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const fixture = await seedIntent(domain)
    const largeBody = `${fixture.staleAttentionIntent.generation.sealedResult!.body.exactSkillBytes}\n${'x'.repeat(20 * 1024)}`
    const orphan = {
      ...fixture.staleAttentionIntent,
      generation: {
        ...fixture.staleAttentionIntent.generation,
        sealedResult: {
          ...fixture.staleAttentionIntent.generation.sealedResult!,
          body: {
            ...fixture.staleAttentionIntent.generation.sealedResult!.body,
            exactSkillBytes: largeBody,
            skillBytesDigest: sha256Utf8(largeBody),
          },
        },
      },
    }
    await domain.table('experience_intents').put(orphan.intentId, orphan)

    const orphanCatalog = derivePendingProposalCatalogV2(domain, orphan)
    expect(orphanCatalog.complete).toBe(true)
    expect(orphanCatalog.entries[0]).toMatchObject({
      source: 'sealed-generation-result',
      exactSkillBytes: largeBody,
    })
    expect(Buffer.byteLength(orphanCatalog.entries[0]!.exactSkillBytes!, 'utf8')).toBeGreaterThan(8192)

    await domain.table('experience_intents').put(fixture.staleRefreshIntent.intentId, fixture.staleRefreshIntent)
    const barrierCatalog = derivePendingProposalCatalogV2(domain, fixture.staleRefreshIntent)
    expect(barrierCatalog.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateKey: fixture.staleRefreshIntent.duplicateBarrier!.barrierId,
        source: 'generation-barrier',
        capability: 'SUMMARY_ONLY',
      }),
    ]))
  })

  it('isolates PROJECT candidates and fails closed when owner scope evidence is missing', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const fixture = await seedIntent(domain)
    await domain.table('experience_intents').put(fixture.proposalReadyIntent.intentId, fixture.proposalReadyIntent)
    await domain.table('proposal_lineages').put(
      fixture.nativeActiveProposalLineage.lineageId,
      fixture.nativeActiveProposalLineage,
    )

    const otherObservation = {
      ...fixture.turnObservation,
      turnEndSeq: fixture.turnObservation.turnEndSeq + 1,
      turnInstanceDigest: 'e'.repeat(64),
      scopeBinding: {
        ...fixture.turnObservation.scopeBinding,
        scopeIdentityDigest: 'd'.repeat(64),
      },
    }
    const validOtherObservation = {
      ...otherObservation,
      observationId: deriveTurnObservationIdV2(otherObservation),
      contentDigest: deriveTurnObservationContentDigestV2(otherObservation),
    }
    await domain.table('turn_observations').put(validOtherObservation.observationId, validOtherObservation)
    const otherIntent = {
      ...fixture.experienceIntent,
      evidenceRefs: fixture.experienceIntent.evidenceRefs.map(ref => ({
        ...ref,
        observationId: validOtherObservation.observationId,
        turnEndSeq: validOtherObservation.turnEndSeq,
      })),
    }
    expect(derivePendingProposalCatalogV2(domain, otherIntent).entries).toHaveLength(0)

    await domain.table('turn_observations').delete(fixture.turnObservation.observationId)
    expect(derivePendingProposalCatalogV2(domain, fixture.proposalReadyIntent).complete).toBe(false)
  })

  it('fails closed for a mutation journal, epoch race, or a generation receipt consumed twice', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const fixture = await seedIntent(domain)
    await domain.table('experience_intents').put(fixture.proposalReadyIntent.intentId, fixture.proposalReadyIntent)
    await domain.table('proposal_lineages').put(
      fixture.nativeActiveProposalLineage.lineageId,
      fixture.nativeActiveProposalLineage,
    )
    await domain.global.set(GlobalV2Schema.parse({
      ...domain.global.get(),
      proposalCatalogMutationJournal: {
        schemaVersion: 1,
        mutationId: `pcm_${'e'.repeat(64)}`,
        ownerId: 'test',
        kind: 'PROPOSAL',
        phase: 'PREPARED',
        preparedAt: '2026-08-22T00:00:00.000Z',
      },
    }))
    expect(derivePendingProposalCatalogV2(domain, fixture.proposalReadyIntent).complete).toBe(false)

    const clean = { ...domain.global.get(), proposalCatalogMutationJournal: undefined }
    await domain.global.set(GlobalV2Schema.parse(clean))
    const otherBehaviorSignature = 'f'.repeat(64)
    const duplicate = {
      ...fixture.nativeActiveProposalLineage,
      lineageId: deriveNativeProposalLineageIdV2('PROJECT', otherBehaviorSignature),
      behaviorSignature: otherBehaviorSignature,
    }
    await domain.table('proposal_lineages').put(duplicate.lineageId, duplicate)
    expect(derivePendingProposalCatalogV2(domain, fixture.proposalReadyIntent).complete).toBe(false)
  })
})
