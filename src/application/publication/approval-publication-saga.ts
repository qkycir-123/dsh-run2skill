import { PublicationTargetSingleFlight } from '../../adapters/dsh-publication/target-single-flight.js'
import {
  PublicationSagaStore,
  PublicationSagaStoreError,
} from '../../adapters/dsh-storage/publication-saga-store.js'
import type { CaptureWorkItemV1 } from '../../domain/observe/schemas.js'
import {
  deriveLineageId,
  materializeLineage,
  type LineageRevisionV1,
  type LineageV1,
} from '../../domain/publication/index.js'
import type { ProposalSnapshotV1 } from '../../domain/review/index.js'

export type PublicationRevalidationResult =
  | { readonly status: 'VALID' }
  | {
    readonly status: 'NEEDS_REFRESH' | 'NEEDS_ATTENTION' | 'PUBLISH_FAILED'
    readonly code: string
    readonly retryable?: boolean
  }

export interface PublicationRevalidationPort {
  revalidate(item: CaptureWorkItemV1): Promise<PublicationRevalidationResult>
}

export interface PublicationRootPreparation {
  readonly root: string
  readonly createdSegments: readonly string[]
  readonly rootIdentityDigest: string
}

export interface PublicationFileSystemResult {
  readonly status: 'written' | 'conflict' | 'finalized'
  readonly code?: string | undefined
  readonly txid: string
  readonly target?: string | undefined
  readonly backup?: string | null | undefined
}

export interface PublicationFileSystemPort {
  recover(input: {
    readonly proposal: ProposalSnapshotV1
    readonly attemptId: string
  }): Promise<PublicationFileSystemResult | { readonly status: 'NO_JOURNAL' }>
  prepareRoot(item: CaptureWorkItemV1): Promise<PublicationRootPreparation>
  write(input: {
    readonly proposal: ProposalSnapshotV1
    readonly attemptId: string
    readonly rootPreparation: PublicationRootPreparation
  }): Promise<PublicationFileSystemResult>
  finalize(input: {
    readonly proposal: ProposalSnapshotV1
    readonly attemptId: string
    readonly rootIdentityDigest: string
  }): Promise<PublicationFileSystemResult>
}

export type PublicationReadbackResult =
  | { readonly status: 'CONFIRMED'; readonly observedHash: string }
  | { readonly status: 'CHANGED'; readonly code: string }
  | { readonly status: 'TIMEOUT'; readonly code: string }

export interface PublicationReadbackPort {
  confirmExact(item: CaptureWorkItemV1): Promise<PublicationReadbackResult>
}

export interface PublicationSingleFlightPort {
  run<T>(canonicalTargetPath: string, task: () => Promise<T>): Promise<T>
}

export interface ApprovalPublicationSagaOptions {
  readonly store: PublicationSagaStore
  readonly revalidation: PublicationRevalidationPort
  readonly fileSystem: PublicationFileSystemPort
  readonly readback: PublicationReadbackPort
  readonly singleFlight?: PublicationSingleFlightPort
  readonly now?: () => string
}

const REFRESH_CONFLICTS = new Set([
  'expected_absence_changed',
  'target_appeared',
  'base_changed',
  'base_changed_during_cutover',
  'backup_exists',
  'rename_race',
  'readback_changed',
])

function currentStage(item: CaptureWorkItemV1, stage: string): boolean {
  const publication = item.publication
  return publication?.journal.some(event => (
    event.attemptId === publication.activeAttemptId && event.stage === stage
  )) ?? false
}

type WritableActionBinding = Exclude<ProposalSnapshotV1['actionBinding'], { kind: 'DISCARD' }>
type WritableProposal = ProposalSnapshotV1 & {
  readonly kind: 'CREATE' | 'MERGE'
  readonly actionBinding: WritableActionBinding
}

function actionProposal(item: CaptureWorkItemV1): WritableProposal {
  const proposal = item.review?.proposal
  if (
    item.processingState !== 'PUBLISHING'
    || item.review?.reviewDecision !== 'APPROVED'
    || item.review.publicationOutcome !== 'PENDING_REVIEW'
    || item.publication === undefined
    || proposal === undefined
    || proposal.actionBinding.kind === 'DISCARD'
  ) throw new PublicationSagaStoreError('INVALID_PUBLICATION_STATE')
  return { ...proposal, kind: proposal.actionBinding.kind, actionBinding: proposal.actionBinding }
}

export class ApprovalPublicationSaga {
  readonly #store
  readonly #revalidation
  readonly #fileSystem
  readonly #readback
  readonly #singleFlight
  readonly #now

  constructor(options: ApprovalPublicationSagaOptions) {
    this.#store = options.store
    this.#revalidation = options.revalidation
    this.#fileSystem = options.fileSystem
    this.#readback = options.readback
    this.#singleFlight = options.singleFlight ?? new PublicationTargetSingleFlight()
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async run(workItemId: string): Promise<CaptureWorkItemV1> {
    const snapshot = this.#store.get(workItemId)
    if (snapshot === undefined) throw new PublicationSagaStoreError('PUBLICATION_WORK_ITEM_NOT_FOUND')
    if (snapshot.processingState === 'TERMINAL' && snapshot.review?.publicationOutcome === 'PUBLISHED') {
      return snapshot
    }
    const proposal = actionProposal(snapshot)
    return await this.#singleFlight.run(
      proposal.actionBinding.targetBinding.skillFilePath,
      async () => await this.#runLocked(workItemId),
    )
  }

  async #runLocked(workItemId: string): Promise<CaptureWorkItemV1> {
    let item = this.#store.get(workItemId)!
    const proposal = actionProposal(item)
    const publication = item.publication!

    if (currentStage(item, 'LINEAGE_COMMITTED')) {
      return await this.#finalizeAndComplete(item, proposal)
    }
    if (currentStage(item, 'LINEAGE_PENDING')) {
      try {
        item = await this.#store.commitLineage(workItemId)
        return await this.#finalizeAndComplete(item, proposal)
      } catch (caught) {
        return await this.#failFromException(item, caught, 'LINEAGE_COMMIT_FAILED')
      }
    }

    let diskWritten = false
    try {
      const attempts = [
        publication.activeAttemptId,
        ...[...publication.journal].reverse().map(event => event.attemptId),
      ].filter((attemptId, index, all) => all.indexOf(attemptId) === index)
      for (const attemptId of attempts) {
        const recovered = await this.#fileSystem.recover({ proposal, attemptId })
        if (recovered.status === 'conflict') {
          return await this.#failConflict(item, recovered.code ?? 'unknown')
        }
        if (recovered.status === 'written') {
          diskWritten = true
          break
        }
      }
    } catch (caught) {
      return await this.#failFromException(item, caught, 'FILESYSTEM_RECOVERY_FAILED')
    }

    if (!diskWritten) {
      const existing = this.#existingLineage(item)
      const latest = existing?.revisions.at(-1)
      if (
        latest?.origin === 'RUN2SKILL'
        && latest.proposalId === proposal.proposalId
        && latest.skillBytesDigest === proposal.skillBytesDigest
      ) {
        // A prior attempt committed Lineage and exact readback but lost only the
        // final WorkItem outcome. Re-read the target; never rewrite it here.
        diskWritten = true
      } else if (proposal.kind === 'CREATE' && existing !== undefined) {
        return await this.#store.fail(workItemId, 'NEEDS_REFRESH', 'MANAGED_TARGET_DELETED', false)
      }
    }

    if (!diskWritten) {
      let revalidated: PublicationRevalidationResult
      try {
        revalidated = await this.#revalidation.revalidate(item)
      } catch {
        revalidated = { status: 'NEEDS_ATTENTION', code: 'REVALIDATION_UNAVAILABLE' }
      }
      if (revalidated.status !== 'VALID') {
        return await this.#store.fail(
          workItemId,
          revalidated.status,
          revalidated.code,
          revalidated.retryable ?? revalidated.status === 'PUBLISH_FAILED',
        )
      }
      item = await this.#store.appendEvent(
        workItemId,
        'FACTS_REVALIDATED',
        proposal.actionBinding.kind === 'MERGE'
          ? { expectedHash: proposal.actionBinding.baseBinding.bytesDigest }
          : {},
      )

      let rootPreparation: PublicationRootPreparation
      try {
        rootPreparation = await this.#fileSystem.prepareRoot(item)
      } catch (caught) {
        return await this.#failFromException(item, caught, 'ROOT_PREPARATION_FAILED')
      }
      item = await this.#store.appendEvent(workItemId, 'ROOT_PREPARED', {
        observedHash: rootPreparation.rootIdentityDigest,
      })

      try {
        const written = await this.#fileSystem.write({
          proposal,
          attemptId: item.publication!.activeAttemptId,
          rootPreparation,
        })
        if (written.status === 'conflict') return await this.#failConflict(item, written.code ?? 'unknown')
        if (written.status !== 'written') {
          return await this.#store.fail(workItemId, 'PUBLISH_FAILED', 'FILESYSTEM_WRITE_FAILED', true)
        }
      } catch (caught) {
        return await this.#failFromException(item, caught, 'FILESYSTEM_WRITE_FAILED')
      }
    }

    item = await this.#store.appendEvent(workItemId, 'TARGET_INSTALLED', {
      observedHash: proposal.skillBytesDigest,
    })
    item = await this.#store.appendEvent(workItemId, 'DISK_VERIFIED', {
      expectedHash: proposal.skillBytesDigest,
      observedHash: proposal.skillBytesDigest,
    })

    let readback: PublicationReadbackResult
    try {
      readback = await this.#readback.confirmExact(item)
    } catch {
      readback = { status: 'TIMEOUT', code: 'READBACK_UNAVAILABLE' }
    }
    if (readback.status === 'CHANGED') {
      return await this.#store.fail(workItemId, 'NEEDS_REFRESH', readback.code, false)
    }
    if (readback.status === 'TIMEOUT') {
      return await this.#store.fail(workItemId, 'PUBLISH_FAILED', readback.code, true)
    }
    if (readback.observedHash !== proposal.skillBytesDigest) {
      return await this.#store.fail(workItemId, 'NEEDS_REFRESH', 'READBACK_CHANGED', false)
    }
    item = await this.#store.appendEvent(workItemId, 'READBACK_CONFIRMED', {
      expectedHash: proposal.skillBytesDigest,
      observedHash: readback.observedHash,
    })

    let lineage: LineageV1
    try {
      lineage = this.#nextLineage(item)
      item = await this.#store.stageLineage(workItemId, lineage)
      item = await this.#store.commitLineage(workItemId)
    } catch (caught) {
      return await this.#failFromException(item, caught, 'LINEAGE_COMMIT_FAILED')
    }
    return await this.#finalizeAndComplete(item, proposal)
  }

  #existingLineage(item: CaptureWorkItemV1): LineageV1 | undefined {
    const publication = item.publication!
    const lineageId = deriveLineageId(
      item.review!.proposal.persistenceScope,
      publication.targetIdentityDigest,
    )
    return this.#store.getLineage(lineageId)
  }

  #nextLineage(item: CaptureWorkItemV1): LineageV1 {
    const proposal = actionProposal(item)
    const binding = proposal.actionBinding
    const publication = item.publication!
    const existing = this.#existingLineage(item)
    if (
      existing?.revisions.at(-1)?.origin === 'RUN2SKILL'
      && existing.revisions.at(-1)?.proposalId === proposal.proposalId
      && existing.revisions.at(-1)?.skillBytesDigest === proposal.skillBytesDigest
    ) return existing

    const revisions: LineageRevisionV1[] = existing === undefined ? [] : [...existing.revisions]
    if (binding.kind === 'MERGE') {
      const baseOrigin = existing === undefined ? 'ADOPTED_BASE' : 'MANUAL_BASE'
      if (revisions.at(-1)?.skillBytesDigest !== binding.baseBinding.bytesDigest) {
        revisions.push({
          revision: revisions.length + 1,
          origin: baseOrigin,
          exactSkillBytes: binding.baseBinding.exactBytes,
          skillBytesDigest: binding.baseBinding.bytesDigest,
          committedAt: this.#now(),
        })
      }
    } else if (existing !== undefined) {
      throw new PublicationSagaStoreError('LINEAGE_CONFLICT')
    }
    revisions.push({
      revision: revisions.length + 1,
      origin: 'RUN2SKILL',
      proposalId: proposal.proposalId,
      exactSkillBytes: proposal.exactSkillBytes,
      skillBytesDigest: proposal.skillBytesDigest,
      committedAt: this.#now(),
    })
    return materializeLineage({
      scope: proposal.persistenceScope,
      provider: binding.rootBinding.provider,
      source: binding.rootBinding.source,
      skillName: proposal.name,
      canonicalTargetPath: binding.targetBinding.skillFilePath,
      targetIdentityDigest: publication.targetIdentityDigest,
      revisions,
    })
  }

  async #finalizeAndComplete(
    item: CaptureWorkItemV1,
    proposal: ProposalSnapshotV1,
  ): Promise<CaptureWorkItemV1> {
    try {
      const filesystemAttemptId = item.publication!.journal.find(event => (
        event.stage === 'TARGET_INSTALLED'
      ))?.attemptId
      const rootIdentityDigest = item.publication!.journal.find(event => (
        event.stage === 'ROOT_PREPARED'
        && event.attemptId === filesystemAttemptId
      ))?.observedHash
      if (filesystemAttemptId === undefined || rootIdentityDigest === undefined) {
        return await this.#store.fail(
          item.workItemId,
          'PUBLISH_FAILED',
          'FILESYSTEM_TRANSACTION_UNAVAILABLE',
          true,
        )
      }
      const finalized = await this.#fileSystem.finalize({
        proposal,
        attemptId: filesystemAttemptId,
        rootIdentityDigest,
      })
      if (finalized.status === 'conflict') return await this.#failConflict(item, finalized.code ?? 'unknown')
      if (finalized.status !== 'finalized') {
        return await this.#store.fail(item.workItemId, 'PUBLISH_FAILED', 'FILESYSTEM_FINALIZE_FAILED', true)
      }
      return await this.#store.complete(item.workItemId)
    } catch (caught) {
      return await this.#failFromException(item, caught, 'FILESYSTEM_FINALIZE_FAILED')
    }
  }

  async #failConflict(item: CaptureWorkItemV1, code: string): Promise<CaptureWorkItemV1> {
    return await this.#store.fail(
      item.workItemId,
      REFRESH_CONFLICTS.has(code) ? 'NEEDS_REFRESH' : 'NEEDS_ATTENTION',
      REFRESH_CONFLICTS.has(code) ? 'PUBLICATION_FACTS_CHANGED' : 'PUBLICATION_UNSAFE_STATE',
      false,
    )
  }

  async #failFromException(
    item: CaptureWorkItemV1,
    caught: unknown,
    fallbackCode: string,
  ): Promise<CaptureWorkItemV1> {
    if (caught instanceof PublicationSagaStoreError && caught.code === 'LINEAGE_CONFLICT') {
      return await this.#store.fail(item.workItemId, 'NEEDS_ATTENTION', 'LINEAGE_CONFLICT', false)
    }
    const unsafe = typeof caught === 'object' && caught !== null && 'code' in caught
      && typeof caught.code === 'string'
      && /unsafe|changed|mismatch|identity|parity/u.test(caught.code)
    return await this.#store.fail(
      item.workItemId,
      unsafe ? 'NEEDS_ATTENTION' : 'PUBLISH_FAILED',
      unsafe ? 'PUBLICATION_UNSAFE_STATE' : fallbackCode,
      !unsafe,
    )
  }
}
