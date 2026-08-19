import { sha256Utf8 } from './hashing.js'

export interface SignalKeyIdentityFacts {
  rootSessionId: string
  sessionCreatedAt: number
  sessionCwdDigest: string
  turn: number
  turnEndSeq: number
  turnInstanceDigest: string
  triggerPolicyVersion: string
}

export interface SessionLifecycleIdentityFacts {
  rootSessionId: string
  sessionCreatedAt: number
  sessionCwdDigest: string
}

export function canonicalizeSignalKeyFacts(facts: SignalKeyIdentityFacts): string {
  return JSON.stringify({
    rootSessionId: facts.rootSessionId,
    sessionCreatedAt: facts.sessionCreatedAt,
    sessionCwdDigest: facts.sessionCwdDigest,
    turn: facts.turn,
    turnEndSeq: facts.turnEndSeq,
    turnInstanceDigest: facts.turnInstanceDigest,
    triggerPolicyVersion: facts.triggerPolicyVersion,
  })
}

export function deriveWorkItemIdFromFacts(facts: SignalKeyIdentityFacts): string {
  return `wi_${sha256Utf8(canonicalizeSignalKeyFacts(facts))}`
}

export function canonicalizeSessionLifecycleFacts(
  facts: SessionLifecycleIdentityFacts,
): string {
  return JSON.stringify({
    rootSessionId: facts.rootSessionId,
    sessionCreatedAt: facts.sessionCreatedAt,
    sessionCwdDigest: facts.sessionCwdDigest,
  })
}

export function deriveSessionLifecycleKeyFromFacts(
  facts: SessionLifecycleIdentityFacts,
): string {
  return `sl_${sha256Utf8(canonicalizeSessionLifecycleFacts(facts))}`
}
