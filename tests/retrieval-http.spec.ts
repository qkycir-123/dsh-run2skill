import { afterEach, describe, expect, it, vi } from 'vitest'
import { embedTexts, rerankTexts } from '../src/adapters/retrieval/http-models.js'

afterEach(() => { vi.unstubAllGlobals() })

describe('retrieval model adapters', () => {
  it('maps out-of-order embedding results to inputs and normalizes vectors', async () => {
    const request = vi.fn(async () => Response.json({ data: [
      { index: 1, embedding: [0, 3] }, { index: 0, embedding: [2, 0] },
    ] }))
    vi.stubGlobal('fetch', request)
    expect(await embedTexts({ endpoint: 'http://127.0.0.1:9000/v1/embeddings', model: 'qwen', keyEnv: '' }, ['first', 'second']))
      .toEqual([[1, 0], [0, 1]])
    expect(request).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'error' }))
  })

  it('rejects duplicated or non-finite embeddings rather than poisoning the cache', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [1] }] }))
    await expect(embedTexts({ endpoint: 'https://example.com/v1/embeddings', model: 'qwen', keyEnv: '' }, ['a', 'b'])).rejects.toThrow('MEMBERSHIP')
  })

  it('maps dedicated reranker scores back to exact candidate ids', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] }))
    expect(await rerankTexts({ endpoint: 'https://example.com/v1/rerank', model: 'qwen', keyEnv: '' }, 'query', [
      { candidateId: 'a', text: 'first' }, { candidateId: 'b', text: 'second' },
    ])).toEqual([{ candidateId: 'b', score: 0.9 }, { candidateId: 'a', score: 0.2 }])
  })

  it('does not send credentials to embedded-credential URLs or non-loopback plaintext endpoints', async () => {
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    for (const endpoint of ['http://example.com/embeddings', 'https://user:password@example.com/embeddings']) {
      await expect(embedTexts({ endpoint, model: 'qwen', keyEnv: '' }, ['a'])).rejects.toThrow('INVALID_MODEL_ENDPOINT')
    }
    expect(request).not.toHaveBeenCalled()
  })
})
