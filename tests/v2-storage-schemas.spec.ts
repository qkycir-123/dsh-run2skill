import { describe, expect, it } from 'vitest'
import {
  ExperienceIntentV2Schema,
  GlobalV2Schema,
  LegacyItemV2Schema,
  ProposalLineageV2Schema,
  SessionBatchV2Schema,
  TurnObservationV2Schema,
  deriveBehaviorSignatureIndexKeyV2,
  deriveCatalogScanBindingDigestV2,
  deriveCatalogScanCallIdV2,
  deriveCatalogScanPlanDigestV2,
  deriveTurnObservationContentDigestV2,
} from '../src/domain/v2/index.js'
import {
  RUN2SKILL_V2_SCHEMA_CONTRACT,
  createInitialGlobalV2,
  run2skillV2DomainSpec,
} from '../src/adapters/dsh-storage/v2-domain.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

describe('run2skill_v2 storage contract', () => {
  it('uses a new version-1 domain without changing the published v1 identity', () => {
    expect(RUN2SKILL_V2_SCHEMA_CONTRACT).toEqual({
      domainName: 'run2skill_v2',
      domainVersion: 1,
      globalSchemaVersion: 1,
      recordSchemaVersion: 1,
      sourceDomainName: 'run2skill_v1',
      sourceDomainVersion: 2,
    })
    expect(run2skillV2DomainSpec.name).toBe('run2skill_v2')
    expect(run2skillV2DomainSpec.version).toBe(1)
    expect(Object.keys(run2skillV2DomainSpec.tables)).toEqual([
      'turn_observations',
      'session_batches',
      'experience_intents',
      'proposal_lineages',
      'legacy_items',
    ])
    expect(createInitialGlobalV2()).toMatchObject({
      schemaVersion: 1,
      migration: { schemaVersion: 1, phase: 'NOT_STARTED' },
      sessions: {},
      behaviorSignatureIndex: {},
      proposalCatalogEpoch: 0,
    })
  })

  it('accepts a minimal valid fixture for Global and every v2 table', () => {
    const fixture = createMinimalV2Fixtures()
    expect(GlobalV2Schema.parse(fixture.global)).toEqual(fixture.global)
    expect(TurnObservationV2Schema.parse(fixture.turnObservation)).toEqual(fixture.turnObservation)
    expect(SessionBatchV2Schema.parse(fixture.sessionBatch)).toEqual(fixture.sessionBatch)
    expect(ExperienceIntentV2Schema.parse(fixture.experienceIntent)).toEqual(fixture.experienceIntent)
    expect(ProposalLineageV2Schema.parse(fixture.proposalLineage)).toEqual(fixture.proposalLineage)
    expect(ProposalLineageV2Schema.parse(fixture.nativeProposalLineage)).toEqual(fixture.nativeProposalLineage)
    expect(ProposalLineageV2Schema.parse(fixture.nativeActiveProposalLineage)).toEqual(fixture.nativeActiveProposalLineage)
    expect(ExperienceIntentV2Schema.parse(fixture.proposalReadyIntent)).toEqual(fixture.proposalReadyIntent)
    expect(ExperienceIntentV2Schema.parse(fixture.staleAttentionIntent)).toEqual(fixture.staleAttentionIntent)
    expect(ExperienceIntentV2Schema.parse(fixture.staleRefreshIntent)).toEqual(fixture.staleRefreshIntent)
    const refreshedScanBindingDigest = deriveCatalogScanBindingDigestV2({
        intentId: fixture.staleRefreshIntent.intentId,
        scanBasisRevision: fixture.staleRefreshIntent.revision,
        selfExclusionDigest: fixture.staleRefreshIntent.recall.selfExclusion.selfExclusionDigest,
        provider: fixture.proposalReadyIntent.recall.scanRouteProvider,
        model: fixture.proposalReadyIntent.recall.scanRouteModel,
        policyVersion: fixture.proposalReadyIntent.recall.scanPolicyVersion,
    })
    const refreshedScanPlanDigest = deriveCatalogScanPlanDigestV2({
      policyVersion: fixture.proposalReadyIntent.recall.scanPolicyVersion,
      runtimeCatalogDigest: fixture.proposalReadyIntent.recall.runtimeCatalogDigest,
      pendingCatalogDigest: 'f'.repeat(64),
      catalogEpoch: fixture.staleRefreshIntent.duplicateBarrier.outcomeCatalogEpoch,
      catalogMutationReceiptDigest: fixture.staleRefreshIntent.duplicateBarrier.mutationReceiptDigest,
      scanBindingDigest: refreshedScanBindingDigest,
      pages: [{
        ordinal: 1,
        inputDigest: fixture.proposalReadyIntent.stageCalls[0]!.inputDigest,
        membershipDigest: fixture.proposalReadyIntent.recall.scanPages[0]!.membershipDigest,
      }],
    })
    const refreshedScanCallId = deriveCatalogScanCallIdV2(
      fixture.staleRefreshIntent.intentId, refreshedScanPlanDigest, 1,
    )
    const refreshedRecall = {
      ...fixture.proposalReadyIntent.recall,
      scanBasisRevision: fixture.staleRefreshIntent.revision,
      scanBindingDigest: refreshedScanBindingDigest,
      scanPlanDigest: refreshedScanPlanDigest,
      pendingCatalogDigest: 'f'.repeat(64),
      catalogEpoch: fixture.staleRefreshIntent.duplicateBarrier.outcomeCatalogEpoch,
      catalogMutationReceiptDigest: fixture.staleRefreshIntent.duplicateBarrier.mutationReceiptDigest,
      selfExclusion: fixture.staleRefreshIntent.recall.selfExclusion,
      summaryClassifications: fixture.proposalReadyIntent.recall.summaryClassifications.map(item => ({
        ...item, callId: refreshedScanCallId,
      })),
    }
    const coverageReadyAfterRefresh = {
      ...fixture.staleRefreshIntent,
      revision: fixture.staleRefreshIntent.revision + 3,
      status: 'COVERAGE_READY' as const,
      recall: refreshedRecall,
      stageCalls: fixture.staleRefreshIntent.stageCalls.map(call => call.stage === 'CATALOG_SCAN'
        ? { ...call, intentRevision: fixture.staleRefreshIntent.revision + 1, callId: refreshedScanCallId }
        : call),
    }
    expect(ExperienceIntentV2Schema.parse(coverageReadyAfterRefresh)).toEqual(coverageReadyAfterRefresh)
    expect(ExperienceIntentV2Schema.parse({
      ...coverageReadyAfterRefresh,
      status: 'COVERAGE_ANALYZING',
      coverage: { state: 'ANALYZING' },
    })).toEqual({
      ...coverageReadyAfterRefresh,
      status: 'COVERAGE_ANALYZING',
      coverage: { state: 'ANALYZING' },
    })
    const refreshedLeaseId = `lease_${'a'.repeat(64)}`
    const refreshedCallId = `call_${'b'.repeat(64)}`
    const refreshedSealedResult = {
      ...fixture.proposalReadyIntent.generation.sealedResult,
      resultId: `result_${'c'.repeat(64)}`,
      leaseId: refreshedLeaseId,
      generationRevision: 2,
      callId: refreshedCallId,
      inputDigest: 'd'.repeat(64),
      pendingCatalogDigest: refreshedRecall.pendingCatalogDigest,
      inputCatalogEpoch: refreshedRecall.catalogEpoch,
      outcomeCatalogEpoch: refreshedRecall.catalogEpoch + 1,
      mutationReceiptDigest: '4'.repeat(64),
      receiptDigest: '9'.repeat(64),
    }
    const {
      duplicateBarrier: _replacedRefreshBarrier,
      ...coverageReadyWithoutBarrier
    } = coverageReadyAfterRefresh
    const staleAgainAfterRefresh = {
      ...coverageReadyWithoutBarrier,
      status: 'NEEDS_ATTENTION' as const,
      coverage: {
        state: 'CREATE' as const,
        inputDigest: 'b'.repeat(64),
        targetDigest: refreshedSealedResult.targetDigest,
      },
      generation: {
        state: 'NEEDS_ATTENTION' as const,
        action: 'CREATE' as const,
        inputDigest: refreshedSealedResult.inputDigest,
        resultDigest: refreshedSealedResult.receiptDigest,
        leaseId: refreshedLeaseId,
        generationRevision: 2,
        catalogEpoch: refreshedSealedResult.inputCatalogEpoch,
        externalPendingDigest: refreshedSealedResult.externalPendingDigest,
        selfExclusionDigest: coverageReadyAfterRefresh.recall.selfExclusion.selfExclusionDigest,
        sealedResult: refreshedSealedResult,
        reasonCode: 'STALE_RESULT' as const,
        userRetryUsed: false,
        staleRefreshUsed: true,
        receipts: ['LEASE_ACQUIRED', 'CALL_RESERVED', 'CALL_TERMINAL', 'RESULT_SEALED'].map((kind, index) => ({
          kind: kind as 'LEASE_ACQUIRED' | 'CALL_RESERVED' | 'CALL_TERMINAL' | 'RESULT_SEALED',
          digest: (index + 1).toString(16).repeat(64),
          leaseId: refreshedLeaseId,
          intentId: coverageReadyAfterRefresh.intentId,
          generationRevision: 2,
          ...(['CALL_RESERVED', 'CALL_TERMINAL', 'RESULT_SEALED'].includes(kind) ? { callId: refreshedCallId } : {}),
          catalogEpoch: kind === 'RESULT_SEALED'
            ? refreshedSealedResult.outcomeCatalogEpoch
            : refreshedSealedResult.inputCatalogEpoch,
          recordedAt: coverageReadyAfterRefresh.updatedAt,
        })),
      },
      stageCalls: [...coverageReadyAfterRefresh.stageCalls, {
        stage: 'GENERATION' as const,
        intentRevision: 2,
        callId: refreshedCallId,
        ordinal: 1,
        inputDigest: refreshedSealedResult.inputDigest,
        outputDigest: 'e'.repeat(64),
        provider: 'deepseek-official',
        model: 'deepseek-chat',
        policyVersion: 'generation-v1',
        outcome: 'SUCCEEDED' as const,
      }],
    }
    expect(ExperienceIntentV2Schema.parse(staleAgainAfterRefresh)).toEqual(staleAgainAfterRefresh)
    const coveredNeedsConfirmation = {
      ...coverageReadyAfterRefresh,
      status: 'COVERED_NEEDS_CONFIRMATION' as const,
      coverage: { state: 'COVERED' as const },
    }
    expect(ExperienceIntentV2Schema.safeParse(coveredNeedsConfirmation).success).toBe(true)
    const {
      duplicateBarrier: _discardedBarrier,
      ...discardedIntentBase
    } = coveredNeedsConfirmation
    const discardedAfterConfirmation = {
      ...discardedIntentBase,
      revision: discardedIntentBase.revision + 1,
      status: 'DISCARDED' as const,
      reasonReceipts: [{
        revision: discardedIntentBase.revision + 1,
        reasonCode: 'CONFIRM_DISCARD',
        recordedAt: discardedIntentBase.updatedAt,
      }],
    }
    expect(ExperienceIntentV2Schema.parse(discardedAfterConfirmation)).toEqual(discardedAfterConfirmation)
    expect(LegacyItemV2Schema.parse(fixture.legacyItem)).toEqual(fixture.legacyItem)
  })

  it('deduplicates an intent across batch replay and DEFER carry', () => {
    const fixture = createMinimalV2Fixtures()
    const replay = {
      ...fixture.experienceIntent,
      batchId: `batch_${'f'.repeat(64)}`,
      ordinal: 3,
    }
    expect(ExperienceIntentV2Schema.parse(replay).intentId).toBe(fixture.experienceIntent.intentId)
  })

  it('rejects contradictory authoritative states instead of deferring validation to workers', () => {
    const fixture = createMinimalV2Fixtures()
    expect(ProposalLineageV2Schema.safeParse({
      ...fixture.nativeProposalLineage,
      state: 'ACTIVE_PROPOSAL',
    }).success).toBe(false)
    expect(SessionBatchV2Schema.safeParse({
      ...fixture.sessionBatch,
      state: 'DETECTION_CLAIMED',
    }).success).toBe(false)
    expect(ExperienceIntentV2Schema.safeParse({
      ...fixture.experienceIntent,
      status: 'PROPOSAL_READY',
    }).success).toBe(false)
    expect(ExperienceIntentV2Schema.safeParse({
      ...fixture.proposalReadyIntent,
      generation: {
        ...fixture.proposalReadyIntent.generation,
        receipts: fixture.proposalReadyIntent.generation.receipts.map(receipt => (
          ['BODY_COMMITTED', 'INDEX_COMMITTED'].includes(receipt.kind)
            ? { ...receipt, catalogEpoch: fixture.proposalReadyIntent.generation.sealedResult.outcomeCatalogEpoch }
            : receipt
        )),
      },
    }).success).toBe(false)
    expect(TurnObservationV2Schema.safeParse({
      ...fixture.turnObservation,
      assistantOutcomeSummary: 'forged summary without a new content digest',
    }).success).toBe(false)
    for (const status of ['RECALLING', 'COVERED', 'CREATE_AUTHORIZED', 'GENERATING'] as const) {
      expect(ExperienceIntentV2Schema.safeParse({
        ...fixture.experienceIntent,
        status,
      }).success).toBe(false)
    }
    expect(ExperienceIntentV2Schema.safeParse({
      ...fixture.experienceIntent,
      recall: { ...fixture.experienceIntent.recall, state: 'COMPLETE', complete: false },
    }).success).toBe(false)
    expect(ExperienceIntentV2Schema.safeParse({
      ...fixture.experienceIntent,
      status: 'RUN2SKILL_OWNED',
      ownership: { state: 'RUN2SKILL_OWNED' },
    }).success).toBe(false)
    expect(ExperienceIntentV2Schema.safeParse({
      ...fixture.proposalReadyIntent,
      status: 'GENERATING',
      generation: {
        ...fixture.proposalReadyIntent.generation,
        state: 'RESULT_COMMITTED',
        receipts: [],
      },
      stageCalls: fixture.proposalReadyIntent.stageCalls.filter(call => call.stage !== 'GENERATION'),
    }).success).toBe(false)
    const {
      proposalId: _resultProposalId,
      revalidationAuthorization: _resultAuthorization,
      ...resultCommittedGeneration
    } = fixture.proposalReadyIntent.generation
    const {
      lineageId: _resultLineageId,
      ...resultCommittedIntentBase
    } = fixture.proposalReadyIntent
    const resultCommittedIntent = {
      ...resultCommittedIntentBase,
      status: 'GENERATING' as const,
      generation: {
        ...resultCommittedGeneration,
        state: 'RESULT_COMMITTED' as const,
        receipts: fixture.proposalReadyIntent.generation.receipts.slice(0, 4),
      },
    }
    expect(ExperienceIntentV2Schema.safeParse(resultCommittedIntent).success).toBe(true)
    expect(ExperienceIntentV2Schema.safeParse({
      ...resultCommittedIntent,
      generation: {
        ...fixture.proposalReadyIntent.generation,
        state: 'RESULT_COMMITTED',
      },
    }).success).toBe(false)
    expect(ExperienceIntentV2Schema.safeParse({
      ...fixture.staleAttentionIntent,
      duplicateBarrier: fixture.staleRefreshIntent.duplicateBarrier,
      generation: {
        ...fixture.staleAttentionIntent.generation,
        receipts: [...fixture.staleAttentionIntent.generation.receipts, {
          kind: 'BARRIER_COMMITTED',
          digest: fixture.staleRefreshIntent.duplicateBarrier.mutationReceiptDigest,
          leaseId: fixture.staleAttentionIntent.generation.leaseId,
          intentId: fixture.staleAttentionIntent.intentId,
          generationRevision: fixture.staleAttentionIntent.generation.generationRevision,
          callId: fixture.staleAttentionIntent.generation.sealedResult.callId,
          catalogEpoch: fixture.staleRefreshIntent.duplicateBarrier.outcomeCatalogEpoch,
          recordedAt: fixture.staleAttentionIntent.updatedAt,
        }],
      },
    }).success).toBe(false)
    expect(ExperienceIntentV2Schema.safeParse({
      ...fixture.staleAttentionIntent,
      revision: fixture.staleAttentionIntent.revision + 1,
      status: 'DISCARDED',
      reasonReceipts: [{
        revision: fixture.staleAttentionIntent.revision + 1,
        reasonCode: 'DISMISS_GENERATION',
        recordedAt: fixture.staleAttentionIntent.updatedAt,
      }],
    }).success).toBe(false)
    expect(ExperienceIntentV2Schema.safeParse({
      ...fixture.proposalReadyIntent,
      generation: {
        ...fixture.proposalReadyIntent.generation,
        receipts: fixture.proposalReadyIntent.generation.receipts.map((receipt, index, receipts) => (
          index === 1 ? { ...receipt, digest: receipts[0]!.digest } : receipt
        )),
      },
    }).success).toBe(false)
    expect(ExperienceIntentV2Schema.safeParse({
      ...fixture.proposalReadyIntent,
      generation: {
        ...fixture.proposalReadyIntent.generation,
        revalidationAuthorization: {
          ...fixture.proposalReadyIntent.generation.revalidationAuthorization,
          pendingCatalogDigest: fixture.proposalReadyIntent.generation.sealedResult.pendingCatalogDigest,
          catalogMutationReceiptDigest: fixture.proposalReadyIntent.recall.catalogMutationReceiptDigest,
        },
      },
    }).success).toBe(false)
    expect(ExperienceIntentV2Schema.safeParse({
      ...resultCommittedIntent,
      generation: {
        ...resultCommittedIntent.generation,
        sealedResult: {
          ...resultCommittedIntent.generation.sealedResult,
          callId: `call_${'f'.repeat(64)}`,
        },
      },
    }).success).toBe(false)
    expect(ExperienceIntentV2Schema.safeParse({
      ...fixture.proposalReadyIntent,
      generation: {
        ...fixture.proposalReadyIntent.generation,
        revalidationAuthorization: {
          ...fixture.proposalReadyIntent.generation.revalidationAuthorization,
          runtimeCatalogDigest: '1'.repeat(64),
          pendingCatalogDigest: '2'.repeat(64),
          externalPendingDigest: '3'.repeat(64),
        },
      },
    }).success).toBe(false)
    expect(ExperienceIntentV2Schema.safeParse({
      ...fixture.staleRefreshIntent,
      recall: {
        ...fixture.staleRefreshIntent.recall,
        selfExclusion: {
          ...fixture.staleRefreshIntent.recall.selfExclusion,
          selfExclusionDigest: '0'.repeat(64),
        },
      },
    }).success).toBe(false)
    expect(ExperienceIntentV2Schema.safeParse({
      ...fixture.proposalReadyIntent,
      recall: {
        ...fixture.proposalReadyIntent.recall,
        candidates: [{
          candidateId: 'unavailable-related-candidate',
          summary: {
            name: 'Existing skill',
            description: 'Potentially covers the same behavior',
            provider: 'dsh',
            source: 'runtime-catalog',
            scope: 'PROJECT',
            writable: true,
          },
          classification: 'RELEVANT',
          capability: 'UNAVAILABLE',
          unavailableReason: 'READ_FAILED',
        }],
      },
    }).success).toBe(false)

    const routeObservation = { complete: true }
    const forgedRouteObservation = {
      ...fixture.turnObservation,
      routeObservation,
      contentDigest: deriveTurnObservationContentDigestV2({
        ...fixture.turnObservation,
        routeObservation,
      }),
    }
    expect(TurnObservationV2Schema.safeParse(forgedRouteObservation).success).toBe(false)

    const publishedWithoutApproval = {
      ...fixture.nativeActiveProposalLineage,
      state: 'PUBLISHED' as const,
      proposalRevisions: fixture.nativeActiveProposalLineage.proposalRevisions.map(revision => ({
        ...revision,
        state: 'PUBLISHED' as const,
        publicationReceiptDigest: 'e'.repeat(64),
      })),
    }
    expect(ProposalLineageV2Schema.safeParse(publishedWithoutApproval).success).toBe(false)

    expect(GlobalV2Schema.safeParse({
      ...fixture.global,
      proposalGenerationLease: {
        schemaVersion: 1,
        leaseId: `lease_${'a'.repeat(64)}`,
        ownerIntentId: fixture.experienceIntent.intentId,
        ownerRevision: 1,
        generationRevision: 1,
        action: 'CREATE',
        inputDigest: 'b'.repeat(64),
        externalPendingDigest: 'c'.repeat(64),
        catalogEpoch: 0,
        acquiredAt: '2026-08-22T00:00:00.000Z',
        completionReceiptDigest: 'd'.repeat(64),
        state: 'NOT_CALLED',
      },
    }).success).toBe(false)
  })

  it('rejects only changing schemaVersion on otherwise valid fixtures', () => {
    const fixture = createMinimalV2Fixtures()
    const cases = [
      [GlobalV2Schema, fixture.global],
      [TurnObservationV2Schema, fixture.turnObservation],
      [SessionBatchV2Schema, fixture.sessionBatch],
      [ExperienceIntentV2Schema, fixture.experienceIntent],
      [ProposalLineageV2Schema, fixture.proposalLineage],
      [LegacyItemV2Schema, fixture.legacyItem],
    ] as const
    for (const [schema, valid] of cases) {
      expect(schema.safeParse({ ...valid, schemaVersion: 999 }).success).toBe(false)
    }
  })

  it('rejects a forged legacy disposition and a behavior index under the wrong key', () => {
    const fixture = createMinimalV2Fixtures()
    expect(LegacyItemV2Schema.safeParse({
      ...fixture.legacyItem,
      disposition: 'AUDIT_ONLY_PUBLISHED',
    }).success).toBe(false)

    const behaviorSignature = 'e'.repeat(64)
    const expectedIndexId = deriveBehaviorSignatureIndexKeyV2('PROJECT', behaviorSignature)
    const entry = {
      schemaVersion: 1 as const,
      persistenceScope: 'PROJECT' as const,
      behaviorSignature,
      ownerIntentId: fixture.experienceIntent.intentId,
      ownerRevision: 1,
      state: 'RESERVED' as const,
      updatedAt: '2026-08-22T00:00:00.000Z',
    }
    expect(GlobalV2Schema.safeParse({
      ...fixture.global,
      behaviorSignatureIndex: { [expectedIndexId]: entry },
    }).success).toBe(true)
    expect(GlobalV2Schema.safeParse({
      ...fixture.global,
      behaviorSignatureIndex: { ['f'.repeat(64)]: entry },
    }).success).toBe(false)
  })
})
