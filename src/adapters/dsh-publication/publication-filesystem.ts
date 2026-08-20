import type {
  PublicationFileSystemPort,
  PublicationFileSystemResult,
  PublicationRootPreparation,
} from '../../application/publication/index.js'
import type { RootBindingV1, ProposalSnapshotV1 } from '../../domain/review/index.js'
import type { CaptureWorkItemV1 } from '../../domain/observe/schemas.js'
import {
  PublicationConflict,
  createBundle,
  finalizeTransaction,
  mergeBundle,
  observePublicationRoot,
  preparePublicationRoot,
  recoverTransaction,
  verifyFinalizedTransaction,
  verifyPublicationDirectoryIdentity,
} from './filesystem-cas.mjs'

export interface C5PublicationFileSystemOptions {
  readonly verifyParity: (
    binding: RootBindingV1,
    canonicalRoot: string,
    item: CaptureWorkItemV1,
  ) => Promise<boolean>
  readonly verifyIdentity?: (canonicalPath: string, identityDigest: string) => Promise<boolean>
}

function writableBinding(proposal: ProposalSnapshotV1) {
  const binding = proposal.actionBinding
  if (binding.kind === 'DISCARD') throw new PublicationConflict('unsafe_kind', 'DISCARD has no filesystem publication')
  return binding
}

export class C5PublicationFileSystemAdapter implements PublicationFileSystemPort {
  readonly #verifyParity
  readonly #verifyIdentity

  constructor(options: C5PublicationFileSystemOptions) {
    this.#verifyParity = options.verifyParity
    this.#verifyIdentity = options.verifyIdentity ?? verifyPublicationDirectoryIdentity
  }

  async recover(input: {
    readonly proposal: ProposalSnapshotV1
    readonly attemptId: string
  }): Promise<PublicationFileSystemResult | { readonly status: 'NO_JOURNAL' }> {
    const binding = writableBinding(input.proposal)
    const observed = await observePublicationRoot(binding.rootBinding.declaredRootPath)
    if (observed.status === 'ABSENT') return { status: 'NO_JOURNAL' }
    try {
      return await recoverTransaction({
        root: binding.rootBinding.declaredRootPath,
        txid: input.attemptId,
      })
    } catch (caught) {
      if (caught instanceof PublicationConflict && caught.code === 'journal_missing') {
        return { status: 'NO_JOURNAL' }
      }
      throw caught
    }
  }

  async prepareRoot(item: CaptureWorkItemV1): Promise<PublicationRootPreparation> {
    const proposal = item.review?.proposal
    if (proposal === undefined) throw new PublicationConflict('unsafe_kind', 'Publication Proposal is unavailable')
    const binding = writableBinding(proposal)
    return await preparePublicationRoot({
      binding: binding.rootBinding,
      verifyIdentity: this.#verifyIdentity,
      verifyParity: (rootBinding, canonicalRoot) => this.#verifyParity(rootBinding, canonicalRoot, item),
    })
  }

  async write(input: {
    readonly proposal: ProposalSnapshotV1
    readonly attemptId: string
    readonly rootPreparation: PublicationRootPreparation
  }): Promise<PublicationFileSystemResult> {
    const binding = writableBinding(input.proposal)
    if (binding.kind === 'CREATE') {
      return await createBundle({
        root: input.rootPreparation.root,
        name: input.proposal.name,
        txid: input.attemptId,
        nextBytes: input.proposal.exactSkillBytes,
        rootPreparation: input.rootPreparation,
      })
    }
    return await mergeBundle({
      root: input.rootPreparation.root,
      name: input.proposal.name,
      txid: input.attemptId,
      expectedHash: binding.baseBinding.bytesDigest,
      nextBytes: input.proposal.exactSkillBytes,
      rootPreparation: input.rootPreparation,
    })
  }

  async finalize(input: {
    readonly proposal: ProposalSnapshotV1
    readonly attemptId: string
    readonly rootIdentityDigest: string
  }): Promise<PublicationFileSystemResult> {
    const binding = writableBinding(input.proposal)
    try {
      return await finalizeTransaction({
        root: binding.rootBinding.declaredRootPath,
        txid: input.attemptId,
        confirmedExactReadback: true,
      })
    } catch (caught) {
      if (
        caught instanceof PublicationConflict
        && caught.code === 'journal_missing'
        && await verifyFinalizedTransaction({
          root: binding.rootBinding.declaredRootPath,
          name: input.proposal.name,
          txid: input.attemptId,
          expectedHash: input.proposal.skillBytesDigest,
          expectedRootIdentityDigest: input.rootIdentityDigest,
        })
      ) return { status: 'finalized', txid: input.attemptId }
      throw caught
    }
  }
}
