import type { CaptureWorkItemV1 } from '../observe/schemas.js'
import { sha256Utf8 } from '../observe/hashing.js'
import { preprocessPersistentText } from '../observe/redaction.js'
import { ExperienceRecordV1Schema, LearningProposalV1Schema, type ExperienceRecordV1, type LearningProposalV1 } from './schemas.js'
import type { CandidatePersistenceScope, SkillRecallObservation } from './skill-recall.js'

export type LearningPersistenceScope = 'PROJECT' | 'USER'

export type LearningScopeResolution =
  | { readonly status: 'AVAILABLE'; readonly persistenceScope: LearningPersistenceScope; readonly cwd: string }
  | { readonly status: 'UNAVAILABLE'; readonly failureCode: 'LEARNING_GUARD_REJECTED' }

const USER_SCOPE_INTENT = /\b(?:across\s+(?:all\s+)?(?:projects?|repositories|workspaces)|(?:all|every|any)\s+(?:projects?|repositories|workspaces)|globally|user[- ]wide)\b|所有项目|每个项目|任意项目|跨项目|全局/iu
const FORMAT_CONTROLS = /\p{Cf}/u
const MARKDOWN_HEADING = /^#{1,6}\s+\S/mu

export function intendedLearningPersistenceScope(
  item: Pick<CaptureWorkItemV1, 'workspaceBinding' | 'evidenceRefs'>,
): LearningPersistenceScope | undefined {
  if (item.evidenceRefs.some(evidence => USER_SCOPE_INTENT.test(evidence.excerpt))) return 'USER'
  return item.workspaceBinding.status === 'BOUND' ? 'PROJECT' : undefined
}

export function resolveLearningScope(
  item: CaptureWorkItemV1,
  sessionCwd: string | undefined,
): LearningScopeResolution {
  const intendedScope = intendedLearningPersistenceScope(item)
  if (intendedScope === 'USER' && sessionCwd !== undefined && sessionCwd.length > 0) {
    return { status: 'AVAILABLE', persistenceScope: 'USER', cwd: sessionCwd }
  }
  if (item.workspaceBinding.status === 'BOUND') {
    return {
      status: 'AVAILABLE',
      persistenceScope: 'PROJECT',
      cwd: item.workspaceBinding.canonicalPath,
    }
  }
  return { status: 'UNAVAILABLE', failureCode: 'LEARNING_GUARD_REJECTED' }
}

function itemAllowsScope(item: CaptureWorkItemV1, scope: LearningPersistenceScope): boolean {
  if (scope === 'PROJECT') return item.workspaceBinding.status === 'BOUND'
  return item.evidenceRefs.some(evidence => USER_SCOPE_INTENT.test(evidence.excerpt))
}

export function canCandidateCoverScope(
  proposalScope: LearningPersistenceScope,
  candidateScope: CandidatePersistenceScope,
): boolean {
  return candidateScope === proposalScope
    || (proposalScope === 'PROJECT' && candidateScope === 'USER')
}

/** A runtime candidate is proven effective for the current project view, not user-wide scope. */
export function canLoadedCandidateCoverScope(
  proposalScope: LearningPersistenceScope,
  candidate: Pick<SkillRecallObservation['candidates'][number], 'persistenceScope' | 'provider'>,
): boolean {
  return canCandidateCoverScope(proposalScope, candidate.persistenceScope)
    || (proposalScope === 'PROJECT' && candidate.provider === 'runtime')
}

export type LearningGuardReason =
  | 'INVALID_RESULT'
  | 'SCOPE_MISMATCH'
  | 'UNKNOWN_EVIDENCE'
  | 'UNKNOWN_EXPERIENCE'
  | 'CATALOG_MISMATCH'
  | 'CANDIDATE_MISMATCH'
  | 'CANDIDATE_NOT_WRITABLE'
  | 'CANDIDATE_SCOPE_MISMATCH'
  | 'NO_NEW_VALUE'
  | 'UNSAFE_CONTENT'

export type LearningGuardResult =
  | { readonly status: 'ACCEPTED' }
  | { readonly status: 'REJECTED'; readonly reason: LearningGuardReason }

interface GuardInput {
  readonly item: CaptureWorkItemV1
  readonly expectedScope: LearningPersistenceScope
  readonly observation: SkillRecallObservation
  readonly experiences: readonly ExperienceRecordV1[]
  readonly proposal: LearningProposalV1
}

function hasUnsafeText(value: string): boolean {
  return FORMAT_CONTROLS.test(value) || preprocessPersistentText(value).redactionKinds.length > 0
}

function unsafeResultText(experiences: readonly ExperienceRecordV1[], proposal: LearningProposalV1): boolean {
  const texts = [
    ...experiences.flatMap(experience => [experience.lesson, experience.contextSummary ?? '']),
    proposal.description,
    proposal.whenToUse,
    proposal.content,
    proposal.curation.rationale,
  ]
  return texts.some(hasUnsafeText) || !MARKDOWN_HEADING.test(proposal.content)
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function guardLearningResult(input: GuardInput): LearningGuardResult {
  const experiencesParse = ExperienceRecordV1Schema.array().min(1).max(3).safeParse(input.experiences)
  const proposalParse = LearningProposalV1Schema.safeParse(input.proposal)
  if (!experiencesParse.success || !proposalParse.success) return { status: 'REJECTED', reason: 'INVALID_RESULT' }
  const experiences = experiencesParse.data
  const proposal = proposalParse.data

  if (
    !itemAllowsScope(input.item, input.expectedScope)
    || proposal.persistenceScope !== input.expectedScope
    || experiences.some(experience => experience.persistenceScope !== input.expectedScope)
  ) return { status: 'REJECTED', reason: 'SCOPE_MISMATCH' }

  const evidence = new Set(input.item.evidenceRefs.map(item => `${item.messageSeq}\u0000${item.excerptDigest}`))
  if (experiences.some(experience => experience.supportingEvidence.some(item => (
    !evidence.has(`${item.messageSeq}\u0000${item.excerptDigest}`)
  )))) return { status: 'REJECTED', reason: 'UNKNOWN_EVIDENCE' }

  const experienceIds = new Set(experiences.map(experience => experience.experienceId))
  if (proposal.supportingExperienceIds.some(id => !experienceIds.has(id))) {
    return { status: 'REJECTED', reason: 'UNKNOWN_EXPERIENCE' }
  }
  if (
    proposal.catalogObservationDigest !== input.observation.catalogObservationDigest
    || !sameOrderedValues(
      proposal.shortlistDigests,
      input.observation.candidates.map(candidate => candidate.candidateDigest),
    )
  ) return { status: 'REJECTED', reason: 'CATALOG_MISMATCH' }
  if (unsafeResultText(experiences, proposal)) return { status: 'REJECTED', reason: 'UNSAFE_CONTENT' }

  if (proposal.curation.decision === 'CREATE') return { status: 'ACCEPTED' }
  const candidate = input.observation.candidates.find(item => (
    item.candidateKey === proposal.curation.candidateKey
  ))
  if (candidate === undefined) return { status: 'REJECTED', reason: 'CANDIDATE_MISMATCH' }

  if (proposal.curation.decision === 'MERGE') {
    if (!candidate.writable) return { status: 'REJECTED', reason: 'CANDIDATE_NOT_WRITABLE' }
    if (candidate.persistenceScope !== proposal.persistenceScope) {
      return { status: 'REJECTED', reason: 'CANDIDATE_SCOPE_MISMATCH' }
    }
    if (candidate.bodyDigest === sha256Utf8(proposal.content)) {
      return { status: 'REJECTED', reason: 'NO_NEW_VALUE' }
    }
    return { status: 'ACCEPTED' }
  }
  return canLoadedCandidateCoverScope(proposal.persistenceScope, candidate)
    ? { status: 'ACCEPTED' }
    : { status: 'REJECTED', reason: 'CANDIDATE_SCOPE_MISMATCH' }
}
