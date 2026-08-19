import { sha256Utf8 } from '../observe/hashing.js'
import type { ExperienceRecordV1, LearningProposalV1 } from './schemas.js'

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
