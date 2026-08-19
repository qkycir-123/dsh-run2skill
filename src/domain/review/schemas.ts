import { z } from 'zod'
import { canonicalJson } from '../learn/identity.js'
import { sha256Utf8 } from '../observe/hashing.js'

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/)
const isoDateTime = z.string().datetime({ offset: true })
const positiveSafeInteger = z.number().refine(
  value => Number.isSafeInteger(value) && value >= 1,
  'Expected a positive safe integer',
)

function utf8Limited(maxBytes: number) {
  return z.string().min(1).refine(
    value => Buffer.byteLength(value, 'utf8') <= maxBytes,
    `Expected at most ${maxBytes} UTF-8 bytes`,
  )
}

const identity = z.string().min(1).max(256)
const path = utf8Limited(8 * 1024)
const skillBytes = utf8Limited(64 * 1024)
const skillName = z.string().min(1).max(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)

const WorkspaceBindingV1Schema = z.object({
  workspaceId: identity,
  canonicalPath: path,
  observedAt: isoDateTime,
}).strict()

const RootBindingCommonSchema = z.object({
  scope: z.enum(['PROJECT', 'USER']),
  provider: identity,
  source: z.enum(['project-dsh', 'user-dsh']),
  resolverVersion: identity,
  observationDigest: sha256Hex,
  declaredRootPath: path,
}).strict()

export const RootBindingV1Schema = z.discriminatedUnion('state', [
  RootBindingCommonSchema.extend({
    state: z.literal('EXISTING'),
    canonicalRootPath: path,
    rootIdentityDigest: sha256Hex,
  }).strict(),
  RootBindingCommonSchema.extend({
    state: z.literal('ABSENT'),
    canonicalExistingAncestorPath: path,
    ancestorIdentityDigest: sha256Hex,
    missingSegments: z.array(z.string().min(1).max(64)).min(1).max(2),
  }).strict(),
]).superRefine((value, context) => {
  const expectedSource = value.scope === 'PROJECT' ? 'project-dsh' : 'user-dsh'
  if (value.source !== expectedSource) {
    context.addIssue({ code: 'custom', path: ['source'], message: 'Root source must match scope' })
  }
  if (value.state === 'ABSENT') {
    const segments = value.missingSegments.join('\0')
    const allowed = value.scope === 'PROJECT'
      ? new Set(['.dsh\0skills', 'skills'])
      : new Set(['skills'])
    if (!allowed.has(segments)) {
      context.addIssue({ code: 'custom', path: ['missingSegments'], message: 'Missing root segments are not fixed for scope' })
    }
  }
})

const TargetBindingV1Schema = z.object({
  skillName,
  bundlePath: path,
  skillFilePath: path,
}).strict()

const ExpectedAbsenceV1Schema = z.object({
  catalogObservationDigest: sha256Hex,
  observedAt: isoDateTime,
  flatSkillFilePath: path,
  bundlePathAbsent: z.literal(true),
  skillFilePathAbsent: z.literal(true),
  flatSkillFilePathAbsent: z.literal(true),
}).strict()

const BaseBindingV1Schema = z.object({
  candidateKey: z.string().regex(/^cand_[a-f0-9]{64}$/),
  provider: identity,
  source: identity,
  path,
  exactBytes: skillBytes,
  bytesDigest: sha256Hex,
  catalogObservationDigest: sha256Hex,
  observedAt: isoDateTime,
}).strict().superRefine((value, context) => {
  if (value.bytesDigest !== sha256Utf8(value.exactBytes)) {
    context.addIssue({ code: 'custom', path: ['bytesDigest'], message: 'Candidate digest does not match bytes' })
  }
})

const CoveringCandidateBindingV1Schema = z.object({
  candidateKey: z.string().regex(/^cand_[a-f0-9]{64}$/),
  provider: identity,
  source: identity,
  name: skillName,
  description: utf8Limited(2 * 1024),
  whenToUse: utf8Limited(4 * 1024).optional(),
  content: skillBytes,
  contentDigest: sha256Hex,
  path: path.optional(),
  catalogObservationDigest: sha256Hex,
  observedAt: isoDateTime,
}).strict().superRefine((value, context) => {
  if (value.contentDigest !== sha256Utf8(value.content)) {
    context.addIssue({ code: 'custom', path: ['contentDigest'], message: 'Candidate digest does not match content' })
  }
})

const CreateBindingV1Schema = z.object({
  kind: z.literal('CREATE'),
  rootBinding: RootBindingV1Schema,
  targetBinding: TargetBindingV1Schema,
  expectedAbsence: ExpectedAbsenceV1Schema,
}).strict()

const MergeBindingV1Schema = z.object({
  kind: z.literal('MERGE'),
  rootBinding: RootBindingV1Schema,
  targetBinding: TargetBindingV1Schema,
  baseBinding: BaseBindingV1Schema,
}).strict()

const DiscardBindingV1Schema = z.object({
  kind: z.literal('DISCARD'),
  coveringCandidateBinding: CoveringCandidateBindingV1Schema,
}).strict()

const ActionBindingV1Schema = z.discriminatedUnion('kind', [
  CreateBindingV1Schema,
  MergeBindingV1Schema,
  DiscardBindingV1Schema,
])

const ProposalSnapshotFactsV1Schema = z.object({
  schemaVersion: z.literal(1),
  revision: positiveSafeInteger,
  createdAt: isoDateTime,
  sourceLearningProposalId: z.string().regex(/^lp_[a-f0-9]{64}$/),
  kind: z.enum(['CREATE', 'MERGE', 'DISCARD']),
  name: skillName,
  description: utf8Limited(2 * 1024),
  whenToUse: utf8Limited(4 * 1024),
  invocation: z.object({
    modelInvocable: z.literal(true),
    userInvocable: z.literal(false),
  }).strict(),
  exactSkillBytes: skillBytes,
  skillBytesDigest: sha256Hex,
  rendererVersion: identity,
  persistenceScope: z.enum(['PROJECT', 'USER']),
  workspaceBinding: WorkspaceBindingV1Schema.optional(),
  supportingExperienceIds: z.array(z.string().regex(/^exp_[a-f0-9]{64}$/)).min(1).max(3),
  catalogObservationDigest: sha256Hex,
  curationRationale: utf8Limited(4 * 1024),
  actionBinding: ActionBindingV1Schema,
}).strict().superRefine((value, context) => {
  if (value.skillBytesDigest !== sha256Utf8(value.exactSkillBytes)) {
    context.addIssue({ code: 'custom', path: ['skillBytesDigest'], message: 'Skill digest does not match bytes' })
  }
  if (value.kind !== value.actionBinding.kind) {
    context.addIssue({ code: 'custom', path: ['actionBinding'], message: 'Action binding must match Proposal kind' })
  }
  if (value.persistenceScope === 'PROJECT' && value.workspaceBinding === undefined) {
    context.addIssue({ code: 'custom', path: ['workspaceBinding'], message: 'PROJECT Proposal requires a Workspace binding' })
  }
  if (new Set(value.supportingExperienceIds).size !== value.supportingExperienceIds.length) {
    context.addIssue({ code: 'custom', path: ['supportingExperienceIds'], message: 'Supporting Experiences must be unique' })
  }
  if (value.actionBinding.kind !== 'DISCARD') {
    if (value.actionBinding.rootBinding.scope !== value.persistenceScope) {
      context.addIssue({ code: 'custom', path: ['actionBinding', 'rootBinding'], message: 'Root scope must match Proposal scope' })
    }
    if (value.actionBinding.targetBinding.skillName !== value.name) {
      context.addIssue({ code: 'custom', path: ['actionBinding', 'targetBinding'], message: 'Target name must match Proposal name' })
    }
    if (
      value.actionBinding.kind === 'CREATE'
      && value.actionBinding.expectedAbsence.catalogObservationDigest !== value.catalogObservationDigest
    ) {
      context.addIssue({ code: 'custom', path: ['actionBinding', 'expectedAbsence'], message: 'Expected absence must use the Proposal catalog observation' })
    }
    if (
      value.actionBinding.kind === 'MERGE'
      && value.actionBinding.baseBinding.catalogObservationDigest !== value.catalogObservationDigest
    ) {
      context.addIssue({ code: 'custom', path: ['actionBinding', 'baseBinding'], message: 'MERGE Base must use the Proposal catalog observation' })
    }
  } else if (
    value.actionBinding.coveringCandidateBinding.catalogObservationDigest
    !== value.catalogObservationDigest
  ) {
    context.addIssue({ code: 'custom', path: ['actionBinding', 'coveringCandidateBinding'], message: 'Coverage must use the Proposal catalog observation' })
  }
})

export type ProposalSnapshotFactsV1 = z.infer<typeof ProposalSnapshotFactsV1Schema>

function digestProposalFacts(facts: ProposalSnapshotFactsV1): string {
  return sha256Utf8(canonicalJson(facts))
}

export function deriveProposalDigest(facts: ProposalSnapshotFactsV1): string {
  return digestProposalFacts(ProposalSnapshotFactsV1Schema.parse(facts))
}

export function deriveProposalId(
  workItemId: string,
  facts: ProposalSnapshotFactsV1,
): `prop_${string}` {
  return `prop_${sha256Utf8(canonicalJson({ workItemId, facts: ProposalSnapshotFactsV1Schema.parse(facts) }))}`
}

export const ProposalSnapshotV1Schema = ProposalSnapshotFactsV1Schema.extend({
  proposalId: z.string().regex(/^prop_[a-f0-9]{64}$/),
  digest: sha256Hex,
}).strict().superRefine((value, context) => {
  const { proposalId: _proposalId, digest, ...facts } = value
  if (digest !== digestProposalFacts(facts)) {
    context.addIssue({ code: 'custom', path: ['digest'], message: 'Proposal digest does not match immutable facts' })
  }
})

export type ProposalSnapshotV1 = z.infer<typeof ProposalSnapshotV1Schema>

export function proposalFactsOf(proposal: ProposalSnapshotV1): ProposalSnapshotFactsV1 {
  const { proposalId: _proposalId, digest: _digest, ...facts } = proposal
  return facts
}

export function materializeProposalSnapshot(
  workItemId: string,
  facts: ProposalSnapshotFactsV1,
): ProposalSnapshotV1 {
  const parsedFacts = ProposalSnapshotFactsV1Schema.parse(facts)
  return ProposalSnapshotV1Schema.parse({
    ...parsedFacts,
    proposalId: deriveProposalId(workItemId, parsedFacts),
    digest: deriveProposalDigest(parsedFacts),
  })
}

export const ProposalRefV1Schema = z.object({
  proposalId: z.string().regex(/^prop_[a-f0-9]{64}$/),
  revision: positiveSafeInteger,
  digest: sha256Hex,
}).strict()

export type ProposalRefV1 = z.infer<typeof ProposalRefV1Schema>

export function proposalRefOf(proposal: ProposalSnapshotV1): ProposalRefV1 {
  return { proposalId: proposal.proposalId, revision: proposal.revision, digest: proposal.digest }
}

export const ReviewStateV1Schema = z.object({
  policyVersion: z.literal('review-v1'),
  proposal: ProposalSnapshotV1Schema,
  reviewDecision: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
  publicationOutcome: z.enum([
    'PENDING_REVIEW',
    'DISCARDED',
    'NEEDS_ATTENTION',
    'NEEDS_REFRESH',
    'PUBLISHED',
    'PUBLISH_FAILED',
  ]),
  coverageRetryCount: z.union([z.literal(0), z.literal(1)]),
  decidedAt: isoDateTime.optional(),
  decisionReason: z.enum(['USER_REJECTED', 'COVERAGE_CONFIRMED']).optional(),
  failure: z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    retryable: z.boolean(),
    occurredAt: isoDateTime,
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.reviewDecision === 'PENDING' && value.decidedAt !== undefined) {
    context.addIssue({ code: 'custom', path: ['decidedAt'], message: 'Pending review cannot have a decision time' })
  }
  if (value.reviewDecision !== 'PENDING' && value.decidedAt === undefined) {
    context.addIssue({ code: 'custom', path: ['decidedAt'], message: 'A review decision requires a decision time' })
  }
  if (value.reviewDecision === 'APPROVED' && value.proposal.kind === 'DISCARD') {
    context.addIssue({ code: 'custom', path: ['reviewDecision'], message: 'DISCARD cannot be approved for publication' })
  }
  const allowedOutcomes = value.reviewDecision === 'PENDING'
    ? ['PENDING_REVIEW', 'NEEDS_ATTENTION']
    : value.reviewDecision === 'APPROVED'
      ? ['PENDING_REVIEW', 'NEEDS_ATTENTION', 'NEEDS_REFRESH', 'PUBLISHED', 'PUBLISH_FAILED']
      : ['DISCARDED']
  if (!allowedOutcomes.includes(value.publicationOutcome)) {
    context.addIssue({ code: 'custom', path: ['publicationOutcome'], message: 'Outcome does not match the Review decision' })
  }
  if (value.reviewDecision === 'REJECTED') {
    if (value.publicationOutcome !== 'DISCARDED' || value.decisionReason === undefined) {
      context.addIssue({ code: 'custom', message: 'Rejected review must record a discarded reason' })
    }
  } else if (value.decisionReason !== undefined) {
    context.addIssue({ code: 'custom', path: ['decisionReason'], message: 'Only rejected review has a decision reason' })
  }
  if (value.publicationOutcome === 'PENDING_REVIEW' && value.failure !== undefined) {
    context.addIssue({ code: 'custom', path: ['failure'], message: 'Pending review cannot have a failure' })
  }
  if (
    value.publicationOutcome === 'NEEDS_ATTENTION'
    && value.failure === undefined
  ) {
    context.addIssue({ code: 'custom', path: ['failure'], message: 'Needs attention requires a structured failure' })
  }
  if (
    value.reviewDecision === 'PENDING'
    && value.publicationOutcome === 'NEEDS_ATTENTION'
    && (
      value.proposal.kind !== 'DISCARD'
      || value.coverageRetryCount !== 1
      || value.failure?.code !== 'COVERAGE_REANALYSIS_REQUESTED'
    )
  ) {
    context.addIssue({ code: 'custom', message: 'Pending attention is reserved for one declined DISCARD reanalysis' })
  }
  if (
    ['NEEDS_REFRESH', 'PUBLISH_FAILED'].includes(value.publicationOutcome)
    && value.failure === undefined
  ) {
    context.addIssue({ code: 'custom', path: ['failure'], message: 'Non-terminal publication failure requires structured facts' })
  }
  if (['DISCARDED', 'PUBLISHED'].includes(value.publicationOutcome) && value.failure !== undefined) {
    context.addIssue({ code: 'custom', path: ['failure'], message: 'Successful terminal outcomes cannot retain a failure' })
  }
  if (value.coverageRetryCount === 1 && value.proposal.kind !== 'DISCARD') {
    context.addIssue({ code: 'custom', path: ['coverageRetryCount'], message: 'Only DISCARD can request coverage reanalysis' })
  }
  if (
    value.coverageRetryCount === 1
    && value.failure?.code !== 'COVERAGE_REANALYSIS_REQUESTED'
  ) {
    context.addIssue({ code: 'custom', path: ['coverageRetryCount'], message: 'Coverage retry must retain its request failure' })
  }
  if (
    value.coverageRetryCount === 0
    && value.failure?.code === 'COVERAGE_REANALYSIS_REQUESTED'
  ) {
    context.addIssue({ code: 'custom', path: ['failure'], message: 'Coverage reanalysis must consume its one retry' })
  }
  if (
    value.decisionReason === 'COVERAGE_CONFIRMED'
    && value.proposal.kind !== 'DISCARD'
  ) {
    context.addIssue({ code: 'custom', path: ['decisionReason'], message: 'Coverage confirmation requires a DISCARD Proposal' })
  }
})

export type ReviewStateV1 = z.infer<typeof ReviewStateV1Schema>
