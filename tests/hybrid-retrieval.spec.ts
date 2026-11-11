import { describe, expect, it, vi } from 'vitest'
import { bm25, normalizeVector, reciprocalRankFusion, retrievalCatalogDigest } from '../src/domain/retrieval/hybrid.js'
import { HybridSkillRetrieval } from '../src/application/recall/hybrid-retrieval.js'
import { RETRIEVAL_DEFAULTS } from '../src/adapters/dsh-settings/retrieval.js'
import type { StoredSkillVector } from '../src/adapters/dsh-storage/retrieval-domain.js'
import type { Run2skillTable } from '../src/adapters/dsh-storage/types.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'
import { CompleteCatalogRecallWorker, deriveRecallCandidateId } from '../src/application/recall/complete-catalog-recall.js'
import { CompleteCoverageWorker } from '../src/application/coverage-analysis/complete-coverage.js'
import { ExperienceIntentV2Schema, SessionBatchV2Schema } from '../src/domain/v2/index.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'

function fixtures() {
  const value = createMinimalV2Fixtures()
  return { ...value, sessionBatch: SessionBatchV2Schema.parse(value.sessionBatch) }
}

function cache() {
  const values = new Map<string, StoredSkillVector>()
  const table: Run2skillTable<string, StoredSkillVector> = {
    get: key => values.get(key), entries: () => values.entries(), keys: () => values.keys(),
    get size() { return values.size }, put: async (key, value) => { values.set(key, structuredClone(value)) },
    delete: async key => values.delete(key), update: async (key, fn) => {
      const value = fn(values.get(key)!); values.set(key, value); return value
    },
  }
  return { values, epoch: 0, table: async () => table }
}

function snapshot(count = 3) {
  return {
    complete: true, runtimeCatalogDigest: '1'.repeat(64), pendingCatalogDigest: '2'.repeat(64),
    catalogEpoch: 1, catalogMutationReceiptDigest: '3'.repeat(64),
    summaries: Array.from({ length: count }, (_, index) => {
      const facts = {
        name: `workflow-${index}`, description: index === 0 ? '提交 PR 前执行 pnpm test' : `Other task ${index}`,
        provider: 'filesystem', source: 'project-dsh', scope: 'PROJECT' as const,
        rootIdentityDigest: 'a'.repeat(64), writable: true,
      }
      return { candidateId: deriveRecallCandidateId(facts), ...facts }
    }),
  }
}

describe('hybrid retrieval', () => {
  it('ranks a rare command over unrelated long text and preserves frequency saturation', () => {
    const hits = bm25('pnpm test 提交', [
      { candidateId: 'a', name: 'preflight', description: '提交前 pnpm test' },
      { candidateId: 'b', name: 'unrelated', description: '启动开发服务器 '.repeat(100) },
    ])
    expect(hits.map(item => item.candidateId)).toEqual(['a'])
    expect(reciprocalRankFusion([{ candidateId: 'a', score: 100 }, { candidateId: 'b', score: 5 }], [
      { candidateId: 'b', score: 0.8 }, { candidateId: 'a', score: 0.7 },
    ])[0]!.fusionScore).toBeCloseTo(1 / 61 + 1 / 62)
    expect(() => normalizeVector([0, 0])).toThrow()
  })

  it('reuses vectors across service instances, updates only changed summaries and isolates snapshot membership', async () => {
    const store = cache()
    const embed = vi.fn(async (_options, texts: readonly string[]) => texts.map(() => [1, 0]))
    const rank = vi.fn(async input => ({ orderedCandidateIds: input.candidates.map((item: { candidateId: string }) => item.candidateId) }))
    const options = { settings: () => ({ ...RETRIEVAL_DEFAULTS, advancedRecall: true }), cache: store, embed, reranker: { rank } }
    const fixture = fixtures()
    const initial = snapshot()
    const first = await new HybridSkillRetrieval(options).prepare(fixture.proposalReadyIntent, fixture.sessionBatch, initial)
    expect(first).toMatchObject({ mode: 'HYBRID', embeddedCount: 3, reranker: 'SESSION' })
    embed.mockClear()
    const second = await new HybridSkillRetrieval(options).prepare(fixture.proposalReadyIntent, fixture.sessionBatch, initial)
    expect(second.embeddedCount).toBe(0)
    expect(embed).toHaveBeenCalledTimes(1) // query only, no corpus re-embedding
    const changed = snapshot(2)
    changed.summaries[0]!.description = '提交前增加构建验证'
    const third = await new HybridSkillRetrieval(options).prepare(fixture.proposalReadyIntent, fixture.sessionBatch, changed)
    expect(third.embeddedCount).toBe(1)
    expect(store.values.size).toBe(2)
    expect(third.signals.some(item => item.candidateId === initial.summaries[2]!.candidateId)).toBe(false)
  })

  it('does no model or cache work when disabled, and falls back without accepting malformed reranker ids', async () => {
    const fixture = fixtures()
    const store = cache()
    const embed = vi.fn(async (_options, texts: readonly string[]) => texts.map(() => [1, 0]))
    const disabled = new HybridSkillRetrieval({ settings: () => RETRIEVAL_DEFAULTS, cache: store, embed, reranker: { rank: async () => ({}) } })
    expect((await disabled.prepare(fixture.proposalReadyIntent, fixture.sessionBatch, snapshot())).fallback).toBe('DISABLED')
    expect(embed).not.toHaveBeenCalled()
    const broken = new HybridSkillRetrieval({ settings: () => ({ ...RETRIEVAL_DEFAULTS, advancedRecall: true }), cache: store, embed, reranker: { rank: async () => ({ orderedCandidateIds: ['invented'] }) } })
    expect(await broken.prepare(fixture.proposalReadyIntent, fixture.sessionBatch, snapshot())).toMatchObject({ mode: 'HYBRID', reranker: 'RRF', fallback: 'RERANK_UNAVAILABLE' })
  })

  it('falls back to standard mode for unavailable embeddings', async () => {
    const fixture = fixtures()
    const service = new HybridSkillRetrieval({
      settings: () => ({ ...RETRIEVAL_DEFAULTS, advancedRecall: true }), cache: cache(),
      embed: async () => { throw new Error('unavailable') }, reranker: { rank: async () => ({}) },
    })
    expect(await service.prepare(fixture.proposalReadyIntent, fixture.sessionBatch, snapshot())).toMatchObject({ mode: 'STANDARD', phase: 'FULL', fallback: 'SERVICE_UNAVAILABLE' })
  })
})

async function pipeline() {
  const domain = createMemoryRun2skillV2Domain()
  const fixture = fixtures()
  const intent = ExperienceIntentV2Schema.parse({
    ...fixture.proposalReadyIntent, revision: 1, status: 'RUN2SKILL_OWNED', explicitSave: false,
    recall: { state: 'NOT_STARTED', complete: false, summaryScanComplete: false, candidates: [] },
    coverage: { state: 'NOT_STARTED', retryUsed: false },
    generation: { state: 'NOT_STARTED', userRetryUsed: false, staleRefreshUsed: false, receipts: [] },
    stageCalls: [], lineageId: undefined,
  })
  await domain.table('experience_intents').put(intent.intentId, intent)
  await domain.table('session_batches').put(fixture.sessionBatch.batchId, fixture.sessionBatch)
  const catalogValue = snapshot()
  const catalog = {
    snapshot: async () => catalogValue,
    read: async ({ candidateId }: { candidateId: string }) => {
      const item = catalogValue.summaries.find(candidate => candidate.candidateId === candidateId)
      return item ? { ...item, content: `# ${item.name}\nRun lint and test.` } : undefined
    },
  }
  const firstId = catalogValue.summaries[0]!.candidateId
  const recall = new CompleteCatalogRecallWorker(domain, {
    catalog, retrieval: { prepare: async () => ({
      mode: 'HYBRID', phase: 'SHORTLIST', catalogDigest: retrievalCatalogDigest(catalogValue), configDigest: 'c'.repeat(64),
      selectedIds: [firstId], signals: [{ candidateId: firstId, fusionScore: 0.03, semanticScore: 0.9, rerankScore: 0.8 }],
      embeddingModel: 'test', reranker: 'SERVICE', durationMs: 1, embeddedCount: 0,
    }) },
    classifier: { classify: async input => ({ classifications: input.summaries.map(item => ({ candidateId: item.candidateId, classification: 'RELEVANT' })) }) },
  })
  return { domain, intent, catalog, recall, firstId }
}

describe('guarded hybrid decisions', () => {
  it('yields to an active purge instead of repeatedly reporting progress', async () => {
    const p = await pipeline()
    const global = p.domain.global.get()
    await p.domain.global.set({ ...global, purgeJournal: {
      schemaVersion: 1, purgeId: `purge_${'a'.repeat(64)}`, scopeBinding: { scope: 'ALL' },
      hideBefore: p.intent.createdAt, phase: 'QUIESCED', updatedAt: p.intent.updatedAt,
    } })
    expect(await p.recall.runOnce()).toBe('IDLE')
    await p.domain.global.set(global)
    expect(await p.recall.runOnce()).toBe('PROCESSED')
  })

  it('retains known partial body evidence even if the full summary scan later disagrees', async () => {
    const p = await pipeline()
    await p.recall.runOnce()
    const seen: string[][] = []
    const coverage = new CompleteCoverageWorker(p.domain, { catalog: p.catalog, classifier: {
      classify: async input => {
        seen.push(input.candidates.map(item => item.candidateId))
        return { decisions: input.candidates.map(item => ({ candidateId: item.candidateId, decision: 'PARTIAL', reason: 'same workflow' })) }
      },
    } })
    await coverage.runOnce()
    const full = new CompleteCatalogRecallWorker(p.domain, { catalog: p.catalog, classifier: {
      classify: async input => ({ classifications: input.summaries.map(item => ({
        candidateId: item.candidateId, classification: item.candidateId === p.firstId ? 'UNRELATED' : 'RELEVANT',
      })) }),
    } })
    await full.runOnce()
    await coverage.runOnce()
    expect(seen[1]).toContain(p.firstId)
    expect(p.domain.experienceIntents.get(p.intent.intentId)).toMatchObject({ status: 'NEEDS_ATTENTION', coverage: { reasonCode: 'COVERAGE_AMBIGUOUS' } })
  })

  it('does not prepare vectors for a snapshot that spans a completed purge', async () => {
    const p = await pipeline()
    const prepare = vi.fn()
    const snapshot = p.catalog.snapshot
    p.catalog.snapshot = async () => {
      const captured = await snapshot()
      const global = p.domain.global.get()
      await p.domain.global.set({ ...global, proposalCatalogEpoch: global.proposalCatalogEpoch + 1 })
      return captured
    }
    const worker = new CompleteCatalogRecallWorker(p.domain, { catalog: p.catalog, retrieval: { prepare }, classifier: { classify: async () => ({}) } })
    await worker.runOnce()
    expect(prepare).not.toHaveBeenCalled()
    expect(p.domain.experienceIntents.get(p.intent.intentId)).toMatchObject({ status: 'NEEDS_ATTENTION', recall: { incompleteReason: 'CATALOG_CHANGED' } })
  })

  it('allows a proven covered result after shortlist inspection without claiming exhaustive scan', async () => {
    const p = await pipeline()
    await p.recall.runOnce()
    const classify = vi.fn(async input => ({ decisions: input.candidates.map((item: { candidateId: string }) => ({ candidateId: item.candidateId, decision: 'COVERED', reason: 'exact rule' })) }))
    await new CompleteCoverageWorker(p.domain, { catalog: p.catalog, classifier: { classify } }).runOnce()
    const result = p.domain.experienceIntents.get(p.intent.intentId)!
    expect(result.status).toBe('COVERED')
    expect(result.recall.summaryScanComplete).toBe(false)
    expect(classify.mock.calls[0]![0].candidates[0].retrievalSignal.semanticScore).toBe(0.9)
  })

  it.each(['UNRELATED', 'PARTIAL'])('requires a complete scan before a %s result can authorize mutation', async decision => {
    const p = await pipeline()
    await p.recall.runOnce()
    const coverage = new CompleteCoverageWorker(p.domain, { catalog: p.catalog, classifier: {
      classify: async input => ({ decisions: input.candidates.map(item => ({
        candidateId: item.candidateId, decision: item.candidateId === p.firstId ? decision : 'UNRELATED', reason: 'evidence',
      })) }),
    } })
    await coverage.runOnce()
    expect(p.domain.experienceIntents.get(p.intent.intentId)).toMatchObject({ status: 'RECALLING', recall: { retrieval: { phase: 'FULL' } } })
    await p.recall.runOnce()
    await coverage.runOnce()
    expect(p.domain.experienceIntents.get(p.intent.intentId)).toMatchObject({
      status: decision === 'PARTIAL' ? 'MERGE_AUTHORIZED' : 'CREATE_AUTHORIZED', recall: { summaryScanComplete: true, scanSummaryCount: 3 },
    })
  })

  it('stops an unreadable shortlist cleanly instead of trapping the worker in RECALLING', async () => {
    const p = await pipeline()
    const originalRead = p.catalog.read
    p.catalog.read = async () => undefined
    await p.recall.runOnce()
    expect(p.domain.experienceIntents.get(p.intent.intentId)).toMatchObject({
      status: 'NEEDS_ATTENTION', recall: { state: 'INCOMPLETE', summaryScanComplete: false, incompleteReason: 'RELEVANT_CANDIDATE_UNAVAILABLE' },
    })
    expect(await p.recall.runOnce()).toBe('IDLE')
    p.catalog.read = originalRead
  })

  it.each([true, false])('falls back after an invalid retrieval plan with advancedRecall=%s', async advancedRecall => {
    const p = await pipeline()
    const retrieval = new HybridSkillRetrieval({
      settings: () => ({ ...RETRIEVAL_DEFAULTS, advancedRecall, embeddingModel: 'x'.repeat(257) }),
      cache: cache(), embed: async () => { throw new Error('not configured') }, reranker: { rank: async () => ({}) },
    })
    const worker = new CompleteCatalogRecallWorker(p.domain, { catalog: p.catalog, retrieval,
      classifier: { classify: async input => ({ classifications: input.summaries.map(item => ({ candidateId: item.candidateId, classification: 'RELEVANT' })) }) },
    })
    await worker.runOnce()
    expect(p.domain.experienceIntents.get(p.intent.intentId)).toMatchObject({
      status: 'COVERAGE_READY', recall: { summaryScanComplete: true, scanSummaryCount: 3, retrieval: { mode: 'STANDARD' } },
    })
  })
})
