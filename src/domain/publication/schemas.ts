import { z } from 'zod'
import { canonicalJson } from '../learn/identity.js'
import { sha256Utf8 } from '../observe/hashing.js'

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/)
const isoDateTime = z.string().datetime({ offset: true })
const positiveSafeInteger = z.number().refine(
  value => Number.isSafeInteger(value) && value >= 1,
  'Expected a positive safe integer',
)
const identity = z.string().min(1).max(256)
const path = z.string().min(1).refine(
  value => Buffer.byteLength(value, 'utf8') <= 8 * 1024,
  'Path exceeds 8 KiB',
)
const skillBytes = z.string().min(1).refine(
  value => Buffer.byteLength(value, 'utf8') <= 64 * 1024,
  'Skill bytes exceed 64 KiB',
)

export const PUBLICATION_LIMITS = {
  maxAttempts: 3,
  maxJournalEntries: 32,
  maxLineageRevisions: 64,
} as const

export const PublicationJournalStageV1Schema = z.enum([
  'APPROVAL_COMMITTED',
  'FACTS_REVALIDATED',
  'ROOT_PREPARED',
  'TARGET_INSTALLED',
  'DISK_VERIFIED',
  'READBACK_CONFIRMED',
  'LINEAGE_PENDING',
  'LINEAGE_COMMITTED',
  'OUTCOME_COMMITTED',
])

export type PublicationJournalStageV1 = z.infer<typeof PublicationJournalStageV1Schema>

const JOURNAL_STAGE_ORDER: readonly PublicationJournalStageV1[] = [
  'APPROVAL_COMMITTED',
  'FACTS_REVALIDATED',
  'ROOT_PREPARED',
  'TARGET_INSTALLED',
  'DISK_VERIFIED',
  'READBACK_CONFIRMED',
  'LINEAGE_PENDING',
  'LINEAGE_COMMITTED',
  'OUTCOME_COMMITTED',
]

const PublicationJournalEventFactsV1Schema = z.object({
  schemaVersion: z.literal(1),
  ordinal: positiveSafeInteger,
  attempt: positiveSafeInteger,
  attemptId: z.string().regex(/^pub-[a-f0-9]{64}$/),
  stage: PublicationJournalStageV1Schema,
  targetIdentityDigest: sha256Hex,
  expectedHash: sha256Hex.optional(),
  observedHash: sha256Hex.optional(),
  occurredAt: isoDateTime,
  previousDigest: sha256Hex.nullable(),
}).strict()

export type PublicationJournalEventFactsV1 = z.infer<typeof PublicationJournalEventFactsV1Schema>

function journalEventDigest(facts: PublicationJournalEventFactsV1): string {
  return sha256Utf8(canonicalJson(facts))
}

export const PublicationJournalEventV1Schema = PublicationJournalEventFactsV1Schema.extend({
  digest: sha256Hex,
}).strict().superRefine((value, context) => {
  const { digest, ...facts } = value
  if (digest !== journalEventDigest(facts)) {
    context.addIssue({ code: 'custom', path: ['digest'], message: 'Publication event digest does not match facts' })
  }
})

export type PublicationJournalEventV1 = z.infer<typeof PublicationJournalEventV1Schema>

export const LineageRevisionV1Schema = z.object({
  revision: positiveSafeInteger,
  origin: z.enum(['ADOPTED_BASE', 'MANUAL_BASE', 'RUN2SKILL']),
  proposalId: z.string().regex(/^prop_[a-f0-9]{64}$/).optional(),
  exactSkillBytes: skillBytes,
  skillBytesDigest: sha256Hex,
  committedAt: isoDateTime,
}).strict().superRefine((value, context) => {
  if (value.skillBytesDigest !== sha256Utf8(value.exactSkillBytes)) {
    context.addIssue({ code: 'custom', path: ['skillBytesDigest'], message: 'Lineage bytes digest does not match bytes' })
  }
  if ((value.origin === 'RUN2SKILL') !== (value.proposalId !== undefined)) {
    context.addIssue({ code: 'custom', path: ['proposalId'], message: 'Only run2skill revisions bind a Proposal' })
  }
})

export type LineageRevisionV1 = z.infer<typeof LineageRevisionV1Schema>

export interface PublicationTargetIdentityFactsV1 {
  readonly scope: 'PROJECT' | 'USER'
  readonly provider: string
  readonly source: 'project-dsh' | 'user-dsh'
  readonly skillName: string
  readonly canonicalTargetPath: string
}

export function derivePublicationTargetIdentityDigest(
  facts: PublicationTargetIdentityFactsV1,
): string {
  return sha256Utf8(canonicalJson({
    scope: facts.scope,
    provider: facts.provider,
    source: facts.source,
    skillName: facts.skillName,
    canonicalTargetPath: facts.canonicalTargetPath,
  }))
}

const LineageFactsV1Schema = z.object({
  schemaVersion: z.literal(1),
  scope: z.enum(['PROJECT', 'USER']),
  provider: identity,
  source: z.enum(['project-dsh', 'user-dsh']),
  skillName: z.string().min(1).max(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  canonicalTargetPath: path,
  targetIdentityDigest: sha256Hex,
  currentRevision: positiveSafeInteger,
  revisions: z.array(LineageRevisionV1Schema).min(1).max(PUBLICATION_LIMITS.maxLineageRevisions),
}).strict()

export function deriveLineageId(
  scope: 'PROJECT' | 'USER',
  targetIdentityDigest: string,
): `lin_${string}` {
  return `lin_${sha256Utf8(canonicalJson({ scope, targetIdentityDigest }))}`
}

export const LineageV1Schema = LineageFactsV1Schema.extend({
  lineageId: z.string().regex(/^lin_[a-f0-9]{64}$/),
}).strict().superRefine((value, context) => {
  if (value.targetIdentityDigest !== derivePublicationTargetIdentityDigest(value)) {
    context.addIssue({ code: 'custom', path: ['targetIdentityDigest'], message: 'Target identity digest does not match target facts' })
  }
  if (value.lineageId !== deriveLineageId(value.scope, value.targetIdentityDigest)) {
    context.addIssue({ code: 'custom', path: ['lineageId'], message: 'Lineage id does not match target facts' })
  }
  if (value.source !== (value.scope === 'PROJECT' ? 'project-dsh' : 'user-dsh')) {
    context.addIssue({ code: 'custom', path: ['source'], message: 'Lineage source does not match scope' })
  }
  if (value.currentRevision !== value.revisions.length) {
    context.addIssue({ code: 'custom', path: ['currentRevision'], message: 'Lineage current revision must match full snapshots' })
  }
  value.revisions.forEach((revision, index) => {
    if (revision.revision !== index + 1) {
      context.addIssue({ code: 'custom', path: ['revisions', index, 'revision'], message: 'Lineage revisions must be consecutive' })
    }
  })
})

export type LineageV1 = z.infer<typeof LineageV1Schema>
export type LineageFactsV1 = z.input<typeof LineageFactsV1Schema>

export function materializeLineage(facts: Omit<LineageFactsV1, 'schemaVersion' | 'currentRevision'>): LineageV1 {
  return LineageV1Schema.parse({
    schemaVersion: 1,
    ...facts,
    lineageId: deriveLineageId(facts.scope, facts.targetIdentityDigest),
    currentRevision: facts.revisions.length,
  })
}

export const PublicationStateV1Schema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal('publication-v1'),
  attemptCount: positiveSafeInteger.refine(value => value <= PUBLICATION_LIMITS.maxAttempts),
  activeAttemptId: z.string().regex(/^pub-[a-f0-9]{64}$/),
  targetIdentityDigest: sha256Hex,
  journal: z.array(PublicationJournalEventV1Schema).min(1).max(PUBLICATION_LIMITS.maxJournalEntries),
  pendingLineage: LineageV1Schema.optional(),
}).strict().superRefine((value, context) => {
  let previousDigest: string | null = null
  let previousAttempt = 0
  let previousStageIndex = -1
  for (const [index, event] of value.journal.entries()) {
    if (event.ordinal !== index + 1 || event.previousDigest !== previousDigest) {
      context.addIssue({ code: 'custom', path: ['journal', index], message: 'Publication journal chain is not consecutive' })
    }
    if (event.targetIdentityDigest !== value.targetIdentityDigest || event.attempt > value.attemptCount) {
      context.addIssue({ code: 'custom', path: ['journal', index], message: 'Publication journal event is outside the active target or attempt bounds' })
    }
    const stageIndex = JOURNAL_STAGE_ORDER.indexOf(event.stage)
    if (event.attempt !== previousAttempt) {
      if (event.attempt !== previousAttempt + 1 || event.stage !== 'APPROVAL_COMMITTED') {
        context.addIssue({ code: 'custom', path: ['journal', index], message: 'Each publication attempt must start with approval' })
      }
      previousAttempt = event.attempt
      previousStageIndex = stageIndex
    } else {
      if (stageIndex <= previousStageIndex) {
        context.addIssue({ code: 'custom', path: ['journal', index, 'stage'], message: 'Publication stages must advance once per attempt' })
      }
      previousStageIndex = stageIndex
    }
    previousDigest = event.digest
  }
  const last = value.journal.at(-1)
  if (last?.attempt !== value.attemptCount || last.attemptId !== value.activeAttemptId) {
    context.addIssue({ code: 'custom', path: ['activeAttemptId'], message: 'Active publication attempt must match the journal tail' })
  }
  if (
    value.pendingLineage !== undefined
    && value.pendingLineage.targetIdentityDigest !== value.targetIdentityDigest
  ) {
    context.addIssue({ code: 'custom', path: ['pendingLineage'], message: 'Pending Lineage must bind the publication target' })
  }
})

export type PublicationStateV1 = z.infer<typeof PublicationStateV1Schema>

function deriveAttemptId(workItemId: string, proposalId: string, attempt: number): `pub-${string}` {
  return `pub-${sha256Utf8(canonicalJson({ workItemId, proposalId, attempt }))}`
}

function materializeJournalEvent(facts: PublicationJournalEventFactsV1): PublicationJournalEventV1 {
  return PublicationJournalEventV1Schema.parse({ ...facts, digest: journalEventDigest(facts) })
}

export function createPublicationState(input: {
  readonly workItemId: string
  readonly proposalId: string
  readonly targetIdentityDigest: string
  readonly occurredAt: string
}): PublicationStateV1 {
  const attemptId = deriveAttemptId(input.workItemId, input.proposalId, 1)
  const event = materializeJournalEvent({
    schemaVersion: 1,
    ordinal: 1,
    attempt: 1,
    attemptId,
    stage: 'APPROVAL_COMMITTED',
    targetIdentityDigest: input.targetIdentityDigest,
    occurredAt: input.occurredAt,
    previousDigest: null,
  })
  return PublicationStateV1Schema.parse({
    schemaVersion: 1,
    policyVersion: 'publication-v1',
    attemptCount: 1,
    activeAttemptId: attemptId,
    targetIdentityDigest: input.targetIdentityDigest,
    journal: [event],
  })
}

export function appendPublicationJournalEvent(
  state: PublicationStateV1,
  input: {
    readonly stage: Exclude<PublicationJournalStageV1, 'APPROVAL_COMMITTED'>
    readonly occurredAt: string
    readonly expectedHash?: string
    readonly observedHash?: string
  },
): PublicationStateV1 {
  const current = PublicationStateV1Schema.parse(state)
  if (current.journal.length >= PUBLICATION_LIMITS.maxJournalEntries) {
    throw new Error('PUBLICATION_JOURNAL_LIMIT')
  }
  const previous = current.journal.at(-1)!
  const event = materializeJournalEvent({
    schemaVersion: 1,
    ordinal: current.journal.length + 1,
    attempt: current.attemptCount,
    attemptId: current.activeAttemptId,
    stage: input.stage,
    targetIdentityDigest: current.targetIdentityDigest,
    ...(input.expectedHash === undefined ? {} : { expectedHash: input.expectedHash }),
    ...(input.observedHash === undefined ? {} : { observedHash: input.observedHash }),
    occurredAt: input.occurredAt,
    previousDigest: previous.digest,
  })
  return PublicationStateV1Schema.parse({ ...current, journal: [...current.journal, event] })
}

export function beginPublicationRetry(
  state: PublicationStateV1,
  input: { readonly workItemId: string; readonly proposalId: string; readonly occurredAt: string },
): PublicationStateV1 {
  const current = PublicationStateV1Schema.parse(state)
  const attempt = current.attemptCount + 1
  if (attempt > PUBLICATION_LIMITS.maxAttempts || current.journal.length >= PUBLICATION_LIMITS.maxJournalEntries) {
    throw new Error('PUBLICATION_RETRY_LIMIT')
  }
  const attemptId = deriveAttemptId(input.workItemId, input.proposalId, attempt)
  const previous = current.journal.at(-1)!
  const event = materializeJournalEvent({
    schemaVersion: 1,
    ordinal: current.journal.length + 1,
    attempt,
    attemptId,
    stage: 'APPROVAL_COMMITTED',
    targetIdentityDigest: current.targetIdentityDigest,
    occurredAt: input.occurredAt,
    previousDigest: previous.digest,
  })
  return PublicationStateV1Schema.parse({
    ...current,
    attemptCount: attempt,
    activeAttemptId: attemptId,
    journal: [...current.journal, event],
    pendingLineage: undefined,
  })
}
