import { expect, it } from 'vitest'
import { retrievalSettings, RetrievalSettingsSchema } from '../src/adapters/dsh-settings/retrieval.js'

it('loads retrieval preferences from a profile containing the retired automatic-learning flag', () => {
  const persisted = { automaticLearning: false, advancedRecall: true, embeddingModel: 'custom-embedding' }
  const parsed = RetrievalSettingsSchema(persisted)

  const settings = retrievalSettings(parsed)
  expect(settings).not.toHaveProperty('automaticLearning')
  expect(settings).toMatchObject({
    advancedRecall: true,
    embeddingModel: 'custom-embedding',
  })
})
