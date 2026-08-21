import { CaptureWorkItemV1Schema, type CaptureWorkItemV1 } from '../../domain/observe/schemas.js'
import type {
  ExperienceRecordV1,
  LearningCallV1,
  LearningFailureV1,
  LearningProposalV1,
  LearningStateV1,
} from '../../domain/learn/index.js'
import {
  isIgnoredLearningFailure,
  manualLearningAuthorizationSourceRevision,
  manualLearningAuthorizationTimestamp,
  nextLearningRequestKind,
} from '../../domain/learn/index.js'
import type { Run2skillDomain } from './types.js'
import { PurgeVisibility } from './purge-visibility.js'

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
  readonly #visibility
  readonly #runMutation
  #tail: Promise<void> = Promise.resolve()

  constructor(
    domain: Run2skillDomain,
    now: (() => string) | undefined = undefined,
    visibility: PurgeVisibility = new PurgeVisibility(domain),
    runMutation: <T>(operation: () => Promise<T>) => Promise<T> = operation => operation(),
  ) {
    this.#table = domain.table('work_items')
    this.#now = now ?? (() => new Date().toISOString())
    this.#visibility = visibility
    this.#runMutation = runMutation
  }

  get(workItemId: string): CaptureWorkItemV1 | undefined {
    const item = this.#table.get(workItemId)
    return item !== undefined && this.#visibility.workItemVisible(item) ? item : undefined
  }

  listEligible(now: string): CaptureWorkItemV1[] {
    const instant = Date.parse(now)
    if (!Number.isFinite(instant)) throw new TypeError('Invalid eligibility instant')
    return [...this.#table.entries()].map(([, item]) => item).filter(item => (
      this.#visibility.workItemVisible(item)
      && item.processingState === 'CAPTURED'
      && item.captureReason === 'CHEAP_TRIGGER'
      && item.scanStatus === 'COMPLETE'
      && item.evidenceRefs.length > 0
      && (item.learning?.attempt ?? 0) < 3
      && (item.learning?.requestBudgetUsed ?? 0) < 2
      && nextLearningRequestKind(item.learning) !== undefined
      && (item.learning?.nextEligibleAt === undefined
        || Date.parse(item.learning.nextEligibleAt) <= instant)
    )).sort((left, right) => (
      left.signalKey.turnEndSeq - right.signalKey.turnEndSeq
      || Date.parse(left.createdAt) - Date.parse(right.createdAt)
      || left.workItemId.localeCompare(right.workItemId)
    ))
  }

  nextEligibleAt(now: string): string | undefined {
    const instant = Date.parse(now)
    if (!Number.isFinite(instant)) throw new TypeError('Invalid eligibility instant')
    let next: string | undefined
    for (const [, item] of this.#table.entries()) {
      if (!this.#visibility.workItemVisible(item)) continue
      const candidate = item.learning?.nextEligibleAt
      if (
        item.processingState !== 'CAPTURED'
        || item.captureReason !== 'CHEAP_TRIGGER'
        || item.scanStatus !== 'COMPLETE'
        || candidate === undefined
        || Date.parse(candidate) <= instant
      ) continue
      if (next === undefined || Date.parse(candidate) < Date.parse(next)) next = candidate
    }
    return next
  }

  claim(workItemId: string, expectedRevision: number): Promise<CaptureWorkItemV1> {
    return this.#update(workItemId, expectedRevision, (current) => {
      if (!this.#visibility.workItemVisible(current)) {
        throw new LearningStoreError('INVALID_LEARNING_STATE')
      }
      if (current.processingState !== 'CAPTURED' || current.scanStatus !== 'COMPLETE') {
        throw new LearningStoreError('INVALID_LEARNING_STATE')
      }
      const previous = current.learning
      const manualSourceRevision = manualLearningAuthorizationSourceRevision(previous)
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
          ...previous,
          policyVersion: 'learning-v1',
          attempt,
          requestBudgetUsed: previous?.requestBudgetUsed ?? 0,
          claimedAt,
          calls: previous?.calls ?? [],
          ...(previous?.modelRoute === undefined ? {} : { modelRoute: previous.modelRoute }),
          nextEligibleAt: manualSourceRevision === undefined ? undefined : previous?.nextEligibleAt,
          failure: undefined,
          publicationOutcome: undefined,
          experiences: undefined,
          proposal: undefined,
        },
      }
    })
  }

  reserveRequest(
    workItemId: string,
    expectedRevision: number,
    modelRoute: { readonly provider: string; readonly model: string },
  ): Promise<CaptureWorkItemV1> {
    return this.#update(workItemId, expectedRevision, (current) => {
      const learning = this.#analyzing(current)
      if (learning.requestBudgetUsed >= 2) {
        throw new LearningStoreError('LEARNING_REQUEST_BUDGET_EXHAUSTED')
      }
      if (
        learning.modelRoute !== undefined
        && (
          learning.modelRoute.provider !== modelRoute.provider
          || learning.modelRoute.model !== modelRoute.model
        )
      ) throw new LearningStoreError('INVALID_LEARNING_STATE')
      return {
        ...current,
        learning: {
          ...learning,
          modelRoute,
          requestBudgetUsed: learning.requestBudgetUsed + 1,
        },
      }
    })
  }

  recordCall(
    workItemId: string,
    expectedRevision: number,
    call: LearningCallV1,
    failure?: LearningFailureV1,
  ): Promise<CaptureWorkItemV1> {
    return this.#update(workItemId, expectedRevision, (current) => {
      const learning = this.#analyzing(current)
      if (
        call.requestOrdinal > learning.requestBudgetUsed
        || learning.calls.some(existing => existing.requestOrdinal === call.requestOrdinal)
      ) throw new LearningStoreError('INVALID_LEARNING_STATE')
      return {
        ...current,
        learning: withoutUndefined({
          ...learning,
          calls: [...learning.calls, call],
          failure,
        }),
      }
    })
  }

  recordCallLatest(
    workItemId: string,
    expectedAttempt: number,
    call: LearningCallV1,
    failure?: LearningFailureV1,
  ): Promise<CaptureWorkItemV1> {
    return this.#updateLatest(workItemId, (current) => {
      const learning = this.#analyzing(current)
      if (
        learning.attempt !== expectedAttempt
        || call.requestOrdinal > learning.requestBudgetUsed
        || learning.calls.some(existing => existing.requestOrdinal === call.requestOrdinal)
      ) throw new LearningStoreError('INVALID_LEARNING_STATE')
      return {
        ...current,
        learning: withoutUndefined({
          ...learning,
          calls: [...learning.calls, call],
          failure,
        }),
      }
    })
  }

  complete(
    workItemId: string,
    expectedRevision: number,
    facts: LearningResultFacts,
  ): Promise<CaptureWorkItemV1> {
    return this.#runMutation(async () => await this.#update(workItemId, expectedRevision, (current) => {
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
    }))
  }

  fail(
    workItemId: string,
    expectedRevision: number,
    failure: LearningFailureV1,
    nextEligibleAt?: string,
  ): Promise<CaptureWorkItemV1> {
    return this.#update(workItemId, expectedRevision, (current) => {
      const learning = this.#analyzing(current)
      const failedLearning = { ...learning, failure }
      const manualSourceRevision = manualLearningAuthorizationSourceRevision(learning)
      const retry = failure.retryable
        && nextEligibleAt !== undefined
        && learning.attempt < 3
        && learning.requestBudgetUsed < 2
        && nextLearningRequestKind(failedLearning) !== undefined
      if (retry) {
        return {
          ...current,
          processingState: 'CAPTURED',
          learning: withoutUndefined({
            ...failedLearning,
            claimedAt: undefined,
            nextEligibleAt,
          }),
        }
      }
      return {
        ...current,
        processingState: 'NEEDS_ATTENTION',
        learning: withoutUndefined({
          ...failedLearning,
          claimedAt: undefined,
          nextEligibleAt: manualSourceRevision === undefined ? undefined : learning.nextEligibleAt,
          publicationOutcome: 'NEEDS_ATTENTION' as const,
        }),
      }
    })
  }

  async recoverInterrupted(): Promise<CaptureWorkItemV1[]> {
    const recovered: CaptureWorkItemV1[] = []
    for (const [workItemId, item] of this.#table.entries()) {
      if (!this.#visibility.workItemVisible(item)) continue
      if (item.processingState !== 'ANALYZING') continue
      const nextKind = nextLearningRequestKind(item.learning)
      if (nextKind === 'TRUNCATION_RECOVERY') {
        recovered.push(await this.#update(workItemId, item.revision, (current) => ({
          ...current,
          processingState: 'CAPTURED',
          learning: withoutUndefined({
            ...current.learning!,
            claimedAt: undefined,
            nextEligibleAt: this.#now(),
          }),
        })))
        continue
      }
      const failure: LearningFailureV1 = {
        code: 'MODEL_ABORTED',
        retryable: nextKind === 'PRIMARY',
        occurredAt: this.#now(),
      }
      recovered.push(await this.fail(
        workItemId,
        item.revision,
        failure,
        nextKind === 'PRIMARY' ? this.#now() : undefined,
      ))
    }
    return recovered
  }

  async resumeAvailableAgentScopes(
    available: (item: CaptureWorkItemV1) => boolean,
  ): Promise<CaptureWorkItemV1[]> {
    const reopened: CaptureWorkItemV1[] = []
    for (const [workItemId, snapshot] of this.#table.entries()) {
      if (!this.#visibility.workItemVisible(snapshot)) continue
      if (
        snapshot.processingState !== 'NEEDS_ATTENTION'
        || snapshot.learning?.failure?.code !== 'AGENT_SCOPE_UNAVAILABLE'
        || snapshot.learning.attempt >= 3
        || snapshot.learning.requestBudgetUsed >= 2
        || !available(snapshot)
      ) continue
      reopened.push(await this.#updateLatest(workItemId, (current) => {
        const learning = current.learning
        if (
          current.processingState !== 'NEEDS_ATTENTION'
          || learning?.failure?.code !== 'AGENT_SCOPE_UNAVAILABLE'
        ) throw new LearningStoreError('INVALID_LEARNING_STATE')
        return {
          ...current,
          processingState: 'CAPTURED',
          learning: withoutUndefined({
            ...learning,
            claimedAt: undefined,
            nextEligibleAt: undefined,
            failure: undefined,
            publicationOutcome: undefined,
          }),
        }
      }))
    }
    return reopened
  }

  retryFailed(
    workItemId: string,
    expectedRevision: number,
  ): Promise<{ readonly item: CaptureWorkItemV1; readonly changed: boolean }> {
    return this.#attentionMutation(workItemId, expectedRevision, 'RECOVER')
  }

  dismissFailed(
    workItemId: string,
    expectedRevision: number,
  ): Promise<{ readonly item: CaptureWorkItemV1; readonly changed: boolean }> {
    return this.#attentionMutation(workItemId, expectedRevision, 'DISMISS')
  }

  resetStale(workItemId: string, expectedAttempt: number): Promise<CaptureWorkItemV1> {
    return this.#updateLatest(workItemId, (current) => {
      const learning = this.#analyzing(current)
      if (learning.attempt !== expectedAttempt) {
        throw new LearningStoreError('INVALID_LEARNING_STATE')
      }
      const exhausted = learning.attempt >= 3 || learning.requestBudgetUsed >= 2
      const manualSourceRevision = manualLearningAuthorizationSourceRevision(learning)
      return {
        ...current,
        processingState: exhausted ? 'NEEDS_ATTENTION' : 'CAPTURED',
        learning: withoutUndefined({
          ...learning,
          claimedAt: undefined,
          nextEligibleAt: exhausted && manualSourceRevision !== undefined
            ? learning.nextEligibleAt
            : undefined,
          failure: exhausted
            ? {
                code: 'STORE_WRITE_FAILED' as const,
                retryable: false,
                occurredAt: this.#now(),
              }
            : undefined,
          experiences: undefined,
          proposal: undefined,
          publicationOutcome: exhausted ? 'NEEDS_ATTENTION' as const : undefined,
        }),
      }
    })
  }

  #analyzing(current: CaptureWorkItemV1): LearningStateV1 {
    if (current.processingState !== 'ANALYZING' || current.learning === undefined) {
      throw new LearningStoreError('INVALID_LEARNING_STATE')
    }
    return current.learning
  }

  #attentionMutation(
    workItemId: string,
    expectedRevision: number,
    kind: 'RECOVER' | 'DISMISS',
  ): Promise<{ readonly item: CaptureWorkItemV1; readonly changed: boolean }> {
    const operation = this.#tail.then(async () => {
      const snapshot = this.#table.get(workItemId)
      if (snapshot === undefined || !this.#visibility.workItemVisible(snapshot)) {
        throw new LearningStoreError('LEARNING_WORK_ITEM_NOT_FOUND')
      }
      const duplicate = (
        (kind === 'RECOVER'
          && manualLearningAuthorizationSourceRevision(snapshot.learning) === expectedRevision)
        || (
          kind === 'DISMISS'
          && snapshot.revision - expectedRevision === 1
          && isIgnoredLearningFailure(snapshot)
        )
      )
      if (duplicate) return { item: snapshot, changed: false }
      if (snapshot.revision !== expectedRevision) {
        throw new LearningStoreError('LEARNING_REVISION_CONFLICT')
      }
      if (
        snapshot.processingState !== 'NEEDS_ATTENTION'
        || snapshot.review !== undefined
        || snapshot.learning?.failure === undefined
      ) throw new LearningStoreError('INVALID_LEARNING_STATE')
      if (
        kind === 'RECOVER'
        && (
          snapshot.learning.failure.retryable !== true
          || snapshot.learning.attempt >= 3
        )
      ) throw new LearningStoreError('INVALID_LEARNING_STATE')
      const updatedAt = this.#now()
      const manualAuthorization = kind === 'RECOVER'
        ? manualLearningAuthorizationTimestamp(expectedRevision)
        : undefined
      if (kind === 'RECOVER' && manualAuthorization === undefined) {
        throw new LearningStoreError('INVALID_LEARNING_STATE')
      }
      const item = await this.#table.update(workItemId, (current) => {
        if (current.revision !== expectedRevision || current.processingState !== 'NEEDS_ATTENTION') {
          throw new LearningStoreError('LEARNING_REVISION_CONFLICT')
        }
        const learning = current.learning
        if (learning?.failure === undefined) throw new LearningStoreError('INVALID_LEARNING_STATE')
        const next = kind === 'RECOVER'
          ? {
              ...current,
              processingState: 'CAPTURED' as const,
              learning: withoutUndefined({
                ...learning,
                attempt: 2,
                requestBudgetUsed: 0,
                calls: [],
                claimedAt: undefined,
                nextEligibleAt: manualAuthorization!,
                experiences: undefined,
                proposal: undefined,
                publicationOutcome: undefined,
              }),
            }
          : {
              ...current,
              processingState: 'NEEDS_ATTENTION' as const,
              learning: withoutUndefined({
                ...learning,
                claimedAt: undefined,
                nextEligibleAt: learning.failure.occurredAt,
              }),
            }
        return CaptureWorkItemV1Schema.parse({
          ...next,
          revision: current.revision + 1,
          updatedAt,
        })
      })
      return { item, changed: true }
    })
    this.#tail = operation.then(() => {}, () => {})
    return operation
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
        if (!this.#visibility.workItemVisible(current)) {
          throw new LearningStoreError('INVALID_LEARNING_STATE')
        }
        if (current.revision !== expectedRevision) {
          throw new LearningStoreError('LEARNING_REVISION_CONFLICT')
        }
        const next = transform(current)
        if (this.#visibility.workItemWasPurged(next)) {
          throw new LearningStoreError('INVALID_LEARNING_STATE')
        }
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

  #updateLatest(
    workItemId: string,
    transform: (current: CaptureWorkItemV1) => CaptureWorkItemV1,
  ): Promise<CaptureWorkItemV1> {
    const operation = this.#tail.then(async () => {
      if (this.#table.get(workItemId) === undefined) {
        throw new LearningStoreError('LEARNING_WORK_ITEM_NOT_FOUND')
      }
      return await this.#table.update(workItemId, (current) => {
        if (!this.#visibility.workItemVisible(current)) {
          throw new LearningStoreError('INVALID_LEARNING_STATE')
        }
        const next = transform(current)
        if (this.#visibility.workItemWasPurged(next)) {
          throw new LearningStoreError('INVALID_LEARNING_STATE')
        }
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
