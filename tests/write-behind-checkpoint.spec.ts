import { describe, expect, it } from 'vitest'
import { deriveSessionLifecycleKeyFromFacts } from '../src/domain/observe/identity.js'
import { WriteBehindCheckpoint } from '../src/application/capture/write-behind-checkpoint.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'

const session = {
  rootSessionId: 'session-1',
  sessionCreatedAt: 100,
  sessionCwdDigest: 'a'.repeat(64),
  triggerPolicyVersion: 'cheap-trigger-v1' as const,
  activationFenceSeq: 10,
  durableNextSeq: 10,
  observedTailSeq: 10,
}

describe('WriteBehindCheckpoint', () => {
  it('persists the activation fence before observation starts', async () => {
    const domain = createMemoryRun2skillDomain()
    const checkpoint = new WriteBehindCheckpoint(domain, { now: () => 0 })

    await checkpoint.activate([session])

    const key = deriveSessionLifecycleKeyFromFacts(session)
    expect(domain.global.get().sessions[key]).toEqual(session)
    expect(domain.writeLog).toEqual(['global'])
  })

  it('batches 32 completed Root turns into one checkpoint publish', async () => {
    const domain = createMemoryRun2skillDomain()
    const checkpoint = new WriteBehindCheckpoint(domain, { now: () => 0 })
    await checkpoint.activate([session])

    for (let index = 0; index < 31; index += 1) {
      await checkpoint.observeCompletedRoot({ ...session, durableNextSeq: 12 + index, observedTailSeq: 11 + index })
    }
    expect(domain.writeLog).toEqual(['global'])

    await checkpoint.observeCompletedRoot({ ...session, durableNextSeq: 43, observedTailSeq: 42 })
    expect(domain.writeLog).toEqual(['global', 'global'])
    expect(domain.global.get().checkpoint).toMatchObject({ dirty: false, pendingSessionCount: 0 })
  })

  it('flushes a dirty checkpoint after 30 seconds', async () => {
    let now = 0
    const domain = createMemoryRun2skillDomain()
    const checkpoint = new WriteBehindCheckpoint(domain, { now: () => now })
    await checkpoint.activate([session])
    await checkpoint.observeCompletedRoot({ ...session, durableNextSeq: 12, observedTailSeq: 11 })
    now = 30_000

    expect(await checkpoint.flushIfDue()).toBe(true)
    expect(domain.writeLog).toEqual(['global', 'global'])
  })

  it('ignores duplicate and stale progress without dirtying or regressing the checkpoint', async () => {
    const domain = createMemoryRun2skillDomain()
    const checkpoint = new WriteBehindCheckpoint(domain, { now: () => 0, turnBatch: 1 })
    await checkpoint.activate([session])
    const latest = { ...session, durableNextSeq: 14, observedTailSeq: 13 }
    await checkpoint.observeCompletedRoot(latest)
    const writesAfterLatest = domain.writeLog.length

    await checkpoint.observeCompletedRoot(latest)
    await checkpoint.observeCompletedRoot({ ...session, durableNextSeq: 12, observedTailSeq: 11 })

    expect(domain.writeLog).toHaveLength(writesAfterLatest)
    expect(checkpoint.snapshot().sessions).toEqual(domain.global.get().sessions)
    expect(checkpoint.snapshot().checkpoint.dirty).toBe(false)
  })

  it('merges replayed progress without moving either watermark backward', async () => {
    const domain = createMemoryRun2skillDomain()
    const checkpoint = new WriteBehindCheckpoint(domain, { now: () => 0 })
    await checkpoint.activate([{ ...session, durableNextSeq: 14, observedTailSeq: 13 }])

    await checkpoint.observeCompletedRoot({
      ...session,
      durableNextSeq: 12,
      observedTailSeq: 15,
    })

    expect(Object.values(checkpoint.snapshot().sessions)[0]).toMatchObject({
      durableNextSeq: 14,
      observedTailSeq: 15,
    })
  })

  it('retains dirty state when checkpoint persistence fails', async () => {
    const domain = createMemoryRun2skillDomain({ failGlobalWrites: 1 })
    const checkpoint = new WriteBehindCheckpoint(domain, { now: () => 0 })
    await expect(checkpoint.activate([session])).rejects.toThrow('synthetic global failure')

    expect(checkpoint.snapshot().checkpoint.dirty).toBe(true)
  })

  it('retries a failed batch checkpoint without advancing durable state early', async () => {
    let now = 0
    const domain = createMemoryRun2skillDomain()
    const checkpoint = new WriteBehindCheckpoint(domain, { now: () => now, turnBatch: 1 })
    await checkpoint.activate([session])
    domain.failNextGlobalWrites(1)

    await expect(checkpoint.observeCompletedRoot({
      ...session, durableNextSeq: 12, observedTailSeq: 11,
    })).rejects.toThrow('synthetic global failure')
    expect(Object.values(domain.global.get().sessions)[0]?.durableNextSeq).toBe(10)
    expect(checkpoint.snapshot().checkpoint.dirty).toBe(true)

    now = 30_000
    await expect(checkpoint.flushIfDue()).resolves.toBe(true)
    expect(Object.values(domain.global.get().sessions)[0]?.durableNextSeq).toBe(12)
  })

  it('safely rolls a watermark back to the upstream durable tail and not before the fence', async () => {
    const domain = createMemoryRun2skillDomain()
    const checkpoint = new WriteBehindCheckpoint(domain, { now: () => 0 })
    await checkpoint.activate([{ ...session, durableNextSeq: 20, observedTailSeq: 20 }])
    const key = deriveSessionLifecycleKeyFromFacts(session)

    await checkpoint.rollbackToDurableTail(key, 5)

    expect(domain.global.get().sessions[key]?.durableNextSeq).toBe(10)
    expect(domain.global.get().health).toMatchObject({ lastCode: 'SESSION_LOG_ROLLBACK' })
  })
})
