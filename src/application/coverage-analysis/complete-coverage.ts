import { z } from 'zod'
import type { Run2skillV2Domain } from '../../adapters/dsh-storage/v2-types.js'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import { preprocessPersistentText } from '../../domain/observe/redaction.js'
import {
  deriveCoverageBindingDigestV2,
  deriveCoverageCallIdV2,
  deriveCoverageInputDigestV2,
  deriveCoverageMembershipDigestV2,
  deriveCoverageOutputDigestV2,
  deriveCoveragePlanDigestV2,
  deriveCreateTargetDigestV2,
  ExperienceIntentV2Schema,
  SessionBatchV2Schema,
  type ExperienceIntentV2,
  type SessionBatchV2,
} from '../../domain/v2/index.js'
import type { CompleteRecallCatalogPort, RecallCatalogSnapshot } from '../recall/index.js'

const decisionSchema = z.object({
  candidateId: z.string().min(1).max(256),
  decision: z.enum(['UNRELATED', 'COVERED', 'PARTIAL', 'AMBIGUOUS']),
  reason: z.string().min(1).max(1024),
}).strict()

const outputSchema = z.object({ decisions: z.array(decisionSchema).max(1024) }).strict()

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
  readonly policy?: Partial<{
    readonly reserveBytes: number
    readonly mergeOutputReserveBytes: number
    readonly maxCalls: number
    readonly policyVersion: string
  }>
  readonly now?: () => number
}

const DEFAULT_POLICY = Object.freeze({
  reserveBytes: 8 * 1024,
  mergeOutputReserveBytes: 2 * 1024,
  maxCalls: 8,
  policyVersion: 'coverage-v2',
})

interface CoveragePolicy {
  readonly reserveBytes: number
  readonly mergeOutputReserveBytes: number
  readonly maxCalls: number
  readonly policyVersion: string
}

interface LoadedCandidate {
  readonly candidateId: string
  readonly content: string
  readonly capability: 'AVAILABLE' | 'READABLE_NOT_MERGEABLE'
  readonly bodyDigest: string
  readonly bodyBytes: number
}

interface CoveragePage {
  readonly ordinal: number
  readonly candidates: readonly LoadedCandidate[]
  readonly inputDigest: string
  readonly membershipDigest: string
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
    if (
      !Number.isSafeInteger(this.#policy.reserveBytes) || this.#policy.reserveBytes < 0
      || !Number.isSafeInteger(this.#policy.mergeOutputReserveBytes) || this.#policy.mergeOutputReserveBytes < 0
      || !Number.isSafeInteger(this.#policy.maxCalls) || this.#policy.maxCalls < 1 || this.#policy.maxCalls > 32
      || this.#policy.policyVersion.trim().length === 0
    ) throw new Error('Invalid complete coverage policy')
  }

  async runOnce(): Promise<'IDLE' | 'PROCESSED'> {
    const candidate = [...this.#intents.entries()]
      .map(([, value]) => ExperienceIntentV2Schema.parse(value))
      .filter(intent => ['COVERAGE_READY', 'COVERAGE_RETRY_AUTHORIZED', 'COVERAGE_ANALYZING'].includes(intent.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.ordinal - right.ordinal)[0]
    if (candidate === undefined) return 'IDLE'

    let intent = candidate
    if (candidate.status === 'COVERAGE_READY' || candidate.status === 'COVERAGE_RETRY_AUTHORIZED') {
      let claimed = false
      intent = await this.#intents.update(candidate.intentId, current => {
        const parsed = ExperienceIntentV2Schema.parse(current)
        if (parsed.status !== 'COVERAGE_READY' && parsed.status !== 'COVERAGE_RETRY_AUTHORIZED') return parsed
        claimed = true
        const retryUsed = parsed.status === 'COVERAGE_RETRY_AUTHORIZED' || parsed.coverage.retryUsed
        return ExperienceIntentV2Schema.parse({
          ...parsed,
          revision: parsed.revision + 1,
          status: 'COVERAGE_ANALYZING',
          coverage: { state: 'ANALYZING', retryUsed },
          updatedAt: this.#isoNow(),
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
      const reserved = intent.coverage.basisRevision === undefined
        ? undefined
        : intent.stageCalls.find(call => (
          call.stage === 'COVERAGE'
          && call.intentRevision === intent.coverage.basisRevision
          && call.outcome === 'RESERVED'
        ))
      if (reserved !== undefined) {
        await this.#attention(intent.intentId, 'COVERAGE_OUTCOME_UNKNOWN', reserved.callId, 'OUTCOME_UNKNOWN')
      }
    }
  }

  async #resume(intent: ExperienceIntentV2): Promise<void> {
    const batchValue = this.#batches.get(intent.batchId)
    const batch = batchValue === undefined ? undefined : SessionBatchV2Schema.safeParse(batchValue)
    if (!batch?.success) return this.#attention(intent.intentId, 'COVERAGE_INPUT_UNAVAILABLE')
    if (intent.recall.candidates.some(candidate => candidate.capability === 'UNAVAILABLE')) {
      return this.#attention(intent.intentId, 'RELEVANT_CANDIDATE_UNAVAILABLE')
    }
    if (!await this.#catalogStillMatches(batch.data, intent)) return
    const loaded = await this.#load(batch.data, intent)
    if (loaded === undefined) return

    const rawPages = this.#group(batch.data, intent, loaded)
    if (rawPages === undefined || rawPages.length > this.#policy.maxCalls) {
      return this.#attention(intent.intentId, 'COVERAGE_BUDGET_EXHAUSTED')
    }
    const basisRevision = intent.coverage.basisRevision ?? intent.revision
    const bindingDigest = deriveCoverageBindingDigestV2({
      intentId: intent.intentId,
      coverageBasisRevision: basisRevision,
      provider: batch.data.routeSnapshot.provider,
      model: batch.data.routeSnapshot.model,
      policyVersion: this.#policy.policyVersion,
      routeMaxInputBytes: batch.data.routeSnapshot.maxInputBytes,
      routeMaxOutputBytes: batch.data.routeSnapshot.maxOutputBytes,
      reserveBytes: this.#policy.reserveBytes,
      mergeOutputReserveBytes: this.#policy.mergeOutputReserveBytes,
    })
    const pageFacts = rawPages.map((candidates, index) => {
      const ordinal = index + 1
      const members = candidates.map(item => ({
        candidateId: item.candidateId, bodyDigest: item.bodyDigest, bodyBytes: item.bodyBytes,
      }))
      return {
        ordinal,
        itemCount: candidates.length,
        membershipDigest: deriveCoverageMembershipDigestV2(members),
        inputDigest: deriveCoverageInputDigestV2({
          coverageBindingDigest: bindingDigest,
          runtimeCatalogDigest: intent.recall.runtimeCatalogDigest!,
          pendingCatalogDigest: intent.recall.pendingCatalogDigest!,
          catalogEpoch: intent.recall.catalogEpoch!,
          catalogMutationReceiptDigest: intent.recall.catalogMutationReceiptDigest!,
          pageOrdinal: ordinal,
          members,
        }),
      }
    })
    const pages: CoveragePage[] = rawPages.map((candidates, index) => ({ ...pageFacts[index]!, candidates }))
    let candidateOrdinal = 0
    const candidateBindings = pages.flatMap(page => page.candidates.map(item => ({
      ordinal: ++candidateOrdinal,
      candidateId: item.candidateId,
      bodyDigest: item.bodyDigest,
      bodyBytes: item.bodyBytes,
      pageOrdinal: page.ordinal,
    })))
    const planDigest = deriveCoveragePlanDigestV2({
      coverageBindingDigest: bindingDigest,
      runtimeCatalogDigest: intent.recall.runtimeCatalogDigest!,
      pendingCatalogDigest: intent.recall.pendingCatalogDigest!,
      catalogEpoch: intent.recall.catalogEpoch!,
      catalogMutationReceiptDigest: intent.recall.catalogMutationReceiptDigest!,
      pages: pageFacts,
    })
    if (!await this.#sealPlan(intent.intentId, batch.data, {
      basisRevision, bindingDigest, planDigest, pages: pageFacts, candidateBindings,
    })) return

    for (const page of pages) {
      const id = deriveCoverageCallIdV2(intent.intentId, planDigest, page.ordinal)
      const current = ExperienceIntentV2Schema.parse(this.#intents.get(intent.intentId))
      const priorCall = current.stageCalls.find(call => call.callId === id)
      const priorDecisions = current.coverage.decisions?.filter(decision => decision.callId === id) ?? []
      if (priorCall?.outcome === 'SUCCEEDED' && priorDecisions.length === page.candidates.length) continue
      if (priorCall !== undefined) return
      if (!await this.#reserve(intent.intentId, batch.data, id, page.ordinal, page.inputDigest, basisRevision)) return

      let raw: unknown
      try {
        raw = await this.#classifier.classify({
          intent: this.#intentProjection(intent),
          candidates: page.candidates.map(item => ({ candidateId: item.candidateId, content: item.content })),
          pageOrdinal: page.ordinal,
          inputDigest: page.inputDigest,
          route: batch.data.routeSnapshot,
        })
      } catch {
        await this.#attention(intent.intentId, 'COVERAGE_CALL_FAILED', id, 'FAILED')
        return
      }
      const parsed = outputSchema.safeParse(raw)
      const expectedIds = page.candidates.map(item => item.candidateId).sort()
      const actualIds = parsed.success ? parsed.data.decisions.map(item => item.candidateId).sort() : []
      if (
        !parsed.success
        || new Set(actualIds).size !== actualIds.length
        || canonicalJson(actualIds) !== canonicalJson(expectedIds)
      ) {
        await this.#attention(intent.intentId, 'INVALID_COVERAGE_OUTPUT', id, 'FAILED', sha256Utf8('[INVALID_COVERAGE_OUTPUT]'))
        return
      }
      const decisions = parsed.data.decisions.map(decision => ({
        candidateId: decision.candidateId,
        decision: decision.decision,
        reason: truncateUtf8(preprocessPersistentText(decision.reason).text, 1024) || '[redacted]',
        pageOrdinal: page.ordinal,
        callId: id,
        inputDigest: page.inputDigest,
      }))
      await this.#finish(intent.intentId, id, decisions, deriveCoverageOutputDigestV2(decisions))
    }

    const current = ExperienceIntentV2Schema.parse(this.#intents.get(intent.intentId))
    if (!await this.#catalogStillMatches(batch.data, current)) return
    const reloaded = await this.#load(batch.data, current)
    if (reloaded === undefined) return
    const expectedBodies = candidateBindings.map(item => ({
      candidateId: item.candidateId, bodyDigest: item.bodyDigest, bodyBytes: item.bodyBytes,
    })).sort((left, right) => left.candidateId.localeCompare(right.candidateId))
    const actualBodies = reloaded.map(item => ({
      candidateId: item.candidateId, bodyDigest: item.bodyDigest, bodyBytes: item.bodyBytes,
    })).sort((left, right) => left.candidateId.localeCompare(right.candidateId))
    if (canonicalJson(actualBodies) !== canonicalJson(expectedBodies)) {
      return this.#attention(intent.intentId, 'COVERAGE_BODY_CHANGED')
    }
    await this.#aggregate(intent.intentId, planDigest)
  }

  #group(batch: SessionBatchV2, intent: ExperienceIntentV2, loaded: readonly LoadedCandidate[]): LoadedCandidate[][] | undefined {
    const pages: LoadedCandidate[][] = []
    for (const candidate of loaded) {
      const current = pages.at(-1)
      if (current !== undefined && this.#fits(batch, intent, [...current, candidate])) current.push(candidate)
      else if (this.#fits(batch, intent, [candidate])) pages.push([candidate])
      else return undefined
    }
    return pages
  }

  #fits(batch: SessionBatchV2, intent: ExperienceIntentV2, candidates: readonly LoadedCandidate[]): boolean {
    const bytes = Buffer.byteLength(canonicalJson({
      intent: this.#intentProjection(intent),
      candidates: candidates.map(item => ({ candidateId: item.candidateId, content: item.content })),
      pageOrdinal: 32,
      inputDigest: '0'.repeat(64),
      route: batch.routeSnapshot,
    }), 'utf8') + this.#policy.reserveBytes
    return bytes <= batch.routeSnapshot.maxInputBytes
  }

  async #catalogStillMatches(batch: SessionBatchV2, intent: ExperienceIntentV2): Promise<boolean> {
    const snapshot = await this.#snapshot(batch, intent)
    if (snapshot !== undefined && this.#snapshotMatches(snapshot, intent)) return true
    await this.#attention(intent.intentId, 'COVERAGE_CATALOG_CHANGED')
    return false
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
        await this.#attention(intent.intentId, 'COVERAGE_READ_FAILED')
        return undefined
      }
      if (definition === undefined || sha256Utf8(definition.content) !== candidate.bodyDigest) {
        await this.#attention(intent.intentId, 'COVERAGE_BODY_CHANGED')
        return undefined
      }
      loaded.push({
        candidateId: candidate.candidateId,
        content: preprocessPersistentText(definition.content).text,
        capability: candidate.capability as LoadedCandidate['capability'],
        bodyDigest: candidate.bodyDigest!,
        bodyBytes: Buffer.byteLength(definition.content, 'utf8'),
      })
    }
    const after = await this.#snapshot(batch, intent)
    if (after === undefined || !this.#snapshotMatches(after, intent)) {
      await this.#attention(intent.intentId, 'COVERAGE_CATALOG_CHANGED')
      return undefined
    }
    return loaded.sort((left, right) => left.candidateId.localeCompare(right.candidateId))
  }

  async #sealPlan(
    intentId: string,
    batch: SessionBatchV2,
    plan: {
      readonly basisRevision: number
      readonly bindingDigest: string
      readonly planDigest: string
      readonly pages: readonly { readonly ordinal: number; readonly itemCount: number; readonly inputDigest: string; readonly membershipDigest: string }[]
      readonly candidateBindings: readonly { readonly ordinal: number; readonly candidateId: string; readonly bodyDigest: string; readonly bodyBytes: number; readonly pageOrdinal: number }[]
    },
  ): Promise<boolean> {
    let accepted = false
    await this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (intent.status !== 'COVERAGE_ANALYZING') return intent
      if (intent.coverage.planDigest !== undefined) {
        accepted = intent.coverage.planDigest === plan.planDigest
          && intent.coverage.basisRevision === plan.basisRevision
          && intent.coverage.bindingDigest === plan.bindingDigest
          && canonicalJson(intent.coverage.pages) === canonicalJson(plan.pages)
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
          routeMaxInputBytes: batch.routeSnapshot.maxInputBytes,
          routeMaxOutputBytes: batch.routeSnapshot.maxOutputBytes,
          reserveBytes: this.#policy.reserveBytes,
          mergeOutputReserveBytes: this.#policy.mergeOutputReserveBytes,
          policyVersion: this.#policy.policyVersion,
          bindingDigest: plan.bindingDigest,
          planDigest: plan.planDigest,
          pages: plan.pages,
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
        ...intent,
        revision: intent.revision + 1,
        stageCalls: [...intent.stageCalls, {
          stage: 'COVERAGE', intentRevision: basisRevision, callId: id, ordinal, inputDigest,
          provider: batch.routeSnapshot.provider, model: batch.routeSnapshot.model,
          policyVersion: this.#policy.policyVersion, outcome: 'RESERVED',
        }],
        updatedAt: this.#isoNow(),
      })
    })
    return won
  }

  async #finish(intentId: string, id: string, decisions: readonly Record<string, unknown>[], digest: string): Promise<void> {
    await this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (intent.status !== 'COVERAGE_ANALYZING') return intent
      return ExperienceIntentV2Schema.parse({
        ...intent,
        revision: intent.revision + 1,
        coverage: {
          ...intent.coverage,
          decisions: [...(intent.coverage.decisions ?? []), ...decisions.map(decision => ({ ...decision, outputDigest: digest }))],
        },
        stageCalls: intent.stageCalls.map(call => call.callId === id
          ? { ...call, outcome: 'SUCCEEDED', outputDigest: digest }
          : call),
        updatedAt: this.#isoNow(),
      })
    })
  }

  async #aggregate(intentId: string, planDigest: string): Promise<void> {
    const intent = ExperienceIntentV2Schema.parse(this.#intents.get(intentId))
    const decisions = intent.coverage.decisions ?? []
    const covered = decisions.filter(item => item.decision === 'COVERED')
    if (covered.length > 0) {
      if (intent.coverage.retryUsed) return this.#attention(intentId, 'COVERAGE_RETRY_STILL_COVERED')
      await this.#intents.update(intentId, current => {
        const parsed = ExperienceIntentV2Schema.parse(current)
        return ExperienceIntentV2Schema.parse({
          ...parsed,
          revision: parsed.revision + 1,
          status: parsed.explicitSave ? 'COVERED_NEEDS_CONFIRMATION' : 'COVERED',
          coverage: {
            ...parsed.coverage,
            state: 'COVERED',
            inputDigest: planDigest,
            targetCandidateId: covered[0]!.candidateId,
          },
          updatedAt: this.#isoNow(),
        })
      })
      return
    }
    const partial = decisions.filter(item => item.decision === 'PARTIAL')
    if (decisions.every(item => item.decision === 'UNRELATED')) return this.#authorize(intentId, 'CREATE', planDigest)
    if (partial.length === 1 && decisions.every(item => item.decision === 'UNRELATED' || item.decision === 'PARTIAL')) {
      const target = intent.recall.candidates.find(item => item.candidateId === partial[0]!.candidateId)
      const binding = intent.coverage.candidateBindings?.find(item => item.candidateId === partial[0]!.candidateId)
      const outputBudget = Math.max(0, intent.coverage.routeMaxOutputBytes! - intent.coverage.mergeOutputReserveBytes!)
      if (target?.capability === 'AVAILABLE' && binding !== undefined) {
        if (binding.bodyBytes > outputBudget) return this.#attention(intentId, 'MERGE_OUTPUT_BUDGET_EXHAUSTED')
        return this.#authorize(intentId, 'MERGE', planDigest, target.candidateId, target.bodyDigest)
      }
    }
    await this.#attention(intentId, 'COVERAGE_AMBIGUOUS')
  }

  async #authorize(intentId: string, action: 'CREATE' | 'MERGE', inputDigest: string, targetCandidateId?: string, targetDigest?: string): Promise<void> {
    await this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (intent.status !== 'COVERAGE_ANALYZING') return intent
      const nextRevision = intent.revision + 1
      const authorizedTargetDigest = action === 'CREATE'
        ? deriveCreateTargetDigestV2(intent)
        : targetDigest
      return ExperienceIntentV2Schema.parse({
        ...intent,
        revision: nextRevision,
        status: action === 'CREATE' ? 'CREATE_AUTHORIZED' : 'MERGE_AUTHORIZED',
        coverage: {
          ...intent.coverage,
          state: action,
          inputDigest,
          ...(targetCandidateId ? { targetCandidateId } : {}),
          ...(authorizedTargetDigest ? { targetDigest: authorizedTargetDigest } : {}),
        },
        generation: {
          state: 'GENERATION_AUTHORIZED', action, inputDigest, generationRevision: nextRevision,
          catalogEpoch: intent.recall.catalogEpoch, externalPendingDigest: intent.recall.pendingCatalogDigest,
          ...(intent.recall.selfExclusion ? { selfExclusionDigest: intent.recall.selfExclusion.selfExclusionDigest } : {}),
          userRetryUsed: intent.generation.userRetryUsed, staleRefreshUsed: intent.generation.staleRefreshUsed, receipts: [],
        },
        updatedAt: this.#isoNow(),
      })
    })
  }

  async #attention(intentId: string, reasonCode: string, callIdValue?: string, outcome?: 'FAILED' | 'OUTCOME_UNKNOWN', digest?: string): Promise<void> {
    await this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (intent.status !== 'COVERAGE_ANALYZING') return intent
      return ExperienceIntentV2Schema.parse({
        ...intent,
        revision: intent.revision + 1,
        status: 'NEEDS_ATTENTION',
        coverage: { ...intent.coverage, state: 'NEEDS_ATTENTION', reasonCode },
        stageCalls: intent.stageCalls.map(call => call.callId === callIdValue
          ? { ...call, outcome, failureCode: reasonCode, ...(digest ? { outputDigest: digest } : {}) }
          : call),
        updatedAt: this.#isoNow(),
      })
    })
  }

  #intentProjection(intent: ExperienceIntentV2) {
    return {
      intentId: intent.intentId,
      persistenceScope: intent.persistenceScope,
      experienceType: intent.experienceType,
      applicabilitySummary: intent.applicabilitySummary,
      keySteps: intent.keySteps,
      prohibitions: intent.prohibitions,
    }
  }

  #isoNow(): string { return new Date(this.#now()).toISOString() }
}
