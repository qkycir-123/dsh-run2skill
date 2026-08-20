import { CaptureWorkItemV1Schema, type CaptureWorkItemV1 } from '../../domain/observe/schemas.js'
import {
  LineageV1Schema,
  appendPublicationJournalEvent,
  beginPublicationRetry,
  type LineageV1,
  type PublicationJournalStageV1,
} from '../../domain/publication/index.js'
import {
  ProposalRefV1Schema,
  proposalRefOf,
  type ProposalRefV1,
} from '../../domain/review/index.js'
import type { Run2skillDomain } from './types.js'
import { PurgeVisibility } from './purge-visibility.js'

export type PublicationSagaStoreErrorCode =
  | 'PUBLICATION_WORK_ITEM_NOT_FOUND'
  | 'PUBLICATION_REVISION_CONFLICT'
  | 'INVALID_PUBLICATION_STATE'
  | 'STALE_PROPOSAL_REF'
  | 'LINEAGE_CONFLICT'
  | 'PUBLICATION_RETRY_LIMIT'

export class PublicationSagaStoreError extends Error {
  constructor(readonly code: PublicationSagaStoreErrorCode) {
    super(code)
    this.name = 'PublicationSagaStoreError'
  }
}

type FailureOutcome = 'NEEDS_ATTENTION' | 'NEEDS_REFRESH' | 'PUBLISH_FAILED'

function sameRef(left: ProposalRefV1, right: ProposalRefV1): boolean {
  return left.proposalId === right.proposalId
    && left.revision === right.revision
    && left.digest === right.digest
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export class PublicationSagaStore {
  readonly #workItems
  readonly #lineages
  readonly #now
  readonly #visibility
  #tail: Promise<void> = Promise.resolve()

  constructor(
    domain: Run2skillDomain,
    now: (() => string) | undefined = undefined,
    visibility: PurgeVisibility = new PurgeVisibility(domain),
  ) {
    this.#workItems = domain.table('work_items')
    this.#lineages = domain.table('lineages')
    this.#now = now ?? (() => new Date().toISOString())
    this.#visibility = visibility
  }

  get(workItemId: string): CaptureWorkItemV1 | undefined {
    const item = this.#workItems.get(workItemId)
    return item !== undefined && this.#visibility.workItemVisible(item) ? item : undefined
  }

  getLineage(lineageId: string): LineageV1 | undefined {
    const lineage = this.#lineages.get(lineageId)
    return lineage !== undefined && this.#visibility.lineageVisible(lineage) ? lineage : undefined
  }

  listRecoverable(): CaptureWorkItemV1[] {
    return [...this.#workItems.entries()].map(([, item]) => item).filter(item => (
      this.#visibility.workItemVisible(item)
      && item.processingState === 'PUBLISHING'
      && item.review?.reviewDecision === 'APPROVED'
      && item.publication !== undefined
    )).sort((left, right) => (
      Date.parse(left.updatedAt) - Date.parse(right.updatedAt)
      || left.workItemId.localeCompare(right.workItemId)
    ))
  }

  appendEvent(
    workItemId: string,
    stage: Exclude<PublicationJournalStageV1, 'APPROVAL_COMMITTED'>,
    hashes: { readonly expectedHash?: string; readonly observedHash?: string } = {},
  ): Promise<CaptureWorkItemV1> {
    return this.#updateLatest(workItemId, current => {
      const publication = this.#publishing(current)
      const existing = publication.journal.find(event => (
        event.attemptId === publication.activeAttemptId && event.stage === stage
      ))
      if (existing !== undefined) {
        if (existing.expectedHash !== hashes.expectedHash || existing.observedHash !== hashes.observedHash) {
          throw new PublicationSagaStoreError('INVALID_PUBLICATION_STATE')
        }
        return undefined
      }
      return {
        ...current,
        publication: appendPublicationJournalEvent(publication, {
          stage,
          occurredAt: this.#now(),
          ...hashes,
        }),
      }
    })
  }

  stageLineage(workItemId: string, rawLineage: LineageV1): Promise<CaptureWorkItemV1> {
    const parsed = LineageV1Schema.safeParse(rawLineage)
    if (!parsed.success) return Promise.reject(new PublicationSagaStoreError('LINEAGE_CONFLICT'))
    return this.#updateLatest(workItemId, current => {
      const publication = this.#publishing(current)
      const readback = publication.journal.find(event => (
        event.attemptId === publication.activeAttemptId && event.stage === 'READBACK_CONFIRMED'
      ))
      if (readback === undefined || parsed.data.targetIdentityDigest !== publication.targetIdentityDigest) {
        throw new PublicationSagaStoreError('INVALID_PUBLICATION_STATE')
      }
      if (publication.pendingLineage !== undefined) {
        if (!sameJson(publication.pendingLineage, parsed.data)) {
          throw new PublicationSagaStoreError('LINEAGE_CONFLICT')
        }
        return undefined
      }
      return {
        ...current,
        publication: {
          ...appendPublicationJournalEvent(publication, {
            stage: 'LINEAGE_PENDING',
            occurredAt: this.#now(),
            observedHash: parsed.data.revisions.at(-1)!.skillBytesDigest,
          }),
          pendingLineage: parsed.data,
        },
      }
    })
  }

  commitLineage(workItemId: string): Promise<CaptureWorkItemV1> {
    return this.#serialize(async () => {
      const snapshot = this.#required(workItemId)
      const publication = this.#publishing(snapshot)
      const pending = publication.pendingLineage
      if (pending === undefined) {
        const committed = publication.journal.some(event => (
          event.attemptId === publication.activeAttemptId && event.stage === 'LINEAGE_COMMITTED'
        ))
        if (committed) return snapshot
        throw new PublicationSagaStoreError('INVALID_PUBLICATION_STATE')
      }
      await this.#putLineage(pending)
      return await this.#updateNow(workItemId, current => {
        const latest = this.#publishing(current)
        if (latest.pendingLineage === undefined) {
          const committed = latest.journal.some(event => (
            event.attemptId === latest.activeAttemptId && event.stage === 'LINEAGE_COMMITTED'
          ))
          if (committed) return undefined
          throw new PublicationSagaStoreError('INVALID_PUBLICATION_STATE')
        }
        if (!sameJson(latest.pendingLineage, pending)) {
          throw new PublicationSagaStoreError('LINEAGE_CONFLICT')
        }
        return {
          ...current,
          publication: {
            ...appendPublicationJournalEvent(latest, {
              stage: 'LINEAGE_COMMITTED',
              occurredAt: this.#now(),
              observedHash: pending.revisions.at(-1)!.skillBytesDigest,
            }),
            pendingLineage: undefined,
          },
        }
      })
    })
  }

  complete(workItemId: string): Promise<CaptureWorkItemV1> {
    return this.#updateLatest(workItemId, current => {
      const publication = this.#publishing(current)
      if (!publication.journal.some(event => (
        event.attemptId === publication.activeAttemptId && event.stage === 'LINEAGE_COMMITTED'
      ))) throw new PublicationSagaStoreError('INVALID_PUBLICATION_STATE')
      return {
        ...current,
        processingState: 'TERMINAL',
        review: {
          ...current.review!,
          publicationOutcome: 'PUBLISHED',
          failure: undefined,
        },
        publication: appendPublicationJournalEvent(publication, {
          stage: 'OUTCOME_COMMITTED',
          occurredAt: this.#now(),
          observedHash: current.review!.proposal.skillBytesDigest,
        }),
      }
    })
  }

  fail(
    workItemId: string,
    outcome: FailureOutcome,
    code: string,
    retryable: boolean,
  ): Promise<CaptureWorkItemV1> {
    return this.#updateLatest(workItemId, current => {
      const publication = this.#publishing(current)
      return {
        ...current,
        processingState: 'NEEDS_ATTENTION',
        review: {
          ...current.review!,
          publicationOutcome: outcome,
          failure: { code, retryable, occurredAt: this.#now() },
        },
        publication: appendPublicationJournalEvent(publication, {
          stage: 'OUTCOME_COMMITTED',
          occurredAt: this.#now(),
        }),
      }
    })
  }

  retry(
    workItemId: string,
    expectedRevision: number,
    rawRef: ProposalRefV1,
  ): Promise<CaptureWorkItemV1> {
    const parsedRef = ProposalRefV1Schema.safeParse(rawRef)
    if (!parsedRef.success) return Promise.reject(new PublicationSagaStoreError('STALE_PROPOSAL_REF'))
    return this.#updateExpected(workItemId, expectedRevision, current => {
      const review = current.review
      const publication = current.publication
      if (
        current.processingState !== 'NEEDS_ATTENTION'
        || review?.reviewDecision !== 'APPROVED'
        || review.publicationOutcome !== 'PUBLISH_FAILED'
        || review.failure?.retryable !== true
        || publication === undefined
        || !sameRef(proposalRefOf(review.proposal), parsedRef.data)
      ) throw new PublicationSagaStoreError('INVALID_PUBLICATION_STATE')
      let retried
      try {
        retried = beginPublicationRetry(publication, {
          workItemId,
          proposalId: review.proposal.proposalId,
          occurredAt: this.#now(),
        })
      } catch {
        throw new PublicationSagaStoreError('PUBLICATION_RETRY_LIMIT')
      }
      return {
        ...current,
        processingState: 'PUBLISHING',
        review: { ...review, publicationOutcome: 'PENDING_REVIEW', failure: undefined },
        publication: retried,
      }
    })
  }

  async #putLineage(pending: LineageV1): Promise<void> {
    if (!this.#visibility.lineageVisible(pending)) {
      throw new PublicationSagaStoreError('INVALID_PUBLICATION_STATE')
    }
    const current = this.#lineages.get(pending.lineageId)
    if (current !== undefined && !this.#visibility.lineageVisible(current)) {
      throw new PublicationSagaStoreError('INVALID_PUBLICATION_STATE')
    }
    if (current === undefined) {
      await this.#lineages.put(pending.lineageId, pending)
      return
    }
    if (sameJson(current, pending)) return
    const prefix = pending.revisions.slice(0, current.revisions.length)
    if (
      current.targetIdentityDigest !== pending.targetIdentityDigest
      || !sameJson(prefix, current.revisions)
      || pending.currentRevision <= current.currentRevision
    ) throw new PublicationSagaStoreError('LINEAGE_CONFLICT')
    await this.#lineages.update(pending.lineageId, latest => {
      if (!sameJson(latest, current)) throw new PublicationSagaStoreError('LINEAGE_CONFLICT')
      return pending
    })
  }

  #publishing(current: CaptureWorkItemV1) {
    if (
      current.processingState !== 'PUBLISHING'
      || current.review?.reviewDecision !== 'APPROVED'
      || current.review.publicationOutcome !== 'PENDING_REVIEW'
      || current.publication === undefined
    ) throw new PublicationSagaStoreError('INVALID_PUBLICATION_STATE')
    return current.publication
  }

  #required(workItemId: string): CaptureWorkItemV1 {
    const current = this.#workItems.get(workItemId)
    if (current === undefined || !this.#visibility.workItemVisible(current)) {
      throw new PublicationSagaStoreError('PUBLICATION_WORK_ITEM_NOT_FOUND')
    }
    return current
  }

  #updateExpected(
    workItemId: string,
    expectedRevision: number,
    transform: (current: CaptureWorkItemV1) => CaptureWorkItemV1 | undefined,
  ): Promise<CaptureWorkItemV1> {
    return this.#serialize(async () => {
      const current = this.#required(workItemId)
      if (current.revision !== expectedRevision) {
        throw new PublicationSagaStoreError('PUBLICATION_REVISION_CONFLICT')
      }
      return await this.#updateNow(workItemId, transform)
    })
  }

  #updateLatest(
    workItemId: string,
    transform: (current: CaptureWorkItemV1) => CaptureWorkItemV1 | undefined,
  ): Promise<CaptureWorkItemV1> {
    return this.#serialize(async () => await this.#updateNow(workItemId, transform))
  }

  async #updateNow(
    workItemId: string,
    transform: (current: CaptureWorkItemV1) => CaptureWorkItemV1 | undefined,
  ): Promise<CaptureWorkItemV1> {
    const snapshot = this.#required(workItemId)
    const next = transform(snapshot)
    if (next === undefined) return snapshot
    const updated = await this.#workItems.update(workItemId, current => {
      if (current.revision !== snapshot.revision) {
        throw new PublicationSagaStoreError('PUBLICATION_REVISION_CONFLICT')
      }
      return CaptureWorkItemV1Schema.parse({
        ...next,
        revision: current.revision + 1,
        updatedAt: this.#now(),
      })
    })
    return updated
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation)
    this.#tail = result.then(() => {}, () => {})
    return result
  }
}
