import { describe, expect, it, vi } from 'vitest'
import {
  DshSessionGapReader,
  SessionCoordinateIngress,
} from '../src/adapters/dsh-session/index.js'
import type {
  DshSessionEvent,
  DshSessionHeader,
  SessionPersistencePort,
} from '../src/adapters/dsh-session/index.js'

const header: DshSessionHeader = {
  version: 0,
  id: 'session-a',
  createdAt: 1_000,
}

function event(type: string, seq: number, data: Record<string, unknown>): DshSessionEvent {
  return { type, seq, time: 10_000 + seq, data }
}

describe('SessionCoordinateIngress', () => {
  it('copies coordinates but never touches message content in the observer callback', async () => {
    const candidates: unknown[] = []
    const ingress = new SessionCoordinateIngress((candidate) => {
      candidates.push(candidate)
    })
    const messageData = {
      id: 'message-a',
      source: { kind: 'user' },
      get content(): never {
        throw new Error('observer copied message text')
      },
    }

    expect(() => {
      ingress.observe(header, event('turn/start', 0, { turn: 0 }))
      ingress.observe(header, event('user/message', 1, messageData))
      ingress.observe(header, event('turn/end', 2, { turn: 0, reason: { kind: 'completed' } }))
    }).not.toThrow()
    expect(candidates).toEqual([])

    await vi.waitFor(() => {
      expect(candidates).toEqual([{
        header,
        turn: 0,
        turnStartSeq: 0,
        turnEndSeq: 2,
        directUserMessages: [{ messageSeq: 1, messageId: 'message-a' }],
      }])
    })
  })

  it.each([
    ['throws', () => { throw new Error('synthetic') }],
    ['rejects', () => Promise.reject(new Error('synthetic'))],
    ['never settles', () => new Promise<void>(() => undefined)],
  ])('keeps the DSH observer fail-open when downstream %s', async (_name, downstream) => {
    const healthCodes: string[] = []
    const ingress = new SessionCoordinateIngress(downstream, (health) => {
      healthCodes.push(health.code)
    })

    const startedAt = performance.now()
    expect(() => {
      ingress.observe(header, event('turn/start', 0, { turn: 0 }))
      ingress.observe(header, event('turn/end', 1, { turn: 0, reason: { kind: 'completed' } }))
    }).not.toThrow()
    expect(performance.now() - startedAt).toBeLessThan(50)

    await Promise.resolve()
    await Promise.resolve()
    if (_name !== 'never settles') {
      await vi.waitFor(() => expect(healthCodes).toContain('SESSION_OBSERVER_DOWNSTREAM_FAILED'))
    }
  })

  it('ignores non-boundary and non-direct message events', async () => {
    const downstream = vi.fn()
    const ingress = new SessionCoordinateIngress(downstream)

    ingress.observe(header, event('assistant/message', 0, { content: 'ignore' }))
    ingress.observe(header, event('user/message', 1, {
      id: 'plugin-message',
      source: { kind: 'plugin', plugin: 'test' },
      content: [{ type: 'text', text: 'ignore' }],
    }))
    await Promise.resolve()

    expect(downstream).not.toHaveBeenCalled()
  })

  it('bounds coordinate memory and reports saturation without throwing', async () => {
    const healthCodes: string[] = []
    const candidates: unknown[] = []
    const ingress = new SessionCoordinateIngress(
      (candidate) => { candidates.push(candidate) },
      (health) => { healthCodes.push(health.code) },
      { maxCoordinates: 2 },
    )

    expect(() => {
      ingress.observe(header, event('turn/start', 0, { turn: 0 }))
      ingress.observe(header, event('user/message', 1, {
        id: 'message-a', source: { kind: 'user' }, content: [],
      }))
      ingress.observe(header, event('user/message', 2, {
        id: 'message-b', source: { kind: 'user' }, content: [],
      }))
      ingress.observe(header, event('turn/end', 3, {
        turn: 0, reason: { kind: 'completed' },
      }))
    }).not.toThrow()
    await vi.waitFor(() => expect(healthCodes).toEqual(['INGRESS_SATURATED']))
    await vi.waitFor(() => expect(candidates).toEqual([{
      header,
      turn: 0,
      turnEndSeq: 3,
      directUserMessages: [],
    }]))

    ingress.observe(header, event('turn/start', 4, { turn: 1 }))
    ingress.observe(header, event('user/message', 5, {
      id: 'message-c', source: { kind: 'user' }, content: [],
    }))
    ingress.observe(header, event('turn/end', 6, {
      turn: 1, reason: { kind: 'completed' },
    }))
    await vi.waitFor(() => expect(candidates).toHaveLength(2))
    expect(candidates[1]).toMatchObject({
      turn: 1,
      turnStartSeq: 4,
      directUserMessages: [{ messageSeq: 5, messageId: 'message-c' }],
    })

    ingress.observe(header, event('turn/start', 7, { turn: 2 }))
    ingress.observe(header, event('user/message', 8, {
      id: 'message-d', source: { kind: 'user' }, content: [],
    }))
    ingress.observe(header, event('user/message', 9, {
      id: 'message-e', source: { kind: 'user' }, content: [],
    }))
    await vi.waitFor(() => expect(healthCodes).toEqual([
      'INGRESS_SATURATED',
      'INGRESS_SATURATED',
    ]))
  })
})

describe('DshSessionGapReader', () => {
  it('returns detached snapshots and suffixes through the DSH persistence port', async () => {
    const persistedEvent = event('turn/end', 4, {
      turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } },
    })
    const persistence: SessionPersistencePort = {
      async listSnapshots() {
        return [{ header, revision: 'jsonl:rev-1' }]
      },
      async readFrom(sessionId, fromSeq) {
        expect(sessionId).toBe('session-a')
        expect(fromSeq).toBe(4)
        return {
          meta: header,
          events: [persistedEvent],
        }
      },
    }
    const reader = new DshSessionGapReader(persistence)

    const snapshots = await reader.listSnapshots()
    expect(snapshots).toEqual({
      status: 'AVAILABLE',
      snapshots: [{ header, revision: 'jsonl:rev-1' }],
    })
    const suffix = await reader.readFrom('session-a', 4)
    expect(suffix).toEqual({
      status: 'AVAILABLE',
      header,
      events: [event('turn/end', 4, { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })],
    })
    if (snapshots.status !== 'AVAILABLE' || suffix.status !== 'AVAILABLE') {
      throw new Error('expected detached persistence results')
    }
    expect(snapshots.snapshots[0]?.header).not.toBe(header)
    expect(suffix.header).not.toBe(header)
    expect(suffix.events[0]).not.toBe(persistedEvent)
  })

  it('turns backend failures into explicit unavailable results without leaking errors', async () => {
    const persistence: SessionPersistencePort = {
      async listSnapshots() {
        throw new Error('synthetic secret and absolute path must not escape')
      },
      async readFrom() {
        return Promise.reject(new Error('synthetic secret and absolute path must not escape'))
      },
    }
    const reader = new DshSessionGapReader(persistence)

    await expect(reader.listSnapshots()).resolves.toEqual({
      status: 'UNAVAILABLE',
      healthCode: 'SESSION_SNAPSHOTS_UNAVAILABLE',
    })
    await expect(reader.readFrom('session-a', 0)).resolves.toEqual({
      status: 'UNAVAILABLE',
      healthCode: 'SESSION_LOG_UNAVAILABLE',
      sessionId: 'session-a',
      fromSeq: 0,
    })
  })

  it.each([
    null,
    42,
    { type: 'turn/end', seq: 0, time: 1 },
    { type: 'turn/end', seq: -1, time: 1, data: {} },
    { type: 'turn/end', seq: 0, time: Number.NaN, data: {} },
  ])('fails closed when persisted events contain a malformed member: %j', async (malformed) => {
    const persistence = {
      async listSnapshots() { return [{ header, revision: 'jsonl:rev-1' }] },
      async readFrom() {
        return { meta: header, events: [malformed] }
      },
    } as unknown as SessionPersistencePort
    const reader = new DshSessionGapReader(persistence)

    await expect(reader.readFrom('session-a', 0)).resolves.toEqual({
      status: 'UNAVAILABLE',
      healthCode: 'SESSION_LOG_UNAVAILABLE',
      sessionId: 'session-a',
      fromSeq: 0,
    })
  })

  it('fails closed when persisted events contain sparse positions', async () => {
    const sparseEvents: unknown[] = []
    sparseEvents.length = 1
    const persistence = {
      async listSnapshots() { return [{ header, revision: 'jsonl:rev-1' }] },
      async readFrom() { return { meta: header, events: sparseEvents } },
    } as unknown as SessionPersistencePort

    await expect(new DshSessionGapReader(persistence).readFrom('session-a', 0)).resolves.toEqual({
      status: 'UNAVAILABLE',
      healthCode: 'SESSION_LOG_UNAVAILABLE',
      sessionId: 'session-a',
      fromSeq: 0,
    })
  })
})
