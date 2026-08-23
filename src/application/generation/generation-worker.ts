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
  deriveNativeProposalLineageIdV2,
  deriveProposalCatalogMutationIdV2,
  deriveProposalCatalogMutationAnchorV2,
  deriveProposalCatalogMutationReceiptDigestV2,
  ExperienceIntentV2Schema,
  ProposalLineageV2Schema,
  SessionBatchV2Schema,
  TurnObservationV2Schema,
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

function deriveNativeProposalId(input: {
  readonly lineageId: string
  readonly generationResultReceiptDigest: string
  readonly proposalRevision: number
}): `prop_${string}` {
  return `prop_${sha256Utf8(canonicalJson(input))}`
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
  snapshot(input: {
    readonly batch: SessionBatchV2
    readonly intent: ExperienceIntentV2
    readonly exclude?: {
      readonly kind: 'GENERATION_RESULT'
      readonly resultId: string
      readonly receiptDigest: string
    } | undefined
  }): Promise<GenerationCatalogSnapshot>
  read(input: {
    readonly candidateId: string
    readonly batch: SessionBatchV2
    readonly intent: ExperienceIntentV2
  }): Promise<RecallCatalogDefinition | undefined>
}

export interface GenerationQuiescencePort {
  validate(intentId: string): Promise<'VALID' | 'STALE' | 'INCOMPLETE'>
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
  readonly quiescence: GenerationQuiescencePort
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
interface ProposalMutationFacts {
  readonly result: NonNullable<ExperienceIntentV2['generation']['sealedResult']>
  readonly revalidation: NonNullable<ExperienceIntentV2['generation']['revalidationAuthorization']>
  readonly proposalId: string
  readonly lineageId: string
  readonly outcomeCatalogEpoch: number
  readonly mutationId: string
  readonly mutationReceiptDigest: string
}

export class GenerationWorker {
  readonly #global: Run2skillV2GlobalStore
  readonly #intents
  readonly #batches
  readonly #lineages
  readonly #observations
  readonly #catalog: GenerationCatalogPort
  readonly #quiescence: GenerationQuiescencePort
  readonly #generator: SkillGenerator
  readonly #policy: GenerationPolicy
  readonly #now: () => number

  constructor(domain: Run2skillV2Domain, options: GenerationWorkerOptions) {
    this.#global = Run2skillV2GlobalStore.for(domain)
    this.#intents = domain.table('experience_intents')
    this.#batches = domain.table('session_batches')
    this.#lineages = domain.table('proposal_lineages')
    this.#observations = domain.table('turn_observations')
    this.#catalog = options.catalog
    this.#quiescence = options.quiescence
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
    const currentLease = this.#global.get().proposalGenerationLease
    if (currentLease !== undefined && [
      'RESULT_COMMITTED', 'PROPOSAL_COMMIT_AUTHORIZED', 'BODY_COMMITTED_INDEX_PENDING', 'ACTIVE_COMPLETE',
    ].includes(currentLease.state)) {
      // A PREPARED Proposal journal is either being committed by the current worker or recovered
      // explicitly at startup. A second live worker must not mistake it for an abandoned crash.
      if (this.#global.get().proposalCatalogMutationJournal?.kind === 'PROPOSAL') return 'PROCESSED'
      await this.#continueProposalCommit(currentLease)
      return 'PROCESSED'
    }
    const currentLeaseOwner = currentLease?.ownerIntentId
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
    let baseSkillBytesDigest: string | undefined
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
      if (
        target === undefined
        || target.skillBytesDigest === undefined
        || target.skillBytesDigest !== sha256Utf8(target.content)
        || sha256Utf8(target.content) !== leased.coverage.targetDigest
      ) {
        await this.#releasePreCall(leased.intentId, 'GENERATION_TARGET_CHANGED')
        return 'PROCESSED'
      }
      const processed = preprocessPersistentText(target.content)
      if (processed.redactionKinds.length > 0 || hasFormatControls(target.content)) {
        await this.#releasePreCall(leased.intentId, 'GENERATION_TARGET_CHANGED')
        return 'PROCESSED'
      }
      baseSkill = processed.text
      baseSkillBytesDigest = sha256Utf8(baseSkill)
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
    const preCallFence = await this.#validateQuiescence(leased.intentId)
    if (preCallFence !== 'VALID') {
      await this.#releasePreCall(leased.intentId, `SESSION_QUIESCENCE_${preCallFence}`)
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
    await this.#commitResult(leased.intentId, parsed.data, exactSkillBytes, baseSkill, baseSkillBytesDigest)
    if (await this.#validateQuiescence(leased.intentId) !== 'VALID') {
      await this.#markStaleResult(leased.intentId, leased.generation.leaseId!)
    }
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
    if ([
      'RESULT_COMMITTED', 'PROPOSAL_COMMIT_AUTHORIZED', 'BODY_COMMITTED_INDEX_PENDING', 'ACTIVE_COMPLETE',
    ].includes(lease.state)) {
      await this.#continueProposalCommit(lease)
      return
    }

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

  async #safePostResultSnapshot(
    batch: SessionBatchV2,
    intent: ExperienceIntentV2,
  ): Promise<GenerationCatalogSnapshot | undefined> {
    const result = intent.generation.sealedResult
    if (result === undefined) return undefined
    try {
      return await this.#catalog.snapshot({
        batch,
        intent,
        exclude: { kind: 'GENERATION_RESULT', resultId: result.resultId, receiptDigest: result.receiptDigest },
      })
    } catch {
      return undefined
    }
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
    baseSkillBytes: string | undefined,
    baseSkillBytesDigest: string | undefined,
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
      ...(baseSkillBytes === undefined ? {} : { baseSkillBytes }),
      ...(baseSkillBytesDigest === undefined ? {} : { baseSkillBytesDigest }),
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
      const { duplicateBarrier: _barrier, ...stable } = parsed
      return ExperienceIntentV2Schema.parse({
        ...stable,
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
          proposalCatalogLastMutation: deriveProposalCatalogMutationAnchorV2({
            ownerId: result.resultId,
            kind: 'GENERATION_RESULT',
            inputCatalogEpoch: result.inputCatalogEpoch,
          }),
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
      return {
        value: undefined,
        global: {
          ...rest,
          proposalCatalogEpoch: barrier.outcomeCatalogEpoch,
          proposalCatalogLastMutation: deriveProposalCatalogMutationAnchorV2({
            ownerId: barrier.barrierId,
            kind: 'BARRIER',
            inputCatalogEpoch: barrier.inputCatalogEpoch,
          }),
        },
      }
    })
  }

  async #continueProposalCommit(initialLease: ProposalGenerationLease): Promise<void> {
    let value = this.#intents.get(initialLease.ownerIntentId)
    if (value === undefined) return
    let intent = ExperienceIntentV2Schema.parse(value)
    if (intent.generation.leaseId !== initialLease.leaseId || intent.generation.sealedResult === undefined) return
    if (intent.generation.state === 'NEEDS_ATTENTION' && intent.generation.reasonCode === 'STALE_RESULT') {
      await this.#markStaleResult(intent.intentId, initialLease.leaseId)
      return
    }

    const currentGlobal = this.#global.get()
    if (currentGlobal.proposalCatalogMutationJournal?.kind === 'PROPOSAL') {
      await this.#recoverPreparedProposal(intent, currentGlobal.proposalCatalogMutationJournal.mutationId)
    }

    value = this.#intents.get(initialLease.ownerIntentId)
    if (value === undefined) return
    intent = ExperienceIntentV2Schema.parse(value)
    let lease = this.#global.get().proposalGenerationLease
    if (lease === undefined || lease.leaseId !== initialLease.leaseId) return
    if (
      intent.generation.state === 'PROPOSAL_BODY_COMMITTED'
      && lease.state === 'PROPOSAL_COMMIT_AUTHORIZED'
      && this.#global.get().proposalCatalogMutationJournal === undefined
    ) {
      const facts = this.#proposalMutationFacts(intent)
      const expected = this.#buildProposalLineage(intent, intent.revision - 1)
      if (facts !== undefined && expected !== undefined) {
        await this.#rollbackPreparedProposal(intent, expected, facts.mutationId)
      } else {
        await this.#markStaleResult(intent.intentId, lease.leaseId)
      }
      return
    }

    if (['RESULT_COMMITTED', 'PROPOSAL_COMMIT_AUTHORIZED'].includes(lease.state)) {
      if (await this.#validateQuiescence(intent.intentId) !== 'VALID') {
        await this.#markStaleResult(intent.intentId, lease.leaseId)
        return
      }
      const batchValue = this.#batches.get(intent.batchId)
      const batch = batchValue === undefined ? undefined : SessionBatchV2Schema.safeParse(batchValue)
      const snapshot = batch?.success ? await this.#revalidateResult(batch.data, intent, lease) : undefined
      if (snapshot === undefined) {
        await this.#markStaleResult(intent.intentId, lease.leaseId)
        return
      }
      if (!await this.#authorizeProposal(intent.intentId, lease.leaseId, snapshot)) return
    }

    await this.#commitProposalBody(initialLease.ownerIntentId, initialLease.leaseId)
    await this.#activateProposal(initialLease.ownerIntentId, initialLease.leaseId)
    await this.#releaseCompletedProposal(initialLease.ownerIntentId, initialLease.leaseId)
  }

  async #revalidateResult(
    batch: SessionBatchV2,
    intent: ExperienceIntentV2,
    lease: ProposalGenerationLease,
  ): Promise<GenerationCatalogSnapshot | undefined> {
    const result = intent.generation.sealedResult
    if (result === undefined || lease.sealedResultReceiptDigest !== result.receiptDigest) return undefined
    const snapshot = await this.#safePostResultSnapshot(batch, intent)
    if (
      snapshot === undefined
      || !snapshot.complete
      || snapshot.runtimeCatalogDigest !== result.runtimeCatalogDigest
      || snapshot.pendingCatalogDigest === result.pendingCatalogDigest
      || snapshot.externalPendingDigest !== result.externalPendingDigest
      || snapshot.catalogEpoch !== result.outcomeCatalogEpoch
      || snapshot.catalogMutationReceiptDigest !== result.mutationReceiptDigest
    ) return undefined
    const global = this.#global.get()
    if (
      global.proposalGenerationLease?.leaseId !== lease.leaseId
      || !['RESULT_COMMITTED', 'PROPOSAL_COMMIT_AUTHORIZED'].includes(global.proposalGenerationLease.state)
      || global.proposalCatalogEpoch !== snapshot.catalogEpoch
      || global.proposalCatalogMutationJournal !== undefined
      || global.purgeJournal !== undefined
    ) return undefined
    if (intent.generation.revalidationAuthorization !== undefined) {
      const prior = intent.generation.revalidationAuthorization
      if (
        prior.runtimeCatalogDigest !== snapshot.runtimeCatalogDigest
        || prior.pendingCatalogDigest !== snapshot.pendingCatalogDigest
        || prior.externalPendingDigest !== snapshot.externalPendingDigest
        || prior.catalogEpoch !== snapshot.catalogEpoch
        || prior.catalogMutationReceiptDigest !== snapshot.catalogMutationReceiptDigest
      ) return undefined
    }
    if (result.action === 'MERGE') {
      const candidateId = intent.coverage.targetCandidateId
      if (candidateId === undefined) return undefined
      try {
        const target = await this.#catalog.read({ candidateId, batch, intent })
        if (
          target === undefined
          || sha256Utf8(target.content) !== result.targetDigest
          || result.baseSkillBytes === undefined
          || target.content !== result.baseSkillBytes
          || sha256Utf8(target.content) !== result.baseSkillBytesDigest
        ) return undefined
      } catch {
        return undefined
      }
      const afterRead = await this.#safePostResultSnapshot(batch, intent)
      if (afterRead === undefined || canonicalJson(afterRead) !== canonicalJson(snapshot)) return undefined
    }
    return snapshot
  }

  async #authorizeProposal(
    intentId: string,
    leaseId: string,
    snapshot: GenerationCatalogSnapshot,
  ): Promise<boolean> {
    let authorizationDigest: string | undefined
    let authorized = false
    await this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (intent.generation.leaseId !== leaseId || intent.generation.sealedResult === undefined) return intent
      if (intent.generation.state === 'PROPOSAL_COMMIT_AUTHORIZED') {
        authorizationDigest = intent.generation.receipts.find(item => item.kind === 'PROPOSAL_AUTHORIZED')?.digest
        authorized = authorizationDigest !== undefined
        return intent
      }
      if (intent.generation.state !== 'RESULT_COMMITTED') return intent
      const result = intent.generation.sealedResult
      const recordedAt = this.#isoNow()
      const receipt = this.#receipt(
        'PROPOSAL_AUTHORIZED', intent, leaseId, recordedAt, undefined, result.outcomeCatalogEpoch,
      )
      const lineageId = deriveNativeProposalLineageIdV2(intent.persistenceScope, intent.behaviorSignature)
      const existing = ProposalLineageV2Schema.safeParse(this.#lineages.get(lineageId))
      const proposalRevision = existing.success
        && existing.data.origin === 'RUN2SKILL_V2'
        && existing.data.state === 'REFRESHING'
        ? existing.data.currentProposalRevision + 1
        : 1
      const proposalId = deriveNativeProposalId({
        lineageId,
        generationResultReceiptDigest: result.receiptDigest,
        proposalRevision,
      })
      authorizationDigest = receipt.digest
      authorized = true
      return ExperienceIntentV2Schema.parse({
        ...intent,
        revision: intent.revision + 1,
        generation: {
          ...intent.generation,
          state: 'PROPOSAL_COMMIT_AUTHORIZED',
          proposalId,
          revalidationAuthorization: {
            runtimeCatalogDigest: result.runtimeCatalogDigest,
            pendingCatalogDigest: snapshot.pendingCatalogDigest,
            externalPendingDigest: result.externalPendingDigest,
            catalogEpoch: result.outcomeCatalogEpoch,
            catalogMutationReceiptDigest: result.mutationReceiptDigest,
            sealedResultReceiptDigest: result.receiptDigest,
            ...(intent.generation.selfExclusionDigest === undefined
              ? {}
              : { selfExclusionDigest: intent.generation.selfExclusionDigest }),
            authorizedAt: recordedAt,
          },
          receipts: [...intent.generation.receipts, receipt],
        },
        updatedAt: recordedAt,
      })
    })
    if (!authorized || authorizationDigest === undefined) return false
    return this.#global.runExclusive(async current => {
      const lease = current.proposalGenerationLease
      if (
        lease?.leaseId !== leaseId
        || !['RESULT_COMMITTED', 'PROPOSAL_COMMIT_AUTHORIZED'].includes(lease.state)
        || current.proposalCatalogMutationJournal !== undefined
        || current.purgeJournal !== undefined
      ) return { value: false }
      return {
        value: true,
        global: {
          ...current,
          proposalGenerationLease: {
            ...lease,
            proposalAuthorizationReceiptDigest: authorizationDigest,
            state: 'PROPOSAL_COMMIT_AUTHORIZED',
          },
        },
      }
    })
  }

  #proposalMutationFacts(intent: ExperienceIntentV2): ProposalMutationFacts | undefined {
    const result = intent.generation.sealedResult
    const revalidation = intent.generation.revalidationAuthorization
    const proposalId = intent.generation.proposalId
    if (result === undefined || revalidation === undefined || proposalId === undefined) return undefined
    const lineageId = deriveNativeProposalLineageIdV2(intent.persistenceScope, intent.behaviorSignature)
    const outcomeCatalogEpoch = revalidation.catalogEpoch + 1
    const mutationId = deriveProposalCatalogMutationIdV2({
      ownerId: proposalId,
      kind: 'PROPOSAL',
      inputCatalogEpoch: revalidation.catalogEpoch,
    })
    const mutationReceiptDigest = deriveProposalCatalogMutationReceiptDigestV2({
      mutationId,
      ownerId: proposalId,
      kind: 'PROPOSAL',
      outcomeCatalogEpoch,
    })
    return { result, revalidation, proposalId, lineageId, outcomeCatalogEpoch, mutationId, mutationReceiptDigest }
  }

  #buildProposalLineage(intent: ExperienceIntentV2, ownerIntentRevision = intent.revision) {
    const facts = this.#proposalMutationFacts(intent)
    if (facts === undefined) return undefined
    const projectScopeBinding = this.#projectScopeBinding(intent)
    if (intent.persistenceScope === 'PROJECT' && projectScopeBinding === undefined) return undefined
    const stored = ProposalLineageV2Schema.safeParse(this.#lineages.get(facts.lineageId))
    const prior = stored.success && stored.data.origin === 'RUN2SKILL_V2' ? stored.data : undefined
    if (prior !== undefined && (
      !['REFRESHING', 'ACTIVE_PROPOSAL'].includes(prior.state)
      || (prior.state === 'REFRESHING' && !intent.generation.staleRefreshUsed)
      || prior.ownerIntentId !== intent.intentId
      || prior.persistenceScope !== intent.persistenceScope
      || prior.behaviorSignature !== intent.behaviorSignature
    )) return undefined
    const proposalRevision = prior?.state === 'ACTIVE_PROPOSAL'
      ? prior.currentProposalRevision
      : (prior?.currentProposalRevision ?? 0) + 1
    const proposal = {
      revision: proposalRevision,
      proposalId: facts.proposalId,
      ownerIntentId: intent.intentId,
      ownerIntentRevision,
      action: facts.result.action,
      body: facts.result.body,
      runtimeCatalogDigest: facts.revalidation.runtimeCatalogDigest,
      pendingCatalogDigest: facts.revalidation.pendingCatalogDigest,
      generationResultReceiptDigest: facts.result.receiptDigest,
      catalogMutationReceiptDigest: facts.mutationReceiptDigest,
      catalogEpoch: facts.outcomeCatalogEpoch,
      targetIdentityDigest: facts.result.targetDigest,
      ...(facts.result.baseSkillBytes === undefined
        ? {}
        : { baseSkillBytes: facts.result.baseSkillBytes }),
      ...(facts.result.baseSkillBytesDigest === undefined
        ? {}
        : { baseSkillBytesDigest: facts.result.baseSkillBytesDigest }),
      ...(projectScopeBinding === undefined ? {} : { projectScopeBinding }),
      state: 'ACTIVE_PROPOSAL' as const,
      createdAt: facts.revalidation.authorizedAt,
    }
    if (prior?.state === 'ACTIVE_PROPOSAL') {
      return canonicalJson(prior.proposalRevisions.at(-1)) === canonicalJson(proposal)
        && prior.ownerIntentId === intent.intentId
        && prior.ownerIntentRevision === ownerIntentRevision
        && prior.currentProposalRevision === proposalRevision
        ? prior
        : undefined
    }
    return ProposalLineageV2Schema.parse({
      schemaVersion: 1,
      revision: (prior?.revision ?? 0) + 1,
      lineageId: facts.lineageId,
      persistenceScope: intent.persistenceScope,
      origin: 'RUN2SKILL_V2',
      state: 'ACTIVE_PROPOSAL',
      behaviorSignature: intent.behaviorSignature,
      ownerIntentId: intent.intentId,
      ownerIntentRevision,
      currentProposalRevision: proposalRevision,
      proposalRevisions: [...(prior?.proposalRevisions ?? []), proposal],
      createdAt: prior?.createdAt ?? facts.revalidation.authorizedAt,
      updatedAt: facts.revalidation.authorizedAt,
    })
  }

  #projectScopeBinding(intent: ExperienceIntentV2): {
    readonly workspaceId: string
    readonly scopeIdentityDigest: string
  } | undefined {
    if (intent.persistenceScope !== 'PROJECT') return undefined
    const bindings = intent.evidenceRefs.map(reference => {
      const parsed = TurnObservationV2Schema.safeParse(this.#observations.get(reference.observationId))
      if (
        !parsed.success
        || parsed.data.evidenceDigest !== reference.evidenceDigest
        || parsed.data.scopeBinding.status !== 'PROJECT'
      ) return undefined
      return {
        workspaceId: parsed.data.scopeBinding.workspaceId,
        scopeIdentityDigest: parsed.data.scopeBinding.scopeIdentityDigest,
      }
    })
    if (bindings.some(binding => binding === undefined)) return undefined
    const unique = new Map(bindings.map(binding => [canonicalJson(binding), binding!]))
    return unique.size === 1 ? [...unique.values()][0] : undefined
  }

  async #commitProposalBody(intentId: string, leaseId: string): Promise<void> {
    let intent = ExperienceIntentV2Schema.parse(this.#intents.get(intentId))
    if (intent.generation.state !== 'PROPOSAL_COMMIT_AUTHORIZED' || intent.generation.leaseId !== leaseId) return
    const facts = this.#proposalMutationFacts(intent)
    const lineage = this.#buildProposalLineage(intent)
    if (facts === undefined || lineage === undefined) return
    const batchValue = this.#batches.get(intent.batchId)
    const batch = batchValue === undefined ? undefined : SessionBatchV2Schema.safeParse(batchValue)
    if (!batch?.success) {
      await this.#markStaleResult(intentId, leaseId)
      return
    }
    const boundarySnapshot = await this.#safePostResultSnapshot(batch.data, intent)
    if (
      await this.#validateQuiescence(intentId) !== 'VALID'
      || !this.#snapshotMatchesRevalidation(boundarySnapshot, intent, leaseId)
    ) {
      await this.#markStaleResult(intentId, leaseId)
      return
    }
    const prepared = await this.#global.runExclusive(async current => {
      const lease = current.proposalGenerationLease
      const proposalAuthorizationReceipt = intent.generation.receipts.find(receipt => receipt.kind === 'PROPOSAL_AUTHORIZED')
      if (
        lease?.leaseId !== leaseId
        || lease.state !== 'PROPOSAL_COMMIT_AUTHORIZED'
        || lease.proposalAuthorizationReceiptDigest !== proposalAuthorizationReceipt?.digest
        || current.proposalCatalogEpoch !== facts.revalidation.catalogEpoch
        || current.proposalCatalogMutationJournal !== undefined
        || current.purgeJournal !== undefined
      ) return { value: false }
      return {
        value: true,
        global: {
          ...current,
          proposalCatalogMutationJournal: {
            schemaVersion: 1,
            mutationId: facts.mutationId,
            ownerId: facts.proposalId,
            kind: 'PROPOSAL',
            phase: 'PREPARED',
            preparedAt: this.#isoNow(),
          },
        },
      }
    })
    if (!prepared) return
    await this.#commitPreparedProposal(intent, lineage, facts)
  }

  #snapshotMatchesRevalidation(
    snapshot: GenerationCatalogSnapshot | undefined,
    intent: ExperienceIntentV2,
    leaseId: string,
  ): boolean {
    const revalidation = intent.generation.revalidationAuthorization
    return snapshot !== undefined
      && revalidation !== undefined
      && snapshot.complete
      && snapshot.runtimeCatalogDigest === revalidation.runtimeCatalogDigest
      && snapshot.pendingCatalogDigest === revalidation.pendingCatalogDigest
      && snapshot.externalPendingDigest === revalidation.externalPendingDigest
      && snapshot.catalogEpoch === revalidation.catalogEpoch
      && snapshot.catalogMutationReceiptDigest === revalidation.catalogMutationReceiptDigest
      && intent.generation.leaseId === leaseId
  }

  async #commitPreparedProposal(
    intent: ExperienceIntentV2,
    expectedLineage: z.infer<typeof ProposalLineageV2Schema>,
    facts: ProposalMutationFacts,
  ): Promise<void> {
    let committed = false
    let replacedLineage: z.infer<typeof ProposalLineageV2Schema> | undefined
    try {
      if (await this.#validateQuiescence(intent.intentId) !== 'VALID') throw new Error('Session quiescence fence is stale')
      const existing = this.#lineages.get(facts.lineageId)
      if (existing === undefined) await this.#lineages.put(facts.lineageId, expectedLineage)
      else {
        const parsed = ProposalLineageV2Schema.safeParse(existing)
        if (
          parsed.success
          && parsed.data.origin === 'RUN2SKILL_V2'
          && parsed.data.state === 'REFRESHING'
          && expectedLineage.origin === 'RUN2SKILL_V2'
          && canonicalJson(parsed.data.proposalRevisions)
            === canonicalJson(expectedLineage.proposalRevisions.slice(0, -1))
          && expectedLineage.revision === parsed.data.revision + 1
        ) {
          replacedLineage = parsed.data
          await this.#lineages.update(facts.lineageId, current => {
            const latest = ProposalLineageV2Schema.parse(current)
            if (canonicalJson(latest) !== canonicalJson(parsed.data)) throw new Error('Proposal lineage changed')
            return expectedLineage
          })
        } else if (!parsed.success || canonicalJson(parsed.data) !== canonicalJson(expectedLineage)) {
          throw new Error('Proposal lineage conflict')
        }
      }
      if (!await this.#markProposalBodyCommitted(intent.intentId, intent.generation.leaseId!, facts)) {
        throw new Error('Proposal body was not committed')
      }
      if (await this.#validateQuiescence(intent.intentId) !== 'VALID') {
        throw new Error('Session quiescence fence changed during Proposal body commit')
      }
      committed = await this.#finalizeProposalBody(
        ExperienceIntentV2Schema.parse(this.#intents.get(intent.intentId)),
        facts,
      )
    } catch {
      committed = false
    }
    if (!committed) {
      if (this.#proposalBodyCommitIsDurable(intent, expectedLineage, facts)) return
      await this.#rollbackPreparedProposal(intent, expectedLineage, facts.mutationId, replacedLineage)
    }
  }

  #proposalBodyCommitIsDurable(
    priorIntent: ExperienceIntentV2,
    expectedLineage: z.infer<typeof ProposalLineageV2Schema>,
    facts: ProposalMutationFacts,
  ): boolean {
    const value = this.#intents.get(priorIntent.intentId)
    if (value === undefined) return false
    const intent = ExperienceIntentV2Schema.safeParse(value)
    const lineage = ProposalLineageV2Schema.safeParse(this.#lineages.get(expectedLineage.lineageId))
    const global = this.#global.get()
    const lease = global.proposalGenerationLease
    return intent.success
      && intent.data.generation.state === 'PROPOSAL_BODY_COMMITTED'
      && intent.data.generation.leaseId === priorIntent.generation.leaseId
      && lineage.success
      && canonicalJson(lineage.data) === canonicalJson(expectedLineage)
      && global.proposalCatalogMutationJournal === undefined
      && global.proposalCatalogEpoch === facts.outcomeCatalogEpoch
      && lease !== undefined
      && lease.leaseId === priorIntent.generation.leaseId
      && lease.state === 'BODY_COMMITTED_INDEX_PENDING'
  }

  async #rollbackPreparedProposal(
    intent: ExperienceIntentV2,
    expectedLineage: z.infer<typeof ProposalLineageV2Schema>,
    mutationId: string,
    replacedLineage?: z.infer<typeof ProposalLineageV2Schema>,
  ): Promise<void> {
    const stored = ProposalLineageV2Schema.safeParse(this.#lineages.get(expectedLineage.lineageId))
    if (stored.success && canonicalJson(stored.data) === canonicalJson(expectedLineage)) {
      if (replacedLineage === undefined) await this.#lineages.delete(expectedLineage.lineageId)
      else await this.#lineages.put(expectedLineage.lineageId, replacedLineage)
    }
    await this.#abandonProposalJournal(mutationId)
    await this.#markStaleResult(intent.intentId, intent.generation.leaseId!)
  }

  async #recoverPreparedProposal(intent: ExperienceIntentV2, mutationId: string): Promise<void> {
    if (!['PROPOSAL_COMMIT_AUTHORIZED', 'PROPOSAL_BODY_COMMITTED'].includes(intent.generation.state)) return
    const facts = this.#proposalMutationFacts(intent)
    if (facts === undefined || facts.mutationId !== mutationId) return
    const existing = this.#lineages.get(facts.lineageId)
    if (existing === undefined) {
      await this.#abandonProposalJournal(mutationId)
      if (intent.generation.state === 'PROPOSAL_BODY_COMMITTED') {
        await this.#markStaleResult(intent.intentId, intent.generation.leaseId!)
      }
      return
    }
    const parsed = ProposalLineageV2Schema.safeParse(existing)
    const expected = this.#buildProposalLineage(
      intent,
      intent.generation.state === 'PROPOSAL_BODY_COMMITTED' ? intent.revision - 1 : intent.revision,
    )
    const exactProposal = parsed.success
      && expected !== undefined
      && canonicalJson(parsed.data) === canonicalJson(expected)
    if (!exactProposal) {
      await this.#abandonProposalJournal(mutationId)
      await this.#markStaleResult(intent.intentId, intent.generation.leaseId!)
      return
    }
    await this.#commitPreparedProposal(intent, expected!, facts)
  }

  async #markProposalBodyCommitted(
    intentId: string,
    leaseId: string,
    facts: ProposalMutationFacts,
  ): Promise<boolean> {
    let committed = false
    await this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (intent.generation.state === 'PROPOSAL_BODY_COMMITTED') {
        committed = true
        return intent
      }
      if (intent.generation.state !== 'PROPOSAL_COMMIT_AUTHORIZED' || intent.generation.leaseId !== leaseId) return intent
      committed = true
      const recordedAt = this.#isoNow()
      return ExperienceIntentV2Schema.parse({
        ...intent,
        revision: intent.revision + 1,
        lineageId: facts.lineageId,
        generation: {
          ...intent.generation,
          state: 'PROPOSAL_BODY_COMMITTED',
          receipts: [...intent.generation.receipts, {
            kind: 'BODY_COMMITTED',
            digest: facts.mutationReceiptDigest,
            leaseId,
            intentId,
            generationRevision: intent.generation.generationRevision!,
            catalogEpoch: facts.outcomeCatalogEpoch,
            recordedAt,
          }],
        },
        updatedAt: recordedAt,
      })
    })
    return committed
  }

  async #finalizeProposalBody(
    intent: ExperienceIntentV2,
    facts: ProposalMutationFacts,
  ): Promise<boolean> {
    if (intent.generation.state !== 'PROPOSAL_BODY_COMMITTED') return false
    return this.#global.runExclusive(async current => {
      const lease = current.proposalGenerationLease
      const journal = current.proposalCatalogMutationJournal
      if (
        lease === undefined
        || lease.leaseId !== intent.generation.leaseId
        || lease.state !== 'PROPOSAL_COMMIT_AUTHORIZED'
        || current.proposalCatalogEpoch !== facts.revalidation.catalogEpoch
        || journal?.mutationId !== facts.mutationId
        || journal.ownerId !== facts.proposalId
        || journal.kind !== 'PROPOSAL'
      ) return { value: false }
      return {
        value: true,
        global: {
          ...current,
          proposalCatalogEpoch: facts.outcomeCatalogEpoch,
          proposalCatalogLastMutation: deriveProposalCatalogMutationAnchorV2({
            ownerId: facts.proposalId,
            kind: 'PROPOSAL',
            inputCatalogEpoch: facts.revalidation.catalogEpoch,
          }),
          proposalCatalogMutationJournal: undefined,
          proposalGenerationLease: { ...lease, state: 'BODY_COMMITTED_INDEX_PENDING' },
        },
      }
    })
  }

  async #activateProposal(intentId: string, leaseId: string): Promise<void> {
    const activationLease = this.#global.get().proposalGenerationLease
    if (
      activationLease?.leaseId !== leaseId
      || !['BODY_COMMITTED_INDEX_PENDING', 'ACTIVE_COMPLETE'].includes(activationLease.state)
    ) return
    let intent = ExperienceIntentV2Schema.parse(this.#intents.get(intentId))
    let indexReceipt = intent.generation.receipts.find(item => item.kind === 'INDEX_COMMITTED')
    if (intent.generation.state === 'PROPOSAL_BODY_COMMITTED') {
      const authorization = intent.generation.revalidationAuthorization
      if (authorization === undefined) return
      const recordedAt = this.#isoNow()
      const receipt = this.#receipt(
        'INDEX_COMMITTED', intent, leaseId, recordedAt, undefined, authorization.catalogEpoch + 1,
      )
      let advanced = false
      await this.#intents.update(intentId, current => {
        const parsed = ExperienceIntentV2Schema.parse(current)
        if (parsed.generation.state !== 'PROPOSAL_BODY_COMMITTED' || parsed.generation.leaseId !== leaseId) return parsed
        advanced = true
        return ExperienceIntentV2Schema.parse({
          ...parsed,
          revision: parsed.revision + 1,
          status: 'PROPOSAL_READY',
          generation: {
            ...parsed.generation,
            state: 'PROPOSAL_READY',
            receipts: [...parsed.generation.receipts, receipt],
          },
          updatedAt: recordedAt,
        })
      })
      if (!advanced) return
      intent = ExperienceIntentV2Schema.parse(this.#intents.get(intentId))
      indexReceipt = receipt
    }
    if (intent.generation.state !== 'PROPOSAL_READY' || indexReceipt === undefined) return
    const lineageId = intent.lineageId
    const proposalId = intent.generation.proposalId
    if (lineageId === undefined || proposalId === undefined) return
    const lineage = ProposalLineageV2Schema.safeParse(this.#lineages.get(lineageId))
    if (
      !lineage.success
      || lineage.data.origin !== 'RUN2SKILL_V2'
      || lineage.data.state !== 'ACTIVE_PROPOSAL'
      || lineage.data.proposalRevisions.at(-1)?.proposalId !== proposalId
    ) return
    const key = deriveBehaviorSignatureIndexKeyV2(intent.persistenceScope, intent.behaviorSignature)
    await this.#global.runExclusive(async current => {
      const lease = current.proposalGenerationLease
      const indexed = current.behaviorSignatureIndex[key]
      if (
        lease?.leaseId !== leaseId
        || !['BODY_COMMITTED_INDEX_PENDING', 'ACTIVE_COMPLETE'].includes(lease.state)
        || current.proposalCatalogMutationJournal !== undefined
        || current.proposalCatalogEpoch !== intent.generation.revalidationAuthorization!.catalogEpoch + 1
        || indexed?.ownerIntentId !== intentId
        || (indexed.state !== 'RESERVED' && indexed.state !== 'ACTIVE')
      ) return { value: undefined }
      return {
        value: undefined,
        global: {
          ...current,
          behaviorSignatureIndex: {
            ...current.behaviorSignatureIndex,
            [key]: {
              ...indexed,
              ownerRevision: intent.revision,
              state: 'ACTIVE',
              updatedAt: indexReceipt!.recordedAt,
            },
          },
          proposalGenerationLease: {
            ...lease,
            completionReceiptDigest: indexReceipt!.digest,
            state: 'ACTIVE_COMPLETE',
          },
        },
      }
    })
  }

  async #releaseCompletedProposal(intentId: string, leaseId: string): Promise<void> {
    const value = this.#intents.get(intentId)
    if (value === undefined) return
    const intent = ExperienceIntentV2Schema.parse(value)
    const completion = intent.generation.receipts.find(item => item.kind === 'INDEX_COMMITTED')
    if (intent.generation.state !== 'PROPOSAL_READY' || completion === undefined) return
    const result = intent.generation.sealedResult
    const revalidation = intent.generation.revalidationAuthorization
    const lineageId = intent.lineageId
    const proposalId = intent.generation.proposalId
    if (result === undefined || revalidation === undefined || lineageId === undefined || proposalId === undefined) return
    const lineage = ProposalLineageV2Schema.safeParse(this.#lineages.get(lineageId))
    const revision = lineage.success && lineage.data.origin === 'RUN2SKILL_V2'
      ? lineage.data.proposalRevisions.at(-1)
      : undefined
    if (
      !lineage.success
      || lineage.data.origin !== 'RUN2SKILL_V2'
      || lineage.data.state !== 'ACTIVE_PROPOSAL'
      || lineage.data.ownerIntentId !== intentId
      || lineage.data.behaviorSignature !== intent.behaviorSignature
      || lineage.data.persistenceScope !== intent.persistenceScope
      || lineage.data.lineageId !== lineageId
      || revision?.proposalId !== proposalId
      || revision.action !== result.action
      || canonicalJson(revision.body) !== canonicalJson(result.body)
      || revision.runtimeCatalogDigest !== revalidation.runtimeCatalogDigest
      || revision.pendingCatalogDigest !== revalidation.pendingCatalogDigest
      || revision.generationResultReceiptDigest !== result.receiptDigest
      || revision.catalogMutationReceiptDigest !== this.#proposalMutationFacts(intent)?.mutationReceiptDigest
      || revision.catalogEpoch !== revalidation.catalogEpoch + 1
      || revision.targetIdentityDigest !== result.targetDigest
      || revision.baseSkillBytes !== result.baseSkillBytes
      || revision.baseSkillBytesDigest !== result.baseSkillBytesDigest
      || revision.state !== 'ACTIVE_PROPOSAL'
    ) return
    const key = deriveBehaviorSignatureIndexKeyV2(intent.persistenceScope, intent.behaviorSignature)
    await this.#global.runExclusive(async current => {
      const lease = current.proposalGenerationLease
      const indexed = current.behaviorSignatureIndex[key]
      if (
        lease?.leaseId !== leaseId
        || lease.state !== 'ACTIVE_COMPLETE'
        || lease.completionReceiptDigest !== completion.digest
        || current.proposalCatalogMutationJournal !== undefined
        || current.proposalCatalogEpoch !== revalidation.catalogEpoch + 1
        || indexed?.ownerIntentId !== intentId
        || indexed.ownerRevision !== intent.revision
        || indexed.state !== 'ACTIVE'
      ) return { value: undefined }
      const { proposalGenerationLease: _lease, ...rest } = current
      return { value: undefined, global: rest }
    })
  }

  async #abandonProposalJournal(mutationId: string): Promise<void> {
    await this.#global.runExclusive(async current => {
      if (current.proposalCatalogMutationJournal?.mutationId !== mutationId) return { value: undefined }
      const { proposalCatalogMutationJournal: _journal, ...rest } = current
      return { value: undefined, global: rest }
    })
  }

  async #markStaleResult(intentId: string, leaseId: string): Promise<void> {
    await this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (intent.generation.leaseId !== leaseId || intent.generation.sealedResult === undefined) return intent
      if (intent.generation.state === 'NEEDS_ATTENTION' && intent.generation.reasonCode === 'STALE_RESULT') return intent
      if (!['RESULT_COMMITTED', 'PROPOSAL_COMMIT_AUTHORIZED', 'PROPOSAL_BODY_COMMITTED'].includes(intent.generation.state)) return intent
      const {
        proposalId: _proposalId,
        revalidationAuthorization: _authorization,
        reasonCode: _reason,
        ...generation
      } = intent.generation
      const { lineageId: _lineageId, ...intentWithoutLineage } = intent
      return ExperienceIntentV2Schema.parse({
        ...intentWithoutLineage,
        revision: intent.revision + 1,
        status: 'NEEDS_ATTENTION',
        generation: {
          ...generation,
          state: 'NEEDS_ATTENTION',
          reasonCode: 'STALE_RESULT',
          receipts: generation.receipts.filter(receipt => ![
            'PROPOSAL_AUTHORIZED', 'BODY_COMMITTED', 'INDEX_COMMITTED',
          ].includes(receipt.kind)),
        },
        updatedAt: this.#isoNow(),
      })
    })
    await this.#global.runExclusive(async current => {
      if (
        current.proposalGenerationLease?.leaseId !== leaseId
        || !['RESULT_COMMITTED', 'PROPOSAL_COMMIT_AUTHORIZED'].includes(current.proposalGenerationLease.state)
        || current.proposalCatalogMutationJournal !== undefined
      ) return { value: undefined }
      const { proposalGenerationLease: _lease, ...rest } = current
      return { value: undefined, global: rest }
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

  async #validateQuiescence(intentId: string): Promise<'VALID' | 'STALE' | 'INCOMPLETE'> {
    try {
      return await this.#quiescence.validate(intentId)
    } catch {
      return 'INCOMPLETE'
    }
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
    kind: 'LEASE_ACQUIRED' | 'CALL_RESERVED' | 'CALL_TERMINAL' | 'PROPOSAL_AUTHORIZED' | 'INDEX_COMMITTED',
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
