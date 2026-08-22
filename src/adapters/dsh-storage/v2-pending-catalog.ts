import { z } from 'zod'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import { deriveProjectScopeIdentityDigest } from '../../domain/purge/index.js'
import {
  ExperienceIntentV2Schema,
  GlobalV2Schema,
  LegacyItemV2Schema,
  ProposalLineageV2Schema,
  TurnObservationV2Schema,
  deriveLegacyPendingProposalCatalogV2,
  type ExperienceIntentV2,
} from '../../domain/v2/index.js'
import type { Run2skillV2Domain } from './v2-types.js'

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/)
const candidateKey = z.string().min(1).max(256)
const utf8Limited = (maxBytes: number) => z.string().refine(
  value => Buffer.byteLength(value, 'utf8') <= maxBytes,
  `Expected at most ${maxBytes} UTF-8 bytes`,
)

export const PendingProposalCatalogEntryV2Schema = z.object({
  candidateKey,
  source: z.enum(['active-proposal', 'sealed-generation-result', 'generation-barrier', 'legacy-proposal']),
  persistenceScope: z.enum(['PROJECT', 'USER']),
  scopeIdentityDigest: sha256Hex,
  name: z.string().min(1).max(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: utf8Limited(2 * 1024),
  whenToUse: utf8Limited(4 * 1024).optional(),
  capability: z.enum(['FULL_BODY', 'SUMMARY_ONLY']),
  exactSkillBytes: utf8Limited(64 * 1024).optional(),
  bodyDigest: sha256Hex.optional(),
  generationResultReceiptDigest: sha256Hex.optional(),
}).strict().superRefine((value, context) => {
  const fullBody = value.capability === 'FULL_BODY'
  if (fullBody !== (value.exactSkillBytes !== undefined && value.bodyDigest !== undefined)) {
    context.addIssue({ code: 'custom', path: ['capability'], message: 'Pending candidate capability does not match its body' })
  }
  if (value.exactSkillBytes !== undefined && value.bodyDigest !== sha256Utf8(value.exactSkillBytes)) {
    context.addIssue({ code: 'custom', path: ['bodyDigest'], message: 'Pending candidate body digest does not match bytes' })
  }
})

export type PendingProposalCatalogEntryV2 = z.infer<typeof PendingProposalCatalogEntryV2Schema>

export interface PendingProposalCatalogV2 {
  readonly complete: boolean
  readonly entries: readonly PendingProposalCatalogEntryV2[]
  readonly digest: string
  readonly catalogEpoch: number
  readonly catalogMutationReceiptDigest: string
}

const EMPTY_DIGEST = sha256Utf8(canonicalJson([]))
const USER_SCOPE_IDENTITY = sha256Utf8(canonicalJson({ domain: 'run2skill_v2', scope: 'USER' }))

function incomplete(global: ReturnType<typeof GlobalV2Schema.parse> | undefined): PendingProposalCatalogV2 {
  return {
    complete: false,
    entries: [],
    digest: EMPTY_DIGEST,
    catalogEpoch: global?.proposalCatalogEpoch ?? 0,
    catalogMutationReceiptDigest: global?.proposalCatalogLastMutation.digest ?? sha256Utf8('CATALOG_UNAVAILABLE'),
  }
}

function projectScopeIdentity(
  domain: Run2skillV2Domain,
  intent: ExperienceIntentV2,
): { readonly complete: boolean; readonly digest?: string } {
  const projectDigests = new Set<string>()
  let userBindingSeen = false
  for (const ref of intent.evidenceRefs) {
    const parsed = TurnObservationV2Schema.safeParse(domain.table('turn_observations').get(ref.observationId))
    if (
      !parsed.success
      || parsed.data.sessionLifecycleKey !== intent.sessionLifecycleKey
      || parsed.data.turnEndSeq !== ref.turnEndSeq
      || parsed.data.evidenceDigest !== ref.evidenceDigest
      || parsed.data.scopeBinding.status === 'UNRESOLVED'
    ) return { complete: false }
    if (parsed.data.scopeBinding.status === 'PROJECT') projectDigests.add(parsed.data.scopeBinding.scopeIdentityDigest)
    else userBindingSeen = true
  }
  if (projectDigests.size > 1 || (projectDigests.size > 0 && userBindingSeen)) return { complete: false }
  const digest = [...projectDigests][0]
  if (intent.persistenceScope === 'PROJECT' && digest === undefined) return { complete: false }
  return { complete: true, ...(digest === undefined ? {} : { digest }) }
}

function visible(
  scope: 'PROJECT' | 'USER',
  scopeIdentityDigest: string,
  currentProjectScopeIdentityDigest: string | undefined,
): boolean {
  return scope === 'USER' || scopeIdentityDigest === currentProjectScopeIdentityDigest
}

function barrierName(behaviorSignature: string): string {
  return `unresolved-${behaviorSignature.slice(0, 24)}`
}

function bodyEntry(input: Omit<PendingProposalCatalogEntryV2, 'capability' | 'bodyDigest'> & {
  readonly exactSkillBytes: string
}): PendingProposalCatalogEntryV2 {
  return PendingProposalCatalogEntryV2Schema.parse({
    ...input,
    capability: 'FULL_BODY',
    bodyDigest: sha256Utf8(input.exactSkillBytes),
  })
}

export function derivePendingProposalCatalogV2(
  domain: Run2skillV2Domain,
  rawIntent: ExperienceIntentV2,
): PendingProposalCatalogV2 {
  const before = GlobalV2Schema.safeParse(domain.global.get())
  if (
    !before.success
    || before.data.migration.phase !== 'COMMITTED'
    || before.data.activation === undefined
    || before.data.proposalCatalogMutationJournal !== undefined
    || before.data.purgeJournal !== undefined
  ) return incomplete(before.success ? before.data : undefined)
  const intent = ExperienceIntentV2Schema.safeParse(rawIntent)
  if (!intent.success) return incomplete(before.data)
  const currentScope = projectScopeIdentity(domain, intent.data)
  if (!currentScope.complete) return incomplete(before.data)

  const entries: PendingProposalCatalogEntryV2[] = []
  const consumedResults = new Map<string, string>()
  try {
    const lineages = [...domain.table('proposal_lineages').entries()]
      .map(([id, value]) => [id, ProposalLineageV2Schema.parse(value)] as const)
    const intents = new Map([...domain.table('experience_intents').entries()]
      .map(([id, value]) => [id, ExperienceIntentV2Schema.parse(value)] as const))

    for (const [, lineage] of lineages) {
      if (lineage.origin !== 'RUN2SKILL_V2') continue
      for (const revision of lineage.proposalRevisions) {
        const prior = consumedResults.get(revision.generationResultReceiptDigest)
        if (prior !== undefined) return incomplete(before.data)
        consumedResults.set(revision.generationResultReceiptDigest, revision.proposalId)
      }
      if (lineage.state !== 'ACTIVE_PROPOSAL') continue
      const latest = lineage.proposalRevisions.at(-1)
      const owner = intents.get(lineage.ownerIntentId)
      if (latest === undefined || owner === undefined) return incomplete(before.data)
      const ownerScope = projectScopeIdentity(domain, owner)
      if (!ownerScope.complete) return incomplete(before.data)
      const scopeIdentityDigest = lineage.persistenceScope === 'USER'
        ? USER_SCOPE_IDENTITY
        : ownerScope.digest
      if (scopeIdentityDigest === undefined) return incomplete(before.data)
      if (!visible(lineage.persistenceScope, scopeIdentityDigest, currentScope.digest)) continue
      entries.push(bodyEntry({
        candidateKey: latest.proposalId,
        source: 'active-proposal',
        persistenceScope: lineage.persistenceScope,
        scopeIdentityDigest,
        name: latest.body.name,
        description: latest.body.description,
        whenToUse: latest.body.whenToUse,
        exactSkillBytes: latest.body.exactSkillBytes,
        generationResultReceiptDigest: latest.generationResultReceiptDigest,
      }))
    }

    for (const [, candidateIntent] of intents) {
      const result = candidateIntent.generation.sealedResult
      const barrier = candidateIntent.duplicateBarrier
      if ((result === undefined || consumedResults.has(result.receiptDigest)) && barrier === undefined) continue
      const ownerScope = projectScopeIdentity(domain, candidateIntent)
      if (!ownerScope.complete) return incomplete(before.data)
      const scopeIdentityDigest = candidateIntent.persistenceScope === 'USER'
        ? USER_SCOPE_IDENTITY
        : ownerScope.digest
      if (scopeIdentityDigest === undefined) return incomplete(before.data)
      if (!visible(candidateIntent.persistenceScope, scopeIdentityDigest, currentScope.digest)) continue

      if (result !== undefined && !consumedResults.has(result.receiptDigest)) {
        entries.push(bodyEntry({
          candidateKey: result.resultId,
          source: 'sealed-generation-result',
          persistenceScope: candidateIntent.persistenceScope,
          scopeIdentityDigest,
          name: result.body.name,
          description: result.body.description,
          whenToUse: result.body.whenToUse,
          exactSkillBytes: result.body.exactSkillBytes,
          generationResultReceiptDigest: result.receiptDigest,
        }))
      }
      if (barrier !== undefined) entries.push(PendingProposalCatalogEntryV2Schema.parse({
        candidateKey: barrier.barrierId,
        source: 'generation-barrier',
        persistenceScope: candidateIntent.persistenceScope,
        scopeIdentityDigest,
        name: barrierName(candidateIntent.behaviorSignature),
        description: candidateIntent.applicabilitySummary,
        whenToUse: candidateIntent.keySteps.join('; '),
        capability: 'SUMMARY_ONLY',
      }))
    }

    const legacyItems = [...domain.table('legacy_items').entries()]
      .map(([, value]) => LegacyItemV2Schema.parse(value))
    const legacy = deriveLegacyPendingProposalCatalogV2(legacyItems)
    if (!legacy.complete) return incomplete(before.data)
    const legacyById = new Map(legacyItems.map(item => [item.legacyItemId, item]))
    for (const entry of legacy.entries) {
      const item = legacyById.get(entry.candidateKey)
      if (item === undefined) return incomplete(before.data)
      const scopeIdentityDigest = entry.persistenceScope === 'USER'
        ? USER_SCOPE_IDENTITY
        : item.sourceWorkItem.workspaceBinding.status === 'BOUND'
          ? deriveProjectScopeIdentityDigest(item.sourceWorkItem.workspaceBinding.canonicalPath)
          : undefined
      if (scopeIdentityDigest === undefined) return incomplete(before.data)
      if (!visible(entry.persistenceScope, scopeIdentityDigest, currentScope.digest)) continue
      entries.push(bodyEntry({
        candidateKey: entry.candidateKey,
        source: 'legacy-proposal',
        persistenceScope: entry.persistenceScope,
        scopeIdentityDigest,
        name: entry.name,
        description: entry.description,
        whenToUse: entry.whenToUse,
        exactSkillBytes: entry.exactSkillBytes,
      }))
    }
  } catch {
    return incomplete(before.data)
  }

  entries.sort((left, right) => left.candidateKey.localeCompare(right.candidateKey))
  if (new Set(entries.map(entry => entry.candidateKey)).size !== entries.length) return incomplete(before.data)
  const after = GlobalV2Schema.safeParse(domain.global.get())
  if (
    !after.success
    || after.data.proposalCatalogMutationJournal !== undefined
    || after.data.purgeJournal !== undefined
    || after.data.proposalCatalogEpoch !== before.data.proposalCatalogEpoch
    || canonicalJson(after.data.proposalCatalogLastMutation) !== canonicalJson(before.data.proposalCatalogLastMutation)
  ) return incomplete(after.success ? after.data : before.data)
  return {
    complete: true,
    entries,
    digest: sha256Utf8(canonicalJson(entries)),
    catalogEpoch: after.data.proposalCatalogEpoch,
    catalogMutationReceiptDigest: after.data.proposalCatalogLastMutation.digest,
  }
}
