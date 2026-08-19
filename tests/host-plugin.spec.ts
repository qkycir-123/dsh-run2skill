import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/host/index.js'
import type { ObserveSummaryRpcHandler } from '../src/adapters/dsh-connection/observe-summary-rpc.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'

describe('Host plugin assembly', () => {
  it('declares only the approved DSH services', () => {
    expect(name).toBe('run2skill')
    expect(inject).toEqual([
      'sessions',
      'sessionPersistence',
      'storageDomain',
      'workspaceRegistry',
      'connection',
    ])
    expect(inject).not.toContain('llm')
    expect(inject).not.toContain('skills')
    expect(inject).not.toContain('settings')
  })

  it('registers ingress before recovery and exposes one durable captured item', async () => {
    const order: string[] = []
    const domain = createMemoryRun2skillDomain()
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
      sessions: {},
      sessionPersistence: {
        async listSnapshots() {
          order.push('list-snapshots')
          return [{ header, revision }]
        },
        async readFrom() { return { meta: header, events: persistedEvents } },
      },
      storageDomain: {
        async open() {
          order.push('domain-open')
          return domain
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
      on(event: string, listener: typeof eventListener) {
        expect(event).toBe('session/event')
        order.push('listener')
        eventListener = listener
      },
    }

    const dispose = await apply(context)

    expect(order.indexOf('listener')).toBeLessThan(order.indexOf('domain-open'))
    expect(eventListener).toBeTypeOf('function')
    expect(domain.workItems.size).toBe(0)
    persistedEvents = events
    revision = 'jsonl:1'
    for (const event of events) eventListener?.({ header }, event)
    await vi.waitFor(() => expect(domain.workItems.size).toBe(1))
    const response = await rpcHandler?.(
      'observe-summary',
      { apiVersion: 1 },
      new AbortController().signal,
    )
    expect(response).toMatchObject({
      ok: true,
      value: { status: 'READY', capturedCount: 1, blockedCaptureCount: 0 },
    })

    await dispose()
    expect(disposeRpc).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
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
      sessions: {},
      sessionPersistence: {
        async listSnapshots() { return snapshots },
        async readFrom() { return { meta: header, events } },
      },
      storageDomain: { async open() { return domain } },
      workspaceRegistry: { async resolveByPath() { return undefined } },
      connection: { rpc: { handle() { return async () => undefined } } },
      on(_event: string, listener: typeof eventListener) { eventListener = listener },
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
      sessions: {},
      sessionPersistence: {
        async listSnapshots() { return [{ header, revision }] },
        async readFrom() { return { meta: header, events } },
      },
      storageDomain: { async open() { return domain } },
      workspaceRegistry: { async resolveByPath() { return undefined } },
      connection: { rpc: { handle() { return async () => undefined } } },
      on(_event: string, listener: typeof eventListener) { eventListener = listener },
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

  it('closes an opened domain when its durable schema cannot initialize', async () => {
    const domain = createMemoryRun2skillDomain()
    const close = vi.fn(async () => undefined)
    domain.close = close
    domain.global.get = () => ({ schemaVersion: 999 } as never)
    const context = {
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
})
