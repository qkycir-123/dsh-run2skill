import { z } from 'zod'
import { canonicalJson } from '../learn/identity.js'
import { EvidenceRefSchema, CaptureWorkItemV1Schema } from '../observe/schemas.js'
import { sha256Utf8 } from '../observe/hashing.js'
import { CompletedPurgeFencesV1Schema } from '../purge/schemas.js'
import { LineageV1Schema } from '../publication/schemas.js'

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/)
const isoDateTime = z.string().datetime({ offset: true })
const identity = z.string().min(1).max(256)
const utf8Limited = (maxBytes: number) => z.string().refine(
  value => Buffer.byteLength(value, 'utf8') <= maxBytes,
  `Expected at most ${maxBytes} UTF-8 bytes`,
)
const safeNonNegativeInteger = z.number().refine(
  value => Number.isSafeInteger(value) && value >= 0,
  'Expected a non-negative safe integer',
)
const positiveSafeInteger = z.number().refine(
  value => Number.isSafeInteger(value) && value >= 1,
  'Expected a positive safe integer',
)

export const RUN2SKILL_V2_LIMITS = Object.freeze({
  maxObservationEvidence: 16,
  maxBatchObservations: 256,
  maxBatchTriggerReasons: 3,
  maxIntentsPerBatch: 3,
} as const)

export const PersistenceScopeV2Schema = z.enum(['PROJECT', 'USER'])

export const ScopeBindingV2Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('PROJECT'),
    workspaceId: identity,
    scopeIdentityDigest: sha256Hex,
  }).strict(),
  z.object({
    status: z.literal('USER'),
    scopeIdentityDigest: sha256Hex,
  }).strict(),
  z.object({
    status: z.literal('UNRESOLVED'),
    reason: z.enum(['NO_CWD', 'UNREGISTERED', 'UNAVAILABLE']),
  }).strict(),
])

export interface TurnObservationIdentityFactsV2 {
  readonly sessionLifecycleKey: string
  readonly turnEndSeq: number
  readonly turnInstanceDigest: string
}

export interface TurnObservationContentFactsV2 {
  readonly outcomeKind: string
  readonly assistantOutcomeSummary: string
  readonly toolOutcomeSummary: readonly {
    readonly toolName: string
    readonly outcome: string
    readonly contentDigest: string
  }[]
  readonly routeObservation: {
    readonly provider?: string | undefined
    readonly model?: string | undefined
    readonly complete: boolean
  }
  readonly completeness: 'COMPLETE' | 'INCOMPLETE'
  readonly explicitSaveRequested: boolean
  readonly scopeBinding: unknown
  readonly evidenceDigest: string
}

export function deriveTurnObservationContentDigestV2(facts: TurnObservationContentFactsV2): string {
  return sha256Utf8(canonicalJson({
    outcomeKind: facts.outcomeKind,
    assistantOutcomeSummary: facts.assistantOutcomeSummary,
    toolOutcomeSummary: facts.toolOutcomeSummary,
    routeObservation: facts.routeObservation,
    completeness: facts.completeness,
    explicitSaveRequested: facts.explicitSaveRequested,
    scopeBinding: facts.scopeBinding,
    evidenceDigest: facts.evidenceDigest,
  }))
}

export function deriveTurnObservationIdV2(facts: TurnObservationIdentityFactsV2): `obs_${string}` {
  return `obs_${sha256Utf8(canonicalJson({
    sessionLifecycleKey: facts.sessionLifecycleKey,
    turnEndSeq: facts.turnEndSeq,
    turnInstanceDigest: facts.turnInstanceDigest,
  }))}`
}

export const TurnObservationV2Schema = z.object({
  schemaVersion: z.literal(1),
  revision: positiveSafeInteger,
  observationId: z.string().regex(/^obs_[a-f0-9]{64}$/),
  sessionLifecycleKey: z.string().regex(/^sl_[a-f0-9]{64}$/),
  turn: safeNonNegativeInteger,
  turnEndSeq: safeNonNegativeInteger,
  turnInstanceDigest: sha256Hex,
  observedAt: isoDateTime,
  outcomeKind: z.string().min(1).max(120),
  assistantOutcomeSummary: utf8Limited(4 * 1024),
  toolOutcomeSummary: z.array(z.object({
    toolName: identity,
    outcome: z.string().min(1).max(120),
    contentDigest: sha256Hex,
  }).strict()).max(32),
  routeObservation: z.object({
    provider: identity.optional(),
    model: identity.optional(),
    complete: z.boolean(),
  }).strict(),
  completeness: z.enum(['COMPLETE', 'INCOMPLETE']),
  explicitSaveRequested: z.boolean(),
  scopeBinding: ScopeBindingV2Schema,
  directUserEvidence: z.array(EvidenceRefSchema).max(RUN2SKILL_V2_LIMITS.maxObservationEvidence),
  evidenceDigest: sha256Hex,
  contentDigest: sha256Hex,
}).strict().superRefine((value, context) => {
  if (value.observationId !== deriveTurnObservationIdV2(value)) {
    context.addIssue({ code: 'custom', path: ['observationId'], message: 'Observation id does not match facts' })
  }
  if (value.completeness === 'INCOMPLETE' && value.directUserEvidence.length > 0) {
    context.addIssue({ code: 'custom', path: ['directUserEvidence'], message: 'Incomplete observations must remain metadata-only' })
  }
  if (value.evidenceDigest !== sha256Utf8(canonicalJson(value.directUserEvidence))) {
    context.addIssue({ code: 'custom', path: ['evidenceDigest'], message: 'Observation evidence digest does not match evidence' })
  }
  if (value.contentDigest !== deriveTurnObservationContentDigestV2(value)) {
    context.addIssue({ code: 'custom', path: ['contentDigest'], message: 'Observation content digest does not match normalized facts' })
  }
  if (value.routeObservation.complete && (
    value.routeObservation.provider === undefined || value.routeObservation.model === undefined
  )) context.addIssue({ code: 'custom', path: ['routeObservation'], message: 'Complete route observation requires provider and model' })
})

export const SessionBatchTriggerReasonV2Schema = z.enum(['EXPLICIT', 'THRESHOLD', 'IDLE'])
const BATCH_REASON_ORDER = ['EXPLICIT', 'THRESHOLD', 'IDLE'] as const

export interface SessionBatchIdentityFactsV2 {
  readonly sessionLifecycleKey: string
  readonly firstTurnEndSeq: number
  readonly lastTurnEndSeq: number
  readonly detectorPolicyVersion: string
}

export function deriveSessionBatchIdV2(facts: SessionBatchIdentityFactsV2): `batch_${string}` {
  return `batch_${sha256Utf8(canonicalJson({
    sessionLifecycleKey: facts.sessionLifecycleKey,
    firstTurnEndSeq: facts.firstTurnEndSeq,
    lastTurnEndSeq: facts.lastTurnEndSeq,
    detectorPolicyVersion: facts.detectorPolicyVersion,
  }))}`
}

const BatchManifestBaselineV2Schema = z.object({
  observedAt: isoDateTime,
  rootManifestDigest: sha256Hex,
  runtimeCatalogDigest: sha256Hex,
  complete: z.boolean(),
}).strict()

const BatchManifestEndObservationV2Schema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('PENDING') }).strict(),
  z.object({
    state: z.literal('OBSERVED'),
    observedAt: isoDateTime,
    rootManifestDigest: sha256Hex,
    runtimeCatalogDigest: sha256Hex,
    complete: z.boolean(),
  }).strict(),
])

export const SessionBatchV2Schema = z.object({
  schemaVersion: z.literal(1),
  revision: positiveSafeInteger,
  batchId: z.string().regex(/^batch_[a-f0-9]{64}$/),
  sessionLifecycleKey: z.string().regex(/^sl_[a-f0-9]{64}$/),
  firstTurnEndSeq: safeNonNegativeInteger,
  lastTurnEndSeq: safeNonNegativeInteger,
  detectorPolicyVersion: identity,
  triggerReasons: z.array(SessionBatchTriggerReasonV2Schema)
    .min(1)
    .max(RUN2SKILL_V2_LIMITS.maxBatchTriggerReasons),
  observationManifest: z.array(z.object({
    observationId: z.string().regex(/^obs_[a-f0-9]{64}$/),
    turnEndSeq: safeNonNegativeInteger,
    evidenceDigest: sha256Hex,
    completeness: z.enum(['COMPLETE', 'INCOMPLETE']),
  }).strict())
    .min(1)
    .max(RUN2SKILL_V2_LIMITS.maxBatchObservations),
  observationManifestDigest: sha256Hex,
  batchManifestBaseline: BatchManifestBaselineV2Schema,
  manifestEndObservation: BatchManifestEndObservationV2Schema,
  routeSnapshot: z.object({
    provider: identity,
    model: identity,
    policyVersion: identity,
    maxInputBytes: positiveSafeInteger,
    maxOutputBytes: positiveSafeInteger,
  }).strict(),
  detector: z.object({
    result: z.enum(['NOT_RUN', 'NONE', 'DEFER', 'READY', 'NEEDS_ATTENTION']),
    calls: z.array(z.object({
      stage: z.literal('DETECTION'),
      callId: z.string().regex(/^call_[a-f0-9]{64}$/),
      ordinal: positiveSafeInteger,
      inputDigest: sha256Hex,
      provider: identity,
      model: identity,
      policyVersion: identity,
      outcome: z.enum(['RESERVED', 'SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED_OUT', 'OUTCOME_UNKNOWN']),
      outputDigest: sha256Hex.optional(),
      failureCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
    }).strict()).max(1),
    carryDigest: sha256Hex.optional(),
    intentIds: z.array(z.string().regex(/^intent_[a-f0-9]{64}$/)).max(RUN2SKILL_V2_LIMITS.maxIntentsPerBatch),
  }).strict(),
  state: z.enum(['FROZEN', 'DETECTION_CLAIMED', 'COMMITTED_NONE', 'COMMITTED_DEFER', 'COMMITTED_READY', 'NEEDS_ATTENTION']),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
}).strict().superRefine((value, context) => {
  if (value.firstTurnEndSeq > value.lastTurnEndSeq) {
    context.addIssue({ code: 'custom', path: ['lastTurnEndSeq'], message: 'Batch range is reversed' })
  }
  if (value.batchId !== deriveSessionBatchIdV2(value)) {
    context.addIssue({ code: 'custom', path: ['batchId'], message: 'Batch id does not match facts' })
  }
  if (new Set(value.triggerReasons).size !== value.triggerReasons.length) {
    context.addIssue({ code: 'custom', path: ['triggerReasons'], message: 'Batch trigger reasons must be unique' })
  }
  if (!value.triggerReasons.every((reason, index, values) => (
    index === 0 || BATCH_REASON_ORDER.indexOf(values[index - 1]!) < BATCH_REASON_ORDER.indexOf(reason)
  ))) {
    context.addIssue({ code: 'custom', path: ['triggerReasons'], message: 'Batch trigger reasons must use canonical order' })
  }
  const observationIds = value.observationManifest.map(entry => entry.observationId)
  if (new Set(observationIds).size !== observationIds.length) {
    context.addIssue({ code: 'custom', path: ['observationManifest'], message: 'Batch observations must be unique' })
  }
  const turnEndSeqs = value.observationManifest.map(entry => entry.turnEndSeq)
  if (
    turnEndSeqs[0] !== value.firstTurnEndSeq
    || turnEndSeqs.at(-1) !== value.lastTurnEndSeq
    || turnEndSeqs.some((seq, index) => index > 0 && seq <= turnEndSeqs[index - 1]!)
  ) context.addIssue({ code: 'custom', path: ['observationManifest'], message: 'Batch manifest must be ordered and bind the frozen range' })
  if (value.observationManifestDigest !== sha256Utf8(canonicalJson(value.observationManifest))) {
    context.addIssue({ code: 'custom', path: ['observationManifestDigest'], message: 'Batch observation digest does not match ids' })
  }
  const expectedResult = value.state === 'COMMITTED_NONE' ? 'NONE'
    : value.state === 'COMMITTED_DEFER' ? 'DEFER'
      : value.state === 'COMMITTED_READY' ? 'READY'
        : value.state === 'NEEDS_ATTENTION' ? 'NEEDS_ATTENTION'
          : 'NOT_RUN'
  if (value.detector.result !== expectedResult) {
    context.addIssue({ code: 'custom', path: ['detector', 'result'], message: 'Detector result does not match batch state' })
  }
  if (value.detector.result === 'READY' && value.detector.intentIds.length === 0) {
    context.addIssue({ code: 'custom', path: ['detector', 'intentIds'], message: 'READY detector result requires at least one Intent' })
  }
  if (value.detector.result !== 'READY' && value.detector.intentIds.length > 0) {
    context.addIssue({ code: 'custom', path: ['detector', 'intentIds'], message: 'Only READY detector result may reference Intents' })
  }
  if (value.state === 'DETECTION_CLAIMED' && (
    value.detector.calls.length !== 1 || value.detector.calls[0]?.outcome !== 'RESERVED'
  )) context.addIssue({ code: 'custom', path: ['detector', 'calls'], message: 'Claimed detection requires one reserved call' })
  if (value.state.startsWith('COMMITTED_') && (
    value.detector.calls.length !== 1 || value.detector.calls[0]?.outcome !== 'SUCCEEDED'
  )) context.addIssue({ code: 'custom', path: ['detector', 'calls'], message: 'Committed detection requires one successful call' })
  if (value.state === 'FROZEN' && value.detector.calls.length !== 0) {
    context.addIssue({ code: 'custom', path: ['detector', 'calls'], message: 'Frozen batch cannot have a detector call' })
  }
  if (value.detector.calls.some(call => call.outcome === 'SUCCEEDED' && call.outputDigest === undefined)) {
    context.addIssue({ code: 'custom', path: ['detector', 'calls'], message: 'Successful detector call requires an output digest' })
  }
})

export interface ExperienceIntentIdentityFactsV2 {
  readonly sessionLifecycleKey: string
  readonly behaviorSignature: string
  readonly evidenceDigests: readonly string[]
  readonly detectorPolicyVersion: string
}

export interface RecallSelfExclusionFactsV2 {
  readonly intentId: string
  readonly priorGenerationRevision: number
  readonly barrierReceiptDigest: string
}

export function deriveRecallSelfExclusionDigestV2(facts: RecallSelfExclusionFactsV2): string {
  return sha256Utf8(canonicalJson({
    intentId: facts.intentId,
    priorGenerationRevision: facts.priorGenerationRevision,
    barrierReceiptDigest: facts.barrierReceiptDigest,
  }))
}

export function deriveExperienceIntentIdV2(facts: ExperienceIntentIdentityFactsV2): `intent_${string}` {
  return `intent_${sha256Utf8(canonicalJson({
    sessionLifecycleKey: facts.sessionLifecycleKey,
    behaviorSignature: facts.behaviorSignature,
    evidenceDigests: [...facts.evidenceDigests].sort(),
    detectorPolicyVersion: facts.detectorPolicyVersion,
  }))}`
}

export const ExperienceIntentStatusV2Schema = z.enum([
  'READY',
  'OWNERSHIP_ARBITRATING',
  'RESOLVED_BY_AGENT',
  'NEEDS_CONFIRMATION',
  'RUN2SKILL_OWNED',
  'RECALLING',
  'COVERAGE_READY',
  'COVERAGE_ANALYZING',
  'COVERED',
  'COVERED_NEEDS_CONFIRMATION',
  'COVERAGE_RETRY_AUTHORIZED',
  'CREATE_AUTHORIZED',
  'MERGE_AUTHORIZED',
  'GENERATING',
  'PROPOSAL_READY',
  'NEEDS_ATTENTION',
  'DISCARDED',
])

const SealedSkillBodyV2Schema = z.object({
  name: z.string().min(1).max(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: utf8Limited(2 * 1024),
  whenToUse: utf8Limited(4 * 1024),
  exactSkillBytes: utf8Limited(64 * 1024),
  skillBytesDigest: sha256Hex,
}).strict().superRefine((value, context) => {
  if (value.skillBytesDigest !== sha256Utf8(value.exactSkillBytes)) {
    context.addIssue({ code: 'custom', path: ['skillBytesDigest'], message: 'Skill bytes digest does not match immutable body' })
  }
})

const SealedGenerationResultV2Schema = z.object({
  resultId: z.string().regex(/^result_[a-f0-9]{64}$/),
  leaseId: z.string().regex(/^lease_[a-f0-9]{64}$/),
  intentId: z.string().regex(/^intent_[a-f0-9]{64}$/),
  generationRevision: positiveSafeInteger,
  callId: z.string().regex(/^call_[a-f0-9]{64}$/),
  action: z.enum(['CREATE', 'MERGE']),
  body: SealedSkillBodyV2Schema,
  targetDigest: sha256Hex,
  inputDigest: sha256Hex,
  runtimeCatalogDigest: sha256Hex,
  pendingCatalogDigest: sha256Hex,
  externalPendingDigest: sha256Hex,
  inputCatalogEpoch: safeNonNegativeInteger,
  outcomeCatalogEpoch: safeNonNegativeInteger,
  sealedAt: isoDateTime,
  mutationReceiptDigest: sha256Hex,
  receiptDigest: sha256Hex,
}).strict()

const GenerationBarrierV2Schema = z.object({
  barrierId: z.string().regex(/^barrier_[a-f0-9]{64}$/),
  leaseId: z.string().regex(/^lease_[a-f0-9]{64}$/),
  intentId: z.string().regex(/^intent_[a-f0-9]{64}$/),
  generationRevision: positiveSafeInteger,
  kind: z.enum(['KNOWN_FAILED', 'RESULT_LOST', 'OUTCOME_UNKNOWN', 'STALE_RESULT']),
  behaviorSignature: sha256Hex,
  inputDigest: sha256Hex,
  callId: z.string().regex(/^call_[a-f0-9]{64}$/).optional(),
  priorGenerationRevision: positiveSafeInteger.optional(),
  inputCatalogEpoch: safeNonNegativeInteger,
  outcomeCatalogEpoch: safeNonNegativeInteger,
  mutationReceiptDigest: sha256Hex,
  recordedAt: isoDateTime,
  receiptDigest: sha256Hex,
}).strict()

export const ExperienceIntentV2Schema = z.object({
  schemaVersion: z.literal(1),
  revision: positiveSafeInteger,
  intentId: z.string().regex(/^intent_[a-f0-9]{64}$/),
  batchId: z.string().regex(/^batch_[a-f0-9]{64}$/),
  ordinal: positiveSafeInteger.refine(value => value <= RUN2SKILL_V2_LIMITS.maxIntentsPerBatch),
  sessionLifecycleKey: z.string().regex(/^sl_[a-f0-9]{64}$/),
  detectorPolicyVersion: identity,
  persistenceScope: PersistenceScopeV2Schema,
  explicitSave: z.boolean(),
  behaviorSignature: sha256Hex,
  evidenceRefs: z.array(z.object({
    observationId: z.string().regex(/^obs_[a-f0-9]{64}$/),
    sessionLifecycleKey: z.string().regex(/^sl_[a-f0-9]{64}$/),
    turnEndSeq: safeNonNegativeInteger,
    evidenceDigest: sha256Hex,
  }).strict()).min(1).max(RUN2SKILL_V2_LIMITS.maxBatchObservations),
  evidenceDigests: z.array(sha256Hex).min(1).max(RUN2SKILL_V2_LIMITS.maxBatchObservations),
  completeness: z.object({
    status: z.enum(['COMPLETE', 'INCOMPLETE']),
    blockers: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)).max(8),
  }).strict(),
  ownership: z.object({
    state: z.enum(['NOT_STARTED', 'ARBITRATING', 'RESOLVED_BY_AGENT', 'NEEDS_CONFIRMATION', 'RUN2SKILL_OWNED']),
    evidenceDigest: sha256Hex.optional(),
    receiptDigest: sha256Hex.optional(),
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
  }).strict(),
  recall: z.object({
    state: z.enum(['NOT_STARTED', 'SCANNING', 'COMPLETE', 'INCOMPLETE']),
    runtimeCatalogDigest: sha256Hex.optional(),
    pendingCatalogDigest: sha256Hex.optional(),
    complete: z.boolean(),
    summaryScanComplete: z.boolean(),
    catalogEpoch: safeNonNegativeInteger.optional(),
    catalogMutationReceiptDigest: sha256Hex.optional(),
    incompleteReason: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
    selfExclusion: z.object({
      intentId: z.string().regex(/^intent_[a-f0-9]{64}$/),
      priorGenerationRevision: positiveSafeInteger,
      barrierReceiptDigest: sha256Hex,
      selfExclusionDigest: sha256Hex,
    }).strict().optional(),
    candidates: z.array(z.object({
      candidateId: identity,
      summary: z.object({
        name: z.string().min(1).max(128),
        description: utf8Limited(2 * 1024),
        whenToUse: utf8Limited(4 * 1024).optional(),
        provider: identity,
        source: identity,
        scope: PersistenceScopeV2Schema,
        writable: z.boolean(),
      }).strict(),
      classification: z.enum(['RELEVANT', 'POSSIBLE', 'UNRELATED']),
      capability: z.enum(['AVAILABLE', 'READABLE_NOT_MERGEABLE', 'UNAVAILABLE']),
      bodyDigest: sha256Hex.optional(),
      unavailableReason: z.enum([
        'CATALOG_INCOMPLETE', 'CANDIDATE_DISAPPEARED', 'IDENTITY_CHANGED', 'READ_FAILED',
        'FILTERED_UNSAFE', 'INPUT_BUDGET_EXCEEDED', 'READ_TIMEOUT', 'SNAPSHOT_TIMEOUT',
      ]).optional(),
    }).strict()).max(1024),
  }).strict(),
  coverage: z.object({
    state: z.enum(['NOT_STARTED', 'ANALYZING', 'COVERED', 'CREATE', 'MERGE', 'NEEDS_ATTENTION']),
    inputDigest: sha256Hex.optional(),
    targetDigest: sha256Hex.optional(),
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
  }).strict(),
  generation: z.object({
    state: z.enum([
      'NOT_STARTED', 'GENERATION_AUTHORIZED', 'GENERATION_LEASED', 'GENERATION_CALL_RESERVED',
      'GENERATION_CALL_TERMINAL', 'RESULT_COMMITTED', 'PROPOSAL_COMMIT_AUTHORIZED',
      'PROPOSAL_BODY_COMMITTED', 'PROPOSAL_READY', 'NEEDS_ATTENTION',
    ]),
    action: z.enum(['CREATE', 'MERGE']).optional(),
    inputDigest: sha256Hex.optional(),
    resultDigest: sha256Hex.optional(),
    leaseId: z.string().regex(/^lease_[a-f0-9]{64}$/).optional(),
    generationRevision: positiveSafeInteger.optional(),
    catalogEpoch: safeNonNegativeInteger.optional(),
    externalPendingDigest: sha256Hex.optional(),
    selfExclusionDigest: sha256Hex.optional(),
    sealedResult: SealedGenerationResultV2Schema.optional(),
    proposalId: z.string().regex(/^prop_[a-f0-9]{64}$/).optional(),
    reasonCode: z.enum(['GENERATION_KNOWN_FAILED', 'GENERATION_RESULT_LOST', 'GENERATION_OUTCOME_UNKNOWN', 'STALE_RESULT']).optional(),
    revalidationAuthorization: z.object({
      runtimeCatalogDigest: sha256Hex,
      pendingCatalogDigest: sha256Hex,
      externalPendingDigest: sha256Hex,
      catalogEpoch: safeNonNegativeInteger,
      catalogMutationReceiptDigest: sha256Hex,
      sealedResultReceiptDigest: sha256Hex,
      selfExclusionDigest: sha256Hex.optional(),
      authorizedAt: isoDateTime,
    }).strict().optional(),
    userRetryUsed: z.boolean(),
    staleRefreshUsed: z.boolean(),
    receipts: z.array(z.object({
      kind: z.enum(['LEASE_ACQUIRED', 'CALL_RESERVED', 'CALL_TERMINAL', 'RESULT_SEALED', 'BARRIER_COMMITTED', 'PROPOSAL_AUTHORIZED', 'BODY_COMMITTED', 'INDEX_COMMITTED']),
      digest: sha256Hex,
      leaseId: z.string().regex(/^lease_[a-f0-9]{64}$/),
      intentId: z.string().regex(/^intent_[a-f0-9]{64}$/),
      generationRevision: positiveSafeInteger,
      callId: z.string().regex(/^call_[a-f0-9]{64}$/).optional(),
      catalogEpoch: safeNonNegativeInteger.optional(),
      recordedAt: isoDateTime,
    }).strict()).max(32),
  }).strict(),
  duplicateBarrier: GenerationBarrierV2Schema.optional(),
  stageCalls: z.array(z.object({
    stage: z.enum(['CATALOG_SCAN', 'COVERAGE', 'GENERATION']),
    intentRevision: positiveSafeInteger,
    callId: z.string().regex(/^call_[a-f0-9]{64}$/),
    ordinal: positiveSafeInteger,
    inputDigest: sha256Hex,
    provider: identity,
    model: identity,
    policyVersion: identity,
    outcome: z.enum(['RESERVED', 'SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED_OUT', 'OUTCOME_UNKNOWN']),
    outputDigest: sha256Hex.optional(),
    failureCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
  }).strict()).max(32),
  reasonReceipts: z.array(z.object({
    revision: positiveSafeInteger,
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    recordedAt: isoDateTime,
  }).strict()).max(32),
  lineageId: z.string().regex(/^lin_[a-f0-9]{64}$/).optional(),
  status: ExperienceIntentStatusV2Schema,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
}).strict().superRefine((value, context) => {
  if (value.intentId !== deriveExperienceIntentIdV2(value)) {
    context.addIssue({ code: 'custom', path: ['intentId'], message: 'Intent id does not match facts' })
  }
  const canonicalEvidenceDigests = [...value.evidenceDigests].sort()
  if (
    new Set(value.evidenceDigests).size !== value.evidenceDigests.length
    || canonicalJson(value.evidenceDigests) !== canonicalJson(canonicalEvidenceDigests)
  ) context.addIssue({ code: 'custom', path: ['evidenceDigests'], message: 'Intent evidence digests must be unique and sorted' })
  if (value.evidenceRefs.some(ref => ref.sessionLifecycleKey !== value.sessionLifecycleKey)) {
    context.addIssue({ code: 'custom', path: ['evidenceRefs'], message: 'Intent evidence must stay within one lifecycle' })
  }
  const expectStage = (
    actual: string,
    expected: string | readonly string[],
    path: (string | number)[],
  ) => {
    const allowed = typeof expected === 'string' ? [expected] : expected
    if (!allowed.includes(actual)) context.addIssue({ code: 'custom', path, message: 'Intent substate does not match authoritative status' })
  }
  const noDownstreamWork = () => {
    expectStage(value.recall.state, 'NOT_STARTED', ['recall', 'state'])
    expectStage(value.coverage.state, 'NOT_STARTED', ['coverage', 'state'])
    expectStage(value.generation.state, 'NOT_STARTED', ['generation', 'state'])
  }
  switch (value.status) {
    case 'READY':
      expectStage(value.ownership.state, 'NOT_STARTED', ['ownership', 'state']); noDownstreamWork(); break
    case 'OWNERSHIP_ARBITRATING':
      expectStage(value.ownership.state, 'ARBITRATING', ['ownership', 'state']); noDownstreamWork(); break
    case 'RESOLVED_BY_AGENT':
      expectStage(value.ownership.state, 'RESOLVED_BY_AGENT', ['ownership', 'state']); noDownstreamWork(); break
    case 'NEEDS_CONFIRMATION':
      expectStage(value.ownership.state, 'NEEDS_CONFIRMATION', ['ownership', 'state']); noDownstreamWork(); break
    case 'RUN2SKILL_OWNED':
      expectStage(value.ownership.state, 'RUN2SKILL_OWNED', ['ownership', 'state']); noDownstreamWork(); break
    case 'RECALLING':
      expectStage(value.ownership.state, 'RUN2SKILL_OWNED', ['ownership', 'state'])
      expectStage(value.recall.state, 'SCANNING', ['recall', 'state'])
      expectStage(value.coverage.state, 'NOT_STARTED', ['coverage', 'state'])
      expectStage(value.generation.state, 'NOT_STARTED', ['generation', 'state'])
      break
    case 'COVERAGE_READY':
      expectStage(value.ownership.state, 'RUN2SKILL_OWNED', ['ownership', 'state'])
      expectStage(value.recall.state, 'COMPLETE', ['recall', 'state'])
      expectStage(value.coverage.state, 'NOT_STARTED', ['coverage', 'state'])
      expectStage(value.generation.state, 'NOT_STARTED', ['generation', 'state'])
      break
    case 'COVERAGE_ANALYZING':
    case 'COVERAGE_RETRY_AUTHORIZED':
      expectStage(value.ownership.state, 'RUN2SKILL_OWNED', ['ownership', 'state'])
      expectStage(value.recall.state, 'COMPLETE', ['recall', 'state'])
      expectStage(value.coverage.state, 'ANALYZING', ['coverage', 'state'])
      expectStage(value.generation.state, 'NOT_STARTED', ['generation', 'state'])
      break
    case 'COVERED':
    case 'COVERED_NEEDS_CONFIRMATION':
      expectStage(value.ownership.state, 'RUN2SKILL_OWNED', ['ownership', 'state'])
      expectStage(value.recall.state, 'COMPLETE', ['recall', 'state'])
      expectStage(value.coverage.state, 'COVERED', ['coverage', 'state'])
      expectStage(value.generation.state, 'NOT_STARTED', ['generation', 'state'])
      break
    case 'CREATE_AUTHORIZED':
    case 'MERGE_AUTHORIZED': {
      const action = value.status === 'CREATE_AUTHORIZED' ? 'CREATE' : 'MERGE'
      expectStage(value.ownership.state, 'RUN2SKILL_OWNED', ['ownership', 'state'])
      expectStage(value.recall.state, 'COMPLETE', ['recall', 'state'])
      expectStage(value.coverage.state, action, ['coverage', 'state'])
      expectStage(value.generation.state, 'GENERATION_AUTHORIZED', ['generation', 'state'])
      expectStage(value.generation.action ?? '', action, ['generation', 'action'])
      break
    }
    case 'GENERATING':
      expectStage(value.ownership.state, 'RUN2SKILL_OWNED', ['ownership', 'state'])
      expectStage(value.recall.state, 'COMPLETE', ['recall', 'state'])
      expectStage(value.coverage.state, ['CREATE', 'MERGE'], ['coverage', 'state'])
      expectStage(value.generation.state, [
        'GENERATION_LEASED', 'GENERATION_CALL_RESERVED', 'GENERATION_CALL_TERMINAL',
        'RESULT_COMMITTED', 'PROPOSAL_COMMIT_AUTHORIZED', 'PROPOSAL_BODY_COMMITTED',
      ], ['generation', 'state'])
      break
    case 'PROPOSAL_READY':
      expectStage(value.ownership.state, 'RUN2SKILL_OWNED', ['ownership', 'state'])
      expectStage(value.recall.state, 'COMPLETE', ['recall', 'state'])
      expectStage(value.coverage.state, ['CREATE', 'MERGE'], ['coverage', 'state'])
      expectStage(value.generation.state, 'PROPOSAL_READY', ['generation', 'state'])
      break
    case 'NEEDS_ATTENTION':
      if (
        value.ownership.state !== 'NEEDS_CONFIRMATION'
        && value.recall.state !== 'INCOMPLETE'
        && value.coverage.state !== 'NEEDS_ATTENTION'
        && value.generation.state !== 'NEEDS_ATTENTION'
      ) context.addIssue({ code: 'custom', path: ['status'], message: 'Attention status requires an authoritative attention substate' })
      break
    case 'DISCARDED':
      if (value.reasonReceipts.length === 0) context.addIssue({ code: 'custom', path: ['reasonReceipts'], message: 'Discarded Intent requires a durable user/action receipt' })
      expectStage(value.generation.state, 'NOT_STARTED', ['generation', 'state'])
      if (value.lineageId !== undefined) context.addIssue({ code: 'custom', path: ['lineageId'], message: 'Discarded Intent cannot retain active Proposal membership' })
      break
    default: {
      const unreachable: never = value.status
      void unreachable
    }
  }
  if (value.ownership.state === 'RUN2SKILL_OWNED' && (
    value.ownership.evidenceDigest === undefined || value.ownership.receiptDigest === undefined
  )) context.addIssue({ code: 'custom', path: ['ownership'], message: 'Run2Skill ownership requires evidence and a durable receipt' })
  if (value.recall.complete !== (value.recall.state === 'COMPLETE')) {
    context.addIssue({ code: 'custom', path: ['recall', 'complete'], message: 'Recall completeness must match its state' })
  }
  if (value.recall.state === 'COMPLETE' && (
    !value.recall.summaryScanComplete
    || value.recall.runtimeCatalogDigest === undefined
    || value.recall.pendingCatalogDigest === undefined
    || value.recall.catalogEpoch === undefined
    || value.recall.catalogMutationReceiptDigest === undefined
  )) context.addIssue({ code: 'custom', path: ['recall'], message: 'Complete recall requires full Catalog and summary-scan facts' })
  if (value.recall.state === 'NOT_STARTED' && (
    value.recall.summaryScanComplete
    || value.recall.candidates.length > 0
    || value.recall.runtimeCatalogDigest !== undefined
    || value.recall.pendingCatalogDigest !== undefined
  )) context.addIssue({ code: 'custom', path: ['recall'], message: 'Unstarted recall cannot contain Catalog results' })
  if (value.recall.state === 'INCOMPLETE' && value.recall.incompleteReason === undefined) {
    context.addIssue({ code: 'custom', path: ['recall', 'incompleteReason'], message: 'Incomplete recall requires a reason' })
  }
  for (const [index, candidate] of value.recall.candidates.entries()) {
    if ((candidate.capability === 'UNAVAILABLE') !== (candidate.unavailableReason !== undefined)) {
      context.addIssue({ code: 'custom', path: ['recall', 'candidates', index], message: 'Unavailable capability requires exactly one reason' })
    }
    if (candidate.capability !== 'UNAVAILABLE' && candidate.bodyDigest === undefined) {
      context.addIssue({ code: 'custom', path: ['recall', 'candidates', index, 'bodyDigest'], message: 'Readable candidate requires a full body digest' })
    }
  }
  if (value.recall.selfExclusion !== undefined && (
    value.recall.selfExclusion.intentId !== value.intentId
    || value.recall.selfExclusion.priorGenerationRevision >= value.revision
    || !value.generation.staleRefreshUsed
    || value.recall.selfExclusion.selfExclusionDigest !== deriveRecallSelfExclusionDigestV2(value.recall.selfExclusion)
  )) context.addIssue({ code: 'custom', path: ['recall', 'selfExclusion'], message: 'Self-exclusion is only valid for an exact stale refresh revision' })
  if (value.coverage.state === 'CREATE' && value.recall.candidates.some(candidate => (
    candidate.classification !== 'UNRELATED' && candidate.capability === 'UNAVAILABLE'
  ))) context.addIssue({ code: 'custom', path: ['coverage'], message: 'Create authorization cannot use absence proof with unavailable relevant candidates' })
  const generation = value.generation
  const generationCalls = value.stageCalls.filter(call => call.stage === 'GENERATION')
  const currentGenerationCalls = generation.generationRevision === undefined
    ? []
    : generationCalls.filter(call => call.intentRevision === generation.generationRevision)
  const receiptFor = (kind: typeof generation.receipts[number]['kind']) => generation.receipts.find(receipt => receipt.kind === kind)
  if (generation.state === 'NOT_STARTED') {
    if (
      generation.action !== undefined
      || generation.inputDigest !== undefined
      || generation.resultDigest !== undefined
      || generation.leaseId !== undefined
      || generation.generationRevision !== undefined
      || generation.catalogEpoch !== undefined
      || generation.externalPendingDigest !== undefined
      || generation.selfExclusionDigest !== undefined
      || generation.sealedResult !== undefined
      || generation.proposalId !== undefined
      || generation.reasonCode !== undefined
      || generation.revalidationAuthorization !== undefined
      || generation.receipts.length > 0
      || generationCalls.some(call => call.intentRevision === value.revision)
    ) context.addIssue({ code: 'custom', path: ['generation'], message: 'Unstarted generation cannot contain future recovery facts' })
  } else if (
    generation.action === undefined
    || generation.inputDigest === undefined
    || generation.generationRevision === undefined
    || generation.catalogEpoch === undefined
    || generation.externalPendingDigest === undefined
    || generation.generationRevision > value.revision
  ) context.addIssue({ code: 'custom', path: ['generation'], message: 'Active generation requires action, input, and bounded revision facts' })
  if (generation.state !== 'NOT_STARTED' && (
    generation.catalogEpoch !== value.recall.catalogEpoch
    || (['CREATE', 'MERGE'].includes(value.coverage.state) && generation.action !== value.coverage.state)
  )) context.addIssue({ code: 'custom', path: ['generation'], message: 'Generation authorization must bind the current recall epoch and coverage action' })
  if (generation.state !== 'NEEDS_ATTENTION' && generation.reasonCode !== undefined) {
    context.addIssue({ code: 'custom', path: ['generation', 'reasonCode'], message: 'Only an attention generation may retain a failure reason' })
  }
  const leaseStates = new Set([
    'GENERATION_LEASED', 'GENERATION_CALL_RESERVED', 'GENERATION_CALL_TERMINAL', 'RESULT_COMMITTED',
    'PROPOSAL_COMMIT_AUTHORIZED', 'PROPOSAL_BODY_COMMITTED', 'PROPOSAL_READY', 'NEEDS_ATTENTION',
  ])
  if (leaseStates.has(generation.state) !== (generation.leaseId !== undefined)) {
    context.addIssue({ code: 'custom', path: ['generation', 'leaseId'], message: 'Leased generation state requires the durable lease identity' })
  }
  const receiptKinds = generation.receipts.map(receipt => receipt.kind)
  if (new Set(receiptKinds).size !== receiptKinds.length) {
    context.addIssue({ code: 'custom', path: ['generation', 'receipts'], message: 'Generation receipt kinds must be unique' })
  }
  const receiptDigests = generation.receipts.map(receipt => receipt.digest)
  if (new Set(receiptDigests).size !== receiptDigests.length) {
    context.addIssue({ code: 'custom', path: ['generation', 'receipts'], message: 'Generation receipt digests must be unique durable identities' })
  }
  for (const [index, receipt] of generation.receipts.entries()) {
    const expectedCatalogEpoch = ['BODY_COMMITTED', 'INDEX_COMMITTED'].includes(receipt.kind)
      ? generation.revalidationAuthorization === undefined
        ? undefined
        : generation.revalidationAuthorization.catalogEpoch + 1
      : ['RESULT_SEALED', 'PROPOSAL_AUTHORIZED'].includes(receipt.kind)
        ? generation.sealedResult?.outcomeCatalogEpoch
      : receipt.kind === 'BARRIER_COMMITTED'
        ? value.duplicateBarrier?.outcomeCatalogEpoch
        : generation.catalogEpoch
    if (
      receipt.intentId !== value.intentId
      || receipt.generationRevision !== generation.generationRevision
      || receipt.leaseId !== generation.leaseId
      || receipt.catalogEpoch !== expectedCatalogEpoch
    ) context.addIssue({ code: 'custom', path: ['generation', 'receipts', index], message: 'Generation receipt is outside its exact owner revision and lease' })
    const expectedCallId = receipt.kind === 'BARRIER_COMMITTED'
      ? value.duplicateBarrier?.callId
      : ['CALL_RESERVED', 'CALL_TERMINAL', 'RESULT_SEALED'].includes(receipt.kind)
        ? currentGenerationCalls[0]?.callId
        : undefined
    if (receipt.callId !== expectedCallId) {
      context.addIssue({ code: 'custom', path: ['generation', 'receipts', index, 'callId'], message: 'Generation receipt call identity does not match its ledger stage' })
    }
  }
  const fixedReceiptPrefix: Partial<Record<typeof generation.state, readonly string[]>> = {
    NOT_STARTED: [],
    GENERATION_AUTHORIZED: [],
    GENERATION_LEASED: ['LEASE_ACQUIRED'],
    GENERATION_CALL_RESERVED: ['LEASE_ACQUIRED', 'CALL_RESERVED'],
    GENERATION_CALL_TERMINAL: ['LEASE_ACQUIRED', 'CALL_RESERVED', 'CALL_TERMINAL'],
    RESULT_COMMITTED: ['LEASE_ACQUIRED', 'CALL_RESERVED', 'CALL_TERMINAL', 'RESULT_SEALED'],
    PROPOSAL_COMMIT_AUTHORIZED: ['LEASE_ACQUIRED', 'CALL_RESERVED', 'CALL_TERMINAL', 'RESULT_SEALED', 'PROPOSAL_AUTHORIZED'],
    PROPOSAL_BODY_COMMITTED: ['LEASE_ACQUIRED', 'CALL_RESERVED', 'CALL_TERMINAL', 'RESULT_SEALED', 'PROPOSAL_AUTHORIZED', 'BODY_COMMITTED'],
    PROPOSAL_READY: ['LEASE_ACQUIRED', 'CALL_RESERVED', 'CALL_TERMINAL', 'RESULT_SEALED', 'PROPOSAL_AUTHORIZED', 'BODY_COMMITTED', 'INDEX_COMMITTED'],
  }
  const expectedReceiptKinds = generation.state === 'NEEDS_ATTENTION'
    ? generation.reasonCode === 'STALE_RESULT'
      ? ['LEASE_ACQUIRED', 'CALL_RESERVED', 'CALL_TERMINAL', 'RESULT_SEALED']
      : ['LEASE_ACQUIRED', 'CALL_RESERVED', 'CALL_TERMINAL', 'BARRIER_COMMITTED']
    : fixedReceiptPrefix[generation.state]
  if (canonicalJson(receiptKinds) !== canonicalJson(expectedReceiptKinds)) {
    context.addIssue({ code: 'custom', path: ['generation', 'receipts'], message: 'Generation receipts must equal the exact durable prefix for its state' })
  }
  if (['GENERATION_AUTHORIZED', 'GENERATION_LEASED'].includes(generation.state) && currentGenerationCalls.length !== 0) {
    context.addIssue({ code: 'custom', path: ['stageCalls'], message: 'Pre-call generation cannot contain a current call' })
  }
  if (generation.state === 'GENERATION_CALL_RESERVED' && (
    currentGenerationCalls.length !== 1 || currentGenerationCalls[0]?.outcome !== 'RESERVED'
  )) context.addIssue({ code: 'custom', path: ['stageCalls'], message: 'Reserved generation requires one matching reserved call' })
  const terminalCallStates = new Set([
    'GENERATION_CALL_TERMINAL', 'RESULT_COMMITTED', 'PROPOSAL_COMMIT_AUTHORIZED',
    'PROPOSAL_BODY_COMMITTED', 'PROPOSAL_READY', 'NEEDS_ATTENTION',
  ])
  if (terminalCallStates.has(generation.state) && (
    currentGenerationCalls.length !== 1
    || currentGenerationCalls[0]?.outcome === 'RESERVED'
    || currentGenerationCalls[0]?.inputDigest !== generation.inputDigest
  )) context.addIssue({ code: 'custom', path: ['stageCalls'], message: 'Terminal generation state requires one exact terminal call' })
  const committedResultStates = new Set([
    'RESULT_COMMITTED', 'PROPOSAL_COMMIT_AUTHORIZED', 'PROPOSAL_BODY_COMMITTED', 'PROPOSAL_READY',
  ])
  const hasAuthoritativeSealedResult = committedResultStates.has(generation.state)
    || (generation.state === 'NEEDS_ATTENTION' && generation.reasonCode === 'STALE_RESULT')
  if (hasAuthoritativeSealedResult && (
    currentGenerationCalls[0]?.outcome !== 'SUCCEEDED'
    || generation.sealedResult === undefined
    || generation.resultDigest === undefined
  )) context.addIssue({ code: 'custom', path: ['generation'], message: 'Committed result state requires one successful call and sealed result' })
  if (!hasAuthoritativeSealedResult && (
    generation.sealedResult !== undefined || generation.resultDigest !== undefined
  )) context.addIssue({ code: 'custom', path: ['generation'], message: 'Pre-result generation cannot contain sealed result facts' })
  if (generation.sealedResult !== undefined && (
    generation.sealedResult.intentId !== value.intentId
    || generation.sealedResult.leaseId !== generation.leaseId
    || generation.sealedResult.generationRevision !== generation.generationRevision
    || generation.sealedResult.inputCatalogEpoch !== generation.catalogEpoch
    || generation.sealedResult.outcomeCatalogEpoch !== generation.sealedResult.inputCatalogEpoch + 1
    || generation.sealedResult.callId !== currentGenerationCalls[0]?.callId
    || generation.sealedResult.action !== generation.action
    || generation.sealedResult.inputDigest !== generation.inputDigest
    || generation.sealedResult.externalPendingDigest !== generation.externalPendingDigest
    || generation.sealedResult.targetDigest !== value.coverage.targetDigest
    || generation.sealedResult.runtimeCatalogDigest !== value.recall.runtimeCatalogDigest
    || generation.sealedResult.pendingCatalogDigest !== value.recall.pendingCatalogDigest
    || generation.sealedResult.mutationReceiptDigest !== receiptFor('RESULT_SEALED')?.digest
    || generation.resultDigest !== generation.sealedResult.receiptDigest
  )) context.addIssue({ code: 'custom', path: ['generation', 'sealedResult'], message: 'Sealed result is outside its exact lease/Intent revision' })
  const proposalCommitStates = new Set(['PROPOSAL_COMMIT_AUTHORIZED', 'PROPOSAL_BODY_COMMITTED', 'PROPOSAL_READY'])
  if (
    (proposalCommitStates.has(generation.state) && (
      generation.revalidationAuthorization === undefined || generation.proposalId === undefined
    ))
    || (!proposalCommitStates.has(generation.state) && (
      generation.revalidationAuthorization !== undefined || generation.proposalId !== undefined
    ))
  ) context.addIssue({ code: 'custom', path: ['generation', 'revalidationAuthorization'], message: 'Proposal commit fields must exist only after exact authorization' })
  if (generation.revalidationAuthorization !== undefined && (
    generation.revalidationAuthorization.catalogEpoch !== generation.sealedResult?.outcomeCatalogEpoch
    || generation.revalidationAuthorization.catalogMutationReceiptDigest !== generation.sealedResult?.mutationReceiptDigest
    || generation.revalidationAuthorization.sealedResultReceiptDigest !== generation.sealedResult?.receiptDigest
    || generation.revalidationAuthorization.runtimeCatalogDigest !== generation.sealedResult?.runtimeCatalogDigest
    || generation.revalidationAuthorization.runtimeCatalogDigest !== value.recall.runtimeCatalogDigest
    || generation.revalidationAuthorization.pendingCatalogDigest === generation.sealedResult?.pendingCatalogDigest
    || generation.revalidationAuthorization.externalPendingDigest !== generation.sealedResult?.externalPendingDigest
    || generation.revalidationAuthorization.externalPendingDigest !== generation.externalPendingDigest
    || generation.revalidationAuthorization.selfExclusionDigest !== generation.selfExclusionDigest
  )) context.addIssue({ code: 'custom', path: ['generation', 'revalidationAuthorization'], message: 'Revalidation authorization must bind the sealed result and Catalog epoch' })
  const selfExclusion = value.recall.selfExclusion
  if (generation.staleRefreshUsed !== (selfExclusion !== undefined)) {
    context.addIssue({ code: 'custom', path: ['generation', 'staleRefreshUsed'], message: 'Stale refresh marker must match its durable self-exclusion proof' })
  }
  const resultReplacedBarrier = hasAuthoritativeSealedResult
  const hasTerminalCleanupReceipt = value.reasonReceipts.some(receipt => (
    receipt.revision === value.revision
    && ['CONFIRM_DISCARD', 'DISMISS_GENERATION'].includes(receipt.reasonCode)
  ))
  const coveredClosedBarrier = value.status === 'COVERED'
    || (value.status === 'DISCARDED' && hasTerminalCleanupReceipt)
  if (value.status === 'DISCARDED' && !hasTerminalCleanupReceipt) {
    context.addIssue({ code: 'custom', path: ['reasonReceipts'], message: 'Discard requires a current durable cleanup receipt' })
  }
  if (selfExclusion !== undefined && !resultReplacedBarrier && !coveredClosedBarrier && value.duplicateBarrier === undefined) {
    context.addIssue({ code: 'custom', path: ['duplicateBarrier'], message: 'Stale refresh must keep its duplicate barrier until a terminal replacement' })
  }
  if (selfExclusion !== undefined && generation.state !== 'NOT_STARTED' && generation.selfExclusionDigest !== selfExclusion.selfExclusionDigest) {
    context.addIssue({ code: 'custom', path: ['generation', 'selfExclusionDigest'], message: 'Refreshed generation must bind the exact self-exclusion proof' })
  }
  if (selfExclusion === undefined && generation.selfExclusionDigest !== undefined) {
    context.addIssue({ code: 'custom', path: ['generation', 'selfExclusionDigest'], message: 'Generation cannot claim self-exclusion without recall proof' })
  }
  if ((resultReplacedBarrier || coveredClosedBarrier) && value.duplicateBarrier !== undefined) {
    context.addIssue({ code: 'custom', path: ['duplicateBarrier'], message: 'Terminal replacement must atomically clear the prior duplicate barrier' })
  }
  if (value.duplicateBarrier !== undefined) {
    const barrier = value.duplicateBarrier
    if (
      (barrier.kind === 'STALE_RESULT' && barrier.priorGenerationRevision !== barrier.generationRevision)
      || (barrier.kind !== 'STALE_RESULT' && barrier.priorGenerationRevision !== undefined)
      || barrier.outcomeCatalogEpoch !== barrier.inputCatalogEpoch + 1
    ) context.addIssue({ code: 'custom', path: ['duplicateBarrier', 'priorGenerationRevision'], message: 'Barrier prior revision is valid only for the exact stale generation' })
    const boundToAttention = generation.state === 'NEEDS_ATTENTION' && (
      barrier.leaseId === generation.leaseId
      && barrier.generationRevision === generation.generationRevision
      && barrier.inputCatalogEpoch === generation.catalogEpoch
      && barrier.inputDigest === generation.inputDigest
      && barrier.callId === currentGenerationCalls[0]?.callId
      && barrier.mutationReceiptDigest === receiptFor('BARRIER_COMMITTED')?.digest
      && ({
        GENERATION_KNOWN_FAILED: 'KNOWN_FAILED',
        GENERATION_RESULT_LOST: 'RESULT_LOST',
        GENERATION_OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN',
        STALE_RESULT: 'STALE_RESULT',
      } as const)[generation.reasonCode ?? 'STALE_RESULT'] === barrier.kind
    )
    const boundToRefresh = selfExclusion !== undefined && (
      barrier.kind === 'STALE_RESULT'
      && barrier.generationRevision === selfExclusion.priorGenerationRevision
      && barrier.priorGenerationRevision === selfExclusion.priorGenerationRevision
      && barrier.mutationReceiptDigest === selfExclusion.barrierReceiptDigest
      && (value.recall.state !== 'COMPLETE' || value.recall.catalogEpoch === barrier.outcomeCatalogEpoch)
    )
    if (
      barrier.intentId !== value.intentId
      || barrier.behaviorSignature !== value.behaviorSignature
      || (!boundToAttention && !boundToRefresh)
    ) context.addIssue({ code: 'custom', path: ['duplicateBarrier'], message: 'Duplicate barrier is outside its exact failed generation or stale refresh' })
  }
  if (generation.state === 'NEEDS_ATTENTION' && (
    generation.reasonCode === undefined
    || (generation.reasonCode === 'STALE_RESULT') !== (generation.sealedResult !== undefined)
    || (generation.reasonCode === 'STALE_RESULT') === (value.duplicateBarrier !== undefined)
  )) context.addIssue({ code: 'custom', path: ['generation'], message: 'Generation attention requires exactly one sealed result or unresolved barrier outcome' })
  if (value.status === 'PROPOSAL_READY' && (
    value.generation.state !== 'PROPOSAL_READY'
    || value.generation.sealedResult === undefined
    || value.generation.proposalId === undefined
    || value.lineageId === undefined
  )) context.addIssue({ code: 'custom', path: ['generation'], message: 'Proposal-ready Intent requires sealed result, Proposal, and Lineage facts' })
  if (value.stageCalls.some(call => call.outcome === 'SUCCEEDED' && call.outputDigest === undefined)) {
    context.addIssue({ code: 'custom', path: ['stageCalls'], message: 'Successful stage call requires an output digest' })
  }
  if (value.stageCalls.some(call => call.intentRevision > value.revision)) {
    context.addIssue({ code: 'custom', path: ['stageCalls'], message: 'Stage call cannot belong to a future Intent revision' })
  }
  const callsFor = (stage: 'CATALOG_SCAN' | 'COVERAGE' | 'GENERATION') => value.stageCalls.filter(call => call.stage === stage)
  if (value.recall.state === 'COMPLETE' && callsFor('CATALOG_SCAN').length === 0) {
    context.addIssue({ code: 'custom', path: ['stageCalls'], message: 'Complete recall requires a durable Catalog scan ledger' })
  }
  if (['COVERED', 'CREATE', 'MERGE'].includes(value.coverage.state) && callsFor('COVERAGE').length === 0) {
    context.addIssue({ code: 'custom', path: ['stageCalls'], message: 'Terminal coverage requires a durable coverage call ledger' })
  }
  if (value.generation.state === 'PROPOSAL_READY') {
    if (
      currentGenerationCalls.length !== 1
      || currentGenerationCalls[0]?.outcome !== 'SUCCEEDED'
      || currentGenerationCalls[0]?.callId !== value.generation.sealedResult?.callId
    ) context.addIssue({ code: 'custom', path: ['stageCalls'], message: 'Proposal-ready generation requires one matching successful call' })
  }
})

export const LegacyDispositionV2Schema = z.enum([
  'AUDIT_ONLY_NO_SIGNAL',
  'LEGACY_NEEDS_ATTENTION',
  'LEGACY_CALL_OUTCOME_UNKNOWN',
  'ACTIVE_LEGACY_PROPOSAL',
  'ACTIVE_LEGACY_PUBLICATION',
  'AUDIT_ONLY_DISCARDED',
  'AUDIT_ONLY_PUBLISHED',
])

export type LegacyDispositionV2 = z.infer<typeof LegacyDispositionV2Schema>

export function deriveLegacyDispositionV2(
  item: z.infer<typeof CaptureWorkItemV1Schema>,
): LegacyDispositionV2 | undefined {
  switch (item.processingState) {
    case 'RESOLVED_NO_SIGNAL': return 'AUDIT_ONLY_NO_SIGNAL'
    case 'CAPTURED': return 'LEGACY_NEEDS_ATTENTION'
    case 'ANALYZING': return 'LEGACY_CALL_OUTCOME_UNKNOWN'
    case 'LEARNED':
    case 'READY_FOR_REVIEW': return 'ACTIVE_LEGACY_PROPOSAL'
    case 'PUBLISHING': return 'ACTIVE_LEGACY_PUBLICATION'
    case 'NEEDS_ATTENTION':
      return item.review === undefined ? 'LEGACY_NEEDS_ATTENTION' : 'ACTIVE_LEGACY_PROPOSAL'
    case 'TERMINAL':
      if (item.review?.publicationOutcome === 'DISCARDED') return 'AUDIT_ONLY_DISCARDED'
      if (item.review?.publicationOutcome === 'PUBLISHED') return 'AUDIT_ONLY_PUBLISHED'
      return undefined
    default: {
      const unreachable: never = item.processingState
      return unreachable
    }
  }
}

export function deriveLegacyItemIdV2(sourceWorkItemId: string): `legacy_${string}` {
  return `legacy_${sha256Utf8(canonicalJson({ sourceDomain: 'run2skill_v1', sourceWorkItemId }))}`
}

export const LegacyItemV2Schema = z.object({
  schemaVersion: z.literal(1),
  legacyItemId: z.string().regex(/^legacy_[a-f0-9]{64}$/),
  sourceWorkItemId: z.string().regex(/^wi_[a-f0-9]{64}$/),
  sourceDigest: sha256Hex,
  disposition: LegacyDispositionV2Schema,
  importedAt: isoDateTime,
  sourceWorkItem: CaptureWorkItemV1Schema,
}).strict().superRefine((value, context) => {
  if (value.legacyItemId !== deriveLegacyItemIdV2(value.sourceWorkItemId)) {
    context.addIssue({ code: 'custom', path: ['legacyItemId'], message: 'Legacy item id does not match source' })
  }
  if (value.sourceWorkItemId !== value.sourceWorkItem.workItemId) {
    context.addIssue({ code: 'custom', path: ['sourceWorkItemId'], message: 'Legacy source id does not match source item' })
  }
  if (value.sourceDigest !== sha256Utf8(canonicalJson(value.sourceWorkItem))) {
    context.addIssue({ code: 'custom', path: ['sourceDigest'], message: 'Legacy source digest does not match source item' })
  }
  if (value.disposition !== deriveLegacyDispositionV2(value.sourceWorkItem)) {
    context.addIssue({ code: 'custom', path: ['disposition'], message: 'Legacy disposition does not match source state' })
  }
})

const LegacyProposalLineageV2Schema = z.object({
  schemaVersion: z.literal(1),
  revision: positiveSafeInteger,
  lineageId: z.string().regex(/^lin_[a-f0-9]{64}$/),
  persistenceScope: PersistenceScopeV2Schema,
  origin: z.literal('LEGACY_V1'),
  state: z.literal('PUBLISHED'),
  sourceDigest: sha256Hex,
  importedAt: isoDateTime,
  updatedAt: isoDateTime,
  legacySnapshot: LineageV1Schema,
}).strict().superRefine((value, context) => {
  if (value.lineageId !== value.legacySnapshot.lineageId) {
    context.addIssue({ code: 'custom', path: ['lineageId'], message: 'Proposal lineage id does not match legacy snapshot' })
  }
  if (value.persistenceScope !== value.legacySnapshot.scope) {
    context.addIssue({ code: 'custom', path: ['persistenceScope'], message: 'Proposal lineage scope does not match legacy snapshot' })
  }
  if (value.sourceDigest !== sha256Utf8(canonicalJson(value.legacySnapshot))) {
    context.addIssue({ code: 'custom', path: ['sourceDigest'], message: 'Proposal lineage digest does not match legacy snapshot' })
  }
})

export function deriveNativeProposalLineageIdV2(
  persistenceScope: z.infer<typeof PersistenceScopeV2Schema>,
  behaviorSignature: string,
): `lin_${string}` {
  return `lin_${sha256Utf8(canonicalJson({ persistenceScope, behaviorSignature }))}`
}

const NativeProposalRevisionV2Schema = z.object({
  revision: positiveSafeInteger,
  proposalId: z.string().regex(/^prop_[a-f0-9]{64}$/),
  ownerIntentId: z.string().regex(/^intent_[a-f0-9]{64}$/),
  ownerIntentRevision: positiveSafeInteger,
  action: z.enum(['CREATE', 'MERGE']),
  body: SealedSkillBodyV2Schema,
  runtimeCatalogDigest: sha256Hex,
  pendingCatalogDigest: sha256Hex,
  generationResultReceiptDigest: sha256Hex,
  catalogMutationReceiptDigest: sha256Hex,
  catalogEpoch: safeNonNegativeInteger,
  targetIdentityDigest: sha256Hex.optional(),
  state: z.enum(['ACTIVE_PROPOSAL', 'PUBLISHED', 'TERMINAL']),
  reviewReceiptDigest: sha256Hex.optional(),
  publicationReceiptDigest: sha256Hex.optional(),
  createdAt: isoDateTime,
}).strict()

const NativeProposalLineageV2Schema = z.object({
  schemaVersion: z.literal(1),
  revision: positiveSafeInteger,
  lineageId: z.string().regex(/^lin_[a-f0-9]{64}$/),
  persistenceScope: PersistenceScopeV2Schema,
  origin: z.literal('RUN2SKILL_V2'),
  state: z.enum(['RESERVED', 'ACTIVE_PROPOSAL', 'PUBLISHED', 'TERMINAL']),
  behaviorSignature: sha256Hex,
  ownerIntentId: z.string().regex(/^intent_[a-f0-9]{64}$/),
  ownerIntentRevision: positiveSafeInteger,
  currentProposalRevision: safeNonNegativeInteger,
  proposalRevisions: z.array(NativeProposalRevisionV2Schema).max(64),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
}).strict().superRefine((value, context) => {
  if (value.lineageId !== deriveNativeProposalLineageIdV2(value.persistenceScope, value.behaviorSignature)) {
    context.addIssue({ code: 'custom', path: ['lineageId'], message: 'Native lineage id does not match behavior facts' })
  }
  if (value.currentProposalRevision !== value.proposalRevisions.length) {
    context.addIssue({ code: 'custom', path: ['currentProposalRevision'], message: 'Native lineage must retain complete consecutive Proposal revisions' })
  }
  value.proposalRevisions.forEach((revision, index) => {
    if (
      revision.revision !== index + 1
    ) context.addIssue({ code: 'custom', path: ['proposalRevisions', index], message: 'Native Proposal revision is outside Lineage ownership' })
  })
  if (value.state === 'RESERVED' && value.proposalRevisions.length !== 0) {
    context.addIssue({ code: 'custom', path: ['proposalRevisions'], message: 'Reserved lineage cannot contain a Proposal body' })
  }
  if (value.state !== 'RESERVED' && (
    value.proposalRevisions.length === 0 || value.proposalRevisions.at(-1)?.state !== value.state
  )) {
    context.addIssue({ code: 'custom', path: ['proposalRevisions'], message: 'Active native lineage requires a matching immutable Proposal revision' })
  }
  const latestRevision = value.proposalRevisions.at(-1)
  if (
    latestRevision !== undefined
    && (latestRevision.ownerIntentId !== value.ownerIntentId || latestRevision.ownerIntentRevision !== value.ownerIntentRevision)
  ) context.addIssue({ code: 'custom', path: ['ownerIntentId'], message: 'Native Lineage owner must match its latest Proposal revision' })
  if (value.state === 'PUBLISHED' && latestRevision?.publicationReceiptDigest === undefined) {
    context.addIssue({ code: 'custom', path: ['proposalRevisions'], message: 'Published native Proposal requires a publication receipt' })
  }
  if (value.state === 'PUBLISHED' && latestRevision?.reviewReceiptDigest === undefined) {
    context.addIssue({ code: 'custom', path: ['proposalRevisions'], message: 'Published native Proposal requires an approval receipt' })
  }
})

export const ProposalLineageV2Schema = z.union([
  LegacyProposalLineageV2Schema,
  NativeProposalLineageV2Schema,
])

const MigrationSourceContractV2Schema = z.object({
  domainName: z.literal('run2skill_v1'),
  domainVersion: z.literal(2),
  globalSchemaVersion: z.literal(1),
}).strict()

const MigrationCountsV2Schema = z.object({
  workItems: safeNonNegativeInteger,
  lineages: safeNonNegativeInteger,
  activeLegacyProposals: safeNonNegativeInteger,
}).strict()

const MigrationBaseV2Schema = z.object({
  schemaVersion: z.literal(1),
  source: MigrationSourceContractV2Schema,
})

const MigrationRunningFactsV2Schema = {
  sourceFingerprint: sha256Hex,
  counts: MigrationCountsV2Schema,
  startedAt: isoDateTime,
  updatedAt: isoDateTime,
} as const

export const MigrationJournalV2Schema = z.discriminatedUnion('phase', [
  MigrationBaseV2Schema.extend({ phase: z.literal('NOT_STARTED') }).strict(),
  MigrationBaseV2Schema.extend({ phase: z.literal('COPYING'), ...MigrationRunningFactsV2Schema }).strict(),
  MigrationBaseV2Schema.extend({ phase: z.literal('VALIDATING'), ...MigrationRunningFactsV2Schema }).strict(),
  MigrationBaseV2Schema.extend({
    phase: z.literal('COMMITTED'),
    ...MigrationRunningFactsV2Schema,
    committedAt: isoDateTime,
    activationFenceDigest: sha256Hex,
  }).strict(),
  MigrationBaseV2Schema.extend({
    phase: z.literal('FAILED'),
    ...MigrationRunningFactsV2Schema,
    failureCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  }).strict(),
])

const SessionCursorV2Schema = z.object({
  observedThroughTurnEndSeq: safeNonNegativeInteger,
  detectedThroughTurnEndSeq: safeNonNegativeInteger,
  activeBatchId: z.string().regex(/^batch_[a-f0-9]{64}$/).optional(),
  lastActivityAt: isoDateTime.optional(),
  batchManifestBaseline: BatchManifestBaselineV2Schema.optional(),
  openExperienceCarry: z.array(z.object({
    summary: z.string().min(1).max(2048),
    behaviorSignatureDraft: sha256Hex,
    evidenceDigests: z.array(sha256Hex).min(1).max(RUN2SKILL_V2_LIMITS.maxBatchObservations),
    remainingBatches: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  }).strict()).max(RUN2SKILL_V2_LIMITS.maxIntentsPerBatch),
  updatedAt: isoDateTime,
}).strict().superRefine((value, context) => {
  if (value.detectedThroughTurnEndSeq > value.observedThroughTurnEndSeq) {
    context.addIssue({ code: 'custom', path: ['detectedThroughTurnEndSeq'], message: 'Detected cursor cannot exceed observed cursor' })
  }
})

const ObserverStartWatermarkV2Schema = z.object({
  nextSeq: safeNonNegativeInteger,
  observedTailSeq: safeNonNegativeInteger,
  headerRevision: identity.optional(),
  headerDigest: sha256Hex.optional(),
}).strict().superRefine((value, context) => {
  if (value.nextSeq !== value.observedTailSeq + 1) {
    context.addIssue({ code: 'custom', path: ['nextSeq'], message: 'Observer start must follow the quiescent v1 tail' })
  }
})

const BehaviorSignatureIndexEntryV2Schema = z.object({
  schemaVersion: z.literal(1),
  persistenceScope: PersistenceScopeV2Schema,
  behaviorSignature: sha256Hex,
  ownerIntentId: z.string().regex(/^intent_[a-f0-9]{64}$/),
  ownerRevision: positiveSafeInteger,
  state: z.enum(['RESERVED', 'ACTIVE']),
  updatedAt: isoDateTime,
}).strict()

export function deriveBehaviorSignatureIndexKeyV2(
  persistenceScope: z.infer<typeof PersistenceScopeV2Schema>,
  behaviorSignature: string,
): string {
  return sha256Utf8(canonicalJson({ persistenceScope, behaviorSignature }))
}

const ProposalGenerationLeaseV2Schema = z.object({
  schemaVersion: z.literal(1),
  leaseId: z.string().regex(/^lease_[a-f0-9]{64}$/),
  ownerIntentId: z.string().regex(/^intent_[a-f0-9]{64}$/),
  ownerRevision: positiveSafeInteger,
  generationRevision: positiveSafeInteger,
  action: z.enum(['CREATE', 'MERGE']),
  inputDigest: sha256Hex,
  externalPendingDigest: sha256Hex,
  catalogEpoch: safeNonNegativeInteger,
  acquiredAt: isoDateTime,
  callId: z.string().regex(/^call_[a-f0-9]{64}$/).optional(),
  callOutcomeReceiptDigest: sha256Hex.optional(),
  sealedResultReceiptDigest: sha256Hex.optional(),
  barrierReceiptDigest: sha256Hex.optional(),
  proposalAuthorizationReceiptDigest: sha256Hex.optional(),
  completionReceiptDigest: sha256Hex.optional(),
  state: z.enum([
    'NOT_CALLED',
    'KNOWN_FAILED',
    'SUCCEEDED_RESULT_MISSING',
    'RESULT_COMMITTED',
    'PROPOSAL_COMMIT_AUTHORIZED',
    'OUTCOME_UNKNOWN',
    'BODY_COMMITTED_INDEX_PENDING',
    'ACTIVE_COMPLETE',
  ]),
}).strict().superRefine((value, context) => {
  const present = (field: 'callId' | 'callOutcomeReceiptDigest' | 'sealedResultReceiptDigest' | 'barrierReceiptDigest' | 'proposalAuthorizationReceiptDigest' | 'completionReceiptDigest') => value[field] !== undefined
  const rejectPresent = (fields: readonly Parameters<typeof present>[0][]) => {
    for (const field of fields) if (present(field)) {
      context.addIssue({ code: 'custom', path: [field], message: 'Lease state contains a future or conflicting receipt' })
    }
  }
  if (value.state === 'NOT_CALLED') rejectPresent([
    'callId', 'callOutcomeReceiptDigest', 'sealedResultReceiptDigest', 'barrierReceiptDigest',
    'proposalAuthorizationReceiptDigest', 'completionReceiptDigest',
  ])
  if (value.generationRevision > value.ownerRevision) {
    context.addIssue({ code: 'custom', path: ['generationRevision'], message: 'Lease generation revision cannot exceed its owner Intent revision' })
  }
  if (value.state !== 'NOT_CALLED' && (value.callId === undefined || value.callOutcomeReceiptDigest === undefined)) {
    context.addIssue({ code: 'custom', path: ['callId'], message: 'Called lease requires durable call identity and outcome receipt' })
  }
  if (
    ['KNOWN_FAILED', 'SUCCEEDED_RESULT_MISSING', 'OUTCOME_UNKNOWN'].includes(value.state)
    && value.barrierReceiptDigest === undefined
  ) context.addIssue({ code: 'custom', path: ['barrierReceiptDigest'], message: 'Unresolved generation lease requires a duplicate barrier receipt' })
  if (['KNOWN_FAILED', 'SUCCEEDED_RESULT_MISSING', 'OUTCOME_UNKNOWN'].includes(value.state)) {
    rejectPresent(['sealedResultReceiptDigest', 'proposalAuthorizationReceiptDigest', 'completionReceiptDigest'])
  }
  if (
    ['RESULT_COMMITTED', 'PROPOSAL_COMMIT_AUTHORIZED', 'BODY_COMMITTED_INDEX_PENDING', 'ACTIVE_COMPLETE'].includes(value.state)
    && value.sealedResultReceiptDigest === undefined
  ) context.addIssue({ code: 'custom', path: ['sealedResultReceiptDigest'], message: 'Result-bearing lease requires a sealed result receipt' })
  if (
    ['PROPOSAL_COMMIT_AUTHORIZED', 'BODY_COMMITTED_INDEX_PENDING', 'ACTIVE_COMPLETE'].includes(value.state)
    && value.proposalAuthorizationReceiptDigest === undefined
  ) context.addIssue({ code: 'custom', path: ['proposalAuthorizationReceiptDigest'], message: 'Proposal commit requires an authorization receipt' })
  if (value.state === 'ACTIVE_COMPLETE' && value.completionReceiptDigest === undefined) {
    context.addIssue({ code: 'custom', path: ['completionReceiptDigest'], message: 'Completed lease requires an index completion receipt' })
  }
  if (value.state === 'RESULT_COMMITTED') rejectPresent([
    'barrierReceiptDigest', 'proposalAuthorizationReceiptDigest', 'completionReceiptDigest',
  ])
  if (value.state === 'PROPOSAL_COMMIT_AUTHORIZED' || value.state === 'BODY_COMMITTED_INDEX_PENDING') {
    rejectPresent(['barrierReceiptDigest', 'completionReceiptDigest'])
  }
  if (value.state === 'ACTIVE_COMPLETE') rejectPresent(['barrierReceiptDigest'])
})

const ProposalCatalogMutationJournalV2Schema = z.object({
  schemaVersion: z.literal(1),
  mutationId: z.string().regex(/^pcm_[a-f0-9]{64}$/),
  ownerId: identity,
  kind: z.enum(['PROPOSAL', 'GENERATION_RESULT', 'BARRIER', 'LEGACY', 'PUBLICATION', 'PURGE']),
  phase: z.literal('PREPARED'),
  preparedAt: isoDateTime,
}).strict()

const PurgeScopeBindingV2Schema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('USER'), scopeIdentityDigest: sha256Hex }).strict(),
  z.object({
    scope: z.literal('PROJECT'),
    workspaceId: identity,
    scopeIdentityDigest: sha256Hex,
  }).strict(),
])

const PurgeJournalV2Schema = z.object({
  schemaVersion: z.literal(1),
  purgeId: z.string().regex(/^purge_[a-f0-9]{64}$/),
  scopeBinding: PurgeScopeBindingV2Schema,
  hideBefore: isoDateTime,
  phase: z.enum(['PREPARED', 'QUIESCED', 'DELETING', 'VALIDATING']),
  updatedAt: isoDateTime,
}).strict()

export const GlobalV2Schema = z.object({
  schemaVersion: z.literal(1),
  migration: MigrationJournalV2Schema,
  sessions: z.record(z.string().regex(/^sl_[a-f0-9]{64}$/), SessionCursorV2Schema),
  behaviorSignatureIndex: z.record(sha256Hex, BehaviorSignatureIndexEntryV2Schema),
  proposalGenerationLease: ProposalGenerationLeaseV2Schema.optional(),
  proposalCatalogEpoch: safeNonNegativeInteger,
  proposalCatalogMutationJournal: ProposalCatalogMutationJournalV2Schema.optional(),
  purgeJournal: PurgeJournalV2Schema.optional(),
  legacyCompletedPurgeFences: CompletedPurgeFencesV1Schema.optional(),
  activation: z.object({
    committedAt: isoDateTime,
    sourceFingerprint: sha256Hex,
    observerStartWatermarks: z.record(z.string().regex(/^sl_[a-f0-9]{64}$/), ObserverStartWatermarkV2Schema),
    observerStartWatermarkDigest: sha256Hex,
    legacyPendingCatalogDigest: sha256Hex,
    legacyPendingCandidateCount: safeNonNegativeInteger,
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if ((value.migration.phase === 'COMMITTED') !== (value.activation !== undefined)) {
    context.addIssue({ code: 'custom', path: ['activation'], message: 'Activation must exist exactly when migration is committed' })
  }
  if (
    value.migration.phase === 'COMMITTED'
    && value.activation?.sourceFingerprint !== value.migration.sourceFingerprint
  ) {
    context.addIssue({ code: 'custom', path: ['activation', 'sourceFingerprint'], message: 'Activation must bind migration source' })
  }
  if (value.activation !== undefined) {
    if (value.activation.observerStartWatermarkDigest !== sha256Utf8(canonicalJson(value.activation.observerStartWatermarks))) {
      context.addIssue({ code: 'custom', path: ['activation', 'observerStartWatermarkDigest'], message: 'Observer watermark digest does not match watermarks' })
    }
    for (const [lifecycleKey, watermark] of Object.entries(value.activation.observerStartWatermarks)) {
      const cursor = value.sessions[lifecycleKey]
      if (
        cursor === undefined
        || cursor.observedThroughTurnEndSeq !== watermark.observedTailSeq
        || cursor.detectedThroughTurnEndSeq !== watermark.observedTailSeq
      ) context.addIssue({ code: 'custom', path: ['sessions', lifecycleKey], message: 'Session cursor must bind activation watermark' })
    }
  }
  for (const [key, entry] of Object.entries(value.behaviorSignatureIndex)) {
    if (key !== deriveBehaviorSignatureIndexKeyV2(entry.persistenceScope, entry.behaviorSignature)) {
      context.addIssue({ code: 'custom', path: ['behaviorSignatureIndex', key], message: 'Behavior index key does not match entry facts' })
    }
  }
})

export type TurnObservationV2 = z.infer<typeof TurnObservationV2Schema>
export type SessionBatchV2 = z.infer<typeof SessionBatchV2Schema>
export type ExperienceIntentV2 = z.infer<typeof ExperienceIntentV2Schema>
export type LegacyItemV2 = z.infer<typeof LegacyItemV2Schema>
export type ProposalLineageV2 = z.infer<typeof ProposalLineageV2Schema>
export type MigrationJournalV2 = z.infer<typeof MigrationJournalV2Schema>
export type GlobalV2 = z.infer<typeof GlobalV2Schema>
