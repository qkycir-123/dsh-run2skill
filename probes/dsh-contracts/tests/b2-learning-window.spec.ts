import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectLearningWindow } from '../src/adapters/dsh-session/learning-window.js'
import { buildTurnObservation } from '../src/adapters/dsh-session/observation.js'
import { buildLearningEnvelope } from '../src/domain/learn/envelope.js'
import { CaptureWorkItemV1Schema } from '../src/domain/observe/schemas.js'
import { buildSignalKey, deriveWorkItemId } from '../src/domain/observe/signal-key.js'
import { analyzeCheapTriggerV1 } from '../src/domain/observe/trigger.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('B2 Learning Window on real DSH Session persistence', () => {
  it('inherits the trigger-Turn route and excludes a later durable Turn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-run2skill-b2-window-'))
    temporaryDirectories.push(directory)
    const ctx = new Context()
    const sessionFiber = await ctx.plugin(SessionStore)
    const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, {
      root: join(directory, 'sessions'), compression: 'none',
    })
    try {
      const session = ctx.sessions.create(SessionId('run2skill-b2-window'), {
        meta: { cwd: directory, createdAt: 100 },
      })
      session.append('turn/start', { turn: 1 })
      const direct = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Save this workflow as a Skill.' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('request/header', {
        header: { config: { provider: 'session-provider', model: 'session-model' } },
        reason: 'initial',
      })
      session.append('assistant/message', {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'Captured the reusable workflow.' }],
          source: { provider: 'session-provider', model: 'session-model' },
        }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const capturedEndSeq = session.snapshotEvents().at(-1)!.seq

      session.append('turn/start', { turn: 2 })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'pass' + 'word=synthetic-future-value' }],
        source: { kind: 'plugin', plugin: 'fixture' },
      }), { surfaceOp: 'append' })
      session.append('step/start', { turn: 2, step: 1 })
      session.append('request/header', {
        header: { config: { provider: 'future-provider', model: 'future-model' } },
        reason: 'change',
      })
      session.append('assistant/message', {
        turn: 2,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'Future response.' }],
          source: { provider: 'future-provider', model: 'future-model' },
        }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 2, step: 1 })
      session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      await ctx.sessions.flush(session)

      const loaded = await ctx.sessionPersistence.load(session.id)
      const observed = buildTurnObservation(loaded.meta, loaded.events, capturedEndSeq)
      if (observed.status !== 'OBSERVED') throw new Error('real DSH Turn was not observable')
      const analysis = analyzeCheapTriggerV1(observed.observation.directUserMessages.map(message => ({
        messageSeq: message.messageSeq,
        sourceKind: 'user' as const,
        text: message.textBlocks.join('\n'),
      })))
      if (analysis.status !== 'COMPLETE' || analysis.evidenceRefs.length === 0) {
        throw new Error('real DSH trigger was not captured')
      }
      const signalKey = buildSignalKey({
        rootSessionId: observed.observation.rootSessionId,
        sessionCreatedAt: observed.observation.sessionCreatedAt,
        sessionCwdDigest: observed.observation.sessionCwdDigest,
        turn: observed.observation.turn,
        turnEndSeq: observed.observation.turnEndSeq,
        turnInstanceDigest: observed.observation.turnInstanceDigest,
      })
      const item = CaptureWorkItemV1Schema.parse({
        schemaVersion: 1,
        revision: 1,
        workItemId: deriveWorkItemId(signalKey),
        signalKey,
        captureReason: 'CHEAP_TRIGGER',
        createdAt: new Date(observed.observation.turnEndTime).toISOString(),
        updatedAt: new Date(observed.observation.turnEndTime).toISOString(),
        turnOutcomeKind: observed.observation.turnOutcomeKind,
        rootIdentity: { status: 'ROOT' },
        workspaceBinding: { status: 'UNREGISTERED', observedAt: new Date().toISOString() },
        scanStatus: 'COMPLETE',
        triggerHits: analysis.triggerHits,
        evidenceRefs: analysis.evidenceRefs,
        captureBlockers: [],
        processingState: 'CAPTURED',
      })
      expect(direct.seq).toBe(item.evidenceRefs[0]!.messageSeq)

      const projected = projectLearningWindow(loaded.meta, loaded.events, item)
      expect(projected.status).toBe('AVAILABLE')
      if (projected.status !== 'AVAILABLE') return
      expect(projected.projection.route).toEqual({
        provider: 'session-provider', model: 'session-model',
      })
      const built = buildLearningEnvelope(item, projected.projection)
      expect(built.status).toBe('AVAILABLE')
      if (built.status === 'AVAILABLE') {
        expect(built.serialized).not.toContain('future-provider')
        expect(built.serialized).not.toContain('synthetic-future-value')
      }
    } finally {
      await persistenceFiber.dispose()
      await sessionFiber.dispose()
    }
  })
})
