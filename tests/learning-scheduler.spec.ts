import { describe, expect, it, vi } from 'vitest'
import {
  LearningScheduler,
  type LearningWorkerPort,
} from '../src/application/learn/learning-scheduler.js'
import { RuntimeNotices } from '../src/application/capture/runtime-notices.js'
import { LearningWorkItemStore } from '../src/adapters/dsh-storage/learning-work-item-store.js'
import type { CaptureWorkItemV1 } from '../src/domain/observe/schemas.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeWorkItem } from './support/work-item-fixture.js'

function queuedItem(
  sessionId: string,
  turnEndSeq: number,
  marker: string,
  kind: 'EXPLICIT_SAVE' | 'CONSTRAINT' = 'EXPLICIT_SAVE',
): CaptureWorkItemV1 {
  return makeWorkItem({
    signalKey: {
      ...makeWorkItem().signalKey,
      rootSessionId: sessionId,
      turn: turnEndSeq,
      turnEndSeq,
      turnInstanceDigest: marker.repeat(64),
    },
    triggerHits: [{
      kind,
      messageSeq: turnEndSeq,
      ruleId: kind === 'EXPLICIT_SAVE'
        ? 'ctv1.explicit-save.save-target'
        : 'ctv1.constraint.persistent-operator',
      confidence: 'HIGH',
    }],
    evidenceRefs: [{
      ...makeWorkItem().evidenceRefs[0]!,
      messageSeq: turnEndSeq,
    }],
  })
}

function storePort(candidates: CaptureWorkItemV1[]) {
  const state = { remaining: [...candidates] }
  const port = {
    get remaining() { return state.remaining },
    set remaining(items: CaptureWorkItemV1[]) { state.remaining = items },
    recoverInterrupted: vi.fn(async () => []),
    resumeAvailableAgentScopes: vi.fn(async () => []),
    listEligible: vi.fn(() => [...state.remaining]),
    nextEligibleAt: vi.fn((_now: string): string | undefined => undefined),
  }
  return port
}

function policy(initial = true) {
  let automaticLearning = initial
  return {
    snapshot: () => Object.freeze({ automaticLearning }),
    set: (value: boolean) => { automaticLearning = value },
  }
}

describe('LearningScheduler', () => {
  it('recovers first, then enforces global=2 and one active item per Root Session', async () => {
    const a1 = queuedItem('session-a', 10, '1')
    const a2 = queuedItem('session-a', 20, '2')
    const b1 = queuedItem('session-b', 11, '3')
    const c1 = queuedItem('session-c', 12, '4')
    const store = storePort([a1, b1, c1, a2])
    const calls: string[] = []
    const activeSessions = new Set<string>()
    let maxActive = 0
    const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
    const worker: LearningWorkerPort = {
      canResolveScope: () => true,
      run: async (item) => {
        calls.push(item.workItemId)
        store.remaining = store.remaining.filter(candidate => candidate.workItemId !== item.workItemId)
        expect(activeSessions.has(item.signalKey.rootSessionId)).toBe(false)
        activeSessions.add(item.signalKey.rootSessionId)
        maxActive = Math.max(maxActive, activeSessions.size)
        const gate = Promise.withResolvers<void>()
        gates.set(item.workItemId, gate)
        await gate.promise
        activeSessions.delete(item.signalKey.rootSessionId)
      },
    }
    const scheduler = new LearningScheduler({
      store, worker, policy: policy(), notices: new RuntimeNotices(), now: () => Date.parse('2026-08-20T00:00:00.000Z'),
    })

    await scheduler.start()
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(store.recoverInterrupted).toHaveBeenCalledOnce()
    expect(store.resumeAvailableAgentScopes).toHaveBeenCalledBefore(store.listEligible)
    expect(calls).toEqual([a1.workItemId, b1.workItemId])
    expect(maxActive).toBe(2)

    gates.get(a1.workItemId)?.resolve()
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    expect(calls[2]).toBe(c1.workItemId)
    gates.get(b1.workItemId)?.resolve()
    await vi.waitFor(() => expect(calls).toHaveLength(4))
    expect(calls[3]).toBe(a2.workItemId)

    for (const gate of gates.values()) gate.resolve()
    await scheduler.dispose()
  })

  it('wakes at the earliest durable nextEligibleAt without polling', async () => {
    vi.useFakeTimers()
    try {
      let now = Date.parse('2026-08-20T00:00:00.000Z')
      const item = queuedItem('session-a', 10, '1')
      const store = storePort([])
      store.nextEligibleAt.mockImplementation(() => new Date(now + 1_000).toISOString())
      const run = vi.fn(async (candidate: CaptureWorkItemV1) => {
        store.remaining = store.remaining.filter(entry => entry.workItemId !== candidate.workItemId)
      })
      const scheduler = new LearningScheduler({
        store,
        policy: policy(),
        worker: { canResolveScope: () => true, run },
        notices: new RuntimeNotices(),
        now: () => now,
      })
      await scheduler.start()
      await vi.advanceTimersByTimeAsync(999)
      expect(run).not.toHaveBeenCalled()
      now += 1_000
      store.remaining = [item]
      store.nextEligibleAt.mockReturnValue(undefined)
      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      await scheduler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not invoke a worker for ten thousand empty-queue wakeups', async () => {
    const store = storePort([])
    const run = vi.fn(async () => undefined)
    const scheduler = new LearningScheduler({
      store,
      policy: policy(),
      worker: { canResolveScope: () => true, run },
      notices: new RuntimeNotices(),
    })

    await scheduler.start()
    for (let index = 0; index < 10_000; index += 1) scheduler.wake()
    await vi.waitFor(() => expect(store.listEligible).toHaveBeenCalled())

    expect(run).not.toHaveBeenCalled()
    await scheduler.dispose()
  })

  it('does not relaunch a stale item after its third attempt is exhausted', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeWorkItem({
      learning: { policyVersion: 'learning-v1', attempt: 2, requestBudgetUsed: 0, calls: [] },
    })
    domain.workItems.set(item.workItemId, item)
    const store = new LearningWorkItemStore(domain)
    const claimed = await store.claim(item.workItemId, item.revision)
    domain.workItems.set(item.workItemId, { ...claimed, revision: claimed.revision + 1 })
    await store.resetStale(item.workItemId, 3)
    const run = vi.fn(async () => undefined)
    const scheduler = new LearningScheduler({
      store,
      policy: policy(),
      worker: { canResolveScope: () => true, run },
      notices: new RuntimeNotices(),
    })

    await scheduler.start()
    scheduler.wake()
    await Promise.resolve()

    expect(run).not.toHaveBeenCalled()
    expect(domain.workItems.get(item.workItemId)?.processingState).toBe('NEEDS_ATTENTION')
    await scheduler.dispose()
  })

  it('stops intake, aborts active work, and bounds shutdown at two seconds', async () => {
    vi.useFakeTimers()
    try {
      const item = queuedItem('session-a', 10, '1')
      const store = storePort([item])
      let receivedSignal: AbortSignal | undefined
      const started = Promise.withResolvers<void>()
      const scheduler = new LearningScheduler({
        store,
        policy: policy(),
        worker: {
          canResolveScope: () => true,
          run: async (_item, signal) => {
            receivedSignal = signal
            store.remaining = []
            started.resolve()
            await new Promise(() => {})
          },
        },
        notices: new RuntimeNotices(),
        now: () => Date.parse('2026-08-20T00:00:00.000Z'),
      })
      await scheduler.start()
      await started.promise
      const disposing = scheduler.dispose()
      expect(receivedSignal?.aborted).toBe(true)
      await vi.advanceTimersByTimeAsync(1_999)
      let settled = false
      void disposing.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await disposing
      scheduler.wake()
      expect(store.listEligible).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pauses ordinary queued work OFF, runs explicit work, resumes ON, and freezes each launch snapshot', async () => {
    const ordinary = queuedItem('session-a', 10, '1', 'CONSTRAINT')
    const explicit = queuedItem('session-b', 11, '2')
    const store = storePort([ordinary, explicit])
    const settings = policy(false)
    const launched: Array<{ id: string; automaticLearning: boolean }> = []
    const explicitGate = Promise.withResolvers<void>()
    const ordinaryGate = Promise.withResolvers<void>()
    const scheduler = new LearningScheduler({
      store,
      policy: settings,
      notices: new RuntimeNotices(),
      worker: {
        canResolveScope: () => true,
        run: async (item, _signal, snapshot) => {
          launched.push({ id: item.workItemId, automaticLearning: snapshot.automaticLearning })
          store.remaining = store.remaining.filter(candidate => candidate.workItemId !== item.workItemId)
          await (item.workItemId === explicit.workItemId ? explicitGate.promise : ordinaryGate.promise)
        },
      },
    })

    await scheduler.start()
    await vi.waitFor(() => expect(launched).toEqual([{
      id: explicit.workItemId, automaticLearning: false,
    }]))
    settings.set(true)
    scheduler.wake()
    await vi.waitFor(() => expect(launched).toHaveLength(2))
    expect(launched[1]).toEqual({ id: ordinary.workItemId, automaticLearning: true })
    settings.set(false)
    expect(launched[1]?.automaticLearning).toBe(true)

    explicitGate.resolve()
    ordinaryGate.resolve()
    await scheduler.dispose()
  })

  it('runs one durable manual recovery while automatic learning is OFF', async () => {
    const ordinary = queuedItem('session-manual', 10, '9', 'CONSTRAINT')
    const authorized = makeWorkItem({
      ...ordinary,
      revision: 2,
      processingState: 'CAPTURED',
      learning: {
        policyVersion: 'learning-v1', attempt: 2, requestBudgetUsed: 0, calls: [],
        failure: { code: 'MODEL_TERMINAL_FAILURE', retryable: true, occurredAt: '2026-08-20T00:00:00.000Z' },
        nextEligibleAt: '1970-01-01T00:00:00.001Z',
      },
    })
    const store = storePort([authorized])
    const run = vi.fn(async (_item: CaptureWorkItemV1) => { store.remaining = [] })
    const scheduler = new LearningScheduler({
      store,
      policy: policy(false),
      worker: { canResolveScope: () => true, run },
      notices: new RuntimeNotices(),
    })

    await scheduler.start()
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(run.mock.calls[0]?.[0].workItemId).toBe(authorized.workItemId)
    await scheduler.dispose()
  })
})
