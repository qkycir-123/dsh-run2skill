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

/** Rechecks the complete Runtime/Pending Catalog before review and publication. */
export class V2ProposalCatalogRevalidator {
  constructor(private readonly catalog: GenerationCatalogPort) {}

  async revalidate(input: V2ProposalPublicationInput): Promise<V2ProposalReviewRevalidation> {
    let snapshot: GenerationCatalogSnapshot
    try {
      snapshot = await this.catalog.snapshot({ batch: input.batch, intent: input.intent })
    } catch {
      return { status: 'UNAVAILABLE' }
    }
    if (!snapshot.complete) return { status: 'UNAVAILABLE' }
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
        || input.proposal.baseSkillBytesDigest === undefined
        || sha256Utf8(target.content) !== input.proposal.targetIdentityDigest
        || target.skillBytesDigest !== input.proposal.baseSkillBytesDigest
      ) return { status: 'STALE' }
      let after: GenerationCatalogSnapshot
      try {
        after = await this.catalog.snapshot({ batch: input.batch, intent: input.intent })
      } catch {
        return { status: 'UNAVAILABLE' }
      }
      if (!after.complete) return { status: 'UNAVAILABLE' }
      if (!sameSnapshot(snapshot, after)) return { status: 'STALE' }
    }
    return currentResult(snapshot)
  }
}
