import { randomUUID } from 'node:crypto'
import type { Run2skillV2Domain } from '../../adapters/dsh-storage/v2-types.js'
import { Run2skillV2GlobalStore } from '../../adapters/dsh-storage/v2-global-store.js'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import {
  deriveProposalCatalogMutationAnchorV2,
  type GlobalV2,
} from '../../domain/v2/index.js'
import {
  PurgeError,
  type PurgeConfirmationScope,
  type PurgePreviewV1,
  type PurgeReceiptV1,
  type PurgeStatusV1,
} from './purge-service.js'

interface CandidateSet {
  readonly turnObservations: readonly string[]
  readonly sessionBatches: readonly string[]
  readonly experienceIntents: readonly string[]
  readonly proposalLineages: readonly string[]
  readonly legacyItems: readonly string[]
}

interface StoredPreview {
  readonly value: PurgePreviewV1
  readonly candidates: CandidateSet
}

const PREVIEW_TTL_MS = 5 * 60_000

function candidates(domain: Run2skillV2Domain, hideBefore: string): CandidateSet {
  const boundary = Date.parse(hideBefore)
  const before = (value: string | undefined) => value !== undefined && Date.parse(value) <= boundary
  const sorted = (items: string[]) => items.sort()
  return {
    turnObservations: sorted([...domain.table('turn_observations').entries()]
      .filter(([, value]) => before(value.observedAt)).map(([id]) => id)),
    sessionBatches: sorted([...domain.table('session_batches').entries()]
      .filter(([, value]) => before(value.createdAt)).map(([id]) => id)),
    experienceIntents: sorted([...domain.table('experience_intents').entries()]
      .filter(([, value]) => before(value.createdAt)).map(([id]) => id)),
    proposalLineages: sorted([...domain.table('proposal_lineages').entries()]
      .filter(([, value]) => before(value.origin === 'RUN2SKILL_V2'
        ? value.createdAt
        : value.legacySnapshot.revisions[0]?.committedAt)).map(([id]) => id)),
    legacyItems: sorted([...domain.table('legacy_items').entries()]
      .filter(([, value]) => before(value.sourceWorkItem.createdAt)).map(([id]) => id)),
  }
}

function candidateDigest(hideBefore: string, value: CandidateSet): string {
  return sha256Utf8(canonicalJson({ hideBefore, ...value }))
}

function sameCandidates(left: CandidateSet, right: CandidateSet): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function phase(global: GlobalV2): PurgeStatusV1 {
  const journal = global.purgeJournal
  if (journal === undefined) return { apiVersion: 1, state: 'IDLE' }
  return {
    apiVersion: 1,
    state: 'IN_PROGRESS',
    purgeId: journal.purgeId,
    hideBefore: journal.hideBefore,
    startedAt: journal.updatedAt,
    phase: journal.phase === 'DELETING'
      ? 'DELETING_WORK_ITEMS'
      : journal.phase === 'VALIDATING'
        ? 'VERIFYING'
        : 'HIDING',
    deletedWorkItems: 0,
    deletedLineages: 0,
  }
}

/** Fresh-v2 cache clearing. It never opens or interprets the retired v1 domain. */
export class V2PurgeService {
  readonly #global: Run2skillV2GlobalStore
  readonly #previews = new Map<string, StoredPreview>()
  readonly #completed = new Map<string, PurgeReceiptV1>()
  #tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly domain: Run2skillV2Domain,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.#global = Run2skillV2GlobalStore.for(domain)
  }

  async preview(scope: 'ALL' | 'PROJECT' | 'USER'): Promise<PurgePreviewV1> {
    if (scope !== 'ALL') throw new PurgeError('PURGE_SCOPE_UNAVAILABLE')
    if (this.domain.global.get().purgeJournal !== undefined) throw new PurgeError('PURGE_ALREADY_RUNNING')
    const hideBefore = new Date(this.now()).toISOString()
    const selected = candidates(this.domain, hideBefore)
    const digest = candidateDigest(hideBefore, selected)
    const previewId = `purv_${sha256Utf8(canonicalJson({ digest, nonce: randomUUID() }))}`
    const value: PurgePreviewV1 = {
      apiVersion: 1,
      previewId,
      digest,
      expiresAt: new Date(this.now() + PREVIEW_TTL_MS).toISOString(),
      scopeBinding: { scope: 'ALL' },
      hideBefore,
      workItemCount: selected.experienceIntents.length,
      lineageCount: selected.proposalLineages.length,
      derivedRecordCount: selected.turnObservations.length + selected.sessionBatches.length + selected.legacyItems.length,
      blockedOrUnprovenCount: 0,
      willDelete: [
        { kind: 'WORK_ITEMS', count: selected.experienceIntents.length },
        { kind: 'LINEAGES', count: selected.proposalLineages.length },
      ],
      willKeep: [
        { reason: 'KEEP_NEW', count: 0 },
        { reason: 'KEEP_SCOPE', count: 0 },
        { reason: 'KEEP_UNPROVEN', count: 0 },
      ],
      busyPublicationCount: this.#busy() ? 1 : 0,
    }
    this.#previews.set(previewId, { value, candidates: selected })
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
      const stored = this.#previews.get(previewId)
      if (
        stored === undefined
        || stored.value.digest !== digest
        || Date.parse(stored.value.expiresAt) <= this.now()
        || confirmationScope?.scope !== 'ALL'
      ) throw new PurgeError('PURGE_PREVIEW_STALE')
      if (this.#busy()) throw new PurgeError('PURGE_BUSY', 1)
      const current = candidates(this.domain, stored.value.hideBefore)
      if (!sameCandidates(current, stored.candidates)) throw new PurgeError('PURGE_PREVIEW_STALE')
      const purgeId = `purge_${sha256Utf8(canonicalJson({ previewId, digest }))}`
      await this.#begin(purgeId, stored.value.hideBefore)
      await this.#finish(purgeId, stored.value.hideBefore)
      const receipt: PurgeReceiptV1 = {
        apiVersion: 1,
        purgeId,
        state: 'COMPLETED',
        deletedWorkItems: stored.value.workItemCount,
        deletedLineages: stored.value.lineageCount,
      }
      this.#completed.set(previewId, receipt)
      this.#previews.delete(previewId)
      return receipt
    })
  }

  status(): PurgeStatusV1 {
    return phase(this.domain.global.get())
  }

  retry(purgeId: string): Promise<PurgeReceiptV1> {
    return this.#serialize(async () => {
      const journal = this.domain.global.get().purgeJournal
      if (journal?.purgeId !== purgeId) throw new PurgeError('PURGE_PREVIEW_STALE')
      await this.#finish(journal.purgeId, journal.hideBefore)
      return {
        apiVersion: 1,
        purgeId,
        state: 'COMPLETED',
        deletedWorkItems: 0,
        deletedLineages: 0,
      }
    })
  }

  async recover(): Promise<void> {
    const journal = this.domain.global.get().purgeJournal
    if (journal !== undefined) await this.#serialize(async () => {
      await this.#finish(journal.purgeId, journal.hideBefore)
    })
  }

  #busy(): boolean {
    const global = this.domain.global.get()
    return global.proposalGenerationLease !== undefined
      || global.proposalCatalogMutationJournal !== undefined
      || [...this.domain.table('session_batches').entries()]
        .some(([, batch]) => batch.state === 'DETECTION_CLAIMED')
  }

  async #begin(purgeId: string, hideBefore: string): Promise<void> {
    const accepted = await this.#global.runExclusive(async current => {
      if (current.purgeJournal !== undefined) return { value: current.purgeJournal.purgeId === purgeId }
      if (
        current.proposalGenerationLease !== undefined
        || current.proposalCatalogMutationJournal !== undefined
        || [...this.domain.table('session_batches').entries()]
          .some(([, batch]) => batch.state === 'DETECTION_CLAIMED')
      ) {
        return { value: false }
      }
      return {
        value: true,
        global: {
          ...current,
          purgeJournal: {
            schemaVersion: 1,
            purgeId,
            scopeBinding: { scope: 'ALL' },
            hideBefore,
            phase: 'QUIESCED',
            updatedAt: new Date(this.now()).toISOString(),
          },
        },
      }
    })
    if (!accepted) throw new PurgeError('PURGE_BUSY', 1)
  }

  async #finish(purgeId: string, hideBefore: string): Promise<void> {
    await this.#setPhase(purgeId, 'DELETING')
    const selected = candidates(this.domain, hideBefore)
    for (const id of selected.proposalLineages) await this.domain.table('proposal_lineages').delete(id)
    for (const id of selected.experienceIntents) await this.domain.table('experience_intents').delete(id)
    for (const id of selected.sessionBatches) await this.domain.table('session_batches').delete(id)
    for (const id of selected.turnObservations) await this.domain.table('turn_observations').delete(id)
    for (const id of selected.legacyItems) await this.domain.table('legacy_items').delete(id)
    await this.#setPhase(purgeId, 'VALIDATING')
    const residual = candidates(this.domain, hideBefore)
    if (Object.values(residual).some(items => items.length > 0)) throw new PurgeError('PURGE_STORAGE_UNAVAILABLE')
    const remainingIntentIds = new Set(this.domain.table('experience_intents').keys())
    await this.#global.runExclusive(async current => {
      if (current.purgeJournal?.purgeId !== purgeId) throw new PurgeError('PURGE_STORAGE_UNAVAILABLE')
      if (current.proposalGenerationLease !== undefined || current.proposalCatalogMutationJournal !== undefined) {
        throw new PurgeError('PURGE_BUSY', 1)
      }
      const { purgeJournal: _purgeJournal, ...stable } = current
      const sessions = Object.fromEntries(Object.entries(current.sessions).map(([key, session]) => {
        const { activeBatchId: _activeBatchId, batchManifestBaseline: _baseline, ...cursor } = session
        return [key, { ...cursor, openExperienceCarry: [] }]
      }))
      const nextEpoch = current.proposalCatalogEpoch + 1
      return {
        value: undefined,
        global: {
          ...stable,
          sessions,
          behaviorSignatureIndex: Object.fromEntries(Object.entries(current.behaviorSignatureIndex)
            .filter(([, entry]) => remainingIntentIds.has(entry.ownerIntentId))),
          proposalCatalogEpoch: nextEpoch,
          proposalCatalogLastMutation: deriveProposalCatalogMutationAnchorV2({
            ownerId: purgeId,
            kind: 'PURGE',
            inputCatalogEpoch: current.proposalCatalogEpoch,
          }),
        },
      }
    })
  }

  async #setPhase(purgeId: string, next: 'DELETING' | 'VALIDATING'): Promise<void> {
    await this.#global.runExclusive(async current => {
      if (current.purgeJournal?.purgeId !== purgeId) throw new PurgeError('PURGE_STORAGE_UNAVAILABLE')
      return {
        value: undefined,
        global: {
          ...current,
          purgeJournal: {
            ...current.purgeJournal,
            phase: next,
            updatedAt: new Date(this.now()).toISOString(),
          },
        },
      }
    })
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation)
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }
}
