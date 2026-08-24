import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/host/index.js'
import type { ObserveSummaryRpcHandler } from '../src/adapters/dsh-connection/observe-summary-rpc.js'
import type { DshSettingsPort } from '../src/adapters/dsh-settings/automatic-learning.js'
import type { DshSessionEvent, DshSessionHeader } from '../src/adapters/dsh-session/types.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'
import { deriveSessionCwdDigest, deriveSessionLifecycleKey } from '../src/domain/observe/signal-key.js'

function settingsService(): DshSettingsPort {
  return {
    register<T>(_namespace: string, schema: (value?: T | null) => T) {
      const value = schema({} as T)
      return { get: () => value, watch: () => () => {} }
    },
  }
}

function turnEvents(header: DshSessionHeader): DshSessionEvent[] {
  return [
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
}

function services() {
  return {
    settings: settingsService(),
    sessions: { get: () => undefined },
    agents: { get: () => undefined },
    llm: {
      async resolveModelInfo() { return { context: { contextWindow: 16_384 } } },
      async *stream() { yield { type: 'finish' as const, reason: { kind: 'stop' } } },
    },
    skills: {
      async snapshot() { return { skills: [], complete: true } },
      async get() { return undefined },
    },
    agentPresets: {
      composedPreset() { return undefined },
      async resolve(id: string) { return { id, trust: 'system' as const } },
      async read() { return '' },
      async standingKeyFor(id?: string) { return { agentPreset: id ?? 'standard' } },
    },
    fs: {},
  }
}

describe('Host plugin v2 production cutover', () => {
  it('declares the live Agent and Session services required by the v2 quiescence fence', () => {
    expect(name).toBe('run2skill')
    expect(inject).toEqual([
      'agents',
      'sessions',
      'sessionPersistence',
      'storageDomain',
      'workspaceRegistry',
      'connection',
      'llm',
      'skills',
      'settings',
      'agentPresets',
      'fs',
    ])
  })

  it('registers ingress before fresh v2 activation and persists a later durable Turn without calling the model', async () => {
    const order: string[] = []
    const domain = createMemoryRun2skillV2Domain()
    const close = vi.fn(async () => { order.push('domain-close') })
    domain.close = close
    const header: DshSessionHeader = { version: 1, id: 'session-1', createdAt: Date.now(), cwd: 'D:/workspace' }
    const events = turnEvents(header)
    let present = false
    let revision = 'rev-1'
    let eventListener: ((session: { header: DshSessionHeader }, event: DshSessionEvent) => void) | undefined
    let rpcHandler: ObserveSummaryRpcHandler | undefined
    const stream = vi.fn(async function * () { yield { type: 'finish' as const, reason: { kind: 'stop' } } })
    const context = {
      ...services(),
      llm: { async resolveModelInfo() { return { context: { contextWindow: 16_384 } } }, stream },
      sessionPersistence: {
        async listSnapshots() {
          order.push('list-snapshots')
          return present ? [{ header, revision }] : []
        },
        async readFrom(_id: string, fromSeq: number) {
          return { meta: header, events: events.filter(event => event.seq >= fromSeq) }
        },
      },
      storageDomain: { async open() { order.push('run2skill_v2-open'); return domain } },
      workspaceRegistry: {
        async resolveByPath() { return { id: 'workspace-1', path: 'D:/workspace' } },
        get() { return { id: 'workspace-1', path: 'D:/workspace' } },
      },
      connection: { rpc: { handle(_channel: string, handler: ObserveSummaryRpcHandler) {
        rpcHandler = handler
        return async () => { order.push('rpc-dispose') }
      } } },
      on(event: string, listener: (...args: never[]) => unknown) {
        order.push(`listener:${event}`)
        if (event === 'session/event') eventListener = listener as unknown as typeof eventListener
      },
    }

    const dispose = await apply(context)
    expect(order.indexOf('listener:session/event')).toBeLessThan(order.indexOf('run2skill_v2-open'))
    present = true
    revision = 'rev-2'
    for (const event of events) eventListener?.({ header }, event)
    await vi.waitFor(() => expect(domain.turnObservations.size).toBe(1))
    expect(domain.sessionBatches.size).toBe(0)
    expect(stream).not.toHaveBeenCalled()
    await expect(rpcHandler?.('observe-summary', { apiVersion: 1 }, new AbortController().signal))
      .resolves.toMatchObject({ ok: true, value: { status: 'READY', capturedCount: 1 } })
    await expect(rpcHandler?.('recent-activity/list', {
      apiVersion: 1,
      currentScope: { kind: 'WORKSPACE', generation: 1, workspaceId: 'workspace-1' },
    }, new AbortController().signal))
      .resolves.toMatchObject({ ok: true, value: { items: [] } })
    await expect(rpcHandler?.('purge/status', { apiVersion: 1 }, new AbortController().signal))
      .resolves.toMatchObject({ ok: true, value: { state: 'IDLE' } })
    expect(order.filter(item => item === 'run2skill_v2-open')).toHaveLength(1)

    await dispose()
    expect(close).toHaveBeenCalledOnce()
    expect(order.indexOf('rpc-dispose')).toBeLessThan(order.indexOf('domain-close'))
  })

  it('does not reinterpret durable history that predates fresh v2 activation', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const header: DshSessionHeader = { version: 1, id: 'old-session', createdAt: 1_725_000_000_000 }
    const events = turnEvents(header)
    const context = {
      ...services(),
      sessionPersistence: {
        async listSnapshots() { return [{ header, revision: 'rev-1' }] },
        async readFrom(_id: string, fromSeq: number) {
          return { meta: header, events: events.filter(event => event.seq >= fromSeq) }
        },
      },
      storageDomain: { async open() { return domain } },
      workspaceRegistry: { async resolveByPath() { return undefined } },
      connection: { rpc: { handle() { return async () => undefined } } },
      on() {},
    }

    const dispose = await apply(context)
    expect(domain.turnObservations.size).toBe(0)
    expect(Object.values(domain.global.get().sessions)[0]?.observedThroughTurnEndSeq).toBe(4)
    await dispose()
  })

  it('durably prepares the batch window at step 1 before preserving the Agent waterfall decision', async () => {
    const domain = createMemoryRun2skillV2Domain()
    let preStep: ((payload: { agent: never; step: number }, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    const context = {
      ...services(),
      sessionPersistence: { async listSnapshots() { return [] }, async readFrom() { throw new Error('unused') } },
      storageDomain: { async open() { return domain } },
      workspaceRegistry: { async resolveByPath() { return undefined } },
      connection: { rpc: { handle() { return async () => undefined } } },
      on(event: string, listener: (...args: never[]) => unknown) {
        if (event === 'agent/pre-step') preStep = listener as unknown as typeof preStep
      },
    }
    const dispose = await apply(context)
    const agent = {
      id: 'agent-session',
      ctx: { registry: { values: () => [] } },
      session: { header: { version: 1, id: 'agent-session', createdAt: 1_725_000_000_000 }, events: [] },
    }
    const decision = { kind: 'enter', messages: [] }
    const next = vi.fn(async () => {
      domain.writeLog.push('next')
      return decision
    })
    const lifecycleKey = deriveSessionLifecycleKey({
      rootSessionId: agent.session.header.id,
      sessionCreatedAt: agent.session.header.createdAt,
      sessionCwdDigest: deriveSessionCwdDigest(undefined),
    })

    domain.writeLog.length = 0
    await expect(preStep?.({ agent: agent as never, step: 2 }, next)).resolves.toBe(decision)
    expect(domain.global.get().sessions[lifecycleKey]?.batchManifestBaseline).toBeUndefined()
    next.mockClear()

    domain.writeLog.length = 0
    await expect(preStep?.({ agent: agent as never, step: 1 }, next)).resolves.toBe(decision)
    expect(domain.global.get().sessions[lifecycleKey]?.batchManifestBaseline).toMatchObject({
      afterTurnEndSeq: 0,
      complete: false,
    })
    expect(domain.writeLog.indexOf('global')).toBeGreaterThanOrEqual(0)
    expect(domain.writeLog.indexOf('global')).toBeLessThan(domain.writeLog.indexOf('next'))
    expect(next).toHaveBeenCalledOnce()
    await dispose()
  })

  it('captures the previous durable Turn before preparing the next Turn baseline', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const header: DshSessionHeader = {
      version: 1, id: 'agent-session', createdAt: 1_725_000_000_000, cwd: 'D:/workspace',
    }
    const events = turnEvents(header)
    let present = false
    let eventListener: ((session: { header: DshSessionHeader }, event: DshSessionEvent) => void) | undefined
    let preStep: ((payload: { agent: never; step: number }, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    const context = {
      ...services(),
      sessionPersistence: {
        async listSnapshots() { return present ? [{ header, revision: 'jsonl:4' }] : [] },
        async readFrom(_id: string, fromSeq: number) {
          return { meta: header, events: events.filter(event => event.seq >= fromSeq) }
        },
      },
      storageDomain: { async open() { return domain } },
      workspaceRegistry: {
        async resolveByPath() { return { id: 'workspace-1', path: 'D:/workspace' } },
        get() { return { id: 'workspace-1', path: 'D:/workspace' } },
      },
      connection: { rpc: { handle() { return async () => undefined } } },
      on(event: string, listener: (...args: never[]) => unknown) {
        if (event === 'session/event') eventListener = listener as unknown as typeof eventListener
        if (event === 'agent/pre-step') preStep = listener as unknown as typeof preStep
      },
    }
    const dispose = await apply(context)
    const agent = {
      id: header.id,
      ctx: { registry: { values: () => [] } },
      session: { header, events: [] },
    }
    const decision = { kind: 'enter', messages: [] }
    const next = vi.fn(async () => decision)
    const lifecycleKey = deriveSessionLifecycleKey({
      rootSessionId: header.id,
      sessionCreatedAt: header.createdAt,
      sessionCwdDigest: deriveSessionCwdDigest(header.cwd),
    })

    present = true
    for (const item of events) eventListener?.({ header }, item)
    await expect(preStep?.({ agent: agent as never, step: 1 }, next)).resolves.toBe(decision)

    expect(domain.turnObservations.size).toBe(1)
    expect(domain.global.get().sessions[lifecycleKey]).toMatchObject({
      observedThroughTurnEndSeq: 4,
      batchManifestBaseline: { afterTurnEndSeq: 0, complete: false },
    })
    expect(next).toHaveBeenCalledOnce()
    await dispose()
  })

  it('contains invalid Agent scope identity without blocking the pre-step waterfall', async () => {
    const domain = createMemoryRun2skillV2Domain()
    let preStep: ((payload: { agent: never; step: number }, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    const context = {
      ...services(),
      sessionPersistence: { async listSnapshots() { return [] }, async readFrom() { throw new Error('unused') } },
      storageDomain: { async open() { return domain } },
      workspaceRegistry: { async resolveByPath() { return undefined } },
      connection: { rpc: { handle() { return async () => undefined } } },
      on(event: string, listener: (...args: never[]) => unknown) {
        if (event === 'agent/pre-step') preStep = listener as unknown as typeof preStep
      },
    }
    const dispose = await apply(context)
    const agent = {
      id: 'agent-session',
      ctx: { registry: { values: () => [] } },
      session: { header: { version: 1, id: 'different-session', createdAt: 1_725_000_000_000 }, events: [] },
    }
    const decision = { kind: 'enter', messages: [] }
    const next = vi.fn(async () => decision)

    await expect(preStep?.({ agent: agent as never, step: 1 }, next)).resolves.toBe(decision)
    expect(next).toHaveBeenCalledOnce()
    await dispose()
  })

  it('closes the v2 runtime even when RPC disposal fails', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const close = vi.fn(async () => undefined)
    domain.close = close
    const context = {
      ...services(),
      sessionPersistence: { async listSnapshots() { return [] }, async readFrom() { throw new Error('unused') } },
      storageDomain: { async open() { return domain } },
      workspaceRegistry: { async resolveByPath() { return undefined } },
      connection: { rpc: { handle() { return async () => { throw new Error('synthetic rpc dispose failure') } } } },
      on() {},
    }
    const dispose = await apply(context)

    await expect(dispose()).rejects.toThrow('synthetic rpc dispose failure')
    expect(close).toHaveBeenCalledOnce()
  })
})
