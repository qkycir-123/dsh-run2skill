import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/host/index.js'
import type { DshV2ProductionRuntimeOptions } from '../src/host/v2-production-runtime.js'
import type { LearningSkillView } from '../src/application/learn/index.js'
import type { DshSessionEvent } from '../src/adapters/dsh-session/types.js'
import { deriveSessionCwdDigest, deriveSessionLifecycleKey } from '../src/domain/observe/signal-key.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'

const ports = vi.hoisted(() => ({
  scope: {},
  options: undefined as DshV2ProductionRuntimeOptions<LearningSkillView<Agent>> | undefined,
  acquire: undefined as (() => Promise<void>) | undefined,
}))
const configuration = {
  profile: 'web', presetId: 'standard', providerName: 'filesystem',
  includeDefaultRoots: true, customSkillDirs: [],
}
type Agent = {
  id: string
  ctx: { registry: { values(): never[] } }
  session: { header: { version: number; id: string; createdAt: number; cwd: string; agentPreset: string }; snapshotEvents(): DshSessionEvent[] }
}

vi.mock('../src/host/v2-production-runtime.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/host/v2-production-runtime.js')>()
  return { ...actual, DshV2ProductionRuntime: class extends actual.DshV2ProductionRuntime<LearningSkillView<Agent>> {
    constructor(domain: ConstructorParameters<typeof actual.DshV2ProductionRuntime>[0], options: DshV2ProductionRuntimeOptions<LearningSkillView<Agent>>) {
      super(domain, options)
      ports.options = options
    }
  } }
})
vi.mock('../src/adapters/dsh-skills/stock-root-contract.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/adapters/dsh-skills/stock-root-contract.js')>(),
  resolveStockSkillRuntimeConfiguration: async () => configuration,
}))
vi.mock('../src/adapters/dsh-skills/stock-preset-mount.js', () => ({
  stockPresetMounts: { standingMountFor: async () => ({ key: ports.scope }) },
  stockColdPresetMounts: {},
}))
vi.mock('../src/adapters/dsh-skills/stock-cold-preset.js', () => ({
  currentStockPresetMount: () => ({}),
  acquireStockColdPreset: async () => {
    await ports.acquire?.()
    return { lease: { key: ports.scope, async [Symbol.asyncDispose]() {} }, configuration }
  },
}))

let dispose: (() => Promise<void>) | undefined
afterEach(async () => { await dispose?.(); dispose = undefined; ports.options = undefined; ports.acquire = undefined })

async function harness() {
  const listeners = new Map<string, (...args: never[]) => unknown>()
  const events: DshSessionEvent[] = []
  const header = { version: 1, id: 'directory-session', createdAt: 1_725_000_000_000, cwd: 'D:/project', agentPreset: 'standard' }
  const agent: Agent = { id: header.id, ctx: { registry: { values: () => [] } }, session: { header, snapshotEvents: () => events } }
  const domain = createMemoryRun2skillV2Domain()
  const context = {
    sessions: { get: () => undefined }, agents: { get: () => undefined },
    llm: { async resolveModelInfo() { return { context: { contextWindow: 16_384 } } }, async *stream() { yield { type: 'finish' as const, reason: { kind: 'stop' } } } },
    skills: { async snapshot() { return { skills: [], complete: true } }, async get() { return undefined } },
    agentPresets: { async acquireScope() { return { key: ports.scope, async [Symbol.asyncDispose]() {} } } },
    fs: {}, reflect: { provide() {} }, emit() {},
    sessionPersistence: { async list() { return [] }, async open() { throw new Error('unused') } },
    storageDomain: { async open() { return domain } },
    workspaceRegistry: { async resolveByPath() { return { id: 'workspace', path: header.cwd } }, get() { return { id: 'workspace', path: header.cwd } } },
    on(event: string, listener: (...args: never[]) => unknown) { listeners.set(event, listener) },
  }
  dispose = await apply(context, { automaticLearning: { get: () => true } })
  const dispatch = async (name: string, ...args: unknown[]) => await listeners.get(name)?.(...args as never[])
  const lifecycleKey = deriveSessionLifecycleKey({ rootSessionId: header.id, sessionCreatedAt: header.createdAt, sessionCwdDigest: deriveSessionCwdDigest(header.cwd) })
  return {
    agent, lifecycleKey,
    capture: async () => await dispatch('agent/pre-step', { agent, step: 2 }, async () => undefined),
    retire: async () => await dispatch('agent/disposed', { agent }),
    change: async (notify = true, snapshot = true) => {
      const event = { type: 'working-directory/change', seq: 0, time: header.createdAt + 1, data: { cwd: 'D:/elsewhere' } }
      if (snapshot) events.push(event)
      if (notify) await dispatch('session/event', agent.session, event)
    },
  }
}

describe('Host directory transition permissions', () => {
  it('revokes live and retained cold views and does not restore them after Agent disposal', async () => {
    const h = await harness()
    await h.capture()
    const live = ports.options!.resolveSession(h.lifecycleKey)!
    expect(live).toBeDefined()
    await h.retire()
    const cold = ports.options!.resolveSession(h.lifecycleKey)!
    expect(cold).toBeDefined()
    await h.capture()
    await h.change()
    expect(ports.options!.resolveSession(h.lifecycleKey)).toBeUndefined()
    expect(ports.options!.resolveSessionByView(live.view)).toBeUndefined()
    expect(ports.options!.resolveSessionByView(cold.view)).toBeUndefined()
    await h.retire()
    expect(ports.options!.resolveSession(h.lifecycleKey)).toBeUndefined()
  })

  it('does not repopulate a dormant snapshot when the directory changes during capture', async () => {
    const h = await harness()
    const pending = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    ports.acquire = async () => { entered.resolve(); await pending.promise }
    const capture = h.capture()
    await entered.promise
    await h.change()
    pending.resolve()
    await capture
    await h.retire()
    expect(ports.options!.resolveSession(h.lifecycleKey)).toBeUndefined()
  })

  it('rejects an invalid live cache before falling back to a retained snapshot', async () => {
    const h = await harness()
    await h.capture()
    expect(ports.options!.resolveSession(h.lifecycleKey)).toBeDefined()
    await h.change(false)
    expect(ports.options!.resolveSession(h.lifecycleKey)).toBeUndefined()
    await h.retire()
    expect(ports.options!.resolveSession(h.lifecycleKey)).toBeUndefined()
  })

  it('revokes an issued live view as soon as the directory event is delivered', async () => {
    const h = await harness()
    await h.capture()
    const live = ports.options!.resolveSession(h.lifecycleKey)!
    await h.change(true, false)
    expect(ports.options!.resolveSessionByView(live.view)).toBeUndefined()
    await h.retire()
    await h.capture()
    expect(ports.options!.resolveSession(h.lifecycleKey)).toBeUndefined()
  })
})
