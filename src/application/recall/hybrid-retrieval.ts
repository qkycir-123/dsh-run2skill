import type { RecallCatalogSnapshot } from './complete-catalog-recall.js'
import type { ExperienceIntentV2, SessionBatchV2 } from '../../domain/v2/index.js'
import {
  bm25, cosine, normalizeVector, queryText, reciprocalRankFusion, retrievalCatalogDigest,
  summaryText, type RetrievalPlan,
} from '../../domain/retrieval/hybrid.js'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import type { RetrievalSettings } from '../../adapters/dsh-settings/retrieval.js'
import type { PersistentVectorCache } from '../../adapters/dsh-storage/retrieval-domain.js'
import { embedTexts, rerankTexts } from '../../adapters/retrieval/http-models.js'

export interface HybridRetrievalPort {
  prepare(intent: ExperienceIntentV2, batch: SessionBatchV2, snapshot: RecallCatalogSnapshot): Promise<RetrievalPlan>
}
export interface SessionReranker {
  rank(input: {
    query: string; candidates: readonly { candidateId: string; text: string }[];
    route: SessionBatchV2['routeSnapshot']
  }): Promise<unknown>
}

export class HybridSkillRetrieval implements HybridRetrievalPort {
  #controller = new AbortController()
  #tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly options: {
    settings(): RetrievalSettings
    cache: Pick<PersistentVectorCache, 'table'>
    reranker: SessionReranker
    embed?: typeof embedTexts
    rerank?: typeof rerankTexts
    now?: () => number
  }) {}

  dispose(): void { this.#controller.abort() }

  prepare(intent: ExperienceIntentV2, batch: SessionBatchV2, snapshot: RecallCatalogSnapshot): Promise<RetrievalPlan> {
    // Capture once, before waiting: a settings edit never changes an in-flight operation.
    const config = { ...this.options.settings() }
    const task = this.#tail.then(() => this.#prepare(intent, batch, snapshot, config))
    this.#tail = task.catch(() => {})
    return task
  }

  async #prepare(intent: ExperienceIntentV2, batch: SessionBatchV2, snapshot: RecallCatalogSnapshot, config: RetrievalSettings): Promise<RetrievalPlan> {
    const now = this.options.now ?? Date.now
    const started = now()
    const base: RetrievalPlan = {
      mode: 'STANDARD', phase: 'FULL', catalogDigest: retrievalCatalogDigest(snapshot),
      configDigest: sha256Utf8(canonicalJson(config)), selectedIds: [], signals: [],
      embeddingModel: config.embeddingModel, reranker: 'NONE', durationMs: 0, embeddedCount: 0,
    }
    if (!config.advancedRecall) return { ...base, fallback: 'DISABLED' }
    try {
      const signal = AbortSignal.any([this.#controller.signal, AbortSignal.timeout(60_000)])
      if (!snapshot.complete || snapshot.summaries.length > 1024) throw new Error('CATALOG_UNAVAILABLE')
      const table = await this.options.cache.table()
      const fingerprint = sha256Utf8(canonicalJson({
        endpoint: config.embeddingEndpoint, model: config.embeddingModel, textVersion: 'summary-query-v1',
      }))
      // Only current snapshot membership may be searched, regardless of cache contents.
      const visible = new Set(snapshot.summaries.map(item => item.candidateId))
      const roots = new Set(snapshot.summaries.map(item => item.rootIdentityDigest))
      for (const [key, record] of table.entries()) {
        if (roots.has(record.rootDigest) && (!visible.has(record.candidateId) || record.fingerprint !== fingerprint)) await table.delete(key)
      }
      const vectors = new Map<string, number[]>()
      const missing: { candidateId: string; text: string; key: string; digest: string; root: string }[] = []
      for (const item of snapshot.summaries) {
        const text = summaryText(item)
        const digest = sha256Utf8(text)
        const key = sha256Utf8(canonicalJson({ candidateId: item.candidateId, fingerprint }))
        const cached = table.get(key)
        if (cached?.summaryDigest === digest && cached.fingerprint === fingerprint) {
          vectors.set(item.candidateId, normalizeVector(cached.vector))
        } else missing.push({ candidateId: item.candidateId, text, key, digest, root: item.rootIdentityDigest })
      }
      const embedding = { endpoint: config.embeddingEndpoint, model: config.embeddingModel, keyEnv: config.embeddingApiKeyEnv }
      for (let offset = 0; offset < missing.length; offset += 16) {
        signal.throwIfAborted()
        const items = missing.slice(offset, offset + 16)
        const output = await (this.options.embed ?? embedTexts)(embedding, items.map(item => item.text), signal)
        if (output.length !== items.length) throw new Error('EMBEDDING_MEMBERSHIP')
        for (const [index, item] of items.entries()) {
          const vector = normalizeVector(output[index]!)
          await table.put(item.key, {
            candidateId: item.candidateId, rootDigest: item.root, fingerprint,
            summaryDigest: item.digest, vector, updatedAt: now(),
          })
          vectors.set(item.candidateId, vector)
        }
      }
      // Bound persistent derived data across inactive projects and model changes.
      const oldest = [...table.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)
      for (const [key] of oldest.slice(0, Math.max(0, oldest.length - 4096))) await table.delete(key)
      const query = queryText(intent)
      const [rawQuery] = await (this.options.embed ?? embedTexts)(embedding, [
        `Instruct: Retrieve reusable skills for the same workflow and applicability, including skills missing the new rule.\nQuery: ${query}`,
      ], signal)
      const queryVector = normalizeVector(rawQuery!)
      const semantic = snapshot.summaries.map(item => ({ candidateId: item.candidateId, score: cosine(queryVector, vectors.get(item.candidateId)!) }))
        .sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId)).slice(0, 20)
      const lexical = bm25(query, snapshot.summaries).slice(0, 20)
      let signals = reciprocalRankFusion(lexical, semantic).slice(0, 30)
      let reranker: RetrievalPlan['reranker'] = config.rerankerMode
      let fallback: RetrievalPlan['fallback']
      if (signals.length) {
        const byId = new Map(snapshot.summaries.map(item => [item.candidateId, item]))
        const candidates = signals.map(item => ({ candidateId: item.candidateId, text: summaryText(byId.get(item.candidateId)!) }))
        try {
          let order: { candidateId: string; score?: number }[]
          if (config.rerankerMode === 'SERVICE') {
            order = await (this.options.rerank ?? rerankTexts)({
              endpoint: config.rerankerEndpoint, model: config.rerankerModel, keyEnv: config.rerankerApiKeyEnv,
            }, query, candidates, signal)
          } else {
            const result = await this.options.reranker.rank({ query, candidates, route: batch.routeSnapshot })
            const ids = result && typeof result === 'object' && 'orderedCandidateIds' in result ? result.orderedCandidateIds : undefined
            if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('INVALID_RERANK')
            order = (ids as string[]).map(candidateId => ({ candidateId }))
          }
          if (order.length !== candidates.length || new Set(order.map(item => item.candidateId)).size !== candidates.length
            || order.some(item => !byId.has(item.candidateId) || !signals.some(hit => hit.candidateId === item.candidateId))) throw new Error('INVALID_RERANK')
          signals = order.map((item, index) => ({
            ...signals.find(hit => hit.candidateId === item.candidateId)!, rerankRank: index + 1,
            ...(item.score === undefined ? {} : { rerankScore: item.score }),
          }))
        } catch { reranker = 'RRF'; fallback = 'RERANK_UNAVAILABLE' }
      }
      // Pending proposals and unresolved barriers must never disappear behind Top K.
      const selectedIds = [...new Set([
        ...signals.slice(0, 10).map(item => item.candidateId),
        ...snapshot.summaries.filter(item => item.provider === 'run2skill-pending').map(item => item.candidateId),
      ])]
      return {
        ...base, mode: 'HYBRID', phase: 'SHORTLIST', selectedIds, signals, reranker,
        durationMs: Math.max(0, now() - started), embeddedCount: missing.length,
        ...(fallback ? { fallback } : {}),
      }
    } catch {
      return { ...base, fallback: 'SERVICE_UNAVAILABLE', durationMs: Math.max(0, now() - started) }
    }
  }
}
