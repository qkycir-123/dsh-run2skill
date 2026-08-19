import { describe, expect, it, vi } from 'vitest'
import {
  deriveSessionCwdDigest as deriveDomainSessionCwdDigest,
  deriveTurnInstanceDigest,
} from '../src/domain/observe/signal-key.js'
import {
  buildTurnObservation,
  classifySessionRoot,
  deriveSessionCwdDigest,
  DshSessionGapReader,
  SessionCoordinateIngress,
} from '../src/adapters/dsh-session/index.js'
import type {
  DshSessionEvent,
  DshSessionHeader,
  SessionPersistencePort,
  TurnIngressCandidate,
} from '../src/adapters/dsh-session/index.js'

const rootHeader: DshSessionHeader = {
  version: 0,
  id: 'session-a',
  createdAt: 1_000,
  cwd: 'D:\\work\\project',
}

function event(
  type: string,
  seq: number,
  data: Record<string, unknown>,
  time = 10_000 + seq,
): DshSessionEvent {
  return { type, seq, time, data }
}

function userMessage(
  seq: number,
  id: string,
  text: string,
  source: Record<string, unknown> = { kind: 'user' },
): DshSessionEvent {
  return event('user/message', seq, {
    id,
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image', image: 'must-not-be-read' },
    ],
    source,
  })
}

describe('DSH session root classification', () => {
  it('treats an absent delegationDepth and zero as the same Root fact', () => {
    expect(classifySessionRoot(rootHeader)).toEqual({ status: 'ROOT' })
    expect(classifySessionRoot({ ...rootHeader, delegationDepth: 0 })).toEqual({ status: 'ROOT' })
    expect(classifySessionRoot({ ...rootHeader, delegationDepth: -0 })).toEqual({ status: 'ROOT' })
  })

  it('does not infer Child from parentSession alone', () => {
    expect(classifySessionRoot({ ...rootHeader, parentSession: 'parent' })).toEqual({
      status: 'ROOT',
      parentSessionId: 'parent',
    })
  })

  it('uses only strong subagent facts for Child and fails closed on unavailable identity', () => {
    expect(classifySessionRoot({ ...rootHeader, origin: 'subagent' })).toEqual({ status: 'CHILD' })
    expect(classifySessionRoot({ ...rootHeader, delegationDepth: 2 })).toEqual({ status: 'CHILD' })
    expect(classifySessionRoot({ ...rootHeader, createdAt: Number.NaN })).toEqual({
      status: 'UNAVAILABLE',
      healthCode: 'ROOT_IDENTITY_UNAVAILABLE',
    })
  })
})

describe('TurnObservation construction', () => {
  it('builds the same complete domain input through live ingress and persisted gap paths', async () => {
    const events = [
      event('turn/start', 0, { turn: 7 }),
      userMessage(1, 'message-a', 'first'),
      userMessage(2, 'synthetic', 'ignore me', { kind: 'plugin', plugin: 'test' }),
      userMessage(3, 'message-b', 'second'),
      event('turn/end', 4, { turn: 7, reason: { kind: 'completed' } }),
    ]

    const candidates: TurnIngressCandidate[] = []
    const ingress = new SessionCoordinateIngress((candidate) => { candidates.push(candidate) })
    for (const candidate of events) ingress.observe(rootHeader, candidate)
    await vi.waitFor(() => expect(candidates).toHaveLength(1))

    const persistence: SessionPersistencePort = {
      async listSnapshots() { return [{ header: rootHeader, revision: 'jsonl:rev-1' }] },
      async readFrom() { return { meta: rootHeader, events } },
    }
    const persistedLog = await new DshSessionGapReader(persistence).readFrom('session-a', 0)
    expect(persistedLog.status).toBe('AVAILABLE')
    if (persistedLog.status !== 'AVAILABLE') throw new Error('expected persisted log')

    const liveCandidate = candidates[0]
    if (liveCandidate === undefined) throw new Error('expected live candidate')
    const live = buildTurnObservation(persistedLog.header, persistedLog.events, liveCandidate.turnEndSeq)
    const persisted = buildTurnObservation(persistedLog.header, persistedLog.events, 4)

    expect(live).toEqual(persisted)
    expect(live).toMatchObject({
      status: 'OBSERVED',
      observation: {
        rootSessionId: 'session-a',
        sessionCreatedAt: 1_000,
        turn: 7,
        turnStartSeq: 0,
        turnEndSeq: 4,
        turnEndTime: 10_004,
        turnOutcomeKind: 'completed',
        directUserMessages: [
          { messageSeq: 1, messageId: 'message-a', textBlocks: ['first'] },
          { messageSeq: 3, messageId: 'message-b', textBlocks: ['second'] },
        ],
      },
    })
    if (live.status !== 'OBSERVED') throw new Error('expected a complete observation')
    expect(live.observation.sessionCwdDigest).toBe(deriveSessionCwdDigest(rootHeader.cwd))
    expect(live.observation.sessionCwdDigest).toBe(deriveDomainSessionCwdDigest(rootHeader.cwd))
    expect(live.observation.turnInstanceDigest).toBe(deriveTurnInstanceDigest({
      turnStartSeq: 0,
      turnStartTime: 10_000,
      turnEndSeq: 4,
      turnEndTime: 10_004,
      directUserMessageIds: ['message-a', 'message-b'],
    }))
    expect(live.observation.turnInstanceDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  it.each([
    { kind: 'error', error: { code: 'UNKNOWN', message: 'synthetic failure' } },
    { kind: 'aborted', reason: { kind: 'user' } },
    { kind: 'blocked' },
  ])('accepts a Root Turn ending with $kind and no model events', (reason) => {
    const result = buildTurnObservation(rootHeader, [
      event('turn/start', 0, { turn: 0 }),
      userMessage(1, 'message-a', 'save this workflow'),
      event('turn/end', 2, { turn: 0, reason }),
    ], 2)

    expect(result).toMatchObject({
      status: 'OBSERVED',
      observation: { turnOutcomeKind: reason.kind },
    })
  })

  it('returns Child without reading or exposing its text', () => {
    const result = buildTurnObservation({ ...rootHeader, origin: 'subagent' }, [
      event('turn/start', 0, { turn: 0 }),
      userMessage(1, 'child-message', 'child text'),
      event('turn/end', 2, { turn: 0, reason: { kind: 'completed' } }),
    ], 2)

    expect(result).toEqual({ status: 'CHILD' })
    expect(JSON.stringify(result)).not.toContain('child text')
  })

  it.each([
    {
      name: 'missing turn/start',
      events: [userMessage(0, 'message-a', 'text'), event('turn/end', 1, { turn: 0, reason: { kind: 'completed' } })],
      endSeq: 1,
    },
    {
      name: 'non-contiguous seq',
      events: [event('turn/start', 0, { turn: 0 }), userMessage(2, 'message-a', 'text'), event('turn/end', 3, { turn: 0, reason: { kind: 'completed' } })],
      endSeq: 3,
    },
    {
      name: 'mismatched turn/end',
      events: [event('turn/start', 0, { turn: 0 }), event('turn/end', 1, { turn: 1, reason: { kind: 'completed' } })],
      endSeq: 1,
    },
    {
      name: 'out-of-order events',
      events: [event('turn/start', 0, { turn: 0 }), event('turn/end', 2, { turn: 0, reason: { kind: 'completed' } }), userMessage(1, 'message-a', 'text')],
      endSeq: 2,
    },
  ])('does not guess a boundary for $name', ({ events, endSeq }) => {
    expect(buildTurnObservation(rootHeader, events, endSeq)).toEqual({
      status: 'UNAVAILABLE',
      healthCode: 'TURN_BOUNDARY_INCOMPLETE',
      sessionId: 'session-a',
      turnEndSeq: endSeq,
    })
  })

  it('distinguishes reused Session IDs by immutable lifecycle facts', () => {
    const events = [
      event('turn/start', 0, { turn: 0 }),
      event('turn/end', 1, { turn: 0, reason: { kind: 'completed' } }),
    ]
    const first = buildTurnObservation(rootHeader, events, 1)
    const reused = buildTurnObservation({ ...rootHeader, createdAt: 2_000 }, events, 1)

    expect(first.status).toBe('OBSERVED')
    expect(reused.status).toBe('OBSERVED')
    if (first.status !== 'OBSERVED' || reused.status !== 'OBSERVED') return
    expect(first.observation.sessionLifecycleKey).not.toBe(reused.observation.sessionLifecycleKey)
  })

  it('maps bounded identity failures to explicit unavailable results', () => {
    const events = [
      event('turn/start', 0, { turn: 0 }),
      event('turn/end', 1, { turn: 0, reason: { kind: 'completed' } }),
    ]
    expect(buildTurnObservation({ ...rootHeader, cwd: 'x'.repeat(32 * 1024 + 1) }, events, 1))
      .toMatchObject({ status: 'UNAVAILABLE', healthCode: 'ROOT_IDENTITY_UNAVAILABLE' })

    const oversizedMessageId = [
      event('turn/start', 0, { turn: 0 }),
      userMessage(1, 'm'.repeat(1_025), 'text'),
      event('turn/end', 2, { turn: 0, reason: { kind: 'completed' } }),
    ]
    expect(buildTurnObservation(rootHeader, oversizedMessageId, 2)).toEqual({
      status: 'UNAVAILABLE',
      healthCode: 'TURN_BOUNDARY_INCOMPLETE',
      sessionId: 'session-a',
      turnEndSeq: 2,
    })
  })
})
