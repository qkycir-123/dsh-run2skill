import { z } from 'zod'
import { sha256Utf8 } from '../observe/hashing.js'
import { preprocessPersistentText } from '../observe/redaction.js'
import { canonicalJson } from '../learn/identity.js'

export const RetrievalSignalSchema = z.object({
  candidateId: z.string().min(1).max(256),
  lexicalScore: z.number().finite().nonnegative().optional(),
  lexicalRank: z.number().int().positive().optional(),
  semanticScore: z.number().finite().min(-1).max(1).optional(),
  semanticRank: z.number().int().positive().optional(),
  fusionScore: z.number().finite().nonnegative(),
  rerankScore: z.number().finite().optional(),
  rerankRank: z.number().int().positive().optional(),
}).strict()

export const RetrievalPlanSchema = z.object({
  mode: z.enum(['STANDARD', 'HYBRID']),
  phase: z.enum(['SHORTLIST', 'FULL']),
  catalogDigest: z.string().regex(/^[a-f0-9]{64}$/),
  configDigest: z.string().regex(/^[a-f0-9]{64}$/),
  selectedIds: z.array(z.string().min(1).max(256)).max(1024),
  requiredBodyIds: z.array(z.string().min(1).max(256)).max(1024).optional(),
  signals: z.array(RetrievalSignalSchema).max(1024),
  embeddingModel: z.string().max(256),
  reranker: z.enum(['SESSION', 'SERVICE', 'RRF', 'NONE']),
  durationMs: z.number().finite().nonnegative(),
  embeddedCount: z.number().int().nonnegative(),
  fallback: z.enum(['DISABLED', 'SERVICE_UNAVAILABLE', 'RERANK_UNAVAILABLE']).optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.selectedIds).size !== value.selectedIds.length
    || new Set(value.signals.map(item => item.candidateId)).size !== value.signals.length
    || (value.mode === 'STANDARD' && value.phase !== 'FULL')) {
    context.addIssue({ code: 'custom', message: 'Invalid retrieval membership or phase' })
  }
  if (value.requiredBodyIds && (value.phase !== 'FULL'
    || value.requiredBodyIds.some(id => !value.selectedIds.includes(id))
    || new Set(value.requiredBodyIds).size !== value.requiredBodyIds.length)) {
    context.addIssue({ code: 'custom', message: 'Required body checks must come from the original shortlist' })
  }
})

export type RetrievalSignal = z.infer<typeof RetrievalSignalSchema>
export type RetrievalPlan = z.infer<typeof RetrievalPlanSchema>
export interface RetrievalSummary {
  readonly candidateId: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string | undefined
}
export interface RetrievalIntent {
  readonly experienceType: string
  readonly applicabilitySummary: string
  readonly keySteps: readonly string[]
  readonly prohibitions: readonly string[]
}

export function summaryText(summary: RetrievalSummary): string {
  return preprocessPersistentText(`名称：${summary.name}\n适用条件：${summary.whenToUse ?? ''}\n描述：${summary.description}`).text
}

export function queryText(intent: RetrievalIntent): string {
  return preprocessPersistentText(`经验类型：${intent.experienceType}\n适用条件：${intent.applicabilitySummary}\n关键步骤：${intent.keySteps.join('；')}\n禁止事项：${intent.prohibitions.join('；')}`).text
}

export function retrievalCatalogDigest(snapshot: {
  runtimeCatalogDigest: string; pendingCatalogDigest: string; catalogEpoch: number; catalogMutationReceiptDigest: string
}): string {
  return sha256Utf8(canonicalJson({
    runtime: snapshot.runtimeCatalogDigest, pending: snapshot.pendingCatalogDigest,
    epoch: snapshot.catalogEpoch, mutation: snapshot.catalogMutationReceiptDigest,
  }))
}

const stop = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'for', 'in', 'is', '使用', '进行', '一个', '这个'])
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

/** Keep term frequency, unlike the legacy overlap tokenizer. Preserve identifiers too. */
export function retrievalTokens(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase()
  const tokens: string[] = []
  for (const item of segmenter.segment(normalized)) {
    if (item.isWordLike && !stop.has(item.segment)) tokens.push(item.segment)
  }
  for (const match of normalized.matchAll(/[a-z0-9]+(?:[-_.:/][a-z0-9]+)+/g)) tokens.push(match[0])
  return tokens
}

/** Field-weighted BM25. Scores are only compared within this retrieval channel. */
export function bm25(query: string, summaries: readonly RetrievalSummary[]): { candidateId: string; score: number }[] {
  const terms = [...new Set(retrievalTokens(query))]
  const scores = new Map(summaries.map(item => [item.candidateId, 0]))
  for (const [field, weight] of [['name', 2], ['whenToUse', 3], ['description', 1]] as const) {
    const documents = summaries.map(item => retrievalTokens(item[field] ?? ''))
    const average = documents.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(documents.length, 1) || 1
    const counts = documents.map(tokens => {
      const frequencies = new Map<string, number>()
      for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
      return frequencies
    })
    for (const term of terms) {
      const frequency = counts.filter(count => count.has(term)).length
      const idf = Math.log(1 + (summaries.length - frequency + 0.5) / (frequency + 0.5))
      summaries.forEach((item, index) => {
        const tf = counts[index]!.get(term) ?? 0
        if (tf === 0) return
        const denominator = tf + 1.2 * (0.25 + 0.75 * documents[index]!.length / average)
        scores.set(item.candidateId, scores.get(item.candidateId)! + weight * idf * tf * 2.2 / denominator)
      })
    }
  }
  return [...scores].filter(([, score]) => score > 0).map(([candidateId, score]) => ({ candidateId, score }))
    .sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId))
}

export function normalizeVector(vector: readonly number[]): number[] {
  if (!vector.length || vector.length > 4096 || vector.some(value => !Number.isFinite(value))) throw new Error('INVALID_EMBEDDING')
  const norm = Math.hypot(...vector)
  if (!Number.isFinite(norm) || norm === 0) throw new Error('INVALID_EMBEDDING')
  return vector.map(value => value / norm)
}

export function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) throw new Error('EMBEDDING_DIMENSION_CHANGED')
  return Math.max(-1, Math.min(1, left.reduce((sum, value, index) => sum + value * right[index]!, 0)))
}

export function reciprocalRankFusion(
  lexical: readonly { candidateId: string; score: number }[],
  semantic: readonly { candidateId: string; score: number }[],
  k = 60,
): RetrievalSignal[] {
  const result = new Map<string, RetrievalSignal>()
  for (const [channel, items] of [['lexical', lexical], ['semantic', semantic]] as const) {
    items.forEach((item, index) => {
      const prior = result.get(item.candidateId) ?? { candidateId: item.candidateId, fusionScore: 0 }
      result.set(item.candidateId, {
        ...prior, [`${channel}Rank`]: index + 1, [`${channel}Score`]: item.score,
        fusionScore: prior.fusionScore + 1 / (k + index + 1),
      })
    })
  }
  return [...result.values()].sort((a, b) => b.fusionScore - a.fusionScore || a.candidateId.localeCompare(b.candidateId))
}
