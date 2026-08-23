import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import type { DshSessionEvent } from './types.js'

export const DSH_SESSION_LOG_PREFIX_GENESIS = sha256Utf8(canonicalJson({
  contract: 'dsh-session-log-prefix-v1',
}))

export function extendDshSessionLogPrefixDigest(
  initial: string,
  events: readonly DshSessionEvent[],
): string {
  let digest = initial
  for (const event of events) digest = sha256Utf8(canonicalJson({ previous: digest, event }))
  return digest
}

export function deriveDshSessionLogPrefixDigest(
  events: readonly DshSessionEvent[],
  throughSeq: number,
): string | undefined {
  const prefix = events.filter(event => event.seq <= throughSeq)
  if (prefix.length !== throughSeq + 1) return undefined
  return extendDshSessionLogPrefixDigest(DSH_SESSION_LOG_PREFIX_GENESIS, prefix)
}
