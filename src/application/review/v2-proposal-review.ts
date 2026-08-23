import { Run2skillV2GlobalStore } from '../../adapters/dsh-storage/v2-global-store.js'
import type { Run2skillV2Domain } from '../../adapters/dsh-storage/v2-types.js'
import type { Run2skillTable } from '../../adapters/dsh-storage/types.js'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import {
  ExperienceIntentV2Schema,
  ProposalLineageV2Schema,
  SessionBatchV2Schema,
  deriveProposalCatalogMutationAnchorV2,
  deriveProposalCatalogMutationIdV2,
  deriveProposalReviewReceiptDigestV2,
  type ExperienceIntentV2,
  type ProposalLineageV2,
  type SessionBatchV2,
} from '../../domain/v2/index.js'

type NativeProposalLineageV2 = Extract<ProposalLineageV2, { readonly origin: 'RUN2SKILL_V2' }>
type NativeProposalRevisionV2 = NativeProposalLineageV2['proposalRevisions'][number]

export interface V2ProposalRef {
  readonly proposalId: string
  readonly revision: number
  readonly digest: string
}

export type V2ProposalReviewRevalidation =
  | {
      readonly status: 'CURRENT'
      readonly runtimeCatalogDigest: string
      readonly pendingCatalogDigest: string
      readonly catalogEpoch: number
      readonly catalogMutationReceiptDigest: string
    }
  | { readonly status: 'STALE' | 'UNAVAILABLE' }

export interface V2ProposalReviewRevalidationPort {
  revalidate(input: {
    readonly lineage: NativeProposalLineageV2
    readonly proposal: NativeProposalRevisionV2
    readonly proposalRef: V2ProposalRef
    readonly intent: ExperienceIntentV2
    readonly batch: SessionBatchV2
  }): Promise<V2ProposalReviewRevalidation>
}

export interface V2ProposalReviewRequest {
  readonly lineageId: string
  readonly expectedLineageRevision: number
  readonly proposalRef: V2ProposalRef
}

export interface V2ProposalReviewResult {
  readonly changed: boolean
  readonly state: 'APPROVED' | 'REJECTED' | 'NEEDS_ATTENTION'
  readonly lineage: NativeProposalLineageV2
}

export class V2ProposalReviewError extends Error {
  constructor(readonly code:
    | 'REVIEW_LINEAGE_NOT_FOUND'
    | 'REVIEW_REVISION_CONFLICT'
    | 'STALE_PROPOSAL_REF'
    | 'INVALID_REVIEW_STATE'
    | 'REVIEW_INPUT_UNAVAILABLE'
    | 'REVIEW_BUSY'
    | 'REVIEW_RECOVERY_CONFLICT',
  ) {
    super(code)
    this.name = 'V2ProposalReviewError'
  }
}

function immutableProposalFacts(lineage: NativeProposalLineageV2, proposal: NativeProposalRevisionV2) {
  return {
    contract: 'run2skill-v2-proposal-ref-v1',
    lineageId: lineage.lineageId,
    persistenceScope: lineage.persistenceScope,
    behaviorSignature: lineage.behaviorSignature,
    proposal: {
      revision: proposal.revision,
      proposalId: proposal.proposalId,
      ownerIntentId: proposal.ownerIntentId,
      ownerIntentRevision: proposal.ownerIntentRevision,
      action: proposal.action,
      body: proposal.body,
      runtimeCatalogDigest: proposal.runtimeCatalogDigest,
      pendingCatalogDigest: proposal.pendingCatalogDigest,
      generationResultReceiptDigest: proposal.generationResultReceiptDigest,
      catalogMutationReceiptDigest: proposal.catalogMutationReceiptDigest,
      catalogEpoch: proposal.catalogEpoch,
      ...(proposal.targetIdentityDigest === undefined
        ? {}
        : { targetIdentityDigest: proposal.targetIdentityDigest }),
      ...(proposal.baseSkillBytesDigest === undefined
        ? {}
        : { baseSkillBytesDigest: proposal.baseSkillBytesDigest }),
      ...(proposal.projectScopeBinding === undefined
        ? {}
        : { projectScopeBinding: proposal.projectScopeBinding }),
      createdAt: proposal.createdAt,
    },
  }
}

export function deriveV2ProposalRef(lineage: ProposalLineageV2): V2ProposalRef {
  if (lineage.origin !== 'RUN2SKILL_V2') throw new TypeError('Legacy lineage has no native v2 Proposal ref')
  const proposal = lineage.proposalRevisions.at(-1)
  if (proposal === undefined) throw new TypeError('Native lineage has no Proposal revision')
  return {
    proposalId: proposal.proposalId,
    revision: proposal.revision,
    digest: sha256Utf8(canonicalJson(immutableProposalFacts(lineage, proposal))),
  }
}

function sameRef(left: V2ProposalRef, right: V2ProposalRef): boolean {
  return left.proposalId === right.proposalId
    && left.revision === right.revision
    && left.digest === right.digest
}

function reviewState(lineage: NativeProposalLineageV2): V2ProposalReviewResult['state'] | undefined {
  const proposal = lineage.proposalRevisions.at(-1)
  if (proposal?.reviewDecision === 'APPROVED') return 'APPROVED'
  if (proposal?.reviewDecision === 'REJECTED') return 'REJECTED'
  if (proposal?.reviewFailureCode !== undefined) return 'NEEDS_ATTENTION'
  return undefined
}

/**
 * Owns native v2 Proposal review facts. Rejection is a Pending Catalog
 * membership mutation, so it uses the same durable journal/epoch fence as
 * generation and publication. Approval keeps the Proposal active and stores
 * the exact pre-publication Catalog revalidation receipt.
 */
export class V2ProposalReviewCoordinator {
  readonly #global: Run2skillV2GlobalStore
  readonly #lineages: Run2skillTable<string, ProposalLineageV2>
  readonly #intents: Run2skillTable<string, ExperienceIntentV2>
  readonly #batches: Run2skillTable<string, SessionBatchV2>
  readonly #now: () => string
  #tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly domain: Run2skillV2Domain,
    private readonly options: V2ProposalReviewRevalidationPort & { readonly now?: () => string },
  ) {
    this.#global = Run2skillV2GlobalStore.for(domain)
    this.#lineages = domain.table('proposal_lineages')
    this.#intents = domain.table('experience_intents')
    this.#batches = domain.table('session_batches')
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  approve(request: V2ProposalReviewRequest): Promise<V2ProposalReviewResult> {
    return this.#serialize(async () => {
      const lineage = this.#matchingLineage(request)
      const state = reviewState(lineage)
      if (state === 'APPROVED') {
        const journal = this.#global.get().proposalCatalogMutationJournal
        if (journal?.kind === 'REVIEW' && journal.ownerId === request.proposalRef.proposalId) {
          await this.#recoverReviewJournal()
        }
        return { changed: false, state, lineage }
      }
      if (state === 'REJECTED') throw new V2ProposalReviewError('INVALID_REVIEW_STATE')
      this.#assertExpectedRevision(lineage, request)
      const proposal = lineage.proposalRevisions.at(-1)!
      const intent = ExperienceIntentV2Schema.safeParse(this.#intents.get(lineage.ownerIntentId))
      const batch = intent.success
        ? SessionBatchV2Schema.safeParse(this.#batches.get(intent.data.batchId))
        : undefined
      if (!intent?.success || !batch?.success || intent.data.lineageId !== lineage.lineageId) {
        throw new V2ProposalReviewError('REVIEW_INPUT_UNAVAILABLE')
      }

      let revalidation: V2ProposalReviewRevalidation
      try {
        revalidation = await this.options.revalidate({
          lineage, proposal, proposalRef: request.proposalRef, intent: intent.data, batch: batch.data,
        })
      } catch {
        revalidation = { status: 'UNAVAILABLE' }
      }
      if (revalidation.status !== 'CURRENT') {
        const failureCode = revalidation.status === 'STALE' ? 'CATALOG_CHANGED' : 'CATALOG_UNAVAILABLE'
        return await this.#recordAttention(lineage, request, failureCode)
      }

      const prepared = await this.#prepareApproval(request.proposalRef.proposalId, revalidation)
      if (!prepared) {
        return await this.#recordAttention(lineage, request, 'CATALOG_CHANGED')
      }

      const reviewedAt = this.#now()
      const receiptDigest = deriveProposalReviewReceiptDigestV2({
        proposalRef: request.proposalRef,
        decision: 'APPROVED',
        reviewedAt,
        reviewCatalog: revalidation,
      })
      let updated: NativeProposalLineageV2
      try {
        updated = await this.#updateExpected(lineage, request, current => {
          const latest = current.proposalRevisions.at(-1)!
          if (latest.reviewDecision !== undefined) throw new V2ProposalReviewError('INVALID_REVIEW_STATE')
          const { reviewFailureCode: _failure, reviewAttemptedAt: _attempt, ...base } = latest
          return {
            ...current,
            revision: current.revision + 1,
            updatedAt: reviewedAt,
            proposalRevisions: [{
              ...base,
              reviewDecision: 'APPROVED',
              reviewedAt,
              reviewReceiptDigest: receiptDigest,
              reviewCatalog: revalidation,
            }],
          }
        })
        await this.#clearReviewJournal(request.proposalRef.proposalId)
      } catch (error) {
        await this.#recoverReviewJournal()
        throw error
      }
      return { changed: true, state: 'APPROVED', lineage: updated }
    })
  }

  reject(request: V2ProposalReviewRequest): Promise<V2ProposalReviewResult> {
    return this.#serialize(async () => {
      const lineage = this.#matchingLineage(request)
      const state = reviewState(lineage)
      if (state === 'REJECTED') {
        const journal = this.#global.get().proposalCatalogMutationJournal
        if (journal?.kind === 'REVIEW' && journal.ownerId === request.proposalRef.proposalId) {
          await this.#recoverReviewJournal()
        }
        return { changed: false, state, lineage }
      }
      if (state === 'APPROVED') throw new V2ProposalReviewError('INVALID_REVIEW_STATE')
      this.#assertExpectedRevision(lineage, request)
      await this.#prepareRejection(request.proposalRef.proposalId)
      let updated: NativeProposalLineageV2
      try {
        const reviewedAt = this.#now()
        const receiptDigest = deriveProposalReviewReceiptDigestV2({
          proposalRef: request.proposalRef,
          decision: 'REJECTED',
          reviewedAt,
        })
        updated = await this.#updateExpected(lineage, request, current => {
          const latest = current.proposalRevisions.at(-1)!
          if (latest.reviewDecision !== undefined) throw new V2ProposalReviewError('INVALID_REVIEW_STATE')
          const {
            reviewFailureCode: _failure,
            reviewAttemptedAt: _attempt,
            reviewCatalog: _catalog,
            ...base
          } = latest
          return {
            ...current,
            revision: current.revision + 1,
            state: 'TERMINAL',
            updatedAt: reviewedAt,
            proposalRevisions: [{
              ...base,
              state: 'TERMINAL',
              reviewDecision: 'REJECTED',
              reviewedAt,
              reviewReceiptDigest: receiptDigest,
            }],
          }
        })
      } catch (error) {
        await this.#recoverReviewJournal()
        throw error
      }
      try {
        await this.#finalizeRejection(request.proposalRef.proposalId)
      } catch (error) {
        await this.#recoverReviewJournal()
        throw error
      }
      return { changed: true, state: 'REJECTED', lineage: updated }
    })
  }

  recover(): Promise<'IDLE' | 'RECOVERED'> {
    return this.#serialize(async () => await this.#recoverReviewJournal())
  }

  #matchingLineage(request: V2ProposalReviewRequest): NativeProposalLineageV2 {
    const parsed = ProposalLineageV2Schema.safeParse(this.#lineages.get(request.lineageId))
    if (!parsed.success || parsed.data.origin !== 'RUN2SKILL_V2') {
      throw new V2ProposalReviewError('REVIEW_LINEAGE_NOT_FOUND')
    }
    if (!sameRef(deriveV2ProposalRef(parsed.data), request.proposalRef)) {
      throw new V2ProposalReviewError('STALE_PROPOSAL_REF')
    }
    return parsed.data
  }

  #assertExpectedRevision(
    lineage: NativeProposalLineageV2,
    request: V2ProposalReviewRequest,
  ): void {
    if (lineage.revision !== request.expectedLineageRevision) {
      throw new V2ProposalReviewError('REVIEW_REVISION_CONFLICT')
    }
  }

  async #updateExpected(
    expected: NativeProposalLineageV2,
    request: V2ProposalReviewRequest,
    transform: (current: NativeProposalLineageV2) => NativeProposalLineageV2,
  ): Promise<NativeProposalLineageV2> {
    const updated = await this.#lineages.update(expected.lineageId, value => {
      const parsed = ProposalLineageV2Schema.safeParse(value)
      if (!parsed.success || parsed.data.origin !== 'RUN2SKILL_V2') {
        throw new V2ProposalReviewError('REVIEW_LINEAGE_NOT_FOUND')
      }
      if (parsed.data.revision !== expected.revision) {
        throw new V2ProposalReviewError('REVIEW_REVISION_CONFLICT')
      }
      if (!sameRef(deriveV2ProposalRef(parsed.data), request.proposalRef)) {
        throw new V2ProposalReviewError('STALE_PROPOSAL_REF')
      }
      return ProposalLineageV2Schema.parse(transform(parsed.data))
    })
    const parsed = ProposalLineageV2Schema.parse(updated)
    if (parsed.origin !== 'RUN2SKILL_V2') throw new V2ProposalReviewError('REVIEW_LINEAGE_NOT_FOUND')
    return parsed
  }

  async #recordAttention(
    lineage: NativeProposalLineageV2,
    request: V2ProposalReviewRequest,
    failureCode: 'CATALOG_CHANGED' | 'CATALOG_UNAVAILABLE',
  ): Promise<V2ProposalReviewResult> {
    const attemptedAt = this.#now()
    const updated = await this.#updateExpected(lineage, request, current => {
      const latest = current.proposalRevisions.at(-1)!
      if (latest.reviewDecision !== undefined) throw new V2ProposalReviewError('INVALID_REVIEW_STATE')
      const { reviewFailureCode: _failure, reviewAttemptedAt: _attempt, ...base } = latest
      return {
        ...current,
        revision: current.revision + 1,
        updatedAt: attemptedAt,
        proposalRevisions: [{
          ...base,
          reviewFailureCode: failureCode,
          reviewAttemptedAt: attemptedAt,
        }],
      }
    })
    return { changed: true, state: 'NEEDS_ATTENTION', lineage: updated }
  }

  async #prepareApproval(
    proposalId: string,
    revalidation: Extract<V2ProposalReviewRevalidation, { readonly status: 'CURRENT' }>,
  ): Promise<boolean> {
    return await this.#global.runExclusive(async current => {
      if (
        current.migration.phase !== 'COMMITTED'
        || current.activation === undefined
        || current.proposalGenerationLease !== undefined
        || current.proposalCatalogMutationJournal !== undefined
        || current.purgeJournal !== undefined
      ) throw new V2ProposalReviewError('REVIEW_BUSY')
      if (
        current.proposalCatalogEpoch !== revalidation.catalogEpoch
        || current.proposalCatalogLastMutation.digest !== revalidation.catalogMutationReceiptDigest
      ) return { value: false }
      const mutationId = deriveProposalCatalogMutationIdV2({
        ownerId: proposalId,
        kind: 'REVIEW',
        inputCatalogEpoch: current.proposalCatalogEpoch,
      })
      return {
        value: true,
        global: {
          ...current,
          proposalCatalogMutationJournal: {
            schemaVersion: 1,
            mutationId,
            ownerId: proposalId,
            kind: 'REVIEW',
            phase: 'PREPARED',
            preparedAt: this.#now(),
          },
        },
      }
    })
  }

  async #prepareRejection(proposalId: string): Promise<void> {
    await this.#global.runExclusive(async current => {
      if (
        current.migration.phase !== 'COMMITTED'
        || current.activation === undefined
        || current.proposalGenerationLease !== undefined
        || current.proposalCatalogMutationJournal !== undefined
        || current.purgeJournal !== undefined
      ) throw new V2ProposalReviewError('REVIEW_BUSY')
      const mutationId = deriveProposalCatalogMutationIdV2({
        ownerId: proposalId,
        kind: 'REVIEW',
        inputCatalogEpoch: current.proposalCatalogEpoch,
      })
      return {
        value: undefined,
        global: {
          ...current,
          proposalCatalogMutationJournal: {
            schemaVersion: 1,
            mutationId,
            ownerId: proposalId,
            kind: 'REVIEW',
            phase: 'PREPARED',
            preparedAt: this.#now(),
          },
        },
      }
    })
  }

  async #finalizeRejection(proposalId: string): Promise<void> {
    await this.#global.runExclusive(async current => {
      const journal = current.proposalCatalogMutationJournal
      const expectedId = deriveProposalCatalogMutationIdV2({
        ownerId: proposalId,
        kind: 'REVIEW',
        inputCatalogEpoch: current.proposalCatalogEpoch,
      })
      if (journal?.kind !== 'REVIEW' || journal.ownerId !== proposalId || journal.mutationId !== expectedId) {
        throw new V2ProposalReviewError('REVIEW_RECOVERY_CONFLICT')
      }
      const { proposalCatalogMutationJournal: _journal, ...rest } = current
      const anchor = deriveProposalCatalogMutationAnchorV2({
        ownerId: proposalId,
        kind: 'REVIEW',
        inputCatalogEpoch: current.proposalCatalogEpoch,
      })
      return {
        value: undefined,
        global: {
          ...rest,
          proposalCatalogEpoch: anchor.epoch,
          proposalCatalogLastMutation: anchor,
        },
      }
    })
  }

  async #clearReviewJournal(proposalId: string): Promise<void> {
    await this.#global.runExclusive(async current => {
      const journal = current.proposalCatalogMutationJournal
      const expectedId = deriveProposalCatalogMutationIdV2({
        ownerId: proposalId,
        kind: 'REVIEW',
        inputCatalogEpoch: current.proposalCatalogEpoch,
      })
      if (journal?.kind !== 'REVIEW' || journal.ownerId !== proposalId || journal.mutationId !== expectedId) {
        throw new V2ProposalReviewError('REVIEW_RECOVERY_CONFLICT')
      }
      const { proposalCatalogMutationJournal: _journal, ...rest } = current
      return { value: undefined, global: rest }
    })
  }

  async #recoverReviewJournal(): Promise<'IDLE' | 'RECOVERED'> {
    const journal = this.#global.get().proposalCatalogMutationJournal
    if (journal?.kind !== 'REVIEW') return 'IDLE'
    const matches = [...this.#lineages.entries()].flatMap(([, value]) => {
      const parsed = ProposalLineageV2Schema.safeParse(value)
      if (!parsed.success || parsed.data.origin !== 'RUN2SKILL_V2') return []
      return parsed.data.proposalRevisions.at(-1)?.proposalId === journal.ownerId ? [parsed.data] : []
    })
    if (matches.length !== 1) throw new V2ProposalReviewError('REVIEW_RECOVERY_CONFLICT')
    const lineage = matches[0]!
    const proposal = lineage.proposalRevisions.at(-1)!
    if (lineage.state === 'TERMINAL' && proposal.reviewDecision === 'REJECTED' && proposal.reviewReceiptDigest !== undefined) {
      await this.#finalizeRejection(journal.ownerId)
      return 'RECOVERED'
    }
    if (
      lineage.state !== 'ACTIVE_PROPOSAL'
      || (proposal.reviewDecision !== undefined && (
        proposal.reviewDecision !== 'APPROVED' || proposal.reviewReceiptDigest === undefined
      ))
    ) {
      throw new V2ProposalReviewError('REVIEW_RECOVERY_CONFLICT')
    }
    await this.#clearReviewJournal(journal.ownerId)
    return 'RECOVERED'
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation)
    this.#tail = result.then(() => {}, () => {})
    return result
  }
}
