import {
  LearningDiagnosticRecordV1Schema,
  isIgnoredLearningFailure,
  type LearningDiagnosticRecordV1,
  type LearningTerminalDetailV1,
} from '../../domain/learn/index.js'
import type { CaptureWorkItemV1 } from '../../domain/observe/schemas.js'
import type { LearningDiagnosticDomain } from './learning-diagnostic-domain.js'
import type { Run2skillDomain } from './types.js'

export type LearningDiagnosticStoreErrorCode =
  | 'DIAGNOSTIC_MAIN_FACT_CONFLICT'
  | 'DIAGNOSTIC_RECORD_CONFLICT'

export class LearningDiagnosticStoreError extends Error {
  constructor(readonly code: LearningDiagnosticStoreErrorCode) {
    super(code)
    this.name = 'LearningDiagnosticStoreError'
  }
}

export function createLearningDiagnosticKey(
  workItemId: string,
  attempt: number,
  requestOrdinal: 1 | 2,
): string {
  return `${workItemId}:${attempt}:${requestOrdinal}`
}

function expectedFailureCode(detail: LearningTerminalDetailV1) {
  return detail === 'MODEL_STREAM_FAILURE' ? 'MODEL_ABORTED' as const : 'MODEL_TERMINAL_FAILURE' as const
}

function matchingCall(item: CaptureWorkItemV1, ordinal: 1 | 2) {
  return item.learning?.calls.find(call => call.requestOrdinal === ordinal)
}

function recordStillMatches(item: CaptureWorkItemV1, record: LearningDiagnosticRecordV1): boolean {
  const learning = item.learning
  const call = matchingCall(item, record.requestOrdinal)
  return item.revision >= record.workItemRevision
    && learning?.attempt === record.attempt
    && call?.kind === record.callKind
    && call.outcome === record.callOutcome
    && learning.failure?.code === record.failureCode
    && learning.failure.occurredAt === record.failureOccurredAt
}

function recordVisibleFor(item: CaptureWorkItemV1, record: LearningDiagnosticRecordV1): boolean {
  return item.processingState === 'NEEDS_ATTENTION'
    && !isIgnoredLearningFailure(item)
    && recordStillMatches(item, record)
}

export class LearningDiagnosticStore {
  readonly #table
  readonly #runMutation

  constructor(
    private readonly main: Run2skillDomain,
    sidecar: LearningDiagnosticDomain,
    runMutation: <T>(operation: () => Promise<T>) => Promise<T> = async operation => await operation(),
  ) {
    this.#table = sidecar.table('terminal_details')
    this.#runMutation = runMutation
  }

  attach(
    item: CaptureWorkItemV1,
    requestOrdinal: 1 | 2,
    detail: LearningTerminalDetailV1,
  ): Promise<{ readonly changed: boolean }> {
    return this.#runMutation(async () => {
      const current = this.main.table('work_items').get(item.workItemId)
      const call = matchingCall(item, requestOrdinal)
      const failure = item.learning?.failure
      const record = item.learning === undefined || call === undefined || failure === undefined
        ? undefined
        : LearningDiagnosticRecordV1Schema.parse({
            schemaVersion: 1,
            workItemId: item.workItemId,
            workItemRevision: item.revision,
            attempt: item.learning.attempt,
            requestOrdinal,
            callKind: call.kind,
            callOutcome: call.outcome,
            failureCode: failure.code,
            failureOccurredAt: failure.occurredAt,
            detail,
          })
      if (
        current === undefined
        || current.revision !== item.revision
        || (item.processingState !== 'ANALYZING' && item.processingState !== 'NEEDS_ATTENTION')
        || isIgnoredLearningFailure(item)
        || record === undefined
        || record.failureCode !== expectedFailureCode(detail)
        || !recordStillMatches(current, record)
      ) throw new LearningDiagnosticStoreError('DIAGNOSTIC_MAIN_FACT_CONFLICT')
      const key = createLearningDiagnosticKey(item.workItemId, record.attempt, requestOrdinal)
      const existing = this.#table.get(key)
      if (existing !== undefined) {
        if (JSON.stringify(existing) === JSON.stringify(record)) return { changed: false }
        throw new LearningDiagnosticStoreError('DIAGNOSTIC_RECORD_CONFLICT')
      }
      await this.#table.put(key, record)
      return { changed: true }
    })
  }

  detailFor(item: CaptureWorkItemV1): LearningTerminalDetailV1 | undefined {
    const learning = item.learning
    if (learning === undefined) return undefined
    for (const call of learning.calls) {
      const record = this.#table.get(createLearningDiagnosticKey(item.workItemId, learning.attempt, call.requestOrdinal))
      if (record !== undefined && recordVisibleFor(item, record)) return record.detail
    }
    return undefined
  }

  deleteWorkItem(workItemId: string): Promise<void> {
    return this.#runMutation(async () => await this.deleteWorkItemWithinMutation(workItemId))
  }

  async deleteWorkItemWithinMutation(workItemId: string): Promise<void> {
    for (const [key, record] of this.#table.entries()) {
      if (record.workItemId === workItemId) await this.#table.delete(key)
    }
  }

  cleanupOrphans(): Promise<{ readonly deleted: number }> {
    return this.#runMutation(async () => {
      let deleted = 0
      for (const [key, record] of this.#table.entries()) {
        if (this.main.table('work_items').get(record.workItemId) !== undefined) continue
        if (await this.#table.delete(key)) deleted += 1
      }
      return { deleted }
    })
  }
}
