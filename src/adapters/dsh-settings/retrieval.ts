import z from '@deepseek-ai/schemastery'

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
export type RetrievalConfig = { readonly [K in keyof RetrievalSettings]?: { get(): RetrievalSettings[K] } }

export const RetrievalSettingsFields = {
  advancedRecall: z.boolean().default(false).volatile(),
  embeddingEndpoint: z.string().default('').volatile(),
  embeddingModel: z.string().default(RETRIEVAL_DEFAULTS.embeddingModel).volatile(),
  embeddingApiKeyEnv: z.string().default('').volatile(),
  rerankerMode: z.union(['SESSION', 'SERVICE']).default('SESSION').volatile(),
  rerankerEndpoint: z.string().default('').volatile(),
  rerankerModel: z.string().default(RETRIEVAL_DEFAULTS.rerankerModel).volatile(),
  rerankerApiKeyEnv: z.string().default('').volatile(),
}

export function retrievalSettings(config: RetrievalConfig): RetrievalSettings {
  return Object.freeze(Object.fromEntries(Object.entries(RETRIEVAL_DEFAULTS).map(([key, value]) => [
    key, config[key as keyof RetrievalConfig]?.get() ?? value,
  ])) as RetrievalSettings)
}
