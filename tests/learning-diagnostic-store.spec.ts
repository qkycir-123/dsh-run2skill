import { describe, expect, it } from 'vitest'
import {
  LearningDiagnosticStore,
  LearningDiagnosticStoreError,
  createLearningDiagnosticKey,
} from '../src/adapters/dsh-storage/learning-diagnostic-store.js'
import { LearningDiagnosticRecordV1Schema } from '../src/domain/learn/index.js'
import { createMemoryLearningDiagnosticDomain } from './support/memory-learning-diagnostic-domain.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeWorkItem } from './support/work-item-fixture.js'

const OCCURRED_AT = '2026-08-20T00:00:01.000Z'

function terminalItem() {
  const base = makeWorkItem()
  return {
    ...base,
    revision: 5,
    processingState: 'NEEDS_ATTENTION' as const,
    learning: {
      policyVersion: 'learning-v1' as const,
      attempt: 1,
      requestBudgetUsed: 1,
      modelRoute: { provider: 'provider', model: 'model' },
      calls: [{ requestOrdinal: 1 as const, kind: 'PRIMARY' as const, outcome: 'FAILED' as const }],
      failure: { code: 'MODEL_TERMINAL_FAILURE' as const, retryable: true, occurredAt: OCCURRED_AT },
      publicationOutcome: 'NEEDS_ATTENTION' as const,
    },
  }
}

describe('LearningDiagnosticStore', () => {
  it('attaches exact terminal detail idempotently and rejects conflicting content', async () => {
    const main = createMemoryRun2skillDomain()
    const sidecar = createMemoryLearningDiagnosticDomain()
    const item = terminalItem()
    main.workItems.set(item.workItemId, item)
    const store = new LearningDiagnosticStore(main, sidecar)

    await expect(store.attach(item, 1, 'MODEL_USAGE_INVALID')).resolves.toEqual({ changed: true })
    await expect(store.attach(item, 1, 'MODEL_USAGE_INVALID')).resolves.toEqual({ changed: false })
    await expect(store.attach(item, 1, 'MODEL_FINISH_MISSING'))
      .rejects.toBeInstanceOf(LearningDiagnosticStoreError)
    expect(store.detailFor(item)).toBe('MODEL_USAGE_INVALID')
  })

  it('attaches after the generic call failure is durable even before interrupted recovery reaches terminal', async () => {
    const main = createMemoryRun2skillDomain()
    const sidecar = createMemoryLearningDiagnosticDomain()
    const terminal = terminalItem()
    const analyzing = { ...terminal, processingState: 'ANALYZING' as const }
    main.workItems.set(analyzing.workItemId, analyzing)
    const store = new LearningDiagnosticStore(main, sidecar)

    await expect(store.attach(analyzing, 1, 'MODEL_ASSEMBLY_FAILED')).resolves.toEqual({ changed: true })
    expect(store.detailFor(analyzing)).toBeUndefined()
    main.workItems.set(terminal.workItemId, { ...terminal, revision: 6 })
    expect(store.detailFor({ ...terminal, revision: 6 })).toBe('MODEL_ASSEMBLY_FAILED')
  })

  it('fails closed when main facts changed and never joins stale detail after retry or ignore', async () => {
    const main = createMemoryRun2skillDomain()
    const sidecar = createMemoryLearningDiagnosticDomain()
    const item = terminalItem()
    main.workItems.set(item.workItemId, item)
    const store = new LearningDiagnosticStore(main, sidecar)
    await store.attach(item, 1, 'MODEL_USAGE_INVALID')

    const retry = { ...item, revision: 6, processingState: 'CAPTURED' as const }
    main.workItems.set(item.workItemId, retry)
    expect(store.detailFor(retry)).toBeUndefined()

    const ignored = {
      ...item,
      revision: 6,
      learning: { ...item.learning, nextEligibleAt: item.learning.failure.occurredAt },
    }
    main.workItems.set(item.workItemId, ignored)
    expect(store.detailFor(ignored)).toBeUndefined()
    await expect(store.attach(item, 1, 'MODEL_USAGE_INVALID'))
      .rejects.toMatchObject({ code: 'DIAGNOSTIC_MAIN_FACT_CONFLICT' })
  })

  it('accepts later main revisions only while exact call and failure facts still match', async () => {
    const main = createMemoryRun2skillDomain()
    const sidecar = createMemoryLearningDiagnosticDomain()
    const item = terminalItem()
    main.workItems.set(item.workItemId, item)
    const store = new LearningDiagnosticStore(main, sidecar)
    await store.attach(item, 1, 'MODEL_UNEXPECTED_FINISH')

    const later = { ...item, revision: 6, updatedAt: '2026-08-20T00:00:02.000Z' }
    main.workItems.set(item.workItemId, later)
    expect(store.detailFor(later)).toBe('MODEL_UNEXPECTED_FINISH')
    const changedFailure = {
      ...later,
      learning: { ...later.learning, failure: { ...later.learning.failure, occurredAt: '2026-08-20T00:00:03.000Z' } },
    }
    expect(store.detailFor(changedFailure)).toBeUndefined()
  })

  it('keeps the sidecar strict and stores no text, path, route, or raw usage', () => {
    const item = terminalItem()
    const record = {
      schemaVersion: 1,
      workItemId: item.workItemId,
      workItemRevision: item.revision,
      attempt: 1,
      requestOrdinal: 1,
      callKind: 'PRIMARY',
      callOutcome: 'FAILED',
      failureCode: 'MODEL_TERMINAL_FAILURE',
      failureOccurredAt: OCCURRED_AT,
      detail: 'MODEL_USAGE_INVALID',
    }
    expect(LearningDiagnosticRecordV1Schema.parse(record)).toEqual(record)
    expect(() => LearningDiagnosticRecordV1Schema.parse({ ...record, body: 'secret' })).toThrow()
  })

  it('cleans only proven orphans after the fully loaded main domain and resumes partial cleanup', async () => {
    const main = createMemoryRun2skillDomain()
    const sidecar = createMemoryLearningDiagnosticDomain()
    const kept = terminalItem()
    main.workItems.set(kept.workItemId, kept)
    const orphanId = `wi_${'e'.repeat(64)}`
    const store = new LearningDiagnosticStore(main, sidecar)
    await store.attach(kept, 1, 'MODEL_FINISH_MISSING')
    sidecar.records.set(createLearningDiagnosticKey(orphanId, 1, 1), {
      ...sidecar.records.values().next().value!, workItemId: orphanId,
    })
    sidecar.failNextDeletes(1)
    await expect(store.cleanupOrphans()).rejects.toThrow('synthetic diagnostic delete failure')
    expect(sidecar.records.size).toBe(2)
    await expect(store.cleanupOrphans()).resolves.toEqual({ deleted: 1 })
    expect(sidecar.records.size).toBe(1)
    expect(store.detailFor(kept)).toBe('MODEL_FINISH_MISSING')
  })

  it('verifies live sidecar writes, exact readback, and cleanup on every readiness check', async () => {
    const main = createMemoryRun2skillDomain()
    const sidecar = createMemoryLearningDiagnosticDomain()
    const store = new LearningDiagnosticStore(main, sidecar)

    await expect(store.verifyReady()).resolves.toBeUndefined()
    expect(sidecar.healthChecks.size).toBe(0)
    sidecar.setUnavailable(true)
    await expect(store.verifyReady()).rejects.toThrow('synthetic diagnostic backend unavailable')
    expect(sidecar.healthChecks.size).toBe(0)
    sidecar.setUnavailable(false)
    await expect(store.verifyReady()).resolves.toBeUndefined()

    sidecar.failNextHealthDeletes(1)
    await expect(store.verifyReady()).rejects.toThrow('synthetic diagnostic health delete failure')
    expect(sidecar.healthChecks.size).toBe(1)
    await expect(store.verifyReady()).resolves.toBeUndefined()
    expect(sidecar.healthChecks.size).toBe(0)
  })

  it('fails readiness with terminal-table backend loss and can reverify before retrying deletion', async () => {
    const main = createMemoryRun2skillDomain()
    const sidecar = createMemoryLearningDiagnosticDomain()
    const item = terminalItem()
    main.workItems.set(item.workItemId, item)
    const store = new LearningDiagnosticStore(main, sidecar)

    sidecar.setUnavailable(true)
    await expect(store.attach(item, 1, 'MODEL_USAGE_INVALID')).rejects.toThrow()
    await expect(store.verifyReady()).rejects.toThrow('synthetic diagnostic backend unavailable')
    sidecar.setUnavailable(false)
    await expect(store.verifyReady()).resolves.toBeUndefined()

    await store.attach(item, 1, 'MODEL_USAGE_INVALID')
    sidecar.failNextDeletes(1)
    await expect(store.deleteWorkItem(item.workItemId)).rejects.toThrow('synthetic diagnostic delete failure')
    expect(sidecar.records.size).toBe(1)
    await expect(store.verifyReady()).resolves.toBeUndefined()
    await expect(store.deleteWorkItem(item.workItemId)).resolves.toBeUndefined()
    expect(sidecar.records.size).toBe(0)
  })
})
