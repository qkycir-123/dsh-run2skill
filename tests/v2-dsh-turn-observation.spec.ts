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

function insertTurnEvent(
  events: DshSessionEvent[],
  afterType: string,
  inserted: Omit<DshSessionEvent, 'seq' | 'time'> & { readonly ignorable?: true },
): DshSessionEvent[] {
  const index = events.findIndex(event => event.type === afterType) + 1
  events.splice(index, 0, { ...inserted, seq: 0, time: 0 } as DshSessionEvent)
  events.forEach((event, seq) => {
    ;(event as { seq: number; time: number }).seq = seq
    ;(event as { seq: number; time: number }).time = 1_000 + seq
  })
  return events
}

function withRoutePrefix(
  inserted: Omit<DshSessionEvent, 'seq' | 'time'> & { readonly ignorable?: true },
): { readonly events: DshSessionEvent[]; readonly turnEndSeq: number } {
  const events = completeTurn('普通请求').filter(event => event.type !== 'request/header')
  events.unshift(
    {
      type: 'request/header',
      seq: 0,
      time: 0,
      data: { header: { config: { provider: 'prefix-provider', model: 'prefix-model' } }, reason: 'initial' },
    },
    { ...inserted, seq: 0, time: 0 } as DshSessionEvent,
  )
  events.forEach((event, seq) => {
    ;(event as { seq: number; time: number }).seq = seq
    ;(event as { seq: number; time: number }).time = 1_000 + seq
  })
  return { events, turnEndSeq: events.find(event => event.type === 'turn/end')!.seq }
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
      turnStartSeq: 0,
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
    expect(result.observation.directUserEvidence[0]?.excerpt).toContain('保存成 Skill')
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

  it('preserves blockquotes and fenced code in persistent semantic evidence', async () => {
    const quoted = [
      '> 用户确认的长期约束',
      '```text',
      '先校验输入，再执行操作，最后验证结果',
      '```',
      '请按以上内容实现。',
    ].join('\n')

    const result = await projectDshTurnObservationV2(header, completeTurn(quoted), 8, workspace)

    expect(result.status).toBe('OBSERVED')
    if (result.status !== 'OBSERVED') throw new Error('expected an observation')
    expect(result.observation.completeness).toBe('COMPLETE')
    expect(result.observation.directUserEvidence[0]?.excerpt).toContain('> 用户确认的长期约束')
    expect(result.observation.directUserEvidence[0]?.excerpt).toContain('先校验输入,再执行操作')
  })

  it('fails closed for image-only direct-user content instead of recording complete empty evidence', async () => {
    const events = completeTurn('')
    const direct = events.find(event => event.type === 'user/message')!
    ;(direct.data as Record<string, unknown>)['content'] = [{
      type: 'image', source: { type: 'url', url: 'https://example.invalid/workflow.png' },
    }]

    const result = await projectDshTurnObservationV2(header, events, 8, workspace)

    expect(result.status).toBe('OBSERVED')
    if (result.status !== 'OBSERVED') throw new Error('expected an observation')
    expect(result.observation).toMatchObject({
      completeness: 'INCOMPLETE', explicitSaveRequested: false, directUserEvidence: [],
    })
  })

  it('fails closed for text plus image even when the text explicitly requests a save', async () => {
    const events = completeTurn()
    const direct = events.find(event => event.type === 'user/message')!
    ;(direct.data as Record<string, unknown>)['content'] = [
      { type: 'text', text: '把图片里的流程保存成 Skill。' },
      { type: 'image', source: { type: 'url', url: 'https://example.invalid/workflow.png' } },
    ]

    const result = await projectDshTurnObservationV2(header, events, 8, workspace)

    expect(result.status).toBe('OBSERVED')
    if (result.status !== 'OBSERVED') throw new Error('expected an observation')
    expect(result.observation).toMatchObject({
      completeness: 'INCOMPLETE', explicitSaveRequested: false, directUserEvidence: [],
    })
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

  it('projects a later explicit Turn from a normalized inherited route', async () => {
    const events = completeTurn().filter(event => event.type !== 'request/header')
    events.forEach((event, index) => {
      ;(event as { seq: number }).seq = 10 + index
      ;(event as { time: number }).time = 2_000 + index
    })
    const turnEndSeq = events.find(event => event.type === 'turn/end')!.seq

    const result = await projectDshTurnObservationV2(
      header,
      events,
      turnEndSeq,
      workspace,
      undefined,
      {
        requestHeaderSeq: 1,
        provider: 'deepseek-official',
        model: 'deepseek-chat',
        complete: true,
      },
    )

    expect(result.status).toBe('OBSERVED')
    if (result.status !== 'OBSERVED') throw new Error('expected an observation')
    expect(result.observation).toMatchObject({
      completeness: 'COMPLETE',
      explicitSaveRequested: true,
      routeObservation: {
        provider: 'deepseek-official', model: 'deepseek-chat', complete: true,
      },
    })
  })

  it('does not fall back when a newer current request/header is malformed', async () => {
    const events = completeTurn()
    const route = events.find(event => event.type === 'request/header')!
    ;(route as { data: unknown }).data = { header: { config: { provider: 'deepseek-official' } } }

    const result = await projectDshTurnObservationV2(
      header,
      events,
      8,
      workspace,
      undefined,
      {
        requestHeaderSeq: 0,
        provider: 'prior-provider',
        model: 'prior-model',
        complete: true,
      },
    )

    expect(result.status).toBe('OBSERVED')
    if (result.status !== 'OBSERVED') throw new Error('expected an observation')
    expect(result.observation).toMatchObject({
      completeness: 'INCOMPLETE', explicitSaveRequested: false, routeObservation: { complete: false },
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

  it('accepts the stock DSH session metadata emitted around a real root Turn', async () => {
    const events = completeTurn('普通请求')
    events.unshift(
      { type: 'permission/preset', seq: 0, time: 0, data: { preset: 'workspace-write' } },
      { type: 'sandbox/mode', seq: 0, time: 0, data: { mode: 'workspace-write' } },
      { type: 'approval/policy', seq: 0, time: 0, data: { policy: 'ask' } },
      {
        type: 'agent/inbox/spliced',
        seq: 0,
        time: 0,
        data: { target: 'next-turn', start: 0, inserted: [] },
      },
    )
    insertTurnEvent(events, 'user/message', {
      type: 'session/title-llm-request', data: { messageSeqs: [6] },
    })
    insertTurnEvent(events, 'session/title-llm-request', {
      type: 'session/title', data: { title: '真实 DSH 会话', messageSeqs: [6], source: { kind: 'llm' } },
    })
    const turnEndSeq = events.find(event => event.type === 'turn/end')!.seq

    const result = await projectDshTurnObservationV2(header, events, turnEndSeq, workspace)

    expect(result.status).toBe('OBSERVED')
    if (result.status !== 'OBSERVED') throw new Error('expected an observation')
    expect(result.observation.completeness).toBe('COMPLETE')
  })

  it('accepts the stock DSH approval lifecycle emitted during a root Turn', async () => {
    const events = completeTurn('普通请求')
    insertTurnEvent(events, 'tool/call', {
      type: 'approval/asked',
      data: { id: 'approval-1', toolName: 'write', callId: 'call-1', reason: 'permission' },
    })
    insertTurnEvent(events, 'approval/asked', {
      type: 'approval/decided',
      data: { id: 'approval-1', outcome: 'approved' },
    })
    const turnEndSeq = events.find(event => event.type === 'turn/end')!.seq

    const result = await projectDshTurnObservationV2(header, events, turnEndSeq, workspace)

    expect(result.status).toBe('OBSERVED')
    if (result.status !== 'OBSERVED') throw new Error('expected an observation')
    expect(result.observation.completeness).toBe('COMPLETE')
  })

  it('refuses to interpret an unknown required DSH event', async () => {
    const events = insertTurnEvent(completeTurn('普通请求'), 'user/message', {
      type: 'plugin/required-context', data: { payload: 'new required semantics' },
    })
    const turnEndSeq = events.find(event => event.type === 'turn/end')!.seq

    const result = await projectDshTurnObservationV2(header, events, turnEndSeq, workspace)

    expect(result).toMatchObject({
      status: 'UNAVAILABLE', healthCode: 'OBSERVATION_PROJECTION_UNAVAILABLE',
    })
  })

  it('skips an unknown DSH event only when its envelope explicitly marks it ignorable', async () => {
    const events = insertTurnEvent(completeTurn('普通请求'), 'user/message', {
      type: 'plugin/optional-context', data: { payload: 'optional presentation fact' }, ignorable: true,
    })
    const turnEndSeq = events.find(event => event.type === 'turn/end')!.seq

    const result = await projectDshTurnObservationV2(header, events, turnEndSeq, workspace)

    expect(result.status).toBe('OBSERVED')
    if (result.status !== 'OBSERVED') throw new Error('expected an observation')
    expect(result.observation.completeness).toBe('COMPLETE')
  })

  it('refuses a required unknown event in the Session prefix before inheriting an older route', async () => {
    const { events, turnEndSeq } = withRoutePrefix({
      type: 'plugin/required-route-state', data: { routeChanged: true },
    })

    const result = await projectDshTurnObservationV2(header, events, turnEndSeq, workspace)

    expect(result).toMatchObject({
      status: 'UNAVAILABLE', healthCode: 'OBSERVATION_PROJECTION_UNAVAILABLE',
    })
  })

  it('may inherit a prefix route across an explicitly ignorable unknown event', async () => {
    const { events, turnEndSeq } = withRoutePrefix({
      type: 'plugin/optional-route-card', data: { presentation: true }, ignorable: true,
    })

    const result = await projectDshTurnObservationV2(header, events, turnEndSeq, workspace)

    expect(result.status).toBe('OBSERVED')
    if (result.status !== 'OBSERVED') throw new Error('expected an observation')
    expect(result.observation.routeObservation).toEqual({
      provider: 'prefix-provider', model: 'prefix-model', complete: true,
    })
  })

  it('does not let a required unknown event after turn/end affect the completed Turn', async () => {
    const events = completeTurn('普通请求')
    events.push({
      type: 'plugin/future-required-state',
      seq: 9,
      time: 1_009,
      data: { future: true },
    })

    const result = await projectDshTurnObservationV2(header, events, 8, workspace)

    expect(result.status).toBe('OBSERVED')
    if (result.status !== 'OBSERVED') throw new Error('expected an observation')
    expect(result.observation.completeness).toBe('COMPLETE')
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
