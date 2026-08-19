import { describe, expect, it } from 'vitest'
import { projectLearningWindow } from '../src/adapters/dsh-session/learning-window.js'
import type { DshSessionEvent, DshSessionHeader } from '../src/adapters/dsh-session/types.js'
import {
  makeLearningSessionFixture,
  makeLearningWorkItem,
} from './support/learning-session-fixture.js'

describe('DSH Learning Window projection', () => {
  it('uses the last route in the trigger Turn and ignores later events', () => {
    const fixture = makeLearningSessionFixture()
    const result = projectLearningWindow(fixture.header, fixture.events, fixture.item)
    expect(result.status).toBe('AVAILABLE')
    if (result.status !== 'AVAILABLE') return

    expect(result.projection.route).toEqual({
      provider: 'target-provider',
      model: 'target-model-last',
    })
    expect(result.projection.blocks.map(block => [block.source, block.eventSeq])).toEqual([
      ['USER_EVIDENCE', 1],
      ['ASSISTANT_CONTEXT', 3],
      ['EXTERNAL_UNTRUSTED', 8],
      ['USER_EVIDENCE', 11],
      ['ASSISTANT_CONTEXT', 12],
      ['TOOL_EVIDENCE', 13],
      ['ASSISTANT_CONTEXT', 18],
    ])
    const serialized = JSON.stringify(result.projection)
    expect(serialized).not.toContain('future-provider')
    expect(serialized).not.toContain('must-not-be-read')
    expect(serialized).not.toContain('synthetic-envelope-value')
    expect(serialized).not.toContain('synthetic-tool-value')
    expect(serialized).not.toContain('synthetic-value')
    expect(serialized).toContain('[REDACTED]')
    expect(serialized).not.toContain('weather output')
  })

  it('falls back to the last earlier route when the trigger Turn has none', () => {
    const fixture = makeLearningSessionFixture()
    const events = fixture.events.map(event => (
      (event.seq === 10 || event.seq === 17)
        ? { ...event, type: 'todo/write', data: { todos: [] } }
        : event
    ))
    const result = projectLearningWindow(fixture.header, events, fixture.item)
    expect(result.status).toBe('AVAILABLE')
    if (result.status === 'AVAILABLE') {
      expect(result.projection.route).toEqual({
        provider: 'history-provider',
        model: 'history-model',
      })
    }
  })

  it('fails closed when lifecycle facts do not match the WorkItem', () => {
    const fixture = makeLearningSessionFixture()
    expect(projectLearningWindow(
      { ...fixture.header, createdAt: fixture.header.createdAt + 1 },
      fixture.events,
      fixture.item,
    )).toEqual({ status: 'UNAVAILABLE', failureCode: 'SESSION_LOG_UNAVAILABLE' })
  })

  it('rejects durable evidence that was not derived from its Session message', () => {
    const fixture = makeLearningSessionFixture()
    const inventedExcerpt = 'save an invented workflow as a skill'
    const item = makeLearningWorkItem(fixture.header, fixture.events, 20, 11, inventedExcerpt)
    expect(projectLearningWindow(fixture.header, fixture.events, item)).toEqual({
      status: 'UNAVAILABLE', failureCode: 'SESSION_LOG_UNAVAILABLE',
    })
  })

  it('reports an unavailable route instead of reading defaults', () => {
    const fixture = makeLearningSessionFixture()
    const events = fixture.events.map(event => event.type === 'request/header'
      ? { ...event, type: 'todo/write', data: { todos: [] } }
      : event)
    expect(projectLearningWindow(fixture.header, events, fixture.item)).toEqual({
      status: 'UNAVAILABLE',
      failureCode: 'MODEL_ROUTE_UNAVAILABLE',
    })
  })

  it('does not fall back when the last trigger-Turn route is malformed', () => {
    const fixture = makeLearningSessionFixture()
    const events = fixture.events.map(event => event.seq === 17
      ? { ...event, data: { header: { config: { provider: 'target-provider', model: '   ' } }, reason: 'change' } }
      : event)
    expect(projectLearningWindow(fixture.header, events, fixture.item)).toEqual({
      status: 'UNAVAILABLE', failureCode: 'MODEL_ROUTE_UNAVAILABLE',
    })
  })

  it('keeps only the four most recent complete history Turns', () => {
    const header: DshSessionHeader = {
      version: 0, id: 'session-history-limit', createdAt: 200, cwd: 'D:\\workspace\\history',
    }
    const events: DshSessionEvent[] = []
    for (let turn = 1; turn <= 6; turn += 1) {
      events.push(
        { type: 'turn/start', seq: events.length, time: 2000 + events.length, data: { turn } },
        { type: 'user/message', seq: events.length + 1, time: 2001 + events.length, data: {
          id: `history-${String(turn)}`, role: 'user', source: { kind: 'user' },
          content: [{ type: 'text', text: `history-${String(turn)}` }],
        } },
        { type: 'turn/end', seq: events.length + 2, time: 2002 + events.length, data: { turn, reason: { kind: 'completed' } } },
      )
    }
    const triggerTurn = 7
    const triggerStart = events.length
    events.push(
      { type: 'turn/start', seq: events.length, time: 3000, data: { turn: triggerTurn } },
      { type: 'user/message', seq: events.length + 1, time: 3001, data: {
        id: 'trigger-history-limit', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: 'save this workflow as a skill' }],
      } },
      { type: 'step/start', seq: events.length + 2, time: 3002, data: { turn: triggerTurn, step: 1 } },
      { type: 'request/header', seq: events.length + 3, time: 3003, data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' } },
      { type: 'step/end', seq: events.length + 4, time: 3004, data: { turn: triggerTurn, step: 1 } },
      { type: 'turn/end', seq: events.length + 5, time: 3005, data: { turn: triggerTurn, reason: { kind: 'completed' } } },
    )
    const item = makeLearningWorkItem(
      header, events, events.length - 1, triggerStart + 1, 'save this workflow as a skill',
    )
    const result = projectLearningWindow(header, events, item)
    expect(result.status).toBe('AVAILABLE')
    if (result.status === 'AVAILABLE') {
      const text = result.projection.blocks.map(block => block.text).join(' ')
      expect(text).not.toContain('history-1')
      expect(text).not.toContain('history-2')
      for (let turn = 3; turn <= 6; turn += 1) expect(text).toContain(`history-${String(turn)}`)
    }
  })

  it('keeps at most the two latest trigger-related Tool summaries', () => {
    const fixture = makeLearningSessionFixture()
    const asTool = (event: DshSessionEvent, callId: string): DshSessionEvent => ({
      ...event,
      type: 'tool/result',
      data: {
        turn: 2,
        step: 1,
        message: {
          id: `tool-${callId}`, role: 'user', source: { kind: 'tool', callId },
          content: [{
            type: 'tool-result', toolCallId: callId,
            content: [{ type: 'text', text: `skill result ${callId}` }],
          }],
        },
      },
    })
    const events = fixture.events.map(event => {
      if (event.seq === 12) return asTool(event, 'call-0')
      if (event.seq === 14) return asTool(event, 'call-2')
      return event
    })
    const result = projectLearningWindow(fixture.header, events, fixture.item)
    expect(result.status).toBe('AVAILABLE')
    if (result.status === 'AVAILABLE') {
      expect(result.projection.blocks
        .filter(block => block.source === 'TOOL_EVIDENCE')
        .map(block => block.eventSeq)).toEqual([13, 14])
    }
  })

  it('bounds each Tool summary to 2 KiB after redaction', () => {
    const fixture = makeLearningSessionFixture()
    const events = fixture.events.map(event => event.seq === 13
      ? {
          ...event,
          data: {
            turn: 2,
            step: 1,
            message: {
              id: 'tool-large', role: 'user', source: { kind: 'tool', callId: 'call-large' },
              content: [{
                type: 'tool-result', toolCallId: 'call-large',
                content: [{ type: 'text', text: `skill ${'界'.repeat(2_000)}` }],
              }],
            },
          },
        }
      : event)
    const result = projectLearningWindow(fixture.header, events, fixture.item)
    expect(result.status).toBe('AVAILABLE')
    if (result.status === 'AVAILABLE') {
      const tool = result.projection.blocks.find(block => block.eventSeq === 13)
      expect(tool?.truncated).toBe(true)
      expect(Buffer.byteLength(tool?.text ?? '', 'utf8')).toBeLessThanOrEqual(2 * 1024)
    }
  })

  it('rejects incomplete or metadata-only WorkItems', () => {
    const fixture = makeLearningSessionFixture()
    const incomplete = {
      ...fixture.item,
      captureReason: 'SCAN_INCOMPLETE' as const,
      scanStatus: 'INCOMPLETE' as const,
      triggerHits: [],
      evidenceRefs: [],
      captureBlockers: ['TURN_BOUNDARY_INCOMPLETE' as const],
    }
    expect(projectLearningWindow(fixture.header, fixture.events, incomplete)).toEqual({
      status: 'UNAVAILABLE', failureCode: 'SESSION_LOG_UNAVAILABLE',
    })
  })
})
