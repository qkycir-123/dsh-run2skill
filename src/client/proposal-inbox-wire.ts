import { z } from 'zod'
import type {
  ProposalDetail,
  ProposalListItem,
  ProposalReviewSummary,
} from './proposal-inbox.js'

const identity = z.string().min(1).max(256)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const positiveInteger = z.number().int().safe().positive()
const nonNegativeInteger = z.number().int().safe().nonnegative()
const proposalId = z.string().regex(/^prop_[a-f0-9]{64}$/)
const workItemId = z.string().regex(/^wi_[a-f0-9]{64}$/)
const proposalRef = z.object({ proposalId, revision: positiveInteger, digest: sha256 }).strict()
const processingState = z.enum(['READY_FOR_REVIEW', 'PUBLISHING', 'NEEDS_ATTENTION', 'TERMINAL'])
const publicationOutcome = z.enum([
  'PENDING_REVIEW', 'DISCARDED', 'NEEDS_ATTENTION', 'NEEDS_REFRESH', 'PUBLISHED', 'PUBLISH_FAILED',
])

const rootDisplay = z.object({
  state: z.enum(['EXISTING', 'ABSENT']),
  scope: z.enum(['PROJECT', 'USER']),
  expectedProvider: identity,
  expectedSource: z.enum(['project-dsh', 'user-dsh']),
  resolverVersion: identity,
  rootContractVersion: identity,
  resolutionContractDigest: sha256,
}).strict()
const targetDisplay = z.object({
  skillName: identity,
}).strict()
const actionBinding = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('CREATE'),
    rootBinding: rootDisplay,
    targetBinding: targetDisplay,
    expectedAbsence: z.object({
      observedAt: z.string().min(1).max(64),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('MERGE'),
    rootBinding: rootDisplay,
    targetBinding: targetDisplay,
    baseBinding: z.object({
      candidateKey: z.string().regex(/^cand_[a-f0-9]{64}$/),
      exactBytes: z.string().min(1).max(65_536),
      bytesDigest: sha256,
      observedAt: z.string().min(1).max(64),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('DISCARD'),
    coveringCandidateBinding: z.object({
      candidateKey: z.string().regex(/^cand_[a-f0-9]{64}$/),
      name: z.string().min(1).max(128),
      source: identity,
      content: z.string().min(1).max(65_536),
      contentDigest: sha256,
      observedAt: z.string().min(1).max(64),
    }).strict(),
  }).strict(),
])

const proposal = z.object({
  schemaVersion: z.literal(1),
  revision: positiveInteger,
  createdAt: z.string().min(1).max(64),
  sourceLearningProposalId: z.string().regex(/^lp_[a-f0-9]{64}$/),
  kind: z.enum(['CREATE', 'MERGE', 'DISCARD']),
  name: z.string().min(1).max(128),
  description: z.string().min(1).max(2_048),
  whenToUse: z.string().min(1).max(4_096),
  invocation: z.object({ modelInvocable: z.literal(true), userInvocable: z.literal(false) }).strict(),
  exactSkillBytes: z.string().min(1).max(65_536),
  skillBytesDigest: sha256,
  rendererVersion: identity,
  persistenceScope: z.enum(['PROJECT', 'USER']),
  workspaceBinding: z.object({
    workspaceId: identity,
  }).strict().optional(),
  dshHomeBinding: z.object({
    resolutionKind: z.enum(['CONFIGURATION', 'ENVIRONMENT', 'DEFAULT']),
    identityDigest: sha256,
  }).strict().optional(),
  supportingExperienceIds: z.array(z.string().regex(/^exp_[a-f0-9]{64}$/)).min(1).max(3),
  catalogObservationDigest: sha256,
  curationRationale: z.string().min(1).max(4_096),
  actionBinding,
  proposalId,
  digest: sha256,
}).strict().refine(value => value.kind === value.actionBinding.kind, {
  path: ['actionBinding'],
  message: 'action binding kind must match proposal kind',
})

const evidence = z.object({
  source: z.literal('USER_DIRECT'),
  messageSeq: nonNegativeInteger,
  excerpt: z.string().max(8_192),
  excerptDigest: sha256,
  redactionKinds: z.array(z.string().min(1).max(64)).max(16),
  truncated: z.boolean(),
}).strict()
const experience = z.object({
  experienceId: z.string().regex(/^exp_[a-f0-9]{64}$/),
  type: z.enum(['CORRECTION', 'CONSTRAINT', 'WORKFLOW']),
  lesson: z.string().min(1).max(4_096),
  persistenceScope: z.enum(['PROJECT', 'USER']),
  evidenceStrength: z.literal('HIGH'),
  supportingEvidence: z.array(z.object({
    messageSeq: nonNegativeInteger,
    excerptDigest: sha256,
  }).strict()).min(1).max(4),
  contextSummary: z.string().min(1).max(4_096).optional(),
}).strict()

const summary = z.object({
  apiVersion: z.literal(1),
  status: z.enum(['READY', 'RECOVERING', 'DEGRADED', 'INCOMPATIBLE']),
  recoveryLag: z.boolean(),
  lastHealthCode: z.string().min(1).max(128).optional(),
  queue: z.discriminatedUnion('completeness', [
    z.object({ completeness: z.literal('UNKNOWN') }).strict(),
    z.object({
      completeness: z.literal('KNOWN'),
      pendingReview: nonNegativeInteger,
      publishing: nonNegativeInteger,
      needsAttention: nonNegativeInteger,
    }).strict(),
  ]),
}).strict()
const listItem = z.object({
  workItemId,
  workItemRevision: positiveInteger,
  proposalRef,
  kind: z.enum(['CREATE', 'MERGE', 'DISCARD']),
  name: z.string().min(1).max(128),
  description: z.string().min(1).max(2_048),
  persistenceScope: z.enum(['PROJECT', 'USER']),
  createdAt: z.string().min(1).max(64),
  processingState: z.enum(['READY_FOR_REVIEW', 'PUBLISHING', 'NEEDS_ATTENTION']),
  publicationOutcome: z.enum(['PENDING_REVIEW', 'NEEDS_ATTENTION', 'NEEDS_REFRESH', 'PUBLISH_FAILED']),
}).strict()
const listPage = z.object({
  apiVersion: z.literal(1),
  items: z.array(listItem).max(20),
  nextCursor: z.string().regex(/^c_[1-9][0-9]*_[1-9][0-9]*_[a-f0-9]{64}$/).optional(),
}).strict()
const detail = z.object({
  apiVersion: z.literal(1),
  workItemId,
  workItemRevision: positiveInteger,
  processingState,
  reviewDecision: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
  publicationOutcome,
  proposal,
  sessionCoordinate: z.object({
    rootSessionId: identity,
    sessionCreatedAt: nonNegativeInteger,
    turn: nonNegativeInteger,
    turnEndSeq: nonNegativeInteger,
  }).strict(),
  evidenceRefs: z.array(evidence).max(16),
  experiences: z.array(experience).max(3),
}).strict()
const receipt = z.object({
  apiVersion: z.literal(1),
  workItemId,
  workItemRevision: positiveInteger,
  proposalRef,
  changed: z.boolean(),
  processingState,
  reviewDecision: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
  publicationOutcome,
}).strict()

function parseValue<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const parsed = z.object({ ok: z.literal(true), value: schema }).strict().safeParse(value)
  return parsed.success ? parsed.data.value : undefined
}

export function parseProposalSummary(value: unknown): ProposalReviewSummary | undefined {
  return parseValue(summary, value) as ProposalReviewSummary | undefined
}

type ParsedListPage = {
  readonly apiVersion: 1
  readonly items: readonly ProposalListItem[]
  readonly nextCursor?: string | undefined
}

export function parseProposalList(value: unknown): ParsedListPage | undefined {
  return parseValue(listPage, value) as ParsedListPage | undefined
}

export function parseProposalDetail(value: unknown): ProposalDetail | undefined {
  return parseValue(detail, value) as ProposalDetail | undefined
}

export function parseMutationReceipt(value: unknown): {
  readonly apiVersion: 1
  readonly workItemId: string
  readonly workItemRevision: number
  readonly proposalRef: { readonly proposalId: string; readonly revision: number; readonly digest: string }
  readonly changed: boolean
  readonly processingState: 'READY_FOR_REVIEW' | 'PUBLISHING' | 'NEEDS_ATTENTION' | 'TERMINAL'
  readonly reviewDecision: 'PENDING' | 'APPROVED' | 'REJECTED'
  readonly publicationOutcome: 'PENDING_REVIEW' | 'DISCARDED' | 'NEEDS_ATTENTION' | 'NEEDS_REFRESH' | 'PUBLISHED' | 'PUBLISH_FAILED'
} | undefined {
  return parseValue(receipt, value)
}
