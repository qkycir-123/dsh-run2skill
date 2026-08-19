import { describe, expect, it } from 'vitest'
import { DurableCaptureStore } from '../src/adapters/dsh-storage/durable-capture-store.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeWorkItem } from './support/work-item-fixture.js'

describe('DurableCaptureStore', () => {
  it('persists duplicate concurrent deliveries once', async () => {
    const domain = createMemoryRun2skillDomain()
    const store = new DurableCaptureStore(domain, () => '2026-08-19T00:00:10.000Z')
    const item = makeWorkItem()

    const results = await Promise.all(Array.from({ length: 20 }, async () => store.persist(item)))

    expect(domain.workItems.size).toBe(1)
    expect(domain.writeLog).toEqual(['work_items'])
    expect(results.every((result) => result.item.revision === 1)).toBe(true)
  })

  it('atomically merges new facts and assigns one durable revision', async () => {
    const domain = createMemoryRun2skillDomain()
    const store = new DurableCaptureStore(domain, () => '2026-08-19T00:00:10.000Z')
    const first = makeWorkItem({
      captureReason: 'SCAN_INCOMPLETE',
      scanStatus: 'INCOMPLETE',
      triggerHits: [],
      evidenceRefs: [],
      captureBlockers: ['TURN_BOUNDARY_INCOMPLETE', 'TEXT_LIMIT_EXCEEDED'],
    })
    const second = makeWorkItem({
      captureReason: 'SCAN_INCOMPLETE',
      scanStatus: 'INCOMPLETE',
      triggerHits: [],
      evidenceRefs: [],
      captureBlockers: ['TEXT_LIMIT_EXCEEDED'],
    })

    await store.persist(first)
    const [left, right] = await Promise.all([store.persist(first), store.persist(second)])

    expect(left.item.revision).toBe(1)
    expect(right.item).toMatchObject({ revision: 2, captureBlockers: ['TEXT_LIMIT_EXCEEDED'] })
    expect(domain.workItems.get(first.workItemId)).toEqual(right.item)
    expect(domain.writeLog).toEqual(['work_items', 'work_items'])
  })

  it('rejects the same ID with different SignalKey facts without overwriting', async () => {
    const domain = createMemoryRun2skillDomain()
    const store = new DurableCaptureStore(domain)
    const existing = makeWorkItem()
    await store.persist(existing)
    const conflicting = makeWorkItem({
      workItemId: existing.workItemId,
      signalKey: { ...existing.signalKey, sessionCreatedAt: 101 },
    })

    await expect(store.persist(conflicting)).rejects.toMatchObject({ code: 'SIGNAL_KEY_CONFLICT' })
    expect(domain.workItems.get(existing.workItemId)).toEqual(existing)
  })

  it('keeps the durable item when a later global checkpoint fails', async () => {
    const domain = createMemoryRun2skillDomain({ failGlobalWrites: 1 })
    const store = new DurableCaptureStore(domain)
    const item = makeWorkItem()

    await store.persist(item)
    await expect(domain.global.set(domain.global.get())).rejects.toThrow('synthetic global failure')
    expect(domain.workItems.get(item.workItemId)).toEqual(item)

    const replay = await store.persist(item)
    expect(replay.changed).toBe(false)
    expect(domain.workItems.size).toBe(1)
  })
})
