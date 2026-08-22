import { randomUUID } from 'node:crypto'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import {
  PurgeJournalV1Schema,
  PurgeScopeBindingV1Schema,
  canUpsertCompletedPurgeFence,
  classifyLineageForPurge,
  classifyWorkItemForPurge,
  upsertCompletedPurgeFence,
  type PurgeClassification,
  type PurgeJournalV1,
  type PurgePhaseV1,
  type PurgeScopeBindingV1,
} from '../../domain/purge/index.js'
import { Run2skillGlobalStore } from '../../adapters/dsh-storage/global-store.js'
import type { Run2skillDomain } from '../../adapters/dsh-storage/types.js'
import type { Run2skillV2Domain } from '../../adapters/dsh-storage/v2-types.js'

interface PurgeDeleteTable {
  get(key: string): unknown
  keys(): IterableIterator<string>
  delete(key: string): Promise<boolean>
}

interface V2PurgeCandidates {
  readonly turn_observations: readonly string[]
  readonly session_batches: readonly string[]
  readonly experience_intents: readonly string[]
  readonly proposal_lineages: readonly string[]
  readonly legacy_items: readonly string[]
}

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
  | 'PURGE_FENCE_LIMIT'

export class PurgeError extends Error {
  constructor(readonly code: PurgeErrorCode, readonly busyPublicationCount = 0) {
    super(code)
    this.name = 'PurgeError'
  }
}

export interface PurgeCandidateSummary {
  readonly workItemIds: readonly string[]
  readonly lineageIds: readonly string[]
  readonly derivedIds: readonly string[]
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
  readonly derivedRecordCount: number
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

export type PurgeConfirmationScope =
  | { readonly scope: 'ALL' }
  | { readonly scope: 'USER' }
  | { readonly scope: 'PROJECT'; readonly workspaceId: string }

export interface PurgeScopeResolver {
  resolve(scope: 'PROJECT' | 'USER', workspaceId?: string): Promise<PurgeScopeBindingV1>
}

export interface PurgeServiceOptions {
  readonly now?: () => number
  readonly previewTtlMs?: number
  readonly onHidden?: (journal: PurgeJournalV1) => void | Promise<void>
  readonly onPhasePersisted?: (phase: PurgePhaseV1) => void | Promise<void>
  readonly beforeDeleteWorkItem?: (workItemId: string) => void | Promise<void>
  readonly beforeDeleteAll?: () => void | Promise<void>
  readonly assertDeletionReady?: () => void | Promise<void>
  readonly v2Domain?: Run2skillV2Domain
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
    derivedIds: [...candidates.derivedIds].sort(),
  }))
}

function derivePurgeId(preview: PurgePreviewV1): string {
  return `purge_${sha256Utf8(canonicalJson({ previewId: preview.previewId, digest: preview.digest }))}`
}

function sameScopeFacts(left: PurgeScopeBindingV1, right: PurgeScopeBindingV1): boolean {
  if (left.scope !== right.scope) return false
  if (left.scope === 'USER' || left.scope === 'ALL') return true
  if (right.scope !== 'PROJECT') return false
  const { workspaceObservedAt: _leftObservedAt, ...leftFacts } = left
  const { workspaceObservedAt: _rightObservedAt, ...rightFacts } = right
  return canonicalJson(leftFacts) === canonicalJson(rightFacts)
}

function v2PurgeCandidates(domain: Run2skillV2Domain, hideBefore: string): V2PurgeCandidates {
  const boundary = Date.parse(hideBefore)
  const beforeBoundary = (value: string | undefined) => value !== undefined && Date.parse(value) <= boundary
  const sorted = (values: string[]) => values.sort()
  return {
    turn_observations: sorted([...domain.table('turn_observations').entries()]
      .filter(([, value]) => beforeBoundary(value.observedAt)).map(([id]) => id)),
    session_batches: sorted([...domain.table('session_batches').entries()]
      .filter(([, value]) => beforeBoundary(value.createdAt)).map(([id]) => id)),
    experience_intents: sorted([...domain.table('experience_intents').entries()]
      .filter(([, value]) => beforeBoundary(value.createdAt)).map(([id]) => id)),
    proposal_lineages: sorted([...domain.table('proposal_lineages').entries()]
      .filter(([, value]) => beforeBoundary(value.origin === 'LEGACY_V1'
        ? value.legacySnapshot.revisions[0]?.committedAt
        : value.createdAt)).map(([id]) => id)),
    legacy_items: sorted([...domain.table('legacy_items').entries()]
      .filter(([, value]) => beforeBoundary(value.sourceWorkItem.createdAt)).map(([id]) => id)),
  }
}

export function collectPurgeCandidates(
  domain: Run2skillDomain,
  binding: PurgeScopeBindingV1,
  hideBefore: string,
  v2Domain?: Run2skillV2Domain,
): PurgeCandidateSummary {
  const workItemIds: string[] = []
  const lineageIds: string[] = []
  const derivedIds: string[] = []
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
  if (binding.scope === 'ALL' && v2Domain !== undefined) {
    const candidates = v2PurgeCandidates(v2Domain, hideBefore)
    for (const [tableName, ids] of Object.entries(candidates)) {
      for (const key of ids) derivedIds.push(`${tableName}:${key}`)
    }
  }
  derivedIds.sort()
  return { workItemIds, lineageIds, derivedIds, keepCounts, busyPublicationCount }
}

export class PurgeService {
  readonly #global
  readonly #previews = new Map<string, StoredPreview>()
  readonly #completed = new Map<string, PurgeReceiptV1>()
  readonly #now
  readonly #ttl
  readonly #onHidden
  readonly #onPhasePersisted
  readonly #beforeDeleteWorkItem
  readonly #beforeDeleteAll
  readonly #assertDeletionReady
  readonly #v2Domain
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
    this.#beforeDeleteWorkItem = options.beforeDeleteWorkItem ?? (() => {})
    this.#beforeDeleteAll = options.beforeDeleteAll ?? (() => {})
    this.#assertDeletionReady = options.assertDeletionReady ?? (() => {})
    this.#v2Domain = options.v2Domain
  }

  async preview(scope: 'ALL' | 'PROJECT' | 'USER', workspaceId?: string): Promise<PurgePreviewV1> {
    await this.#requireDeletionReady()
    this.#prunePreviews()
    let binding: PurgeScopeBindingV1
    if (scope === 'ALL') {
      if (this.#v2Domain === undefined) throw new PurgeError('PURGE_STORAGE_UNAVAILABLE')
      binding = PurgeScopeBindingV1Schema.parse({ scope: 'ALL' })
    }
    else {
      try {
        binding = PurgeScopeBindingV1Schema.parse(await this.scopeResolver.resolve(scope, workspaceId))
      } catch (error) {
        if (error instanceof PurgeError) throw error
        throw new PurgeError('PURGE_SCOPE_UNAVAILABLE')
      }
    }
    this.#assertFenceCapacity(binding)
    const hideBefore = new Date(this.#now()).toISOString()
    const candidates = collectPurgeCandidates(this.domain, binding, hideBefore, this.#v2Domain)
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
      derivedRecordCount: candidates.derivedIds.length,
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

  confirm(
    previewId: string,
    digest: string,
    confirmationScope?: PurgeConfirmationScope,
  ): Promise<PurgeReceiptV1> {
    return this.#serialize(async () => {
      const completed = this.#completed.get(previewId)
      if (completed !== undefined) return completed
      await this.#requireDeletionReady()
      const stored = this.#previews.get(previewId)
      if (
        stored === undefined
        || stored.value.digest !== digest
        || Date.parse(stored.value.expiresAt) <= this.#now()
      ) throw new PurgeError('PURGE_PREVIEW_STALE')
      if (confirmationScope !== undefined && (
        confirmationScope.scope !== stored.value.scopeBinding.scope
        || (
          confirmationScope.scope === 'PROJECT'
          && stored.value.scopeBinding.scope === 'PROJECT'
          && confirmationScope.workspaceId !== stored.value.scopeBinding.workspaceId
        )
      )) throw new PurgeError('PURGE_PREVIEW_STALE')
      if (this.#global.get().purgeJournal !== undefined) throw new PurgeError('PURGE_ALREADY_RUNNING')
      let currentBinding: PurgeScopeBindingV1
      if (stored.value.scopeBinding.scope === 'ALL') {
        if (this.#v2Domain === undefined) throw new PurgeError('PURGE_STORAGE_UNAVAILABLE')
        currentBinding = { scope: 'ALL' }
      } else {
        try {
          currentBinding = PurgeScopeBindingV1Schema.parse(await this.scopeResolver.resolve(
            stored.value.scopeBinding.scope,
            stored.value.scopeBinding.scope === 'PROJECT' ? stored.value.scopeBinding.workspaceId : undefined,
          ))
        } catch {
          throw new PurgeError('PURGE_SCOPE_UNAVAILABLE')
        }
      }
      if (!sameScopeFacts(stored.value.scopeBinding, currentBinding)) {
        throw new PurgeError('PURGE_PREVIEW_STALE')
      }
      this.#assertFenceCapacity(currentBinding)
      const current = collectPurgeCandidates(this.domain, currentBinding, stored.value.hideBefore, this.#v2Domain)
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
        targetWorkItems: current.workItemIds.length,
        targetLineages: current.lineageIds.length,
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
      await this.#requireDeletionReady()
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
      const candidates = collectPurgeCandidates(this.domain, journal.scopeBinding, journal.hideBefore, this.#v2Domain)
      const batch = candidates.lineageIds.slice(0, DELETE_BATCH_SIZE)
      const v2LineageIds = journal.scopeBinding.scope === 'ALL' && this.#v2Domain !== undefined
        ? v2PurgeCandidates(this.#v2Domain, journal.hideBefore).proposal_lineages
        : []
      const v2Batch = v2LineageIds.slice(0, DELETE_BATCH_SIZE)
      let deleted = 0
      for (const id of batch) {
        if (await this.domain.table('lineages').delete(id)) deleted += 1
        else if (this.domain.table('lineages').get(id) !== undefined) throw new Error('PURGE_DELETE_FAILED')
      }
      for (const id of v2Batch) {
        if (!await this.#v2Domain!.table('proposal_lineages').delete(id)
          && this.#v2Domain!.table('proposal_lineages').get(id) !== undefined) {
          throw new Error('PURGE_DELETE_FAILED')
        }
      }
      const next = {
        ...journal,
        deletedLineages: journal.deletedLineages + deleted,
        phase: batch.length < candidates.lineageIds.length || v2Batch.length < v2LineageIds.length
          ? 'DELETING_LINEAGES' as const
          : 'DELETING_WORK_ITEMS' as const,
        lastError: undefined,
      }
      await this.#writeJournal(next)
      return
    }
    if (journal.phase === 'DELETING_WORK_ITEMS') {
      const candidates = collectPurgeCandidates(this.domain, journal.scopeBinding, journal.hideBefore, this.#v2Domain)
      const batch = candidates.workItemIds.slice(0, DELETE_BATCH_SIZE)
      let deleted = 0
      for (const id of batch) {
        await this.#beforeDeleteWorkItem(id)
        if (await this.domain.table('work_items').delete(id)) deleted += 1
        else if (this.domain.table('work_items').get(id) !== undefined) throw new Error('PURGE_DELETE_FAILED')
      }
      let v2HasMore = false
      if (journal.scopeBinding.scope === 'ALL' && this.#v2Domain !== undefined) {
        const candidates = v2PurgeCandidates(this.#v2Domain, journal.hideBefore)
        const tables: readonly [PurgeDeleteTable, readonly string[]][] = [
          [this.#v2Domain.table('turn_observations'), candidates.turn_observations],
          [this.#v2Domain.table('session_batches'), candidates.session_batches],
          [this.#v2Domain.table('experience_intents'), candidates.experience_intents],
          [this.#v2Domain.table('legacy_items'), candidates.legacy_items],
        ]
        for (const [table, ids] of tables) {
          const v2Batch = ids.slice(0, DELETE_BATCH_SIZE)
          for (const id of v2Batch) {
            if (!await table.delete(id) && table.get(id) !== undefined) throw new Error('PURGE_DELETE_FAILED')
          }
          if (v2Batch.length < ids.length) v2HasMore = true
        }
      }
      const next = {
        ...journal,
        deletedWorkItems: journal.deletedWorkItems + deleted,
        phase: batch.length < candidates.workItemIds.length || v2HasMore
          ? 'DELETING_WORK_ITEMS' as const
          : 'VERIFYING' as const,
        lastError: undefined,
      }
      await this.#writeJournal(next)
      return
    }
    if (journal.scopeBinding.scope === 'ALL') await this.#beforeDeleteAll()
    const residual = collectPurgeCandidates(this.domain, journal.scopeBinding, journal.hideBefore, this.#v2Domain)
    if (residual.workItemIds.length > 0 || residual.lineageIds.length > 0 || residual.derivedIds.length > 0) {
      throw new Error('PURGE_VERIFY_RESIDUAL')
    }
    this.#lastReceipt = {
      apiVersion: 1,
      purgeId: journal.purgeId,
      state: 'COMPLETED',
      deletedWorkItems: journal.targetWorkItems ?? journal.deletedWorkItems,
      deletedLineages: journal.targetLineages ?? journal.deletedLineages,
    }
    const currentGlobal = this.#global.get()
    if (!canUpsertCompletedPurgeFence(currentGlobal.completedPurgeFences, journal.scopeBinding)) {
      throw new PurgeError('PURGE_FENCE_LIMIT')
    }
    const completedPurgeFences = upsertCompletedPurgeFence(
      currentGlobal.completedPurgeFences,
      journal,
      new Date(this.#now()).toISOString(),
    )
    if (journal.scopeBinding.scope === 'ALL') await this.#finalizeV2(completedPurgeFences)
    await this.#global.update(current => ({
      ...current,
      completedPurgeFences,
      purgeJournal: undefined,
    }))
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

  async #finalizeV2(completedPurgeFences: NonNullable<ReturnType<typeof upsertCompletedPurgeFence>>): Promise<void> {
    if (this.#v2Domain === undefined) throw new Error('Run2Skill v2 storage unavailable')
    const current = this.#v2Domain.global.get()
    const {
      proposalGenerationLease: _proposalGenerationLease,
      proposalCatalogMutationJournal: _proposalCatalogMutationJournal,
      purgeJournal: _purgeJournal,
      ...stable
    } = current
    const hideBefore = completedPurgeFences.all?.hideBefore
    if (hideBefore === undefined) throw new Error('ALL purge fence missing')
    const boundary = Date.parse(hideBefore)
    const remainingOwnerIds = new Set([
      ...this.#v2Domain.table('turn_observations').keys(),
      ...this.#v2Domain.table('session_batches').keys(),
      ...this.#v2Domain.table('experience_intents').keys(),
      ...this.#v2Domain.table('proposal_lineages').keys(),
      ...this.#v2Domain.table('legacy_items').keys(),
    ])
    const remainingIntentIds = new Set(this.#v2Domain.table('experience_intents').keys())
    const behaviorSignatureIndex = Object.fromEntries(Object.entries(current.behaviorSignatureIndex)
      .filter(([, entry]) => Date.parse(entry.updatedAt) > boundary && remainingIntentIds.has(entry.ownerIntentId)))
    const sessions = Object.fromEntries(Object.entries(current.sessions).map(([key, session]) => {
      const {
        activeBatchId: _activeBatchId,
        batchManifestBaseline: _batchManifestBaseline,
        ...cursor
      } = session
      return [key, { ...cursor, openExperienceCarry: [] }]
    }))
    const proposalGenerationLease = current.proposalGenerationLease !== undefined
      && Date.parse(current.proposalGenerationLease.acquiredAt) > boundary
      && remainingIntentIds.has(current.proposalGenerationLease.ownerIntentId)
      ? current.proposalGenerationLease
      : undefined
    const proposalCatalogMutationJournal = current.proposalCatalogMutationJournal !== undefined
      && Date.parse(current.proposalCatalogMutationJournal.preparedAt) > boundary
      && remainingOwnerIds.has(current.proposalCatalogMutationJournal.ownerId)
      ? current.proposalCatalogMutationJournal
      : undefined
    const alreadyFinalized = current.legacyCompletedPurgeFences?.all?.purgeId
      === completedPurgeFences.all?.purgeId
    await this.#v2Domain.global.set({
      ...stable,
      sessions,
      behaviorSignatureIndex,
      ...(proposalGenerationLease === undefined ? {} : { proposalGenerationLease }),
      ...(proposalCatalogMutationJournal === undefined ? {} : { proposalCatalogMutationJournal }),
      proposalCatalogEpoch: alreadyFinalized
        ? current.proposalCatalogEpoch
        : current.proposalCatalogEpoch + 1,
      legacyCompletedPurgeFences: completedPurgeFences,
    })
  }

  async #requireDeletionReady(): Promise<void> {
    try {
      await this.#assertDeletionReady()
    } catch (error) {
      if (error instanceof PurgeError) throw error
      throw new PurgeError('PURGE_STORAGE_UNAVAILABLE')
    }
  }

  #prunePreviews(): void {
    const now = this.#now()
    for (const [id, preview] of this.#previews) {
      if (Date.parse(preview.value.expiresAt) <= now) this.#previews.delete(id)
    }
  }

  #assertFenceCapacity(binding: PurgeScopeBindingV1): void {
    if (!canUpsertCompletedPurgeFence(this.#global.get().completedPurgeFences, binding)) {
      throw new PurgeError('PURGE_FENCE_LIMIT')
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation)
    this.#tail = result.then(() => {}, () => {})
    return result
  }
}
