import { z } from 'zod'
import { canonicalJson } from '../learn/identity.js'
import { EvidenceRefSchema, CaptureWorkItemV1Schema } from '../observe/schemas.js'
import { sha256Utf8 } from '../observe/hashing.js'
import { CompletedPurgeFencesV1Schema } from '../purge/schemas.js'
import { LineageV1Schema } from '../publication/schemas.js'

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/)
const isoDateTime = z.string().datetime({ offset: true })
const identity = z.string().min(1).max(256)
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
  completeness: z.enum(['COMPLETE', 'INCOMPLETE']),
  scopeBinding: ScopeBindingV2Schema,
  directUserEvidence: z.array(EvidenceRefSchema).max(RUN2SKILL_V2_LIMITS.maxObservationEvidence),
  evidenceDigest: sha256Hex,
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
  observationIds: z.array(z.string().regex(/^obs_[a-f0-9]{64}$/))
    .min(1)
    .max(RUN2SKILL_V2_LIMITS.maxBatchObservations),
  observationManifestDigest: sha256Hex,
  state: z.enum(['FROZEN', 'DETECTION_CLAIMED', 'NONE', 'DEFER', 'READY', 'NEEDS_ATTENTION']),
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
  if (new Set(value.observationIds).size !== value.observationIds.length) {
    context.addIssue({ code: 'custom', path: ['observationIds'], message: 'Batch observations must be unique' })
  }
  if (value.observationManifestDigest !== sha256Utf8(canonicalJson(value.observationIds))) {
    context.addIssue({ code: 'custom', path: ['observationManifestDigest'], message: 'Batch observation digest does not match ids' })
  }
})

export interface ExperienceIntentIdentityFactsV2 {
  readonly batchId: string
  readonly ordinal: number
  readonly detectorPolicyVersion: string
}

export function deriveExperienceIntentIdV2(facts: ExperienceIntentIdentityFactsV2): `intent_${string}` {
  return `intent_${sha256Utf8(canonicalJson({
    batchId: facts.batchId,
    ordinal: facts.ordinal,
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

export const ExperienceIntentV2Schema = z.object({
  schemaVersion: z.literal(1),
  revision: positiveSafeInteger,
  intentId: z.string().regex(/^intent_[a-f0-9]{64}$/),
  batchId: z.string().regex(/^batch_[a-f0-9]{64}$/),
  ordinal: positiveSafeInteger.refine(value => value <= RUN2SKILL_V2_LIMITS.maxIntentsPerBatch),
  detectorPolicyVersion: identity,
  persistenceScope: PersistenceScopeV2Schema,
  explicitSave: z.boolean(),
  behaviorSignature: sha256Hex,
  evidenceDigest: sha256Hex,
  status: ExperienceIntentStatusV2Schema,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
}).strict().superRefine((value, context) => {
  if (value.intentId !== deriveExperienceIntentIdV2(value)) {
    context.addIssue({ code: 'custom', path: ['intentId'], message: 'Intent id does not match facts' })
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

export const ProposalLineageV2Schema = z.object({
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
  detectedThrough: safeNonNegativeInteger,
  capturedThrough: safeNonNegativeInteger,
  updatedAt: isoDateTime,
}).strict().superRefine((value, context) => {
  if (value.detectedThrough > value.capturedThrough) {
    context.addIssue({ code: 'custom', path: ['detectedThrough'], message: 'Detected cursor cannot exceed captured cursor' })
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
}).strict()

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
    observerStartWatermarkDigest: sha256Hex,
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
