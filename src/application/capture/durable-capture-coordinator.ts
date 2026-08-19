import type { DurableCaptureResult, DurableCaptureStore } from '../../adapters/dsh-storage/durable-capture-store.js'
import type { CaptureWorkItemV1, SessionCheckpointV1 } from '../../domain/observe/schemas.js'
import { DomainError } from '../../domain/observe/errors.js'
import { deriveSessionLifecycleKeyFromFacts } from '../../domain/observe/identity.js'
import type { RuntimeNotices } from './runtime-notices.js'
import type { WriteBehindCheckpoint } from './write-behind-checkpoint.js'

export class DurableCaptureCoordinator {
  constructor(
    private readonly store: DurableCaptureStore,
    private readonly checkpoint: WriteBehindCheckpoint,
    private readonly notices: RuntimeNotices,
  ) {}

  async capture(
    item: CaptureWorkItemV1,
    progress: SessionCheckpointV1,
  ): Promise<DurableCaptureResult> {
    if (
      item.signalKey.rootSessionId !== progress.rootSessionId
      || item.signalKey.sessionCreatedAt !== progress.sessionCreatedAt
      || item.signalKey.sessionCwdDigest !== progress.sessionCwdDigest
      || item.signalKey.triggerPolicyVersion !== progress.triggerPolicyVersion
    ) {
      throw new DomainError('SIGNAL_KEY_CONFLICT')
    }
    const lifecycleKey = deriveSessionLifecycleKeyFromFacts(progress)
    await this.checkpoint.holdSignal(lifecycleKey, item.workItemId)
    let result: DurableCaptureResult
    try {
      result = await this.store.persist(item)
    } catch (error) {
      this.notices.record({
        healthCode: 'WORK_ITEM_WRITE_FAILED',
        sessionId: item.signalKey.rootSessionId,
        turnEndSeq: item.signalKey.turnEndSeq,
      })
      throw error
    }
    this.notices.clearSignal(item.signalKey.rootSessionId, item.signalKey.turnEndSeq)
    await this.checkpoint.releaseSignal(lifecycleKey, item.workItemId)
    await this.checkpoint.observeCompletedRoot(progress)
    return result
  }

  observeNoSignal(progress: SessionCheckpointV1): Promise<void> {
    return this.checkpoint.observeCompletedRoot(progress)
  }
}
