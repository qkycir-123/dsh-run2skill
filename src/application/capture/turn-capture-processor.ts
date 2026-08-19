import { buildTurnObservation } from '../../adapters/dsh-session/observation.js'
import type { DshSessionEvent, DshSessionHeader } from '../../adapters/dsh-session/types.js'
import {
  CaptureWorkItemV1Schema,
  type CaptureWorkItemV1,
  type SessionCheckpointV1,
} from '../../domain/observe/schemas.js'
import { buildSignalKey, deriveWorkItemId } from '../../domain/observe/signal-key.js'
import { analyzeCheapTriggerV1 } from '../../domain/observe/trigger.js'
import type { DurableCaptureCoordinator } from './durable-capture-coordinator.js'
import type { RuntimeNotices } from './runtime-notices.js'

export type WorkspaceResolution =
  | { readonly status: 'BOUND'; readonly workspaceId: string; readonly canonicalPath: string }
  | { readonly status: 'UNREGISTERED' | 'UNAVAILABLE' }

export interface WorkspaceBindingPort {
  resolve(cwd: string): Promise<WorkspaceResolution>
}

export interface DurableTurnInput {
  readonly header: DshSessionHeader
  readonly events: readonly DshSessionEvent[]
  readonly turnEndSeq: number
  readonly progress: SessionCheckpointV1
}

function isoTime(time: number): string {
  const value = new Date(time)
  if (!Number.isFinite(value.getTime())) throw new Error('TURN_BOUNDARY_INCOMPLETE')
  return value.toISOString()
}

export class TurnCaptureProcessor {
  constructor(
    private readonly coordinator: DurableCaptureCoordinator,
    private readonly notices: RuntimeNotices,
    private readonly workspace: WorkspaceBindingPort,
  ) {}

  async processTurn(input: DurableTurnInput): Promise<void> {
    const result = buildTurnObservation(input.header, input.events, input.turnEndSeq)
    if (result.status === 'CHILD') return
    if (result.status === 'UNAVAILABLE') {
      this.notices.record({
        healthCode: result.healthCode,
        sessionId: result.sessionId ?? 'global',
        ...(result.turnEndSeq === undefined ? {} : { turnEndSeq: result.turnEndSeq }),
      })
      throw new Error(result.healthCode)
    }

    const observation = result.observation
    if (
      input.progress.rootSessionId !== observation.rootSessionId
      || input.progress.sessionCreatedAt !== observation.sessionCreatedAt
      || input.progress.sessionCwdDigest !== observation.sessionCwdDigest
      || input.progress.durableNextSeq < observation.turnEndSeq + 1
    ) {
      this.notices.record({
        healthCode: 'TURN_BOUNDARY_INCOMPLETE',
        sessionId: observation.rootSessionId,
        turnEndSeq: observation.turnEndSeq,
      })
      throw new Error('TURN_BOUNDARY_INCOMPLETE')
    }

    const timestamp = isoTime(observation.turnEndTime)
    const signalKey = buildSignalKey({
      rootSessionId: observation.rootSessionId,
      sessionCreatedAt: observation.sessionCreatedAt,
      sessionCwdDigest: observation.sessionCwdDigest,
      turn: observation.turn,
      turnEndSeq: observation.turnEndSeq,
      turnInstanceDigest: observation.turnInstanceDigest,
    })
    const analysis = analyzeCheapTriggerV1(observation.directUserMessages.map((message) => ({
      messageSeq: message.messageSeq,
      sourceKind: 'user' as const,
      text: message.textBlocks.join('\n'),
    })))
    const base = {
      schemaVersion: 1 as const,
      revision: 1,
      workItemId: deriveWorkItemId(signalKey),
      signalKey,
      createdAt: timestamp,
      updatedAt: timestamp,
      turnOutcomeKind: observation.turnOutcomeKind,
      rootIdentity: {
        status: 'ROOT' as const,
        ...(observation.parentSessionId === undefined
          ? {}
          : { parentSessionId: observation.parentSessionId }),
      },
    }

    if (analysis.status === 'INCOMPLETE') {
      const workspaceBinding = await this.#workspaceBinding(input.header.cwd, timestamp)
      await this.coordinator.capture(CaptureWorkItemV1Schema.parse({
        ...base,
        workspaceBinding,
        captureReason: 'SCAN_INCOMPLETE',
        scanStatus: 'INCOMPLETE',
        triggerHits: [],
        evidenceRefs: [],
        captureBlockers: analysis.captureBlockers,
        processingState: 'CAPTURED',
      }), input.progress)
      return
    }

    if (analysis.triggerHits.length > 0) {
      const workspaceBinding = await this.#workspaceBinding(input.header.cwd, timestamp)
      await this.coordinator.capture(CaptureWorkItemV1Schema.parse({
        ...base,
        workspaceBinding,
        captureReason: 'CHEAP_TRIGGER',
        scanStatus: 'COMPLETE',
        triggerHits: analysis.triggerHits,
        evidenceRefs: analysis.evidenceRefs,
        captureBlockers: [],
        processingState: 'CAPTURED',
      }), input.progress)
      return
    }

    if (!this.coordinator.hasCaptured(base.workItemId)) {
      await this.coordinator.observeNoSignal(input.progress)
      return
    }
    const workspaceBinding = await this.#workspaceBinding(input.header.cwd, timestamp)
    const resolution: CaptureWorkItemV1 = CaptureWorkItemV1Schema.parse({
      ...base,
      workspaceBinding,
      captureReason: 'SCAN_INCOMPLETE',
      scanStatus: 'COMPLETE',
      triggerHits: [],
      evidenceRefs: [],
      captureBlockers: [],
      processingState: 'RESOLVED_NO_SIGNAL',
    })
    await this.coordinator.resolveNoSignalIfCaptured(resolution, input.progress)
  }

  async #workspaceBinding(
    cwd: string | undefined,
    observedAt: string,
  ): Promise<CaptureWorkItemV1['workspaceBinding']> {
    if (cwd === undefined) return { status: 'NO_CWD', observedAt }
    try {
      const result = await this.workspace.resolve(cwd)
      if (result.status === 'BOUND') return { ...result, observedAt }
      return { status: result.status, observedAt }
    } catch {
      return { status: 'UNAVAILABLE', observedAt }
    }
  }
}
