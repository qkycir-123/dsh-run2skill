import { z } from 'zod'
import type { Run2skillV2Domain } from '../../adapters/dsh-storage/v2-types.js'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import { preprocessPersistentText } from '../../domain/observe/redaction.js'
import {
  deriveCatalogScanBindingDigestV2,
  deriveCatalogScanCallIdV2,
  deriveCatalogScanMembershipDigestV2,
  deriveCatalogScanOutputDigestV2,
  deriveCatalogScanPlanDigestV2,
  ExperienceIntentV2Schema,
  SessionBatchV2Schema,
  type ExperienceIntentV2,
  type SessionBatchV2,
} from '../../domain/v2/index.js'

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/)
const identity = z.string().min(1).max(256)
const utf8Limited = (maxBytes: number) => z.string().refine(
  value => Buffer.byteLength(value, 'utf8') <= maxBytes,
  `Expected at most ${maxBytes} UTF-8 bytes`,
)

export interface RecallCandidateIdentityFacts {
  readonly provider: string
  readonly source: string
  readonly scope: 'PROJECT' | 'USER'
  readonly name: string
  readonly rootIdentityDigest: string
}

export function deriveRecallCandidateId(facts: RecallCandidateIdentityFacts): `cand_${string}` {
  return `cand_${sha256Utf8(canonicalJson({
    provider: facts.provider,
    source: facts.source,
    scope: facts.scope,
    name: facts.name,
    rootIdentityDigest: facts.rootIdentityDigest,
  }))}`
}

const summarySchema = z.object({
  candidateId: z.string().regex(/^cand_[a-f0-9]{64}$/),
  name: z.string().min(1).max(128),
  description: utf8Limited(2 * 1024),
  whenToUse: utf8Limited(4 * 1024).optional(),
  provider: identity,
  source: identity,
  scope: z.enum(['PROJECT', 'USER']),
  writable: z.boolean(),
  rootIdentityDigest: sha256Hex,
}).strict().superRefine((value, context) => {
  if (value.candidateId !== deriveRecallCandidateId(value)) {
    context.addIssue({ code: 'custom', path: ['candidateId'], message: 'Candidate identity does not match stable root and winning name facts' })
  }
})
const snapshotSchema = z.object({
  complete: z.boolean(),
  runtimeCatalogDigest: sha256Hex,
  pendingCatalogDigest: sha256Hex,
  catalogEpoch: z.number().int().nonnegative(),
  catalogMutationReceiptDigest: sha256Hex,
  summaries: z.array(summarySchema).max(1024),
}).strict().superRefine((value, context) => {
  const ids = value.summaries.map(item => item.candidateId)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['summaries'], message: 'Catalog candidate identities must be unique' })
  }
})
const definitionSchema = summarySchema.safeExtend({
  content: z.string(),
  exactSkillBytes: z.string().optional(),
  skillBytesDigest: sha256Hex.optional(),
}).strict().superRefine((value, context) => {
  if (value.exactSkillBytes !== undefined) {
    if (value.skillBytesDigest === undefined) {
      context.addIssue({ code: 'custom', path: ['skillBytesDigest'], message: 'Exact Skill bytes require their digest' })
    } else if (sha256Utf8(value.exactSkillBytes) !== value.skillBytesDigest) {
      context.addIssue({ code: 'custom', path: ['skillBytesDigest'], message: 'Exact Skill bytes digest does not match bytes' })
    }
  }
})
const classifierOutputSchema = z.object({
  classifications: z.array(z.object({
    candidateId: identity,
    classification: z.enum(['RELEVANT', 'POSSIBLE', 'UNRELATED']),
  }).strict()).max(1024),
}).strict()

export type RecallCatalogSummary = z.infer<typeof summarySchema>
export type RecallCatalogSnapshot = z.infer<typeof snapshotSchema>
export type RecallCatalogDefinition = z.infer<typeof definitionSchema>

export interface CompleteRecallCatalogPort {
  snapshot(input: { readonly batch: SessionBatchV2; readonly intent: ExperienceIntentV2 }): Promise<RecallCatalogSnapshot>
  read(input: {
    readonly candidateId: string
    readonly batch: SessionBatchV2
    readonly intent: ExperienceIntentV2
  }): Promise<RecallCatalogDefinition | undefined>
}

export interface CatalogRecallClassifier {
  classify(input: {
    readonly intent: Pick<ExperienceIntentV2,
      'intentId' | 'persistenceScope' | 'experienceType' | 'applicabilitySummary' | 'keySteps' | 'prohibitions'>
    readonly summaries: readonly RecallCatalogSummary[]
    readonly pageOrdinal: number
    readonly inputDigest: string
    readonly route: SessionBatchV2['routeSnapshot']
  }): Promise<unknown>
}

export interface CompleteCatalogRecallPolicy {
  readonly catalogScanReserveBytes: number
  readonly coverageReserveBytes: number
  readonly maxCatalogScanCalls: number
  readonly policyVersion: string
}

const DEFAULT_POLICY: CompleteCatalogRecallPolicy = Object.freeze({
  catalogScanReserveBytes: 8 * 1024,
  coverageReserveBytes: 8 * 1024,
  maxCatalogScanCalls: 8,
  policyVersion: 'catalog-scan-v1',
})

export interface CompleteCatalogRecallOptions {
  readonly catalog: CompleteRecallCatalogPort
  readonly classifier: CatalogRecallClassifier
  readonly policy?: Partial<CompleteCatalogRecallPolicy>
  readonly now?: () => number
}

interface ScanPage {
  readonly ordinal: number
  readonly inputDigest: string
  readonly membershipDigest: string
  readonly summaries: readonly RecallCatalogSummary[]
}

interface ScanPlan {
  readonly digest: string
  readonly pages: readonly ScanPage[]
}

const canonicalCatalogLabels = Object.freeze({
  provider: new Set(['filesystem', 'run2skill-pending']),
  source: new Set([
    'project-dsh', 'project-agents', 'custom', 'user-dsh', 'user-agents', 'bundled',
    'active-proposal', 'sealed-generation-result', 'generation-barrier', 'legacy-proposal',
  ]),
})

function projectCatalogLabel(kind: 'provider' | 'source', value: string): string {
  if (new RegExp(`^${kind}-[a-f0-9]{64}$`, 'u').test(value)) return value
  return canonicalCatalogLabels[kind].has(value)
    ? value
    : `${kind}-${sha256Utf8(value)}`
}

function summaryProjection(summary: RecallCatalogSummary): RecallCatalogSummary {
  return {
    candidateId: summary.candidateId,
    name: preprocessPersistentText(summary.name).text,
    description: preprocessPersistentText(summary.description).text,
    ...(summary.whenToUse === undefined ? {} : { whenToUse: preprocessPersistentText(summary.whenToUse).text }),
    provider: projectCatalogLabel('provider', summary.provider),
    source: projectCatalogLabel('source', summary.source),
    scope: summary.scope,
    writable: summary.writable,
    rootIdentityDigest: summary.rootIdentityDigest,
  }
}

function summaryDigest(summary: RecallCatalogSummary): string {
  return sha256Utf8(canonicalJson(summaryProjection(summary)))
}

function callId(intentId: string, scanPlanDigest: string, ordinal: number): `call_${string}` {
  return deriveCatalogScanCallIdV2(intentId, scanPlanDigest, ordinal)
}

export class CompleteCatalogRecallWorker {
  readonly #intents
  readonly #batches
  readonly #catalog: CompleteRecallCatalogPort
  readonly #classifier: CatalogRecallClassifier
  readonly #policy: CompleteCatalogRecallPolicy
  readonly #now: () => number

  constructor(domain: Run2skillV2Domain, options: CompleteCatalogRecallOptions) {
    this.#intents = domain.table('experience_intents')
    this.#batches = domain.table('session_batches')
    this.#catalog = options.catalog
    this.#classifier = options.classifier
    this.#policy = { ...DEFAULT_POLICY, ...options.policy }
    this.#now = options.now ?? Date.now
    if (
      !Number.isSafeInteger(this.#policy.catalogScanReserveBytes) || this.#policy.catalogScanReserveBytes < 0
      || !Number.isSafeInteger(this.#policy.coverageReserveBytes) || this.#policy.coverageReserveBytes < 0
      || !Number.isSafeInteger(this.#policy.maxCatalogScanCalls) || this.#policy.maxCatalogScanCalls < 1
      || this.#policy.policyVersion.trim().length === 0
    ) throw new Error('Invalid complete Catalog recall policy')
  }

  async runOnce(): Promise<'IDLE' | 'PROCESSED'> {
    const candidate = [...this.#intents.entries()]
      .map(([, value]) => ExperienceIntentV2Schema.parse(value))
      .filter(intent => intent.status === 'RUN2SKILL_OWNED' || intent.status === 'RECALLING')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.ordinal - right.ordinal)[0]
    if (candidate === undefined) return 'IDLE'

    let claimed = candidate
    if (candidate.status === 'RUN2SKILL_OWNED') {
      let didClaim = false
      claimed = await this.#intents.update(candidate.intentId, current => {
        const intent = ExperienceIntentV2Schema.parse(current)
        if (intent.status !== 'RUN2SKILL_OWNED') return intent
        didClaim = true
        return ExperienceIntentV2Schema.parse({
          ...intent,
          revision: intent.revision + 1,
          status: 'RECALLING',
          recall: {
            state: 'SCANNING', complete: false, summaryScanComplete: false,
            summaryClassifications: [], candidates: [],
          },
          updatedAt: this.#isoNow(),
        })
      })
      if (!didClaim) return 'PROCESSED'
    }
    await this.#resume(claimed.intentId)
    return 'PROCESSED'
  }

  async recover(): Promise<void> {
    const recalling = [...this.#intents.entries()]
      .map(([, value]) => ExperienceIntentV2Schema.parse(value))
      .filter(intent => intent.status === 'RECALLING')
    for (const intent of recalling) {
      const reserved = intent.recall.scanPlanDigest === undefined || intent.recall.scanPageCount === undefined
        ? undefined
        : intent.stageCalls.find(call => (
          call.stage === 'CATALOG_SCAN'
          && call.outcome === 'RESERVED'
          && call.ordinal <= intent.recall.scanPageCount!
          && call.callId === callId(intent.intentId, intent.recall.scanPlanDigest!, call.ordinal)
        ))
      if (reserved === undefined) continue
      await this.#intents.update(intent.intentId, current => {
        const parsed = ExperienceIntentV2Schema.parse(current)
        if (parsed.status !== 'RECALLING') return parsed
        return ExperienceIntentV2Schema.parse({
          ...parsed,
          revision: parsed.revision + 1,
          status: 'NEEDS_ATTENTION',
          recall: {
            ...parsed.recall,
            state: 'INCOMPLETE', complete: false, summaryScanComplete: false,
            incompleteReason: 'CATALOG_SCAN_OUTCOME_UNKNOWN',
          },
          stageCalls: parsed.stageCalls.map(call => call.callId === reserved.callId
            ? { ...call, outcome: 'OUTCOME_UNKNOWN', failureCode: 'CATALOG_SCAN_OUTCOME_UNKNOWN' }
            : call),
          updatedAt: this.#isoNow(),
        })
      })
    }
  }

  async #resume(intentId: string): Promise<void> {
    let intent = ExperienceIntentV2Schema.parse(this.#intents.get(intentId))
    if (intent.status !== 'RECALLING') return
    const batchValue = this.#batches.get(intent.batchId)
    if (batchValue === undefined) {
      await this.#commitIncomplete(intentId, 'RECALL_INPUT_UNAVAILABLE')
      return
    }
    const batchResult = SessionBatchV2Schema.safeParse(batchValue)
    if (!batchResult.success) {
      await this.#commitIncomplete(intentId, 'RECALL_INPUT_UNAVAILABLE')
      return
    }
    const batch = batchResult.data

    const snapshot = await this.#snapshot(batch, intent)
    if (snapshot === undefined || !snapshot.complete) {
      await this.#commitIncomplete(intentId, 'CATALOG_INCOMPLETE')
      return
    }
    const plan = this.#plan(intent, batch, snapshot)
    if (plan === undefined || plan.pages.length > this.#policy.maxCatalogScanCalls) {
      await this.#commitIncomplete(intentId, 'CATALOG_SCAN_BUDGET_EXHAUSTED')
      return
    }
    if (intent.recall.scanPlanDigest === undefined) {
      intent = await this.#commitPlan(intentId, batch, snapshot, plan)
    } else if (!this.#snapshotMatchesIntent(snapshot, intent) || intent.recall.scanPlanDigest !== plan.digest) {
      await this.#commitIncomplete(intentId, 'CATALOG_CHANGED')
      return
    }

    for (const page of plan.pages) {
      intent = ExperienceIntentV2Schema.parse(this.#intents.get(intentId))
      if (intent.status !== 'RECALLING') return
      const expectedCallId = callId(intent.intentId, plan.digest, page.ordinal)
      if (intent.stageCalls.some(call => (
        call.stage === 'CATALOG_SCAN'
        && call.callId === expectedCallId
        && call.inputDigest === page.inputDigest
        && call.provider === batch.routeSnapshot.provider
        && call.model === batch.routeSnapshot.model
        && call.policyVersion === this.#policy.policyVersion
        && call.outcome === 'SUCCEEDED'
      ))) continue
      const reserved = await this.#reservePage(intent, batch, plan, page)
      if (!reserved) return
      let raw: unknown
      try {
        raw = await this.#classifier.classify({
          intent: this.#intentProjection(intent), summaries: page.summaries,
          pageOrdinal: page.ordinal, inputDigest: page.inputDigest, route: batch.routeSnapshot,
        })
      } catch {
        await this.#finishFailedCall(intentId, callId(intent.intentId, plan.digest, page.ordinal), 'CATALOG_SCAN_FAILED')
        return
      }
      const parsed = classifierOutputSchema.safeParse(raw)
      if (!parsed.success || !this.#classificationsMatchPage(parsed.data.classifications, page)) {
        await this.#finishInvalidCall(intentId, callId(intent.intentId, plan.digest, page.ordinal), this.#outputDigest(raw))
        return
      }
      const outputDigest = deriveCatalogScanOutputDigestV2(parsed.data.classifications)
      await this.#finishSuccessfulPage(intentId, page, plan, parsed.data.classifications, outputDigest)
    }

    intent = ExperienceIntentV2Schema.parse(this.#intents.get(intentId))
    if (intent.status !== 'RECALLING') return
    const beforeRead = await this.#snapshot(batch, intent)
    if (beforeRead === undefined || !beforeRead.complete || !this.#snapshotMatchesIntent(beforeRead, intent)) {
      await this.#commitIncomplete(intentId, 'CATALOG_CHANGED')
      return
    }
    const loaded = await this.#loadCandidates(batch, intent, beforeRead)
    if (loaded === undefined) return
    if (loaded.length > 0) {
      const afterRead = await this.#snapshot(batch, intent)
      if (afterRead === undefined || !afterRead.complete || !this.#snapshotMatchesIntent(afterRead, intent)) {
        await this.#commitIncomplete(intentId, 'CATALOG_CHANGED', loaded)
        return
      }
    }
    const unavailable = loaded.some(candidate => candidate.capability === 'UNAVAILABLE')
    if (unavailable) {
      await this.#commitIncomplete(intentId, 'RELEVANT_CANDIDATE_UNAVAILABLE', loaded, true)
      return
    }
    await this.#commitComplete(intentId, loaded)
  }

  async #snapshot(batch: SessionBatchV2, intent: ExperienceIntentV2): Promise<RecallCatalogSnapshot | undefined> {
    try {
      const parsed = snapshotSchema.safeParse(await this.#catalog.snapshot({ batch, intent }))
      if (!parsed.success) return undefined
      return {
        ...parsed.data,
        summaries: parsed.data.summaries.map(summaryProjection).sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
      }
    } catch {
      return undefined
    }
  }

  #plan(intent: ExperienceIntentV2, batch: SessionBatchV2, snapshot: RecallCatalogSnapshot): ScanPlan | undefined {
    const summaries = [...snapshot.summaries].sort((left, right) => left.candidateId.localeCompare(right.candidateId))
    const scanBindingDigest = deriveCatalogScanBindingDigestV2({
      intentId: intent.intentId,
      scanBasisRevision: intent.recall.scanBasisRevision ?? intent.revision,
      selfExclusionDigest: intent.recall.selfExclusion?.selfExclusionDigest,
      provider: batch.routeSnapshot.provider,
      model: batch.routeSnapshot.model,
      policyVersion: this.#policy.policyVersion,
    })
    const fixedBytes = Buffer.byteLength(canonicalJson({
      intent: this.#intentProjection(intent),
      route: batch.routeSnapshot,
      catalogs: this.#catalogFacts(snapshot),
      scanBindingDigest,
      protocol: this.#policy.policyVersion,
    }), 'utf8') + this.#policy.catalogScanReserveBytes
    const pageBudget = batch.routeSnapshot.maxInputBytes - fixedBytes
    if (pageBudget < 1 && summaries.length > 0) return undefined
    const rawPages: RecallCatalogSummary[][] = []
    let page: RecallCatalogSummary[] = []
    let used = 2
    for (const summary of summaries) {
      const bytes = Buffer.byteLength(canonicalJson(summary), 'utf8') + 1
      if (bytes > pageBudget) return undefined
      if (page.length > 0 && used + bytes > pageBudget) {
        rawPages.push(page)
        page = []
        used = 2
      }
      page.push(summary)
      used += bytes
    }
    if (page.length > 0) rawPages.push(page)
    const pages = rawPages.map((items, index) => {
      const ordinal = index + 1
      return {
        ordinal,
        summaries: items,
        membershipDigest: deriveCatalogScanMembershipDigestV2(items.map(item => ({
          candidateId: item.candidateId, summaryDigest: summaryDigest(item),
        }))),
        inputDigest: sha256Utf8(canonicalJson({
          intent: this.#intentProjection(intent),
          route: batch.routeSnapshot,
          catalogs: this.#catalogFacts(snapshot),
          scanBindingDigest,
          policyVersion: this.#policy.policyVersion,
          ordinal,
          summaries: items,
        })),
      }
    })
    return {
      pages,
      digest: deriveCatalogScanPlanDigestV2({
        policyVersion: this.#policy.policyVersion,
        ...this.#catalogFacts(snapshot),
        scanBindingDigest,
        pages: pages.map(item => ({
          ordinal: item.ordinal, inputDigest: item.inputDigest, membershipDigest: item.membershipDigest,
        })),
      }),
    }
  }

  async #commitPlan(
    intentId: string,
    batch: SessionBatchV2,
    snapshot: RecallCatalogSnapshot,
    plan: ScanPlan,
  ): Promise<ExperienceIntentV2> {
    return this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (intent.status !== 'RECALLING' || intent.recall.scanPlanDigest !== undefined) return intent
      return ExperienceIntentV2Schema.parse({
        ...intent,
        revision: intent.revision + 1,
        recall: {
          ...intent.recall,
          runtimeCatalogDigest: snapshot.runtimeCatalogDigest,
          pendingCatalogDigest: snapshot.pendingCatalogDigest,
          catalogEpoch: snapshot.catalogEpoch,
          catalogMutationReceiptDigest: snapshot.catalogMutationReceiptDigest,
          scanBasisRevision: intent.revision,
          scanRouteProvider: batch.routeSnapshot.provider,
          scanRouteModel: batch.routeSnapshot.model,
          scanPolicyVersion: this.#policy.policyVersion,
          scanBindingDigest: deriveCatalogScanBindingDigestV2({
            intentId: intent.intentId,
            scanBasisRevision: intent.revision,
            selfExclusionDigest: intent.recall.selfExclusion?.selfExclusionDigest,
            provider: batch.routeSnapshot.provider,
            model: batch.routeSnapshot.model,
            policyVersion: this.#policy.policyVersion,
          }),
          scanPlanDigest: plan.digest,
          scanPageCount: plan.pages.length,
          scanSummaryCount: plan.pages.reduce((total, page) => total + page.summaries.length, 0),
          scanPages: plan.pages.map(page => ({
            ordinal: page.ordinal, itemCount: page.summaries.length,
            inputDigest: page.inputDigest, membershipDigest: page.membershipDigest,
          })),
          summaryClassifications: [],
        },
        updatedAt: this.#isoNow(),
      })
    })
  }

  async #reservePage(intent: ExperienceIntentV2, batch: SessionBatchV2, plan: ScanPlan, page: ScanPage): Promise<boolean> {
    let didReserve = false
    const id = callId(intent.intentId, plan.digest, page.ordinal)
    await this.#intents.update(intent.intentId, current => {
      const parsed = ExperienceIntentV2Schema.parse(current)
      if (parsed.status !== 'RECALLING') return parsed
      if (parsed.stageCalls.some(call => call.callId === id)) return parsed
      didReserve = true
      return ExperienceIntentV2Schema.parse({
        ...parsed,
        revision: parsed.revision + 1,
        stageCalls: [...parsed.stageCalls, {
          stage: 'CATALOG_SCAN', intentRevision: parsed.revision,
          callId: id, ordinal: page.ordinal, itemCount: page.summaries.length, inputDigest: page.inputDigest,
          provider: batch.routeSnapshot.provider, model: batch.routeSnapshot.model,
          policyVersion: this.#policy.policyVersion, outcome: 'RESERVED',
        }],
        updatedAt: this.#isoNow(),
      })
    })
    return didReserve
  }

  async #finishSuccessfulPage(
    intentId: string,
    page: ScanPage,
    plan: ScanPlan,
    classifications: readonly { candidateId: string; classification: 'RELEVANT' | 'POSSIBLE' | 'UNRELATED' }[],
    outputDigest: string,
  ): Promise<void> {
    const id = callId(intentId, plan.digest, page.ordinal)
    await this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (intent.status !== 'RECALLING') return intent
      const call = intent.stageCalls.find(item => item.callId === id)
      if (call?.outcome !== 'RESERVED') return intent
      const byId = new Map(classifications.map(item => [item.candidateId, item.classification]))
      const records = page.summaries.map(summary => ({
        candidateId: summary.candidateId,
        summaryDigest: summaryDigest(summary),
        classification: byId.get(summary.candidateId)!,
        pageOrdinal: page.ordinal,
        callId: id,
        inputDigest: page.inputDigest,
        outputDigest,
      }))
      return ExperienceIntentV2Schema.parse({
        ...intent,
        revision: intent.revision + 1,
        recall: {
          ...intent.recall,
          summaryClassifications: [...(intent.recall.summaryClassifications ?? []), ...records]
            .sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
        },
        stageCalls: intent.stageCalls.map(item => item.callId === id
          ? { ...item, outcome: 'SUCCEEDED', outputDigest }
          : item),
        updatedAt: this.#isoNow(),
      })
    })
  }

  async #finishFailedCall(intentId: string, id: string, failureCode: string): Promise<void> {
    await this.#finishCallWithAttention(intentId, id, 'FAILED', failureCode)
  }

  async #finishInvalidCall(intentId: string, id: string, outputDigest: string): Promise<void> {
    await this.#finishCallWithAttention(intentId, id, 'SUCCEEDED', 'INVALID_CATALOG_SCAN_OUTPUT', outputDigest)
  }

  async #finishCallWithAttention(
    intentId: string,
    id: string,
    outcome: 'SUCCEEDED' | 'FAILED',
    failureCode: string,
    outputDigest?: string,
  ): Promise<void> {
    await this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (intent.status !== 'RECALLING') return intent
      return ExperienceIntentV2Schema.parse({
        ...intent,
        revision: intent.revision + 1,
        status: 'NEEDS_ATTENTION',
        recall: {
          ...intent.recall,
          state: 'INCOMPLETE', complete: false, summaryScanComplete: false,
          incompleteReason: failureCode,
        },
        stageCalls: intent.stageCalls.map(call => call.callId === id
          ? { ...call, outcome, failureCode, ...(outputDigest === undefined ? {} : { outputDigest }) }
          : call),
        updatedAt: this.#isoNow(),
      })
    })
  }

  async #loadCandidates(batch: SessionBatchV2, intent: ExperienceIntentV2, snapshot: RecallCatalogSnapshot) {
    const classifications = intent.recall.summaryClassifications ?? []
    const relevant = classifications.filter(item => item.classification !== 'UNRELATED')
    const summaries = new Map(snapshot.summaries.map(item => [item.candidateId, item]))
    const result: Array<{
      candidateId: string
      summary: Omit<RecallCatalogSummary, 'candidateId' | 'rootIdentityDigest'>
      classification: 'RELEVANT' | 'POSSIBLE'
      capability: 'AVAILABLE' | 'READABLE_NOT_MERGEABLE' | 'UNAVAILABLE'
      bodyDigest?: string
      unavailableReason?: 'CANDIDATE_DISAPPEARED' | 'IDENTITY_CHANGED' | 'READ_FAILED' | 'INPUT_BUDGET_EXCEEDED'
    }> = []
    for (const classification of relevant) {
      const summary = summaries.get(classification.candidateId)
      if (summary === undefined || summaryDigest(summary) !== classification.summaryDigest) {
        await this.#commitIncomplete(intent.intentId, 'CATALOG_CHANGED')
        return undefined
      }
      let raw: RecallCatalogDefinition | undefined
      try {
        raw = await this.#catalog.read({ candidateId: summary.candidateId, batch, intent })
      } catch {
        const { candidateId: _candidateId, rootIdentityDigest: _rootIdentityDigest, ...projected } = summary
        result.push({
          candidateId: summary.candidateId, summary: projected,
          classification: classification.classification as 'RELEVANT' | 'POSSIBLE',
          capability: 'UNAVAILABLE', unavailableReason: 'READ_FAILED',
        })
        continue
      }
      const parsed = definitionSchema.safeParse(raw)
      const { candidateId: _candidateId, rootIdentityDigest: _rootIdentityDigest, ...projected } = summary
      if (!parsed.success) {
        result.push({
          candidateId: summary.candidateId, summary: projected,
          classification: classification.classification as 'RELEVANT' | 'POSSIBLE',
          capability: 'UNAVAILABLE', unavailableReason: raw === undefined ? 'CANDIDATE_DISAPPEARED' : 'READ_FAILED',
        })
        continue
      }
      const { content, ...loadedSummary } = parsed.data
      if (canonicalJson(summaryProjection(loadedSummary)) !== canonicalJson(summaryProjection(summary))) {
        result.push({
          candidateId: summary.candidateId, summary: projected,
          classification: classification.classification as 'RELEVANT' | 'POSSIBLE',
          capability: 'UNAVAILABLE', unavailableReason: 'IDENTITY_CHANGED',
        })
        continue
      }
      const sanitized = preprocessPersistentText(content).text
      const availableBytes = this.#coverageCandidateBudget(batch, intent, summary)
      if (Buffer.byteLength(sanitized, 'utf8') > availableBytes) {
        result.push({
          candidateId: summary.candidateId, summary: projected,
          classification: classification.classification as 'RELEVANT' | 'POSSIBLE',
          capability: 'UNAVAILABLE', unavailableReason: 'INPUT_BUDGET_EXCEEDED',
        })
        continue
      }
      const mergeable = summary.writable && summary.scope === intent.persistenceScope
      result.push({
        candidateId: summary.candidateId, summary: projected,
        classification: classification.classification as 'RELEVANT' | 'POSSIBLE',
        capability: mergeable ? 'AVAILABLE' : 'READABLE_NOT_MERGEABLE',
        bodyDigest: sha256Utf8(content),
      })
    }
    return result
  }

  #coverageCandidateBudget(batch: SessionBatchV2, intent: ExperienceIntentV2, summary: RecallCatalogSummary): number {
    const fixed = Buffer.byteLength(canonicalJson({
      intent: this.#intentProjection(intent),
      candidate: summary,
      route: batch.routeSnapshot,
      protocol: 'coverage-v1',
    }), 'utf8') + this.#policy.coverageReserveBytes
    return Math.max(0, batch.routeSnapshot.maxInputBytes - fixed)
  }

  async #commitComplete(intentId: string, candidates: readonly unknown[]): Promise<void> {
    await this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (intent.status !== 'RECALLING') return intent
      return ExperienceIntentV2Schema.parse({
        ...intent,
        revision: intent.revision + 1,
        status: 'COVERAGE_READY',
        recall: {
          ...intent.recall,
          state: 'COMPLETE', complete: true, summaryScanComplete: true,
          candidates,
        },
        updatedAt: this.#isoNow(),
      })
    })
  }

  async #commitIncomplete(
    intentId: string,
    reason: string,
    candidates?: readonly unknown[],
    summaryScanComplete = false,
  ): Promise<void> {
    await this.#intents.update(intentId, current => {
      const intent = ExperienceIntentV2Schema.parse(current)
      if (intent.status !== 'RECALLING') return intent
      return ExperienceIntentV2Schema.parse({
        ...intent,
        revision: intent.revision + 1,
        status: 'NEEDS_ATTENTION',
        recall: {
          ...intent.recall,
          state: 'INCOMPLETE', complete: false, summaryScanComplete,
          incompleteReason: reason,
          ...(candidates === undefined ? {} : { candidates }),
        },
        updatedAt: this.#isoNow(),
      })
    })
  }

  #snapshotMatchesIntent(snapshot: RecallCatalogSnapshot, intent: ExperienceIntentV2): boolean {
    const plan = this.#batches.get(intent.batchId)
    const batchResult = plan === undefined ? undefined : SessionBatchV2Schema.safeParse(plan)
    if (!batchResult?.success) return false
    const expected = this.#plan(intent, batchResult.data, snapshot)
    return (
      snapshot.runtimeCatalogDigest === intent.recall.runtimeCatalogDigest
      && snapshot.pendingCatalogDigest === intent.recall.pendingCatalogDigest
      && snapshot.catalogEpoch === intent.recall.catalogEpoch
      && snapshot.catalogMutationReceiptDigest === intent.recall.catalogMutationReceiptDigest
      && expected?.digest === intent.recall.scanPlanDigest
    )
  }

  #classificationsMatchPage(
    classifications: readonly { candidateId: string }[],
    page: ScanPage,
  ): boolean {
    const actual = classifications.map(item => item.candidateId).sort()
    const expected = page.summaries.map(item => item.candidateId).sort()
    return new Set(actual).size === actual.length && canonicalJson(actual) === canonicalJson(expected)
  }

  #catalogFacts(snapshot: RecallCatalogSnapshot) {
    return {
      runtimeCatalogDigest: snapshot.runtimeCatalogDigest,
      pendingCatalogDigest: snapshot.pendingCatalogDigest,
      catalogEpoch: snapshot.catalogEpoch,
      catalogMutationReceiptDigest: snapshot.catalogMutationReceiptDigest,
    }
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

  #outputDigest(raw: unknown): string {
    try {
      return sha256Utf8(canonicalJson(raw))
    } catch {
      return sha256Utf8('[UNSERIALIZABLE_CATALOG_SCAN_OUTPUT]')
    }
  }

  #isoNow(): string {
    return new Date(this.#now()).toISOString()
  }
}
