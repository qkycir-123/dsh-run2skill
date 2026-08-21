import { canonicalJson } from '../../src/domain/learn/identity.js'
import { deriveSessionLifecycleKeyFromFacts } from '../../src/domain/observe/identity.js'
import { sha256Utf8 } from '../../src/domain/observe/hashing.js'
import { derivePublicationTargetIdentityDigest, materializeLineage } from '../../src/domain/publication/schemas.js'
import {
  deriveExperienceIntentIdV2,
  deriveNativeProposalLineageIdV2,
  deriveSessionBatchIdV2,
  deriveTurnObservationIdV2,
  deriveTurnObservationContentDigestV2,
} from '../../src/domain/v2/index.js'
import { createInitialGlobalV2 } from '../../src/adapters/dsh-storage/v2-domain.js'
import {
  materializeLegacyItemV2,
  materializeLegacyProposalLineageV2,
} from '../../src/adapters/dsh-storage/legacy-v1-adapter.js'
import { makeWorkItem } from './work-item-fixture.js'

export function createMinimalV2Fixtures() {
  const now = '2026-08-22T00:00:00.000Z'
  const lifecycleFacts = {
    rootSessionId: 'session-v2',
    sessionCreatedAt: 100,
    sessionCwdDigest: 'a'.repeat(64),
  }
  const sessionLifecycleKey = deriveSessionLifecycleKeyFromFacts(lifecycleFacts)
  const evidence = makeWorkItem().evidenceRefs
  const observationFacts = {
    sessionLifecycleKey,
    turnEndSeq: 8,
    turnInstanceDigest: 'b'.repeat(64),
  }
  const observationContent = {
    outcomeKind: 'completed',
    assistantOutcomeSummary: 'Completed the requested workflow.',
    toolOutcomeSummary: [],
    routeObservation: { provider: 'deepseek-official', model: 'deepseek-chat', complete: true },
    completeness: 'COMPLETE' as const,
    scopeBinding: {
      status: 'PROJECT' as const,
      workspaceId: 'workspace-v2',
      scopeIdentityDigest: 'c'.repeat(64),
    },
    evidenceDigest: sha256Utf8(canonicalJson(evidence)),
  }
  const turnObservation = {
    schemaVersion: 1 as const,
    revision: 1,
    observationId: deriveTurnObservationIdV2(observationFacts),
    ...observationFacts,
    turn: 2,
    observedAt: now,
    ...observationContent,
    directUserEvidence: evidence,
    contentDigest: deriveTurnObservationContentDigestV2(observationContent),
  }
  const batchFacts = {
    sessionLifecycleKey,
    firstTurnEndSeq: 8,
    lastTurnEndSeq: 8,
    detectorPolicyVersion: 'batch-detector-v1',
  }
  const observationManifest = [{
    observationId: turnObservation.observationId,
    turnEndSeq: turnObservation.turnEndSeq,
    evidenceDigest: turnObservation.evidenceDigest,
    completeness: turnObservation.completeness,
  }]
  const sessionBatch = {
    schemaVersion: 1 as const,
    revision: 1,
    batchId: deriveSessionBatchIdV2(batchFacts),
    ...batchFacts,
    triggerReasons: ['EXPLICIT'] as const,
    observationManifest,
    observationManifestDigest: sha256Utf8(canonicalJson(observationManifest)),
    batchManifestBaseline: {
      observedAt: now,
      rootManifestDigest: '1'.repeat(64),
      runtimeCatalogDigest: '2'.repeat(64),
      complete: true,
    },
    manifestEndObservation: { state: 'PENDING' as const },
    routeSnapshot: {
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      policyVersion: 'batch-detector-v1',
      maxInputBytes: 32 * 1024,
      maxOutputBytes: 8 * 1024,
    },
    detector: { result: 'NOT_RUN' as const, calls: [], intentIds: [] },
    state: 'FROZEN' as const,
    createdAt: now,
    updatedAt: now,
  }
  const intentFacts = {
    sessionLifecycleKey,
    behaviorSignature: 'd'.repeat(64),
    evidenceDigests: [turnObservation.evidenceDigest],
    detectorPolicyVersion: batchFacts.detectorPolicyVersion,
  }
  const experienceIntent = {
    schemaVersion: 1 as const,
    revision: 1,
    intentId: deriveExperienceIntentIdV2(intentFacts),
    batchId: sessionBatch.batchId,
    ordinal: 1,
    sessionLifecycleKey,
    detectorPolicyVersion: intentFacts.detectorPolicyVersion,
    persistenceScope: 'PROJECT' as const,
    explicitSave: true,
    behaviorSignature: intentFacts.behaviorSignature,
    evidenceRefs: [{
      observationId: turnObservation.observationId,
      sessionLifecycleKey,
      turnEndSeq: turnObservation.turnEndSeq,
      evidenceDigest: turnObservation.evidenceDigest,
    }],
    evidenceDigests: intentFacts.evidenceDigests,
    completeness: { status: 'COMPLETE' as const, blockers: [] },
    ownership: { state: 'NOT_STARTED' as const },
    recall: { state: 'NOT_STARTED' as const, complete: false, candidateCapabilities: [] },
    coverage: { state: 'NOT_STARTED' as const },
    generation: {
      state: 'NOT_STARTED' as const,
      userRetryUsed: false,
      staleRefreshUsed: false,
      receipts: [],
    },
    stageCalls: [],
    reasonReceipts: [],
    status: 'READY' as const,
    createdAt: now,
    updatedAt: now,
  }
  const canonicalTargetPath = 'D:\\workspace\\.dsh\\skills\\fixture\\SKILL.md'
  const targetIdentityDigest = derivePublicationTargetIdentityDigest({
    scope: 'PROJECT',
    provider: 'filesystem',
    source: 'project-dsh',
    skillName: 'fixture',
    canonicalTargetPath,
  })
  const exactSkillBytes = '---\nname: fixture\ndescription: Fixture.\n---\n\n# Fixture\n'
  const legacyLineage = materializeLineage({
    scope: 'PROJECT',
    provider: 'filesystem',
    source: 'project-dsh',
    skillName: 'fixture',
    canonicalTargetPath,
    targetIdentityDigest,
    revisions: [{
      revision: 1,
      origin: 'ADOPTED_BASE',
      exactSkillBytes,
      skillBytesDigest: sha256Utf8(exactSkillBytes),
      committedAt: now,
    }],
  })
  const legacyItem = materializeLegacyItemV2(makeWorkItem(), now)
  const proposalLineage = materializeLegacyProposalLineageV2(legacyLineage, now)
  if (proposalLineage.origin !== 'LEGACY_V1') throw new Error('expected legacy lineage fixture')
  const nativeProposalLineage = {
    schemaVersion: 1 as const,
    revision: 1,
    lineageId: deriveNativeProposalLineageIdV2('PROJECT', experienceIntent.behaviorSignature),
    persistenceScope: 'PROJECT' as const,
    origin: 'RUN2SKILL_V2' as const,
    state: 'RESERVED' as const,
    behaviorSignature: experienceIntent.behaviorSignature,
    ownerIntentId: experienceIntent.intentId,
    ownerIntentRevision: experienceIntent.revision,
    currentProposalRevision: 0,
    proposalRevisions: [],
    createdAt: now,
    updatedAt: now,
  }
  const nativeBody = {
    name: 'fixture-v2',
    description: 'A native v2 fixture.',
    whenToUse: 'Use for v2 schema tests.',
    exactSkillBytes: '---\nname: fixture-v2\ndescription: A native v2 fixture.\n---\n\n# Fixture v2\n',
    skillBytesDigest: '',
  }
  nativeBody.skillBytesDigest = sha256Utf8(nativeBody.exactSkillBytes)
  const nativeProposalId = `prop_${'3'.repeat(64)}`
  const sealedResult = {
    resultId: `result_${'4'.repeat(64)}`,
    callId: `call_${'5'.repeat(64)}`,
    action: 'CREATE' as const,
    body: nativeBody,
    targetDigest: '6'.repeat(64),
    runtimeCatalogDigest: '7'.repeat(64),
    pendingCatalogDigest: '8'.repeat(64),
    sealedAt: now,
    receiptDigest: '9'.repeat(64),
  }
  const proposalReadyIntent = {
    ...experienceIntent,
    status: 'PROPOSAL_READY' as const,
    ownership: { state: 'RUN2SKILL_OWNED' as const, evidenceDigest: 'a'.repeat(64) },
    recall: {
      state: 'COMPLETE' as const,
      runtimeCatalogDigest: sealedResult.runtimeCatalogDigest,
      pendingCatalogDigest: sealedResult.pendingCatalogDigest,
      complete: true,
      candidateCapabilities: [],
    },
    coverage: { state: 'CREATE' as const, inputDigest: 'b'.repeat(64), targetDigest: sealedResult.targetDigest },
    generation: {
      state: 'PROPOSAL_READY' as const,
      action: 'CREATE' as const,
      inputDigest: 'c'.repeat(64),
      resultDigest: sealedResult.receiptDigest,
      sealedResult,
      proposalId: nativeProposalId,
      userRetryUsed: false,
      staleRefreshUsed: false,
      receipts: [{ kind: 'BODY_COMMITTED' as const, digest: 'd'.repeat(64), recordedAt: now }],
    },
    stageCalls: [
      {
        stage: 'CATALOG_SCAN' as const,
        callId: `call_${'1'.repeat(64)}`,
        ordinal: 1,
        inputDigest: '1'.repeat(64),
        outputDigest: '2'.repeat(64),
        provider: 'deepseek-official',
        model: 'deepseek-chat',
        policyVersion: 'catalog-scan-v1',
        outcome: 'SUCCEEDED' as const,
      },
      {
        stage: 'COVERAGE' as const,
        callId: `call_${'2'.repeat(64)}`,
        ordinal: 1,
        inputDigest: '3'.repeat(64),
        outputDigest: '4'.repeat(64),
        provider: 'deepseek-official',
        model: 'deepseek-chat',
        policyVersion: 'coverage-v1',
        outcome: 'SUCCEEDED' as const,
      },
      {
        stage: 'GENERATION' as const,
        callId: sealedResult.callId,
        ordinal: 1,
        inputDigest: '5'.repeat(64),
        outputDigest: '6'.repeat(64),
        provider: 'deepseek-official',
        model: 'deepseek-chat',
        policyVersion: 'generation-v1',
        outcome: 'SUCCEEDED' as const,
      },
    ],
    lineageId: nativeProposalLineage.lineageId,
  }
  const nativeActiveProposalLineage = {
    ...nativeProposalLineage,
    state: 'ACTIVE_PROPOSAL' as const,
    currentProposalRevision: 1,
    proposalRevisions: [{
      revision: 1,
      proposalId: nativeProposalId,
      ownerIntentId: experienceIntent.intentId,
      ownerIntentRevision: experienceIntent.revision,
      action: 'CREATE' as const,
      body: nativeBody,
      runtimeCatalogDigest: sealedResult.runtimeCatalogDigest,
      pendingCatalogDigest: sealedResult.pendingCatalogDigest,
      targetIdentityDigest: sealedResult.targetDigest,
      state: 'ACTIVE_PROPOSAL' as const,
      createdAt: now,
    }],
  }
  return {
    global: createInitialGlobalV2(),
    turnObservation,
    sessionBatch,
    experienceIntent,
    proposalLineage,
    nativeProposalLineage,
    nativeActiveProposalLineage,
    proposalReadyIntent,
    legacyItem,
  }
}
