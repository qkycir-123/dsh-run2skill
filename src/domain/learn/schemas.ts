import { z } from 'zod'

const safeNonNegativeInteger = z.number().refine(
  value => Number.isSafeInteger(value) && value >= 0,
  'Expected a non-negative safe integer',
)
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/)
const isoDateTime = z.string().datetime({ offset: true })

function utf8Limited(maxBytes: number) {
  return z.string().min(1).refine(
    value => Buffer.byteLength(value, 'utf8') <= maxBytes,
    `Expected at most ${maxBytes} UTF-8 bytes`,
  )
}

export const LEARNING_POLICY_VERSION = 'learning-v1' as const

export const SupportingEvidenceV1Schema = z.object({
  messageSeq: safeNonNegativeInteger,
  excerptDigest: sha256Hex,
}).strict()

export const ExperienceRecordV1Schema = z.object({
  experienceId: z.string().regex(/^exp_[a-f0-9]{64}$/),
  type: z.enum(['CORRECTION', 'CONSTRAINT', 'WORKFLOW']),
  lesson: utf8Limited(4 * 1024),
  persistenceScope: z.enum(['PROJECT', 'USER']),
  evidenceStrength: z.literal('HIGH'),
  supportingEvidence: z.array(SupportingEvidenceV1Schema).min(1).max(4),
  contextSummary: utf8Limited(4 * 1024).optional(),
}).strict().superRefine((value, context) => {
  const keys = value.supportingEvidence.map(item => `${item.messageSeq}\u0000${item.excerptDigest}`)
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: 'custom', message: 'Supporting evidence must be unique' })
  }
})

const CurationV1Schema = z.object({
  decision: z.enum(['CREATE', 'MERGE', 'DISCARD']),
  candidateKey: z.string().regex(/^cand_[a-f0-9]{64}$/).optional(),
  rationale: utf8Limited(4 * 1024),
}).strict().superRefine((value, context) => {
  if (value.decision === 'CREATE' && value.candidateKey !== undefined) {
    context.addIssue({ code: 'custom', message: 'CREATE cannot identify a candidate' })
  }
  if (value.decision !== 'CREATE' && value.candidateKey === undefined) {
    context.addIssue({ code: 'custom', message: 'MERGE and DISCARD require a candidate' })
  }
})

/** Semantic fields accepted from the model; Host-owned identity and catalog facts are excluded. */
export const ModelLearningOutputV1Schema = z.object({
  experiences: z.array(z.object({
    type: z.enum(['CORRECTION', 'CONSTRAINT', 'WORKFLOW']),
    lesson: utf8Limited(4 * 1024),
    persistenceScope: z.enum(['PROJECT', 'USER']),
    evidenceStrength: z.literal('HIGH'),
    supportingEvidence: z.array(SupportingEvidenceV1Schema).min(1).max(4),
    contextSummary: utf8Limited(4 * 1024).optional(),
  }).strict().superRefine((value, context) => {
    const keys = value.supportingEvidence.map(item => `${item.messageSeq}\u0000${item.excerptDigest}`)
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: 'custom', message: 'Supporting evidence must be unique' })
    }
  })).min(1).max(3),
  proposal: z.object({
    policyVersion: z.literal(LEARNING_POLICY_VERSION),
    name: z.string().min(1).max(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: utf8Limited(2 * 1024),
    whenToUse: utf8Limited(4 * 1024),
    content: utf8Limited(32 * 1024),
    invocation: z.object({
      modelInvocable: z.literal(true),
      userInvocable: z.literal(false),
    }).strict(),
    persistenceScope: z.enum(['PROJECT', 'USER']),
    curation: CurationV1Schema,
  }).strict(),
}).strict()

export const LearningProposalV1Schema = z.object({
  learningProposalId: z.string().regex(/^lp_[a-f0-9]{64}$/),
  policyVersion: z.literal(LEARNING_POLICY_VERSION),
  name: z.string().min(1).max(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: utf8Limited(2 * 1024),
  whenToUse: utf8Limited(4 * 1024),
  content: utf8Limited(32 * 1024),
  invocation: z.object({
    modelInvocable: z.literal(true),
    userInvocable: z.literal(false),
  }).strict(),
  persistenceScope: z.enum(['PROJECT', 'USER']),
  supportingExperienceIds: z.array(z.string().regex(/^exp_[a-f0-9]{64}$/)).min(1).max(3),
  curation: CurationV1Schema,
  catalogObservationDigest: sha256Hex,
  shortlistDigests: z.array(sha256Hex).max(5),
}).strict().superRefine((value, context) => {
  if (new Set(value.supportingExperienceIds).size !== value.supportingExperienceIds.length) {
    context.addIssue({ code: 'custom', message: 'Supporting Experience ids must be unique' })
  }
  if (new Set(value.shortlistDigests).size !== value.shortlistDigests.length) {
    context.addIssue({ code: 'custom', message: 'Shortlist digests must be unique' })
  }
})

export const LearningFailureCodeSchema = z.enum([
  'SESSION_LOG_UNAVAILABLE',
  'AGENT_SCOPE_UNAVAILABLE',
  'MODEL_ROUTE_UNAVAILABLE',
  'MODEL_INFO_UNAVAILABLE',
  'CATALOG_INCOMPLETE',
  'CANDIDATE_UNAVAILABLE',
  'ENVELOPE_UNBUILDABLE',
  'MODEL_TIMEOUT',
  'MODEL_ABORTED',
  'MODEL_TERMINAL_FAILURE',
  'MODEL_OUTPUT_LIMIT_EXCEEDED',
  'INVALID_STRUCTURED_OUTPUT',
  'LEARNING_GUARD_REJECTED',
  'STORE_WRITE_FAILED',
])

export const LearningFailureV1Schema = z.object({
  code: LearningFailureCodeSchema,
  retryable: z.boolean(),
  occurredAt: isoDateTime,
}).strict()

export const LearningCallV1Schema = z.object({
  requestOrdinal: z.union([z.literal(1), z.literal(2)]),
  kind: z.enum(['PRIMARY', 'FORMAT_REPAIR']),
  inputTokens: safeNonNegativeInteger.optional(),
  outputTokens: safeNonNegativeInteger.optional(),
  outcome: z.enum(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED_OUT']),
}).strict()

export const LearningStateV1Schema = z.object({
  policyVersion: z.literal(LEARNING_POLICY_VERSION),
  attempt: safeNonNegativeInteger.refine(value => value <= 3, 'Expected at most 3 attempts'),
  requestBudgetUsed: safeNonNegativeInteger.refine(value => value <= 2, 'Expected request budget <= 2'),
  claimedAt: isoDateTime.optional(),
  nextEligibleAt: isoDateTime.optional(),
  modelRoute: z.object({
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
  }).strict().optional(),
  calls: z.array(LearningCallV1Schema).max(2),
  failure: LearningFailureV1Schema.optional(),
  experiences: z.array(ExperienceRecordV1Schema).min(1).max(3).optional(),
  proposal: LearningProposalV1Schema.optional(),
  publicationOutcome: z.literal('NEEDS_ATTENTION').optional(),
}).strict().superRefine((value, context) => {
  const ordinals = value.calls.map(call => call.requestOrdinal)
  if (new Set(ordinals).size !== ordinals.length) {
    context.addIssue({ code: 'custom', message: 'Learning call ordinals must be unique' })
  }
  if (ordinals.some(ordinal => ordinal > value.requestBudgetUsed)) {
    context.addIssue({ code: 'custom', message: 'Calls cannot exceed the reserved request budget' })
  }
  if ((value.experiences === undefined) !== (value.proposal === undefined)) {
    context.addIssue({ code: 'custom', message: 'Experiences and Proposal must be committed together' })
  }
})

export type ExperienceRecordV1 = z.infer<typeof ExperienceRecordV1Schema>
export type LearningProposalV1 = z.infer<typeof LearningProposalV1Schema>
export type ModelLearningOutputV1 = z.infer<typeof ModelLearningOutputV1Schema>
export type LearningFailureCode = z.infer<typeof LearningFailureCodeSchema>
export type LearningFailureV1 = z.infer<typeof LearningFailureV1Schema>
export type LearningCallV1 = z.infer<typeof LearningCallV1Schema>
export type LearningStateV1 = z.infer<typeof LearningStateV1Schema>
