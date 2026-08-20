import { CaptureWorkItemV1Schema, type CaptureWorkItemV1 } from '../../domain/observe/schemas.js'
import {
  ProposalRefV1Schema,
  ProposalSnapshotV1Schema,
  deriveProposalId,
  proposalFactsOf,
  proposalRefOf,
  type ProposalRefV1,
  type ProposalSnapshotV1,
  type ReviewStateV1,
} from '../../domain/review/index.js'
import type { Run2skillDomain } from './types.js'
import {
  createPublicationState,
  derivePublicationTargetIdentityDigest,
} from '../../domain/publication/index.js'

export type ProposalReviewStoreErrorCode =
  | 'REVIEW_WORK_ITEM_NOT_FOUND'
  | 'REVIEW_REVISION_CONFLICT'
  | 'INVALID_PROPOSAL_SNAPSHOT'
  | 'STALE_PROPOSAL_REF'
  | 'INVALID_REVIEW_STATE'

export class ProposalReviewStoreError extends Error {
  constructor(readonly code: ProposalReviewStoreErrorCode) {
    super(code)
    this.name = 'ProposalReviewStoreError'
  }
}

export interface ProposalReviewStoreResult {
  readonly item: CaptureWorkItemV1
  readonly changed: boolean
}

function sameRef(left: ProposalRefV1, right: ProposalRefV1): boolean {
  return left.proposalId === right.proposalId
    && left.revision === right.revision
    && left.digest === right.digest
}

export class ProposalReviewStore {
  readonly #table
  readonly #now
  #tail: Promise<void> = Promise.resolve()

  constructor(domain: Run2skillDomain, now: () => string = () => new Date().toISOString()) {
    this.#table = domain.table('work_items')
    this.#now = now
  }

  stage(
    workItemId: string,
    expectedRevision: number,
    candidate: ProposalSnapshotV1,
  ): Promise<ProposalReviewStoreResult> {
    const parsed = ProposalSnapshotV1Schema.safeParse(candidate)
    if (!parsed.success) {
      return Promise.reject(new ProposalReviewStoreError('INVALID_PROPOSAL_SNAPSHOT'))
    }
    return this.#serialize(async () => {
      const current = this.#required(workItemId)
      if (
        current.review !== undefined
        && sameRef(proposalRefOf(current.review.proposal), proposalRefOf(parsed.data))
      ) {
        return { item: current, changed: false }
      }
      this.#expectRevision(current, expectedRevision)
      if (
        current.processingState !== 'LEARNED'
        || current.review !== undefined
        || current.learning?.proposal === undefined
        || current.learning.proposal.learningProposalId !== parsed.data.sourceLearningProposalId
        || parsed.data.proposalId !== deriveProposalId(workItemId, proposalFactsOf(parsed.data))
        || parsed.data.revision !== 1
        || parsed.data.persistenceScope !== current.learning.proposal.persistenceScope
        || JSON.stringify(parsed.data.supportingExperienceIds)
          !== JSON.stringify(current.learning.proposal.supportingExperienceIds)
        || (
          parsed.data.persistenceScope === 'PROJECT'
          && (
            current.workspaceBinding.status !== 'BOUND'
            || parsed.data.workspaceBinding?.workspaceId !== current.workspaceBinding.workspaceId
            || parsed.data.workspaceBinding.canonicalPath !== current.workspaceBinding.canonicalPath
          )
        )
      ) throw new ProposalReviewStoreError('INVALID_REVIEW_STATE')
      return await this.#update(workItemId, current, {
        ...current,
        processingState: 'READY_FOR_REVIEW',
        review: {
          policyVersion: 'review-v1',
          proposal: parsed.data,
          reviewDecision: 'PENDING',
          publicationOutcome: 'PENDING_REVIEW',
          coverageRetryCount: 0,
        },
      })
    })
  }

  approve(
    workItemId: string,
    expectedRevision: number,
    ref: ProposalRefV1,
  ): Promise<ProposalReviewStoreResult> {
    return this.#mutate(workItemId, expectedRevision, ref, (current, review) => {
      if (
        current.processingState === 'PUBLISHING'
        && review.reviewDecision === 'APPROVED'
      ) return undefined
      if (
        current.processingState !== 'READY_FOR_REVIEW'
        || review.reviewDecision !== 'PENDING'
        || review.publicationOutcome !== 'PENDING_REVIEW'
        || review.proposal.kind === 'DISCARD'
        || review.proposal.actionBinding.kind === 'DISCARD'
      ) throw new ProposalReviewStoreError('INVALID_REVIEW_STATE')
      const actionBinding = review.proposal.actionBinding
      return {
        ...current,
        processingState: 'PUBLISHING',
        review: { ...review, reviewDecision: 'APPROVED', decidedAt: this.#now() },
        publication: createPublicationState({
          workItemId,
          proposalId: review.proposal.proposalId,
          targetIdentityDigest: derivePublicationTargetIdentityDigest({
            scope: review.proposal.persistenceScope,
            provider: actionBinding.rootBinding.provider,
            source: actionBinding.rootBinding.source,
            skillName: review.proposal.name,
            canonicalTargetPath: actionBinding.targetBinding.skillFilePath,
          }),
          occurredAt: this.#now(),
        }),
      }
    })
  }

  reject(
    workItemId: string,
    expectedRevision: number,
    ref: ProposalRefV1,
  ): Promise<ProposalReviewStoreResult> {
    return this.#mutate(workItemId, expectedRevision, ref, (current, review) => {
      if (
        current.processingState === 'TERMINAL'
        && review.reviewDecision === 'REJECTED'
        && review.decisionReason === 'USER_REJECTED'
      ) return undefined
      if (
        current.processingState !== 'READY_FOR_REVIEW'
        || review.reviewDecision !== 'PENDING'
        || review.publicationOutcome !== 'PENDING_REVIEW'
      ) throw new ProposalReviewStoreError('INVALID_REVIEW_STATE')
      return {
        ...current,
        processingState: 'TERMINAL',
        review: {
          ...review,
          reviewDecision: 'REJECTED',
          publicationOutcome: 'DISCARDED',
          decisionReason: 'USER_REJECTED',
          decidedAt: this.#now(),
        },
      }
    })
  }

  confirmCoverage(
    workItemId: string,
    expectedRevision: number,
    ref: ProposalRefV1,
  ): Promise<ProposalReviewStoreResult> {
    return this.#mutate(workItemId, expectedRevision, ref, (current, review) => {
      if (
        current.processingState === 'TERMINAL'
        && review.reviewDecision === 'REJECTED'
        && review.decisionReason === 'COVERAGE_CONFIRMED'
      ) return undefined
      if (
        current.processingState !== 'READY_FOR_REVIEW'
        || review.reviewDecision !== 'PENDING'
        || review.publicationOutcome !== 'PENDING_REVIEW'
        || review.proposal.kind !== 'DISCARD'
      ) throw new ProposalReviewStoreError('INVALID_REVIEW_STATE')
      return {
        ...current,
        processingState: 'TERMINAL',
        review: {
          ...review,
          reviewDecision: 'REJECTED',
          publicationOutcome: 'DISCARDED',
          decisionReason: 'COVERAGE_CONFIRMED',
          decidedAt: this.#now(),
        },
      }
    })
  }

  requestCoverageRetry(
    workItemId: string,
    expectedRevision: number,
    ref: ProposalRefV1,
  ): Promise<ProposalReviewStoreResult> {
    return this.#mutate(workItemId, expectedRevision, ref, (current, review) => {
      if (
        current.processingState === 'NEEDS_ATTENTION'
        && review.coverageRetryCount === 1
        && review.failure?.code === 'COVERAGE_REANALYSIS_REQUESTED'
      ) return undefined
      if (
        current.processingState !== 'READY_FOR_REVIEW'
        || review.reviewDecision !== 'PENDING'
        || review.publicationOutcome !== 'PENDING_REVIEW'
        || review.proposal.kind !== 'DISCARD'
        || review.coverageRetryCount !== 0
      ) throw new ProposalReviewStoreError('INVALID_REVIEW_STATE')
      return {
        ...current,
        processingState: 'NEEDS_ATTENTION',
        review: {
          ...review,
          publicationOutcome: 'NEEDS_ATTENTION',
          coverageRetryCount: 1,
          failure: {
            code: 'COVERAGE_REANALYSIS_REQUESTED',
            retryable: true,
            occurredAt: this.#now(),
          },
        },
      }
    })
  }

  #mutate(
    workItemId: string,
    expectedRevision: number,
    rawRef: ProposalRefV1,
    transform: (current: CaptureWorkItemV1, review: ReviewStateV1) => CaptureWorkItemV1 | undefined,
  ): Promise<ProposalReviewStoreResult> {
    const parsedRef = ProposalRefV1Schema.safeParse(rawRef)
    if (!parsedRef.success) {
      return Promise.reject(new ProposalReviewStoreError('STALE_PROPOSAL_REF'))
    }
    return this.#serialize(async () => {
      const current = this.#required(workItemId)
      const review = current.review
      if (review === undefined || !sameRef(proposalRefOf(review.proposal), parsedRef.data)) {
        throw new ProposalReviewStoreError('STALE_PROPOSAL_REF')
      }
      const next = transform(current, review)
      if (next === undefined) return { item: current, changed: false }
      this.#expectRevision(current, expectedRevision)
      return await this.#update(workItemId, current, next)
    })
  }

  #required(workItemId: string): CaptureWorkItemV1 {
    const current = this.#table.get(workItemId)
    if (current === undefined) throw new ProposalReviewStoreError('REVIEW_WORK_ITEM_NOT_FOUND')
    return current
  }

  #expectRevision(current: CaptureWorkItemV1, expectedRevision: number): void {
    if (current.revision !== expectedRevision) {
      throw new ProposalReviewStoreError('REVIEW_REVISION_CONFLICT')
    }
  }

  async #update(
    workItemId: string,
    current: CaptureWorkItemV1,
    next: CaptureWorkItemV1,
  ): Promise<ProposalReviewStoreResult> {
    const item = await this.#table.update(workItemId, latest => {
      if (latest.revision !== current.revision) {
        throw new ProposalReviewStoreError('REVIEW_REVISION_CONFLICT')
      }
      return CaptureWorkItemV1Schema.parse({
        ...next,
        revision: latest.revision + 1,
        updatedAt: this.#now(),
      })
    })
    return { item, changed: true }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation)
    this.#tail = result.then(() => {}, () => {})
    return result
  }
}
