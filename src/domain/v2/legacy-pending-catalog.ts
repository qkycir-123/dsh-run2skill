import { z } from 'zod'
import { canonicalJson } from '../learn/identity.js'
import { sha256Utf8 } from '../observe/hashing.js'
import { LegacyItemV2Schema, type LegacyItemV2 } from './schemas.js'

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/)

export const LegacyPendingCatalogEntryV2Schema = z.object({
  candidateKey: z.string().regex(/^legacy_[a-f0-9]{64}$/),
  sourceWorkItemId: z.string().regex(/^wi_[a-f0-9]{64}$/),
  persistenceScope: z.enum(['PROJECT', 'USER']),
  name: z.string().min(1).max(128),
  description: z.string().min(1).max(2048),
  whenToUse: z.string().min(1).max(4096),
  exactSkillBytes: z.string().min(1).max(64 * 1024),
  bodyDigest: sha256Hex,
  sourceProposalId: z.string().min(1).max(256),
  sourceProposalDigest: sha256Hex.optional(),
  capability: z.literal('FULL_BODY'),
}).strict().superRefine((value, context) => {
  if (value.bodyDigest !== sha256Utf8(value.exactSkillBytes)) {
    context.addIssue({ code: 'custom', path: ['bodyDigest'], message: 'Legacy candidate body digest does not match bytes' })
  }
})

export type LegacyPendingCatalogEntryV2 = z.infer<typeof LegacyPendingCatalogEntryV2Schema>

export interface LegacyPendingProposalCatalogV2 {
  readonly complete: boolean
  readonly entries: readonly LegacyPendingCatalogEntryV2[]
  readonly digest: string
}

function activeCandidate(item: LegacyItemV2): LegacyPendingCatalogEntryV2 | undefined {
  if (item.disposition !== 'ACTIVE_LEGACY_PROPOSAL' && item.disposition !== 'ACTIVE_LEGACY_PUBLICATION') return undefined
  const reviewProposal = item.sourceWorkItem.review?.proposal
  const learningProposal = item.sourceWorkItem.learning?.proposal
  const proposal = reviewProposal ?? learningProposal
  if (proposal === undefined) return undefined
  const exactSkillBytes = reviewProposal?.exactSkillBytes ?? learningProposal?.content
  if (exactSkillBytes === undefined) return undefined
  return LegacyPendingCatalogEntryV2Schema.parse({
    candidateKey: item.legacyItemId,
    sourceWorkItemId: item.sourceWorkItemId,
    persistenceScope: proposal.persistenceScope,
    name: proposal.name,
    description: proposal.description,
    whenToUse: proposal.whenToUse,
    exactSkillBytes,
    bodyDigest: sha256Utf8(exactSkillBytes),
    sourceProposalId: reviewProposal?.proposalId ?? learningProposal!.learningProposalId,
    ...(reviewProposal === undefined ? {} : { sourceProposalDigest: reviewProposal.digest }),
    capability: 'FULL_BODY',
  })
}

export function deriveLegacyPendingProposalCatalogV2(
  rawItems: Iterable<LegacyItemV2>,
): LegacyPendingProposalCatalogV2 {
  const entries: LegacyPendingCatalogEntryV2[] = []
  let activeCount = 0
  try {
    for (const raw of rawItems) {
      const item = LegacyItemV2Schema.parse(raw)
      if (item.disposition !== 'ACTIVE_LEGACY_PROPOSAL' && item.disposition !== 'ACTIVE_LEGACY_PUBLICATION') continue
      activeCount += 1
      const entry = activeCandidate(item)
      if (entry === undefined) return { complete: false, entries: [], digest: sha256Utf8(canonicalJson([])) }
      entries.push(entry)
    }
  } catch {
    return { complete: false, entries: [], digest: sha256Utf8(canonicalJson([])) }
  }
  entries.sort((left, right) => left.candidateKey.localeCompare(right.candidateKey))
  const complete = entries.length === activeCount && new Set(entries.map(entry => entry.candidateKey)).size === entries.length
  return { complete, entries, digest: sha256Utf8(canonicalJson(entries)) }
}
