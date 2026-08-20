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

export const AutomaticLearningSettingsSchema: z<AutomaticLearningSettings> = z.object({
  automaticLearning: z.boolean().default(AUTOMATIC_LEARNING_DEFAULT),
})

interface DshSettingsScope<T> {
  get(): T
  watch(callback: (next: T, previous: T) => void | Promise<void>): () => void
}

export interface DshSettingsPort {
  register<T>(
    namespace: string,
    schema: z<T>,
    options: { readonly applies: 'live' },
  ): DshSettingsScope<T>
}

export interface AutomaticLearningSettingsPolicy extends AutomaticLearningPolicyPort {
  watch(callback: (
    next: AutomaticLearningSnapshot,
    previous: AutomaticLearningSnapshot,
  ) => void | Promise<void>): () => void
}

export function registerAutomaticLearningSettings(
  settings: DshSettingsPort,
): AutomaticLearningSettingsPolicy {
  const scope = settings.register(
    RUN2SKILL_SETTINGS_NAMESPACE,
    AutomaticLearningSettingsSchema,
    { applies: 'live' },
  )
  const freeze = (value: AutomaticLearningSettings): AutomaticLearningSnapshot => Object.freeze({
    automaticLearning: value.automaticLearning,
  })
  return {
    snapshot: () => freeze(scope.get()),
    watch: callback => scope.watch(async (next, previous) => {
      await callback(freeze(next), freeze(previous))
    }),
  }
}
