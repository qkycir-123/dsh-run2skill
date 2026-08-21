import { describe, expect, it } from 'vitest'
import { LearningWorkItemStore } from '../src/adapters/dsh-storage/learning-work-item-store.js'
import { DurableCaptureStore } from '../src/adapters/dsh-storage/durable-capture-store.js'
import { makeLearningResult } from './support/learning-fixture.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeWorkItem } from './support/work-item-fixture.js'
import {
  hasManualLearningAuthorization,
} from '../src/domain/learn/index.js'

const MODEL_ROUTE = { provider: 'target-provider', model: 'target-model' }

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
    const reserved = await store.reserveRequest(item.workItemId, 2, MODEL_ROUTE)
    expect(reserved.learning).toMatchObject({ requestBudgetUsed: 1, modelRoute: MODEL_ROUTE })
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
    const one = await store.reserveRequest(item.workItemId, claimed.revision, MODEL_ROUTE)
    await expect(store.reserveRequest(item.workItemId, one.revision, {
      provider: 'other-provider', model: 'other-model',
    })).rejects.toMatchObject({ code: 'INVALID_LEARNING_STATE' })
    const two = await store.reserveRequest(item.workItemId, one.revision, MODEL_ROUTE)
    await expect(store.reserveRequest(item.workItemId, two.revision, MODEL_ROUTE)).rejects.toMatchObject({ code: 'LEARNING_REQUEST_BUDGET_EXHAUSTED' })
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
    failedRepair = await store.reserveRequest(failedRepairItem.workItemId, failedRepair.revision, MODEL_ROUTE)
    failedRepair = await store.recordCall(failedRepairItem.workItemId, failedRepair.revision, {
      requestOrdinal: 1, kind: 'PRIMARY', outcome: 'SUCCEEDED',
    })
    failedRepair = await store.reserveRequest(failedRepairItem.workItemId, failedRepair.revision, MODEL_ROUTE)
    await expect(store.complete(
      failedRepairItem.workItemId, failedRepair.revision, makeLearningResult(failedRepairItem),
    )).rejects.toMatchObject({ code: 'INVALID_LEARNING_STATE' })
    failedRepair = await store.recordCall(failedRepairItem.workItemId, failedRepair.revision, {
      requestOrdinal: 2, kind: 'FORMAT_REPAIR', outcome: 'FAILED',
    })
    expect(failedRepair.learning?.modelRoute).toEqual(MODEL_ROUTE)
    await expect(store.complete(
      failedRepairItem.workItemId, failedRepair.revision, makeLearningResult(failedRepairItem),
    )).rejects.toMatchObject({ code: 'INVALID_LEARNING_STATE' })

    let successfulRepair = await store.claim(successfulRepairItem.workItemId, 1)
    successfulRepair = await store.reserveRequest(successfulRepairItem.workItemId, successfulRepair.revision, MODEL_ROUTE)
    successfulRepair = await store.recordCall(successfulRepairItem.workItemId, successfulRepair.revision, {
      requestOrdinal: 1, kind: 'PRIMARY', outcome: 'FAILED',
    })
    successfulRepair = await store.reserveRequest(successfulRepairItem.workItemId, successfulRepair.revision, MODEL_ROUTE)
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

  it('recovers only a durably classified truncation and fails closed for an unclassified reserved call', async () => {
    const domain = createMemoryRun2skillDomain()
    const first = makeWorkItem()
    const second = makeWorkItem({
      signalKey: { ...first.signalKey, turn: 3, turnEndSeq: 20, turnInstanceDigest: 'd'.repeat(64) },
    })
    domain.workItems.set(first.workItemId, first)
    domain.workItems.set(second.workItemId, second)
    const store = new LearningWorkItemStore(domain, () => '2026-08-20T00:00:10.000Z')
    let truncated = await store.claim(first.workItemId, 1)
    truncated = await store.reserveRequest(first.workItemId, truncated.revision, MODEL_ROUTE)
    truncated = await store.recordCall(first.workItemId, truncated.revision, {
      requestOrdinal: 1, kind: 'PRIMARY', outcome: 'ABORTED', outputTokens: 4096,
    }, {
      code: 'MODEL_OUTPUT_LIMIT_EXCEEDED', retryable: true, occurredAt: '2026-08-20T00:00:09.000Z',
    })
    const unclassified = await store.claim(second.workItemId, 1)
    await store.reserveRequest(second.workItemId, unclassified.revision, MODEL_ROUTE)

    const recovered = await store.recoverInterrupted()
    expect(recovered).toHaveLength(2)
    expect(domain.workItems.get(first.workItemId)).toMatchObject({
      processingState: 'CAPTURED',
      learning: {
        requestBudgetUsed: 1,
        calls: [{ kind: 'PRIMARY', outcome: 'ABORTED' }],
        failure: { code: 'MODEL_OUTPUT_LIMIT_EXCEEDED' },
      },
    })
    expect(domain.workItems.get(second.workItemId)).toMatchObject({
      processingState: 'NEEDS_ATTENTION',
      learning: { failure: { code: 'MODEL_ABORTED', retryable: false } },
    })
  })

  it('carries one manual authorization across PRIMARY truncation, crash recovery, and the recovery claim', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeWorkItem({
      processingState: 'NEEDS_ATTENTION',
      learning: {
        policyVersion: 'learning-v1', attempt: 1, requestBudgetUsed: 1,
        calls: [{ requestOrdinal: 1, kind: 'PRIMARY', outcome: 'FAILED' }],
        failure: { code: 'MODEL_ABORTED', retryable: true, occurredAt: '2026-08-20T00:00:00.000Z' },
        publicationOutcome: 'NEEDS_ATTENTION',
      },
    })
    domain.workItems.set(item.workItemId, item)
    const store = new LearningWorkItemStore(domain, () => '2026-08-20T00:00:10.000Z')
    const authorized = await store.retryFailed(item.workItemId, item.revision)
    let current = await store.claim(item.workItemId, authorized.item.revision)
    current = await store.reserveRequest(item.workItemId, current.revision, MODEL_ROUTE)
    await store.recordCall(item.workItemId, current.revision, {
      requestOrdinal: 1, kind: 'PRIMARY', outcome: 'ABORTED', outputTokens: 4096,
    }, {
      code: 'MODEL_OUTPUT_LIMIT_EXCEEDED', retryable: true, occurredAt: '2026-08-20T00:00:09.000Z',
    })

    await store.recoverInterrupted()
    const recovered = domain.workItems.get(item.workItemId)!
    expect(recovered).toMatchObject({
      processingState: 'CAPTURED',
      learning: {
        attempt: 3, requestBudgetUsed: 1,
        nextEligibleAt: '1970-01-01T00:00:00.001Z',
      },
    })
    expect(hasManualLearningAuthorization(recovered)).toBe(true)
    const recoveryClaim = await store.claim(item.workItemId, recovered.revision)
    expect(recoveryClaim.learning?.attempt).toBe(3)
    const reserved = await store.reserveRequest(item.workItemId, recoveryClaim.revision, MODEL_ROUTE)
    expect(reserved.learning?.requestBudgetUsed).toBe(2)
  })

  it('fails closed after a successful primary response if structure-repair intent was not durable before restart', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeWorkItem()
    domain.workItems.set(item.workItemId, item)
    const store = new LearningWorkItemStore(domain, () => '2026-08-20T00:00:10.000Z')
    let current = await store.claim(item.workItemId, item.revision)
    current = await store.reserveRequest(item.workItemId, current.revision, MODEL_ROUTE)
    await store.recordCall(item.workItemId, current.revision, {
      requestOrdinal: 1, kind: 'PRIMARY', outcome: 'SUCCEEDED', outputTokens: 120,
    })

    await store.recoverInterrupted()

    expect(domain.workItems.get(item.workItemId)).toMatchObject({
      processingState: 'NEEDS_ATTENTION',
      learning: {
        requestBudgetUsed: 1,
        calls: [{ kind: 'PRIMARY', outcome: 'SUCCEEDED' }],
        failure: { code: 'MODEL_ABORTED', retryable: false },
      },
    })
  })

  it('preserves learned facts when Slice A replays the same capture', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeWorkItem()
    domain.workItems.set(item.workItemId, item)
    const learning = new LearningWorkItemStore(domain)
    const capture = new DurableCaptureStore(domain)
    let current = await learning.claim(item.workItemId, 1)
    current = await learning.reserveRequest(item.workItemId, current.revision, MODEL_ROUTE)
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
    const ignoredCandidate = makeWorkItem({
      signalKey: { ...available.signalKey, turn: 4, turnEndSeq: 30, turnInstanceDigest: 'e'.repeat(64) },
      processingState: 'NEEDS_ATTENTION',
      learning: available.learning,
    })
    domain.workItems.set(available.workItemId, available)
    domain.workItems.set(unavailable.workItemId, unavailable)
    domain.workItems.set(ignoredCandidate.workItemId, ignoredCandidate)
    const store = new LearningWorkItemStore(domain)
    const ignored = await store.dismissFailed(ignoredCandidate.workItemId, ignoredCandidate.revision)

    const reopened = await store.resumeAvailableAgentScopes(item => (
      item.workItemId === available.workItemId || item.workItemId === ignored.item.workItemId
    ))

    expect(reopened.map(item => item.workItemId)).toEqual([available.workItemId])
    expect(reopened[0]).toMatchObject({ processingState: 'CAPTURED', revision: 2 })
    expect(reopened[0]?.learning).not.toHaveProperty('failure')
    expect(domain.workItems.get(ignored.item.workItemId)).toEqual(ignored.item)
    expect(domain.workItems.get(unavailable.workItemId)?.processingState).toBe('NEEDS_ATTENTION')
  })

  it('records completed-call usage before resetting a stale analyzing input', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeWorkItem()
    domain.workItems.set(item.workItemId, item)
    const store = new LearningWorkItemStore(domain)
    let current = await store.claim(item.workItemId, item.revision)
    current = await store.reserveRequest(item.workItemId, current.revision, MODEL_ROUTE)
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

  it('moves a stale third attempt to visible terminal attention instead of leaving it eligible', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeWorkItem({
      learning: { policyVersion: 'learning-v1', attempt: 2, requestBudgetUsed: 0, calls: [] },
    })
    domain.workItems.set(item.workItemId, item)
    const store = new LearningWorkItemStore(domain)
    const claimed = await store.claim(item.workItemId, item.revision)
    domain.workItems.set(item.workItemId, { ...claimed, revision: claimed.revision + 1 })

    const reset = await store.resetStale(item.workItemId, 3)

    expect(reset).toMatchObject({
      processingState: 'NEEDS_ATTENTION',
      learning: {
        attempt: 3,
        failure: { code: 'STORE_WRITE_FAILED', retryable: false },
        publicationOutcome: 'NEEDS_ATTENTION',
      },
    })
    expect(store.listEligible(new Date().toISOString())).toEqual([])
  })

  it('opens at most one explicit bounded recovery and makes duplicate requests idempotent', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeWorkItem({
      processingState: 'NEEDS_ATTENTION',
      learning: {
        policyVersion: 'learning-v1', attempt: 1, requestBudgetUsed: 2,
        calls: [
          { requestOrdinal: 1, kind: 'PRIMARY', outcome: 'ABORTED', outputTokens: 4096 },
          { requestOrdinal: 2, kind: 'FORMAT_REPAIR', outcome: 'ABORTED', outputTokens: 4096 },
        ],
        failure: { code: 'MODEL_OUTPUT_LIMIT_EXCEEDED', retryable: true, occurredAt: '2026-08-20T00:00:00.000Z' },
        publicationOutcome: 'NEEDS_ATTENTION',
      },
    })
    domain.workItems.set(item.workItemId, item)
    const store = new LearningWorkItemStore(domain, () => '2026-08-20T00:00:10.000Z')

    const recovered = await store.retryFailed(item.workItemId, item.revision)
    expect(recovered).toMatchObject({
      changed: true,
      item: {
        processingState: 'CAPTURED', revision: item.revision + 1,
        learning: {
          attempt: 2, requestBudgetUsed: 0, calls: [],
          failure: item.learning!.failure,
          nextEligibleAt: '1970-01-01T00:00:00.001Z',
        },
      },
    })
    expect(await store.retryFailed(item.workItemId, item.revision)).toMatchObject({
      changed: false, item: { revision: item.revision + 1 },
    })

    let current = await store.claim(item.workItemId, recovered.item.revision)
    expect(await store.retryFailed(item.workItemId, item.revision)).toMatchObject({
      changed: false, item: { processingState: 'ANALYZING' },
    })
    current = await store.reserveRequest(item.workItemId, current.revision, MODEL_ROUTE)
    current = await store.recordCall(item.workItemId, current.revision, {
      requestOrdinal: 1, kind: 'PRIMARY', outcome: 'FAILED',
    })
    current = await store.fail(item.workItemId, current.revision, {
      code: 'MODEL_ABORTED', retryable: true, occurredAt: '2026-08-20T00:00:11.000Z',
    })
    expect(current.processingState).toBe('NEEDS_ATTENTION')
    await expect(store.retryFailed(item.workItemId, current.revision))
      .rejects.toMatchObject({ code: 'INVALID_LEARNING_STATE' })
  })

  it('keeps the explicit recovery receipt idempotent when its third attempt becomes stale', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeWorkItem({
      processingState: 'NEEDS_ATTENTION',
      learning: {
        policyVersion: 'learning-v1', attempt: 1, requestBudgetUsed: 1,
        calls: [{ requestOrdinal: 1, kind: 'PRIMARY', outcome: 'FAILED' }],
        failure: { code: 'MODEL_ABORTED', retryable: true, occurredAt: '2026-08-20T00:00:00.000Z' },
        publicationOutcome: 'NEEDS_ATTENTION',
      },
    })
    domain.workItems.set(item.workItemId, item)
    const store = new LearningWorkItemStore(domain, () => '2026-08-20T00:00:10.000Z')

    const recovered = await store.retryFailed(item.workItemId, item.revision)
    const claimed = await store.claim(item.workItemId, recovered.item.revision)
    const reset = await store.resetStale(item.workItemId, claimed.learning!.attempt)

    expect(reset).toMatchObject({
      processingState: 'NEEDS_ATTENTION',
      learning: {
        attempt: 3,
        nextEligibleAt: '1970-01-01T00:00:00.001Z',
        failure: { code: 'STORE_WRITE_FAILED', retryable: false },
      },
    })
    expect(await store.retryFailed(item.workItemId, item.revision)).toMatchObject({
      changed: false,
      item: { revision: reset.revision },
    })
  })

  it('dismisses a failed learning item without deleting it and makes duplicate dismissal idempotent', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeWorkItem({
      processingState: 'NEEDS_ATTENTION',
      learning: {
        policyVersion: 'learning-v1', attempt: 1, requestBudgetUsed: 1,
        calls: [{ requestOrdinal: 1, kind: 'PRIMARY', outcome: 'FAILED' }],
        failure: { code: 'MODEL_TERMINAL_FAILURE', retryable: false, occurredAt: '2026-08-20T00:00:00.000Z' },
        publicationOutcome: 'NEEDS_ATTENTION',
      },
    })
    domain.workItems.set(item.workItemId, item)
    const store = new LearningWorkItemStore(domain, () => '2026-08-20T00:00:10.000Z')

    const dismissed = await store.dismissFailed(item.workItemId, item.revision)
    expect(dismissed).toMatchObject({
      changed: true,
      item: {
        processingState: 'NEEDS_ATTENTION',
        learning: { nextEligibleAt: '2026-08-20T00:00:00.000Z' },
      },
    })
    expect(dismissed.item.learning).toMatchObject({ publicationOutcome: 'NEEDS_ATTENTION' })
    expect(await store.dismissFailed(item.workItemId, item.revision)).toMatchObject({ changed: false })
    expect(await store.dismissFailed(item.workItemId, dismissed.item.revision)).toMatchObject({ changed: false })
    await expect(store.retryFailed(item.workItemId, dismissed.item.revision))
      .rejects.toMatchObject({ code: 'INVALID_LEARNING_STATE' })
    expect(store.listEligible('2026-08-20T00:01:00.000Z')).toEqual([])
  })
})
