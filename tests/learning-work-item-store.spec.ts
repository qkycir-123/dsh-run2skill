import { describe, expect, it } from 'vitest'
import { LearningWorkItemStore } from '../src/adapters/dsh-storage/learning-work-item-store.js'
import { DurableCaptureStore } from '../src/adapters/dsh-storage/durable-capture-store.js'
import { makeLearningResult } from './support/learning-fixture.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeWorkItem } from './support/work-item-fixture.js'

describe('LearningWorkItemStore', () => {
  it('claims, reserves at most two requests, records usage, and completes once', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeWorkItem()
    domain.workItems.set(item.workItemId, item)
    const store = new LearningWorkItemStore(domain, () => '2026-08-20T00:00:00.000Z')

    const claimed = await store.claim(item.workItemId, 1)
    expect(claimed).toMatchObject({ revision: 2, processingState: 'ANALYZING', learning: { attempt: 1 } })
    const reserved = await store.reserveRequest(item.workItemId, 2)
    expect(reserved.learning?.requestBudgetUsed).toBe(1)
    const called = await store.recordCall(item.workItemId, 3, {
      requestOrdinal: 1, kind: 'PRIMARY', outcome: 'SUCCEEDED', inputTokens: 10, outputTokens: 5,
    })
    const completed = await store.complete(item.workItemId, called.revision, makeLearningResult(item))
    expect(completed).toMatchObject({ processingState: 'LEARNED', learning: { requestBudgetUsed: 1 } })
    await expect(store.complete(item.workItemId, completed.revision, makeLearningResult(item))).rejects.toMatchObject({ code: 'INVALID_LEARNING_STATE' })
  })

  it('fails closed on revision conflicts and budget exhaustion', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeWorkItem()
    domain.workItems.set(item.workItemId, item)
    const store = new LearningWorkItemStore(domain)
    await expect(store.claim(item.workItemId, 2)).rejects.toMatchObject({ code: 'LEARNING_REVISION_CONFLICT' })
    const claimed = await store.claim(item.workItemId, 1)
    const one = await store.reserveRequest(item.workItemId, claimed.revision)
    const two = await store.reserveRequest(item.workItemId, one.revision)
    await expect(store.reserveRequest(item.workItemId, two.revision)).rejects.toMatchObject({ code: 'LEARNING_REQUEST_BUDGET_EXHAUSTED' })
  })

  it('retries retryable failures and records a visible terminal failure', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeWorkItem()
    domain.workItems.set(item.workItemId, item)
    const store = new LearningWorkItemStore(domain)
    const claimed = await store.claim(item.workItemId, 1)
    const retry = await store.fail(item.workItemId, claimed.revision, {
      code: 'SESSION_LOG_UNAVAILABLE', retryable: true, occurredAt: '2026-08-20T00:00:01.000Z',
    }, '2026-08-20T00:00:05.000Z')
    expect(retry).toMatchObject({ processingState: 'CAPTURED', learning: { nextEligibleAt: '2026-08-20T00:00:05.000Z' } })
    const reclaimed = await store.claim(item.workItemId, retry.revision)
    const terminal = await store.fail(item.workItemId, reclaimed.revision, {
      code: 'LEARNING_GUARD_REJECTED', retryable: false, occurredAt: '2026-08-20T00:00:06.000Z',
    })
    expect(terminal).toMatchObject({
      processingState: 'NEEDS_ATTENTION',
      learning: { publicationOutcome: 'NEEDS_ATTENTION' },
    })
  })

  it('recovers interrupted analysis without losing consumed request budget', async () => {
    const domain = createMemoryRun2skillDomain()
    const first = makeWorkItem()
    const second = makeWorkItem({
      signalKey: { ...first.signalKey, turn: 3, turnEndSeq: 20, turnInstanceDigest: 'd'.repeat(64) },
    })
    domain.workItems.set(first.workItemId, first)
    domain.workItems.set(second.workItemId, second)
    const store = new LearningWorkItemStore(domain, () => '2026-08-20T00:00:10.000Z')
    const claimed = await store.claim(first.workItemId, 1)
    await store.reserveRequest(first.workItemId, claimed.revision)

    const recovered = await store.recoverInterrupted()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ processingState: 'CAPTURED', learning: { requestBudgetUsed: 1 } })
  })

  it('preserves learned facts when Slice A replays the same capture', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeWorkItem()
    domain.workItems.set(item.workItemId, item)
    const learning = new LearningWorkItemStore(domain)
    const capture = new DurableCaptureStore(domain)
    let current = await learning.claim(item.workItemId, 1)
    current = await learning.reserveRequest(item.workItemId, current.revision)
    current = await learning.complete(item.workItemId, current.revision, makeLearningResult(item))

    const replay = await capture.persist(item)
    expect(replay.changed).toBe(false)
    expect(replay.item).toEqual(current)
  })
})
