import { z } from 'zod'
import { Run2skillV2GlobalStore } from '../../adapters/dsh-storage/v2-global-store.js'
import type { Run2skillV2Domain } from '../../adapters/dsh-storage/v2-types.js'
import type { Run2skillTable } from '../../adapters/dsh-storage/types.js'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import { preprocessPersistentText } from '../../domain/observe/redaction.js'
import {
  ExperienceIntentV2Schema,
  ProposalLineageV2Schema,
  SessionBatchV2Schema,
  deriveProposalCatalogMutationAnchorV2,
  deriveProposalCatalogMutationIdV2,
  deriveProposalRevisionCallIdV2,
  deriveProposalRevisionGenerationReceiptDigestV2,
  deriveProposalRevisionMutationOwnerIdV2,
  type ExperienceIntentV2,
  type ProposalLineageV2,
  type SessionBatchV2,
} from '../../domain/v2/index.js'
import { renderCanonicalSkill } from '../curation/skill-renderer.js'
import {
  deriveV2ProposalRef,
  type V2ProposalRef,
  type V2ProposalReviewRevalidation,
  type V2ProposalReviewRevalidationPort,
} from './v2-proposal-review.js'

type NativeLineage = Extract<ProposalLineageV2, { readonly origin: 'RUN2SKILL_V2' }>
type NativeProposal = NativeLineage['proposalRevisions'][number]
type RevisionAction = NativeLineage['revisionActions'][number]

const utf8Limited = (maxBytes: number) => z.string().refine(
  value => Buffer.byteLength(value, 'utf8') <= maxBytes,
  `Expected at most ${maxBytes} UTF-8 bytes`,
)
const revisionOutputSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: utf8Limited(2 * 1024).refine(value => value.trim().length > 0),
  whenToUse: utf8Limited(4 * 1024).refine(value => value.trim().length > 0),
  content: utf8Limited(60 * 1024).refine(value => /^#{1,6}\s+\S/mu.test(value)),
}).strict()

export interface ProposalRevisionGenerator {
  generate(input: {
    readonly action: 'CREATE' | 'MERGE'
    readonly intent: Pick<ExperienceIntentV2, 'intentId' | 'persistenceScope' | 'experienceType' | 'applicabilitySummary' | 'keySteps' | 'prohibitions'>
    readonly parent: NativeProposal['body']
    readonly feedback: string
    readonly inputDigest: string
    readonly route: SessionBatchV2['routeSnapshot']
  }): Promise<unknown>
}

export interface V2ProposalRevisionRequest {
  readonly lineageId: string
  readonly expectedLineageRevision: number
  readonly proposalRef: V2ProposalRef
  readonly actionId: string
  readonly feedback: string
}

export interface V2ProposalRevisionResult {
  readonly changed: boolean
  readonly lineage: NativeLineage
  readonly proposalRef: V2ProposalRef
}

export class V2ProposalRevisionError extends Error {
  constructor(readonly code:
    | 'REVISION_LINEAGE_NOT_FOUND'
    | 'REVISION_REVISION_CONFLICT'
    | 'STALE_PROPOSAL_REF'
    | 'INVALID_REVISION_STATE'
    | 'REVISION_INPUT_INVALID'
    | 'REVISION_INPUT_UNAVAILABLE'
    | 'REVISION_BUSY'
    | 'REVISION_CATALOG_CHANGED'
    | 'REVISION_CATALOG_UNAVAILABLE'
    | 'REVISION_MODEL_FAILED'
    | 'REVISION_OUTPUT_INVALID'
    | 'REVISION_RECOVERY_CONFLICT',
  ) {
    super(code)
    this.name = 'V2ProposalRevisionError'
  }
}

function sameRef(left: V2ProposalRef, right: V2ProposalRef): boolean {
  return left.proposalId === right.proposalId
    && left.revision === right.revision
    && left.digest === right.digest
}

function hasFormatControls(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0)!
    if (
      /\p{Cf}/u.test(character)
      || point <= 8
      || point === 11
      || point === 12
      || (point >= 14 && point <= 31)
      || (point >= 127 && point <= 159)
    ) return true
  }
  return false
}

function boundedSummary(value: string): string {
  let summary = value
  while (Buffer.byteLength(summary, 'utf8') > 512) summary = summary.slice(0, -1)
  return summary
}

function normalizedFeedback(value: string): string {
  if (typeof value !== 'string') throw new V2ProposalRevisionError('REVISION_INPUT_INVALID')
  const normalized = value.normalize('NFKC').trim()
  if (normalized.length === 0 || Buffer.byteLength(normalized, 'utf8') > 2_048) {
    throw new V2ProposalRevisionError('REVISION_INPUT_INVALID')
  }
  const filtered = preprocessPersistentText(normalized).text.trim()
  if (filtered.length === 0) throw new V2ProposalRevisionError('REVISION_INPUT_INVALID')
  return filtered
}

function safeOutput(raw: unknown, expectedName: string): {
  readonly name: string
  readonly description: string
  readonly whenToUse: string
  readonly exactSkillBytes: string
  readonly skillBytesDigest: string
} {
  const parsed = revisionOutputSchema.safeParse(raw)
  if (!parsed.success || parsed.data.name !== expectedName) {
    throw new V2ProposalRevisionError('REVISION_OUTPUT_INVALID')
  }
  const fields = [parsed.data.description, parsed.data.whenToUse, parsed.data.content]
  if (fields.some(value => {
    const processed = preprocessPersistentText(value)
    return processed.redactionKinds.length > 0
      || processed.text !== value.normalize('NFKC')
      || hasFormatControls(value)
  })) throw new V2ProposalRevisionError('REVISION_OUTPUT_INVALID')
  const exactSkillBytes = renderCanonicalSkill({
    ...parsed.data,
    invocation: { modelInvocable: true, userInvocable: false },
  })
  if (Buffer.byteLength(exactSkillBytes, 'utf8') > 64 * 1024 || hasFormatControls(exactSkillBytes)) {
    throw new V2ProposalRevisionError('REVISION_OUTPUT_INVALID')
  }
  return {
    name: parsed.data.name,
    description: parsed.data.description,
    whenToUse: parsed.data.whenToUse,
    exactSkillBytes,
    skillBytesDigest: sha256Utf8(exactSkillBytes),
  }
}

function revisionFailure(error: unknown): RevisionAction['failureCode'] {
  if (error instanceof V2ProposalRevisionError) {
    if (error.code === 'REVISION_OUTPUT_INVALID') return 'REVISION_OUTPUT_INVALID'
    if (error.code === 'REVISION_CATALOG_CHANGED') return 'REVISION_CATALOG_CHANGED'
    if (error.code === 'REVISION_CATALOG_UNAVAILABLE') return 'REVISION_CATALOG_UNAVAILABLE'
  }
  return 'REVISION_MODEL_FAILED'
}

/**
 * Turns one bounded, untrusted user comment into a Host-owned immutable Proposal
 * revision. The browser never supplies Skill bytes or a publication grant.
 */
export class V2ProposalRevisionCoordinator {
  readonly #global: Run2skillV2GlobalStore
  readonly #lineages: Run2skillTable<string, ProposalLineageV2>
  readonly #intents: Run2skillTable<string, ExperienceIntentV2>
  readonly #batches: Run2skillTable<string, SessionBatchV2>
  readonly #now: () => string
  #tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly domain: Run2skillV2Domain,
    private readonly options: V2ProposalReviewRevalidationPort & ProposalRevisionGenerator & {
      readonly now?: () => string
    },
  ) {
    this.#global = Run2skillV2GlobalStore.for(domain)
    this.#lineages = domain.table('proposal_lineages')
    this.#intents = domain.table('experience_intents')
    this.#batches = domain.table('session_batches')
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  revise(request: V2ProposalRevisionRequest): Promise<V2ProposalRevisionResult> {
    return this.#serialize(async () => {
      const feedback = normalizedFeedback(request.feedback)
      if (!/^rev_[a-f0-9]{64}$/.test(request.actionId)) {
        throw new V2ProposalRevisionError('REVISION_INPUT_INVALID')
      }
      const parsed = ProposalLineageV2Schema.safeParse(this.#lineages.get(request.lineageId))
      if (!parsed.success || parsed.data.origin !== 'RUN2SKILL_V2') {
        throw new V2ProposalRevisionError('REVISION_LINEAGE_NOT_FOUND')
      }
      const duplicate = parsed.data.revisionActions.find(action => action.actionId === request.actionId)
      if (duplicate !== undefined) {
        if (
          duplicate.parentProposalId !== request.proposalRef.proposalId
          || duplicate.parentProposalRevision !== request.proposalRef.revision
          || duplicate.parentProposalDigest !== request.proposalRef.digest
          || duplicate.feedbackDigest !== sha256Utf8(feedback)
        ) throw new V2ProposalRevisionError('REVISION_INPUT_INVALID')
        return this.#duplicateResult(parsed.data, duplicate)
      }
      const lineage = this.#matchingLineage(parsed.data, request)
      const parent = lineage.proposalRevisions.at(-1)!
      const { intent, batch } = this.#inputs(lineage)
      const before = await this.#revalidate(lineage, parent, request.proposalRef, intent, batch)
      if (before.status !== 'CURRENT') {
        throw new V2ProposalRevisionError(before.status === 'STALE'
          ? 'REVISION_CATALOG_CHANGED'
          : 'REVISION_CATALOG_UNAVAILABLE')
      }
      const feedbackDigest = sha256Utf8(feedback)
      const inputDigest = sha256Utf8(canonicalJson({
        contract: 'run2skill-v2-proposal-revision-input-v1',
        lineageId: lineage.lineageId,
        proposalRef: request.proposalRef,
        action: parent.action,
        parentBodyDigest: parent.body.skillBytesDigest,
        feedbackDigest,
        route: batch.routeSnapshot,
      }))
      const callId = deriveProposalRevisionCallIdV2(request.actionId, inputDigest)
      const createdAt = this.#now()
      const reservedAction: RevisionAction = {
        actionId: request.actionId,
        parentProposalId: request.proposalRef.proposalId,
        parentProposalRevision: request.proposalRef.revision,
        parentProposalDigest: request.proposalRef.digest,
        feedbackDigest,
        feedbackSummary: boundedSummary(feedback),
        inputDigest,
        callId,
        state: 'CALL_RESERVED',
        createdAt,
      }
      const reserved = await this.#updateLineage(lineage.lineageId, lineage.revision, current => ({
        ...current,
        revision: current.revision + 1,
        updatedAt: createdAt,
        revisionActions: [...current.revisionActions, reservedAction],
      }))

      try {
        const raw = await this.options.generate({
          action: parent.action,
          intent: {
            intentId: intent.intentId,
            persistenceScope: intent.persistenceScope,
            experienceType: intent.experienceType,
            applicabilitySummary: intent.applicabilitySummary,
            keySteps: intent.keySteps,
            prohibitions: intent.prohibitions,
          },
          parent: parent.body,
          feedback,
          inputDigest,
          route: batch.routeSnapshot,
        })
        const body = safeOutput(raw, parent.body.name)
        const current = ProposalLineageV2Schema.parse(this.#lineages.get(lineage.lineageId))
        if (current.origin !== 'RUN2SKILL_V2') throw new V2ProposalRevisionError('REVISION_LINEAGE_NOT_FOUND')
        const currentParent = current.proposalRevisions.at(-1)!
        if (!sameRef(deriveV2ProposalRef(current), request.proposalRef)) {
          throw new V2ProposalRevisionError('STALE_PROPOSAL_REF')
        }
        const after = await this.#revalidate(current, currentParent, request.proposalRef, intent, batch)
        if (after.status !== 'CURRENT') {
          throw new V2ProposalRevisionError(after.status === 'STALE'
            ? 'REVISION_CATALOG_CHANGED'
            : 'REVISION_CATALOG_UNAVAILABLE')
        }
        if (
          after.catalogEpoch !== before.catalogEpoch
          || after.catalogMutationReceiptDigest !== before.catalogMutationReceiptDigest
          || after.runtimeCatalogDigest !== before.runtimeCatalogDigest
        ) throw new V2ProposalRevisionError('REVISION_CATALOG_CHANGED')

        const mutationOwnerId = deriveProposalRevisionMutationOwnerIdV2(lineage.lineageId, request.actionId)
        const anchor = await this.#prepareMutation(mutationOwnerId, after)
        const proposalRevision = parent.revision + 1
        const generationResultReceiptDigest = deriveProposalRevisionGenerationReceiptDigestV2({
          actionId: request.actionId,
          callId,
          inputDigest,
          skillBytesDigest: body.skillBytesDigest,
        })
        const proposalId = `prop_${sha256Utf8(canonicalJson({
          lineageId: lineage.lineageId,
          parentProposalId: parent.proposalId,
          proposalRevision,
          actionId: request.actionId,
          generationResultReceiptDigest,
        }))}`
        const revisionSource = {
          kind: 'USER_FEEDBACK' as const,
          actionId: request.actionId,
          parentProposalId: request.proposalRef.proposalId,
          parentProposalRevision: request.proposalRef.revision,
          parentProposalDigest: request.proposalRef.digest,
          feedbackDigest,
          feedbackSummary: boundedSummary(feedback),
        }
        const proposal: NativeProposal = {
          revision: proposalRevision,
          proposalId,
          ownerIntentId: current.ownerIntentId,
          ownerIntentRevision: current.ownerIntentRevision,
          action: parent.action,
          body,
          runtimeCatalogDigest: after.runtimeCatalogDigest,
          pendingCatalogDigest: after.pendingCatalogDigest,
          generationResultReceiptDigest,
          catalogMutationReceiptDigest: anchor.digest,
          catalogEpoch: anchor.epoch,
          ...(parent.targetIdentityDigest === undefined ? {} : { targetIdentityDigest: parent.targetIdentityDigest }),
          ...(parent.baseSkillBytes === undefined ? {} : { baseSkillBytes: parent.baseSkillBytes }),
          ...(parent.baseSkillBytesDigest === undefined ? {} : { baseSkillBytesDigest: parent.baseSkillBytesDigest }),
          ...(parent.projectScopeBinding === undefined ? {} : { projectScopeBinding: parent.projectScopeBinding }),
          state: 'ACTIVE_PROPOSAL',
          revisionSource,
          createdAt: this.#now(),
        }
        const provisional = {
          ...current,
          revision: current.revision + 1,
          currentProposalRevision: proposalRevision,
          proposalRevisions: [
            ...current.proposalRevisions.slice(0, -1),
            { ...parent, state: 'SUPERSEDED' as const },
            proposal,
          ],
          updatedAt: proposal.createdAt,
        }
        const proposalRef = deriveV2ProposalRef(provisional)
        const completedAt = this.#now()
        const updated = await this.#updateLineage(current.lineageId, current.revision, value => ({
          ...provisional,
          revisionActions: value.revisionActions.map(action => action.actionId === request.actionId
            ? { ...action, state: 'SUCCEEDED' as const, resultProposalRef: proposalRef, completedAt }
            : action),
        }))
        await this.#finalizeMutation(mutationOwnerId)
        return { changed: true, lineage: updated, proposalRef }
      } catch (caught) {
        await this.#recoverMutationJournal().catch(() => undefined)
        const failureCode = revisionFailure(caught)
        await this.#markFailed(reserved.lineageId, request.actionId, failureCode).catch(() => undefined)
        throw caught instanceof V2ProposalRevisionError
          ? caught
          : new V2ProposalRevisionError('REVISION_MODEL_FAILED')
      }
    })
  }

  recover(): Promise<'IDLE' | 'RECOVERED'> {
    return this.#serialize(async () => {
      let changed = await this.#recoverMutationJournal()
      for (const [, raw] of this.#lineages.entries()) {
        const parsed = ProposalLineageV2Schema.safeParse(raw)
        if (!parsed.success || parsed.data.origin !== 'RUN2SKILL_V2') continue
        if (!parsed.data.revisionActions.some(action => action.state === 'CALL_RESERVED')) continue
        const completedAt = this.#now()
        await this.#updateLineage(parsed.data.lineageId, parsed.data.revision, current => ({
          ...current,
          revision: current.revision + 1,
          updatedAt: completedAt,
          revisionActions: current.revisionActions.map(action => action.state === 'CALL_RESERVED'
            ? {
                ...action,
                state: 'OUTCOME_UNKNOWN' as const,
                failureCode: 'REVISION_OUTCOME_UNKNOWN' as const,
                completedAt,
              }
            : action),
        }))
        changed = true
      }
      return changed ? 'RECOVERED' : 'IDLE'
    })
  }

  #matchingLineage(lineage: NativeLineage, request: V2ProposalRevisionRequest): NativeLineage {
    if (!sameRef(deriveV2ProposalRef(lineage), request.proposalRef)) {
      throw new V2ProposalRevisionError('STALE_PROPOSAL_REF')
    }
    if (lineage.revision !== request.expectedLineageRevision) {
      throw new V2ProposalRevisionError('REVISION_REVISION_CONFLICT')
    }
    const proposal = lineage.proposalRevisions.at(-1)
    if (
      lineage.state !== 'ACTIVE_PROPOSAL'
      || proposal === undefined
      || proposal.state !== 'ACTIVE_PROPOSAL'
      || proposal.publicationReceiptDigest !== undefined
      || lineage.revisionActions.some(action => action.state === 'CALL_RESERVED')
      || lineage.proposalRevisions.length >= 64
      || lineage.revisionActions.length >= 64
    ) throw new V2ProposalRevisionError('INVALID_REVISION_STATE')
    return lineage
  }

  #inputs(lineage: NativeLineage): { readonly intent: ExperienceIntentV2; readonly batch: SessionBatchV2 } {
    const intent = ExperienceIntentV2Schema.safeParse(this.#intents.get(lineage.ownerIntentId))
    const batch = intent.success
      ? SessionBatchV2Schema.safeParse(this.#batches.get(intent.data.batchId))
      : undefined
    if (
      !intent?.success
      || !batch?.success
      || intent.data.lineageId !== lineage.lineageId
      || intent.data.status !== 'PROPOSAL_READY'
      || !['CREATE', 'MERGE'].includes(intent.data.coverage.state)
    ) throw new V2ProposalRevisionError('REVISION_INPUT_UNAVAILABLE')
    return { intent: intent.data, batch: batch.data }
  }

  async #revalidate(
    lineage: NativeLineage,
    proposal: NativeProposal,
    proposalRef: V2ProposalRef,
    intent: ExperienceIntentV2,
    batch: SessionBatchV2,
  ): Promise<V2ProposalReviewRevalidation> {
    try {
      return await this.options.revalidate({ lineage, proposal, proposalRef, intent, batch })
    } catch {
      return { status: 'UNAVAILABLE' }
    }
  }

  #duplicateResult(lineage: NativeLineage, action: RevisionAction): V2ProposalRevisionResult {
    if (action.state === 'SUCCEEDED' && action.resultProposalRef !== undefined) {
      if (!sameRef(action.resultProposalRef, deriveV2ProposalRef(lineage))) {
        throw new V2ProposalRevisionError('STALE_PROPOSAL_REF')
      }
      return { changed: false, lineage, proposalRef: action.resultProposalRef }
    }
    if (action.state === 'CALL_RESERVED') throw new V2ProposalRevisionError('REVISION_BUSY')
    throw new V2ProposalRevisionError(action.failureCode === 'REVISION_CATALOG_CHANGED'
      ? 'REVISION_CATALOG_CHANGED'
      : action.failureCode === 'REVISION_CATALOG_UNAVAILABLE'
        ? 'REVISION_CATALOG_UNAVAILABLE'
        : action.failureCode === 'REVISION_OUTPUT_INVALID'
          ? 'REVISION_OUTPUT_INVALID'
          : 'REVISION_MODEL_FAILED')
  }

  async #prepareMutation(
    mutationOwnerId: string,
    snapshot: Extract<V2ProposalReviewRevalidation, { readonly status: 'CURRENT' }>,
  ) {
    return await this.#global.runExclusive(async current => {
      if (
        current.migration.phase !== 'COMMITTED'
        || current.activation === undefined
        || current.proposalGenerationLease !== undefined
        || current.proposalCatalogMutationJournal !== undefined
        || current.purgeJournal !== undefined
      ) throw new V2ProposalRevisionError('REVISION_BUSY')
      if (
        current.proposalCatalogEpoch !== snapshot.catalogEpoch
        || current.proposalCatalogLastMutation.digest !== snapshot.catalogMutationReceiptDigest
      ) throw new V2ProposalRevisionError('REVISION_CATALOG_CHANGED')
      const mutationId = deriveProposalCatalogMutationIdV2({
        ownerId: mutationOwnerId,
        kind: 'USER_ACTION',
        inputCatalogEpoch: current.proposalCatalogEpoch,
      })
      const anchor = deriveProposalCatalogMutationAnchorV2({
        ownerId: mutationOwnerId,
        kind: 'USER_ACTION',
        inputCatalogEpoch: current.proposalCatalogEpoch,
      })
      return {
        value: anchor,
        global: {
          ...current,
          proposalCatalogMutationJournal: {
            schemaVersion: 1,
            mutationId,
            ownerId: mutationOwnerId,
            kind: 'USER_ACTION',
            phase: 'PREPARED',
            preparedAt: this.#now(),
          },
        },
      }
    })
  }

  async #finalizeMutation(mutationOwnerId: string): Promise<void> {
    await this.#global.runExclusive(async current => {
      const journal = current.proposalCatalogMutationJournal
      const expectedId = deriveProposalCatalogMutationIdV2({
        ownerId: mutationOwnerId,
        kind: 'USER_ACTION',
        inputCatalogEpoch: current.proposalCatalogEpoch,
      })
      if (journal?.kind !== 'USER_ACTION' || journal.ownerId !== mutationOwnerId || journal.mutationId !== expectedId) {
        throw new V2ProposalRevisionError('REVISION_RECOVERY_CONFLICT')
      }
      const { proposalCatalogMutationJournal: _journal, ...rest } = current
      return {
        value: undefined,
        global: {
          ...rest,
          proposalCatalogEpoch: current.proposalCatalogEpoch + 1,
          proposalCatalogLastMutation: deriveProposalCatalogMutationAnchorV2({
            ownerId: mutationOwnerId,
            kind: 'USER_ACTION',
            inputCatalogEpoch: current.proposalCatalogEpoch,
          }),
        },
      }
    })
  }

  async #recoverMutationJournal(): Promise<boolean> {
    const global = this.#global.get()
    const journal = global.proposalCatalogMutationJournal
    if (journal?.kind !== 'USER_ACTION') return false
    const legacyUnbound = /^rev_[a-f0-9]{64}$/.test(journal.ownerId)
    const lineageBound = /^revop_[a-f0-9]{64}$/.test(journal.ownerId)
    if (!legacyUnbound && !lineageBound) return false
    const expectedAnchor = deriveProposalCatalogMutationAnchorV2({
      ownerId: journal.ownerId,
      kind: 'USER_ACTION',
      inputCatalogEpoch: global.proposalCatalogEpoch,
    })
    const ownedActions = [...this.#lineages.entries()].flatMap(([, raw]) => {
      const parsed = ProposalLineageV2Schema.safeParse(raw)
      if (!parsed.success || parsed.data.origin !== 'RUN2SKILL_V2') return []
      const lineage = parsed.data
      const currentRef = deriveV2ProposalRef(lineage)
      return lineage.revisionActions.flatMap(action => {
        const ownsJournal = legacyUnbound
          ? action.actionId === journal.ownerId
          : deriveProposalRevisionMutationOwnerIdV2(lineage.lineageId, action.actionId) === journal.ownerId
        if (!ownsJournal) return []
        const child = lineage.proposalRevisions.find(proposal => proposal.revisionSource?.actionId === action.actionId)
        const exactCommitted = action.state === 'SUCCEEDED'
          && action.resultProposalRef !== undefined
          && sameRef(action.resultProposalRef, currentRef)
          && child?.catalogEpoch === expectedAnchor.epoch
          && child.catalogMutationReceiptDigest === expectedAnchor.digest
        return [{ action, child, exactCommitted }]
      })
    })
    const exactCommitted = ownedActions.filter(candidate => candidate.exactCommitted)
    if (exactCommitted.length === 1) {
      await this.#finalizeMutation(journal.ownerId)
      return true
    }
    const provablePreChild = exactCommitted.length === 0
      ? ownedActions.filter(candidate => candidate.action.state === 'CALL_RESERVED' && candidate.child === undefined)
      : []
    if (provablePreChild.length === 1) {
      await this.#global.runExclusive(async current => {
        if (
          current.proposalCatalogMutationJournal?.mutationId !== journal.mutationId
          || current.proposalCatalogMutationJournal.ownerId !== journal.ownerId
          || current.proposalCatalogMutationJournal.kind !== journal.kind
          || current.proposalCatalogEpoch !== global.proposalCatalogEpoch
          || current.proposalCatalogLastMutation.digest !== global.proposalCatalogLastMutation.digest
        ) {
          throw new V2ProposalRevisionError('REVISION_RECOVERY_CONFLICT')
        }
        const { proposalCatalogMutationJournal: _journal, ...rest } = current
        return { value: undefined, global: rest }
      })
      return true
    }
    throw new V2ProposalRevisionError('REVISION_RECOVERY_CONFLICT')
  }

  async #markFailed(lineageId: string, actionId: string, failureCode: RevisionAction['failureCode']): Promise<void> {
    const parsed = ProposalLineageV2Schema.safeParse(this.#lineages.get(lineageId))
    if (!parsed.success || parsed.data.origin !== 'RUN2SKILL_V2') return
    const action = parsed.data.revisionActions.find(item => item.actionId === actionId)
    if (action?.state !== 'CALL_RESERVED') return
    const completedAt = this.#now()
    await this.#updateLineage(lineageId, parsed.data.revision, current => ({
      ...current,
      revision: current.revision + 1,
      updatedAt: completedAt,
      revisionActions: current.revisionActions.map(item => item.actionId === actionId
        ? { ...item, state: 'FAILED' as const, failureCode: failureCode!, completedAt }
        : item),
    }))
  }

  async #updateLineage(
    lineageId: string,
    expectedRevision: number,
    transform: (current: NativeLineage) => NativeLineage,
  ): Promise<NativeLineage> {
    const updated = await this.#lineages.update(lineageId, raw => {
      const parsed = ProposalLineageV2Schema.safeParse(raw)
      if (!parsed.success || parsed.data.origin !== 'RUN2SKILL_V2') {
        throw new V2ProposalRevisionError('REVISION_LINEAGE_NOT_FOUND')
      }
      if (parsed.data.revision !== expectedRevision) {
        throw new V2ProposalRevisionError('REVISION_REVISION_CONFLICT')
      }
      return ProposalLineageV2Schema.parse(transform(parsed.data))
    })
    const parsed = ProposalLineageV2Schema.parse(updated)
    if (parsed.origin !== 'RUN2SKILL_V2') throw new V2ProposalRevisionError('REVISION_LINEAGE_NOT_FOUND')
    return parsed
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation, operation)
    this.#tail = next.then(() => undefined, () => undefined)
    return next
  }
}
