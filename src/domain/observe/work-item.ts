import {
  CAPTURE_BLOCKER_ORDER,
  compareOrdinalText,
  OBSERVE_LIMITS,
  REDACTION_KIND_ORDER,
  TRIGGER_KIND_ORDER,
} from './constants.js'
import { DomainError } from './errors.js'
import {
  CaptureWorkItemV1Schema,
  type CaptureBlocker,
  type CaptureWorkItemV1,
  type EvidenceRef,
  type TriggerHit,
} from './schemas.js'
import { canonicalizeSignalKey } from './signal-key.js'

function parseWorkItem(value: CaptureWorkItemV1): CaptureWorkItemV1 {
  const parsed = CaptureWorkItemV1Schema.safeParse(value)
  if (!parsed.success) throw new DomainError('INVALID_WORK_ITEM')
  return parsed.data
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function assertIdentity(left: CaptureWorkItemV1, right: CaptureWorkItemV1): void {
  if (
    left.workItemId !== right.workItemId
    || canonicalizeSignalKey(left.signalKey) !== canonicalizeSignalKey(right.signalKey)
  ) {
    throw new DomainError('SIGNAL_KEY_CONFLICT')
  }
  if (
    left.createdAt !== right.createdAt
    || left.turnOutcomeKind !== right.turnOutcomeKind
    || !sameJson(left.rootIdentity, right.rootIdentity)
  ) {
    throw new DomainError('IMMUTABLE_FIELD_CONFLICT')
  }
}

function mergeTriggerHits(left: readonly TriggerHit[], right: readonly TriggerHit[]): TriggerHit[] {
  const hits = new Map<string, TriggerHit>()
  for (const hit of [...left, ...right]) {
    hits.set(`${hit.messageSeq}\u0000${hit.kind}\u0000${hit.ruleId}`, hit)
  }
  return [...hits.values()].sort((a, b) => (
    a.messageSeq - b.messageSeq
    || TRIGGER_KIND_ORDER.indexOf(a.kind) - TRIGGER_KIND_ORDER.indexOf(b.kind)
    || compareOrdinalText(a.ruleId, b.ruleId)
  ))
}

function mergeEvidenceRefs(left: readonly EvidenceRef[], right: readonly EvidenceRef[]): EvidenceRef[] {
  const evidence = new Map<string, EvidenceRef>()
  for (const next of [...left, ...right]) {
    const key = `${next.source}\u0000${next.messageSeq}\u0000${next.excerptDigest}`
    const current = evidence.get(key)
    if (current !== undefined && current.excerpt !== next.excerpt) {
      throw new DomainError('IMMUTABLE_FIELD_CONFLICT')
    }
    evidence.set(key, current === undefined ? next : {
      ...current,
      redactionKinds: REDACTION_KIND_ORDER.filter((kind) => (
        current.redactionKinds.includes(kind) || next.redactionKinds.includes(kind)
      )),
      truncated: current.truncated || next.truncated,
    })
  }

  const merged = [...evidence.values()].sort((a, b) => (
    a.messageSeq - b.messageSeq || compareOrdinalText(a.excerptDigest, b.excerptDigest)
  ))
  const totalBytes = merged.reduce(
    (total, item) => total + Buffer.byteLength(item.excerpt, 'utf8'),
    0,
  )
  if (
    merged.length > OBSERVE_LIMITS.maxEvidenceRefs
    || totalBytes > OBSERVE_LIMITS.maxEvidenceTotalBytes
  ) {
    throw new DomainError('EVIDENCE_LIMIT_EXCEEDED')
  }
  return merged
}

function mergeBlockers(
  left: readonly CaptureBlocker[],
  right: readonly CaptureBlocker[],
): CaptureBlocker[] {
  const rightSet = new Set(right)
  return CAPTURE_BLOCKER_ORDER.filter((blocker) => left.includes(blocker) && rightSet.has(blocker))
}

function bindingRank(binding: CaptureWorkItemV1['workspaceBinding']): number {
  switch (binding.status) {
    case 'BOUND': return 3
    case 'NO_CWD': return 2
    case 'UNREGISTERED': return 2
    case 'UNAVAILABLE': return 1
  }
}

function mergeWorkspaceBinding(
  left: CaptureWorkItemV1['workspaceBinding'],
  right: CaptureWorkItemV1['workspaceBinding'],
): CaptureWorkItemV1['workspaceBinding'] {
  if (sameJson(left, right)) return left
  if (left.status === right.status) {
    if (
      left.status === 'BOUND'
      && right.status === 'BOUND'
      && (left.workspaceId !== right.workspaceId || left.canonicalPath !== right.canonicalPath)
    ) {
      throw new DomainError('IMMUTABLE_FIELD_CONFLICT')
    }
    return compareIsoDateTime(left.observedAt, right.observedAt) >= 0 ? left : right
  }
  const leftRank = bindingRank(left)
  const rightRank = bindingRank(right)
  if (leftRank === rightRank) {
    const timeOrder = compareIsoDateTime(left.observedAt, right.observedAt)
    if (timeOrder !== 0) return timeOrder > 0 ? left : right
    return left.status < right.status ? left : right
  }
  return leftRank > rightRank ? left : right
}

function withoutRevisionFacts(value: CaptureWorkItemV1): Omit<CaptureWorkItemV1, 'revision' | 'updatedAt'> {
  const { revision: _revision, updatedAt: _updatedAt, ...facts } = value
  return facts
}

export function sameCaptureWorkItemFacts(
  left: CaptureWorkItemV1,
  right: CaptureWorkItemV1,
): boolean {
  return sameJson(withoutRevisionFacts(left), withoutRevisionFacts(right))
}

function preferSnapshot(left: CaptureWorkItemV1, right: CaptureWorkItemV1): CaptureWorkItemV1 {
  if (left.revision !== right.revision) return left.revision > right.revision ? left : right
  const timeOrder = compareIsoDateTime(left.updatedAt, right.updatedAt)
  if (timeOrder !== 0) return timeOrder > 0 ? left : right
  return canonicalSnapshot(left) <= canonicalSnapshot(right) ? left : right
}

function compareIsoDateTime(left: string, right: string): number {
  const instantOrder = Date.parse(left) - Date.parse(right)
  if (instantOrder !== 0) return instantOrder
  return left.localeCompare(right)
}

function canonicalSnapshot(value: CaptureWorkItemV1): string {
  return JSON.stringify(value)
}

function materializeMergedFacts(
  mergedFacts: Omit<CaptureWorkItemV1, 'revision' | 'updatedAt'>,
  left: CaptureWorkItemV1,
  right: CaptureWorkItemV1,
): CaptureWorkItemV1 {
  const matchesLeft = sameJson(mergedFacts, withoutRevisionFacts(left))
  const matchesRight = sameJson(mergedFacts, withoutRevisionFacts(right))
  const revision = Math.max(left.revision, right.revision)
  const updatedAt = compareIsoDateTime(left.updatedAt, right.updatedAt) >= 0
    ? left.updatedAt
    : right.updatedAt
  const matchingSnapshot = matchesLeft ? left : matchesRight ? right : undefined
  if (
    matchingSnapshot !== undefined
    && matchingSnapshot.revision === revision
    && matchingSnapshot.updatedAt === updatedAt
  ) return matchingSnapshot

  return parseWorkItem({
    ...mergedFacts,
    revision,
    updatedAt,
  })
}

function mergeResolvedWithIncomplete(
  resolved: CaptureWorkItemV1,
  incomplete: CaptureWorkItemV1,
): CaptureWorkItemV1 {
  const isMetadataOnlyIncomplete = incomplete.captureReason === 'SCAN_INCOMPLETE'
    && incomplete.scanStatus === 'INCOMPLETE'
    && incomplete.processingState === 'CAPTURED'
    && incomplete.triggerHits.length === 0
    && incomplete.evidenceRefs.length === 0

  if (!isMetadataOnlyIncomplete) throw new DomainError('IMMUTABLE_FIELD_CONFLICT')

  const workspaceBinding = mergeWorkspaceBinding(
    resolved.workspaceBinding,
    incomplete.workspaceBinding,
  )
  return materializeMergedFacts({
    ...withoutRevisionFacts(resolved),
    workspaceBinding,
  }, resolved, incomplete)
}

export function mergeCaptureWorkItems(
  existingValue: CaptureWorkItemV1,
  incomingValue: CaptureWorkItemV1,
): CaptureWorkItemV1 {
  // This reconciles one jointly valid monotonic observation chain. A3 owns
  // compare-revision persistence and assigns the next durable revision only
  // when these reconciled facts change.
  const existing = parseWorkItem(existingValue)
  const incoming = parseWorkItem(incomingValue)
  assertIdentity(existing, incoming)

  if (
    existing.processingState === 'RESOLVED_NO_SIGNAL'
    || incoming.processingState === 'RESOLVED_NO_SIGNAL'
  ) {
    if (
      existing.processingState === 'RESOLVED_NO_SIGNAL'
      && incoming.processingState === 'RESOLVED_NO_SIGNAL'
    ) {
      const workspaceBinding = mergeWorkspaceBinding(
        existing.workspaceBinding,
        incoming.workspaceBinding,
      )
      return materializeMergedFacts({
        ...withoutRevisionFacts(preferSnapshot(existing, incoming)),
        workspaceBinding,
      }, existing, incoming)
    }
    return existing.processingState === 'RESOLVED_NO_SIGNAL'
      ? mergeResolvedWithIncomplete(existing, incoming)
      : mergeResolvedWithIncomplete(incoming, existing)
  }

  const triggerHits = mergeTriggerHits(existing.triggerHits, incoming.triggerHits)
  const evidenceRefs = mergeEvidenceRefs(existing.evidenceRefs, incoming.evidenceRefs)
  const scanStatus = existing.scanStatus === 'COMPLETE' || incoming.scanStatus === 'COMPLETE'
    ? 'COMPLETE'
    : 'INCOMPLETE'
  const captureBlockers = scanStatus === 'COMPLETE'
    ? []
    : mergeBlockers(existing.captureBlockers, incoming.captureBlockers)

  if (scanStatus === 'INCOMPLETE' && captureBlockers.length === 0) {
    throw new DomainError('INVALID_WORK_ITEM')
  }

  const hasTrigger = triggerHits.length > 0
  const mergedFacts: Omit<CaptureWorkItemV1, 'revision' | 'updatedAt'> = {
    schemaVersion: 1,
    workItemId: existing.workItemId,
    signalKey: existing.signalKey,
    captureReason: hasTrigger ? 'CHEAP_TRIGGER' : 'SCAN_INCOMPLETE',
    createdAt: existing.createdAt,
    turnOutcomeKind: existing.turnOutcomeKind,
    rootIdentity: existing.rootIdentity,
    workspaceBinding: mergeWorkspaceBinding(existing.workspaceBinding, incoming.workspaceBinding),
    scanStatus,
    triggerHits,
    evidenceRefs,
    captureBlockers,
    processingState: 'CAPTURED',
  }

  return materializeMergedFacts(mergedFacts, existing, incoming)
}
