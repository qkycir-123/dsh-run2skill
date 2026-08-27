import { describe, expect, it, vi } from 'vitest'
import { createDshV2PipelineRuntime } from '../src/host/v2-pipeline.js'
import { projectDshTurnObservationV2 } from '../src/adapters/dsh-session/v2-turn-observation.js'
import { V2LearningAttentionService } from '../src/adapters/dsh-connection/v2-learning-attention-rpc.js'
import { projectV2LearningStatus } from '../src/adapters/dsh-connection/v2-learning-status-rpc.js'
import { SessionBatchCoordinator } from '../src/application/batch/index.js'
import { SessionQuiescenceCoordinator } from '../src/application/quiescence/index.js'
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

async function seedActiveBatchWithLaterManualRequest(
  domain: ReturnType<typeof createMemoryRun2skillV2Domain>,
): Promise<void> {
  const coordinator = new SessionBatchCoordinator(domain, {
    captureBaseline: async () => ({
      observedAt: new Date(CREATED_AT - 1).toISOString(),
      rootManifestDigest: '1'.repeat(64), runtimeCatalogDigest: '2'.repeat(64), complete: true,
    }),
    captureRouteSnapshot: async () => ({
      provider: 'deepseek-official', model: 'deepseek-chat', policyVersion: 'batch-detector-v1',
      maxInputBytes: 128 * 1024, maxOutputBytes: 8 * 1024,
    }),
  })
  const workspace = {
    resolve: async () => ({ status: 'BOUND' as const, workspaceId: 'workspace-1', canonicalPath: CWD }),
  }
  const events = turnEvents(0)
  const first = await projectDshTurnObservationV2(header, events, 4, workspace)
  if (first.status !== 'OBSERVED') throw new Error('failed to seed first observation')
  await coordinator.recordObservation(first.observation)
  await coordinator.requestSynthesis(lifecycleKey())
  await coordinator.flushRequested(async () => true)

  events.push(...turnEvents(1))
  const second = await projectDshTurnObservationV2(header, events, 14, workspace)
  if (second.status !== 'OBSERVED') throw new Error('failed to seed second observation')
  await coordinator.recordObservation(second.observation)
  await coordinator.requestSynthesis(lifecycleKey())
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
          await release.promise
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
      let settled = false
      const closed = Promise.all([observing, disposing]).then(() => { settled = true })
      expect(signal.aborted).toBe(true)
      await vi.waitFor(() => { expect(settled).toBe(true) })
      await closed
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

  it.each([
    { oldResult: 'NONE', laterResult: 'NONE' },
    { oldResult: 'READY', laterResult: 'NONE' },
    { oldResult: 'READY', laterResult: 'READY' },
  ] as const)(
    'closes recovered $oldResult learning safely when the later explicit batch commits $laterResult',
    async ({ oldResult, laterResult }) => {
      const domain = createMemoryRun2skillV2Domain()
      await seedActiveBatchWithLaterManualRequest(domain)
      let detectorCalls = 0
      const activity = { observe: async () => ({
        complete: true, activeAgent: false, durableLatestTurnEndSeq: 14,
        durableOpenTurn: false, activityRevision: 'stable-14',
      }) }
      const runtime = createDshV2PipelineRuntime(domain, {
        llm: {
          resolveModelInfo: async () => ({ context: { contextWindow: 32_000 }, defaultMaxTokens: 4_096 }),
          stream: async function * () {
            detectorCalls += 1
            const result = detectorCalls === 1 ? oldResult : laterResult
            let output = JSON.stringify({ result })
            if (result === 'READY') {
              const claimed = [...domain.sessionBatches.values()]
                .find(batch => batch.state === 'DETECTION_CLAIMED')!
              const observationId = claimed.observationManifest.at(-1)!.observationId
              const evidenceDigest = domain.turnObservations.get(observationId)!.evidenceDigest
              output = JSON.stringify({
                result: 'READY',
                intents: [{
                  persistenceScope: 'PROJECT', experienceType: 'WORKFLOW',
                  applicabilitySummary: `记录第 ${detectorCalls} 个批次中的可复用流程`,
                  keySteps: ['保留经过验证的步骤'], prohibitions: [], evidenceDigests: [evidenceDigest],
                  completeness: { status: 'COMPLETE', blockers: [] },
                }],
              })
            }
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
        activity,
        ownership: { observe: async () => ({ status: 'UNAVAILABLE', reasonCode: 'OBSERVATION_FAILED' }) },
        catalog: {
          recall: {
            snapshot: async () => { throw new Error('old intent must remain behind the newer Session tail') },
            read: async () => undefined,
          },
          generation: {
            snapshot: async () => { throw new Error('old intent must remain behind the newer Session tail') },
            read: async () => undefined,
          },
        },
      })

      await runtime.start()

      expect(detectorCalls).toBe(2)
      const batches = [...domain.sessionBatches.values()]
        .sort((left, right) => left.lastTurnEndSeq - right.lastTurnEndSeq)
      expect(batches).toHaveLength(2)
      expect(batches[0]).toMatchObject({ state: `COMMITTED_${oldResult}`, lastTurnEndSeq: 4 })
      expect(batches[1]).toMatchObject({
        state: `COMMITTED_${laterResult}`,
        firstTurnEndSeq: 14,
        lastTurnEndSeq: 14,
        triggerReasons: ['EXPLICIT'],
      })
      expect(domain.global.get().sessions[lifecycleKey()]).toMatchObject({
        detectedThroughTurnEndSeq: 14,
      })
      expect(domain.global.get().sessions[lifecycleKey()]?.manualSynthesisRequest).toBeUndefined()
      const intents = [...domain.experienceIntents.values()]
      const quiescence = new SessionQuiescenceCoordinator(domain, { activity })
      expect(quiescence.nextEligibleAt()).toBeUndefined()
      const attention = new V2LearningAttentionService(
        domain,
        async workspaceId => ({ workspaceId, canonicalPath: CWD }),
      )
      const actions = await attention.project({ kind: 'WORKSPACE', generation: 1, workspaceId: 'workspace-1' })
      if (oldResult === 'NONE') {
        expect(intents).toHaveLength(0)
        expect(actions).toHaveLength(0)
        expect(projectV2LearningStatus(domain, lifecycleKey())).toMatchObject({ state: 'EMPTY' })
      } else {
        const oldIntent = intents.find(intent => intent.batchId === batches[0]!.batchId)
        expect(oldIntent).toMatchObject({
          status: 'NEEDS_ATTENTION',
          evidenceRefs: [{ turnEndSeq: 4 }],
          quiescence: {
            state: 'SATISFIED',
            batchLastTurnEndSeq: 4,
            observedThroughTurnEndSeq: 14,
            detectedThroughTurnEndSeq: 14,
          },
          coverage: { state: 'NEEDS_ATTENTION', reasonCode: 'SESSION_TAIL_ADVANCED' },
        })
        expect(actions.find(action => action.reasonCode === 'SESSION_TAIL_ADVANCED')).toMatchObject({
          kind: 'DISMISS_LEARNING',
          availableActions: ['DISMISS'],
        })
        expect(projectV2LearningStatus(domain, lifecycleKey())).toMatchObject({ state: 'NEEDS_ATTENTION' })
        if (laterResult === 'READY') {
          expect(intents.find(intent => intent.batchId === batches[1]!.batchId)).toMatchObject({
            status: 'NEEDS_CONFIRMATION',
            evidenceRefs: [{ turnEndSeq: 14 }],
          })
        } else {
          expect(intents).toHaveLength(1)
        }
      }
      await runtime.dispose()
    },
  )

  it('keeps the later manual request queued when post-stage quiescence still denies it', async () => {
    const domain = createMemoryRun2skillV2Domain()
    await seedActiveBatchWithLaterManualRequest(domain)
    let detectorCalls = 0
    const runtime = createDshV2PipelineRuntime(domain, {
      llm: {
        resolveModelInfo: async () => ({ context: { contextWindow: 32_000 }, defaultMaxTokens: 4_096 }),
        stream: async function * () {
          detectorCalls += 1
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
      activity: { observe: async () => ({
        complete: true, activeAgent: true, durableLatestTurnEndSeq: 14,
        durableOpenTurn: false, activityRevision: 'still-active',
      }) },
      ownership: { observe: async () => ({ status: 'UNAVAILABLE', reasonCode: 'OBSERVATION_FAILED' }) },
      catalog: {
        recall: { snapshot: async () => { throw new Error('unused') }, read: async () => undefined },
        generation: { snapshot: async () => { throw new Error('unused') }, read: async () => undefined },
      },
    })

    await runtime.start()

    expect(detectorCalls).toBe(1)
    expect(domain.sessionBatches.size).toBe(1)
    expect(domain.global.get().sessions[lifecycleKey()]?.manualSynthesisRequest).toMatchObject({
      throughTurnEndSeq: 14,
    })
    await runtime.dispose()
  })

  it('extends a waiting manual request to the final observed tail before real quiescence releases it', async () => {
    const domain = createMemoryRun2skillV2Domain()
    let modelCalls = 0
    let ownershipCalls = 0
    let activeAgent = true
    let durableLatestTurnEndSeq = 34
    const runtime = createDshV2PipelineRuntime(domain, {
      llm: {
        resolveModelInfo: async () => ({ context: { contextWindow: 32_000 }, defaultMaxTokens: 4_096 }),
        stream: async function * () {
          modelCalls += 1
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
        complete: true, activeAgent, durableLatestTurnEndSeq,
        durableOpenTurn: false, activityRevision: `activity-${durableLatestTurnEndSeq}`,
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
    for (let turn = 0; turn < 4; turn += 1) {
      events.push(...turnEvents(turn))
      await runtime.observeTurn(header, events, turn * 10 + 4, {
        resolve: async () => ({ status: 'BOUND', workspaceId: 'workspace-1', canonicalPath: CWD }),
      })
    }
    await expect(runtime.requestSynthesis(lifecycleKey())).resolves.toMatchObject({ disposition: 'QUEUED' })
    runtime.wake()
    await runtime.settle()
    expect(modelCalls).toBe(0)

    activeAgent = false
    durableLatestTurnEndSeq = 44
    events.push(...turnEvents(4))
    await runtime.observeTurn(header, events, 44, {
      resolve: async () => ({ status: 'BOUND', workspaceId: 'workspace-1', canonicalPath: CWD }),
    })

    expect(modelCalls).toBe(1)
    expect([...domain.sessionBatches.values()]).toHaveLength(1)
    expect([...domain.sessionBatches.values()][0]).toMatchObject({
      lastTurnEndSeq: 44,
      triggerReasons: ['EXPLICIT', 'THRESHOLD'],
      state: 'COMMITTED_READY',
    })
    expect(ownershipCalls).toBe(1)
    expect([...domain.experienceIntents.values()][0]).toMatchObject({
      status: 'NEEDS_CONFIRMATION',
      quiescence: {
        state: 'SATISFIED',
        batchLastTurnEndSeq: 44,
        observedThroughTurnEndSeq: 44,
        detectedThroughTurnEndSeq: 44,
      },
    })
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
