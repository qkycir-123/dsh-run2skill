import { z } from 'zod'
import { normalizeVector } from '../../domain/retrieval/hybrid.js'

/** Full endpoint URLs are explicit: embedding and reranking APIs need not share a host. */
function endpoint(value: string): URL {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash
    || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('INVALID_MODEL_ENDPOINT')
  }
  return url
}

function apiKey(name: string): string | undefined {
  if (!name) return undefined
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('INVALID_CREDENTIAL_REFERENCE')
  const value = process.env[name]
  if (!value?.trim()) throw new Error('CREDENTIAL_UNAVAILABLE')
  return value.trim()
}

async function post(url: string, keyEnv: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const key = apiKey(keyEnv)
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (key) headers.set('Authorization', ['Bearer', key].join(' '))
  const response = await fetch(endpoint(url), {
    method: 'POST', redirect: 'error',
    headers,
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  })
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('MODEL_SERVICE_FAILED') }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      bytes += item.value.byteLength
      if (bytes > 2 * 1024 * 1024) throw new Error('MODEL_RESPONSE_TOO_LARGE')
      chunks.push(item.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally { await reader.cancel().catch(() => {}) }
}

export async function embedTexts(
  options: { endpoint: string; model: string; keyEnv: string }, texts: readonly string[], signal?: AbortSignal,
): Promise<number[][]> {
  const result = z.object({ data: z.array(z.object({
    index: z.number().int().nonnegative(), embedding: z.array(z.number().finite()).min(1).max(4096),
  })).max(16) }).parse(await post(options.endpoint, options.keyEnv, {
    model: options.model, input: texts, encoding_format: 'float',
  }, signal))
  const sorted = result.data.sort((a, b) => a.index - b.index)
  if (sorted.length !== texts.length || sorted.some((item, index) => item.index !== index)) throw new Error('INVALID_EMBEDDING_MEMBERSHIP')
  const vectors = sorted.map(item => normalizeVector(item.embedding))
  if (vectors.some(vector => vector.length !== vectors[0]!.length)) throw new Error('EMBEDDING_DIMENSION_CHANGED')
  return vectors
}

export async function rerankTexts(
  options: { endpoint: string; model: string; keyEnv: string }, query: string,
  candidates: readonly { candidateId: string; text: string }[], signal?: AbortSignal,
): Promise<{ candidateId: string; score: number }[]> {
  const result = z.object({ results: z.array(z.object({
    index: z.number().int().nonnegative(), relevance_score: z.number().finite(),
  })).max(30) }).parse(await post(options.endpoint, options.keyEnv, {
    model: options.model, query, documents: candidates.map(item => item.text), top_n: candidates.length,
  }, signal))
  if (result.results.length !== candidates.length || new Set(result.results.map(item => item.index)).size !== candidates.length
    || result.results.some(item => item.index >= candidates.length)) throw new Error('INVALID_RERANK_MEMBERSHIP')
  return result.results.map(item => ({ candidateId: candidates[item.index]!.candidateId, score: item.relevance_score }))
    .sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId))
}
