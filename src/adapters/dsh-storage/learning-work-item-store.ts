import { CaptureWorkItemV1Schema, type CaptureWorkItemV1 } from '../../domain/observe/schemas.js'
import type {
  ExperienceRecordV1,
  LearningCallV1,
  LearningFailureV1,
  LearningProposalV1,
  LearningStateV1,
} from '../../domain/learn/index.js'
import type { Run2skillDomain } from './types.js'

export type LearningStoreErrorCode =
  | 'LEARNING_WORK_ITEM_NOT_FOUND'
  | 'LEARNING_REVISION_CONFLICT'
  | 'INVALID_LEARNING_STATE'
  | 'LEARNING_REQUEST_BUDGET_EXHAUSTED'

export class LearningStoreError extends Error {
  constructor(readonly code: LearningStoreErrorCode) {
    super(code)
    this.name = 'LearningStoreError'
  }
}

export interface LearningResultFacts {
  readonly experiences: readonly ExperienceRecordV1[]
  readonly proposal: LearningProposalV1
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

export class LearningWorkItemStore {
  readonly #table
  readonly #now
  #tail: Promise<void> = Promise.resolve()

  constructor(domain: Run2skillDomain, now: () => string = () => new Date().toISOString()) {
    this.#table = domain.table('work_items')
    this.#now = now
  }

  get(workItemId: string): CaptureWorkItemV1 | undefined {
    return this.#table.get(workItemId)
  }

  claim(workItemId: string, expectedRevision: number): Promise<CaptureWorkItemV1> {
    return this.#update(workItemId, expectedRevision, (current) => {
      if (current.processingState !== 'CAPTURED' || current.scanStatus !== 'COMPLETE') {
        throw new LearningStoreError('INVALID_LEARNING_STATE')
      }
      const previous = current.learning
      const claimedAt = this.#now()
      if (
        previous?.nextEligibleAt !== undefined
        && Date.parse(previous.nextEligibleAt) > Date.parse(claimedAt)
      ) throw new LearningStoreError('INVALID_LEARNING_STATE')
      const attempt = (previous?.attempt ?? 0) + 1
      if (attempt > 3) throw new LearningStoreError('INVALID_LEARNING_STATE')
      return {
        ...current,
        processingState: 'ANALYZING',
        learning: {
          policyVersion: 'learning-v1',
          attempt,
          requestBudgetUsed: previous?.requestBudgetUsed ?? 0,
          claimedAt,
          calls: previous?.calls ?? [],
          ...(previous?.modelRoute === undefined ? {} : { modelRoute: previous.modelRoute }),
        },
      }
    })
  }

  reserveRequest(workItemId: string, expectedRevision: number): Promise<CaptureWorkItemV1> {
    return this.#update(workItemId, expectedRevision, (current) => {
      const learning = this.#analyzing(current)
      if (learning.requestBudgetUsed >= 2) {
        throw new LearningStoreError('LEARNING_REQUEST_BUDGET_EXHAUSTED')
      }
      return { ...current, learning: { ...learning, requestBudgetUsed: learning.requestBudgetUsed + 1 } }
    })
  }

  recordCall(
    workItemId: string,
    expectedRevision: number,
    call: LearningCallV1,
  ): Promise<CaptureWorkItemV1> {
    return this.#update(workItemId, expectedRevision, (current) => {
      const learning = this.#analyzing(current)
      if (
        call.requestOrdinal > learning.requestBudgetUsed
        || learning.calls.some(existing => existing.requestOrdinal === call.requestOrdinal)
      ) throw new LearningStoreError('INVALID_LEARNING_STATE')
      return { ...current, learning: { ...learning, calls: [...learning.calls, call] } }
    })
  }

  complete(
    workItemId: string,
    expectedRevision: number,
    facts: LearningResultFacts,
  ): Promise<CaptureWorkItemV1> {
    return this.#update(workItemId, expectedRevision, (current) => {
      const learning = this.#analyzing(current)
      if (
        learning.requestBudgetUsed === 0
        || !learning.calls.some(call => (
          call.requestOrdinal === learning.requestBudgetUsed
          && call.outcome === 'SUCCEEDED'
        ))
      ) throw new LearningStoreError('INVALID_LEARNING_STATE')
      return {
        ...current,
        processingState: 'LEARNED',
        learning: {
          ...learning,
          experiences: [...facts.experiences],
          proposal: facts.proposal,
        },
      }
    })
  }

  fail(
    workItemId: string,
    expectedRevision: number,
    failure: LearningFailureV1,
    nextEligibleAt?: string,
  ): Promise<CaptureWorkItemV1> {
    return this.#update(workItemId, expectedRevision, (current) => {
      const learning = this.#analyzing(current)
      const retry = failure.retryable
        && nextEligibleAt !== undefined
        && learning.attempt < 3
        && learning.requestBudgetUsed < 2
      if (retry) {
        return {
          ...current,
          processingState: 'CAPTURED',
          learning: withoutUndefined({
            ...learning,
            claimedAt: undefined,
            nextEligibleAt,
            failure,
          }),
        }
      }
      return {
        ...current,
        processingState: 'NEEDS_ATTENTION',
        learning: withoutUndefined({
          ...learning,
          claimedAt: undefined,
          nextEligibleAt: undefined,
          failure,
          publicationOutcome: 'NEEDS_ATTENTION' as const,
        }),
      }
    })
  }

  async recoverInterrupted(): Promise<CaptureWorkItemV1[]> {
    const recovered: CaptureWorkItemV1[] = []
    for (const [workItemId, item] of this.#table.entries()) {
      if (item.processingState !== 'ANALYZING') continue
      const failure: LearningFailureV1 = {
        code: 'MODEL_ABORTED', retryable: true, occurredAt: this.#now(),
      }
      recovered.push(await this.fail(workItemId, item.revision, failure, this.#now()))
    }
    return recovered
  }

  #analyzing(current: CaptureWorkItemV1): LearningStateV1 {
    if (current.processingState !== 'ANALYZING' || current.learning === undefined) {
      throw new LearningStoreError('INVALID_LEARNING_STATE')
    }
    return current.learning
  }

  #update(
    workItemId: string,
    expectedRevision: number,
    transform: (current: CaptureWorkItemV1) => CaptureWorkItemV1,
  ): Promise<CaptureWorkItemV1> {
    const operation = this.#tail.then(async () => {
      if (this.#table.get(workItemId) === undefined) {
        throw new LearningStoreError('LEARNING_WORK_ITEM_NOT_FOUND')
      }
      return await this.#table.update(workItemId, (current) => {
        if (current.revision !== expectedRevision) {
          throw new LearningStoreError('LEARNING_REVISION_CONFLICT')
        }
        const next = transform(current)
        return CaptureWorkItemV1Schema.parse({
          ...next,
          revision: current.revision + 1,
          updatedAt: this.#now(),
        })
      })
    })
    this.#tail = operation.then(() => {}, () => {})
    return operation
  }
}
