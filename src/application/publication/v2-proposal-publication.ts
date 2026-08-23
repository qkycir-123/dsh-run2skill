import { Run2skillV2GlobalStore } from '../../adapters/dsh-storage/v2-global-store.js'
import type { Run2skillV2Domain } from '../../adapters/dsh-storage/v2-types.js'
import type { Run2skillTable } from '../../adapters/dsh-storage/types.js'
import {
  ExperienceIntentV2Schema,
  ProposalLineageV2Schema,
  SessionBatchV2Schema,
  deriveProposalCatalogMutationAnchorV2,
  deriveProposalCatalogMutationIdV2,
  deriveProposalPublicationReceiptDigestV2,
  type ExperienceIntentV2,
  type ProposalLineageV2,
  type SessionBatchV2,
} from '../../domain/v2/index.js'
import {
  deriveV2ProposalRef,
  type V2ProposalRef,
  type V2ProposalReviewRevalidation,
} from '../review/index.js'

type NativeProposalLineageV2 = Extract<ProposalLineageV2, { readonly origin: 'RUN2SKILL_V2' }>
type NativeProposalRevisionV2 = NativeProposalLineageV2['proposalRevisions'][number]
type CurrentCatalog = Extract<V2ProposalReviewRevalidation, { readonly status: 'CURRENT' }>

export interface V2ProposalPublicationRequest {
  readonly lineageId: string
  readonly expectedLineageRevision: number
  readonly proposalRef: V2ProposalRef
}

export type V2ProposalPublicationOutcome =
  | { readonly status: 'PUBLISHED'; readonly externalReceiptDigest: string }
  // STALE and CONFLICT guarantee that no external write occurred. UNAVAILABLE
  // is outcome-unknown: the write may have completed before exact readback.
  | { readonly status: 'STALE' | 'UNAVAILABLE' | 'CONFLICT' }

export type V2ProposalPublicationRecoveryOutcome =
  | V2ProposalPublicationOutcome
  | { readonly status: 'ABSENT' }

export interface V2ProposalPublicationInput {
  readonly lineage: NativeProposalLineageV2
  readonly proposal: NativeProposalRevisionV2
  readonly proposalRef: V2ProposalRef
  readonly intent: ExperienceIntentV2
  readonly batch: SessionBatchV2
}

export interface V2ProposalPublicationOptions {
  revalidate(input: V2ProposalPublicationInput): Promise<V2ProposalReviewRevalidation>
  /** Recover an existing attempt only. ABSENT must guarantee that no external transaction exists. */
  recover?(input: V2ProposalPublicationInput & { readonly attemptId: string }): Promise<unknown>
  publish(input: V2ProposalPublicationInput & { readonly attemptId: string }): Promise<unknown>
  readonly now?: () => string
}

export interface V2ProposalPublicationResult {
  readonly changed: boolean
  readonly state: 'PUBLISHED' | 'NEEDS_ATTENTION'
  readonly lineage: NativeProposalLineageV2
}

export class V2ProposalPublicationError extends Error {
  constructor(readonly code:
    | 'PUBLICATION_LINEAGE_NOT_FOUND'
    | 'PUBLICATION_REVISION_CONFLICT'
    | 'STALE_PROPOSAL_REF'
    | 'INVALID_PUBLICATION_STATE'
    | 'PUBLICATION_INPUT_UNAVAILABLE'
    | 'PUBLICATION_BUSY'
    | 'PUBLICATION_RECOVERY_CONFLICT',
  ) {
    super(code)
    this.name = 'V2ProposalPublicationError'
  }
}

const sha256 = /^[a-f0-9]{64}$/u

function sameRef(left: V2ProposalRef, right: V2ProposalRef): boolean {
  return left.proposalId === right.proposalId
    && left.revision === right.revision
    && left.digest === right.digest
}

function failureCode(status: Exclude<V2ProposalPublicationOutcome['status'], 'PUBLISHED'>) {
  if (status === 'STALE') return 'CATALOG_CHANGED' as const
  if (status === 'CONFLICT') return 'PUBLICATION_CONFLICT' as const
  return 'PUBLICATION_UNAVAILABLE' as const
}

function publicationOutcome(value: unknown): V2ProposalPublicationOutcome {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { status: 'UNAVAILABLE' }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (
    record.status === 'PUBLISHED'
    && keys.length === 2
    && keys.includes('externalReceiptDigest')
    && typeof record.externalReceiptDigest === 'string'
  ) return { status: 'PUBLISHED', externalReceiptDigest: record.externalReceiptDigest }
  if (
    keys.length === 1
    && (record.status === 'STALE' || record.status === 'UNAVAILABLE' || record.status === 'CONFLICT')
  ) return { status: record.status }
  return { status: 'UNAVAILABLE' }
}

function publicationRecoveryOutcome(value: unknown): V2ProposalPublicationRecoveryOutcome {
  if (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && (value as Record<string, unknown>).status === 'ABSENT'
  ) return { status: 'ABSENT' }
  return publicationOutcome(value)
}

/**
 * Publishes one approved native v2 Proposal behind a durable Catalog mutation
 * fence. The filesystem port must use attemptId as an idempotency key and
 * return success only after exact readback.
 */
export class V2ProposalPublicationCoordinator {
  readonly #global: Run2skillV2GlobalStore
  readonly #lineages: Run2skillTable<string, ProposalLineageV2>
  readonly #intents: Run2skillTable<string, ExperienceIntentV2>
  readonly #batches: Run2skillTable<string, SessionBatchV2>
  readonly #now: () => string
  #tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly domain: Run2skillV2Domain,
    private readonly options: V2ProposalPublicationOptions,
  ) {
    this.#global = Run2skillV2GlobalStore.for(domain)
    this.#lineages = domain.table('proposal_lineages')
    this.#intents = domain.table('experience_intents')
    this.#batches = domain.table('session_batches')
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  publish(request: V2ProposalPublicationRequest): Promise<V2ProposalPublicationResult> {
    return this.#serialize(async () => {
      const lineage = this.#matchingLineage(request.lineageId, request.proposalRef)
      if (lineage.state === 'PUBLISHED') {
        const journal = this.#global.get().proposalCatalogMutationJournal
        if (journal?.kind === 'PUBLICATION' && journal.ownerId === request.proposalRef.proposalId) {
          await this.#recoverPublicationJournal()
        }
        return { changed: false, state: 'PUBLISHED', lineage }
      }
      this.#assertPublishable(lineage)
      if (lineage.revision !== request.expectedLineageRevision) {
        throw new V2ProposalPublicationError('PUBLICATION_REVISION_CONFLICT')
      }
      const input = this.#input(lineage, request.proposalRef)
      let revalidation: V2ProposalReviewRevalidation
      try {
        revalidation = await this.options.revalidate(input)
      } catch {
        revalidation = { status: 'UNAVAILABLE' }
      }
      if (revalidation.status !== 'CURRENT') {
        return await this.#recordFailure(
          lineage,
          revalidation.status === 'STALE' ? 'CATALOG_CHANGED' : 'CATALOG_UNAVAILABLE',
        )
      }
      const attemptId = await this.#prepare(request.proposalRef.proposalId, revalidation)
      if (attemptId === undefined) return await this.#recordFailure(lineage, 'CATALOG_CHANGED')
      await this.#markExecuting(request.proposalRef.proposalId, attemptId)
      try {
        return await this.#executePrepared(input, attemptId)
      } catch (error) {
        await this.#recoverPublicationJournal()
        throw error
      }
    })
  }

  recover(): Promise<'IDLE' | 'RECOVERED'> {
    return this.#serialize(async () => await this.#recoverPublicationJournal())
  }

  #matchingLineage(lineageId: string, proposalRef: V2ProposalRef): NativeProposalLineageV2 {
    const parsed = ProposalLineageV2Schema.safeParse(this.#lineages.get(lineageId))
    if (!parsed.success || parsed.data.origin !== 'RUN2SKILL_V2') {
      throw new V2ProposalPublicationError('PUBLICATION_LINEAGE_NOT_FOUND')
    }
    if (!sameRef(deriveV2ProposalRef(parsed.data), proposalRef)) {
      throw new V2ProposalPublicationError('STALE_PROPOSAL_REF')
    }
    return parsed.data
  }

  #assertPublishable(lineage: NativeProposalLineageV2, allowOutcomeUnknownRecovery = false): void {
    const proposal = lineage.proposalRevisions.at(-1)
    if (
      lineage.state !== 'ACTIVE_PROPOSAL'
      || proposal?.reviewDecision !== 'APPROVED'
      || proposal.reviewReceiptDigest === undefined
      || (
        !allowOutcomeUnknownRecovery
        && (proposal.publicationFailureCode === 'CATALOG_CHANGED'
          || proposal.publicationFailureCode === 'PUBLICATION_CONFLICT')
      )
    ) throw new V2ProposalPublicationError('INVALID_PUBLICATION_STATE')
  }

  #input(lineage: NativeProposalLineageV2, proposalRef: V2ProposalRef): V2ProposalPublicationInput {
    const intent = ExperienceIntentV2Schema.safeParse(this.#intents.get(lineage.ownerIntentId))
    const batch = intent.success
      ? SessionBatchV2Schema.safeParse(this.#batches.get(intent.data.batchId))
      : undefined
    const proposal = lineage.proposalRevisions.at(-1)
    if (
      !intent?.success
      || !batch?.success
      || proposal === undefined
      || intent.data.lineageId !== lineage.lineageId
    ) throw new V2ProposalPublicationError('PUBLICATION_INPUT_UNAVAILABLE')
    return { lineage, proposal, proposalRef, intent: intent.data, batch: batch.data }
  }

  async #prepare(proposalId: string, revalidation: CurrentCatalog): Promise<string | undefined> {
    return await this.#global.runExclusive(async current => {
      if (
        current.migration.phase !== 'COMMITTED'
        || current.activation === undefined
        || current.proposalGenerationLease !== undefined
        || current.proposalCatalogMutationJournal !== undefined
        || current.purgeJournal !== undefined
      ) throw new V2ProposalPublicationError('PUBLICATION_BUSY')
      if (
        current.proposalCatalogEpoch !== revalidation.catalogEpoch
        || current.proposalCatalogLastMutation.digest !== revalidation.catalogMutationReceiptDigest
      ) return { value: undefined }
      const mutationId = deriveProposalCatalogMutationIdV2({
        ownerId: proposalId,
        kind: 'PUBLICATION',
        inputCatalogEpoch: current.proposalCatalogEpoch,
      })
      return {
        value: mutationId,
        global: {
          ...current,
          proposalCatalogMutationJournal: {
            schemaVersion: 1,
            mutationId,
            ownerId: proposalId,
            kind: 'PUBLICATION',
            phase: 'PREPARED',
            preparedAt: this.#now(),
          },
        },
      }
    })
  }

  async #executePrepared(input: V2ProposalPublicationInput, attemptId: string): Promise<V2ProposalPublicationResult> {
    const outcome = publicationOutcome(await this.options.publish({ ...input, attemptId }))
    return await this.#completeExternalOutcome(input, attemptId, outcome)
  }

  async #completeExternalOutcome(
    input: V2ProposalPublicationInput,
    attemptId: string,
    outcome: V2ProposalPublicationOutcome,
  ): Promise<V2ProposalPublicationResult> {
    if (outcome.status !== 'PUBLISHED') {
      if (outcome.status === 'STALE' || outcome.status === 'CONFLICT') {
        const code = outcome.status === 'STALE' ? 'CATALOG_CHANGED' : 'PUBLICATION_CONFLICT'
        await this.#markNeedsRefresh(input.proposalRef.proposalId, attemptId, code)
        const result = await this.#recordFailure(input.lineage, code)
        await this.#clearJournal(input.proposalRef.proposalId, attemptId)
        return result
      }
      return await this.#recordFailure(input.lineage, failureCode(outcome.status))
    }
    if (!sha256.test(outcome.externalReceiptDigest)) {
      return await this.#recordFailure(input.lineage, 'PUBLICATION_UNAVAILABLE')
    }
    const publishedAt = this.#now()
    const receiptDigest = deriveProposalPublicationReceiptDigestV2({
      proposalRef: input.proposalRef,
      reviewReceiptDigest: input.proposal.reviewReceiptDigest!,
      attemptId,
      externalReceiptDigest: outcome.externalReceiptDigest,
      publishedAt,
    })
    const updated = await this.#updateLineage(input.lineage, current => {
      const latest = current.proposalRevisions.at(-1)!
      const {
        publicationFailureCode: _failure,
        publicationAttemptedAt: _attempted,
        ...base
      } = latest
      const skillRevisions = [...current.skillRevisions]
      if (latest.action === 'MERGE') {
        if (latest.baseSkillBytes === undefined || latest.baseSkillBytesDigest === undefined) {
          throw new V2ProposalPublicationError('PUBLICATION_INPUT_UNAVAILABLE')
        }
        const currentSkill = skillRevisions.at(-1)
        if (currentSkill === undefined) {
          skillRevisions.push({
            revision: 1,
            origin: 'ADOPTED_BASE',
            exactSkillBytes: latest.baseSkillBytes,
            skillBytesDigest: latest.baseSkillBytesDigest,
            committedAt: publishedAt,
          })
        } else if (
          currentSkill.exactSkillBytes !== latest.baseSkillBytes
          || currentSkill.skillBytesDigest !== latest.baseSkillBytesDigest
        ) {
          throw new V2ProposalPublicationError('PUBLICATION_INPUT_UNAVAILABLE')
        }
      }
      skillRevisions.push({
        revision: skillRevisions.length + 1,
        origin: 'RUN2SKILL',
        proposalId: latest.proposalId,
        exactSkillBytes: latest.body.exactSkillBytes,
        skillBytesDigest: latest.body.skillBytesDigest,
        committedAt: publishedAt,
      })
      return {
        ...current,
        revision: current.revision + 1,
        state: 'PUBLISHED',
        currentSkillRevision: skillRevisions.length,
        skillRevisions,
        updatedAt: publishedAt,
        proposalRevisions: [
          ...current.proposalRevisions.slice(0, -1),
          {
            ...base,
            state: 'PUBLISHED',
            publishedAt,
            publicationExternalReceiptDigest: outcome.externalReceiptDigest,
            publicationReceiptDigest: receiptDigest,
          },
        ],
      }
    })
    await this.#finalize(input.proposalRef.proposalId, attemptId)
    return { changed: true, state: 'PUBLISHED', lineage: updated }
  }

  async #recordFailure(
    expected: NativeProposalLineageV2,
    code: 'CATALOG_CHANGED' | 'CATALOG_UNAVAILABLE' | 'PUBLICATION_UNAVAILABLE' | 'PUBLICATION_CONFLICT',
  ): Promise<V2ProposalPublicationResult> {
    const attemptedAt = this.#now()
    const updated = await this.#updateLineage(expected, current => {
      const latest = current.proposalRevisions.at(-1)!
      const { publicationFailureCode: _failure, publicationAttemptedAt: _attempted, ...base } = latest
      return {
        ...current,
        revision: current.revision + 1,
        updatedAt: attemptedAt,
        proposalRevisions: [
          ...current.proposalRevisions.slice(0, -1),
          { ...base, publicationFailureCode: code, publicationAttemptedAt: attemptedAt },
        ],
      }
    })
    return { changed: true, state: 'NEEDS_ATTENTION', lineage: updated }
  }

  async #updateLineage(
    expected: NativeProposalLineageV2,
    transform: (current: NativeProposalLineageV2) => NativeProposalLineageV2,
  ): Promise<NativeProposalLineageV2> {
    const value = await this.#lineages.update(expected.lineageId, raw => {
      const current = ProposalLineageV2Schema.safeParse(raw)
      if (!current.success || current.data.origin !== 'RUN2SKILL_V2') {
        throw new V2ProposalPublicationError('PUBLICATION_LINEAGE_NOT_FOUND')
      }
      if (current.data.revision !== expected.revision) {
        throw new V2ProposalPublicationError('PUBLICATION_REVISION_CONFLICT')
      }
      return ProposalLineageV2Schema.parse(transform(current.data))
    })
    const parsed = ProposalLineageV2Schema.parse(value)
    if (parsed.origin !== 'RUN2SKILL_V2') throw new V2ProposalPublicationError('PUBLICATION_LINEAGE_NOT_FOUND')
    return parsed
  }

  async #clearJournal(proposalId: string, attemptId: string): Promise<void> {
    await this.#global.runExclusive(async current => {
      const journal = current.proposalCatalogMutationJournal
      if (journal?.kind !== 'PUBLICATION' || journal.ownerId !== proposalId || journal.mutationId !== attemptId) {
        throw new V2ProposalPublicationError('PUBLICATION_RECOVERY_CONFLICT')
      }
      const { proposalCatalogMutationJournal: _journal, ...rest } = current
      return { value: undefined, global: rest }
    })
  }

  async #markExecuting(proposalId: string, attemptId: string): Promise<void> {
    await this.#global.runExclusive(async current => {
      const journal = current.proposalCatalogMutationJournal
      if (
        journal?.kind !== 'PUBLICATION'
        || journal.ownerId !== proposalId
        || journal.mutationId !== attemptId
      ) throw new V2ProposalPublicationError('PUBLICATION_RECOVERY_CONFLICT')
      if (journal.phase === 'EXECUTING') return { value: undefined }
      return {
        value: undefined,
        global: {
          ...current,
          proposalCatalogMutationJournal: {
            ...journal,
            phase: 'EXECUTING',
            executionStartedAt: this.#now(),
          },
        },
      }
    })
  }

  async #markPrepared(proposalId: string, attemptId: string): Promise<void> {
    await this.#global.runExclusive(async current => {
      const journal = current.proposalCatalogMutationJournal
      if (
        journal?.kind !== 'PUBLICATION'
        || journal.ownerId !== proposalId
        || journal.mutationId !== attemptId
        || journal.phase !== 'EXECUTING'
      ) throw new V2ProposalPublicationError('PUBLICATION_RECOVERY_CONFLICT')
      return {
        value: undefined,
        global: {
          ...current,
          proposalCatalogMutationJournal: {
            schemaVersion: 1,
            mutationId: journal.mutationId,
            ownerId: journal.ownerId,
            kind: 'PUBLICATION',
            phase: 'PREPARED',
            preparedAt: journal.preparedAt,
          },
        },
      }
    })
  }

  async #markNeedsRefresh(
    proposalId: string,
    attemptId: string,
    code: 'CATALOG_CHANGED' | 'PUBLICATION_CONFLICT',
  ): Promise<void> {
    await this.#global.runExclusive(async current => {
      const journal = current.proposalCatalogMutationJournal
      if (
        journal?.kind !== 'PUBLICATION'
        || journal.ownerId !== proposalId
        || journal.mutationId !== attemptId
      ) throw new V2ProposalPublicationError('PUBLICATION_RECOVERY_CONFLICT')
      if (journal.phase === 'NEEDS_REFRESH') {
        if (journal.failureCode !== code) {
          throw new V2ProposalPublicationError('PUBLICATION_RECOVERY_CONFLICT')
        }
        return { value: undefined }
      }
      return {
        value: undefined,
        global: {
          ...current,
          proposalCatalogMutationJournal: {
            ...journal,
            phase: 'NEEDS_REFRESH',
            failureCode: code,
            failedAt: this.#now(),
          },
        },
      }
    })
  }

  async #finalize(proposalId: string, attemptId: string): Promise<void> {
    await this.#global.runExclusive(async current => {
      const journal = current.proposalCatalogMutationJournal
      const expectedId = deriveProposalCatalogMutationIdV2({
        ownerId: proposalId,
        kind: 'PUBLICATION',
        inputCatalogEpoch: current.proposalCatalogEpoch,
      })
      if (
        journal?.kind !== 'PUBLICATION'
        || journal.ownerId !== proposalId
        || journal.mutationId !== attemptId
        || journal.mutationId !== expectedId
      ) throw new V2ProposalPublicationError('PUBLICATION_RECOVERY_CONFLICT')
      const { proposalCatalogMutationJournal: _journal, ...rest } = current
      const anchor = deriveProposalCatalogMutationAnchorV2({
        ownerId: proposalId,
        kind: 'PUBLICATION',
        inputCatalogEpoch: current.proposalCatalogEpoch,
      })
      return {
        value: undefined,
        global: { ...rest, proposalCatalogEpoch: anchor.epoch, proposalCatalogLastMutation: anchor },
      }
    })
  }

  async #recoverPublicationJournal(): Promise<'IDLE' | 'RECOVERED'> {
    const journal = this.#global.get().proposalCatalogMutationJournal
    if (journal?.kind !== 'PUBLICATION') return 'IDLE'
    const matches = [...this.#lineages.entries()].flatMap(([, raw]) => {
      const parsed = ProposalLineageV2Schema.safeParse(raw)
      if (!parsed.success || parsed.data.origin !== 'RUN2SKILL_V2') return []
      return parsed.data.proposalRevisions.at(-1)?.proposalId === journal.ownerId ? [parsed.data] : []
    })
    if (matches.length !== 1) throw new V2ProposalPublicationError('PUBLICATION_RECOVERY_CONFLICT')
    const lineage = matches[0]!
    const proposal = lineage.proposalRevisions.at(-1)!
    if (lineage.state === 'PUBLISHED' && proposal.publicationReceiptDigest !== undefined) {
      await this.#finalize(journal.ownerId, journal.mutationId)
      return 'RECOVERED'
    }
    if (journal.phase === 'NEEDS_REFRESH') {
      if (journal.failureCode === undefined) {
        throw new V2ProposalPublicationError('PUBLICATION_RECOVERY_CONFLICT')
      }
      await this.#recordFailureIfNeeded(lineage, journal.failureCode)
      await this.#clearJournal(journal.ownerId, journal.mutationId)
      return 'RECOVERED'
    }
    this.#assertPublishable(lineage, journal.phase === 'EXECUTING')
    const input = this.#input(lineage, deriveV2ProposalRef(lineage))
    if (journal.phase === 'EXECUTING') {
      const recovered = publicationRecoveryOutcome(await this.options.recover?.({
        ...input,
        attemptId: journal.mutationId,
      }))
      if (recovered.status !== 'ABSENT') {
        await this.#completeExternalOutcome(input, journal.mutationId, recovered)
        return 'RECOVERED'
      }
      await this.#markPrepared(journal.ownerId, journal.mutationId)
    }
    let revalidation: V2ProposalReviewRevalidation
    try {
      revalidation = await this.options.revalidate(input)
    } catch {
      revalidation = { status: 'UNAVAILABLE' }
    }
    if (revalidation.status !== 'CURRENT') {
      const code = revalidation.status === 'STALE' ? 'CATALOG_CHANGED' : 'CATALOG_UNAVAILABLE'
      if (code === 'CATALOG_CHANGED') {
        await this.#markNeedsRefresh(journal.ownerId, journal.mutationId, code)
        await this.#recordFailureIfNeeded(lineage, code)
        await this.#clearJournal(journal.ownerId, journal.mutationId)
        return 'RECOVERED'
      }
      await this.#recordFailureIfNeeded(lineage, code)
      await this.#clearJournal(journal.ownerId, journal.mutationId)
      return 'RECOVERED'
    }
    await this.#markExecuting(journal.ownerId, journal.mutationId)
    await this.#executePrepared(input, journal.mutationId)
    return 'RECOVERED'
  }

  async #recordFailureIfNeeded(
    lineage: NativeProposalLineageV2,
    code: 'CATALOG_CHANGED' | 'CATALOG_UNAVAILABLE' | 'PUBLICATION_CONFLICT',
  ): Promise<void> {
    const proposal = lineage.proposalRevisions.at(-1)
    if (proposal?.publicationFailureCode === code) return
    await this.#recordFailure(lineage, code)
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation)
    this.#tail = result.then(() => {}, () => {})
    return result
  }
}
