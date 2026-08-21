import { describe, expect, it } from 'vitest'
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

describe('v2 SessionBatch scheduler', () => {
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
    const scheduler = new SessionBatchScheduler({
      coordinator,
      now: () => now,
      setTimer: timer.set,
      clearTimer: timer.clear,
    })
    await scheduler.start()
    await scheduler.prepareSessionWindow(createMinimalV2Fixtures().turnObservation.sessionLifecycleKey)
    await scheduler.observe(scheduledObservation(10, now))
    expect(timer.delay).toBe(30 * 60_000)
    now = 30 * 60_000
    timer.fire()
    await scheduler.settle()
    expect(domain.sessionBatches.size).toBe(1)
    scheduler.wake()
    await scheduler.settle()
    expect(domain.sessionBatches.size).toBe(1)
    await scheduler.dispose()
  })
})
