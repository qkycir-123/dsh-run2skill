import { Run2skillV2GlobalStore } from '../../adapters/dsh-storage/v2-global-store.js'
import type { Run2skillV2Domain } from '../../adapters/dsh-storage/v2-types.js'
import type { Run2skillTable } from '../../adapters/dsh-storage/types.js'
import {
  ExperienceIntentV2Schema,
  ProposalLineageV2Schema,
  deriveBehaviorSignatureIndexKeyV2,
  deriveGenerationBarrierIdV2,
  deriveGenerationBarrierReceiptDigestV2,
  deriveProposalCatalogMutationAnchorV2,
  deriveProposalCatalogMutationIdV2,
  deriveProposalCatalogMutationReceiptDigestV2,
  deriveRecallSelfExclusionDigestV2,
  type ExperienceIntentV2,
  type ProposalLineageV2,
} from '../../domain/v2/index.js'
import { deriveV2ProposalRef, type V2ProposalRef } from './v2-proposal-review.js'

type NativeLineage = Extract<ProposalLineageV2, { readonly origin: 'RUN2SKILL_V2' }>

export interface V2ProposalRefreshRequest {
  readonly lineageId: string
  readonly expectedLineageRevision: number
  readonly proposalRef: V2ProposalRef
}

export interface V2ProposalRefreshResult {
  readonly changed: boolean
  readonly lineage: NativeLineage
}

export class V2ProposalRefreshError extends Error {
  constructor(readonly code:
    | 'REFRESH_LINEAGE_NOT_FOUND'
    | 'REFRESH_REVISION_CONFLICT'
    | 'STALE_PROPOSAL_REF'
    | 'INVALID_REFRESH_STATE'
    | 'REFRESH_INPUT_UNAVAILABLE'
    | 'REFRESH_BUSY'
    | 'REFRESH_RECOVERY_CONFLICT',
  ) {
    super(code)
    this.name = 'V2ProposalRefreshError'
  }
}

function sameRef(left: V2ProposalRef, right: V2ProposalRef): boolean {
  return left.proposalId === right.proposalId
    && left.revision === right.revision
    && left.digest === right.digest
}

function refreshable(lineage: NativeLineage): boolean {
  const proposal = lineage.proposalRevisions.at(-1)
  return lineage.state === 'ACTIVE_PROPOSAL' && proposal !== undefined && (
    (proposal.reviewDecision === undefined && proposal.reviewFailureCode === 'CATALOG_CHANGED')
    || (proposal.reviewDecision === 'APPROVED' && (
      proposal.publicationFailureCode === 'CATALOG_CHANGED'
      || proposal.publicationFailureCode === 'PUBLICATION_CONFLICT'
    ))
  )
}

/** Re-enters recall after a stale Proposal while retaining the superseded revision for audit. */
export class V2ProposalRefreshCoordinator {
  readonly #global: Run2skillV2GlobalStore
  readonly #lineages: Run2skillTable<string, ProposalLineageV2>
  readonly #intents: Run2skillTable<string, ExperienceIntentV2>
  readonly #now: () => string
  #tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly domain: Run2skillV2Domain,
    options: { readonly now?: () => string } = {},
  ) {
    this.#global = Run2skillV2GlobalStore.for(domain)
    this.#lineages = domain.table('proposal_lineages')
    this.#intents = domain.table('experience_intents')
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  refresh(request: V2ProposalRefreshRequest): Promise<V2ProposalRefreshResult> {
    return this.#serialize(async () => {
      const lineage = this.#lineage(request.lineageId)
      if (!sameRef(deriveV2ProposalRef(lineage), request.proposalRef)) {
        throw new V2ProposalRefreshError('STALE_PROPOSAL_REF')
      }
      if (lineage.revision !== request.expectedLineageRevision) {
        throw new V2ProposalRefreshError('REFRESH_REVISION_CONFLICT')
      }
      if (!refreshable(lineage)) throw new V2ProposalRefreshError('INVALID_REFRESH_STATE')
      const proposalId = request.proposalRef.proposalId
      await this.#prepare(proposalId)
      try {
        const refreshed = await this.#resume(lineage, proposalId)
        return { changed: true, lineage: refreshed }
      } catch (caught) {
        await this.#recoverPrepared(proposalId).catch(() => {})
        throw caught
      }
    })
  }

  recover(): Promise<'IDLE' | 'RECOVERED'> {
    return this.#serialize(async () => {
      const journal = this.#global.get().proposalCatalogMutationJournal
      if (journal?.kind !== 'USER_ACTION') return 'IDLE'
      const recovered = await this.#recoverPrepared(journal.ownerId)
      return recovered ? 'RECOVERED' : 'IDLE'
    })
  }

  async #prepare(proposalId: string): Promise<void> {
    await this.#global.runExclusive(async current => {
      const existing = current.proposalCatalogMutationJournal
      if (existing !== undefined) {
        if (existing.kind === 'USER_ACTION' && existing.ownerId === proposalId) return { value: undefined }
        throw new V2ProposalRefreshError('REFRESH_BUSY')
      }
      if (
        current.migration.phase !== 'COMMITTED'
        || current.activation === undefined
        || current.proposalGenerationLease !== undefined
        || current.purgeJournal !== undefined
      ) throw new V2ProposalRefreshError('REFRESH_BUSY')
      return { value: undefined, global: {
        ...current,
        proposalCatalogMutationJournal: {
          schemaVersion: 1,
          mutationId: deriveProposalCatalogMutationIdV2({
            ownerId: proposalId,
            kind: 'USER_ACTION',
            inputCatalogEpoch: current.proposalCatalogEpoch,
          }),
          ownerId: proposalId,
          kind: 'USER_ACTION',
          phase: 'PREPARED',
          preparedAt: this.#now(),
        },
      } }
    })
  }

  async #resume(initial: NativeLineage, proposalId: string): Promise<NativeLineage> {
    let lineage = initial
    if (lineage.state !== 'REFRESHING') {
      const updated = await this.#lineages.update(lineage.lineageId, raw => {
        const current = ProposalLineageV2Schema.parse(raw)
        if (current.origin !== 'RUN2SKILL_V2') throw new V2ProposalRefreshError('REFRESH_LINEAGE_NOT_FOUND')
        if (!refreshable(current) || current.proposalRevisions.at(-1)?.proposalId !== proposalId) {
          throw new V2ProposalRefreshError('INVALID_REFRESH_STATE')
        }
        const latest = current.proposalRevisions.at(-1)!
        return ProposalLineageV2Schema.parse({
          ...current,
          revision: current.revision + 1,
          state: 'REFRESHING',
          proposalRevisions: [...current.proposalRevisions.slice(0, -1), { ...latest, state: 'SUPERSEDED' }],
          updatedAt: this.#now(),
        })
      })
      if (updated.origin !== 'RUN2SKILL_V2') throw new V2ProposalRefreshError('REFRESH_LINEAGE_NOT_FOUND')
      lineage = updated
    }
    const intent = await this.#refreshIntent(lineage, proposalId)
    await this.#finalize(intent, proposalId)
    return this.#lineage(lineage.lineageId)
  }

  async #refreshIntent(lineage: NativeLineage, proposalId: string): Promise<ExperienceIntentV2> {
    const raw = this.#intents.get(lineage.ownerIntentId)
    const existing = ExperienceIntentV2Schema.safeParse(raw)
    if (!existing.success) throw new V2ProposalRefreshError('REFRESH_INPUT_UNAVAILABLE')
    if (
      existing.data.status === 'RECALLING'
      && existing.data.generation.staleRefreshUsed
      && existing.data.recall.selfExclusion !== undefined
    ) return existing.data
    const global = this.#global.get()
    const journal = global.proposalCatalogMutationJournal
    const intent = existing.data
    const sealed = intent.generation.sealedResult
    if (
      journal?.kind !== 'USER_ACTION'
      || journal.ownerId !== proposalId
      || intent.status !== 'PROPOSAL_READY'
      || intent.lineageId !== lineage.lineageId
      || intent.generation.staleRefreshUsed
      || sealed === undefined
      || intent.generation.leaseId === undefined
      || intent.generation.generationRevision === undefined
      || intent.generation.inputDigest === undefined
    ) throw new V2ProposalRefreshError('REFRESH_INPUT_UNAVAILABLE')
    const inputEpoch = global.proposalCatalogEpoch
    const outcomeEpoch = inputEpoch + 1
    const recordedAt = this.#now()
    const barrierId = deriveGenerationBarrierIdV2({
      leaseId: intent.generation.leaseId,
      intentId: intent.intentId,
      generationRevision: intent.generation.generationRevision,
      kind: 'STALE_RESULT',
      inputDigest: intent.generation.inputDigest,
      callId: sealed.callId,
    })
    const mutationReceiptDigest = deriveProposalCatalogMutationReceiptDigestV2({
      mutationId: journal.mutationId,
      ownerId: proposalId,
      kind: 'USER_ACTION',
      outcomeCatalogEpoch: outcomeEpoch,
    })
    const barrier = {
      barrierId,
      leaseId: intent.generation.leaseId,
      intentId: intent.intentId,
      generationRevision: intent.generation.generationRevision,
      kind: 'STALE_RESULT' as const,
      behaviorSignature: intent.behaviorSignature,
      inputDigest: intent.generation.inputDigest,
      callId: sealed.callId,
      priorGenerationRevision: intent.generation.generationRevision,
      inputCatalogEpoch: inputEpoch,
      outcomeCatalogEpoch: outcomeEpoch,
      mutationReceiptDigest,
      recordedAt,
      receiptDigest: deriveGenerationBarrierReceiptDigestV2({
        barrierId, mutationReceiptDigest, outcomeCatalogEpoch: outcomeEpoch, recordedAt,
      }),
    }
    const selfExclusionFacts = {
      intentId: intent.intentId,
      priorGenerationRevision: intent.generation.generationRevision,
      barrierReceiptDigest: mutationReceiptDigest,
    }
    const updated = await this.#intents.update(intent.intentId, rawIntent => {
      const current = ExperienceIntentV2Schema.parse(rawIntent)
      if (current.revision !== intent.revision || current.status !== 'PROPOSAL_READY') {
        throw new V2ProposalRefreshError('REFRESH_REVISION_CONFLICT')
      }
      const { lineageId: _lineageId, ...stable } = current
      return ExperienceIntentV2Schema.parse({
        ...stable,
        revision: current.revision + 1,
        status: 'RECALLING',
        recall: {
          state: 'SCANNING',
          complete: false,
          summaryScanComplete: false,
          candidates: [],
          selfExclusion: {
            ...selfExclusionFacts,
            selfExclusionDigest: deriveRecallSelfExclusionDigestV2(selfExclusionFacts),
          },
        },
        coverage: { state: 'NOT_STARTED', retryUsed: false },
        generation: {
          state: 'NOT_STARTED',
          userRetryUsed: current.generation.userRetryUsed,
          staleRefreshUsed: true,
          receipts: [],
        },
        duplicateBarrier: barrier,
        updatedAt: recordedAt,
      })
    })
    return ExperienceIntentV2Schema.parse(updated)
  }

  async #finalize(intent: ExperienceIntentV2, proposalId: string): Promise<void> {
    await this.#global.runExclusive(async current => {
      const journal = current.proposalCatalogMutationJournal
      if (journal?.kind !== 'USER_ACTION' || journal.ownerId !== proposalId) {
        throw new V2ProposalRefreshError('REFRESH_RECOVERY_CONFLICT')
      }
      const key = deriveBehaviorSignatureIndexKeyV2(intent.persistenceScope, intent.behaviorSignature)
      const indexed = current.behaviorSignatureIndex[key]
      if (indexed?.ownerIntentId !== intent.intentId) {
        throw new V2ProposalRefreshError('REFRESH_RECOVERY_CONFLICT')
      }
      const { proposalCatalogMutationJournal: _journal, ...stable } = current
      return { value: undefined, global: {
        ...stable,
        behaviorSignatureIndex: {
          ...current.behaviorSignatureIndex,
          [key]: { ...indexed, ownerRevision: intent.revision, state: 'RESERVED', updatedAt: this.#now() },
        },
        proposalCatalogEpoch: current.proposalCatalogEpoch + 1,
        proposalCatalogLastMutation: deriveProposalCatalogMutationAnchorV2({
          ownerId: proposalId,
          kind: 'USER_ACTION',
          inputCatalogEpoch: current.proposalCatalogEpoch,
        }),
      } }
    })
  }

  async #recoverPrepared(proposalId: string): Promise<boolean> {
    const matches = [...this.#lineages.entries()].flatMap(([, raw]) => {
      const parsed = ProposalLineageV2Schema.safeParse(raw)
      if (!parsed.success || parsed.data.origin !== 'RUN2SKILL_V2') return []
      return parsed.data.proposalRevisions.at(-1)?.proposalId === proposalId ? [parsed.data] : []
    })
    if (matches.length !== 1) return false
    const lineage = matches[0]!
    if (lineage.state !== 'REFRESHING' && !refreshable(lineage)) {
      throw new V2ProposalRefreshError('REFRESH_RECOVERY_CONFLICT')
    }
    await this.#resume(lineage, proposalId)
    return true
  }

  #lineage(lineageId: string): NativeLineage {
    const parsed = ProposalLineageV2Schema.safeParse(this.#lineages.get(lineageId))
    if (!parsed.success || parsed.data.origin !== 'RUN2SKILL_V2') {
      throw new V2ProposalRefreshError('REFRESH_LINEAGE_NOT_FOUND')
    }
    return parsed.data
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation)
    this.#tail = result.then(() => {}, () => {})
    return result
  }
}
