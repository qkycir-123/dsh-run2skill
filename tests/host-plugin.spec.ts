import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/host/index.js'
import type { ObserveSummaryRpcHandler } from '../src/adapters/dsh-connection/observe-summary-rpc.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { createMemoryLearningDiagnosticDomain } from './support/memory-learning-diagnostic-domain.js'
import { makeWorkItem } from './support/work-item-fixture.js'
import type { DshSettingsPort } from '../src/adapters/dsh-settings/automatic-learning.js'

function settingsService(): DshSettingsPort {
  return {
    register<T>(_namespace: string, schema: (value?: T | null) => T) {
      const value = schema({} as T)
      return { get: () => value, watch: () => () => {} }
    },
  }
}

function learningServices() {
  return {
    settings: settingsService(),
    llm: {
      async resolveModelInfo() { return { context: { contextWindow: 16_384 } } },
      async *stream() {
        yield { type: 'finish' as const, reason: { kind: 'stop' } }
      },
    },
    skills: {
      async snapshot() { return { skills: [], complete: true } },
      async get() { return undefined },
    },
    agentPresets: {
      composedPreset() { return undefined },
      async resolve(id: string) { return { id, trust: 'system' as const } },
      async read() { return '' },
    },
  }
}

describe('Host plugin assembly', () => {
  it('declares only the approved DSH services', () => {
    expect(name).toBe('run2skill')
    expect(inject).toEqual([
      'sessions',
      'sessionPersistence',
      'storageDomain',
      'workspaceRegistry',
      'connection',
      'llm',
      'skills',
      'settings',
      'agentPresets',
    ])
  })

  it('registers ingress before recovery and exposes one durable captured item', async () => {
    const order: string[] = []
    const domain = createMemoryRun2skillDomain()
    const diagnosticDomain = createMemoryLearningDiagnosticDomain()
    const diagnosticClose = vi.fn(async () => { order.push('diagnostic-close') })
    diagnosticDomain.close = diagnosticClose
    const close = vi.fn(async () => { order.push('domain-close') })
    domain.close = close
    const header = { version: 1, id: 'session-1', createdAt: 1_725_000_000_000 }
    let revision = 'jsonl:0'
    let persistedEvents: Array<{ type: string; seq: number; time: number; data: unknown }> = []
    const events = [
      { type: 'turn/start', seq: 0, time: 1_725_000_001_000, data: { turn: 0 } },
      {
        type: 'user/message', seq: 1, time: 1_725_000_001_100,
        data: {
          id: 'message-1', source: { kind: 'user' },
          content: [{ type: 'text', text: '把这个流程保存成 Skill。' }],
        },
      },
      {
        type: 'turn/end', seq: 2, time: 1_725_000_002_000,
        data: { turn: 0, reason: { kind: 'completed' } },
      },
    ]
    let eventListener: ((session: { header: typeof header }, event: typeof events[number]) => void) | undefined
    let rpcHandler: ObserveSummaryRpcHandler | undefined
    const disposeRpc = vi.fn(async () => { order.push('rpc-dispose') })
    const context = {
      ...learningServices(),
      sessions: {},
      sessionPersistence: {
        async listSnapshots() {
          order.push('list-snapshots')
          return [{ header, revision }]
        },
        async readFrom() { return { meta: header, events: persistedEvents } },
      },
      storageDomain: {
        async open(spec: { readonly name: string }) {
          order.push(`${spec.name}-open`)
          return spec.name === 'run2skill_learning_diagnostics_v1' ? diagnosticDomain : domain
        },
      },
      workspaceRegistry: { async resolveByPath() { return undefined } },
      connection: {
        rpc: {
          handle(_channel: string, handler: ObserveSummaryRpcHandler) {
            rpcHandler = handler
            return disposeRpc
          },
        },
      },
      on(event: string, listener: (...args: never[]) => unknown) {
        order.push('listener')
        if (event === 'session/event') {
          eventListener = listener as unknown as typeof eventListener
        }
      },
    }

    const dispose = await apply(context)

    expect(order.indexOf('listener')).toBeLessThan(order.indexOf('run2skill_v1-open'))
    expect(eventListener).toBeTypeOf('function')
    expect(domain.workItems.size).toBe(0)
    persistedEvents = events
    revision = 'jsonl:1'
    for (const event of events) eventListener?.({ header }, event)
    await vi.waitFor(() => expect(domain.workItems.size).toBe(1))
    await vi.waitFor(() => expect([...domain.workItems.values()][0]?.processingState).toBe('NEEDS_ATTENTION'))
    const response = await rpcHandler?.(
      'observe-summary',
      { apiVersion: 1 },
      new AbortController().signal,
    )
    expect(response).toMatchObject({
      ok: true,
      value: {
        status: 'READY',
        capturedCount: 0,
        blockedCaptureCount: 0,
        learning: { needsAttention: 1 },
      },
    })

    await dispose()
    expect(disposeRpc).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(diagnosticClose).toHaveBeenCalledOnce()
    expect(order.indexOf('diagnostic-close')).toBeLessThan(order.indexOf('domain-close'))
    expect(order.indexOf('rpc-dispose')).toBeLessThan(order.indexOf('domain-close'))
  })

  it('captures the first durable Turn of a Root Session created after activation', async () => {
    const domain = createMemoryRun2skillDomain()
    const header = { version: 1, id: 'new-session', createdAt: 1_725_000_000_000 }
    const events = [
      { type: 'turn/start', seq: 0, time: 1_725_000_001_000, data: { turn: 0 } },
      {
        type: 'user/message', seq: 1, time: 1_725_000_001_100,
        data: {
          id: 'message-1', source: { kind: 'user' },
          content: [{ type: 'text', text: '把这个流程保存成 Skill。' }],
        },
      },
      {
        type: 'turn/end', seq: 2, time: 1_725_000_002_000,
        data: { turn: 0, reason: { kind: 'completed' } },
      },
    ]
    let snapshots: Array<{ header: typeof header; revision: string }> = []
    let eventListener: ((session: { header: typeof header }, event: typeof events[number]) => void) | undefined
    const context = {
      ...learningServices(),
      sessions: {},
      sessionPersistence: {
        async listSnapshots() { return snapshots },
        async readFrom() { return { meta: header, events } },
      },
      storageDomain: { async open() { return domain } },
      workspaceRegistry: { async resolveByPath() { return undefined } },
      connection: { rpc: { handle() { return async () => undefined } } },
      on(event: string, listener: (...args: never[]) => unknown) {
        if (event === 'session/event') {
          eventListener = listener as unknown as typeof eventListener
        }
      },
    }

    const dispose = await apply(context)
    snapshots = [{ header, revision: 'jsonl:1' }]
    for (const event of events) eventListener?.({ header }, event)

    await vi.waitFor(() => expect(domain.workItems.size).toBe(1))
    expect(Object.keys(domain.global.get().sessions)).toHaveLength(1)
    await dispose()
  })

  it('does not capture user text from a Turn that started before the activation fence', async () => {
    const domain = createMemoryRun2skillDomain()
    const header = { version: 1, id: 'mid-turn-session', createdAt: 1_725_000_000_000 }
    const beforeActivation = [
      { type: 'turn/start', seq: 0, time: 1_725_000_001_000, data: { turn: 0 } },
      {
        type: 'user/message', seq: 1, time: 1_725_000_001_100,
        data: {
          id: 'message-1', source: { kind: 'user' },
          content: [{ type: 'text', text: '把这个流程保存成 Skill。' }],
        },
      },
    ]
    const turnEnd = {
      type: 'turn/end', seq: 2, time: 1_725_000_002_000,
      data: { turn: 0, reason: { kind: 'completed' } },
    }
    let events = beforeActivation
    let revision = 'jsonl:0'
    let eventListener: ((session: { header: typeof header }, event: typeof turnEnd) => void) | undefined
    const context = {
      ...learningServices(),
      sessions: {},
      sessionPersistence: {
        async listSnapshots() { return [{ header, revision }] },
        async readFrom() { return { meta: header, events } },
      },
      storageDomain: { async open() { return domain } },
      workspaceRegistry: { async resolveByPath() { return undefined } },
      connection: { rpc: { handle() { return async () => undefined } } },
      on(event: string, listener: (...args: never[]) => unknown) {
        if (event === 'session/event') {
          eventListener = listener as unknown as typeof eventListener
        }
      },
    }

    const dispose = await apply(context)
    events = [...beforeActivation, turnEnd]
    revision = 'jsonl:1'
    eventListener?.({ header }, turnEnd)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(domain.workItems.size).toBe(0)
    const checkpoint = Object.values(domain.global.get().sessions)[0]
    expect(checkpoint?.activationFenceSeq).toBe(2)
    expect(checkpoint?.durableNextSeq).toBe(2)
    await dispose()
  })

  it('borrows the exact live Agent without changing the pre-step waterfall decision', async () => {
    const domain = createMemoryRun2skillDomain()
    const agent = {
      id: 'session-1',
      ctx: { registry: { values: () => [] } },
      session: { header: { id: 'session-1', createdAt: 1_725_000_000_000, cwd: 'D:\\workspace' } },
    }
    let preStep: ((payload: { agent: typeof agent }, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    let agentDisposed: ((payload: { agent: typeof agent }) => void) | undefined
    let registeredAgentCreated = false
    const context = {
      ...learningServices(),
      sessions: {},
      sessionPersistence: {
        async listSnapshots() { return [] },
        async readFrom() { throw new Error('must not read') },
      },
      storageDomain: { async open() { return domain } },
      workspaceRegistry: { async resolveByPath() { return undefined } },
      connection: { rpc: { handle() { return async () => undefined } } },
      on(event: string, listener: (...args: never[]) => unknown) {
        if (event === 'agent/pre-step') {
          preStep = listener as unknown as typeof preStep
        } else if (event === 'agent/disposed') {
          agentDisposed = listener as unknown as typeof agentDisposed
        } else if (event === 'agent/created') {
          registeredAgentCreated = true
        }
      },
    }
    const dispose = await apply(context)
    const decision = { kind: 'enter', messages: [] }
    const next = vi.fn(async () => decision)

    expect(registeredAgentCreated).toBe(false)
    await expect(preStep?.({ agent }, next)).resolves.toBe(decision)
    expect(next).toHaveBeenCalledOnce()
    agentDisposed?.({ agent })
    await dispose()
  })

  it('closes an opened domain when its durable schema cannot initialize', async () => {
    const domain = createMemoryRun2skillDomain()
    const close = vi.fn(async () => undefined)
    domain.close = close
    domain.global.get = () => ({ schemaVersion: 999 } as never)
    const context = {
      ...learningServices(),
      sessions: {},
      sessionPersistence: {
        async listSnapshots() { return [] },
        async readFrom() { throw new Error('must not read') },
      },
      storageDomain: { async open() { return domain } },
      workspaceRegistry: { async resolveByPath() { return undefined } },
      connection: { rpc: { handle() { return async () => undefined } } },
      on() {},
    }

    const dispose = await apply(context)

    expect(close).toHaveBeenCalledOnce()
    await dispose()
  })

  it('closes the runtime even when RPC disposal fails', async () => {
    const domain = createMemoryRun2skillDomain()
    const close = vi.fn(async () => undefined)
    domain.close = close
    const context = {
      ...learningServices(),
      sessions: {},
      sessionPersistence: {
        async listSnapshots() { return [] },
        async readFrom() { throw new Error('must not read') },
      },
      storageDomain: { async open() { return domain } },
      workspaceRegistry: { async resolveByPath() { return undefined } },
      connection: {
        rpc: { handle() { return async () => { throw new Error('synthetic rpc dispose failure') } } },
      },
      on() {},
    }
    const dispose = await apply(context)

    await expect(dispose()).rejects.toThrow('synthetic rpc dispose failure')
    expect(close).toHaveBeenCalledOnce()
  })

  it('continues with the main domain and exposes a non-sensitive health code when sidecar open fails', async () => {
    const domain = createMemoryRun2skillDomain()
    const sidecar = createMemoryLearningDiagnosticDomain()
    const base = makeWorkItem()
    const item = {
      ...base,
      processingState: 'LEARNED' as const,
      learning: { proposal: { persistenceScope: 'USER' as const } } as never,
    }
    domain.workItems.set(item.workItemId, item)
    const lineageId = `lin_${'f'.repeat(64)}`
    domain.lineages.set(lineageId, {
      scope: 'USER',
      revisions: [{ committedAt: '2026-08-20T00:00:00.000Z' }],
    } as never)
    sidecar.records.set(`${item.workItemId}:1:1`, {
      schemaVersion: 1,
      workItemId: item.workItemId,
      workItemRevision: item.revision,
      attempt: 1,
      requestOrdinal: 1,
      callKind: 'PRIMARY',
      callOutcome: 'FAILED',
      failureCode: 'MODEL_TERMINAL_FAILURE',
      failureOccurredAt: '2026-08-20T00:00:01.000Z',
      detail: 'MODEL_USAGE_INVALID',
    })
    let sidecarAvailable = false
    let rpcHandler: ObserveSummaryRpcHandler | undefined
    const context = {
      ...learningServices(),
      sessions: {},
      sessionPersistence: {
        async listSnapshots() { return [] },
        async readFrom() { throw new Error('must not read') },
      },
      storageDomain: {
        async open(spec: { readonly name: string }) {
          if (spec.name === 'run2skill_learning_diagnostics_v1') {
            if (!sidecarAvailable) throw new Error('synthetic sidecar open failure')
            return sidecar
          }
          return domain
        },
      },
      workspaceRegistry: { async resolveByPath() { return undefined } },
      connection: { rpc: { handle(_channel: string, handler: ObserveSummaryRpcHandler) {
        rpcHandler = handler
        return async () => undefined
      } } },
      on() {},
    }

    const dispose = await apply(context)
    const response = await rpcHandler?.('observe-summary', { apiVersion: 1 }, new AbortController().signal)
    expect(response).toMatchObject({
      ok: true,
      value: { status: 'READY', lastHealthCode: 'LEARNING_DIAGNOSTIC_UNAVAILABLE' },
    })
    for (const request of [
      { apiVersion: 1 as const, scope: 'USER' as const },
      { apiVersion: 1 as const, scope: 'PROJECT' as const, workspaceId: 'workspace-1' },
    ]) {
      await expect(rpcHandler?.('purge/preview', request, new AbortController().signal))
        .resolves.toMatchObject({ ok: false, error: { code: 'PURGE_STORAGE_UNAVAILABLE' } })
    }
    expect(domain.workItems.has(item.workItemId)).toBe(true)
    expect(domain.lineages.has(lineageId)).toBe(true)
    expect(sidecar.records.size).toBe(1)
    await dispose()

    sidecarAvailable = true
    const recoveredDispose = await apply(context)
    const preview = await rpcHandler?.(
      'purge/preview', { apiVersion: 1, scope: 'USER' }, new AbortController().signal,
    )
    expect(preview).toMatchObject({ ok: true })
    if (preview === undefined || !preview.ok) throw new Error('expected recovered purge preview')
    const value = preview.value as { previewId: string; digest: string }
    sidecar.setUnavailable(true)
    await expect(rpcHandler?.('purge/confirm', {
      apiVersion: 1, scope: 'USER', previewId: value.previewId, digest: value.digest,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false, error: { code: 'PURGE_STORAGE_UNAVAILABLE' },
    })
    expect(domain.global.get().purgeJournal).toBeUndefined()
    expect(domain.workItems.has(item.workItemId)).toBe(true)
    expect(domain.lineages.has(lineageId)).toBe(true)
    expect(sidecar.records.size).toBe(1)

    sidecar.setUnavailable(false)
    sidecar.failNextHealthPuts(1)
    await expect(rpcHandler?.('purge/confirm', {
      apiVersion: 1, scope: 'USER', previewId: value.previewId, digest: value.digest,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false, error: { code: 'PURGE_STORAGE_UNAVAILABLE' },
    })
    expect(domain.global.get().purgeJournal).toBeUndefined()
    expect(domain.workItems.has(item.workItemId)).toBe(true)
    expect(domain.lineages.has(lineageId)).toBe(true)
    expect(sidecar.records.size).toBe(1)

    sidecar.failNextHealthDeletes(1)
    await expect(rpcHandler?.('purge/confirm', {
      apiVersion: 1, scope: 'USER', previewId: value.previewId, digest: value.digest,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false, error: { code: 'PURGE_STORAGE_UNAVAILABLE' },
    })
    expect(domain.global.get().purgeJournal).toBeUndefined()
    expect(domain.workItems.has(item.workItemId)).toBe(true)
    expect(domain.lineages.has(lineageId)).toBe(true)
    expect(sidecar.records.size).toBe(1)
    expect(sidecar.healthChecks.size).toBe(1)

    await expect(rpcHandler?.('purge/confirm', {
      apiVersion: 1, scope: 'USER', previewId: value.previewId, digest: value.digest,
    }, new AbortController().signal)).resolves.toMatchObject({ ok: true, value: { state: 'COMPLETED' } })
    expect(domain.workItems.has(item.workItemId)).toBe(false)
    expect(domain.lineages.has(lineageId)).toBe(false)
    expect(sidecar.records.size).toBe(0)
    expect(sidecar.healthChecks.size).toBe(0)
    await recoveredDispose()
  })
})
