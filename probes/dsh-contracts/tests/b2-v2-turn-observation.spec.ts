import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  ToolCallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectDshTurnObservationV2 } from '../src/adapters/dsh-session/v2-turn-observation.js'
import { TurnObservationV2Schema } from '../src/domain/v2/index.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('B2 TurnObservationV2 on real DSH Session persistence', () => {
  it('projects durable direct-user, route, assistant, and paired tool facts without later-Turn leakage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-run2skill-b2-v2-observation-'))
    temporaryDirectories.push(directory)
    const ctx = new Context()
    const sessionFiber = await ctx.plugin(SessionStore)
    const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, {
      root: join(directory, 'sessions'), compression: 'none',
    })
    try {
      const session = ctx.sessions.create(SessionId('run2skill-b2-v2-observation'), {
        meta: { cwd: directory, createdAt: 100 },
      })
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '把这个流程保存成 Skill，以后可以复用。' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('request/header', {
        header: { config: { provider: 'session-provider', model: 'session-model' } },
        reason: 'initial',
      })
      const callId = ToolCallId('run2skill-observation-call')
      session.append('assistant/message', {
        turn: 1,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'text', text: `准备写入。${['Authori', 'zation: ', 'Bear', 'er secret-probe-token'].join('')}` },
            { type: 'tool-call', id: callId, name: 'write', arguments: '{}' },
          ],
          source: { kind: 'model', provider: 'session-provider', model: 'session-model' },
        }),
      }, { surfaceOp: 'append' })
      session.append('tool/call', {
        turn: 1, step: 1, callId, name: 'write', arguments: '{}',
      })
      session.append('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: 'real durable tool result' }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const capturedEndSeq = session.snapshotEvents().at(-1)!.seq

      session.append('turn/start', { turn: 2 })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'future turn must not leak' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('turn/end', { turn: 2, reason: { kind: 'cancelled' } })
      await ctx.sessions.flush(session)

      const loaded = await ctx.sessionPersistence.load(session.id)
      const projected = await projectDshTurnObservationV2(
        loaded.meta,
        loaded.events,
        capturedEndSeq,
        {
          resolve: async () => ({
            status: 'BOUND', workspaceId: 'real-dsh-workspace', canonicalPath: directory,
          }),
        },
      )
      expect(projected.status).toBe('OBSERVED')
      if (projected.status !== 'OBSERVED') return
      expect(TurnObservationV2Schema.parse(projected.observation)).toEqual(projected.observation)
      expect(projected.observation).toMatchObject({
        completeness: 'COMPLETE',
        explicitSaveRequested: true,
        routeObservation: {
          provider: 'session-provider', model: 'session-model', complete: true,
        },
        toolOutcomeSummary: [{ toolName: 'write', outcome: 'SUCCEEDED' }],
      })
      const serialized = JSON.stringify(projected.observation)
      expect(serialized).not.toContain('secret-probe-token')
      expect(serialized).not.toContain('real durable tool result')
      expect(serialized).not.toContain('future turn must not leak')
    } finally {
      await persistenceFiber.dispose()
      await sessionFiber.dispose()
    }
  })
})
