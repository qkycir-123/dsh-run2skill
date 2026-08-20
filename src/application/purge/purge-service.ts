import { randomUUID } from 'node:crypto'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import {
  PurgeJournalV1Schema,
  PurgeScopeBindingV1Schema,
  classifyLineageForPurge,
  classifyWorkItemForPurge,
  type PurgeClassification,
  type PurgeJournalV1,
  type PurgePhaseV1,
  type PurgeScopeBindingV1,
} from '../../domain/purge/index.js'
import { Run2skillGlobalStore } from '../../adapters/dsh-storage/global-store.js'
import type { Run2skillDomain } from '../../adapters/dsh-storage/types.js'

const DEFAULT_PREVIEW_TTL_MS = 5 * 60_000
const MAX_PREVIEWS = 32
const DELETE_BATCH_SIZE = 32

export type PurgeErrorCode =
  | 'PURGE_PREVIEW_STALE'
  | 'PURGE_BUSY'
  | 'PURGE_ALREADY_RUNNING'
  | 'PURGE_SCOPE_UNAVAILABLE'
  | 'PURGE_STORAGE_UNAVAILABLE'
  | 'PURGE_INCOMPATIBLE'

export class PurgeError extends Error {
  constructor(readonly code: PurgeErrorCode, readonly busyPublicationCount = 0) {
    super(code)
    this.name = 'PurgeError'
  }
}

export interface PurgeCandidateSummary {
  readonly workItemIds: readonly string[]
  readonly lineageIds: readonly string[]
  readonly keepCounts: Readonly<Record<Exclude<PurgeClassification, 'DELETE'>, number>>
  readonly busyPublicationCount: number
}

export interface PurgePreviewV1 {
  readonly apiVersion: 1
  readonly previewId: string
  readonly digest: string
  readonly expiresAt: string
  readonly scopeBinding: PurgeScopeBindingV1
  readonly hideBefore: string
  readonly workItemCount: number
  readonly lineageCount: number
  readonly blockedOrUnprovenCount: number
  readonly willDelete: readonly { readonly kind: 'WORK_ITEMS' | 'LINEAGES'; readonly count: number }[]
  readonly willKeep: readonly { readonly reason: Exclude<PurgeClassification, 'DELETE'>; readonly count: number }[]
  readonly busyPublicationCount: number
}

export type PurgeReceiptV1 = {
  readonly apiVersion: 1
  readonly purgeId: string
  readonly state: 'COMPLETED' | 'IN_PROGRESS'
  readonly phase?: PurgePhaseV1
  readonly deletedWorkItems: number
  readonly deletedLineages: number
}

export type PurgeStatusV1 =
  | { readonly apiVersion: 1; readonly state: 'IDLE' }
  | ({ readonly apiVersion: 1; readonly state: 'IN_PROGRESS' } & Omit<PurgeJournalV1, 'schemaVersion' | 'scopeBinding' | 'candidateDigest'>)

export interface PurgeScopeResolver {
  resolve(scope: 'PROJECT' | 'USER', workspaceId?: string): Promise<PurgeScopeBindingV1>
}

export interface PurgeServiceOptions {
  readonly now?: () => number
  readonly previewTtlMs?: number
  readonly onHidden?: (journal: PurgeJournalV1) => void | Promise<void>
  readonly onPhasePersisted?: (phase: PurgePhaseV1) => void | Promise<void>
}

interface StoredPreview {
  readonly value: PurgePreviewV1
}

function candidateDigest(binding: PurgeScopeBindingV1, hideBefore: string, candidates: PurgeCandidateSummary): string {
  return sha256Utf8(canonicalJson({
    scopeBinding: binding,
    hideBefore,
    workItemIds: [...candidates.workItemIds].sort(),
    lineageIds: [...candidates.lineageIds].sort(),
  }))
}

function derivePurgeId(preview: PurgePreviewV1): string {
  return `purge_${sha256Utf8(canonicalJson({ previewId: preview.previewId, digest: preview.digest }))}`
}

function sameScopeFacts(left: PurgeScopeBindingV1, right: PurgeScopeBindingV1): boolean {
  if (left.scope !== right.scope) return false
  if (left.scope === 'USER' || right.scope === 'USER') return true
  const { workspaceObservedAt: _leftObservedAt, ...leftFacts } = left
  const { workspaceObservedAt: _rightObservedAt, ...rightFacts } = right
  return canonicalJson(leftFacts) === canonicalJson(rightFacts)
}

export function collectPurgeCandidates(
  domain: Run2skillDomain,
  binding: PurgeScopeBindingV1,
  hideBefore: string,
): PurgeCandidateSummary {
  const workItemIds: string[] = []
  const lineageIds: string[] = []
  const keepCounts = { KEEP_NEW: 0, KEEP_SCOPE: 0, KEEP_UNPROVEN: 0 }
  let busyPublicationCount = 0
  for (const [id, item] of domain.table('work_items').entries()) {
    const classification = classifyWorkItemForPurge(item, binding, hideBefore)
    if (classification === 'DELETE') {
      workItemIds.push(id)
      if (item.processingState === 'PUBLISHING') busyPublicationCount += 1
    } else keepCounts[classification] += 1
  }
  for (const [id, lineage] of domain.table('lineages').entries()) {
    const classification = classifyLineageForPurge(lineage, binding, hideBefore)
    if (classification === 'DELETE') lineageIds.push(id)
    else keepCounts[classification] += 1
  }
  workItemIds.sort()
  lineageIds.sort()
  return { workItemIds, lineageIds, keepCounts, busyPublicationCount }
}

export class PurgeService {
  readonly #global
  readonly #previews = new Map<string, StoredPreview>()
  readonly #completed = new Map<string, PurgeReceiptV1>()
  readonly #now
  readonly #ttl
  readonly #onHidden
  readonly #onPhasePersisted
  #tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly domain: Run2skillDomain,
    private readonly scopeResolver: PurgeScopeResolver,
    options: PurgeServiceOptions = {},
  ) {
    this.#global = Run2skillGlobalStore.for(domain)
    this.#now = options.now ?? Date.now
    const requestedTtl = options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS
    if (!Number.isSafeInteger(requestedTtl) || requestedTtl < 1) {
      throw new TypeError('Purge preview TTL must be a positive safe integer')
    }
    this.#ttl = Math.min(requestedTtl, DEFAULT_PREVIEW_TTL_MS)
    this.#onHidden = options.onHidden ?? (() => {})
    this.#onPhasePersisted = options.onPhasePersisted ?? (() => {})
  }

  async preview(scope: 'PROJECT' | 'USER', workspaceId?: string): Promise<PurgePreviewV1> {
    this.#prunePreviews()
    let binding: PurgeScopeBindingV1
    try {
      binding = PurgeScopeBindingV1Schema.parse(await this.scopeResolver.resolve(scope, workspaceId))
    } catch (error) {
      if (error instanceof PurgeError) throw error
      throw new PurgeError('PURGE_SCOPE_UNAVAILABLE')
    }
    const hideBefore = new Date(this.#now()).toISOString()
    const candidates = collectPurgeCandidates(this.domain, binding, hideBefore)
    const digest = candidateDigest(binding, hideBefore, candidates)
    const previewId = `purv_${sha256Utf8(canonicalJson({ digest, nonce: randomUUID() }))}`
    const expiresAt = new Date(this.#now() + this.#ttl).toISOString()
    const value: PurgePreviewV1 = {
      apiVersion: 1,
      previewId,
      digest,
      expiresAt,
      scopeBinding: binding,
      hideBefore,
      workItemCount: candidates.workItemIds.length,
      lineageCount: candidates.lineageIds.length,
      blockedOrUnprovenCount: candidates.keepCounts.KEEP_UNPROVEN,
      willDelete: [
        { kind: 'WORK_ITEMS', count: candidates.workItemIds.length },
        { kind: 'LINEAGES', count: candidates.lineageIds.length },
      ],
      willKeep: (['KEEP_NEW', 'KEEP_SCOPE', 'KEEP_UNPROVEN'] as const).map(reason => ({
        reason,
        count: candidates.keepCounts[reason],
      })),
      busyPublicationCount: candidates.busyPublicationCount,
    }
    this.#previews.set(previewId, { value })
    while (this.#previews.size > MAX_PREVIEWS) this.#previews.delete(this.#previews.keys().next().value!)
    return value
  }

  confirm(previewId: string, digest: string): Promise<PurgeReceiptV1> {
    return this.#serialize(async () => {
      const completed = this.#completed.get(previewId)
      if (completed !== undefined) return completed
      const stored = this.#previews.get(previewId)
      if (
        stored === undefined
        || stored.value.digest !== digest
        || Date.parse(stored.value.expiresAt) <= this.#now()
      ) throw new PurgeError('PURGE_PREVIEW_STALE')
      if (this.#global.get().purgeJournal !== undefined) throw new PurgeError('PURGE_ALREADY_RUNNING')
      let currentBinding: PurgeScopeBindingV1
      try {
        currentBinding = PurgeScopeBindingV1Schema.parse(await this.scopeResolver.resolve(
          stored.value.scopeBinding.scope,
          stored.value.scopeBinding.scope === 'PROJECT' ? stored.value.scopeBinding.workspaceId : undefined,
        ))
      } catch {
        throw new PurgeError('PURGE_SCOPE_UNAVAILABLE')
      }
      if (!sameScopeFacts(stored.value.scopeBinding, currentBinding)) {
        throw new PurgeError('PURGE_PREVIEW_STALE')
      }
      const current = collectPurgeCandidates(this.domain, currentBinding, stored.value.hideBefore)
      const currentDigest = candidateDigest(stored.value.scopeBinding, stored.value.hideBefore, current)
      if (currentDigest !== digest) throw new PurgeError('PURGE_PREVIEW_STALE')
      if (current.busyPublicationCount > 0) {
        throw new PurgeError('PURGE_BUSY', current.busyPublicationCount)
      }
      const journal = PurgeJournalV1Schema.parse({
        schemaVersion: 1,
        purgeId: derivePurgeId(stored.value),
        scopeBinding: stored.value.scopeBinding,
        hideBefore: stored.value.hideBefore,
        candidateDigest: digest,
        startedAt: new Date(this.#now()).toISOString(),
        phase: 'HIDING',
        deletedWorkItems: 0,
        deletedLineages: 0,
      })
      this.#lastReceipt = undefined
      let receipt: PurgeReceiptV1
      try {
        await this.#writeJournal(journal)
        await this.#onHidden(journal)
        receipt = await this.#runToCompletion()
      } catch (error) {
        if (error instanceof PurgeError) throw error
        await this.#recordFailure('PURGE_STORAGE_UNAVAILABLE')
        throw new PurgeError('PURGE_STORAGE_UNAVAILABLE')
      }
      this.#completed.set(previewId, receipt)
      while (this.#completed.size > MAX_PREVIEWS) this.#completed.delete(this.#completed.keys().next().value!)
      this.#previews.delete(previewId)
      return receipt
    })
  }

  status(): PurgeStatusV1 {
    const journal = this.#global.get().purgeJournal
    if (journal === undefined) return { apiVersion: 1, state: 'IDLE' }
    return {
      apiVersion: 1,
      state: 'IN_PROGRESS',
      purgeId: journal.purgeId,
      hideBefore: journal.hideBefore,
      startedAt: journal.startedAt,
      phase: journal.phase,
      deletedWorkItems: journal.deletedWorkItems,
      deletedLineages: journal.deletedLineages,
      ...(journal.lastError === undefined ? {} : { lastError: journal.lastError }),
    }
  }

  recover(): Promise<PurgeReceiptV1 | undefined> {
    return this.#serialize(async () => {
      if (this.#global.get().purgeJournal === undefined) return undefined
      this.#lastReceipt = undefined
      return await this.#runToCompletion()
    })
  }

  retry(purgeId: string): Promise<PurgeReceiptV1> {
    return this.#serialize(async () => {
      const journal = this.#global.get().purgeJournal
      if (journal === undefined || journal.purgeId !== purgeId) {
        throw new PurgeError('PURGE_PREVIEW_STALE')
      }
      this.#lastReceipt = undefined
      await this.#writeJournal({ ...journal, lastError: undefined })
      return await this.#runToCompletion()
    })
  }

  async #runToCompletion(): Promise<PurgeReceiptV1> {
    try {
      while (this.#global.get().purgeJournal !== undefined) await this.#step()
      const last = this.#lastReceipt
      if (last === undefined) throw new PurgeError('PURGE_STORAGE_UNAVAILABLE')
      return last
    } catch (error) {
      if (error instanceof PurgeError) throw error
      await this.#recordFailure('PURGE_STORAGE_UNAVAILABLE')
      throw new PurgeError('PURGE_STORAGE_UNAVAILABLE')
    }
  }

  #lastReceipt: PurgeReceiptV1 | undefined

  async #step(): Promise<void> {
    const journal = this.#global.get().purgeJournal
    if (journal === undefined) return
    if (journal.phase === 'HIDING') {
      await this.#writeJournal({ ...journal, phase: 'DELETING_LINEAGES', lastError: undefined })
      return
    }
    if (journal.phase === 'DELETING_LINEAGES') {
      const candidates = collectPurgeCandidates(this.domain, journal.scopeBinding, journal.hideBefore)
      const batch = candidates.lineageIds.slice(0, DELETE_BATCH_SIZE)
      let deleted = 0
      for (const id of batch) {
        if (await this.domain.table('lineages').delete(id)) deleted += 1
        else if (this.domain.table('lineages').get(id) !== undefined) throw new Error('PURGE_DELETE_FAILED')
      }
      const next = {
        ...journal,
        deletedLineages: journal.deletedLineages + deleted,
        phase: batch.length < candidates.lineageIds.length ? 'DELETING_LINEAGES' as const : 'DELETING_WORK_ITEMS' as const,
        lastError: undefined,
      }
      await this.#writeJournal(next)
      return
    }
    if (journal.phase === 'DELETING_WORK_ITEMS') {
      const candidates = collectPurgeCandidates(this.domain, journal.scopeBinding, journal.hideBefore)
      const batch = candidates.workItemIds.slice(0, DELETE_BATCH_SIZE)
      let deleted = 0
      for (const id of batch) {
        if (await this.domain.table('work_items').delete(id)) deleted += 1
        else if (this.domain.table('work_items').get(id) !== undefined) throw new Error('PURGE_DELETE_FAILED')
      }
      const next = {
        ...journal,
        deletedWorkItems: journal.deletedWorkItems + deleted,
        phase: batch.length < candidates.workItemIds.length ? 'DELETING_WORK_ITEMS' as const : 'VERIFYING' as const,
        lastError: undefined,
      }
      await this.#writeJournal(next)
      return
    }
    const residual = collectPurgeCandidates(this.domain, journal.scopeBinding, journal.hideBefore)
    if (residual.workItemIds.length > 0 || residual.lineageIds.length > 0) {
      throw new Error('PURGE_VERIFY_RESIDUAL')
    }
    this.#lastReceipt = {
      apiVersion: 1,
      purgeId: journal.purgeId,
      state: 'COMPLETED',
      deletedWorkItems: journal.deletedWorkItems,
      deletedLineages: journal.deletedLineages,
    }
    await this.#global.update(current => ({ ...current, purgeJournal: undefined }))
  }

  async #writeJournal(journal: PurgeJournalV1): Promise<void> {
    const parsed = PurgeJournalV1Schema.parse(journal)
    await this.#global.update(current => ({ ...current, purgeJournal: parsed }))
    await this.#onPhasePersisted(parsed.phase)
  }

  async #recordFailure(code: string): Promise<void> {
    try {
      const journal = this.#global.get().purgeJournal
      if (journal === undefined) return
      await this.#global.update(current => ({
        ...current,
        purgeJournal: current.purgeJournal === undefined ? undefined : {
          ...current.purgeJournal,
          lastError: { code, occurredAt: new Date(this.#now()).toISOString() },
        },
      }))
    } catch {
      // The durable hide fence remains authoritative even if diagnostics cannot be updated.
    }
  }

  #prunePreviews(): void {
    const now = this.#now()
    for (const [id, preview] of this.#previews) {
      if (Date.parse(preview.value.expiresAt) <= now) this.#previews.delete(id)
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation)
    this.#tail = result.then(() => {}, () => {})
    return result
  }
}
