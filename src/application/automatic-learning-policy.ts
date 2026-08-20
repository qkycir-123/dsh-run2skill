import type { CaptureWorkItemV1, TriggerHit } from '../domain/observe/schemas.js'

export interface AutomaticLearningSnapshot {
  readonly automaticLearning: boolean
}

export interface AutomaticLearningPolicyPort {
  snapshot(): AutomaticLearningSnapshot
}

export function includesExplicitSave(
  input: Pick<CaptureWorkItemV1, 'triggerHits'> | readonly TriggerHit[],
): boolean {
  const hits: readonly TriggerHit[] = 'triggerHits' in input ? input.triggerHits : input
  return hits.some(hit => hit.kind === 'EXPLICIT_SAVE')
}

export function permitsLearning(
  input: Pick<CaptureWorkItemV1, 'triggerHits'> | readonly TriggerHit[],
  snapshot: AutomaticLearningSnapshot,
): boolean {
  return snapshot.automaticLearning || includesExplicitSave(input)
}
