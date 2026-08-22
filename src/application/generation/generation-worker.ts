import { z } from 'zod'
import { Run2skillV2GlobalStore } from '../../adapters/dsh-storage/v2-global-store.js'
import type { Run2skillV2Domain } from '../../adapters/dsh-storage/v2-types.js'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import { preprocessPersistentText } from '../../domain/observe/redaction.js'
import {
  deriveBehaviorSignatureIndexKeyV2,
  deriveGenerationBarrierIdV2,
  deriveGenerationBarrierReceiptDigestV2,
  deriveGenerationCallIdV2,
  deriveGenerationInputDigestV2,
  deriveGenerationLeaseIdV2,
  deriveGenerationReceiptDigestV2,
  deriveGenerationResultIdV2,
  deriveGenerationResultReceiptDigestV2,
  deriveProposalCatalogMutationIdV2,
  deriveProposalCatalogMutationReceiptDigestV2,
  ExperienceIntentV2Schema,
  SessionBatchV2Schema,
  type ExperienceIntentV2,
  type GlobalV2,
  type SessionBatchV2,
} from '../../domain/v2/index.js'
import { renderCanonicalSkill } from '../curation/skill-renderer.js'
import type { RecallCatalogDefinition } from '../recall/index.js'

const utf8Limited = (maxBytes: number) => z.string().refine(
  value => Buffer.byteLength(value, 'utf8') <= maxBytes,
  `Expected at most ${maxBytes} UTF-8 bytes`,
)
const generationOutputSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: utf8Limited(2 * 1024).refine(value => value.trim().length > 0),
  whenToUse: utf8Limited(4 * 1024).refine(value => value.trim().length > 0),
  content: utf8Limited(60 * 1024).refine(value => /^#{1,6}\s+\S/mu.test(value)),
}).strict()

function hasFormatControls(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (
      /\p{Cf}/u.test(character)
      || codePoint <= 8
      || codePoint === 11
      || codePoint === 12
      || (codePoint >= 14 && codePoint <= 31)
      || (codePoint >= 127 && codePoint <= 159)
    ) return true
  }
  return false
}

function digestUnknownOutput(value: unknown): string {
  try {
    const canonical = canonicalJson(value)
    return sha256Utf8(typeof canonical === 'string' ? canonical : '[UNSERIALIZABLE_GENERATION_OUTPUT]')
  } catch {
    return sha256Utf8('[UNSERIALIZABLE_GENERATION_OUTPUT]')
  }
}

export interface GenerationCatalogSnapshot {
  readonly complete: boolean
  readonly runtimeCatalogDigest: string
  readonly pendingCatalogDigest: string
  readonly externalPendingDigest: string
  readonly catalogEpoch: number
  readonly catalogMutationReceiptDigest: string
}

export interface GenerationCatalogPort {
  snapshot(input: { readonly batch: SessionBatchV2; readonly intent: ExperienceIntentV2 }): Promise<GenerationCatalogSnapshot>
  read(input: {
    readonly candidateId: string
    readonly batch: SessionBatchV2
    readonly intent: ExperienceIntentV2
  }): Promise<RecallCatalogDefinition | undefined>
}

export interface SkillGenerator {
  generate(input: {
    readonly action: 'CREATE' | 'MERGE'
    readonly intent: Pick<ExperienceIntentV2, 'intentId' | 'persistenceScope' | 'experienceType' | 'applicabilitySummary' | 'keySteps' | 'prohibitions'>
    readonly targetCandidateId?: string | undefined
    readonly baseSkill?: string | undefined
    readonly inputDigest: string
    readonly route: SessionBatchV2['routeSnapshot']
  }): Promise<unknown>
}

export interface GenerationWorkerOptions {
  readonly catalog: GenerationCatalogPort
  readonly generator: SkillGenerator
  readonly policy?: Partial<{ readonly reserveBytes: number; readonly policyVersion: string }>
  readonly now?: () => number
}

const DEFAULT_POLICY = Object.freeze({ reserveBytes: 8 * 1024, policyVersion: 'generation-v2' })

interface GenerationPolicy {
  readonly reserveBytes: number
  readonly policyVersion: string
}

type FailureKind = 'KNOWN_FAILED' | 'RESULT_LOST' | 'OUTCOME_UNKNOWN'
type ProposalGenerationLease = NonNullable<GlobalV2['proposalGenerationLease']>
type AcquireOutcome = 'ACQUIRED' | 'BLOCKED' | 'STALE' | 'CONFLICT' | 'HANDLED'
type LeaseBinding =
  | { readonly outcome: 'ACQUIRED'; readonly leaseId: string; readonly acquiredAt: string }
  | { readonly outcome: 'BLOCKED' | 'STALE' | 'CONFLICT' }

export class GenerationWorker {
  readonly #global: Run2skillV2GlobalStore
  readonly #intents
  readonly #batches
  readonly #catalog: GenerationCatalogPort
  readonly #generator: SkillGenerator
  readonly #policy: GenerationPolicy
  readonly #now: () => number

  constructor(domain: Run2skillV2Domain, options: GenerationWorkerOptions) {
    this.#global = Run2skillV2GlobalStore.for(domain)
    this.#intents = domain.table('experience_intents')
    this.#batches = domain.table('session_batches')
    this.#catalog = options.catalog
    this.#generator = options.generator
    this.#policy = { ...DEFAULT_POLICY, ...options.policy }
    this.#now = options.now ?? Date.now
    if (
      !Number.isSafeInteger(this.#policy.reserveBytes)
      || this.#policy.reserveBytes < 0
      || this.#policy.policyVersion.trim().length === 0
    ) throw new Error('Invalid generation policy')
  }

  async runOnce(): Promise<'IDLE' | 'PROCESSED'> {
    const currentLeaseOwner = this.#global.get().proposalGenerationLease?.ownerIntentId
    const candidate = [...this.#intents.entries()]
      .map(([, value]) => ExperienceIntentV2Schema.parse(value))
      .filter(intent => ['CREATE_AUTHORIZED', 'MERGE_AUTHORIZED'].includes(intent.status))
      .sort((left, right) => (
        Number(right.intentId === currentLeaseOwner) - Number(left.intentId === currentLeaseOwner)
        || left.createdAt.localeCompare(right.createdAt)
        || left.ordinal - right.ordinal
      ))[0]
    if (candidate === undefined) return 'IDLE'
    const batchValue = this.#batches.get(candidate.batchId)
    const batch = batchValue === undefined ? undefined : SessionBatchV2Schema.safeParse(batchValue)
    if (!batch?.success) {
      await this.#preCallAttention(candidate.intentId, 'GENERATION_INPUT_UNAVAILABLE')
      return 'PROCESSED'
    }

    const acquireOutcome = await this.#acquire(candidate, batch.data)
    if (acquireOutcome === 'STALE') await this.#preCallAttention(candidate.intentId, 'GENERATION_CATALOG_CHANGED')
    if (acquireOutcome === 'CONFLICT') await this.#preCallAttention(candidate.intentId, 'GENERATION_DUPLICATE_CONFLICT')
    if (acquireOutcome !== 'ACQUIRED') return 'PROCESSED'
    const leased = ExperienceIntentV2Schema.parse(this.#intents.get(candidate.intentId))

    let snapshot: GenerationCatalogSnapshot
    try {
      snapshot = await this.#catalog.snapshot({ batch: batch.data, intent: leased })
    } catch {
      await this.#releasePreCall(leased.intentId, 'GENERATION_CATALOG_CHANGED')
      return 'PROCESSED'
    }
    if (!this.#snapshotMatches(snapshot, leased)) {
      await this.#releasePreCall(leased.intentId, 'GENERATION_CATALOG_CHANGED')
      return 'PROCESSED'
    }

    let baseSkill: string | undefined
    if (leased.generation.action === 'MERGE') {
      const targetCandidateId = leased.coverage.targetCandidateId
      if (targetCandidateId === undefined) {
        await this.#releasePreCall(leased.intentId, 'GENERATION_TARGET_CHANGED')
        return 'PROCESSED'
      }
      let target: RecallCatalogDefinition | undefined
      try {
        target = await this.#catalog.read({ candidateId: targetCandidateId, batch: batch.data, intent: leased })
      } catch {
        target = undefined
      }
      if (target === undefined || sha256Utf8(target.content) !== leased.coverage.targetDigest) {
        await this.#releasePreCall(leased.intentId, 'GENERATION_TARGET_CHANGED')
        return 'PROCESSED'
      }
      const processed = preprocessPersistentText(target.content)
      if (processed.redactionKinds.length > 0 || hasFormatControls(target.content)) {
        await this.#releasePreCall(leased.intentId, 'GENERATION_TARGET_CHANGED')
        return 'PROCESSED'
      }
      baseSkill = processed.text
      const afterRead = await this.#safeSnapshot(batch.data, leased)
      if (afterRead === undefined || !this.#snapshotMatches(afterRead, leased)) {
        await this.#releasePreCall(leased.intentId, 'GENERATION_CATALOG_CHANGED')
        return 'PROCESSED'
      }
    }

    const modelInput = this.#modelInput(leased, batch.data, baseSkill)
    if (Buffer.byteLength(canonicalJson(modelInput), 'utf8') + this.#policy.reserveBytes > batch.data.routeSnapshot.maxInputBytes) {
      await this.#releasePreCall(leased.intentId, 'GENERATION_INPUT_BUDGET_EXHAUSTED')
      return 'PROCESSED'
    }
    const immediatelyBeforeCall = await this.#safeSnapshot(batch.data, leased)
    if (immediatelyBeforeCall === undefined || !this.#snapshotMatches(immediatelyBeforeCall, leased)) {
      await this.#releasePreCall(leased.intentId, 'GENERATION_CATALOG_CHANGED')
      return 'PROCESSED'
    }
    const callId = deriveGenerationCallIdV2(leased.generation.leaseId!, leased.generation.inputDigest!)
    if (!await this.#reserveCall(leased.intentId, batch.data, callId)) return 'PROCESSED'

    let raw: unknown
    try {
      raw = await this.#generator.generate(modelInput)
    } catch {
      if (await this.#terminalCall(leased.intentId, callId, 'FAILED', undefined, 'GENERATION_CALL_FAILED')) {
        await this.#commitBarrier(leased.intentId, 'KNOWN_FAILED')
      }
      return 'PROCESSED'
    }

    const parsed = generationOutputSchema.safeParse(raw)
    const outputBytes = (() => {
      try { return Buffer.byteLength(canonicalJson(raw), 'utf8') } catch { return Number.POSITIVE_INFINITY }
    })()
    if (!parsed.success || outputBytes > batch.data.routeSnapshot.maxOutputBytes) {
      if (await this.#terminalCall(
        leased.intentId,
        callId,
        'SUCCEEDED',
        digestUnknownOutput(raw),
        'INVALID_GENERATION_OUTPUT',
      )) await this.#commitBarrier(leased.intentId, 'RESULT_LOST')
      return 'PROCESSED'
    }
    if (leased.generation.action === 'MERGE') {
      const target = leased.recall.candidates.find(item => item.candidateId === leased.coverage.targetCandidateId)
      if (parsed.data.name !== target?.summary.name) {
        if (await this.#terminalCall(
          leased.intentId,
          callId,
          'SUCCEEDED',
          digestUnknownOutput(raw),
          'INVALID_GENERATION_OUTPUT',
        )) await this.#commitBarrier(leased.intentId, 'RESULT_LOST')
        return 'PROCESSED'
      }
    }
    const exactSkillBytes = renderCanonicalSkill({
      ...parsed.data,
      invocation: { modelInvocable: true, userInvocable: false },
    })
    if (
      Buffer.byteLength(exactSkillBytes, 'utf8') > 64 * 1024
      || hasFormatControls(exactSkillBytes)
      || preprocessPersistentText(exactSkillBytes).redactionKinds.length > 0
    ) {
      if (await this.#terminalCall(
        leased.intentId,
        callId,
        'SUCCEEDED',
        digestUnknownOutput(raw),
        'UNSAFE_GENERATION_OUTPUT',
      )) await this.#commitBarrier(leased.intentId, 'RESULT_LOST')
      return 'PROCESSED'
    }
    const outputDigest = sha256Utf8(canonicalJson(parsed.data))
    if (!await this.#terminalCall(leased.intentId, callId, 'SUCCEEDED', outputDigest)) return 'PROCESSED'
    await this.#commitResult(leased.intentId, parsed.data, exactSkillBytes)
    return 'PROCESSED'
  }

  async recover(): Promise<void> {
    const global = this.#global.get()
    const lease = global.proposalGenerationLease
    if (lease === undefined) {
      await this.#recoverStrandedPreCallIntents()
      return
    }
    const value = this.#intents.get(lease.ownerIntentId)
    if (value === undefined) {
      if (lease.state === 'NOT_CALLED') await this.#releaseOrphanNotCalled(lease)
      return
    }
    const intent = ExperienceIntentV2Schema.parse(value)

    if (lease.state === 'NOT_CALLED' && !(
      (['CREATE_AUTHORIZED', 'MERGE_AUTHORIZED'].includes(intent.status) && intent.generation.generationRevision === lease.generationRevision)
      || (intent.generation.state === 'GENERATION_LEASED' && intent.generation.leaseId === lease.leaseId)
    )) {
      await this.#releaseOrphanNotCalled(lease, intent)
      return
    }

    if (global.proposalCatalogMutationJournal !== undefined) {
      if (intent.generation.state === 'RESULT_COMMITTED') {
        await this.#finalizeResult(intent)
        return
      }
      if (intent.generation.state === 'NEEDS_ATTENTION' && intent.duplicateBarrier !== undefined) {
        await this.#finalizeBarrier(intent)
        return
      }
      await this.#abandonPreparedMutation(intent)
    }
    if (lease.state === 'RESULT_COMMITTED') return

    const currentCall = intent.stageCalls.find(call => (
      call.stage === 'GENERATION' && call.intentRevision === lease.generationRevision
    ))
    if (currentCall?.outcome === 'SUCCEEDED') {
      await this.#commitBarrier(intent.intentId, 'RESULT_LOST')
      return
    }
    if (currentCall !== undefined && currentCall.outcome !== 'RESERVED') {
      await this.#commitBarrier(intent.intentId, currentCall.outcome === 'OUTCOME_UNKNOWN' ? 'OUTCOME_UNKNOWN' : 'KNOWN_FAILED')
      return
    }
    if (lease.state === 'CALL_RESERVED' || currentCall?.outcome === 'RESERVED') {
      await this.#forceUnknownTerminal(intent.intentId, lease)
      await this.#commitBarrier(intent.intentId, 'OUTCOME_UNKNOWN')
    }
  }

  async #acquire(intent: ExperienceIntentV2, batch: SessionBatchV2): Promise<AcquireOutcome> {
    const targetDigest = intent.coverage.targetDigest
    if (
      targetDigest === undefined
      || intent.generation.action === undefined
      || intent.generation.generationRevision === undefined
      || intent.generation.externalPendingDigest === undefined
      || intent.recall.catalogEpoch === undefined
      || intent.recall.runtimeCatalogDigest === undefined
      || intent.recall.pendingCatalogDigest === undefined
      || intent.recall.catalogMutationReceiptDigest === undefined
      || intent.coverage.planDigest === undefined
    ) {
      await this.#preCallAttention(intent.intentId, 'GENERATION_INPUT_UNAVAILABLE')
      return 'HANDLED'
    }
    const action = intent.generation.action
    const generationRevision = intent.generation.generationRevision
    const externalPendingDigest = intent.generation.externalPendingDigest
    const catalogEpoch = intent.recall.catalogEpoch
    const runtimeCatalogDigest = intent.recall.runtimeCatalogDigest
    const pendingCatalogDigest = intent.recall.pendingCatalogDigest
    const catalogMutationReceiptDigest = intent.recall.catalogMutationReceiptDigest
    const coveragePlanDigest = intent.coverage.planDigest
    const inputDigest = deriveGenerationInputDigestV2({
      intentId: intent.intentId,
      generationRevision,
      behaviorSignature: intent.behaviorSignature,
      action,
      coveragePlanDigest,
      targetDigest,
      runtimeCatalogDigest,
      pendingCatalogDigest,
      externalPendingDigest,
      catalogEpoch,
      catalogMutationReceiptDigest,
      routeProvider: batch.routeSnapshot.provider,
      routeModel: batch.routeSnapshot.model,
      policyVersion: this.#policy.policyVersion,
    })
    const leaseId = deriveGenerationLeaseIdV2({
      intentId: intent.intentId,
      generationRevision,
      action,
      inputDigest,
      externalPendingDigest,
      catalogEpoch,
    })
    const proposedAcquiredAt = this.#isoNow()
    const leaseBinding = await this.#global.runExclusive<LeaseBinding>(async current => {
      const existing = current.proposalGenerationLease
      if (existing !== undefined) {
        return {
          value: existing.leaseId === leaseId
            && existing.ownerIntentId === intent.intentId
            && existing.state === 'NOT_CALLED'
            && current.purgeJournal === undefined
            && current.proposalCatalogMutationJournal === undefined
            && current.proposalCatalogEpoch === existing.catalogEpoch
            ? { outcome: 'ACQUIRED' as const, leaseId: existing.leaseId, acquiredAt: existing.acquiredAt }
            : { outcome: 'BLOCKED' as const },
        }
      }
      if (current.purgeJournal !== undefined || current.proposalCatalogMutationJournal !== undefined) {
        return { value: { outcome: 'BLOCKED' as const } }
      }
      if (current.proposalCatalogEpoch !== catalogEpoch) return { value: { outcome: 'STALE' as const } }
      const key = deriveBehaviorSignatureIndexKeyV2(intent.persistenceScope, intent.behaviorSignature)
      const indexed = current.behaviorSignatureIndex[key]
      if (indexed !== undefined && (indexed.ownerIntentId !== intent.intentId || indexed.state !== 'RESERVED')) {
        return { value: { outcome: 'CONFLICT' as const } }
      }
      return {
        value: { outcome: 'ACQUIRED' as const, leaseId, acquiredAt: proposedAcquiredAt },
        global: {
          ...current,
          behaviorSignatureIndex: {
            ...current.behaviorSignatureIndex,
            [key]: indexed ?? {
              schemaVersion: 1,
              persistenceScope: intent.persistenceScope,
              behaviorSignature: intent.behaviorSignature,
              ownerIntentId: intent.intentId,
              ownerRevision: intent.revision,
              state: 'RESERVED',
              updatedAt: proposedAcquiredAt,
            },
          },
          proposalGenerationLease: {
            schemaVersion: 1,
            leaseId,
            ownerIntentId: intent.intentId,
            ownerRevision: intent.revision,
            generationRevision,
            action,
            inputDigest,
            externalPendingDigest,
            catalogEpoch,
            acquiredAt: proposedAcquiredAt,
            state: 'NOT_CALLED',
          },
        },
      }
    })
    if (leaseBinding.outcome !== 'ACQUIRED') return leaseBinding.outcome

    let bound = false
    await this.#intents.update(intent.intentId, current => {
      const parsed = ExperienceIntentV2Schema.parse(current)
      if (parsed.status === 'GENERATING' && parsed.generation.leaseId === leaseId) {
        bound = true
        return parsed
      }
      if (!['CREATE_AUTHORIZED', 'MERGE_AUTHORIZED'].includes(parsed.status)) return parsed
      const receipt = this.#receipt(
        'LEASE_ACQUIRED', parsed, leaseBinding.leaseId, leaseBinding.acquiredAt, undefined, parsed.recall.catalogEpoch,
      )
      bound = true
      return ExperienceIntentV2Schema.parse({
        ...parsed,
        revision: parsed.revision + 1,
        status: 'GENERATING',
        generation: {
          ...parsed.generation,
          state: 'GENERATION_LEASED',
          inputDigest,
          leaseId: leaseBinding.leaseId,
          receipts: [receipt],
        },
        updatedAt: this.#isoNow(),
      })
    })
    return bound ? 'ACQUIRED' : 'BLOCKED'
  }

  #snapshotMatches(snapshot: GenerationCatalogSnapshot, intent: ExperienceIntentV2): boolean {
    const global = this.#global.get()
    return snapshot.complete
      && snapshot.runtimeCatalogDigest === intent.recall.runtimeCatalogDigest
      && snapshot.pendingCatalogDigest === intent.recall.pendingCatalogDigest
      && snapshot.externalPendingDigest === intent.generation.externalPendingDigest
      && snapshot.catalogEpoch === intent.generation.catalogEpoch
      && snapshot.catalogMutationReceiptDigest === intent.recall.catalogMutationReceiptDigest
      && global.proposalCatalogEpoch === snapshot.catalogEpoch
      && global.proposalCatalogMutationJournal === undefined
      && global.purgeJournal === undefined
  }

  async #safeSnapshot(batch: SessionBatchV2, intent: ExperienceIntentV2): Promise<GenerationCatalogSnapshot | undefined> {
    try { return await this.#catalog.snapshot({ batch, intent }) } catch { return undefined }
  }

  #modelInput(intent: ExperienceIntentV2, batch: SessionBatchV2, baseSkill?: string) {
    return {
      action: intent.generation.action!,
      intent: {
        intentId: intent.intentId,
        persistenceScope: intent.persistenceScope,
        experienceType: intent.experienceType,
        applicabilitySummary: intent.applicabilitySummary,
        keySteps: intent.keySteps,
        prohibitions: intent.prohibitions,
      },
      ...(intent.coverage.targetCandidateId === undefined ? {} : { targetCandidateId: intent.coverage.targetCandidateId }),
      ...(baseSkill === undefined ? {} : { baseSkill }),
      inputDigest: intent.generation.inputDigest!,
      route: batch.routeSnapshot,
    }
  }

  async #reserveCall(intentId: string, batch: SessionBatchV2, callId: string): Promise<boolean> {
    const before = ExperienceIntentV2Schema.parse(this.#intents.get(intentId))
    if (before.generation.state !== 'GENERATION_LEASED' || before.generation.leaseId === undefined) return false
    const leaseId = before.generation.leaseId
    let markedGlobal = false
    try {
      markedGlobal = await this.#global.runExclusive(async current => {
        const lease = current.proposalGenerationLease
        if (
          lease?.leaseId !== leaseId
          || lease.state !== 'NOT_CALLED'
          || current.purgeJournal !== undefined
          || current.proposalCatalogMutationJournal !== undefined
        ) return { value: false }
        return { value: true, global: { ...current, proposalGenerationLease: { ...lease, callId, state: 'CALL_RESERVED' } } }
      })
    } catch {
      markedGlobal = false
    }
    if (!markedGlobal) return false

    let won = false
    await this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (intent.generation.state !== 'GENERATION_LEASED' || intent.generation.leaseId !== leaseId) return intent
      won = true
      const recordedAt = this.#isoNow()
      return ExperienceIntentV2Schema.parse({
        ...intent,
        revision: intent.revision + 1,
        status: 'GENERATING',
        generation: {
          ...intent.generation,
          state: 'GENERATION_CALL_RESERVED',
          receipts: [...intent.generation.receipts, this.#receipt(
            'CALL_RESERVED', intent, leaseId, recordedAt, callId, intent.generation.catalogEpoch,
          )],
        },
        stageCalls: [...intent.stageCalls, {
          stage: 'GENERATION', intentRevision: intent.generation.generationRevision!, callId, ordinal: 1,
          inputDigest: intent.generation.inputDigest!, provider: batch.routeSnapshot.provider,
          model: batch.routeSnapshot.model, policyVersion: this.#policy.policyVersion, outcome: 'RESERVED',
        }],
        updatedAt: recordedAt,
      })
    })
    if (!won) await this.recover()
    return won
  }

  async #terminalCall(
    intentId: string,
    callId: string,
    outcome: 'SUCCEEDED' | 'FAILED',
    outputDigest?: string,
    failureCode?: string,
  ): Promise<boolean> {
    let committed = false
    await this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (intent.generation.state !== 'GENERATION_CALL_RESERVED') return intent
      const call = intent.stageCalls.find(item => item.callId === callId)
      if (call?.outcome !== 'RESERVED') return intent
      committed = true
      const recordedAt = this.#isoNow()
      return ExperienceIntentV2Schema.parse({
        ...intent,
        revision: intent.revision + 1,
        status: 'GENERATING',
        generation: {
          ...intent.generation,
          state: 'GENERATION_CALL_TERMINAL',
          receipts: [...intent.generation.receipts, this.#receipt(
            'CALL_TERMINAL', intent, intent.generation.leaseId!, recordedAt, callId, intent.generation.catalogEpoch,
          )],
        },
        stageCalls: intent.stageCalls.map(item => item.callId === callId ? {
          ...item,
          outcome,
          ...(outputDigest === undefined ? {} : { outputDigest }),
          ...(failureCode === undefined ? {} : { failureCode }),
        } : item),
        updatedAt: recordedAt,
      })
    })
    return committed
  }

  async #forceUnknownTerminal(intentId: string, lease: ProposalGenerationLease): Promise<void> {
    const callId = lease.callId
    if (callId === undefined) return
    await this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (!['GENERATION_AUTHORIZED', 'GENERATION_LEASED', 'GENERATION_CALL_RESERVED'].includes(intent.generation.state)) return intent
      const recordedAt = this.#isoNow()
      const existing = intent.stageCalls.find(item => item.callId === callId)
      const leasedReceipt = intent.generation.receipts.some(item => item.kind === 'LEASE_ACQUIRED')
        ? []
        : [this.#receipt('LEASE_ACQUIRED', intent, lease.leaseId, lease.acquiredAt, undefined, lease.catalogEpoch)]
      const reservedReceipt = intent.generation.receipts.some(item => item.kind === 'CALL_RESERVED')
        ? []
        : [this.#receipt('CALL_RESERVED', intent, lease.leaseId, recordedAt, callId, lease.catalogEpoch)]
      const terminalReceipt = this.#receipt('CALL_TERMINAL', intent, lease.leaseId, recordedAt, callId, lease.catalogEpoch)
      return ExperienceIntentV2Schema.parse({
        ...intent,
        revision: intent.revision + 1,
        status: 'GENERATING',
        generation: {
          ...intent.generation,
          state: 'GENERATION_CALL_TERMINAL',
          inputDigest: lease.inputDigest,
          leaseId: lease.leaseId,
          catalogEpoch: lease.catalogEpoch,
          externalPendingDigest: lease.externalPendingDigest,
          receipts: [...intent.generation.receipts, ...leasedReceipt, ...reservedReceipt, terminalReceipt],
        },
        stageCalls: existing === undefined
          ? [...intent.stageCalls, {
              stage: 'GENERATION', intentRevision: intent.generation.generationRevision!, callId, ordinal: 1,
              inputDigest: lease.inputDigest, provider: 'recovery', model: 'recovery',
              policyVersion: this.#policy.policyVersion, outcome: 'OUTCOME_UNKNOWN', failureCode: 'GENERATION_OUTCOME_UNKNOWN',
            }]
          : intent.stageCalls.map(item => item.callId === callId ? {
              ...item, outcome: 'OUTCOME_UNKNOWN', failureCode: 'GENERATION_OUTCOME_UNKNOWN',
            } : item),
        updatedAt: recordedAt,
      })
    })
  }

  async #commitResult(
    intentId: string,
    output: z.infer<typeof generationOutputSchema>,
    exactSkillBytes: string,
  ): Promise<void> {
    const intent = ExperienceIntentV2Schema.parse(this.#intents.get(intentId))
    if (intent.generation.state !== 'GENERATION_CALL_TERMINAL') return
    const call = intent.stageCalls.find(item => (
      item.stage === 'GENERATION' && item.intentRevision === intent.generation.generationRevision
    ))
    if (call?.outcome !== 'SUCCEEDED') return
    const inputEpoch = intent.generation.catalogEpoch!
    const outcomeEpoch = inputEpoch + 1
    const resultId = deriveGenerationResultIdV2({
      leaseId: intent.generation.leaseId!, intentId, generationRevision: intent.generation.generationRevision!,
      callId: call.callId, action: intent.generation.action!, skillBytesDigest: sha256Utf8(exactSkillBytes),
      inputDigest: intent.generation.inputDigest!,
    })
    const mutationId = deriveProposalCatalogMutationIdV2({ ownerId: resultId, kind: 'GENERATION_RESULT', inputCatalogEpoch: inputEpoch })
    const mutationReceiptDigest = deriveProposalCatalogMutationReceiptDigestV2({
      mutationId, ownerId: resultId, kind: 'GENERATION_RESULT', outcomeCatalogEpoch: outcomeEpoch,
    })
    const sealedAt = this.#isoNow()
    const receiptDigest = deriveGenerationResultReceiptDigestV2({ resultId, mutationReceiptDigest, outcomeCatalogEpoch: outcomeEpoch, sealedAt })
    const sealedResult = {
      resultId,
      leaseId: intent.generation.leaseId!,
      intentId,
      generationRevision: intent.generation.generationRevision!,
      callId: call.callId,
      action: intent.generation.action!,
      body: {
        name: output.name,
        description: output.description,
        whenToUse: output.whenToUse,
        exactSkillBytes,
        skillBytesDigest: sha256Utf8(exactSkillBytes),
      },
      targetDigest: intent.coverage.targetDigest!,
      inputDigest: intent.generation.inputDigest!,
      runtimeCatalogDigest: intent.recall.runtimeCatalogDigest!,
      pendingCatalogDigest: intent.recall.pendingCatalogDigest!,
      externalPendingDigest: intent.generation.externalPendingDigest!,
      inputCatalogEpoch: inputEpoch,
      outcomeCatalogEpoch: outcomeEpoch,
      sealedAt,
      mutationReceiptDigest,
      receiptDigest,
    }
    if (!await this.#prepareMutation(intent, mutationId, resultId, 'GENERATION_RESULT')) return
    let committed = false
    await this.#intents.update(intentId, current => {
      const parsed = ExperienceIntentV2Schema.parse(current)
      if (parsed.generation.state !== 'GENERATION_CALL_TERMINAL') return parsed
      committed = true
      return ExperienceIntentV2Schema.parse({
        ...parsed,
        revision: parsed.revision + 1,
        generation: {
          ...parsed.generation,
          state: 'RESULT_COMMITTED',
          resultDigest: receiptDigest,
          sealedResult,
          receipts: [...parsed.generation.receipts, {
            kind: 'RESULT_SEALED', digest: mutationReceiptDigest, leaseId: parsed.generation.leaseId!,
            intentId, generationRevision: parsed.generation.generationRevision!, callId: call.callId,
            catalogEpoch: outcomeEpoch, recordedAt: sealedAt,
          }],
        },
        updatedAt: sealedAt,
      })
    })
    if (committed) await this.#finalizeResult(ExperienceIntentV2Schema.parse(this.#intents.get(intentId)))
  }

  async #commitBarrier(intentId: string, kind: FailureKind): Promise<void> {
    const intent = ExperienceIntentV2Schema.parse(this.#intents.get(intentId))
    if (intent.generation.state !== 'GENERATION_CALL_TERMINAL') return
    const call = intent.stageCalls.find(item => (
      item.stage === 'GENERATION' && item.intentRevision === intent.generation.generationRevision
    ))
    if (call === undefined || call.outcome === 'RESERVED') return
    const inputEpoch = intent.generation.catalogEpoch!
    const outcomeEpoch = inputEpoch + 1
    const barrierId = deriveGenerationBarrierIdV2({
      leaseId: intent.generation.leaseId!, intentId, generationRevision: intent.generation.generationRevision!,
      kind, inputDigest: intent.generation.inputDigest!, callId: call.callId,
    })
    const mutationId = deriveProposalCatalogMutationIdV2({ ownerId: barrierId, kind: 'BARRIER', inputCatalogEpoch: inputEpoch })
    const mutationReceiptDigest = deriveProposalCatalogMutationReceiptDigestV2({
      mutationId, ownerId: barrierId, kind: 'BARRIER', outcomeCatalogEpoch: outcomeEpoch,
    })
    const recordedAt = this.#isoNow()
    const receiptDigest = deriveGenerationBarrierReceiptDigestV2({ barrierId, mutationReceiptDigest, outcomeCatalogEpoch: outcomeEpoch, recordedAt })
    const barrier = {
      barrierId,
      leaseId: intent.generation.leaseId!,
      intentId,
      generationRevision: intent.generation.generationRevision!,
      kind,
      behaviorSignature: intent.behaviorSignature,
      inputDigest: intent.generation.inputDigest!,
      callId: call.callId,
      inputCatalogEpoch: inputEpoch,
      outcomeCatalogEpoch: outcomeEpoch,
      mutationReceiptDigest,
      recordedAt,
      receiptDigest,
    }
    if (!await this.#prepareMutation(intent, mutationId, barrierId, 'BARRIER')) return
    let committed = false
    await this.#intents.update(intentId, current => {
      const parsed = ExperienceIntentV2Schema.parse(current)
      if (parsed.generation.state !== 'GENERATION_CALL_TERMINAL') return parsed
      committed = true
      return ExperienceIntentV2Schema.parse({
        ...parsed,
        revision: parsed.revision + 1,
        status: 'NEEDS_ATTENTION',
        generation: {
          ...parsed.generation,
          state: 'NEEDS_ATTENTION',
          reasonCode: ({
            KNOWN_FAILED: 'GENERATION_KNOWN_FAILED',
            RESULT_LOST: 'GENERATION_RESULT_LOST',
            OUTCOME_UNKNOWN: 'GENERATION_OUTCOME_UNKNOWN',
          } as const)[kind],
          receipts: [...parsed.generation.receipts, {
            kind: 'BARRIER_COMMITTED', digest: mutationReceiptDigest, leaseId: parsed.generation.leaseId!,
            intentId, generationRevision: parsed.generation.generationRevision!, callId: call.callId,
            catalogEpoch: outcomeEpoch, recordedAt,
          }],
        },
        duplicateBarrier: barrier,
        updatedAt: recordedAt,
      })
    })
    if (committed) await this.#finalizeBarrier(ExperienceIntentV2Schema.parse(this.#intents.get(intentId)))
  }

  async #prepareMutation(
    intent: ExperienceIntentV2,
    mutationId: string,
    ownerId: string,
    kind: 'GENERATION_RESULT' | 'BARRIER',
  ): Promise<boolean> {
    return this.#global.runExclusive(async current => {
      const lease = current.proposalGenerationLease
      if (
        lease === undefined
        || lease.leaseId !== intent.generation.leaseId
        || lease.state !== 'CALL_RESERVED'
        || lease.callId !== intent.stageCalls.find(call => (
          call.stage === 'GENERATION' && call.intentRevision === intent.generation.generationRevision
        ))?.callId
        || current.proposalCatalogEpoch !== intent.generation.catalogEpoch
        || current.proposalCatalogMutationJournal !== undefined
      ) return { value: false }
      return {
        value: true,
        global: {
          ...current,
          proposalCatalogMutationJournal: {
            schemaVersion: 1, mutationId, ownerId, kind, phase: 'PREPARED', preparedAt: this.#isoNow(),
          },
        },
      }
    })
  }

  async #finalizeResult(intent: ExperienceIntentV2): Promise<void> {
    const result = intent.generation.sealedResult
    if (result === undefined) return
    await this.#global.runExclusive(async current => {
      const lease = current.proposalGenerationLease
      const journal = current.proposalCatalogMutationJournal
      const expectedMutationId = deriveProposalCatalogMutationIdV2({
        ownerId: result.resultId, kind: 'GENERATION_RESULT', inputCatalogEpoch: result.inputCatalogEpoch,
      })
      if (
        lease?.leaseId !== result.leaseId
        || lease.callId !== result.callId
        || current.proposalCatalogEpoch !== result.inputCatalogEpoch
        || journal?.mutationId !== expectedMutationId
        || journal.ownerId !== result.resultId
        || journal.kind !== 'GENERATION_RESULT'
      ) {
        return { value: undefined }
      }
      const terminalReceipt = intent.generation.receipts.find(item => item.kind === 'CALL_TERMINAL')
      return {
        value: undefined,
        global: {
          ...current,
          proposalCatalogEpoch: result.outcomeCatalogEpoch,
          proposalCatalogMutationJournal: undefined,
          proposalGenerationLease: {
            ...lease,
            callId: result.callId,
            callOutcomeReceiptDigest: terminalReceipt!.digest,
            sealedResultReceiptDigest: result.receiptDigest,
            state: 'RESULT_COMMITTED',
          },
        },
      }
    })
  }

  async #finalizeBarrier(intent: ExperienceIntentV2): Promise<void> {
    const barrier = intent.duplicateBarrier
    if (barrier === undefined) return
    await this.#global.runExclusive(async current => {
      const journal = current.proposalCatalogMutationJournal
      const expectedMutationId = deriveProposalCatalogMutationIdV2({
        ownerId: barrier.barrierId, kind: 'BARRIER', inputCatalogEpoch: barrier.inputCatalogEpoch,
      })
      if (
        current.proposalGenerationLease?.leaseId !== barrier.leaseId
        || current.proposalCatalogEpoch !== barrier.inputCatalogEpoch
        || journal?.mutationId !== expectedMutationId
        || journal.ownerId !== barrier.barrierId
        || journal.kind !== 'BARRIER'
      ) return { value: undefined }
      const { proposalGenerationLease: _lease, proposalCatalogMutationJournal: _journal, ...rest } = current
      return { value: undefined, global: { ...rest, proposalCatalogEpoch: barrier.outcomeCatalogEpoch } }
    })
  }

  async #abandonPreparedMutation(intent: ExperienceIntentV2): Promise<void> {
    const call = intent.stageCalls.find(item => (
      item.stage === 'GENERATION' && item.intentRevision === intent.generation.generationRevision
    ))
    const expectedKind = call?.outcome === 'SUCCEEDED' ? 'GENERATION_RESULT' : 'BARRIER'
    await this.#global.runExclusive(async current => {
      const journal = current.proposalCatalogMutationJournal
      if (
        current.proposalGenerationLease?.leaseId !== intent.generation.leaseId
        || journal === undefined
        || journal.kind !== expectedKind
        || intent.generation.sealedResult !== undefined
        || intent.duplicateBarrier !== undefined
      ) return { value: undefined }
      const { proposalCatalogMutationJournal: _journal, ...rest } = current
      return { value: undefined, global: rest }
    })
  }

  async #releasePreCall(intentId: string, reasonCode: string): Promise<void> {
    const value = this.#intents.get(intentId)
    if (value === undefined) return
    const intent = ExperienceIntentV2Schema.parse(value)
    const leaseId = intent.generation.leaseId
    const released = await this.#global.runExclusive(async current => {
      if (leaseId === undefined || current.proposalGenerationLease?.leaseId !== leaseId) return { value: false }
      if (current.proposalGenerationLease.state !== 'NOT_CALLED') return { value: false }
      const key = deriveBehaviorSignatureIndexKeyV2(intent.persistenceScope, intent.behaviorSignature)
      const { [key]: indexed, ...remainingIndex } = current.behaviorSignatureIndex
      const { proposalGenerationLease: _lease, ...rest } = current
      return {
        value: true,
        global: {
          ...rest,
          behaviorSignatureIndex: indexed?.ownerIntentId === intentId ? remainingIndex : current.behaviorSignatureIndex,
        },
      }
    })
    if (released) await this.#resetPreCallIntent(intentId, reasonCode)
  }

  async #resetPreCallIntent(intentId: string, reasonCode: string): Promise<void> {
    await this.#intents.update(intentId, current => {
      const parsed = ExperienceIntentV2Schema.parse(current)
      if (!['GENERATION_LEASED', 'GENERATION_AUTHORIZED'].includes(parsed.generation.state)) return parsed
      const generationRevision = parsed.generation.generationRevision
      return ExperienceIntentV2Schema.parse({
        ...parsed,
        revision: parsed.revision + 1,
        status: 'NEEDS_ATTENTION',
        coverage: { ...parsed.coverage, state: 'NEEDS_ATTENTION', reasonCode },
        generation: {
          state: 'NOT_STARTED', userRetryUsed: parsed.generation.userRetryUsed,
          staleRefreshUsed: parsed.generation.staleRefreshUsed, receipts: [],
        },
        stageCalls: generationRevision === undefined
          ? parsed.stageCalls
          : parsed.stageCalls.filter(call => call.stage !== 'GENERATION' || call.intentRevision !== generationRevision),
        updatedAt: this.#isoNow(),
      })
    })
  }

  async #recoverStrandedPreCallIntents(): Promise<void> {
    for (const [, value] of this.#intents.entries()) {
      const intent = ExperienceIntentV2Schema.parse(value)
      if (intent.generation.state === 'GENERATION_LEASED') {
        await this.#global.runExclusive(async current => ({
          value: undefined,
          global: {
            ...current,
            behaviorSignatureIndex: Object.fromEntries(Object.entries(current.behaviorSignatureIndex).filter(([, entry]) => (
              entry.ownerIntentId !== intent.intentId || entry.state !== 'RESERVED'
            ))),
          },
        }))
        await this.#resetPreCallIntent(intent.intentId, 'GENERATION_LEASE_LOST')
      }
    }
  }

  async #releaseOrphanNotCalled(lease: ProposalGenerationLease, intent?: ExperienceIntentV2): Promise<void> {
    await this.#global.runExclusive(async current => {
      if (
        current.proposalGenerationLease?.leaseId !== lease.leaseId
        || current.proposalGenerationLease.state !== 'NOT_CALLED'
      ) {
        return { value: undefined }
      }
      const behaviorSignatureIndex = Object.fromEntries(Object.entries(current.behaviorSignatureIndex).filter(([, entry]) => (
        entry.ownerIntentId !== lease.ownerIntentId || entry.state !== 'RESERVED'
      )))
      const { proposalGenerationLease: _lease, ...rest } = current
      return { value: undefined, global: { ...rest, behaviorSignatureIndex } }
    })
    if (intent?.generation.state === 'GENERATION_LEASED') {
      await this.#resetPreCallIntent(intent.intentId, 'GENERATION_LEASE_LOST')
    }
  }

  async #preCallAttention(intentId: string, reasonCode: string): Promise<void> {
    await this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (!['CREATE_AUTHORIZED', 'MERGE_AUTHORIZED'].includes(intent.status)) return intent
      return ExperienceIntentV2Schema.parse({
        ...intent,
        revision: intent.revision + 1,
        status: 'NEEDS_ATTENTION',
        coverage: { ...intent.coverage, state: 'NEEDS_ATTENTION', reasonCode },
        generation: { state: 'NOT_STARTED', userRetryUsed: intent.generation.userRetryUsed, staleRefreshUsed: intent.generation.staleRefreshUsed, receipts: [] },
        updatedAt: this.#isoNow(),
      })
    })
  }

  #receipt(
    kind: 'LEASE_ACQUIRED' | 'CALL_RESERVED' | 'CALL_TERMINAL',
    intent: ExperienceIntentV2,
    leaseId: string,
    recordedAt: string,
    callId?: string,
    catalogEpoch?: number,
  ) {
    const facts = {
      kind,
      leaseId,
      intentId: intent.intentId,
      generationRevision: intent.generation.generationRevision!,
      ...(callId === undefined ? {} : { callId }),
      ...(catalogEpoch === undefined ? {} : { catalogEpoch }),
      recordedAt,
    }
    return { ...facts, digest: deriveGenerationReceiptDigestV2(facts) }
  }

  #isoNow(): string {
    return new Date(this.#now()).toISOString()
  }
}
