import { sha256Utf8 } from '../observe/hashing.js'
import { compareOrdinalText } from '../observe/constants.js'
import type { CaptureWorkItemV1 } from '../observe/schemas.js'

export const LEARNING_ENVELOPE_MAX_BYTES = 48 * 1024

export type LearningEnvelopeSource =
  | 'USER_EVIDENCE'
  | 'ASSISTANT_CONTEXT'
  | 'TOOL_EVIDENCE'
  | 'EXTERNAL_UNTRUSTED'
  | 'EXISTING_SKILL'

export type LearningBlockRetention =
  | { readonly kind: 'TRIGGER_EVIDENCE' }
  | { readonly kind: 'EXTERNAL' }
  | { readonly kind: 'HISTORY'; readonly distance: number }
  | { readonly kind: 'TOOL' }
  | { readonly kind: 'SKILL_SUMMARY'; readonly rank: number }
  | { readonly kind: 'SKILL'; readonly rank: number }
  | { readonly kind: 'ASSISTANT' }

export interface LearningWindowBlock {
  readonly source: LearningEnvelopeSource
  readonly sessionId: string
  readonly turn: number
  readonly eventSeq: number
  readonly text: string
  readonly digest: string
  readonly truncated: boolean
  readonly retention: LearningBlockRetention
}

export interface LearningWindowProjection {
  readonly route: { readonly provider: string; readonly model: string }
  readonly blocks: readonly LearningWindowBlock[]
}

export interface LearningEnvelopeBlock {
  readonly source: LearningEnvelopeSource
  readonly sessionId: string
  readonly turn: number
  readonly eventSeq: number
  readonly text: string
  readonly digest: string
  readonly truncated: boolean
}

export interface LearningEnvelopeV1 {
  readonly policyVersion: 'learning-v1'
  readonly workItemId: string
  readonly trigger: {
    readonly turn: number
    readonly turnEndSeq: number
    readonly evidenceDigests: readonly string[]
  }
  readonly blocks: readonly LearningEnvelopeBlock[]
}

export type LearningEnvelopeBuildResult =
  | {
    readonly status: 'AVAILABLE'
    readonly envelope: LearningEnvelopeV1
    readonly serialized: string
    readonly byteLength: number
  }
  | { readonly status: 'UNAVAILABLE'; readonly failureCode: 'ENVELOPE_UNBUILDABLE' }

function isValidRoute(route: LearningWindowProjection['route']): boolean {
  return route.provider.trim().length > 0
    && route.provider.length <= 256
    && route.model.trim().length > 0
    && route.model.length <= 256
}

function materializeEnvelope(
  item: CaptureWorkItemV1,
  projection: LearningWindowProjection,
  blocks: readonly LearningWindowBlock[],
): { envelope: LearningEnvelopeV1; serialized: string; byteLength: number } {
  const envelope: LearningEnvelopeV1 = {
    policyVersion: 'learning-v1',
    workItemId: item.workItemId,
    trigger: {
      turn: item.signalKey.turn,
      turnEndSeq: item.signalKey.turnEndSeq,
      evidenceDigests: item.evidenceRefs.map(evidence => evidence.excerptDigest),
    },
    blocks: blocks.map(({ retention: _retention, ...block }) => block),
  }
  const serialized = JSON.stringify(envelope)
  return { envelope, serialized, byteLength: Buffer.byteLength(serialized, 'utf8') }
}

function removalOrder(blocks: readonly LearningWindowBlock[]): number[] {
  const removable = blocks.flatMap((block, index) => {
    switch (block.retention.kind) {
      case 'TRIGGER_EVIDENCE': return []
      case 'EXTERNAL': return [{ index, tier: 0, withinTier: block.eventSeq }]
      case 'HISTORY': return [{ index, tier: 1, withinTier: -block.retention.distance }]
      case 'TOOL': return [{ index, tier: 2, withinTier: block.eventSeq }]
      case 'SKILL_SUMMARY': return []
      case 'SKILL': return [{ index, tier: 3, withinTier: -block.retention.rank }]
      case 'ASSISTANT': return [{ index, tier: 4, withinTier: block.eventSeq }]
    }
  })
  removable.sort((left, right) => (
    left.tier - right.tier || left.withinTier - right.withinTier || left.index - right.index
  ))
  return removable.map(item => item.index)
}

function projectionIsConsistent(
  item: CaptureWorkItemV1,
  projection: LearningWindowProjection,
): boolean {
  if (!isValidRoute(projection.route)) return false
  const required = new Set(item.evidenceRefs.map(evidence => (
    `${evidence.messageSeq}\u0000${evidence.excerptDigest}`
  )))
  const observedRequired = new Set<string>()
  const blockKeys = new Set<string>()
  for (const block of projection.blocks) {
    if (
      block.sessionId !== item.signalKey.rootSessionId
      || !Number.isSafeInteger(block.turn)
      || block.turn < 0
      || !Number.isSafeInteger(block.eventSeq)
      || block.eventSeq < 0
      || block.eventSeq > item.signalKey.turnEndSeq
      || block.digest !== sha256Utf8(block.text)
    ) return false
    const blockIdentity = `${block.source}\u0000${block.eventSeq}\u0000${block.digest}`
    if (blockKeys.has(blockIdentity)) return false
    blockKeys.add(blockIdentity)
    if (block.retention.kind === 'TRIGGER_EVIDENCE') {
      if (block.source !== 'USER_EVIDENCE' || block.turn !== item.signalKey.turn) return false
      observedRequired.add(`${block.eventSeq}\u0000${block.digest}`)
    }
  }
  return required.size === observedRequired.size
    && [...required].every(key => observedRequired.has(key))
}

export function buildLearningEnvelope(
  item: CaptureWorkItemV1,
  projection: LearningWindowProjection,
  requestedByteBudget = LEARNING_ENVELOPE_MAX_BYTES,
): LearningEnvelopeBuildResult {
  if (!Number.isSafeInteger(requestedByteBudget) || requestedByteBudget <= 0) {
    return { status: 'UNAVAILABLE', failureCode: 'ENVELOPE_UNBUILDABLE' }
  }
  if (!projectionIsConsistent(item, projection)) {
    return { status: 'UNAVAILABLE', failureCode: 'ENVELOPE_UNBUILDABLE' }
  }
  const byteBudget = Math.min(requestedByteBudget, LEARNING_ENVELOPE_MAX_BYTES)
  const kept = [...projection.blocks].sort((left, right) => (
    left.eventSeq - right.eventSeq || compareOrdinalText(left.digest, right.digest)
  ))
  let built = materializeEnvelope(item, projection, kept)
  if (built.byteLength <= byteBudget) return { status: 'AVAILABLE', ...built }

  const removals = removalOrder(kept)
  const removed = new Set<number>()
  for (const index of removals) {
    removed.add(index)
    built = materializeEnvelope(
      item,
      projection,
      kept.filter((_block, candidateIndex) => !removed.has(candidateIndex)),
    )
    if (built.byteLength <= byteBudget) return { status: 'AVAILABLE', ...built }
  }
  return { status: 'UNAVAILABLE', failureCode: 'ENVELOPE_UNBUILDABLE' }
}
