import { createReadStream } from 'node:fs'
import { opendir } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { z } from 'zod'
import type { Run2skillV2Domain } from '../dsh-storage/v2-types.js'
import {
  derivePendingProposalCatalogV2,
  type PendingProposalCatalogEntryV2,
  type PendingProposalCatalogReadOptionsV2,
} from '../dsh-storage/v2-pending-catalog.js'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import { deriveRecallCandidateId, type CompleteRecallCatalogPort, type RecallCatalogDefinition, type RecallCatalogSnapshot, type RecallCatalogSummary } from '../../application/recall/index.js'
import type { GenerationCatalogPort, GenerationCatalogSnapshot } from '../../application/generation/index.js'
import { GlobalV2Schema, type ExperienceIntentV2, type SessionBatchV2 } from '../../domain/v2/index.js'
import type { DshSkillRegistryPort } from './skill-catalog.js'
import { parseDshSkillFileForOwnership } from './v2-skill-file.js'

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
  path: z.string().min(1).max(32 * 1024).optional(),
}).passthrough()
const runtimeSnapshotSchema = z.object({
  complete: z.boolean(),
  skills: z.array(runtimeSummarySchema).max(1024),
}).passthrough()
const runtimeDefinitionSchema = runtimeSummarySchema.safeExtend({ content: z.string() }).passthrough()

type RuntimeSummary = z.infer<typeof runtimeSummarySchema>

type OwnershipFileRead =
  | {
      readonly status: 'READ'
      readonly name: string
      readonly bodyDigest: string
      readonly skillBytesDigest: string
    }
  | { readonly status: 'NO_MATCH' | 'UNAVAILABLE' }

interface OwnershipLocatedFile {
  readonly target: string
  readonly bodyDigest: string
  readonly skillBytesDigest: string
}

type OwnershipDirectoryIndex = ReadonlyMap<string, OwnershipLocatedFile | null>

interface OwnershipDirectoryEntry {
  readonly name: string
  readonly kind: 'file' | 'directory' | 'symbolic-link' | 'other'
}

interface OwnershipCatalogPolicy {
  readonly maxBodyBytes: number
  readonly maxTotalBytes: number
  readonly maxDirectoryEntries: number
  readonly maxCandidateFiles: number
}

const DEFAULT_OWNERSHIP_CATALOG_POLICY: OwnershipCatalogPolicy = Object.freeze({
  maxBodyBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxDirectoryEntries: 16_384,
  maxCandidateFiles: 4_096,
})

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
  /** @internal Allows deterministic boundary tests; Host wiring uses the frozen default policy. */
  readonly internalOwnershipPolicy?: Partial<OwnershipCatalogPolicy>
  /** @internal Allows deterministic bounded-stream tests; Host wiring reads the discovered file directly. */
  readonly internalOpenOwnershipFile?: (path: string) => AsyncIterable<Uint8Array>
  /** @internal Allows deterministic bounded layout discovery tests. */
  readonly internalOpenOwnershipDirectory?: (path: string) => AsyncIterable<OwnershipDirectoryEntry>
}

export interface V2PublicationRecoveryCatalogPort {
  snapshot(input: {
    readonly batch: SessionBatchV2
    readonly intent: ExperienceIntentV2
    readonly proposalId: string
  }): Promise<GenerationCatalogSnapshot | undefined>
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
const CANONICAL_OWNERSHIP_PROVIDERS = new Set(['filesystem'])
const CANONICAL_OWNERSHIP_SOURCES = new Set([
  'project-dsh', 'project-agents', 'custom', 'user-dsh', 'user-agents', 'bundled', 'runtime',
])

function ownershipCatalogLabel(kind: 'provider' | 'source', value: string): string {
  const canonical = kind === 'provider' ? CANONICAL_OWNERSHIP_PROVIDERS : CANONICAL_OWNERSHIP_SOURCES
  return canonical.has(value)
    ? value
    : `opaque-${kind}-${sha256Utf8(canonicalJson({ kind, value }))}`
}

function pathApi(value: string): typeof win32 | typeof posix {
  return /^[a-zA-Z]:[\\/]/u.test(value) || value.includes('\\') ? win32 : posix
}

function canonicalPath(value: string): string {
  const api = pathApi(value)
  const normalized = api.resolve(value)
  return api === win32 ? normalized.toLowerCase() : normalized
}

function fileAbsent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

async function* openOwnershipDirectory(path: string): AsyncIterable<OwnershipDirectoryEntry> {
  const directory = await opendir(path)
  try {
    while (true) {
      const entry = await directory.read()
      if (entry === null) return
      const kind = entry.isFile()
        ? 'file'
        : entry.isDirectory()
          ? 'directory'
          : entry.isSymbolicLink()
            ? 'symbolic-link'
            : 'other'
      yield { name: entry.name, kind }
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
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
  readonly publicationRecovery: V2PublicationRecoveryCatalogPort
  readonly #domain: Run2skillV2Domain
  readonly #registry: DshSkillRegistryPort<TView>
  readonly #resolveView: DshV2CatalogAdapterOptions<TView>['resolveView']
  readonly #resolveRuntimeIdentity: NonNullable<DshV2CatalogAdapterOptions<TView>['resolveRuntimeIdentity']>
  readonly #ownershipPolicy: OwnershipCatalogPolicy
  readonly #openOwnershipFile: (path: string) => AsyncIterable<Uint8Array>
  readonly #openOwnershipDirectory: (path: string) => AsyncIterable<OwnershipDirectoryEntry>

  constructor(domain: Run2skillV2Domain, options: DshV2CatalogAdapterOptions<TView>) {
    this.#domain = domain
    this.#registry = options.registry
    this.#resolveView = options.resolveView
    this.#ownershipPolicy = { ...DEFAULT_OWNERSHIP_CATALOG_POLICY, ...options.internalOwnershipPolicy }
    this.#openOwnershipFile = options.internalOpenOwnershipFile
      ?? (path => createReadStream(path, { highWaterMark: 64 * 1024 }))
    this.#openOwnershipDirectory = options.internalOpenOwnershipDirectory ?? openOwnershipDirectory
    if (!Object.values(this.#ownershipPolicy).every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new TypeError('Invalid ownership Catalog policy')
    }
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
    this.publicationRecovery = {
      snapshot: async input => {
        const global = GlobalV2Schema.safeParse(this.#domain.global.get())
        const journal = global.success ? global.data.proposalCatalogMutationJournal : undefined
        if (
          journal?.kind !== 'PUBLICATION'
          || journal.ownerId !== input.proposalId
          || (journal.phase !== 'PREPARED' && journal.phase !== 'EXECUTING')
        ) return undefined
        return await this.#generationSnapshot(input.batch, input.intent, undefined, {
          mutationId: journal.mutationId,
          ownerId: journal.ownerId,
          phase: journal.phase,
        })
      },
    }
  }

  async observeRuntimeCatalog(sessionLifecycleKey: string): Promise<{
    readonly complete: boolean
    readonly runtimeCatalogDigest: string
  }> {
    const view = this.#resolveView(sessionLifecycleKey)
    if (view === undefined) return { complete: false, runtimeCatalogDigest: EMPTY_DIGEST }
    const first = await this.#runtime(view, sessionLifecycleKey)
    const second = await this.#runtime(view, sessionLifecycleKey)
    if (!first.complete || !second.complete || first.digest !== second.digest) {
      return { complete: false, runtimeCatalogDigest: EMPTY_DIGEST }
    }
    return { complete: true, runtimeCatalogDigest: first.digest }
  }

  async observeOwnershipCatalog(sessionLifecycleKey: string): Promise<{
    readonly complete: boolean
    readonly runtimeCatalogDigest: string
    readonly candidates: readonly {
      readonly candidateId: string
      readonly name: string
      readonly provider: string
      readonly source: string
      readonly scope: 'PROJECT' | 'USER'
      readonly writable: boolean
      readonly targetPathDigest?: string
      readonly bodyDigest: string
    }[]
  }> {
    const unavailable = { complete: false, runtimeCatalogDigest: EMPTY_DIGEST, candidates: [] }
    const view = this.#resolveView(sessionLifecycleKey)
    if (view === undefined) return unavailable
    let totalBytes = 0
    let directoryEntries = 0
    let candidateFiles = 0
    const observeBytes = (bytes: number): boolean => {
      if (bytes > this.#ownershipPolicy.maxTotalBytes - totalBytes) return false
      totalBytes += bytes
      return true
    }
    const observeDirectoryEntry = (): boolean => ++directoryEntries <= this.#ownershipPolicy.maxDirectoryEntries
    const observeCandidateFile = (): boolean => ++candidateFiles <= this.#ownershipPolicy.maxCandidateFiles
    const first = await this.#ownershipRuntime(
      view, sessionLifecycleKey, observeBytes, observeDirectoryEntry, observeCandidateFile,
    )
    if (!first.complete) return unavailable
    const second = await this.#ownershipRuntime(
      view, sessionLifecycleKey, observeBytes, observeDirectoryEntry, observeCandidateFile,
    )
    if (!second.complete || canonicalJson(first) !== canonicalJson(second)) return unavailable
    return {
      complete: true,
      runtimeCatalogDigest: first.runtimeCatalogDigest,
      candidates: first.candidates,
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
    allowPublicationJournal?: NonNullable<PendingProposalCatalogReadOptionsV2['allowPublicationJournal']>,
  ): Promise<GenerationCatalogSnapshot> {
    const captured = await this.#capture(batch, intent, exclude, undefined, allowPublicationJournal)
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
    allowPublicationJournal?: NonNullable<PendingProposalCatalogReadOptionsV2['allowPublicationJournal']>,
  ): Promise<CapturedCatalog> {
    const view = exactView ?? this.#resolveView(batch.sessionLifecycleKey)
    if (view === undefined || intent.sessionLifecycleKey !== batch.sessionLifecycleKey) {
      return this.#incomplete()
    }
    const firstRuntime = await this.#runtime(view, batch.sessionLifecycleKey)
    const pending = derivePendingProposalCatalogV2(
      this.#domain,
      intent,
      allowPublicationJournal === undefined ? {} : { allowPublicationJournal },
    )
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

  async #ownershipRuntime(
    view: TView,
    sessionLifecycleKey: string,
    observeBytes: (bytes: number) => boolean,
    observeDirectoryEntry: () => boolean,
    observeCandidateFile: () => boolean,
  ): Promise<{
    readonly complete: boolean
    readonly runtimeCatalogDigest: string
    readonly candidates: readonly {
      readonly candidateId: string
      readonly name: string
      readonly provider: string
      readonly source: string
      readonly scope: 'PROJECT' | 'USER'
      readonly writable: boolean
      readonly targetPathDigest?: string
      readonly bodyDigest: string
    }[]
  }> {
    const unavailable = { complete: false, runtimeCatalogDigest: EMPTY_DIGEST, candidates: [] }
    const runtime = await this.#runtime(view, sessionLifecycleKey)
    if (!runtime.complete) return unavailable
    const candidates = []
    const fileReads = new Map<string, Promise<OwnershipFileRead>>()
    const directoryIndexes = new Map<string, Promise<OwnershipDirectoryIndex | undefined>>()
    for (const candidate of runtime.candidates) {
      // Agent writes are filesystem-observable. Other providers remain covered by
      // the stable Runtime digest and cannot be granted file-write ownership.
      if (candidate.raw.provider !== 'filesystem') continue
      const exact = candidate.raw.path === undefined
        ? candidate.raw.resourceBase?.kind === 'directory'
          ? await this.#discoverOwnershipFile(
              candidate.raw.resourceBase.path,
              candidate.raw.name,
              observeBytes,
              observeDirectoryEntry,
              observeCandidateFile,
              fileReads,
              directoryIndexes,
            )
          : undefined
        : await this.#readExactOwnershipFile(
            candidate.raw.path, candidate.raw.name, observeBytes, observeCandidateFile, fileReads,
          )
      if (exact === undefined) return unavailable
      candidates.push({
        candidateId: candidate.summary.candidateId,
        name: candidate.summary.name,
        provider: ownershipCatalogLabel('provider', candidate.summary.provider),
        source: ownershipCatalogLabel('source', candidate.summary.source),
        scope: candidate.summary.scope,
        writable: candidate.summary.writable,
        targetPathDigest: sha256Utf8(canonicalJson({ path: canonicalPath(exact.target) })),
        bodyDigest: exact.bodyDigest,
      })
    }
    candidates.sort((left, right) => left.candidateId.localeCompare(right.candidateId))
    return { complete: true, runtimeCatalogDigest: runtime.digest, candidates }
  }

  async #readOwnershipFile(
    target: string,
    observeBytes: (bytes: number) => boolean,
    observeCandidateFile: () => boolean,
    cache: Map<string, Promise<OwnershipFileRead>>,
  ): Promise<OwnershipFileRead> {
    const key = canonicalPath(target)
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const pending = observeCandidateFile()
      ? this.#readOwnershipFileUncached(target, observeBytes)
      : Promise.resolve({ status: 'UNAVAILABLE' as const })
    cache.set(key, pending)
    return pending
  }

  async #readOwnershipFileUncached(
    target: string,
    observeBytes: (bytes: number) => boolean,
  ): Promise<OwnershipFileRead> {
    const chunks: Buffer[] = []
    let candidateBytes = 0
    try {
      for await (const chunk of this.#openOwnershipFile(target)) {
        const bytes = Buffer.from(chunk)
        if (bytes.byteLength > this.#ownershipPolicy.maxBodyBytes - candidateBytes) return { status: 'UNAVAILABLE' }
        if (!observeBytes(bytes.byteLength)) return { status: 'UNAVAILABLE' }
        candidateBytes += bytes.byteLength
        chunks.push(bytes)
      }
    } catch (error) {
      return { status: fileAbsent(error) ? 'NO_MATCH' : 'UNAVAILABLE' }
    }
    const exactSkillBytes = Buffer.concat(chunks, candidateBytes).toString('utf8')
    const parsed = parseDshSkillFileForOwnership(exactSkillBytes)
    if (parsed === undefined) return { status: 'NO_MATCH' }
    return {
      status: 'READ',
      name: parsed.name,
      bodyDigest: sha256Utf8(parsed.body),
      skillBytesDigest: sha256Utf8(exactSkillBytes),
    }
  }

  async #readExactOwnershipFile(
    target: string,
    expectedName: string,
    observeBytes: (bytes: number) => boolean,
    observeCandidateFile: () => boolean,
    fileReads: Map<string, Promise<OwnershipFileRead>>,
  ): Promise<OwnershipLocatedFile | undefined> {
    const read = await this.#readOwnershipFile(target, observeBytes, observeCandidateFile, fileReads)
    return read.status === 'READ' && read.name === expectedName
      ? { target, bodyDigest: read.bodyDigest, skillBytesDigest: read.skillBytesDigest }
      : undefined
  }

  async #discoverOwnershipFile(
    directory: string,
    expectedName: string,
    observeBytes: (bytes: number) => boolean,
    observeDirectoryEntry: () => boolean,
    observeCandidateFile: () => boolean,
    fileReads: Map<string, Promise<OwnershipFileRead>>,
    directoryIndexes: Map<string, Promise<OwnershipDirectoryIndex | undefined>>,
  ): Promise<OwnershipLocatedFile | undefined> {
    // A path-free DSH summary cannot distinguish a bundle directory from a flat
    // root. Index every direct Markdown candidate before accepting one name so a
    // shadowed root SKILL.md never masquerades as the Runtime winner.
    const key = canonicalPath(directory)
    let pending = directoryIndexes.get(key)
    if (pending === undefined) {
      pending = this.#indexOwnershipDirectory(
        directory,
        observeBytes,
        observeDirectoryEntry,
        observeCandidateFile,
        fileReads,
      )
      directoryIndexes.set(key, pending)
    }
    const index = await pending
    const exact = index?.get(expectedName)
    return exact === null ? undefined : exact
  }

  async #indexOwnershipDirectory(
    directory: string,
    observeBytes: (bytes: number) => boolean,
    observeDirectoryEntry: () => boolean,
    observeCandidateFile: () => boolean,
    fileReads: Map<string, Promise<OwnershipFileRead>>,
  ): Promise<OwnershipDirectoryIndex | undefined> {
    const api = pathApi(directory)
    const index = new Map<string, OwnershipLocatedFile | null>()
    try {
      for await (const entry of this.#openOwnershipDirectory(directory)) {
        if (!observeDirectoryEntry()) return undefined
        if (
          (entry.kind !== 'file' && entry.kind !== 'symbolic-link')
          || !entry.name.endsWith('.md')
          || api.basename(entry.name) !== entry.name
        ) continue
        const target = api.join(directory, entry.name)
        const read = await this.#readOwnershipFile(target, observeBytes, observeCandidateFile, fileReads)
        if (read.status === 'UNAVAILABLE') return undefined
        if (read.status === 'READ') {
          index.set(
            read.name,
            index.has(read.name)
              ? null
              : { target, bodyDigest: read.bodyDigest, skillBytesDigest: read.skillBytesDigest },
          )
        }
      }
    } catch {
      return undefined
    }
    return index
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
    let skillBytesDigest: string | undefined
    if (candidate.kind === 'PENDING') {
      content = candidate.entry.capability === 'FULL_BODY' ? candidate.entry.exactSkillBytes : undefined
      if (content !== undefined) skillBytesDigest = sha256Utf8(content)
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
      if (candidate.summary.writable) {
        let totalBytes = 0
        let candidateFiles = 0
        const exactPath = definition.data.path ?? candidate.raw.path
        const exact = exactPath === undefined
          ? candidate.raw.resourceBase?.kind === 'directory'
            ? await this.#discoverOwnershipFile(
                candidate.raw.resourceBase.path,
                candidate.raw.name,
                bytes => {
                  if (bytes > this.#ownershipPolicy.maxTotalBytes - totalBytes) return false
                  totalBytes += bytes
                  return true
                },
                () => true,
                () => ++candidateFiles <= this.#ownershipPolicy.maxCandidateFiles,
                new Map(),
                new Map(),
              )
            : undefined
          : await this.#readExactOwnershipFile(
              exactPath,
              candidate.raw.name,
              bytes => {
                if (bytes > this.#ownershipPolicy.maxTotalBytes - totalBytes) return false
                totalBytes += bytes
                return true
              },
              () => ++candidateFiles <= this.#ownershipPolicy.maxCandidateFiles,
              new Map(),
            )
        if (exact === undefined || exact.bodyDigest !== sha256Utf8(content)) return undefined
        skillBytesDigest = exact.skillBytesDigest
      }
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
    return {
      ...candidate.summary,
      content,
      ...(skillBytesDigest === undefined ? {} : { skillBytesDigest }),
    }
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
