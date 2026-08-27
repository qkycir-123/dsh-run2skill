import { describe, expect, it, vi } from 'vitest'
import { SessionBatchCoordinator, SessionBatchScheduler } from '../src/application/batch/index.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'
import { deriveTurnObservationContentDigestV2, deriveTurnObservationIdV2 } from '../src/domain/v2/index.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'

class ManualTimer {
  delay: number | undefined
  callback: (() => void) | undefined

  set = (callback: () => void, delay: number): object => {
    this.callback = callback
    this.delay = delay
    return {}
  }

  clear = (): void => {
    this.callback = undefined
    this.delay = undefined
  }

  fire(): void {
    const callback = this.callback
    this.clear()
    callback?.()
  }
}

function scheduledObservation(seq: number, observedAt: number) {
  const base = createMinimalV2Fixtures().turnObservation
  const turnInstanceDigest = sha256Utf8(`scheduled-${seq}`)
  const value = {
    ...base,
    observationId: deriveTurnObservationIdV2({
      sessionLifecycleKey: base.sessionLifecycleKey,
      turnEndSeq: seq,
      turnInstanceDigest,
    }),
    turn: seq,
    turnEndSeq: seq,
    turnInstanceDigest,
    observedAt: new Date(observedAt).toISOString(),
    assistantOutcomeSummary: `scheduled-${seq}`,
    explicitSaveRequested: false,
  }
  return { ...value, contentDigest: deriveTurnObservationContentDigestV2(value) }
}

function coordinator(domain: ReturnType<typeof createMemoryRun2skillV2Domain>, now: () => number) {
  return new SessionBatchCoordinator(domain, {
    captureBaseline: async () => ({
      observedAt: new Date(now()).toISOString(),
      rootManifestDigest: '1'.repeat(64),
      runtimeCatalogDigest: '2'.repeat(64),
      complete: true,
    }),
    captureRouteSnapshot: async () => ({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      policyVersion: 'batch-detector-v1',
      maxInputBytes: 128 * 1024,
      maxOutputBytes: 8 * 1024,
    }),
    now,
  })
}

async function seedManualSynthesisRequest(
  domain: ReturnType<typeof createMemoryRun2skillV2Domain>,
  now: () => number,
): Promise<string> {
  const firstProcess = coordinator(domain, now)
  const lifecycleKey = createMinimalV2Fixtures().turnObservation.sessionLifecycleKey
  await firstProcess.recordObservation(scheduledObservation(10, now()))
  await expect(firstProcess.requestSynthesis(lifecycleKey)).resolves.toMatchObject({
    changed: true,
    disposition: 'QUEUED',
  })
  expect(domain.global.get().sessions[lifecycleKey]?.manualSynthesisRequest).toBeDefined()
  return lifecycleKey
}

describe('v2 SessionBatch scheduler', () => {
  it('retries coordinator recovery after a failed start instead of reporting a false success', async () => {
    let recoveries = 0
    const coordinator = {
      recover: async () => {
        recoveries += 1
        if (recoveries === 1) throw new Error('synthetic coordinator recovery failure')
      },
      flushRequested: async () => [],
      nextIdleAt: () => undefined,
    } as unknown as SessionBatchCoordinator
    const scheduler = new SessionBatchScheduler({ coordinator })

    await expect(scheduler.start()).rejects.toThrow('synthetic coordinator recovery failure')
    await expect(scheduler.start()).resolves.toBeUndefined()
    expect(recoveries).toBe(2)
    await scheduler.dispose()
  })

  it('arms one durable idle deadline and freezes one authoritative batch', async () => {
    let now = 0
    const timer = new ManualTimer()
    const domain = createMemoryRun2skillV2Domain()
    const coordinator = new SessionBatchCoordinator(domain, {
      captureBaseline: async () => ({
          observedAt: new Date(now).toISOString(),
          rootManifestDigest: '1'.repeat(64),
          runtimeCatalogDigest: '2'.repeat(64),
          complete: true,
      }),
      captureRouteSnapshot: async () => ({
          provider: 'deepseek-official',
          model: 'deepseek-chat',
          policyVersion: 'batch-detector-v1',
          maxInputBytes: 128 * 1024,
          maxOutputBytes: 8 * 1024,
      }),
    })
    const onIdleBatchFrozen = vi.fn()
    const scheduler = new SessionBatchScheduler({
      coordinator,
      now: () => now,
      setTimer: timer.set,
      clearTimer: timer.clear,
      onIdleBatchFrozen,
    })
    await scheduler.start()
    await scheduler.prepareSessionWindow(createMinimalV2Fixtures().turnObservation.sessionLifecycleKey)
    await scheduler.observe(scheduledObservation(10, now))
    expect(timer.delay).toBe(30 * 60_000)
    now = 30 * 60_000
    timer.fire()
    await scheduler.settle()
    expect(domain.sessionBatches.size).toBe(1)
    expect(onIdleBatchFrozen).toHaveBeenCalledOnce()
    scheduler.wake()
    await scheduler.settle()
    expect(domain.sessionBatches.size).toBe(1)
    await scheduler.dispose()
  })

  it('flushes an over-idle durable manual request exactly once after restart when quiescence permits it', async () => {
    let now = 60_000
    const domain = createMemoryRun2skillV2Domain()
    const lifecycleKey = await seedManualSynthesisRequest(domain, () => now)
    now += 30 * 60_000 + 1
    const permitRequestedSynthesis = vi.fn(async () => true)
    const onIdleBatchFrozen = vi.fn()
    const restarted = new SessionBatchScheduler({
      coordinator: coordinator(domain, () => now),
      now: () => now,
      permitRequestedSynthesis,
      onIdleBatchFrozen,
    })

    await restarted.start()

    expect(permitRequestedSynthesis).toHaveBeenCalledWith(lifecycleKey)
    expect([...domain.sessionBatches.values()]).toHaveLength(1)
    expect([...domain.sessionBatches.values()][0]).toMatchObject({ triggerReasons: ['EXPLICIT'] })
    expect(domain.global.get().sessions[lifecycleKey]?.manualSynthesisRequest).toBeUndefined()
    expect(onIdleBatchFrozen).toHaveBeenCalledOnce()
    restarted.wake()
    await restarted.settle()
    expect([...domain.sessionBatches.values()]).toHaveLength(1)
    expect(onIdleBatchFrozen).toHaveBeenCalledOnce()
    expect(permitRequestedSynthesis).toHaveBeenCalledOnce()
    await restarted.dispose()
  })

  it('keeps an over-idle durable manual request pending after restart while quiescence denies it', async () => {
    let now = 60_000
    const timer = new ManualTimer()
    const domain = createMemoryRun2skillV2Domain()
    const lifecycleKey = await seedManualSynthesisRequest(domain, () => now)
    now += 30 * 60_000 + 1
    const permitRequestedSynthesis = vi.fn(async () => false)
    const restarted = new SessionBatchScheduler({
      coordinator: coordinator(domain, () => now),
      now: () => now,
      setTimer: timer.set,
      clearTimer: timer.clear,
      permitRequestedSynthesis,
    })

    await restarted.start()

    expect(permitRequestedSynthesis).toHaveBeenCalledWith(lifecycleKey)
    expect(domain.sessionBatches.size).toBe(0)
    expect(domain.global.get().sessions[lifecycleKey]?.manualSynthesisRequest).toBeDefined()
    expect(timer.callback).toBeUndefined()
    await restarted.dispose()
  })

  it('does not let a threshold observation bypass a denied manual-request permit', async () => {
    let now = 60_000
    let permit = false
    const domain = createMemoryRun2skillV2Domain()
    const firstProcess = coordinator(domain, () => now)
    const lifecycleKey = createMinimalV2Fixtures().turnObservation.sessionLifecycleKey
    for (const seq of [10, 20, 30, 40]) {
      await firstProcess.recordObservation(scheduledObservation(seq, now++))
    }
    await expect(firstProcess.requestSynthesis(lifecycleKey)).resolves.toMatchObject({
      changed: true,
      disposition: 'QUEUED',
    })
    const permitRequestedSynthesis = vi.fn(async () => permit)
    const onIdleBatchFrozen = vi.fn()
    const restarted = new SessionBatchScheduler({
      coordinator: coordinator(domain, () => now),
      now: () => now,
      permitRequestedSynthesis,
      onIdleBatchFrozen,
    })
    await restarted.start()

    await restarted.observe(scheduledObservation(50, now++))

    expect(permitRequestedSynthesis).toHaveBeenCalledTimes(2)
    expect(domain.sessionBatches.size).toBe(0)
    expect(domain.global.get().sessions[lifecycleKey]?.manualSynthesisRequest).toBeDefined()
    permit = true
    restarted.wake()
    await restarted.settle()
    expect([...domain.sessionBatches.values()]).toHaveLength(1)
    expect([...domain.sessionBatches.values()][0]).toMatchObject({
      lastTurnEndSeq: 40,
      triggerReasons: ['EXPLICIT'],
    })
    expect(onIdleBatchFrozen).toHaveBeenCalledOnce()
    await restarted.dispose()
  })
})
