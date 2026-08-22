import { describe, expect, it, vi } from 'vitest'
import { projectDshTurnObservationV2 } from '../src/adapters/dsh-session/v2-turn-observation.js'
import type { DshSessionEvent, DshSessionHeader } from '../src/adapters/dsh-session/types.js'
import { deriveProjectScopeIdentityDigest } from '../src/domain/purge/index.js'
import { TurnObservationV2Schema } from '../src/domain/v2/index.js'

const header: DshSessionHeader = {
  version: 0,
  id: 'session-v2-observation',
  createdAt: 100,
  cwd: 'D:\\workspace\\project',
}

function message(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  source: Record<string, unknown>,
) {
  return { id, role, source, content: [{ type: 'text', text }] }
}

function completeTurn(userText = '把这个流程保存成 Skill，以后可以复用。'): DshSessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1_000, data: { turn: 1 } },
    {
      type: 'request/header',
      seq: 1,
      time: 1_001,
      data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-chat' } }, reason: 'initial' },
    },
    { type: 'user/message', seq: 2, time: 1_002, data: message('user-1', 'user', userText, { kind: 'user' }) },
    { type: 'step/start', seq: 3, time: 1_003, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      seq: 4,
      time: 1_004,
      data: {
        turn: 1,
        step: 1,
        message: message(
          'assistant-1',
          'assistant',
          `已完成。${['Authori', 'zation: ', 'Bear', 'er secret-observation-token'].join('')}`,
          { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
        ),
      },
    },
    {
      type: 'tool/call',
      seq: 5,
      time: 1_005,
      data: { turn: 1, step: 1, callId: 'call-1', name: 'write', arguments: '{"path":"SKILL.md"}' },
    },
    {
      type: 'tool/result',
      seq: 6,
      time: 1_006,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'tool-1',
          role: 'user',
          source: { kind: 'tool', callId: 'call-1' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call-1',
            content: [{ type: 'text', text: 'written' }],
          }],
        },
      },
    },
    { type: 'step/end', seq: 7, time: 1_007, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 8, time: 1_008, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

const workspace = {
  resolve: vi.fn(async () => ({
    status: 'BOUND' as const,
    workspaceId: 'workspace-project',
    canonicalPath: 'D:\\workspace\\project',
  })),
}

describe('DSH TurnObservationV2 projection', () => {
  it('projects one complete root Turn without an LLM call and keeps only bounded redacted facts', async () => {
    const result = await projectDshTurnObservationV2(header, completeTurn(), 8, workspace)

    expect(result.status).toBe('OBSERVED')
    if (result.status !== 'OBSERVED') throw new Error('expected an observation')
    expect(TurnObservationV2Schema.parse(result.observation)).toEqual(result.observation)
    expect(result.observation).toMatchObject({
      turn: 1,
      turnEndSeq: 8,
      outcomeKind: 'completed',
      completeness: 'COMPLETE',
      explicitSaveRequested: true,
      routeObservation: {
        provider: 'deepseek-official',
        model: 'deepseek-chat',
        complete: true,
      },
      scopeBinding: {
        status: 'PROJECT',
        workspaceId: 'workspace-project',
        scopeIdentityDigest: deriveProjectScopeIdentityDigest('D:\\workspace\\project'),
      },
      toolOutcomeSummary: [{
        toolName: 'write',
        outcome: 'SUCCEEDED',
        contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }],
    })
    expect(result.observation.directUserEvidence).toHaveLength(1)
    expect(result.observation.directUserEvidence[0]?.excerpt).toContain('保存成 skill')
    expect(result.observation.assistantOutcomeSummary).not.toContain('secret-observation-token')
  })

  it('retains ordinary direct-user semantics even when no keyword rule fires', async () => {
    const result = await projectDshTurnObservationV2(
      header,
      completeTurn('页面交互最终采用主从布局，左侧选择对象，右侧编辑细节。'),
      8,
      workspace,
    )

    expect(result.status).toBe('OBSERVED')
    if (result.status !== 'OBSERVED') throw new Error('expected an observation')
    expect(result.observation.explicitSaveRequested).toBe(false)
    expect(result.observation.directUserEvidence[0]?.excerpt).toContain('主从布局')
  })

  it('inherits the latest valid route before the Turn and ignores events after the boundary', async () => {
    const events = completeTurn('普通请求')
    events.splice(1, 1)
    events.forEach((event, index) => {
      ;(event as { seq: number }).seq = index + 1
    })
    events.unshift({
      type: 'request/header',
      seq: 0,
      time: 999,
      data: { header: { config: { provider: 'prior-provider', model: 'prior-model' } }, reason: 'initial' },
    })
    const turnEndSeq = events.find(event => event.type === 'turn/end')!.seq
    events.push({
      type: 'request/header',
      seq: turnEndSeq + 1,
      time: 2_000,
      data: { header: { config: { provider: 'future-provider', model: 'future-model' } }, reason: 'change' },
    })

    const result = await projectDshTurnObservationV2(header, events, turnEndSeq, workspace)

    expect(result.status).toBe('OBSERVED')
    if (result.status !== 'OBSERVED') throw new Error('expected an observation')
    expect(result.observation.routeObservation).toEqual({
      provider: 'prior-provider', model: 'prior-model', complete: true,
    })
  })

  it('records a failed tool result without persisting its raw content', async () => {
    const events = completeTurn('普通请求')
    const resultEvent = events.find(event => event.type === 'tool/result')!
    ;(resultEvent.data as Record<string, unknown>)['error'] = { name: 'ToolError', code: 'WRITE_FAILED' }
    const raw = JSON.stringify(resultEvent.data)

    const result = await projectDshTurnObservationV2(header, events, 8, workspace)

    expect(result.status).toBe('OBSERVED')
    if (result.status !== 'OBSERVED') throw new Error('expected an observation')
    expect(result.observation.toolOutcomeSummary[0]?.outcome).toBe('FAILED')
    expect(JSON.stringify(result.observation)).not.toContain(raw)
    expect(JSON.stringify(result.observation)).not.toContain('written')
  })

  it('fails closed to metadata-only when direct-user evidence exceeds its capture bound', async () => {
    const result = await projectDshTurnObservationV2(
      header,
      completeTurn('x'.repeat(64 * 1024 + 1)),
      8,
      workspace,
    )

    expect(result.status).toBe('OBSERVED')
    if (result.status !== 'OBSERVED') throw new Error('expected an observation')
    expect(result.observation).toMatchObject({
      completeness: 'INCOMPLETE',
      explicitSaveRequested: false,
      directUserEvidence: [],
    })
  })

  it('marks an unmatched tool call incomplete instead of inventing a successful outcome', async () => {
    const events = completeTurn('普通请求').filter(event => event.type !== 'tool/result')
    events.forEach((event, index) => {
      ;(event as { seq: number }).seq = index
    })
    const turnEndSeq = events.find(event => event.type === 'turn/end')!.seq

    const result = await projectDshTurnObservationV2(header, events, turnEndSeq, workspace)

    expect(result.status).toBe('OBSERVED')
    if (result.status !== 'OBSERVED') throw new Error('expected an observation')
    expect(result.observation.completeness).toBe('INCOMPLETE')
    expect(result.observation.directUserEvidence).toEqual([])
    expect(result.observation.toolOutcomeSummary).toEqual([{
      toolName: 'write',
      outcome: 'OUTCOME_UNKNOWN',
      contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    }])
  })

  it('fails closed when a tool result is paired across different steps', async () => {
    const events = completeTurn('普通请求')
    const resultEvent = events.find(event => event.type === 'tool/result')!
    ;(resultEvent.data as Record<string, unknown>)['step'] = 2

    const result = await projectDshTurnObservationV2(header, events, 8, workspace)

    expect(result.status).toBe('OBSERVED')
    if (result.status !== 'OBSERVED') throw new Error('expected an observation')
    expect(result.observation.completeness).toBe('INCOMPLETE')
    expect(result.observation.directUserEvidence).toEqual([])
    expect(result.observation.toolOutcomeSummary[0]?.outcome).toBe('OUTCOME_UNKNOWN')
  })

  it('does not project a child Session', async () => {
    const result = await projectDshTurnObservationV2(
      { ...header, origin: 'subagent', delegationDepth: 1 },
      completeTurn(),
      8,
      workspace,
    )
    expect(result).toEqual({ status: 'CHILD' })
  })
})
