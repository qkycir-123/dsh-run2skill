import { describe, expect, it, vi } from 'vitest'
import { DshV2ProductionRuntime } from '../src/host/v2-production-runtime.js'
import { RuntimeNotices } from '../src/application/capture/runtime-notices.js'
import { deriveSessionCwdDigest, deriveSessionLifecycleKey } from '../src/domain/observe/signal-key.js'
import type { DshSessionEvent, DshSessionHeader } from '../src/adapters/dsh-session/types.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'

describe('v2 production Host runtime', () => {
  it('activates fresh and routes a new durable Turn only into the v2 domain', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const close = vi.fn(async () => undefined)
    domain.close = close
    const header: DshSessionHeader = {
      version: 1,
      id: 'production-session',
      createdAt: 1_725_000_000_000,
      cwd: 'D:/workspace',
    }
    const events: DshSessionEvent[] = [
      { type: 'turn/start', seq: 0, time: header.createdAt + 1, data: { turn: 0 } },
      {
        type: 'request/header', seq: 1, time: header.createdAt + 2,
        data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-chat' } } },
      },
      {
        type: 'user/message', seq: 2, time: header.createdAt + 3,
        data: { id: 'user-1', source: { kind: 'user' }, content: [{ type: 'text', text: '继续完成任务。' }] },
      },
      {
        type: 'assistant/message', seq: 3, time: header.createdAt + 4,
        data: {
          turn: 0,
          message: {
            id: 'assistant-1', role: 'assistant', source: { kind: 'assistant' },
            content: [{ type: 'text', text: '任务已完成。' }],
          },
        },
      },
      { type: 'turn/end', seq: 4, time: header.createdAt + 5, data: { turn: 0, reason: { kind: 'completed' } } },
    ]
    let present = false
    let revision = 'rev-1'
    const view = { cwd: header.cwd, scope: {}, signal: new AbortController().signal }
    const lifecycleKey = deriveSessionLifecycleKey({
      rootSessionId: header.id,
      sessionCreatedAt: header.createdAt,
      sessionCwdDigest: deriveSessionCwdDigest(header.cwd),
    })
    const llmStream = vi.fn(async function * () { yield { type: 'finish' as const, reason: { kind: 'stop' } } })
    const runtime = new DshV2ProductionRuntime(domain, {
      persistence: {
        listSnapshots: async () => present ? [{ header, revision }] : [],
        readFrom: async (_id, fromSeq) => ({ meta: header, events: events.filter(event => event.seq >= fromSeq) }),
      },
      sessions: { get: () => undefined },
      agents: { get: () => undefined },
      llm: {
        resolveModelInfo: async () => ({ context: { contextWindow: 16_384 } }),
        stream: llmStream,
      },
      skills: {
        snapshot: async () => ({ complete: true, skills: [] }),
        get: async () => undefined,
      },
      workspace: {
        resolve: async () => ({ status: 'BOUND', workspaceId: 'workspace-1', canonicalPath: 'D:/workspace' }),
      },
      resolveWorkspace: async workspaceId => ({ workspaceId, canonicalPath: 'D:/workspace' }),
      notices: new RuntimeNotices(),
      resolveSession: key => key === lifecycleKey
        ? {
            header,
            view,
            configuration: {
              profile: 'web', presetId: 'standard', providerName: 'filesystem',
              includeDefaultRoots: true, customSkillDirs: [], usesContextFileSystem: true,
            },
            workspaceBinding: { workspaceId: 'workspace-1', canonicalPath: 'D:/workspace' },
          }
        : undefined,
      resolveSessionByView: candidate => candidate === view
        ? {
            header,
            view,
            configuration: {
              profile: 'web', presetId: 'standard', providerName: 'filesystem',
              includeDefaultRoots: true, customSkillDirs: [], usesContextFileSystem: true,
            },
            workspaceBinding: { workspaceId: 'workspace-1', canonicalPath: 'D:/workspace' },
          }
        : undefined,
      now: () => header.createdAt + 100,
    })

    await runtime.start()
    present = true
    revision = 'rev-2'
    await runtime.processCandidate({
      header,
      turn: 0,
      turnEndSeq: 4,
      turnStartSeq: 0,
      directUserMessages: [],
    })

    expect(domain.turnObservations.size).toBe(1)
    expect(domain.sessionBatches.size).toBe(0)
    expect(llmStream).not.toHaveBeenCalled()
    await runtime.close()
    expect(close).toHaveBeenCalledOnce()
  })

  it('keeps turns 1-4 model-free and makes exactly one detector call at turn 5', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const header: DshSessionHeader = {
      version: 1,
      id: 'five-turn-session',
      createdAt: 1_725_100_000_000,
      cwd: 'D:/workspace',
    }
    const events: DshSessionEvent[] = []
    for (let turn = 0; turn < 5; turn += 1) {
      const base = turn * 5
      events.push(
        { type: 'turn/start', seq: base, time: header.createdAt + base, data: { turn } },
        {
          type: 'request/header', seq: base + 1, time: header.createdAt + base + 1,
          data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-chat' } } },
        },
        {
          type: 'user/message', seq: base + 2, time: header.createdAt + base + 2,
          data: {
            id: `user-${String(turn)}`, source: { kind: 'user' },
            content: [{ type: 'text', text: `完成第 ${String(turn + 1)} 步。` }],
          },
        },
        {
          type: 'assistant/message', seq: base + 3, time: header.createdAt + base + 3,
          data: {
            turn,
            message: {
              id: `assistant-${String(turn)}`, role: 'assistant', source: { kind: 'assistant' },
              content: [{ type: 'text', text: `第 ${String(turn + 1)} 步已完成。` }],
            },
          },
        },
        { type: 'turn/end', seq: base + 4, time: header.createdAt + base + 4, data: { turn, reason: { kind: 'completed' } } },
      )
    }
    let visibleTail = -1
    let present = false
    const view = { cwd: header.cwd, scope: {}, signal: new AbortController().signal }
    const lifecycleKey = deriveSessionLifecycleKey({
      rootSessionId: header.id,
      sessionCreatedAt: header.createdAt,
      sessionCwdDigest: deriveSessionCwdDigest(header.cwd),
    })
    const stream = vi.fn(async function * () {
      yield { type: 'finish' as const, reason: { kind: 'stop' } }
    })
    const runtime = new DshV2ProductionRuntime(domain, {
      persistence: {
        listSnapshots: async () => present ? [{ header, revision: `rev-${String(visibleTail)}` }] : [],
        readFrom: async (_id, fromSeq) => ({
          meta: header,
          events: events.filter(event => event.seq >= fromSeq && event.seq <= visibleTail),
        }),
      },
      sessions: { get: () => undefined },
      agents: { get: () => undefined },
      llm: {
        resolveModelInfo: async () => ({ context: { contextWindow: 16_384 } }),
        stream,
      },
      skills: {
        snapshot: async () => ({ complete: true, skills: [] }),
        get: async () => undefined,
      },
      workspace: {
        resolve: async () => ({ status: 'BOUND', workspaceId: 'workspace-1', canonicalPath: 'D:/workspace' }),
      },
      resolveWorkspace: async workspaceId => ({ workspaceId, canonicalPath: 'D:/workspace' }),
      notices: new RuntimeNotices(),
      resolveSession: key => key === lifecycleKey
        ? {
            header,
            view,
            configuration: {
              profile: 'web', presetId: 'standard', providerName: 'filesystem',
              includeDefaultRoots: true, customSkillDirs: [], usesContextFileSystem: true,
            },
            workspaceBinding: { workspaceId: 'workspace-1', canonicalPath: 'D:/workspace' },
          }
        : undefined,
      resolveSessionByView: candidate => candidate === view
        ? {
            header,
            view,
            configuration: {
              profile: 'web', presetId: 'standard', providerName: 'filesystem',
              includeDefaultRoots: true, customSkillDirs: [], usesContextFileSystem: true,
            },
            workspaceBinding: { workspaceId: 'workspace-1', canonicalPath: 'D:/workspace' },
          }
        : undefined,
      now: () => header.createdAt + 100_000,
    })

    await runtime.start()
    present = true
    for (let turn = 0; turn < 5; turn += 1) {
      visibleTail = turn * 5 + 4
      await runtime.processCandidate({
        header,
        turn,
        turnStartSeq: turn * 5,
        turnEndSeq: visibleTail,
        directUserMessages: [],
      })
      expect(stream).toHaveBeenCalledTimes(turn < 4 ? 0 : 1)
    }
    expect(domain.turnObservations.size).toBe(5)
    expect(domain.sessionBatches.size).toBe(1)
    await runtime.close()
  })
})
