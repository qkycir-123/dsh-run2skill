import type { V2ProposalPublicationInput } from '../publication/index.js'
import type { GenerationCatalogPort, GenerationCatalogSnapshot } from '../generation/index.js'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import type { V2ProposalReviewRevalidation } from './v2-proposal-review.js'

function currentResult(snapshot: GenerationCatalogSnapshot): V2ProposalReviewRevalidation {
  return {
    status: 'CURRENT',
    runtimeCatalogDigest: snapshot.runtimeCatalogDigest,
    pendingCatalogDigest: snapshot.pendingCatalogDigest,
    catalogEpoch: snapshot.catalogEpoch,
    catalogMutationReceiptDigest: snapshot.catalogMutationReceiptDigest,
  }
}

function sameSnapshot(left: GenerationCatalogSnapshot, right: GenerationCatalogSnapshot): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

export interface V2ProposalPublicationRecoveryCatalogPort {
  snapshot(input: {
    readonly batch: V2ProposalPublicationInput['batch']
    readonly intent: V2ProposalPublicationInput['intent']
    readonly proposalId: string
  }): Promise<GenerationCatalogSnapshot | undefined>
}

/** Rechecks the complete Runtime/Pending Catalog before review and publication. */
export class V2ProposalCatalogRevalidator {
  constructor(
    private readonly catalog: GenerationCatalogPort,
    private readonly publicationRecovery?: V2ProposalPublicationRecoveryCatalogPort,
  ) {}

  async revalidate(input: V2ProposalPublicationInput): Promise<V2ProposalReviewRevalidation> {
    const snapshot = await this.#snapshot(input)
    if (snapshot === undefined) return { status: 'UNAVAILABLE' }
    if (
      snapshot.runtimeCatalogDigest !== input.proposal.runtimeCatalogDigest
      || snapshot.catalogEpoch !== input.proposal.catalogEpoch
      || snapshot.catalogMutationReceiptDigest !== input.proposal.catalogMutationReceiptDigest
    ) return { status: 'STALE' }

    if (input.proposal.action === 'MERGE') {
      const candidateId = input.intent.coverage.targetCandidateId
      if (candidateId === undefined) return { status: 'STALE' }
      let target
      try {
        target = await this.catalog.read({ candidateId, batch: input.batch, intent: input.intent })
      } catch {
        return { status: 'UNAVAILABLE' }
      }
      if (
        target === undefined
        || input.proposal.targetIdentityDigest === undefined
        || input.proposal.baseSkillBytes === undefined
        || input.proposal.baseSkillBytesDigest === undefined
        || sha256Utf8(target.content) !== input.proposal.targetIdentityDigest
        || target.skillBytesDigest !== sha256Utf8(target.content)
        || target.content !== input.proposal.baseSkillBytes
        || sha256Utf8(target.content) !== input.proposal.baseSkillBytesDigest
      ) return { status: 'STALE' }
      const after = await this.#snapshot(input)
      if (after === undefined) return { status: 'UNAVAILABLE' }
      if (!sameSnapshot(snapshot, after)) return { status: 'STALE' }
    }
    return currentResult(snapshot)
  }

  async #snapshot(input: V2ProposalPublicationInput): Promise<GenerationCatalogSnapshot | undefined> {
    let snapshot: GenerationCatalogSnapshot
    try {
      snapshot = await this.catalog.snapshot({ batch: input.batch, intent: input.intent })
    } catch {
      return undefined
    }
    if (snapshot.complete) return snapshot
    if (this.publicationRecovery === undefined) return undefined
    try {
      const recovered = await this.publicationRecovery.snapshot({
        batch: input.batch,
        intent: input.intent,
        proposalId: input.proposalRef.proposalId,
      })
      return recovered?.complete === true ? recovered : undefined
    } catch {
      return undefined
    }
  }
}
