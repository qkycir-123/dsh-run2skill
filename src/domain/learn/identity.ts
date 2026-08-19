import { sha256Utf8 } from '../observe/hashing.js'
import {
  ExperienceRecordV1Schema,
  LearningProposalV1Schema,
  type ExperienceRecordV1,
  type LearningProposalV1,
  type ModelLearningOutputV1,
} from './schemas.js'

type ExperienceFacts = Omit<ExperienceRecordV1, 'experienceId'>
type ProposalFacts = Omit<LearningProposalV1, 'learningProposalId'>

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function deriveExperienceId(workItemId: string, facts: ExperienceFacts): `exp_${string}` {
  return `exp_${sha256Utf8(canonicalJson({ workItemId, facts }))}`
}

export function deriveLearningProposalId(
  workItemId: string,
  facts: ProposalFacts,
): `lp_${string}` {
  return `lp_${sha256Utf8(canonicalJson({ workItemId, facts }))}`
}

export interface LearningHostFacts {
  readonly workItemId: string
  readonly catalogObservationDigest: string
  readonly shortlistDigests: readonly string[]
}

/** Add deterministic identities and observation facts that the model is not trusted to supply. */
export function materializeModelLearningOutput(
  output: ModelLearningOutputV1,
  host: LearningHostFacts,
): { experiences: ExperienceRecordV1[]; proposal: LearningProposalV1 } {
  const experiences = output.experiences.map((facts) => ExperienceRecordV1Schema.parse({
    experienceId: deriveExperienceId(host.workItemId, facts),
    ...facts,
  }))
  const proposalFacts: Omit<LearningProposalV1, 'learningProposalId'> = {
    ...output.proposal,
    supportingExperienceIds: experiences.map(experience => experience.experienceId),
    catalogObservationDigest: host.catalogObservationDigest,
    shortlistDigests: [...host.shortlistDigests],
  }
  const proposal = LearningProposalV1Schema.parse({
    learningProposalId: deriveLearningProposalId(host.workItemId, proposalFacts),
    ...proposalFacts,
  })
  return { experiences, proposal }
}
