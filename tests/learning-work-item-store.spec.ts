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
    await expect(store.complete(item.workItemId, claimed.revision, makeLearningResult(item)))
      .rejects.toMatchObject({ code: 'INVALID_LEARNING_STATE' })
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

  it('requires the latest reserved request to succeed before completion', async () => {
    const domain = createMemoryRun2skillDomain()
    const failedRepairItem = makeWorkItem()
    const successfulRepairItem = makeWorkItem({
      signalKey: {
        ...failedRepairItem.signalKey,
        turn: 3,
        turnEndSeq: 20,
        turnInstanceDigest: 'd'.repeat(64),
      },
    })
    domain.workItems.set(failedRepairItem.workItemId, failedRepairItem)
    domain.workItems.set(successfulRepairItem.workItemId, successfulRepairItem)
    const store = new LearningWorkItemStore(domain)

    let failedRepair = await store.claim(failedRepairItem.workItemId, 1)
    failedRepair = await store.reserveRequest(failedRepairItem.workItemId, failedRepair.revision)
    failedRepair = await store.recordCall(failedRepairItem.workItemId, failedRepair.revision, {
      requestOrdinal: 1, kind: 'PRIMARY', outcome: 'SUCCEEDED',
    })
    failedRepair = await store.reserveRequest(failedRepairItem.workItemId, failedRepair.revision)
    await expect(store.complete(
      failedRepairItem.workItemId, failedRepair.revision, makeLearningResult(failedRepairItem),
    )).rejects.toMatchObject({ code: 'INVALID_LEARNING_STATE' })
    failedRepair = await store.recordCall(failedRepairItem.workItemId, failedRepair.revision, {
      requestOrdinal: 2, kind: 'FORMAT_REPAIR', outcome: 'FAILED',
    })
    await expect(store.complete(
      failedRepairItem.workItemId, failedRepair.revision, makeLearningResult(failedRepairItem),
    )).rejects.toMatchObject({ code: 'INVALID_LEARNING_STATE' })

    let successfulRepair = await store.claim(successfulRepairItem.workItemId, 1)
    successfulRepair = await store.reserveRequest(successfulRepairItem.workItemId, successfulRepair.revision)
    successfulRepair = await store.recordCall(successfulRepairItem.workItemId, successfulRepair.revision, {
      requestOrdinal: 1, kind: 'PRIMARY', outcome: 'FAILED',
    })
    successfulRepair = await store.reserveRequest(successfulRepairItem.workItemId, successfulRepair.revision)
    successfulRepair = await store.recordCall(successfulRepairItem.workItemId, successfulRepair.revision, {
      requestOrdinal: 2, kind: 'FORMAT_REPAIR', outcome: 'SUCCEEDED',
    })
    await expect(store.complete(
      successfulRepairItem.workItemId,
      successfulRepair.revision,
      makeLearningResult(successfulRepairItem),
    )).resolves.toMatchObject({ processingState: 'LEARNED' })
  })

  it('retries retryable failures and records a visible terminal failure', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeWorkItem()
    domain.workItems.set(item.workItemId, item)
    let now = '2026-08-20T00:00:00.000Z'
    const store = new LearningWorkItemStore(domain, () => now)
    const claimed = await store.claim(item.workItemId, 1)
    const retry = await store.fail(item.workItemId, claimed.revision, {
      code: 'SESSION_LOG_UNAVAILABLE', retryable: true, occurredAt: '2026-08-20T00:00:01.000Z',
    }, '2026-08-20T00:00:05.000Z')
    expect(retry).toMatchObject({ processingState: 'CAPTURED', learning: { nextEligibleAt: '2026-08-20T00:00:05.000Z' } })
    await expect(store.claim(item.workItemId, retry.revision))
      .rejects.toMatchObject({ code: 'INVALID_LEARNING_STATE' })
    now = '2026-08-20T00:00:05.000Z'
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
    current = await learning.recordCall(item.workItemId, current.revision, {
      requestOrdinal: 1, kind: 'PRIMARY', outcome: 'SUCCEEDED',
    })
    current = await learning.complete(item.workItemId, current.revision, makeLearningResult(item))

    const replay = await capture.persist(item)
    expect(replay.changed).toBe(false)
    expect(replay.item).toEqual(current)
  })

  it('lists only due complete trigger work in deterministic order', () => {
    const domain = createMemoryRun2skillDomain()
    const first = makeWorkItem({
      signalKey: { ...makeWorkItem().signalKey, turn: 3, turnEndSeq: 30, turnInstanceDigest: '3'.repeat(64) },
    })
    const second = makeWorkItem({
      signalKey: { ...makeWorkItem().signalKey, turn: 2, turnEndSeq: 20, turnInstanceDigest: '2'.repeat(64) },
      learning: {
        policyVersion: 'learning-v1', attempt: 1, requestBudgetUsed: 0, calls: [],
        nextEligibleAt: '2026-08-20T00:00:10.000Z',
      },
    })
    const future = makeWorkItem({
      signalKey: { ...makeWorkItem().signalKey, turn: 4, turnEndSeq: 40, turnInstanceDigest: '4'.repeat(64) },
      learning: {
        policyVersion: 'learning-v1', attempt: 1, requestBudgetUsed: 0, calls: [],
        nextEligibleAt: '2026-08-20T00:01:00.000Z',
      },
    })
    const incomplete = makeWorkItem({
      signalKey: { ...makeWorkItem().signalKey, turn: 1, turnEndSeq: 10, turnInstanceDigest: '1'.repeat(64) },
      captureReason: 'SCAN_INCOMPLETE', scanStatus: 'INCOMPLETE', processingState: 'CAPTURED',
      triggerHits: [], evidenceRefs: [], captureBlockers: ['TURN_BOUNDARY_INCOMPLETE'],
    })
    for (const item of [first, second, future, incomplete]) domain.workItems.set(item.workItemId, item)
    const store = new LearningWorkItemStore(domain)

    expect(store.listEligible('2026-08-20T00:00:10.000Z').map(item => item.workItemId))
      .toEqual([second.workItemId, first.workItemId])
    expect(store.nextEligibleAt('2026-08-20T00:00:10.000Z')).toBe('2026-08-20T00:01:00.000Z')
  })

  it('reopens only an available exact-agent-scope failure', async () => {
    const domain = createMemoryRun2skillDomain()
    const available = makeWorkItem({
      processingState: 'NEEDS_ATTENTION',
      learning: {
        policyVersion: 'learning-v1', attempt: 1, requestBudgetUsed: 0, calls: [],
        failure: { code: 'AGENT_SCOPE_UNAVAILABLE', retryable: false, occurredAt: '2026-08-20T00:00:00.000Z' },
        publicationOutcome: 'NEEDS_ATTENTION',
      },
    })
    const unavailable = makeWorkItem({
      signalKey: { ...available.signalKey, turn: 3, turnEndSeq: 20, turnInstanceDigest: 'd'.repeat(64) },
      processingState: 'NEEDS_ATTENTION',
      learning: {
        policyVersion: 'learning-v1', attempt: 1, requestBudgetUsed: 0, calls: [],
        failure: { code: 'AGENT_SCOPE_UNAVAILABLE', retryable: false, occurredAt: '2026-08-20T00:00:00.000Z' },
        publicationOutcome: 'NEEDS_ATTENTION',
      },
    })
    domain.workItems.set(available.workItemId, available)
    domain.workItems.set(unavailable.workItemId, unavailable)
    const store = new LearningWorkItemStore(domain)

    const reopened = await store.resumeAvailableAgentScopes(item => item.workItemId === available.workItemId)

    expect(reopened.map(item => item.workItemId)).toEqual([available.workItemId])
    expect(reopened[0]).toMatchObject({ processingState: 'CAPTURED', revision: 2 })
    expect(reopened[0]?.learning).not.toHaveProperty('failure')
    expect(domain.workItems.get(unavailable.workItemId)?.processingState).toBe('NEEDS_ATTENTION')
  })

  it('records completed-call usage before resetting a stale analyzing input', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeWorkItem()
    domain.workItems.set(item.workItemId, item)
    const store = new LearningWorkItemStore(domain)
    let current = await store.claim(item.workItemId, item.revision)
    current = await store.reserveRequest(item.workItemId, current.revision)
    domain.workItems.set(item.workItemId, { ...current, revision: current.revision + 1 })

    const recorded = await store.recordCallLatest(item.workItemId, current.learning!.attempt, {
      requestOrdinal: 1, kind: 'PRIMARY', inputTokens: 5, outputTokens: 3, outcome: 'SUCCEEDED',
    })
    const reset = await store.resetStale(item.workItemId, recorded.learning!.attempt)

    expect(reset).toMatchObject({
      processingState: 'CAPTURED',
      learning: { requestBudgetUsed: 1, calls: [{ requestOrdinal: 1, outcome: 'SUCCEEDED' }] },
    })
    expect(reset.learning).not.toHaveProperty('claimedAt')
  })
})
