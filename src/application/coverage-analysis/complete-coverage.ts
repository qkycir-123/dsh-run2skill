import { z } from 'zod'
import type { Run2skillV2Domain } from '../../adapters/dsh-storage/v2-types.js'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import { preprocessPersistentText } from '../../domain/observe/redaction.js'
import {
  deriveCoverageBindingDigestV2,
  deriveCoverageCallIdV2,
  deriveCoverageInputDigestV2,
  deriveCoverageOutputDigestV2,
  deriveCoveragePlanDigestV2,
  ExperienceIntentV2Schema,
  SessionBatchV2Schema,
  type ExperienceIntentV2,
  type SessionBatchV2,
} from '../../domain/v2/index.js'
import type { CompleteRecallCatalogPort, RecallCatalogSnapshot } from '../recall/index.js'

const outputSchema = z.object({
  decisions: z.array(z.object({
    candidateId: z.string().min(1).max(256),
    decision: z.enum(['UNRELATED', 'COVERED', 'PARTIAL', 'AMBIGUOUS']),
    reason: z.string().min(1).max(1024),
  }).strict()).max(1024),
}).strict()

export interface CoverageClassifier {
  classify(input: {
    readonly intent: Pick<ExperienceIntentV2, 'intentId' | 'persistenceScope' | 'experienceType' | 'applicabilitySummary' | 'keySteps' | 'prohibitions'>
    readonly candidates: readonly { readonly candidateId: string; readonly content: string }[]
    readonly pageOrdinal: number
    readonly inputDigest: string
    readonly route: SessionBatchV2['routeSnapshot']
  }): Promise<unknown>
}

export interface CompleteCoverageOptions {
  readonly catalog: CompleteRecallCatalogPort
  readonly classifier: CoverageClassifier
  readonly policy?: Partial<{ readonly reserveBytes: number; readonly maxCalls: number; readonly policyVersion: string }>
  readonly now?: () => number
}

const DEFAULT_POLICY = Object.freeze({ reserveBytes: 8 * 1024, maxCalls: 8, policyVersion: 'coverage-v1' })

interface LoadedCandidate {
  readonly candidateId: string
  readonly content: string
  readonly capability: 'AVAILABLE' | 'READABLE_NOT_MERGEABLE'
  readonly bodyDigest: string
}

interface CoveragePolicy {
  readonly reserveBytes: number
  readonly maxCalls: number
  readonly policyVersion: string
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = ''
  let bytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > maxBytes) break
    result += character
    bytes += characterBytes
  }
  return result
}

export class CompleteCoverageWorker {
  readonly #intents
  readonly #batches
  readonly #catalog: CompleteRecallCatalogPort
  readonly #classifier: CoverageClassifier
  readonly #policy: CoveragePolicy
  readonly #now: () => number

  constructor(domain: Run2skillV2Domain, options: CompleteCoverageOptions) {
    this.#intents = domain.table('experience_intents')
    this.#batches = domain.table('session_batches')
    this.#catalog = options.catalog
    this.#classifier = options.classifier
    this.#policy = { ...DEFAULT_POLICY, ...options.policy }
    this.#now = options.now ?? Date.now
    if (!Number.isSafeInteger(this.#policy.reserveBytes) || this.#policy.reserveBytes < 0
      || !Number.isSafeInteger(this.#policy.maxCalls) || this.#policy.maxCalls < 1 || this.#policy.maxCalls > 32
      || this.#policy.policyVersion.trim().length === 0) throw new Error('Invalid complete coverage policy')
  }

  async runOnce(): Promise<'IDLE' | 'PROCESSED'> {
    const candidate = [...this.#intents.entries()]
      .map(([, value]) => ExperienceIntentV2Schema.parse(value))
      .filter(intent => ['COVERAGE_READY', 'COVERAGE_RETRY_AUTHORIZED', 'COVERAGE_ANALYZING'].includes(intent.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.ordinal - b.ordinal)[0]
    if (candidate === undefined) return 'IDLE'
    let intent = candidate
    if (candidate.status === 'COVERAGE_READY' || candidate.status === 'COVERAGE_RETRY_AUTHORIZED') {
      let claimed = false
      intent = await this.#intents.update(candidate.intentId, current => {
        const parsed = ExperienceIntentV2Schema.parse(current)
        if (parsed.status !== 'COVERAGE_READY' && parsed.status !== 'COVERAGE_RETRY_AUTHORIZED') return parsed
        claimed = true
        return ExperienceIntentV2Schema.parse({
          ...parsed, revision: parsed.revision + 1, status: 'COVERAGE_ANALYZING',
          coverage: { state: 'ANALYZING' }, updatedAt: this.#isoNow(),
        })
      })
      if (!claimed) return 'PROCESSED'
    }
    await this.#resume(intent)
    return 'PROCESSED'
  }

  async recover(): Promise<void> {
    for (const intent of [...this.#intents.entries()].map(([, value]) => ExperienceIntentV2Schema.parse(value))) {
      if (intent.status !== 'COVERAGE_ANALYZING') continue
      const reserved = intent.stageCalls.find(call => call.stage === 'COVERAGE' && call.outcome === 'RESERVED')
      if (reserved === undefined) continue
      await this.#attention(intent.intentId, 'COVERAGE_OUTCOME_UNKNOWN', reserved.callId, 'OUTCOME_UNKNOWN')
    }
  }

  async #resume(intent: ExperienceIntentV2): Promise<void> {
    const batchValue = this.#batches.get(intent.batchId)
    const batch = batchValue === undefined ? undefined : SessionBatchV2Schema.safeParse(batchValue)
    if (!batch?.success) return this.#attention(intent.intentId, 'COVERAGE_INPUT_UNAVAILABLE')
    if (intent.recall.candidates.some(candidate => candidate.capability === 'UNAVAILABLE')) {
      return this.#attention(intent.intentId, 'RELEVANT_CANDIDATE_UNAVAILABLE')
    }
    const snapshot = await this.#snapshot(batch.data, intent)
    if (snapshot === undefined || !this.#snapshotMatches(snapshot, intent)) {
      return this.#attention(intent.intentId, 'COVERAGE_CATALOG_CHANGED')
    }
    const loaded = await this.#load(batch.data, intent)
    if (loaded === undefined) return
    if (loaded.length > this.#policy.maxCalls) return this.#attention(intent.intentId, 'COVERAGE_BUDGET_EXHAUSTED')
    const basisRevision = intent.coverage.basisRevision ?? intent.revision
    const bindingDigest = deriveCoverageBindingDigestV2({
      intentId: intent.intentId,
      coverageBasisRevision: basisRevision,
      provider: batch.data.routeSnapshot.provider,
      model: batch.data.routeSnapshot.model,
      policyVersion: this.#policy.policyVersion,
    })
    const candidateBindings = loaded.map((item, index) => {
      const ordinal = index + 1
      return {
        ordinal,
        candidateId: item.candidateId,
        bodyDigest: item.bodyDigest,
        inputDigest: deriveCoverageInputDigestV2({
          coverageBindingDigest: bindingDigest,
          runtimeCatalogDigest: intent.recall.runtimeCatalogDigest!,
          pendingCatalogDigest: intent.recall.pendingCatalogDigest!,
          catalogEpoch: intent.recall.catalogEpoch!,
          catalogMutationReceiptDigest: intent.recall.catalogMutationReceiptDigest!,
          ordinal,
          candidateId: item.candidateId,
          bodyDigest: item.bodyDigest,
        }),
      }
    })
    const planDigest = deriveCoveragePlanDigestV2({
      coverageBindingDigest: bindingDigest,
      runtimeCatalogDigest: intent.recall.runtimeCatalogDigest!,
      pendingCatalogDigest: intent.recall.pendingCatalogDigest!,
      catalogEpoch: intent.recall.catalogEpoch!,
      catalogMutationReceiptDigest: intent.recall.catalogMutationReceiptDigest!,
      candidates: candidateBindings,
    })
    if (!await this.#sealPlan(intent.intentId, batch.data, {
      basisRevision, bindingDigest, planDigest, candidateBindings,
    })) return
    if (loaded.length === 0) return this.#authorize(intent.intentId, 'CREATE', planDigest)

    for (const [index, item] of loaded.entries()) {
      const ordinal = index + 1
      const inputDigest = candidateBindings[index]!.inputDigest
      const id = deriveCoverageCallIdV2(intent.intentId, planDigest, ordinal)
      const current = ExperienceIntentV2Schema.parse(this.#intents.get(intent.intentId))
      const priorCall = current.stageCalls.find(call => call.callId === id)
      const priorDecision = current.coverage.decisions?.find(decision => decision.callId === id)
      if (priorCall?.outcome === 'SUCCEEDED' && priorDecision !== undefined) continue
      if (priorCall !== undefined) return
      const reserved = await this.#reserve(intent.intentId, batch.data, id, ordinal, inputDigest, basisRevision)
      if (!reserved) return
      let raw: unknown
      try {
        raw = await this.#classifier.classify({
          intent: this.#intentProjection(intent), candidates: [{ candidateId: item.candidateId, content: item.content }],
          pageOrdinal: ordinal, inputDigest, route: batch.data.routeSnapshot,
        })
      } catch {
        await this.#attention(intent.intentId, 'COVERAGE_CALL_FAILED', id, 'FAILED')
        return
      }
      const parsed = outputSchema.safeParse(raw)
      if (!parsed.success || parsed.data.decisions.length !== 1 || parsed.data.decisions[0]?.candidateId !== item.candidateId) {
        await this.#attention(intent.intentId, 'INVALID_COVERAGE_OUTPUT', id, 'FAILED', sha256Utf8('[INVALID_COVERAGE_OUTPUT]'))
        return
      }
      const decision = parsed.data.decisions[0]!
      const safeReason = truncateUtf8(preprocessPersistentText(decision.reason).text, 1024) || '[redacted]'
      const digest = deriveCoverageOutputDigestV2({ ...decision, reason: safeReason })
      await this.#finish(intent.intentId, id, {
        candidateId: item.candidateId, decision: decision.decision, reason: safeReason,
        pageOrdinal: ordinal, callId: id, inputDigest,
      }, digest)
    }
    await this.#aggregate(intent.intentId, planDigest)
  }

  async #snapshot(batch: SessionBatchV2, intent: ExperienceIntentV2): Promise<RecallCatalogSnapshot | undefined> {
    try { return await this.#catalog.snapshot({ batch, intent }) } catch { return undefined }
  }

  #snapshotMatches(snapshot: RecallCatalogSnapshot, intent: ExperienceIntentV2): boolean {
    return snapshot.complete
      && snapshot.runtimeCatalogDigest === intent.recall.runtimeCatalogDigest
      && snapshot.pendingCatalogDigest === intent.recall.pendingCatalogDigest
      && snapshot.catalogEpoch === intent.recall.catalogEpoch
      && snapshot.catalogMutationReceiptDigest === intent.recall.catalogMutationReceiptDigest
  }

  async #load(batch: SessionBatchV2, intent: ExperienceIntentV2): Promise<LoadedCandidate[] | undefined> {
    const loaded: LoadedCandidate[] = []
    for (const candidate of intent.recall.candidates) {
      let definition
      try { definition = await this.#catalog.read({ candidateId: candidate.candidateId, batch, intent }) } catch {
        await this.#attention(intent.intentId, 'COVERAGE_READ_FAILED'); return undefined
      }
      if (definition === undefined || sha256Utf8(definition.content) !== candidate.bodyDigest) {
        await this.#attention(intent.intentId, 'COVERAGE_BODY_CHANGED'); return undefined
      }
      const content = preprocessPersistentText(definition.content).text
      const fixed = Buffer.byteLength(canonicalJson({
        intent: this.#intentProjection(intent), candidateId: candidate.candidateId,
        route: batch.routeSnapshot, policyVersion: this.#policy.policyVersion,
      }), 'utf8') + this.#policy.reserveBytes
      if (Buffer.byteLength(content, 'utf8') > batch.routeSnapshot.maxInputBytes - fixed) {
        await this.#attention(intent.intentId, 'COVERAGE_BUDGET_EXHAUSTED'); return undefined
      }
      loaded.push({
        candidateId: candidate.candidateId, content, bodyDigest: candidate.bodyDigest!,
        capability: candidate.capability as LoadedCandidate['capability'],
      })
    }
    const after = await this.#snapshot(batch, intent)
    if (after === undefined || !this.#snapshotMatches(after, intent)) {
      await this.#attention(intent.intentId, 'COVERAGE_CATALOG_CHANGED'); return undefined
    }
    return loaded.sort((a, b) => a.candidateId.localeCompare(b.candidateId))
  }

  async #sealPlan(
    intentId: string,
    batch: SessionBatchV2,
    plan: {
      readonly basisRevision: number
      readonly bindingDigest: string
      readonly planDigest: string
      readonly candidateBindings: readonly { readonly ordinal: number; readonly candidateId: string; readonly bodyDigest: string; readonly inputDigest: string }[]
    },
  ): Promise<boolean> {
    let accepted = false
    await this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (intent.status !== 'COVERAGE_ANALYZING') return intent
      const existing = intent.coverage.planDigest
      if (existing !== undefined) {
        accepted = existing === plan.planDigest
          && intent.coverage.basisRevision === plan.basisRevision
          && intent.coverage.bindingDigest === plan.bindingDigest
          && canonicalJson(intent.coverage.candidateBindings) === canonicalJson(plan.candidateBindings)
        return intent
      }
      accepted = true
      return ExperienceIntentV2Schema.parse({
        ...intent,
        revision: intent.revision + 1,
        coverage: {
          ...intent.coverage,
          basisRevision: plan.basisRevision,
          routeProvider: batch.routeSnapshot.provider,
          routeModel: batch.routeSnapshot.model,
          policyVersion: this.#policy.policyVersion,
          bindingDigest: plan.bindingDigest,
          planDigest: plan.planDigest,
          candidateBindings: plan.candidateBindings,
          decisions: intent.coverage.decisions ?? [],
        },
        updatedAt: this.#isoNow(),
      })
    })
    if (!accepted) await this.#attention(intentId, 'COVERAGE_PLAN_CHANGED')
    return accepted
  }

  async #reserve(intentId: string, batch: SessionBatchV2, id: string, ordinal: number, inputDigest: string, basisRevision: number): Promise<boolean> {
    let won = false
    await this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (intent.status !== 'COVERAGE_ANALYZING' || intent.stageCalls.some(call => call.callId === id)) return intent
      won = true
      return ExperienceIntentV2Schema.parse({
        ...intent, revision: intent.revision + 1,
        stageCalls: [...intent.stageCalls, {
          stage: 'COVERAGE', intentRevision: basisRevision, callId: id, ordinal, inputDigest,
          provider: batch.routeSnapshot.provider, model: batch.routeSnapshot.model,
          policyVersion: this.#policy.policyVersion, outcome: 'RESERVED',
        }], updatedAt: this.#isoNow(),
      })
    })
    return won
  }

  async #finish(intentId: string, id: string, decision: Record<string, unknown>, digest: string): Promise<void> {
    await this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (intent.status !== 'COVERAGE_ANALYZING') return intent
      return ExperienceIntentV2Schema.parse({
        ...intent, revision: intent.revision + 1,
        coverage: { ...intent.coverage, decisions: [...(intent.coverage.decisions ?? []), { ...decision, outputDigest: digest }] },
        stageCalls: intent.stageCalls.map(call => call.callId === id ? { ...call, outcome: 'SUCCEEDED', outputDigest: digest } : call),
        updatedAt: this.#isoNow(),
      })
    })
  }

  async #aggregate(intentId: string, planDigest: string): Promise<void> {
    const intent = ExperienceIntentV2Schema.parse(this.#intents.get(intentId))
    const decisions = intent.coverage.decisions ?? []
    const covered = decisions.filter(item => item.decision === 'COVERED')
    if (covered.length > 0) {
      await this.#intents.update(intentId, current => {
        const parsed = ExperienceIntentV2Schema.parse(current)
        return ExperienceIntentV2Schema.parse({
          ...parsed, revision: parsed.revision + 1,
          status: parsed.explicitSave ? 'COVERED_NEEDS_CONFIRMATION' : 'COVERED',
          coverage: { ...parsed.coverage, state: 'COVERED', inputDigest: planDigest, targetCandidateId: covered[0]!.candidateId },
          updatedAt: this.#isoNow(),
        })
      }); return
    }
    const partial = decisions.filter(item => item.decision === 'PARTIAL')
    if (decisions.every(item => item.decision === 'UNRELATED')) return this.#authorize(intentId, 'CREATE', planDigest)
    if (partial.length === 1 && decisions.every(item => item.decision === 'UNRELATED' || item.decision === 'PARTIAL')) {
      const target = intent.recall.candidates.find(item => item.candidateId === partial[0]!.candidateId)
      if (target?.capability === 'AVAILABLE') return this.#authorize(intentId, 'MERGE', planDigest, target.candidateId, target.bodyDigest)
    }
    await this.#attention(intentId, 'COVERAGE_AMBIGUOUS')
  }

  async #authorize(intentId: string, action: 'CREATE' | 'MERGE', inputDigest: string, targetCandidateId?: string, targetDigest?: string): Promise<void> {
    await this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (intent.status !== 'COVERAGE_ANALYZING') return intent
      const nextRevision = intent.revision + 1
      return ExperienceIntentV2Schema.parse({
        ...intent, revision: nextRevision, status: action === 'CREATE' ? 'CREATE_AUTHORIZED' : 'MERGE_AUTHORIZED',
        coverage: { ...intent.coverage, state: action, inputDigest, ...(targetCandidateId ? { targetCandidateId } : {}), ...(targetDigest ? { targetDigest } : {}) },
        generation: {
          state: 'GENERATION_AUTHORIZED', action, inputDigest, generationRevision: nextRevision,
          catalogEpoch: intent.recall.catalogEpoch, externalPendingDigest: intent.recall.pendingCatalogDigest,
          ...(intent.recall.selfExclusion ? { selfExclusionDigest: intent.recall.selfExclusion.selfExclusionDigest } : {}),
          userRetryUsed: intent.generation.userRetryUsed, staleRefreshUsed: intent.generation.staleRefreshUsed, receipts: [],
        }, updatedAt: this.#isoNow(),
      })
    })
  }

  async #attention(intentId: string, reasonCode: string, callIdValue?: string, outcome?: 'FAILED' | 'SUCCEEDED' | 'OUTCOME_UNKNOWN', digest?: string): Promise<void> {
    await this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (intent.status !== 'COVERAGE_ANALYZING') return intent
      return ExperienceIntentV2Schema.parse({
        ...intent, revision: intent.revision + 1, status: 'NEEDS_ATTENTION',
        coverage: { ...intent.coverage, state: 'NEEDS_ATTENTION', reasonCode },
        stageCalls: intent.stageCalls.map(call => call.callId === callIdValue
          ? { ...call, outcome, failureCode: reasonCode, ...(digest ? { outputDigest: digest } : {}) }
          : call), updatedAt: this.#isoNow(),
      })
    })
  }

  #intentProjection(intent: ExperienceIntentV2) {
    return {
      intentId: intent.intentId, persistenceScope: intent.persistenceScope, experienceType: intent.experienceType,
      applicabilitySummary: intent.applicabilitySummary, keySteps: intent.keySteps, prohibitions: intent.prohibitions,
    }
  }

  #isoNow(): string { return new Date(this.#now()).toISOString() }
}
