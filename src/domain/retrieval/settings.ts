export interface RetrievalSettings {
  readonly advancedRecall: boolean
  readonly embeddingEndpoint: string
  readonly embeddingModel: string
  readonly embeddingApiKeyEnv: string
  readonly rerankerMode: 'SESSION' | 'SERVICE'
  readonly rerankerEndpoint: string
  readonly rerankerModel: string
  readonly rerankerApiKeyEnv: string
}
export const RETRIEVAL_DEFAULTS: RetrievalSettings = Object.freeze({
  advancedRecall: false,
  embeddingEndpoint: '',
  embeddingModel: 'Qwen/Qwen3-Embedding-0.6B',
  embeddingApiKeyEnv: '',
  rerankerMode: 'SESSION' as 'SESSION' | 'SERVICE',
  rerankerEndpoint: '',
  rerankerModel: 'Qwen/Qwen3-Reranker-0.6B',
  rerankerApiKeyEnv: '',
})
