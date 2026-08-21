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
  callId: z.string().regex(/^call_[a-f0-9]{64}$/),
  action: z.enum(['CREATE', 'MERGE']),
  body: SealedSkillBodyV2Schema,
  targetDigest: sha256Hex,
  runtimeCatalogDigest: sha256Hex,
  pendingCatalogDigest: sha256Hex,
  sealedAt: isoDateTime,
  receiptDigest: sha256Hex,
}).strict()

const GenerationBarrierV2Schema = z.object({
  barrierId: z.string().regex(/^barrier_[a-f0-9]{64}$/),
  kind: z.enum(['KNOWN_FAILED', 'RESULT_LOST', 'OUTCOME_UNKNOWN', 'STALE_RESULT']),
  behaviorSignature: sha256Hex,
  inputDigest: sha256Hex,
  callId: z.string().regex(/^call_[a-f0-9]{64}$/).optional(),
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
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
  }).strict(),
  recall: z.object({
    state: z.enum(['NOT_STARTED', 'SCANNING', 'COMPLETE', 'INCOMPLETE']),
    runtimeCatalogDigest: sha256Hex.optional(),
    pendingCatalogDigest: sha256Hex.optional(),
    complete: z.boolean(),
    candidateCapabilities: z.array(z.object({
      candidateKey: identity,
      classification: z.enum(['COVERING', 'MERGEABLE', 'UNRELATED', 'UNAVAILABLE']),
      capability: z.enum(['SUMMARY', 'FULL_BODY', 'UNAVAILABLE']),
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
    sealedResult: SealedGenerationResultV2Schema.optional(),
    barrier: GenerationBarrierV2Schema.optional(),
    proposalId: z.string().regex(/^prop_[a-f0-9]{64}$/).optional(),
    reasonCode: z.enum(['GENERATION_KNOWN_FAILED', 'GENERATION_RESULT_LOST', 'GENERATION_OUTCOME_UNKNOWN', 'STALE_RESULT']).optional(),
    userRetryUsed: z.boolean(),
    staleRefreshUsed: z.boolean(),
    receipts: z.array(z.object({
      kind: z.enum(['LEASE_ACQUIRED', 'CALL_RESERVED', 'CALL_TERMINAL', 'RESULT_SEALED', 'BARRIER_COMMITTED', 'PROPOSAL_AUTHORIZED', 'BODY_COMMITTED', 'INDEX_COMMITTED']),
      digest: sha256Hex,
      recordedAt: isoDateTime,
    }).strict()).max(32),
  }).strict(),
  stageCalls: z.array(z.object({
    stage: z.enum(['CATALOG_SCAN', 'COVERAGE', 'GENERATION']),
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
  const ownershipByStatus: Partial<Record<typeof value.status, typeof value.ownership.state>> = {
    READY: 'NOT_STARTED',
    OWNERSHIP_ARBITRATING: 'ARBITRATING',
    RESOLVED_BY_AGENT: 'RESOLVED_BY_AGENT',
    NEEDS_CONFIRMATION: 'NEEDS_CONFIRMATION',
    RUN2SKILL_OWNED: 'RUN2SKILL_OWNED',
  }
  const expectedOwnership = ownershipByStatus[value.status]
  if (expectedOwnership !== undefined && value.ownership.state !== expectedOwnership) {
    context.addIssue({ code: 'custom', path: ['ownership', 'state'], message: 'Ownership state does not match Intent status' })
  }
  if (value.status === 'PROPOSAL_READY' && (
    value.generation.state !== 'PROPOSAL_READY'
    || value.generation.sealedResult === undefined
    || value.generation.proposalId === undefined
    || value.lineageId === undefined
  )) context.addIssue({ code: 'custom', path: ['generation'], message: 'Proposal-ready Intent requires sealed result, Proposal, and Lineage facts' })
  if (value.generation.state === 'RESULT_COMMITTED' && value.generation.sealedResult === undefined) {
    context.addIssue({ code: 'custom', path: ['generation', 'sealedResult'], message: 'Committed generation result requires immutable body facts' })
  }
  if (value.generation.state === 'NEEDS_ATTENTION' && value.generation.barrier === undefined) {
    context.addIssue({ code: 'custom', path: ['generation', 'barrier'], message: 'Generation attention requires a durable duplicate barrier' })
  }
  if (
    value.generation.sealedResult !== undefined
    && value.generation.resultDigest !== value.generation.sealedResult.receiptDigest
  ) context.addIssue({ code: 'custom', path: ['generation', 'resultDigest'], message: 'Generation result digest must bind the sealed result receipt' })
  if (
    value.generation.barrier !== undefined
    && value.generation.barrier.behaviorSignature !== value.behaviorSignature
  ) context.addIssue({ code: 'custom', path: ['generation', 'barrier'], message: 'Generation barrier must bind the Intent behavior signature' })
  if (value.stageCalls.some(call => call.outcome === 'SUCCEEDED' && call.outputDigest === undefined)) {
    context.addIssue({ code: 'custom', path: ['stageCalls'], message: 'Successful stage call requires an output digest' })
  }
  const callsFor = (stage: 'CATALOG_SCAN' | 'COVERAGE' | 'GENERATION') => value.stageCalls.filter(call => call.stage === stage)
  if (value.recall.state === 'COMPLETE' && callsFor('CATALOG_SCAN').length === 0) {
    context.addIssue({ code: 'custom', path: ['stageCalls'], message: 'Complete recall requires a durable Catalog scan ledger' })
  }
  if (['COVERED', 'CREATE', 'MERGE'].includes(value.coverage.state) && callsFor('COVERAGE').length === 0) {
    context.addIssue({ code: 'custom', path: ['stageCalls'], message: 'Terminal coverage requires a durable coverage call ledger' })
  }
  if (value.generation.state === 'PROPOSAL_READY') {
    const generationCalls = callsFor('GENERATION')
    if (
      generationCalls.length !== 1
      || generationCalls[0]?.outcome !== 'SUCCEEDED'
      || generationCalls[0]?.callId !== value.generation.sealedResult?.callId
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
  action: z.enum(['CREATE', 'MERGE']),
  inputDigest: sha256Hex,
  externalPendingDigest: sha256Hex,
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
  if (value.state === 'NOT_CALLED' && value.callId !== undefined) {
    context.addIssue({ code: 'custom', path: ['callId'], message: 'Uncalled lease cannot retain a call identity' })
  }
  if (value.state !== 'NOT_CALLED' && (value.callId === undefined || value.callOutcomeReceiptDigest === undefined)) {
    context.addIssue({ code: 'custom', path: ['callId'], message: 'Called lease requires durable call identity and outcome receipt' })
  }
  if (
    ['KNOWN_FAILED', 'SUCCEEDED_RESULT_MISSING', 'OUTCOME_UNKNOWN'].includes(value.state)
    && value.barrierReceiptDigest === undefined
  ) context.addIssue({ code: 'custom', path: ['barrierReceiptDigest'], message: 'Unresolved generation lease requires a duplicate barrier receipt' })
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
