import { describe, expect, it } from 'vitest'
import {
  buildSignalKey,
  deriveSessionLifecycleKey,
  deriveSessionCwdDigest,
  deriveTurnInstanceDigest,
  deriveWorkItemId,
} from '../src/domain/observe/signal-key.js'

const boundaries = {
  turnStartSeq: 10,
  turnStartTime: 1_700_000_000_000,
  turnEndSeq: 13,
  turnEndTime: 1_700_000_000_100,
  directUserMessageIds: ['m-1', 'm-2'],
}

describe('SignalKey', () => {
  it('derives the same key and WorkItem ID for the same durable turn', () => {
    const first = buildSignalKey({
      rootSessionId: 'session-1',
      sessionCreatedAt: 1_700_000_000_000,
      sessionCwd: 'D:\\repo',
      turn: 2,
      turnEndSeq: 13,
      turnInstanceDigest: deriveTurnInstanceDigest(boundaries),
    })
    const replay = buildSignalKey(first)

    expect(replay).toEqual(first)
    expect(deriveWorkItemId(replay)).toBe(deriveWorkItemId(first))
    expect(deriveWorkItemId(first)).toMatch(/^wi_[a-f0-9]{64}$/)
  })

  it('distinguishes missing cwd from a present empty cwd without storing the path', () => {
    expect(deriveSessionCwdDigest(undefined)).not.toBe(deriveSessionCwdDigest(''))
    expect(deriveSessionCwdDigest('D:\\private\\workspace')).not.toContain('private')
  })

  it('does not normalize cwd identity and separates reused lifecycle or turn facts', () => {
    const base = buildSignalKey({
      rootSessionId: 'reused-session',
      sessionCreatedAt: 100,
      sessionCwd: 'D:\\Repo',
      turn: 1,
      turnEndSeq: 3,
      turnInstanceDigest: deriveTurnInstanceDigest(boundaries),
    })

    const variants = [
      buildSignalKey({ ...base, sessionCreatedAt: 101 }),
      buildSignalKey({ ...base, sessionCwdDigest: deriveSessionCwdDigest('d:\\repo') }),
      buildSignalKey({ ...base, turnInstanceDigest: deriveTurnInstanceDigest({ ...boundaries, turnEndTime: boundaries.turnEndTime + 1 }) }),
    ]

    expect(new Set([deriveWorkItemId(base), ...variants.map(deriveWorkItemId)]).size).toBe(4)
  })

  it('changes the turn digest when direct user message identity or boundary changes', () => {
    const digest = deriveTurnInstanceDigest(boundaries)

    expect(deriveTurnInstanceDigest({ ...boundaries, directUserMessageIds: ['m-1', 'm-3'] })).not.toBe(digest)
    expect(deriveTurnInstanceDigest({ ...boundaries, turnStartSeq: 9 })).not.toBe(digest)
  })

  it('bounds message identity inputs before hashing', () => {
    const oneKiBId = 'm'.repeat(1024)

    expect(() => deriveTurnInstanceDigest({
      ...boundaries,
      directUserMessageIds: Array.from({ length: 1025 }, () => 'm'),
    })).toThrow(RangeError)
    expect(() => deriveTurnInstanceDigest({
      ...boundaries,
      directUserMessageIds: ['m'.repeat(1025)],
    })).toThrow(RangeError)
    expect(deriveTurnInstanceDigest({
      ...boundaries,
      directUserMessageIds: Array.from({ length: 256 }, () => oneKiBId),
    })).toMatch(/^[a-f0-9]{64}$/)
    expect(() => deriveTurnInstanceDigest({
      ...boundaries,
      directUserMessageIds: [
        ...Array.from({ length: 256 }, () => oneKiBId),
        'm',
      ],
    })).toThrow(RangeError)
  })

  it('bounds cwd identity by characters and UTF-8 bytes before hashing', () => {
    expect(deriveSessionCwdDigest('p'.repeat(32 * 1024))).toMatch(/^[a-f0-9]{64}$/)
    expect(() => deriveSessionCwdDigest('p'.repeat(32 * 1024 + 1))).toThrow(RangeError)
    expect(() => deriveSessionCwdDigest('界'.repeat(10_923))).toThrow(RangeError)
  })

  it('derives an opaque lifecycle key from stable header facts', () => {
    const lifecycle = {
      rootSessionId: 'session-with-private-looking-id',
      sessionCreatedAt: 100,
      sessionCwdDigest: deriveSessionCwdDigest('D:\\private\\workspace'),
    }
    const key = deriveSessionLifecycleKey(lifecycle)

    expect(key).toMatch(/^sl_[a-f0-9]{64}$/)
    expect(key).not.toContain('session')
    expect(deriveSessionLifecycleKey(lifecycle)).toBe(key)
    expect(deriveSessionLifecycleKey({ ...lifecycle, sessionCreatedAt: 101 })).not.toBe(key)
  })
})
