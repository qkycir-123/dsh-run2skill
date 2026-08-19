import { describe, expect, it } from 'vitest'
import { DurableCaptureStore } from '../src/adapters/dsh-storage/durable-capture-store.js'
import { DurableCaptureCoordinator } from '../src/application/capture/durable-capture-coordinator.js'
import { RuntimeNotices } from '../src/application/capture/runtime-notices.js'
import { WriteBehindCheckpoint } from '../src/application/capture/write-behind-checkpoint.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeWorkItem } from './support/work-item-fixture.js'

const progress = {
  rootSessionId: 'session-1',
  sessionCreatedAt: 100,
  sessionCwdDigest: 'a'.repeat(64),
  triggerPolicyVersion: 'cheap-trigger-v1' as const,
  activationFenceSeq: 10,
  durableNextSeq: 14,
  observedTailSeq: 13,
}

describe('DurableCaptureCoordinator', () => {
  it('durably writes the WorkItem before advancing a due checkpoint', async () => {
    const domain = createMemoryRun2skillDomain()
    const checkpoint = new WriteBehindCheckpoint(domain, { now: () => 0, turnBatch: 1 })
    await checkpoint.activate([{ ...progress, durableNextSeq: 10, observedTailSeq: 10 }])
    const coordinator = new DurableCaptureCoordinator(
      new DurableCaptureStore(domain),
      checkpoint,
      new RuntimeNotices(),
    )

    await coordinator.capture(makeWorkItem(), progress)

    expect(domain.writeLog).toEqual(['global', 'work_items', 'global'])
  })

  it('does not advance a watermark when WorkItem persistence fails', async () => {
    const domain = createMemoryRun2skillDomain({ failWorkItemWrites: 1 })
    const notices = new RuntimeNotices()
    const checkpoint = new WriteBehindCheckpoint(domain, { now: () => 0, turnBatch: 1 })
    await checkpoint.activate([{ ...progress, durableNextSeq: 10, observedTailSeq: 10 }])
    const coordinator = new DurableCaptureCoordinator(
      new DurableCaptureStore(domain), checkpoint, notices,
    )

    await expect(coordinator.capture(makeWorkItem(), progress)).rejects.toThrow('synthetic work item failure')

    expect(domain.writeLog).toEqual(['global'])
    expect(checkpoint.snapshot().sessions).toEqual(domain.global.get().sessions)
    expect(notices.list()).toEqual([expect.objectContaining({
      healthCode: 'WORK_ITEM_WRITE_FAILED', sessionId: 'session-1', turnEndSeq: 13,
    })])
  })

  it('rejects mismatched WorkItem and checkpoint lifecycles before either write', async () => {
    const domain = createMemoryRun2skillDomain()
    const checkpoint = new WriteBehindCheckpoint(domain, { now: () => 0 })
    await checkpoint.activate([{ ...progress, durableNextSeq: 10, observedTailSeq: 10 }])
    const coordinator = new DurableCaptureCoordinator(
      new DurableCaptureStore(domain), checkpoint, new RuntimeNotices(),
    )

    await expect(coordinator.capture(makeWorkItem(), {
      ...progress,
      rootSessionId: 'different-session',
    })).rejects.toMatchObject({ code: 'SIGNAL_KEY_CONFLICT' })

    expect(domain.workItems.size).toBe(0)
    expect(domain.writeLog).toEqual(['global'])
  })

  it('holds the durable watermark behind a failed signal until replay succeeds', async () => {
    let now = 0
    const domain = createMemoryRun2skillDomain({ failWorkItemWrites: 1 })
    const checkpoint = new WriteBehindCheckpoint(domain, { now: () => now, turnBatch: 2 })
    await checkpoint.activate([{ ...progress, durableNextSeq: 10, observedTailSeq: 10 }])
    const coordinator = new DurableCaptureCoordinator(
      new DurableCaptureStore(domain), checkpoint, new RuntimeNotices(),
    )
    const item = makeWorkItem()
    await expect(coordinator.capture(item, progress)).rejects.toThrow()

    await coordinator.observeNoSignal({ ...progress, durableNextSeq: 16, observedTailSeq: 15 })
    await coordinator.observeNoSignal({ ...progress, durableNextSeq: 18, observedTailSeq: 17 })
    expect(Object.values(domain.global.get().sessions)[0]?.durableNextSeq).toBe(10)

    await coordinator.capture(item, progress)
    now = 30_000
    await checkpoint.flushIfDue()
    expect(Object.values(domain.global.get().sessions)[0]?.durableNextSeq).toBe(18)
    expect(domain.workItems.size).toBe(1)
  })

  it('clears an unsaved notice only after replay becomes durable', async () => {
    const domain = createMemoryRun2skillDomain({ failWorkItemWrites: 1 })
    const notices = new RuntimeNotices()
    const checkpoint = new WriteBehindCheckpoint(domain, { now: () => 0 })
    await checkpoint.activate([{ ...progress, durableNextSeq: 10, observedTailSeq: 10 }])
    const coordinator = new DurableCaptureCoordinator(
      new DurableCaptureStore(domain), checkpoint, notices,
    )
    const item = makeWorkItem()
    await expect(coordinator.capture(item, progress)).rejects.toThrow()

    await coordinator.capture(item, progress)

    expect(notices.list()).toEqual([])
    expect(domain.workItems.size).toBe(1)
  })
})
