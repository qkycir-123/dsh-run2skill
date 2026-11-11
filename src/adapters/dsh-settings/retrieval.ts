import z from '@deepseek-ai/schemastery'
import { RETRIEVAL_DEFAULTS, type RetrievalSettings } from '../../domain/retrieval/settings.js'
export { RETRIEVAL_DEFAULTS, type RetrievalSettings } from '../../domain/retrieval/settings.js'

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
