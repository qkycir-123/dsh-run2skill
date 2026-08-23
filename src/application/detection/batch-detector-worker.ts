import { z } from 'zod'
import { Run2skillV2GlobalStore } from '../../adapters/dsh-storage/v2-global-store.js'
import type { Run2skillV2Domain } from '../../adapters/dsh-storage/v2-types.js'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import {
  ExperienceIntentV2Schema,
  SessionBatchV2Schema,
  TurnObservationV2Schema,
  deriveExperienceIntentIdV2,
  deriveBehaviorSignatureV2,
  RUN2SKILL_V2_LIMITS,
  type ExperienceIntentV2,
  type SessionBatchV2,
  type TurnObservationV2,
} from '../../domain/v2/index.js'

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/)
const carryOutputSchema = z.object({
  summary: z.string().max(2048).refine(value => value.trim().length > 0),
  behaviorSignatureDraft: sha256Hex,
  evidenceDigests: z.array(sha256Hex).min(1).max(64),
}).strict()
const detectorOutputSchema = z.discriminatedUnion('result', [
  z.object({ result: z.literal('NONE') }).strict(),
  z.object({ result: z.literal('DEFER'), carry: z.array(carryOutputSchema).min(1).max(3) }).strict(),
  z.object({
    result: z.literal('READY'),
    intents: z.array(z.object({
      persistenceScope: z.enum(['PROJECT', 'USER']),
      experienceType: z.enum(['WORKFLOW', 'CONSTRAINT', 'CORRECTION']),
      applicabilitySummary: z.string().max(2048).refine(value => value.trim().length > 0),
      keySteps: z.array(z.string().max(1024).refine(value => value.trim().length > 0)).min(1).max(16),
      prohibitions: z.array(z.string().max(1024).refine(value => value.trim().length > 0)).max(16),
      evidenceDigests: z.array(sha256Hex).min(1).max(64),
      completeness: z.object({
        status: z.enum(['COMPLETE', 'INCOMPLETE']),
        blockers: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)).max(8),
      }).strict(),
    }).strict()).min(1).max(3),
  }).strict(),
])

export type BatchDetectorOutput = z.infer<typeof detectorOutputSchema>

export interface BatchDetectorInput {
  readonly batchId: string
  readonly sessionLifecycleKey: string
  readonly triggerReasons: SessionBatchV2['triggerReasons']
  readonly route: SessionBatchV2['routeSnapshot']
  readonly observations: readonly {
    readonly observationId: string
    readonly turnEndSeq: number
    readonly directUserEvidence: TurnObservationV2['directUserEvidence']
    readonly assistantOutcomeSummary: string
    readonly toolOutcomeSummary: TurnObservationV2['toolOutcomeSummary']
    readonly completeness: TurnObservationV2['completeness']
    readonly evidenceDigest: string
  }[]
  readonly carry: Readonly<NonNullable<ReturnType<Run2skillV2Domain['global']['get']>['sessions'][string]>['openExperienceCarry']>
}

export interface BatchDetectorClient {
  detect(input: BatchDetectorInput): Promise<unknown>
}

export interface BatchDetectorWorkerOptions {
  readonly client: BatchDetectorClient
  readonly permitBatch?: (batch: SessionBatchV2) => boolean
  readonly now?: () => number
}

interface ClaimedBatch {
  readonly batch: SessionBatchV2
  readonly observations: readonly TurnObservationV2[]
  readonly input: BatchDetectorInput
  readonly inputDigest: string
  readonly callId: string
}

interface RejectedBatch {
  readonly rejectedBatch: SessionBatchV2
}

export class BatchDetectorWorker {
  readonly #global
  readonly #batches
  readonly #observations
  readonly #intents
  readonly #client
  readonly #permitBatch
  readonly #now

  constructor(domain: Run2skillV2Domain, options: BatchDetectorWorkerOptions) {
    this.#global = Run2skillV2GlobalStore.for(domain)
    this.#batches = domain.table('session_batches')
    this.#observations = domain.table('turn_observations')
    this.#intents = domain.table('experience_intents')
    this.#client = options.client
    this.#permitBatch = options.permitBatch ?? (() => true)
    this.#now = options.now ?? Date.now
  }

  async runOnce(): Promise<'IDLE' | 'PROCESSED'> {
    await this.#repairCommittedReady()
    const claimed = await this.#claimNext()
    if (claimed === undefined) return 'IDLE'
    if ('rejectedBatch' in claimed) {
      await this.#advanceCursor(claimed.rejectedBatch)
      return 'PROCESSED'
    }
    let raw: unknown
    try {
      raw = await this.#client.detect(claimed.input)
    } catch {
      await this.#commitAttention(claimed, 'FAILED', 'MODEL_CALL_FAILED')
      return 'PROCESSED'
    }
    const outputDigest = this.#outputDigest(raw)
    const parsed = detectorOutputSchema.safeParse(raw)
    if (!parsed.success || !this.#evidenceIsBound(parsed.data, claimed)) {
      await this.#commitAttention(claimed, 'SUCCEEDED', 'INVALID_DETECTOR_OUTPUT', outputDigest)
      return 'PROCESSED'
    }
    try {
      await this.#commitOutput(claimed, parsed.data, outputDigest)
    } catch {
      const current = this.#batches.get(claimed.batch.batchId)
      if (current !== undefined && current.state !== 'DETECTION_CLAIMED') await this.#advanceCursor(current)
      else await this.#commitAttention(claimed, 'SUCCEEDED', 'DETECTOR_COMMIT_FAILED', outputDigest)
    }
    return 'PROCESSED'
  }

  async recover(): Promise<void> {
    const batches = [...this.#batches.entries()]
      .map(([, value]) => SessionBatchV2Schema.parse(value))
      .sort((left, right) => (
        left.sessionLifecycleKey.localeCompare(right.sessionLifecycleKey)
        || left.lastTurnEndSeq - right.lastTurnEndSeq
        || left.batchId.localeCompare(right.batchId)
      ))
    for (const batch of batches) {
      if (batch.state === 'DETECTION_CLAIMED') {
        const call = batch.detector.calls[0]!
        await this.#batches.update(batch.batchId, current => SessionBatchV2Schema.parse({
          ...current,
          revision: current.revision + 1,
          detector: {
            result: 'NEEDS_ATTENTION',
            failureCode: 'CALL_OUTCOME_UNKNOWN',
            calls: [{ ...call, outcome: 'OUTCOME_UNKNOWN', failureCode: 'CALL_OUTCOME_UNKNOWN' }],
            intentIds: [],
            ...(batch.detector.carry.length === 0 ? {} : { carryDigest: sha256Utf8(canonicalJson(batch.detector.carry)) }),
            carry: batch.detector.carry,
          },
          state: 'NEEDS_ATTENTION',
          updatedAt: this.#isoNow(),
        }))
        await this.#discardStagedIntents(batch.batchId)
        await this.#advanceCursor(this.#batches.get(batch.batchId)!)
      } else if (['COMMITTED_NONE', 'COMMITTED_DEFER', 'COMMITTED_READY', 'NEEDS_ATTENTION'].includes(batch.state)) {
        if (batch.state === 'COMMITTED_READY') await this.#repairReadyIntents(batch)
        else await this.#discardStagedIntents(batch.batchId)
        await this.#advanceCursor(batch)
      }
    }
  }

  #claimNext(): Promise<ClaimedBatch | RejectedBatch | undefined> {
    return this.#global.runExclusive<ClaimedBatch | RejectedBatch | undefined>(async current => {
      if (current.purgeJournal !== undefined) return { value: undefined }
      const batch = [...this.#batches.entries()]
        .map(([, value]) => SessionBatchV2Schema.parse(value))
        .filter(value => value.state === 'FROZEN' && this.#permitBatch(value))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.batchId.localeCompare(right.batchId))[0]
      if (batch === undefined) return { value: undefined }
      const cursor = current.sessions[batch.sessionLifecycleKey]
      if (cursor?.activeBatchId !== batch.batchId) throw new Error('Frozen batch is not the active Session batch')
      let observations: TurnObservationV2[]
      try {
        observations = batch.observationManifest.map(entry => {
          const observation = this.#observations.get(entry.observationId)
          if (observation === undefined) throw new Error('Frozen batch observation is unavailable')
          const parsed = TurnObservationV2Schema.parse(observation)
          if (parsed.evidenceDigest !== entry.evidenceDigest || parsed.turnEndSeq !== entry.turnEndSeq) {
            throw new Error('Frozen batch observation identity changed')
          }
          return parsed
        })
      } catch {
        const rejectedBatch = await this.#batches.update(batch.batchId, currentBatch => SessionBatchV2Schema.parse({
          ...currentBatch,
          revision: currentBatch.revision + 1,
          detector: {
            result: 'NEEDS_ATTENTION',
            failureCode: 'DETECTOR_INPUT_UNAVAILABLE',
            calls: [],
            intentIds: [],
            ...(cursor.openExperienceCarry.length === 0
              ? {}
              : { carryDigest: sha256Utf8(canonicalJson(cursor.openExperienceCarry)) }),
            carry: cursor.openExperienceCarry,
          },
          state: 'NEEDS_ATTENTION',
          updatedAt: this.#isoNow(),
        }))
        return { value: { rejectedBatch } }
      }
      const input: BatchDetectorInput = {
        batchId: batch.batchId,
        sessionLifecycleKey: batch.sessionLifecycleKey,
        triggerReasons: batch.triggerReasons,
        route: batch.routeSnapshot,
        observations: observations.map(item => ({
          observationId: item.observationId,
          turnEndSeq: item.turnEndSeq,
          directUserEvidence: item.directUserEvidence,
          assistantOutcomeSummary: item.assistantOutcomeSummary,
          toolOutcomeSummary: item.toolOutcomeSummary,
          completeness: item.completeness,
          evidenceDigest: item.evidenceDigest,
        })),
        carry: cursor.openExperienceCarry,
      }
      const inputDigest = sha256Utf8(canonicalJson(input))
      const callId = `call_${sha256Utf8(canonicalJson({
        batchId: batch.batchId,
        inputDigest,
        policyVersion: batch.routeSnapshot.policyVersion,
        ordinal: 1,
      }))}`
      const claimed = await this.#batches.update(batch.batchId, currentBatch => {
        if (currentBatch.state !== 'FROZEN') throw new Error('Batch was concurrently claimed')
        return SessionBatchV2Schema.parse({
          ...currentBatch,
          revision: currentBatch.revision + 1,
          detector: {
            result: 'NOT_RUN',
            calls: [{
              stage: 'DETECTION',
              callId,
              ordinal: 1,
              inputDigest,
              provider: batch.routeSnapshot.provider,
              model: batch.routeSnapshot.model,
              policyVersion: batch.routeSnapshot.policyVersion,
              outcome: 'RESERVED',
            }],
            intentIds: [],
            ...(cursor.openExperienceCarry.length === 0
              ? {}
              : { carryDigest: sha256Utf8(canonicalJson(cursor.openExperienceCarry)) }),
            carry: cursor.openExperienceCarry,
          },
          state: 'DETECTION_CLAIMED',
          updatedAt: this.#isoNow(),
        })
      })
      return { value: { batch: claimed, observations, input, inputDigest, callId } }
    })
  }

  async #commitOutput(claimed: ClaimedBatch, output: BatchDetectorOutput, outputDigest: string): Promise<void> {
    const now = this.#isoNow()
    const intentIds: string[] = []
    let carry: SessionBatchV2['detector']['carry'] = []
    let state: SessionBatchV2['state']
    if (output.result === 'READY') {
      for (const [index, item] of output.intents.entries()) {
        const intent = this.#materializeIntent(claimed, item, index + 1, now)
        const existing = this.#intents.get(intent.intentId)
        if (existing !== undefined && canonicalJson(existing) !== canonicalJson(intent)) {
          throw new Error('Experience Intent identity conflict')
        }
        if (existing === undefined) await this.#intents.put(intent.intentId, intent)
        intentIds.push(intent.intentId)
      }
      state = 'COMMITTED_READY'
    } else if (output.result === 'DEFER') {
      carry = output.carry.map(item => {
        const evidenceDigests = [...new Set(item.evidenceDigests)].sort()
        const prior = claimed.input.carry.find(existing => (
          existing.behaviorSignatureDraft === item.behaviorSignatureDraft
          || existing.evidenceDigests.some(digest => evidenceDigests.includes(digest))
        ))
        if (prior?.remainingBatches === 0) throw new Error('Deferred carry lifetime is exhausted')
        return {
          ...item,
          evidenceDigests,
          remainingBatches: prior === undefined ? 2 as const : (prior.remainingBatches - 1) as 0 | 1,
        }
      })
      state = 'COMMITTED_DEFER'
    } else {
      state = 'COMMITTED_NONE'
    }
    const result = output.result
    const terminal = await this.#batches.update(claimed.batch.batchId, current => {
      this.#assertClaim(current, claimed)
      return SessionBatchV2Schema.parse({
        ...current,
        revision: current.revision + 1,
        detector: {
          result,
          calls: [{ ...current.detector.calls[0]!, outcome: 'SUCCEEDED', outputDigest }],
          ...(carry.length === 0 ? {} : { carryDigest: sha256Utf8(canonicalJson(carry)) }),
          carry,
          intentIds,
        },
        state,
        updatedAt: now,
      })
    })
    if (terminal.state === 'COMMITTED_READY') await this.#repairReadyIntents(terminal)
    await this.#advanceCursor(terminal)
  }

  async #commitAttention(
    claimed: ClaimedBatch,
    outcome: 'SUCCEEDED' | 'FAILED',
    failureCode: string,
    outputDigest?: string,
  ): Promise<void> {
    const current = this.#batches.get(claimed.batch.batchId)
    if (current === undefined || current.state !== 'DETECTION_CLAIMED') return
    const terminal = await this.#batches.update(claimed.batch.batchId, latest => {
      this.#assertClaim(latest, claimed)
      return SessionBatchV2Schema.parse({
        ...latest,
        revision: latest.revision + 1,
        detector: {
          result: 'NEEDS_ATTENTION',
          failureCode,
          calls: [{
            ...latest.detector.calls[0]!,
            outcome,
            ...(outputDigest === undefined ? {} : { outputDigest }),
            failureCode,
          }],
          intentIds: [],
          ...(claimed.input.carry.length === 0
            ? {}
            : { carryDigest: sha256Utf8(canonicalJson(claimed.input.carry)) }),
          carry: claimed.input.carry,
        },
        state: 'NEEDS_ATTENTION',
        updatedAt: this.#isoNow(),
      })
    })
    await this.#discardStagedIntents(terminal.batchId)
    await this.#advanceCursor(terminal)
  }

  #materializeIntent(
    claimed: ClaimedBatch,
    output: Extract<BatchDetectorOutput, { result: 'READY' }>['intents'][number],
    ordinal: number,
    now: string,
  ): ExperienceIntentV2 {
    const evidenceDigests = [...new Set(output.evidenceDigests)].sort()
    const behaviorSignature = deriveBehaviorSignatureV2(output)
    const intentId = deriveExperienceIntentIdV2({
      sessionLifecycleKey: claimed.batch.sessionLifecycleKey,
      behaviorSignature,
      evidenceDigests,
      detectorPolicyVersion: claimed.batch.detectorPolicyVersion,
    })
    const evidenceRefs = claimed.observations
      .filter(item => evidenceDigests.includes(item.evidenceDigest))
      .map(item => ({
        observationId: item.observationId,
        sessionLifecycleKey: item.sessionLifecycleKey,
        turnEndSeq: item.turnEndSeq,
        evidenceDigest: item.evidenceDigest,
      }))
    return ExperienceIntentV2Schema.parse({
      schemaVersion: 1,
      revision: 1,
      intentId,
      batchId: claimed.batch.batchId,
      ordinal,
      sessionLifecycleKey: claimed.batch.sessionLifecycleKey,
      detectorPolicyVersion: claimed.batch.detectorPolicyVersion,
      persistenceScope: output.persistenceScope,
      explicitSave: claimed.batch.triggerReasons.includes('EXPLICIT'),
      experienceType: output.experienceType,
      applicabilitySummary: output.applicabilitySummary.trim(),
      keySteps: output.keySteps.map(step => step.trim()),
      prohibitions: output.prohibitions.map(item => item.trim()),
      behaviorSignature,
      evidenceRefs,
      evidenceDigests,
      completeness: output.completeness,
      quiescence: {
        state: 'WAITING',
        batchLastTurnEndSeq: claimed.batch.lastTurnEndSeq,
        requiredIdleMs: RUN2SKILL_V2_LIMITS.sessionIdleMs,
      },
      ownership: { state: 'NOT_STARTED' },
      recall: { state: 'NOT_STARTED', complete: false, summaryScanComplete: false, candidates: [] },
      coverage: { state: 'NOT_STARTED', retryUsed: false },
      generation: { state: 'NOT_STARTED', userRetryUsed: false, staleRefreshUsed: false, receipts: [] },
      stageCalls: [],
      reasonReceipts: [],
      status: 'DETECTOR_STAGED',
      createdAt: now,
      updatedAt: now,
    })
  }

  #evidenceIsBound(output: BatchDetectorOutput, claimed: ClaimedBatch): boolean {
    const current = new Set(claimed.observations.map(item => item.evidenceDigest))
    const allowed = new Set([...current, ...claimed.input.carry.flatMap(item => item.evidenceDigests)])
    const groups = output.result === 'READY' ? output.intents : output.result === 'DEFER' ? output.carry : []
    return groups.every(group => (
      group.evidenceDigests.every(digest => allowed.has(digest))
      && (output.result !== 'READY' || group.evidenceDigests.some(digest => current.has(digest)))
    ))
  }

  async #advanceCursor(batch: SessionBatchV2): Promise<void> {
    await this.#global.runExclusive(async global => {
      const cursor = global.sessions[batch.sessionLifecycleKey]
      if (cursor === undefined) throw new Error('Terminal batch has no Session cursor')
      if (batch.lastTurnEndSeq <= cursor.detectedThroughTurnEndSeq) return { value: undefined }
      if (cursor.activeBatchId !== undefined && cursor.activeBatchId !== batch.batchId) {
        throw new Error('Terminal batch conflicts with another active batch')
      }
      const { activeBatchId: _activeBatchId, ...rest } = cursor
      const advances = batch.lastTurnEndSeq >= cursor.detectedThroughTurnEndSeq
      const nextCarry = !advances
        ? cursor.openExperienceCarry
        : batch.detector.result === 'DEFER'
          ? batch.detector.carry
          : ['NONE', 'READY'].includes(batch.detector.result)
            ? []
            : cursor.openExperienceCarry
      return {
        value: undefined,
        global: {
          ...global,
          sessions: {
            ...global.sessions,
            [batch.sessionLifecycleKey]: {
              ...rest,
              detectedThroughTurnEndSeq: Math.max(cursor.detectedThroughTurnEndSeq, batch.lastTurnEndSeq),
              openExperienceCarry: nextCarry,
              updatedAt: this.#isoNow(),
            },
          },
        },
      }
    })
  }

  #assertClaim(batch: SessionBatchV2, claimed: ClaimedBatch): void {
    if (
      batch.state !== 'DETECTION_CLAIMED'
      || batch.detector.calls[0]?.callId !== claimed.callId
      || batch.detector.calls[0]?.inputDigest !== claimed.inputDigest
    ) throw new Error('Detector claim changed before commit')
  }

  async #repairReadyIntents(batch: SessionBatchV2): Promise<void> {
    for (const intentId of batch.detector.intentIds) {
      await this.#intents.update(intentId, current => {
        if (current.batchId !== batch.batchId) throw new Error('Ready Intent belongs to another batch')
        if (current.status !== 'DETECTOR_STAGED') return current
        return ExperienceIntentV2Schema.parse({
          ...current,
          revision: current.revision + 1,
          status: 'WAITING_FOR_QUIESCENCE',
          updatedAt: this.#isoNow(),
        })
      })
    }
  }

  async #repairCommittedReady(): Promise<void> {
    const batches = [...this.#batches.entries()]
      .map(([, value]) => SessionBatchV2Schema.parse(value))
      .filter(batch => batch.state === 'COMMITTED_READY')
      .sort((left, right) => left.lastTurnEndSeq - right.lastTurnEndSeq)
    for (const batch of batches) await this.#repairReadyIntents(batch)
  }

  async #discardStagedIntents(batchId: string): Promise<void> {
    for (const [intentId, intent] of this.#intents.entries()) {
      if (intent.batchId === batchId && intent.status === 'DETECTOR_STAGED') await this.#intents.delete(intentId)
    }
  }

  #isoNow(): string {
    return new Date(this.#now()).toISOString()
  }

  #outputDigest(raw: unknown): string {
    try {
      const serialized = canonicalJson(raw)
      return sha256Utf8(typeof serialized === 'string' ? serialized : 'null')
    } catch {
      return sha256Utf8('[UNSERIALIZABLE_DETECTOR_OUTPUT]')
    }
  }
}
