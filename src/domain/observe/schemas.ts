import { z } from 'zod'
import { OBSERVE_LIMITS, TRIGGER_POLICY_VERSION } from './constants.js'
import { sha256Utf8 } from './hashing.js'
import {
  deriveSessionLifecycleKeyFromFacts,
  deriveWorkItemIdFromFacts,
} from './identity.js'

const safeNonNegativeInteger = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  'Expected a non-negative safe integer',
)
const positiveSafeInteger = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 1,
  'Expected a positive safe integer',
)
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/)
const isoDateTime = z.string().datetime({ offset: true })
const healthCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)

export const TriggerPolicyVersionSchema = z.literal(TRIGGER_POLICY_VERSION)

export const SignalKeySchema = z.object({
  rootSessionId: z.string().min(1),
  sessionCreatedAt: safeNonNegativeInteger,
  sessionCwdDigest: sha256Hex,
  turn: safeNonNegativeInteger,
  turnEndSeq: safeNonNegativeInteger,
  turnInstanceDigest: sha256Hex,
  triggerPolicyVersion: TriggerPolicyVersionSchema,
}).strict()

export const TriggerHitSchema = z.object({
  kind: z.enum(['EXPLICIT_SAVE', 'CORRECTION', 'CONSTRAINT', 'WORKFLOW']),
  messageSeq: safeNonNegativeInteger,
  ruleId: z.string().min(1).max(160),
  confidence: z.literal('HIGH'),
}).strict()

export const RedactionKindSchema = z.enum([
  'PRIVATE_KEY',
  'AUTHORIZATION',
  'BEARER_TOKEN',
  'API_KEY',
  'SECRET_ASSIGNMENT',
  'URL_CREDENTIAL',
])

export const EvidenceRefSchema = z.object({
  source: z.literal('USER_DIRECT'),
  messageSeq: safeNonNegativeInteger,
  excerpt: z.string(),
  excerptDigest: sha256Hex,
  redactionKinds: z.array(RedactionKindSchema),
  truncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(value.excerpt, 'utf8') > OBSERVE_LIMITS.maxEvidenceBytes) {
    context.addIssue({
      code: 'custom',
      message: `Evidence excerpt exceeds ${OBSERVE_LIMITS.maxEvidenceBytes} bytes`,
    })
  }
  if (value.excerptDigest !== sha256Utf8(value.excerpt)) {
    context.addIssue({ code: 'custom', message: 'Evidence digest does not match excerpt' })
  }
})

const RootIdentitySchema = z.object({
  status: z.literal('ROOT'),
  parentSessionId: z.string().min(1).optional(),
}).strict()

const WorkspaceBindingSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('BOUND'),
    workspaceId: z.string().min(1),
    canonicalPath: z.string().min(1),
    observedAt: isoDateTime,
  }).strict(),
  z.object({
    status: z.enum(['NO_CWD', 'UNREGISTERED', 'UNAVAILABLE']),
    observedAt: isoDateTime,
  }).strict(),
])

export const CaptureBlockerSchema = z.enum([
  'TURN_BOUNDARY_INCOMPLETE',
  'TEXT_LIMIT_EXCEEDED',
  'REDACTION_UNAVAILABLE',
])

export const CaptureWorkItemV1Schema = z.object({
  schemaVersion: z.literal(1),
  revision: positiveSafeInteger,
  workItemId: z.string().regex(/^wi_[a-f0-9]{64}$/),
  signalKey: SignalKeySchema,
  captureReason: z.enum(['CHEAP_TRIGGER', 'SCAN_INCOMPLETE']),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  turnOutcomeKind: z.string().min(1).max(120),
  rootIdentity: RootIdentitySchema,
  workspaceBinding: WorkspaceBindingSchema,
  scanStatus: z.enum(['COMPLETE', 'INCOMPLETE']),
  triggerHits: z.array(TriggerHitSchema),
  evidenceRefs: z.array(EvidenceRefSchema).max(OBSERVE_LIMITS.maxEvidenceRefs),
  captureBlockers: z.array(CaptureBlockerSchema),
  processingState: z.enum(['CAPTURED', 'RESOLVED_NO_SIGNAL']),
}).strict().superRefine((value, context) => {
  if (value.workItemId !== deriveWorkItemIdFromFacts(value.signalKey)) {
    context.addIssue({ code: 'custom', message: 'WorkItem ID does not match SignalKey' })
  }
  const evidenceBytes = value.evidenceRefs.reduce(
    (total, evidence) => total + Buffer.byteLength(evidence.excerpt, 'utf8'),
    0,
  )
  if (evidenceBytes > OBSERVE_LIMITS.maxEvidenceTotalBytes) {
    context.addIssue({ code: 'custom', message: 'WorkItem evidence exceeds 2 KiB' })
  }

  if (value.scanStatus === 'COMPLETE' && value.captureBlockers.length > 0) {
    context.addIssue({ code: 'custom', message: 'Complete scans cannot retain capture blockers' })
  }
  if (value.scanStatus === 'INCOMPLETE' && value.captureBlockers.length === 0) {
    context.addIssue({ code: 'custom', message: 'Incomplete scans require a capture blocker' })
  }
  if (value.scanStatus === 'INCOMPLETE' && (value.triggerHits.length > 0 || value.evidenceRefs.length > 0)) {
    context.addIssue({ code: 'custom', message: 'Incomplete scans must remain metadata-only' })
  }
  if (value.captureReason === 'SCAN_INCOMPLETE' && value.scanStatus === 'COMPLETE' && value.processingState !== 'RESOLVED_NO_SIGNAL') {
    context.addIssue({ code: 'custom', message: 'A completed formerly blocked scan must close as no-signal' })
  }
  if (value.captureReason === 'CHEAP_TRIGGER') {
    if (value.scanStatus !== 'COMPLETE' || value.triggerHits.length === 0 || value.processingState !== 'CAPTURED') {
      context.addIssue({ code: 'custom', message: 'Cheap trigger captures require a complete triggered scan' })
    }
  }
  if (value.processingState === 'RESOLVED_NO_SIGNAL') {
    if (
      value.captureReason !== 'SCAN_INCOMPLETE'
      || value.scanStatus !== 'COMPLETE'
      || value.triggerHits.length > 0
      || value.evidenceRefs.length > 0
      || value.captureBlockers.length > 0
    ) {
      context.addIssue({ code: 'custom', message: 'Resolved no-signal items must be complete and empty' })
    }
  }
  const triggerKeys = value.triggerHits.map((hit) => `${hit.messageSeq}\u0000${hit.kind}\u0000${hit.ruleId}`)
  if (new Set(triggerKeys).size !== triggerKeys.length) {
    context.addIssue({ code: 'custom', message: 'Trigger hits must be unique' })
  }
  const evidenceKeys = value.evidenceRefs.map((evidence) => `${evidence.messageSeq}\u0000${evidence.excerptDigest}`)
  if (new Set(evidenceKeys).size !== evidenceKeys.length) {
    context.addIssue({ code: 'custom', message: 'Evidence references must be unique' })
  }
  if (new Set(value.captureBlockers).size !== value.captureBlockers.length) {
    context.addIssue({ code: 'custom', message: 'Capture blockers must be unique' })
  }
})

const SessionCheckpointV1Schema = z.object({
  rootSessionId: z.string().min(1),
  sessionCreatedAt: safeNonNegativeInteger,
  sessionCwdDigest: sha256Hex,
  triggerPolicyVersion: TriggerPolicyVersionSchema,
  activationFenceSeq: safeNonNegativeInteger,
  durableNextSeq: safeNonNegativeInteger,
  observedTailSeq: safeNonNegativeInteger,
  lastScannedAt: isoDateTime.optional(),
  headerRevision: z.string().min(1).optional(),
  headerDigest: sha256Hex.optional(),
}).strict().superRefine((value, context) => {
  if (value.durableNextSeq < value.activationFenceSeq) {
    context.addIssue({ code: 'custom', message: 'Durable watermarks cannot precede the activation fence' })
  }
})

export const GlobalV1Schema = z.object({
  schemaVersion: z.literal(1),
  activeTriggerPolicyVersion: TriggerPolicyVersionSchema,
  sessions: z.record(z.string().regex(/^sl_[a-f0-9]{64}$/), SessionCheckpointV1Schema),
  health: z.object({
    counts: z.record(healthCode, safeNonNegativeInteger),
    lastCode: healthCode.optional(),
  }).strict(),
  recovery: z.object({
    recoveryLag: z.boolean(),
    cursor: z.object({
      lifecycleKey: z.string().regex(/^sl_[a-f0-9]{64}$/),
      nextSeq: safeNonNegativeInteger,
    }).strict().optional(),
  }).strict(),
  lastSuccessfulStoreWriteAt: isoDateTime.optional(),
  checkpoint: z.object({
    dirty: z.boolean(),
    pendingSessionCount: safeNonNegativeInteger,
    lastCheckpointAt: isoDateTime.optional(),
  }).strict(),
}).strict().superRefine((value, context) => {
  for (const [lifecycleKey, checkpoint] of Object.entries(value.sessions)) {
    if (lifecycleKey !== deriveSessionLifecycleKeyFromFacts(checkpoint)) {
      context.addIssue({
        code: 'custom',
        path: ['sessions', lifecycleKey],
        message: 'Session key does not match lifecycle facts',
      })
    }
  }
})

export type TriggerPolicyVersion = z.infer<typeof TriggerPolicyVersionSchema>
export type SignalKey = z.infer<typeof SignalKeySchema>
export type TriggerHit = z.infer<typeof TriggerHitSchema>
export type RedactionKind = z.infer<typeof RedactionKindSchema>
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>
export type CaptureBlocker = z.infer<typeof CaptureBlockerSchema>
export type CaptureWorkItemV1 = z.infer<typeof CaptureWorkItemV1Schema>
export type GlobalV1 = z.infer<typeof GlobalV1Schema>
