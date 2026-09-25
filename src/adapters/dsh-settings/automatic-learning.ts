import z from '@deepseek-ai/schemastery'
import type {
  AutomaticLearningPolicyPort,
  AutomaticLearningSnapshot,
} from '../../application/automatic-learning-policy.js'

export const RUN2SKILL_SETTINGS_NAMESPACE = 'run2skill'
export const AUTOMATIC_LEARNING_DEFAULT = true

export interface AutomaticLearningSettings {
  readonly automaticLearning: boolean
}

export interface AutomaticLearningConfig {
  readonly automaticLearning: { get(): boolean }
}

export const AutomaticLearningSettingsSchema = z.object({
  automaticLearning: z.boolean().default(AUTOMATIC_LEARNING_DEFAULT).volatile(),
})

export interface AutomaticLearningSettingsPolicy extends AutomaticLearningPolicyPort {
  watch(callback: (next: AutomaticLearningSnapshot, previous: AutomaticLearningSnapshot) => void): () => void
}

export function createAutomaticLearningSettings(context: {
  readonly config: AutomaticLearningConfig
  on(event: 'loader/volatile-update', listener: (paths: readonly (readonly string[])[]) => void): void
}): AutomaticLearningSettingsPolicy {
  const listeners = new Set<(next: AutomaticLearningSnapshot, previous: AutomaticLearningSnapshot) => void>()
  let previous = context.config.automaticLearning.get()
  const freeze = (value: boolean): AutomaticLearningSnapshot => Object.freeze({ automaticLearning: value })
  context.on('loader/volatile-update', paths => {
    if (!paths.some(path => path.length === 1 && path[0] === 'automaticLearning')) return
    const next = context.config.automaticLearning.get()
    if (next === previous) return
    const before = freeze(previous)
    previous = next
    const after = freeze(next)
    for (const listener of listeners) listener(after, before)
  })
  return {
    snapshot: () => freeze(context.config.automaticLearning.get()),
    watch: callback => {
      listeners.add(callback)
      return () => { listeners.delete(callback) }
    },
  }
}
