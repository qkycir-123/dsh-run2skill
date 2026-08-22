import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshSessionActivityAdapter } from '../src/adapters/dsh-session/v2-session-activity.js'
import { deriveSessionCwdDigest, deriveSessionLifecycleKey } from '../src/domain/observe/signal-key.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('B2 v2 quiescence activity on real DSH Session services', () => {
  it('binds one stable durable root and rejects an unflushed live tail', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-run2skill-b2-v2-activity-'))
    temporaryDirectories.push(directory)
    const ctx = new Context()
    const sessionFiber = await ctx.plugin(SessionStore)
    const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, {
      root: join(directory, 'sessions'), compression: 'none',
    })
    try {
      const session = ctx.sessions.create(SessionId('run2skill-b2-v2-activity'), {
        meta: { cwd: directory, createdAt: 100 },
      })
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await ctx.sessions.flush(session)
      const sessionLifecycleKey = deriveSessionLifecycleKey({
        rootSessionId: session.header.id,
        sessionCreatedAt: session.header.createdAt,
        sessionCwdDigest: deriveSessionCwdDigest(session.header.cwd),
      })
      const adapter = new DshSessionActivityAdapter({
        persistence: ctx.sessionPersistence,
        sessions: ctx.sessions,
        agents: { get: () => undefined },
      })

      const stable = await adapter.observe(sessionLifecycleKey)
      expect(stable).toMatchObject({ complete: true, activeAgent: false })

      session.append('turn/start', { turn: 2 })
      await expect(adapter.observe(sessionLifecycleKey)).resolves.toMatchObject({ complete: false })

      session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      await ctx.sessions.flush(session)
      const advanced = await adapter.observe(sessionLifecycleKey)
      expect(advanced).toMatchObject({
        complete: true,
        activeAgent: false,
        durableLatestTurnEndSeq: 3,
        durableOpenTurn: false,
      })
      expect(advanced.activityRevision).not.toBe(stable.activityRevision)
    } finally {
      await persistenceFiber.dispose()
      await sessionFiber.dispose()
    }
  })
})
