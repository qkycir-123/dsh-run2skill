import { describe, expect, it, vi } from 'vitest'
import { CompleteCatalogRecallWorker, CatalogRecallTemporaryError, deriveRecallCandidateId, type CatalogRecallClassifier } from '../src/application/recall/index.js'
import { CompleteCoverageWorker } from '../src/application/coverage-analysis/index.js'
import { V2LearningAttentionService } from '../src/adapters/dsh-connection/v2-learning-attention-rpc.js'
import { ExperienceIntentV2Schema, SessionBatchV2Schema, deriveTurnObservationContentDigestV2 } from '../src/domain/v2/index.js'
import { deriveProjectScopeIdentityDigest } from '../src/domain/purge/index.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

const scope = { kind: 'WORKSPACE' as const, generation: 1, workspaceId: 'workspace-v2' }
const now = '2026-10-01T03:00:00.000Z'

async function retryFixture() {
  const domain = createMemoryRun2skillV2Domain()
  const fixture = createMinimalV2Fixtures()
  const scopeBinding = { status: 'PROJECT' as const, workspaceId: scope.workspaceId, scopeIdentityDigest: deriveProjectScopeIdentityDigest('D:/workspace') }
  const observation = { ...fixture.turnObservation, scopeBinding, contentDigest: deriveTurnObservationContentDigestV2({ ...fixture.turnObservation, scopeBinding }) }
  await domain.table('turn_observations').put(observation.observationId, observation)
  const owned = ExperienceIntentV2Schema.parse({
    ...fixture.proposalReadyIntent, status: 'RUN2SKILL_OWNED',
    recall: { state: 'NOT_STARTED', complete: false, summaryScanComplete: false, candidates: [] },
    coverage: { state: 'NOT_STARTED', retryUsed: false },
    generation: { state: 'NOT_STARTED', userRetryUsed: false, staleRefreshUsed: false, receipts: [] },
    stageCalls: [], lineageId: undefined,
  })
  const batch = SessionBatchV2Schema.parse({ ...fixture.sessionBatch, routeSnapshot: { ...fixture.sessionBatch.routeSnapshot, maxInputBytes: 4096 } })
  await domain.table('session_batches').put(batch.batchId, batch)
  await domain.table('experience_intents').put(owned.intentId, owned)
  const summaries = Array.from({ length: 23 }, (_, index) => {
    const facts = { name: `skill-${index}`, description: `Workflow ${index}`, provider: 'filesystem', source: 'project-dsh', scope: 'PROJECT' as const, writable: true, rootIdentityDigest: index.toString(16).padStart(64, '0') }
    return { ...facts, candidateId: deriveRecallCandidateId(facts) }
  })
  let changed = false
  let mode: 'FIRST_FAILURE' | 'SUCCESS' | 'FAILURE' | 'WAIT' = 'FIRST_FAILURE'
  let release!: () => void
  const held = new Promise<void>(done => { release = done })
  const snapshot = vi.fn(async () => ({ complete: true, runtimeCatalogDigest: (changed ? '9' : '1').repeat(64), pendingCatalogDigest: '2'.repeat(64), catalogEpoch: 1, catalogMutationReceiptDigest: '3'.repeat(64), summaries }))
  const catalog = { snapshot, read: vi.fn(async () => undefined) }
  const classify = vi.fn(async (input: Parameters<CatalogRecallClassifier['classify']>[0]) => {
    if (mode === 'WAIT') await held
    if (mode === 'FAILURE' || (mode === 'FIRST_FAILURE' && input.pageOrdinal === 2)) throw new CatalogRecallTemporaryError()
    return { classifications: input.summaries.map(item => ({ candidateId: item.candidateId, classification: 'UNRELATED' })) }
  })
  const worker = () => new CompleteCatalogRecallWorker(domain, { catalog, classifier: { classify }, policy: { catalogScanReserveBytes: 1024, coverageReserveBytes: 1024 }, now: () => Date.parse(now) })
  const wake = vi.fn()
  const service = () => new V2LearningAttentionService(domain, async workspaceId => ({ workspaceId, canonicalPath: 'D:/workspace' }), () => now, wake)
  const current = () => ExperienceIntentV2Schema.parse(domain.experienceIntents.get(owned.intentId))
  await worker().runOnce()
  const stopped = current()
  const action = (await service().project(scope))[0]!
  const request = { apiVersion: 1, workItemId: action.subjectId, workItemRevision: stopped.revision, currentScope: scope, action: { actionKey: action.actionKey, subjectId: action.subjectId, kind: action.kind } }
  const retry = (payload = request) => service().handler()('learning/issues/retry', payload, new AbortController().signal)
  return { domain, batch, current, stopped, action, request, retry, service, wake, catalog, classify, worker, release, setMode: (value: typeof mode) => { mode = value }, changeCatalog: () => { changed = true } }
}

describe('one manual Catalog retry', () => {
  it('keeps detection and successful pages, durably authorizes once, and resumes the failed page', async () => {
    const f = await retryFixture()
    expect(f.stopped.recall.incompleteReason).toBe('CATALOG_SCAN_TEMPORARY_FAILED')
    expect(f.action).toMatchObject({ kind: 'RETRY_LEARNING', availableActions: ['RETRY', 'DISMISS'] })
    expect(f.classify).toHaveBeenCalledTimes(2)
    expect(await f.worker().runOnce()).toBe('IDLE')
    const receipts = await Promise.all([f.retry(), f.retry()])
    expect(receipts).toEqual(expect.arrayContaining([expect.objectContaining({ ok: true, value: expect.objectContaining({ changed: true }) }), expect.objectContaining({ ok: true, value: expect.objectContaining({ changed: false }) })]))
    expect(f.wake).toHaveBeenCalledTimes(1)
    expect(f.current().catalogRetry).toBeDefined()
    f.setMode('SUCCESS')
    await f.worker().runOnce()
    const done = f.current()
    expect(done.status).toBe('COVERAGE_READY')
    expect(done.recall.complete).toBe(true)
    expect(done.stageCalls.filter(call => call.failureCode === 'CATALOG_SCAN_TEMPORARY_FAILED')).toHaveLength(1)
    expect(done.stageCalls.filter(call => call.stage === 'CATALOG_SCAN')).toHaveLength(done.recall.scanPageCount! + 1)
    expect(f.classify.mock.calls.filter(([input]) => input.pageOrdinal === 1)).toHaveLength(1)
    expect(f.classify.mock.calls.filter(([input]) => input.pageOrdinal === 2)).toHaveLength(2)
    expect(f.domain.sessionBatches.get(f.batch.batchId)?.detector).toEqual(f.batch.detector)
    await new CompleteCoverageWorker(f.domain, { catalog: f.catalog, classifier: { classify: vi.fn() } }).runOnce()
    expect(f.current().status).toBe('CREATE_AUTHORIZED')
    await f.worker().recover()
    expect(await f.worker().runOnce()).toBe('IDLE')
    expect(ExperienceIntentV2Schema.safeParse(done).success).toBe(true)
    expect(ExperienceIntentV2Schema.safeParse({ ...done, catalogRetry: undefined }).success).toBe(false)
  })

  it('does not offer or call a second retry after another transient failure', async () => {
    const f = await retryFixture()
    await f.retry()
    f.setMode('FAILURE')
    await f.worker().runOnce()
    expect(f.current().status).toBe('NEEDS_ATTENTION')
    expect((await f.service().project(scope))[0]?.availableActions).toEqual(['DISMISS'])
    await expect(f.retry()).resolves.toMatchObject({ ok: true, value: { changed: false } })
    expect(await f.worker().runOnce()).toBe('IDLE')
    expect(f.classify).toHaveBeenCalledTimes(3)
  })

  it('rechecks Catalog facts and stops without a model call when they changed', async () => {
    const f = await retryFixture()
    await f.retry()
    const snapshots = f.catalog.snapshot.mock.calls.length
    f.changeCatalog()
    f.setMode('SUCCESS')
    await f.worker().runOnce()
    expect(f.catalog.snapshot.mock.calls.length).toBeGreaterThan(snapshots)
    expect(f.current().recall.incompleteReason).toBe('CATALOG_CHANGED')
    expect(f.classify).toHaveBeenCalledTimes(2)
  })

  it('rejects another scope and a request whose inputs have been purged', async () => {
    const f = await retryFixture()
    await expect(f.retry({ ...f.request, currentScope: { ...scope, workspaceId: 'other' } })).resolves.toMatchObject({ ok: false })
    expect(f.current().catalogRetry).toBeUndefined()
    await f.domain.table('turn_observations').delete(f.current().evidenceRefs[0]!.observationId)
    await expect(f.retry()).resolves.toMatchObject({ ok: false })
    expect(f.classify).toHaveBeenCalledTimes(2)
  })

  it('recovers a reserved retry as unknown and never replays it', async () => {
    const f = await retryFixture()
    await f.retry()
    f.setMode('WAIT')
    const running = f.worker().runOnce()
    await vi.waitFor(() => { expect(f.classify).toHaveBeenCalledTimes(3) })
    await f.worker().recover()
    expect(f.current().recall.incompleteReason).toBe('CATALOG_SCAN_OUTCOME_UNKNOWN')
    expect(f.current().stageCalls.at(-1)?.outcome).toBe('OUTCOME_UNKNOWN')
    f.release()
    await running
    expect(await f.worker().runOnce()).toBe('IDLE')
    expect((await f.service().project(scope))[0]?.availableActions).toEqual(['DISMISS'])
    expect(f.classify).toHaveBeenCalledTimes(3)
  })

  it('allows two competing workers to reserve the authorized retry only once', async () => {
    const f = await retryFixture()
    await f.retry()
    f.setMode('SUCCESS')
    await Promise.all([f.worker().runOnce(), f.worker().runOnce()])
    expect(f.classify.mock.calls.filter(([input]) => input.pageOrdinal === 2)).toHaveLength(2)
    expect(f.current().status).toBe('COVERAGE_READY')
  })
  it('rejects a retry while purge is active and when its Batch is unavailable', async () => {
    const f = await retryFixture()
    const stable = f.domain.global.get()
    await f.domain.global.set({ ...stable, purgeJournal: {
      schemaVersion: 1, purgeId: `purge_${'a'.repeat(64)}`, scopeBinding: { scope: 'ALL' },
      hideBefore: now, phase: 'PREPARED', updatedAt: now,
    } })
    await expect(f.retry()).resolves.toMatchObject({ ok: false })
    expect(f.current().catalogRetry).toBeUndefined()
    expect((await f.service().project(scope))[0]?.availableActions).toEqual(['DISMISS'])
    await f.domain.global.set(stable)
    await f.domain.table('session_batches').delete(f.batch.batchId)
    expect((await f.service().project(scope))[0]?.availableActions).toEqual(['DISMISS'])
    await expect(f.retry()).resolves.toMatchObject({ ok: false })
    expect(f.classify).toHaveBeenCalledTimes(2)
  })

  it('resumes after authorization persisted across restart and rejects a forged retry ledger', async () => {
    const f = await retryFixture()
    await f.retry()
    f.setMode('SUCCESS')
    await f.worker().recover()
    await f.worker().runOnce()
    const done = f.current()
    const failed = done.stageCalls.find(call => call.callId === done.catalogRetry!.failedCallId)!
    expect(ExperienceIntentV2Schema.safeParse({ ...done, stageCalls: done.stageCalls.map(call => call === failed ? { ...call, failureCode: 'INVALID_CATALOG_SCAN_OUTPUT' } : call) }).success).toBe(false)
    expect(ExperienceIntentV2Schema.safeParse({ ...done, catalogRetry: { ...done.catalogRetry, authorizationRevision: done.revision + 1 } }).success).toBe(false)
    expect(ExperienceIntentV2Schema.safeParse({ ...done, reasonReceipts: [] }).success).toBe(false)
    expect(f.classify.mock.calls.filter(([input]) => input.pageOrdinal === 1)).toHaveLength(1)
    expect(f.current().status).toBe('COVERAGE_READY')
  })

})
