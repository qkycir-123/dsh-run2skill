import { OBSERVE_LIMITS, TRIGGER_POLICY_VERSION } from './constants.js'
import { sha256Utf8 } from './hashing.js'
import {
  canonicalizeSignalKeyFacts,
  deriveSessionLifecycleKeyFromFacts,
  deriveWorkItemIdFromFacts,
} from './identity.js'
import { SignalKeySchema, type SignalKey } from './schemas.js'

interface TurnInstanceFacts {
  turnStartSeq: number
  turnStartTime: number
  turnEndSeq: number
  turnEndTime: number
  directUserMessageIds: readonly string[]
}

interface SessionLifecycleFacts {
  rootSessionId: string
  sessionCreatedAt: number
  sessionCwdDigest: string
}

type SignalKeyInput = Omit<SignalKey, 'sessionCwdDigest' | 'triggerPolicyVersion'> & {
  sessionCwd?: string
  sessionCwdDigest?: string
  triggerPolicyVersion?: typeof TRIGGER_POLICY_VERSION
}

function assertSafeCoordinate(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }
}

export function deriveSessionCwdDigest(cwd: string | undefined): string {
  if (
    cwd !== undefined
    && (
      cwd.length > OBSERVE_LIMITS.maxPathChars
      || Buffer.byteLength(cwd, 'utf8') > OBSERVE_LIMITS.maxPathBytes
    )
  ) {
    throw new RangeError('cwd exceeds the bounded path envelope')
  }
  const taggedValue = cwd === undefined
    ? { status: 'missing' as const }
    : { status: 'present' as const, value: cwd }
  return sha256Utf8(JSON.stringify(taggedValue))
}

export function deriveTurnInstanceDigest(facts: TurnInstanceFacts): string {
  assertSafeCoordinate(facts.turnStartSeq, 'turnStartSeq')
  assertSafeCoordinate(facts.turnStartTime, 'turnStartTime')
  assertSafeCoordinate(facts.turnEndSeq, 'turnEndSeq')
  assertSafeCoordinate(facts.turnEndTime, 'turnEndTime')

  if (facts.directUserMessageIds.length > OBSERVE_LIMITS.maxDirectUserMessages) {
    throw new RangeError('directUserMessageIds exceeds the message-count limit')
  }
  let identityBytes = 0
  for (const messageId of facts.directUserMessageIds) {
    if (messageId.length === 0 || messageId.length > OBSERVE_LIMITS.maxIdentityChars) {
      throw new RangeError('direct user message ID exceeds the identity limit')
    }
    identityBytes += Buffer.byteLength(messageId, 'utf8')
    if (identityBytes > OBSERVE_LIMITS.maxTurnIdentityBytes) {
      throw new RangeError('direct user message IDs exceed the aggregate byte limit')
    }
  }

  const canonical = JSON.stringify({
    turnStartSeq: facts.turnStartSeq,
    turnStartTime: facts.turnStartTime,
    turnEndSeq: facts.turnEndSeq,
    turnEndTime: facts.turnEndTime,
    directUserMessageIds: [...facts.directUserMessageIds],
  })
  return sha256Utf8(canonical)
}

export function deriveSessionLifecycleKey(facts: SessionLifecycleFacts): string {
  const parsed = SignalKeySchema.pick({
    rootSessionId: true,
    sessionCreatedAt: true,
    sessionCwdDigest: true,
  }).parse(facts)
  return deriveSessionLifecycleKeyFromFacts(parsed)
}

export function buildSignalKey(input: SignalKeyInput): SignalKey {
  const signalKey = {
    rootSessionId: input.rootSessionId,
    sessionCreatedAt: input.sessionCreatedAt,
    sessionCwdDigest: input.sessionCwdDigest ?? deriveSessionCwdDigest(input.sessionCwd),
    turn: input.turn,
    turnEndSeq: input.turnEndSeq,
    turnInstanceDigest: input.turnInstanceDigest,
    triggerPolicyVersion: input.triggerPolicyVersion ?? TRIGGER_POLICY_VERSION,
  }
  return SignalKeySchema.parse(signalKey)
}

export function canonicalizeSignalKey(signalKey: SignalKey): string {
  const parsed = SignalKeySchema.parse(signalKey)
  return canonicalizeSignalKeyFacts(parsed)
}

export function deriveWorkItemId(signalKey: SignalKey): string {
  const parsed = SignalKeySchema.parse(signalKey)
  return deriveWorkItemIdFromFacts(parsed)
}
