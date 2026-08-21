import type { CaptureWorkItemV1 } from '../observe/schemas.js'
import type { LearningStateV1 } from './schemas.js'

export type NextLearningRequestKind = 'PRIMARY' | 'TRUNCATION_RECOVERY'
const MANUAL_RECOVERY_REVISION_CEILING = Date.parse('2000-01-01T00:00:00.000Z')
/** Encodes an action source revision in an existing schema-v1 timestamp slot. */
export function manualLearningAuthorizationTimestamp(sourceRevision: number): string | undefined {
  if (
    !Number.isSafeInteger(sourceRevision)
    || sourceRevision < 1
    || sourceRevision >= MANUAL_RECOVERY_REVISION_CEILING
  ) return undefined
  return new Date(sourceRevision).toISOString()
}

/** Decodes the schema-v1-compatible authorization marker without adding fields. */
export function manualLearningAuthorizationSourceRevision(
  learning: LearningStateV1 | undefined,
): number | undefined {
  if (learning?.nextEligibleAt === undefined || learning.attempt < 2) return undefined
  const revision = Date.parse(learning.nextEligibleAt)
  return manualLearningAuthorizationTimestamp(revision) === learning.nextEligibleAt
    ? revision
    : undefined
}

export function nextLearningRequestKind(
  learning: LearningStateV1 | undefined,
): NextLearningRequestKind | undefined {
  if (learning === undefined) return 'PRIMARY'
  if (learning.requestBudgetUsed === 0) return learning.calls.length === 0 ? 'PRIMARY' : undefined
  if (learning.requestBudgetUsed !== 1 || learning.calls.length !== 1) return undefined
  const first = learning.calls[0]
  return first?.requestOrdinal === 1
    && first.kind === 'PRIMARY'
    && first.outcome === 'ABORTED'
    && learning.failure?.code === 'MODEL_OUTPUT_LIMIT_EXCEEDED'
    ? 'TRUNCATION_RECOVERY'
    : undefined
}

export function hasManualLearningAuthorization(item: CaptureWorkItemV1): boolean {
  const learning = item.learning
  const sourceRevision = manualLearningAuthorizationSourceRevision(learning)
  const initialRecovery = learning?.attempt === 2
    && learning.requestBudgetUsed === 0
    && learning.calls.length === 0
    && sourceRevision === item.revision - 1
  const truncationContinuation = learning?.attempt === 3
    && nextLearningRequestKind(learning) === 'TRUNCATION_RECOVERY'
    && sourceRevision !== undefined
    && sourceRevision < item.revision
  return item.processingState === 'CAPTURED'
    && item.review === undefined
    && learning?.failure?.retryable === true
    && (initialRecovery || truncationContinuation)
}

/**
 * Schema-v1-compatible ignored marker. NEEDS_ATTENTION never otherwise retains
 * nextEligibleAt; binding it to the original failure time avoids a new field or state.
 */
export function isIgnoredLearningFailure(item: CaptureWorkItemV1): boolean {
  const learning = item.learning
  return item.processingState === 'NEEDS_ATTENTION'
    && item.review === undefined
    && learning?.failure !== undefined
    && learning.publicationOutcome === 'NEEDS_ATTENTION'
    && learning.nextEligibleAt === learning.failure.occurredAt
}
