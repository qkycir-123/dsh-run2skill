import { canonicalJson } from '../../src/domain/learn/identity.js'
import { deriveSessionLifecycleKeyFromFacts } from '../../src/domain/observe/identity.js'
import { sha256Utf8 } from '../../src/domain/observe/hashing.js'
import { derivePublicationTargetIdentityDigest, materializeLineage } from '../../src/domain/publication/schemas.js'
import {
  deriveExperienceIntentIdV2,
  deriveNativeProposalLineageIdV2,
  deriveSessionBatchIdV2,
  deriveTurnObservationIdV2,
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
  const turnObservation = {
    schemaVersion: 1 as const,
    revision: 1,
    observationId: deriveTurnObservationIdV2(observationFacts),
    ...observationFacts,
    turn: 2,
    observedAt: now,
    outcomeKind: 'completed',
    completeness: 'COMPLETE' as const,
    scopeBinding: {
      status: 'PROJECT' as const,
      workspaceId: 'workspace-v2',
      scopeIdentityDigest: 'c'.repeat(64),
    },
    directUserEvidence: evidence,
    evidenceDigest: sha256Utf8(canonicalJson(evidence)),
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
    generation: { state: 'NOT_STARTED' as const, userRetryUsed: false, staleRefreshUsed: false },
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
    createdAt: now,
    updatedAt: now,
  }
  return {
    global: createInitialGlobalV2(),
    turnObservation,
    sessionBatch,
    experienceIntent,
    proposalLineage,
    nativeProposalLineage,
    legacyItem,
  }
}
