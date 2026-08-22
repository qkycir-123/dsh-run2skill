import { posix, win32 } from 'node:path'
import { z } from 'zod'
import type { Run2skillV2Domain } from '../dsh-storage/v2-types.js'
import { derivePendingProposalCatalogV2, type PendingProposalCatalogEntryV2 } from '../dsh-storage/v2-pending-catalog.js'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import { deriveRecallCandidateId, type CompleteRecallCatalogPort, type RecallCatalogDefinition, type RecallCatalogSnapshot, type RecallCatalogSummary } from '../../application/recall/index.js'
import type { GenerationCatalogPort, GenerationCatalogSnapshot } from '../../application/generation/index.js'
import type { ExperienceIntentV2, SessionBatchV2 } from '../../domain/v2/index.js'
import type { DshSkillRegistryPort } from './skill-catalog.js'

const identity = z.string().min(1).max(256)
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/)
const utf8Limited = (maxBytes: number) => z.string().refine(
  value => Buffer.byteLength(value, 'utf8') <= maxBytes,
  `Expected at most ${maxBytes} UTF-8 bytes`,
)
const resourceBaseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('directory'), path: z.string().min(1).max(32 * 1024) }).strict(),
  z.object({ kind: z.literal('url'), url: z.string().min(1).max(32 * 1024) }).strict(),
  z.object({ kind: z.literal('opaque'), description: z.string().min(1).max(4096) }).strict(),
])
const runtimeSummarySchema = z.object({
  name: z.string().min(1).max(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: utf8Limited(2 * 1024),
  whenToUse: utf8Limited(4 * 1024).optional(),
  invocation: z.object({ modelInvocable: z.boolean(), userInvocable: z.boolean() }).strict().optional(),
  source: identity,
  provider: identity,
  resourceBase: resourceBaseSchema.optional(),
}).passthrough()
const runtimeSnapshotSchema = z.object({
  complete: z.boolean(),
  skills: z.array(runtimeSummarySchema).max(1024),
}).passthrough()
const runtimeDefinitionSchema = runtimeSummarySchema.safeExtend({ content: z.string() }).passthrough()

type RuntimeSummary = z.infer<typeof runtimeSummarySchema>

export interface V2RuntimeCatalogIdentity {
  readonly scope: 'PROJECT' | 'USER'
  readonly writable: boolean
  readonly rootIdentityDigest: string
}

export interface V2StockWritableRootBinding {
  readonly scope: 'PROJECT' | 'USER'
  readonly expectedProvider: 'filesystem'
  readonly expectedSource: 'project-dsh' | 'user-dsh'
  readonly canonicalRootPath: string
}

export interface DshV2CatalogAdapterOptions<TView extends object> {
  readonly registry: DshSkillRegistryPort<TView>
  readonly resolveView: (sessionLifecycleKey: string) => TView | undefined
  readonly resolveStockWritableRoot?: (
    summary: RuntimeSummary,
    view: TView,
  ) => V2StockWritableRootBinding | undefined
  readonly resolveRuntimeIdentity?: (
    summary: RuntimeSummary,
    view: TView,
    context: { readonly sessionLifecycleKey: string },
  ) => V2RuntimeCatalogIdentity | undefined
}

interface RuntimeCandidate {
  readonly kind: 'RUNTIME'
  readonly raw: RuntimeSummary
  readonly summary: RecallCatalogSummary
}

interface PendingCandidate {
  readonly kind: 'PENDING'
  readonly entry: PendingProposalCatalogEntryV2
  readonly summary: RecallCatalogSummary
}

type Candidate = RuntimeCandidate | PendingCandidate

interface CapturedCatalog {
  readonly complete: boolean
  readonly runtimeCatalogDigest: string
  readonly pendingCatalogDigest: string
  readonly externalPendingDigest: string
  readonly catalogEpoch: number
  readonly catalogMutationReceiptDigest: string
  readonly summaries: readonly RecallCatalogSummary[]
  readonly candidates: ReadonlyMap<string, Candidate>
}

const EMPTY_DIGEST = sha256Utf8(canonicalJson([]))

function pathApi(value: string): typeof win32 | typeof posix {
  return /^[a-zA-Z]:[\\/]/u.test(value) || value.includes('\\') ? win32 : posix
}

function canonicalPath(value: string): string {
  const api = pathApi(value)
  const normalized = api.resolve(value)
  return api === win32 ? normalized.toLowerCase() : normalized
}

function stockRuntimeIdentity(
  summary: RuntimeSummary,
  sessionLifecycleKey: string,
  stockWritableRoot: V2StockWritableRootBinding | undefined,
): V2RuntimeCatalogIdentity {
  const scope = summary.source === 'project-dsh' || summary.source === 'project-agents' || summary.source === 'runtime'
    ? 'PROJECT'
    : summary.source === 'user-dsh'
        || summary.source === 'user-agents'
        || summary.source === 'bundled'
        || summary.source === 'custom'
      ? 'USER'
      : 'PROJECT'
  const trustedStockBundle = stockWritableRoot !== undefined
    && summary.provider === stockWritableRoot.expectedProvider
    && summary.source === stockWritableRoot.expectedSource
    && scope === stockWritableRoot.scope
    && summary.resourceBase?.kind === 'directory'
    && canonicalPath(summary.resourceBase.path) === canonicalPath(
      pathApi(stockWritableRoot.canonicalRootPath).join(stockWritableRoot.canonicalRootPath, summary.name),
    )
  if (trustedStockBundle) {
    const root = canonicalPath(stockWritableRoot.canonicalRootPath)
    return {
      scope,
      writable: true,
      rootIdentityDigest: sha256Utf8(canonicalJson({
        contract: 'dsh-public-skill-resource-base-v1',
        provider: summary.provider,
        source: summary.source,
        scope,
        root,
      })),
    }
  }
  const resourceIdentity = summary.resourceBase?.kind === 'directory'
    ? { kind: 'directory', path: canonicalPath(summary.resourceBase.path) }
    : summary.resourceBase
  return {
    scope,
    writable: false,
    rootIdentityDigest: sha256Utf8(canonicalJson({
      contract: 'dsh-public-skill-winner-v2',
      provider: summary.provider,
      source: summary.source,
      scope,
      resourceIdentity: resourceIdentity ?? {
        kind: 'exact-session-view',
        sessionLifecycleKey,
      },
      layout: 'READ_ONLY',
    })),
  }
}

function pendingRootIdentity(entry: PendingProposalCatalogEntryV2): string {
  return sha256Utf8(canonicalJson({
    contract: 'run2skill-v2-pending-root-v1',
    provider: 'run2skill-pending',
    source: entry.source,
    scope: entry.persistenceScope,
    scopeIdentityDigest: entry.scopeIdentityDigest,
  }))
}

function sameState(left: CapturedCatalog, right: CapturedCatalog): boolean {
  return left.complete && right.complete
    && left.runtimeCatalogDigest === right.runtimeCatalogDigest
    && left.pendingCatalogDigest === right.pendingCatalogDigest
    && left.externalPendingDigest === right.externalPendingDigest
    && left.catalogEpoch === right.catalogEpoch
    && left.catalogMutationReceiptDigest === right.catalogMutationReceiptDigest
}

export class DshV2CatalogAdapter<TView extends object> {
  readonly recall: CompleteRecallCatalogPort
  readonly generation: GenerationCatalogPort
  readonly #domain: Run2skillV2Domain
  readonly #registry: DshSkillRegistryPort<TView>
  readonly #resolveView: DshV2CatalogAdapterOptions<TView>['resolveView']
  readonly #resolveRuntimeIdentity: NonNullable<DshV2CatalogAdapterOptions<TView>['resolveRuntimeIdentity']>

  constructor(domain: Run2skillV2Domain, options: DshV2CatalogAdapterOptions<TView>) {
    this.#domain = domain
    this.#registry = options.registry
    this.#resolveView = options.resolveView
    this.#resolveRuntimeIdentity = options.resolveRuntimeIdentity
      ?? ((summary, view, context) => stockRuntimeIdentity(
        summary,
        context.sessionLifecycleKey,
        options.resolveStockWritableRoot?.(summary, view),
      ))
    this.recall = {
      snapshot: async input => this.#recallSnapshot(input.batch, input.intent),
      read: async input => this.#read(input.candidateId, input.batch, input.intent),
    }
    this.generation = {
      snapshot: async input => this.#generationSnapshot(input.batch, input.intent, input.exclude),
      read: async input => this.#read(input.candidateId, input.batch, input.intent),
    }
  }

  async #recallSnapshot(batch: SessionBatchV2, intent: ExperienceIntentV2): Promise<RecallCatalogSnapshot> {
    const captured = await this.#capture(batch, intent)
    return {
      complete: captured.complete,
      runtimeCatalogDigest: captured.runtimeCatalogDigest,
      pendingCatalogDigest: captured.pendingCatalogDigest,
      catalogEpoch: captured.catalogEpoch,
      catalogMutationReceiptDigest: captured.catalogMutationReceiptDigest,
      summaries: [...captured.summaries],
    }
  }

  async #generationSnapshot(
    batch: SessionBatchV2,
    intent: ExperienceIntentV2,
    exclude: Parameters<GenerationCatalogPort['snapshot']>[0]['exclude'],
  ): Promise<GenerationCatalogSnapshot> {
    const captured = await this.#capture(batch, intent, exclude)
    return {
      complete: captured.complete,
      runtimeCatalogDigest: captured.runtimeCatalogDigest,
      pendingCatalogDigest: captured.pendingCatalogDigest,
      externalPendingDigest: captured.externalPendingDigest,
      catalogEpoch: captured.catalogEpoch,
      catalogMutationReceiptDigest: captured.catalogMutationReceiptDigest,
    }
  }

  async #capture(
    batch: SessionBatchV2,
    intent: ExperienceIntentV2,
    exclude?: Parameters<GenerationCatalogPort['snapshot']>[0]['exclude'],
    exactView?: TView,
  ): Promise<CapturedCatalog> {
    const view = exactView ?? this.#resolveView(batch.sessionLifecycleKey)
    if (view === undefined || intent.sessionLifecycleKey !== batch.sessionLifecycleKey) {
      return this.#incomplete()
    }
    const firstRuntime = await this.#runtime(view, batch.sessionLifecycleKey)
    const pending = derivePendingProposalCatalogV2(this.#domain, intent)
    const secondRuntime = await this.#runtime(view, batch.sessionLifecycleKey)
    if (
      !firstRuntime.complete
      || !secondRuntime.complete
      || firstRuntime.digest !== secondRuntime.digest
      || !pending.complete
    ) return this.#incomplete(pending)

    const candidates = new Map<string, Candidate>()
    const summaries: RecallCatalogSummary[] = []
    for (const candidate of firstRuntime.candidates) {
      if (candidates.has(candidate.summary.candidateId)) return this.#incomplete(pending)
      candidates.set(candidate.summary.candidateId, candidate)
      summaries.push(candidate.summary)
    }
    for (const entry of pending.entries) {
      const rootIdentityDigest = pendingRootIdentity(entry)
      const summary: RecallCatalogSummary = {
        candidateId: deriveRecallCandidateId({
          provider: 'run2skill-pending',
          source: entry.source,
          scope: entry.persistenceScope,
          name: entry.name,
          rootIdentityDigest,
        }),
        name: entry.name,
        description: entry.description,
        ...(entry.whenToUse === undefined ? {} : { whenToUse: entry.whenToUse }),
        provider: 'run2skill-pending',
        source: entry.source,
        scope: entry.persistenceScope,
        writable: false,
        rootIdentityDigest,
      }
      if (candidates.has(summary.candidateId)) return this.#incomplete(pending)
      const candidate: PendingCandidate = { kind: 'PENDING', entry, summary }
      candidates.set(summary.candidateId, candidate)
      const selfExclusion = intent.recall.selfExclusion
      const exactSelfBarrier = entry.source === 'generation-barrier'
        && selfExclusion !== undefined
        && entry.candidateKey === intent.duplicateBarrier?.barrierId
        && intent.duplicateBarrier.intentId === selfExclusion.intentId
        && intent.duplicateBarrier.priorGenerationRevision === selfExclusion.priorGenerationRevision
        && intent.duplicateBarrier.mutationReceiptDigest === selfExclusion.barrierReceiptDigest
      if (!exactSelfBarrier) summaries.push(summary)
    }
    summaries.sort((left, right) => left.candidateId.localeCompare(right.candidateId))
    const externallyVisiblePending = exclude === undefined
      ? pending.entries
      : pending.entries.filter(entry => !(
          entry.source === 'sealed-generation-result'
          && entry.candidateKey === exclude.resultId
          && entry.generationResultReceiptDigest === exclude.receiptDigest
        ))
    return {
      complete: true,
      runtimeCatalogDigest: firstRuntime.digest,
      pendingCatalogDigest: pending.digest,
      externalPendingDigest: sha256Utf8(canonicalJson(externallyVisiblePending)),
      catalogEpoch: pending.catalogEpoch,
      catalogMutationReceiptDigest: pending.catalogMutationReceiptDigest,
      summaries,
      candidates,
    }
  }

  async #runtime(view: TView, sessionLifecycleKey: string): Promise<{
    readonly complete: boolean
    readonly digest: string
    readonly candidates: readonly RuntimeCandidate[]
  }> {
    let raw: unknown
    try {
      raw = await this.#registry.snapshot(view)
    } catch {
      return { complete: false, digest: EMPTY_DIGEST, candidates: [] }
    }
    const parsed = runtimeSnapshotSchema.safeParse(raw)
    if (!parsed.success || !parsed.data.complete) return { complete: false, digest: EMPTY_DIGEST, candidates: [] }
    const candidates: RuntimeCandidate[] = []
    const ids = new Set<string>()
    for (const rawSummary of parsed.data.skills) {
      const runtimeIdentity = this.#resolveRuntimeIdentity(rawSummary, view, { sessionLifecycleKey })
      if (runtimeIdentity === undefined || !sha256Hex.safeParse(runtimeIdentity.rootIdentityDigest).success) {
        return { complete: false, digest: EMPTY_DIGEST, candidates: [] }
      }
      const summary: RecallCatalogSummary = {
        candidateId: deriveRecallCandidateId({
          provider: rawSummary.provider,
          source: rawSummary.source,
          scope: runtimeIdentity.scope,
          name: rawSummary.name,
          rootIdentityDigest: runtimeIdentity.rootIdentityDigest,
        }),
        name: rawSummary.name,
        description: rawSummary.description,
        ...(rawSummary.whenToUse === undefined ? {} : { whenToUse: rawSummary.whenToUse }),
        provider: rawSummary.provider,
        source: rawSummary.source,
        scope: runtimeIdentity.scope,
        writable: runtimeIdentity.writable,
        rootIdentityDigest: runtimeIdentity.rootIdentityDigest,
      }
      if (ids.has(summary.candidateId)) return { complete: false, digest: EMPTY_DIGEST, candidates: [] }
      ids.add(summary.candidateId)
      candidates.push({ kind: 'RUNTIME', raw: rawSummary, summary })
    }
    candidates.sort((left, right) => left.summary.candidateId.localeCompare(right.summary.candidateId))
    return { complete: true, digest: sha256Utf8(canonicalJson(candidates.map(item => item.summary))), candidates }
  }

  async #read(
    candidateId: string,
    batch: SessionBatchV2,
    intent: ExperienceIntentV2,
  ): Promise<RecallCatalogDefinition | undefined> {
    const view = this.#resolveView(batch.sessionLifecycleKey)
    if (view === undefined) return undefined
    const before = await this.#capture(batch, intent, undefined, view)
    if (!before.complete) return undefined
    const candidate = before.candidates.get(candidateId)
    if (candidate === undefined) return undefined
    let content: string | undefined
    if (candidate.kind === 'PENDING') {
      content = candidate.entry.capability === 'FULL_BODY' ? candidate.entry.exactSkillBytes : undefined
    } else {
      let raw: unknown
      try {
        raw = await this.#registry.get(candidate.raw.name, view)
      } catch {
        return undefined
      }
      const definition = runtimeDefinitionSchema.safeParse(raw)
      if (!definition.success) return undefined
      const runtimeIdentity = this.#resolveRuntimeIdentity(
        definition.data,
        view,
        { sessionLifecycleKey: batch.sessionLifecycleKey },
      )
      if (runtimeIdentity === undefined) return undefined
      const loadedId = deriveRecallCandidateId({
        provider: definition.data.provider,
        source: definition.data.source,
        scope: runtimeIdentity.scope,
        name: definition.data.name,
        rootIdentityDigest: runtimeIdentity.rootIdentityDigest,
      })
      const loadedSummary = {
        candidateId: loadedId,
        name: definition.data.name,
        description: definition.data.description,
        ...(definition.data.whenToUse === undefined ? {} : { whenToUse: definition.data.whenToUse }),
        provider: definition.data.provider,
        source: definition.data.source,
        scope: runtimeIdentity.scope,
        writable: runtimeIdentity.writable,
        rootIdentityDigest: runtimeIdentity.rootIdentityDigest,
      }
      if (canonicalJson(loadedSummary) !== canonicalJson(candidate.summary)) return undefined
      content = definition.data.content
    }
    if (content === undefined) return undefined
    const after = await this.#capture(batch, intent, undefined, view)
    if (!sameState(before, after)) return undefined
    const afterCandidate = after.candidates.get(candidateId)
    if (afterCandidate === undefined || canonicalJson(afterCandidate.summary) !== canonicalJson(candidate.summary)) return undefined
    if (
      candidate.kind === 'PENDING'
      && (afterCandidate.kind !== 'PENDING' || afterCandidate.entry.bodyDigest !== candidate.entry.bodyDigest)
    ) return undefined
    return { ...candidate.summary, content }
  }

  #incomplete(pending?: ReturnType<typeof derivePendingProposalCatalogV2>): CapturedCatalog {
    return {
      complete: false,
      runtimeCatalogDigest: EMPTY_DIGEST,
      pendingCatalogDigest: pending?.digest ?? EMPTY_DIGEST,
      externalPendingDigest: pending?.digest ?? EMPTY_DIGEST,
      catalogEpoch: pending?.catalogEpoch ?? 0,
      catalogMutationReceiptDigest: pending?.catalogMutationReceiptDigest ?? sha256Utf8('CATALOG_UNAVAILABLE'),
      summaries: [],
      candidates: new Map(),
    }
  }
}
