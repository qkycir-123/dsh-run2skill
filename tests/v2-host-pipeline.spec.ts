import { describe, expect, it, vi } from 'vitest'
import { createDshV2PipelineRuntime } from '../src/host/v2-pipeline.js'
import { deriveSessionCwdDigest, deriveSessionLifecycleKey } from '../src/domain/observe/signal-key.js'
import type { DshSessionEvent, DshSessionHeader } from '../src/adapters/dsh-session/types.js'
import type { OwnershipObservationPort } from '../src/application/ownership/index.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'

const CREATED_AT = 1_725_000_000_000
const IDLE_MS = 30 * 60_000
const CWD = 'D:\\workspace'
const header: DshSessionHeader = { version: 1, id: 'session-v2', createdAt: CREATED_AT, cwd: CWD }

function lifecycleKey(): string {
  return deriveSessionLifecycleKey({
    rootSessionId: header.id,
    sessionCreatedAt: header.createdAt,
    sessionCwdDigest: deriveSessionCwdDigest(header.cwd),
  })
}

function turnEvents(turn: number): DshSessionEvent[] {
  const base = turn * 10
  return [
    { type: 'turn/start', seq: base, time: CREATED_AT + base, data: { turn } },
    {
      type: 'request/header', seq: base + 1, time: CREATED_AT + base + 1,
      data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-chat' } } },
    },
    {
      type: 'user/message', seq: base + 2, time: CREATED_AT + base + 2,
      data: {
        id: `user-${turn}`, source: { kind: 'user' },
        content: [{ type: 'text', text: `完成第 ${turn + 1} 步。` }],
      },
    },
    {
      type: 'assistant/message', seq: base + 3, time: CREATED_AT + base + 3,
      data: {
        turn,
        message: {
          id: `assistant-${turn}`, role: 'assistant', source: { kind: 'assistant' },
          content: [{ type: 'text', text: `已完成第 ${turn + 1} 步。` }],
        },
      },
    },
    {
      type: 'turn/end', seq: base + 4, time: CREATED_AT + base + 4,
      data: { turn, reason: { kind: 'completed' } },
    },
  ]
}

describe('v2 Host pipeline assembly', () => {
  it('keeps the first four Turns model-free and runs only detection at the fifth checkpoint', async () => {
    const domain = createMemoryRun2skillV2Domain()
    let modelCalls = 0
    let ownershipCalls = 0
    const ownership: OwnershipObservationPort = {
      observe: async () => {
        ownershipCalls += 1
        return { status: 'UNAVAILABLE', reasonCode: 'OBSERVATION_FAILED' }
      },
    }
    const runtime = createDshV2PipelineRuntime(domain, {
      llm: {
        resolveModelInfo: async () => ({ context: { contextWindow: 32_000 }, defaultMaxTokens: 4_096 }),
        stream: async function * () {
          modelCalls += 1
          yield { type: 'block-start' as const, index: 0, blockType: 'text' }
          yield { type: 'text-delta' as const, index: 0, text: '{"result":"NONE"}' }
          yield { type: 'block-end' as const, index: 0, block: { type: 'text', text: '{"result":"NONE"}' } }
          yield { type: 'usage' as const, usage: { inputTokens: 10, outputTokens: 4 } }
          yield { type: 'finish' as const, reason: { kind: 'stop' } }
        },
      },
      baseline: {
        capture: async () => ({
          observedAt: new Date(CREATED_AT - 1).toISOString(),
          rootManifestDigest: '1'.repeat(64), runtimeCatalogDigest: '2'.repeat(64), complete: true,
        }),
      },
      activity: { observe: async () => ({ complete: false }) },
      ownership,
      catalog: {
        recall: {
          snapshot: async () => { throw new Error('NONE must not recall') },
          read: async () => { throw new Error('NONE must not read a candidate') },
        },
        generation: {
          snapshot: async () => { throw new Error('NONE must not generate') },
          read: async () => { throw new Error('NONE must not read a generation target') },
        },
      },
    })
    await runtime.start()
    await runtime.prepareSessionWindow(lifecycleKey())

    const events: DshSessionEvent[] = []
    for (let turn = 0; turn < 5; turn += 1) {
      events.push(...turnEvents(turn))
      await expect(runtime.observeTurn(header, events, turn * 10 + 4, {
        resolve: async () => ({ status: 'BOUND', workspaceId: 'workspace-1', canonicalPath: CWD }),
      })).resolves.toMatchObject({ status: 'OBSERVED' })
      expect(modelCalls).toBe(turn === 4 ? 1 : 0)
    }

    expect(ownershipCalls).toBe(0)
    expect([...domain.sessionBatches.values()][0]).toMatchObject({
      state: 'COMMITTED_NONE', detector: { result: 'NONE', calls: [{ outcome: 'SUCCEEDED' }] },
    })
    expect(domain.global.get().sessions[lifecycleKey()]?.detectedThroughTurnEndSeq).toBe(44)
    await runtime.dispose()
  })

  it('propagates disposal to an active Host model stream', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const started = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<void>()
    const runtime = createDshV2PipelineRuntime(domain, {
      llm: {
        resolveModelInfo: async () => ({ context: { contextWindow: 32_000 }, defaultMaxTokens: 4_096 }),
        stream: async function * (options) {
          started.resolve(options.signal)
          await Promise.race([
            release.promise,
            new Promise<never>((_resolve, reject) => {
              const abort = () => { reject(options.signal.reason) }
              if (options.signal.aborted) abort()
              else options.signal.addEventListener('abort', abort, { once: true })
            }),
          ])
          yield { type: 'block-start' as const, index: 0, blockType: 'text' }
          yield { type: 'block-end' as const, index: 0, block: { type: 'text', text: '{"result":"NONE"}' } }
          yield { type: 'usage' as const, usage: { inputTokens: 10, outputTokens: 4 } }
          yield { type: 'finish' as const, reason: { kind: 'stop' } }
        },
      },
      baseline: {
        capture: async () => ({
          observedAt: new Date(CREATED_AT - 1).toISOString(),
          rootManifestDigest: '1'.repeat(64), runtimeCatalogDigest: '2'.repeat(64), complete: true,
        }),
      },
      activity: { observe: async () => ({ complete: false }) },
      ownership: { observe: async () => ({ status: 'UNAVAILABLE', reasonCode: 'OBSERVATION_FAILED' }) },
      catalog: {
        recall: {
          snapshot: async () => { throw new Error('failed detection must not recall') },
          read: async () => undefined,
        },
        generation: {
          snapshot: async () => { throw new Error('failed detection must not generate') },
          read: async () => undefined,
        },
      },
    })
    await runtime.start()
    await runtime.prepareSessionWindow(lifecycleKey())
    const events: DshSessionEvent[] = []
    for (let turn = 0; turn < 4; turn += 1) {
      events.push(...turnEvents(turn))
      await runtime.observeTurn(header, events, turn * 10 + 4, {
        resolve: async () => ({ status: 'BOUND', workspaceId: 'workspace-1', canonicalPath: CWD }),
      })
    }
    events.push(...turnEvents(4))
    const observing = runtime.observeTurn(header, events, 44, {
      resolve: async () => ({ status: 'BOUND', workspaceId: 'workspace-1', canonicalPath: CWD }),
    })
    const signal = await started.promise

    try {
      const disposing = runtime.dispose()
      expect(signal.aborted).toBe(true)
      await expect(observing).resolves.toMatchObject({ status: 'OBSERVED' })
      await disposing
    } finally {
      release.resolve()
    }
  })

  it('recovers durable stages before accepting a new observation and never calls a model during recovery', async () => {
    const domain = createMemoryRun2skillV2Domain()
    let modelCalls = 0
    const runtime = createDshV2PipelineRuntime(domain, {
      llm: {
        resolveModelInfo: async () => ({ context: { contextWindow: 32_000 } }),
        stream: async function * () { modelCalls += 1; yield* [] },
      },
      baseline: {
        capture: async () => ({
          observedAt: new Date(CREATED_AT - 1).toISOString(),
          rootManifestDigest: '1'.repeat(64), runtimeCatalogDigest: '2'.repeat(64), complete: true,
        }),
      },
      activity: { observe: async () => ({ complete: false }) },
      ownership: { observe: async () => ({ status: 'UNAVAILABLE', reasonCode: 'OBSERVATION_FAILED' }) },
      catalog: {
        recall: {
          snapshot: async () => { throw new Error('unused') },
          read: async () => undefined,
        },
        generation: {
          snapshot: async () => { throw new Error('unused') },
          read: async () => undefined,
        },
      },
    })

    await runtime.start()
    await runtime.start()
    expect(modelCalls).toBe(0)
    await runtime.dispose()
  })

  it('automatically wakes a READY checkpoint after 30 minutes without requiring a new Turn', async () => {
    const domain = createMemoryRun2skillV2Domain()
    let now = CREATED_AT + 44
    let timerCallback: (() => void) | undefined
    let timerDelay: number | undefined
    let ownershipCalls = 0
    const runtime = createDshV2PipelineRuntime(domain, {
      now: () => now,
      internalTimer: {
        set: (callback, delay) => {
          timerCallback = callback
          timerDelay = delay
          return callback
        },
        clear: () => {
          timerCallback = undefined
          timerDelay = undefined
        },
      },
      llm: {
        resolveModelInfo: async () => ({ context: { contextWindow: 32_000 }, defaultMaxTokens: 4_096 }),
        stream: async function * () {
          const evidenceDigest = [...domain.turnObservations.values()].at(-1)!.evidenceDigest
          const output = JSON.stringify({
            result: 'READY',
            intents: [{
              persistenceScope: 'PROJECT', experienceType: 'WORKFLOW',
              applicabilitySummary: '完成一个可复用的五步流程',
              keySteps: ['依次完成五个步骤'], prohibitions: [], evidenceDigests: [evidenceDigest],
              completeness: { status: 'COMPLETE', blockers: [] },
            }],
          })
          yield { type: 'block-start' as const, index: 0, blockType: 'text' }
          yield { type: 'block-end' as const, index: 0, block: { type: 'text', text: output } }
          yield { type: 'usage' as const, usage: { inputTokens: 20, outputTokens: 10 } }
          yield { type: 'finish' as const, reason: { kind: 'stop' } }
        },
      },
      baseline: {
        capture: async () => ({
          observedAt: new Date(CREATED_AT - 1).toISOString(),
          rootManifestDigest: '1'.repeat(64), runtimeCatalogDigest: '2'.repeat(64), complete: true,
        }),
      },
      activity: { observe: async () => ({
        complete: true, activeAgent: false, durableLatestTurnEndSeq: 44,
        durableOpenTurn: false, activityRevision: 'stable-activity',
      }) },
      ownership: {
        observe: async () => {
          ownershipCalls += 1
          return { status: 'UNAVAILABLE', reasonCode: 'OBSERVATION_FAILED' }
        },
      },
      catalog: {
        recall: {
          snapshot: async () => { throw new Error('ownership must fail closed first') },
          read: async () => undefined,
        },
        generation: {
          snapshot: async () => { throw new Error('ownership must fail closed first') },
          read: async () => undefined,
        },
      },
    })
    await runtime.start()
    await runtime.prepareSessionWindow(lifecycleKey())
    const events: DshSessionEvent[] = []
    for (let turn = 0; turn < 5; turn += 1) {
      events.push(...turnEvents(turn))
      await runtime.observeTurn(header, events, turn * 10 + 4, {
        resolve: async () => ({ status: 'BOUND', workspaceId: 'workspace-1', canonicalPath: CWD }),
      })
    }

    expect([...domain.experienceIntents.values()][0]?.status).toBe('WAITING_FOR_QUIESCENCE')
    expect(timerDelay).toBe(IDLE_MS)
    now += IDLE_MS
    timerCallback?.()
    await vi.waitFor(() => expect(ownershipCalls).toBe(1))
    await runtime.settle()
    expect([...domain.experienceIntents.values()][0]).toMatchObject({
      status: 'NEEDS_CONFIRMATION', ownership: { reasonCode: 'OBSERVATION_FAILED' },
    })
    await runtime.dispose()
  })
})
