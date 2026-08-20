import type { DshSessionGapReader } from '../../adapters/dsh-session/gap-reader.js'
import type { DurableCaptureStore } from '../../adapters/dsh-storage/durable-capture-store.js'
import { deriveSessionLifecycleKeyFromFacts } from '../../domain/observe/identity.js'
import type { CaptureWorkItemV1, SessionCheckpointV1 } from '../../domain/observe/schemas.js'
import type { RuntimeNotices } from './runtime-notices.js'
import type { TurnCaptureProcessor } from './turn-capture-processor.js'
import type { WriteBehindCheckpoint } from './write-behind-checkpoint.js'

export const INCOMPLETE_CAPTURE_RETRY_BATCH = 64

export interface IncompleteCaptureRetryResult {
  readonly attempted: number
  readonly resolved: number
  readonly remaining: number
}

export class IncompleteCaptureRetrier {
  #cursor: string | undefined
  #running: Promise<IncompleteCaptureRetryResult> | undefined

  constructor(
    private readonly reader: DshSessionGapReader,
    private readonly store: DurableCaptureStore,
    private readonly checkpoint: WriteBehindCheckpoint,
    private readonly processor: TurnCaptureProcessor,
    private readonly notices: RuntimeNotices,
  ) {}

  retryBatch(signal?: AbortSignal): Promise<IncompleteCaptureRetryResult> {
    if (this.#running !== undefined) return this.#running
    const running = this.#retryBatch(signal)
    this.#running = running
    void running.finally(() => {
      if (this.#running === running) this.#running = undefined
    })
    return running
  }

  async #retryBatch(signal?: AbortSignal): Promise<IncompleteCaptureRetryResult> {
    const items = this.store.getIncomplete(INCOMPLETE_CAPTURE_RETRY_BATCH, this.#cursor)
    let resolved = 0
    for (const item of items) {
      signal?.throwIfAborted()
      this.#cursor = item.workItemId
      if (await this.#retry(item, signal)) resolved += 1
    }
    return {
      attempted: items.length,
      resolved,
      remaining: this.store.countIncomplete(),
    }
  }

  async #retry(item: CaptureWorkItemV1, signal?: AbortSignal): Promise<boolean> {
    const read = await this.reader.readFrom(item.signalKey.rootSessionId, 0, signal)
    if (read.status === 'UNAVAILABLE') {
      this.notices.record({
        healthCode: read.healthCode,
        sessionId: item.signalKey.rootSessionId,
        turnEndSeq: item.signalKey.turnEndSeq,
      })
      return false
    }
    const tailSeq = read.events.at(-1)?.seq
    const turnEnd = read.events.find(event => (
      event.seq === item.signalKey.turnEndSeq && event.type === 'turn/end'
    ))
    if (tailSeq === undefined || turnEnd === undefined) {
      this.notices.record({
        healthCode: 'SESSION_LOG_UNAVAILABLE',
        sessionId: item.signalKey.rootSessionId,
        turnEndSeq: item.signalKey.turnEndSeq,
      })
      return false
    }

    const lifecycleKey = deriveSessionLifecycleKeyFromFacts(item.signalKey)
    let progress = this.checkpoint.snapshot().sessions[lifecycleKey]
    if (progress === undefined) {
      const recovered: SessionCheckpointV1 = {
        rootSessionId: item.signalKey.rootSessionId,
        sessionCreatedAt: item.signalKey.sessionCreatedAt,
        sessionCwdDigest: item.signalKey.sessionCwdDigest,
        triggerPolicyVersion: item.signalKey.triggerPolicyVersion,
        activationFenceSeq: item.signalKey.turnEndSeq + 1,
        durableNextSeq: item.signalKey.turnEndSeq + 1,
        observedTailSeq: tailSeq,
      }
      await this.checkpoint.activate([recovered])
      progress = recovered
    }

    await this.processor.processTurn({
      header: read.header,
      events: read.events,
      turnEndSeq: item.signalKey.turnEndSeq,
      progress: {
        ...progress,
        durableNextSeq: Math.max(progress.durableNextSeq, item.signalKey.turnEndSeq + 1),
        observedTailSeq: Math.max(progress.observedTailSeq, tailSeq),
      },
    })
    return this.store.get(item.workItemId)?.scanStatus === 'COMPLETE'
  }
}
