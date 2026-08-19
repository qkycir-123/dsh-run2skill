import { describe, expect, it, vi } from 'vitest'
import type { TurnIngressCandidate } from '../src/adapters/dsh-session/types.js'
import { DurableCaptureStore } from '../src/adapters/dsh-storage/durable-capture-store.js'
import type { GapScanResult } from '../src/application/capture/bounded-gap-scanner.js'
import {
  BACKEND_HEALTH_PROBE_INTERVAL_MS,
  CAPTURE_QUEUE_LIMIT,
  RecoveryLifecycle,
} from '../src/application/capture/recovery-lifecycle.js'
import { RuntimeNotices } from '../src/application/capture/runtime-notices.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeWorkItem } from './support/work-item-fixture.js'

function candidate(turnEndSeq: number): TurnIngressCandidate {
  return {
    header: { version: 0, id: 'session-a', createdAt: 1_000 },
    turn: turnEndSeq,
    turnStartSeq: turnEndSeq - 1,
    turnEndSeq,
    directUserMessages: [],
  }
}

const completeScan: GapScanResult = {
  status: 'COMPLETE',
  processedSessions: 0,
  processedEvents: 0,
  maxReadFromLatencyMs: 0,
  peakHeapBytes: 0,
}

function runtime(options: {
  ensureActivated?: () => Promise<GapScanResult>
  scanBatch?: () => Promise<GapScanResult>
  processCandidate?: (value: TurnIngressCandidate) => Promise<void>
  close?: () => Promise<void>
} = {}) {
  return {
    scanner: {
      ensureActivated: options.ensureActivated ?? (async () => completeScan),
      scanBatch: options.scanBatch ?? (async () => completeScan),
    },
    processCandidate: options.processCandidate ?? (async () => undefined),
    close: options.close ?? (async () => undefined),
  }
}

function candidateKey(value: TurnIngressCandidate): string {
  return `${value.header.id}:${value.header.createdAt}:${value.turnEndSeq}`
}

describe('RecoveryLifecycle', () => {
  it('buffers live coordinates during startup recovery and drains them with one worker', async () => {
    let releaseScan: (() => void) | undefined
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve })
    const order: number[] = []
    let concurrent = 0
    let maxConcurrent = 0
    const activeRuntime = runtime({
      ensureActivated: async () => {
        await scanGate
        return completeScan
      },
      processCandidate: async (value) => {
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await Promise.resolve()
        order.push(value.turnEndSeq)
        concurrent -= 1
      },
    })
    const lifecycle = new RecoveryLifecycle(
      { open: async () => activeRuntime },
      candidateKey,
      new RuntimeNotices({ now: () => 0 }),
    )

    const starting = lifecycle.start()
    expect(lifecycle.status).toBe('RECOVERING')
    expect(lifecycle.accept(candidate(2))).toBe(true)
    expect(lifecycle.accept(candidate(4))).toBe(true)
    expect(order).toEqual([])

    releaseScan?.()
    await starting

    expect(lifecycle.status).toBe('READY')
    expect(order).toEqual([2, 4])
    expect(maxConcurrent).toBe(1)
  })

  it('converges a startup gap capture and the buffered live duplicate to one WorkItem', async () => {
    let releaseScan: (() => void) | undefined
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve })
    const domain = createMemoryRun2skillDomain()
    const store = new DurableCaptureStore(domain)
    const item = makeWorkItem()
    const activeRuntime = runtime({
      ensureActivated: async () => {
        await scanGate
        await store.persist(item)
        return completeScan
      },
      processCandidate: async () => { await store.persist(item) },
    })
    const lifecycle = new RecoveryLifecycle(
      { open: async () => activeRuntime },
      candidateKey,
      new RuntimeNotices({ now: () => 0 }),
    )

    const starting = lifecycle.start()
    lifecycle.accept(candidate(item.signalKey.turnEndSeq))
    releaseScan?.()
    await starting

    expect(domain.workItems.size).toBe(1)
    expect(domain.writeLog.filter((entry) => entry === 'work_items')).toHaveLength(1)
  })

  it('bounds the queue and triggers catch-up as soon as it falls to the low watermark', async () => {
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let calls = 0
    const scanBatch = vi.fn(async () => completeScan)
    const activeRuntime = runtime({
      scanBatch,
      processCandidate: async () => {
        calls += 1
        if (calls === 1) await firstGate
      },
    })
    const notices = new RuntimeNotices({ now: () => 0 })
    const lifecycle = new RecoveryLifecycle(
      { open: async () => activeRuntime },
      candidateKey,
      notices,
      { maxQueuedCandidates: 2, lowWatermark: 1 },
    )
    await lifecycle.start()
    expect(scanBatch).toHaveBeenCalledTimes(1)

    lifecycle.accept(candidate(2))
    await vi.waitFor(() => expect(calls).toBe(1))
    expect(lifecycle.accept(candidate(4))).toBe(true)
    expect(lifecycle.accept(candidate(6))).toBe(true)
    expect(lifecycle.accept(candidate(8))).toBe(false)
    expect(lifecycle.snapshot()).toMatchObject({ catchupNeeded: true, maxQueueDepth: 2 })

    releaseFirst?.()
    await lifecycle.whenIdle()

    expect(scanBatch).toHaveBeenCalledTimes(2)
    expect(lifecycle.snapshot()).toMatchObject({ catchupNeeded: false, recoveryLag: false })
    expect(notices.list()).toContainEqual(expect.objectContaining({
      healthCode: 'INGRESS_SATURATED', sessionId: 'session-a', turnEndSeq: 8,
    }))
  })

  it('uses the fixed retry schedule, degrades after exhaustion, and probes once after 30 seconds', async () => {
    const sleeps: number[] = []
    const timers: Array<{ delay: number; callback: () => void }> = []
    let opens = 0
    let recoveredFails = false
    const failingRuntime = runtime({
      processCandidate: async () => { throw new Error('synthetic store failure') },
    })
    const recoveredRuntime = runtime({
      processCandidate: async () => {
        if (recoveredFails) throw new Error('synthetic repeated store failure')
      },
    })
    const notices = new RuntimeNotices({ now: () => 0 })
    const lifecycle = new RecoveryLifecycle(
      { open: async () => (++opens === 1 ? failingRuntime : recoveredRuntime) },
      candidateKey,
      notices,
      {
        retrySleep: async (delay) => { sleeps.push(delay) },
        schedule: (callback, delay) => {
          timers.push({ callback, delay })
          return callback
        },
        cancelScheduled: () => undefined,
      },
    )
    await lifecycle.start()

    lifecycle.accept(candidate(2))
    await lifecycle.whenIdle()

    expect(sleeps).toEqual([250, 1_000, 4_000])
    expect(lifecycle.status).toBe('DEGRADED')
    expect(timers).toHaveLength(1)
    expect(timers[0]?.delay).toBe(BACKEND_HEALTH_PROBE_INTERVAL_MS)
    expect(notices.list()).toContainEqual(expect.objectContaining({
      healthCode: 'WORK_ITEM_WRITE_FAILED', count: 4,
    }))

    timers[0]?.callback()
    await vi.waitFor(() => expect(lifecycle.status).toBe('READY'))
    expect(opens).toBe(2)
    expect(timers).toHaveLength(1)

    recoveredFails = true
    lifecycle.accept(candidate(4))
    await lifecycle.whenIdle()
    expect(lifecycle.status).toBe('DEGRADED')
    expect(timers).toHaveLength(2)
    expect(timers[1]?.delay).toBe(BACKEND_HEALTH_PROBE_INTERVAL_MS)
  })

  it('stops new input on dispose, cancels timers, and caps unsubmitted drain wait at two seconds', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const close = vi.fn(async () => undefined)
    const waits: number[] = []
    const lifecycle = new RecoveryLifecycle(
      { open: async () => runtime({ processCandidate: async () => gate, close }) },
      candidateKey,
      new RuntimeNotices({ now: () => 0 }),
      {
        waitFor: async (_pending, timeoutMs) => {
          waits.push(timeoutMs)
          return false
        },
      },
    )
    await lifecycle.start()
    lifecycle.accept(candidate(2))
    await vi.waitFor(() => expect(lifecycle.snapshot().queueDepth).toBe(0))

    await lifecycle.dispose()

    expect(lifecycle.status).toBe('DISPOSED')
    expect(lifecycle.accept(candidate(4))).toBe(false)
    expect(waits).toEqual([2_000])
    expect(close).toHaveBeenCalledTimes(1)
    release?.()
  })

  it('uses the public default queue bound of 1024 candidates', () => {
    expect(CAPTURE_QUEUE_LIMIT).toBe(1_024)
  })
})
