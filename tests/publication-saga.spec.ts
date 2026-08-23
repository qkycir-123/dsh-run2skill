import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { C5PublicationFileSystemAdapter } from '../src/adapters/dsh-publication/publication-filesystem.js'
import {
  probeInternals,
  verifyPublicationDirectoryIdentity,
} from '../src/adapters/dsh-publication/filesystem-cas.mjs'
import { NodePublicationFactsAdapter } from '../src/adapters/dsh-publication/publication-facts.js'
import { ProposalReviewStore } from '../src/adapters/dsh-storage/proposal-review-store.js'
import { PublicationSagaStore } from '../src/adapters/dsh-storage/publication-saga-store.js'
import {
  ApprovalPublicationSaga,
  type PublicationFileSystemPort,
  type PublicationReadbackPort,
  type PublicationRevalidationPort,
} from '../src/application/publication/index.js'
import {
  materializeProposalSnapshot,
  proposalRefOf,
  type ProposalSnapshotV1,
} from '../src/domain/review/index.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { materializeLineage } from '../src/domain/publication/index.js'
import {
  makeCreateProposalSnapshot,
  makeLearnedWorkItem,
  makeMergeProposalSnapshot,
} from './support/review-fixture.js'

const fixedNow = () => '2026-08-20T00:00:10.000Z'

async function approvedFixture(kind: 'CREATE' | 'MERGE' = 'CREATE') {
  const domain = createMemoryRun2skillDomain()
  const learned = makeLearnedWorkItem()
  domain.workItems.set(learned.workItemId, learned)
  const review = new ProposalReviewStore(domain, fixedNow)
  const proposal = kind === 'CREATE'
    ? makeCreateProposalSnapshot(learned)
    : makeMergeProposalSnapshot(learned)
  const staged = await review.stage(learned.workItemId, learned.revision, proposal)
  const approved = await review.approve(
    learned.workItemId,
    staged.item.revision,
    proposalRefOf(proposal),
  )
  return { domain, item: approved.item, proposal }
}

function ports(proposal: ProposalSnapshotV1, overrides: {
  revalidation?: PublicationRevalidationPort
  fileSystem?: Partial<PublicationFileSystemPort>
  readback?: PublicationReadbackPort
} = {}) {
  const revalidation: PublicationRevalidationPort = overrides.revalidation ?? {
    async revalidateRootContract() { return { status: 'VALID' } },
    async revalidate() { return { status: 'VALID' } },
  }
  const fileSystem: PublicationFileSystemPort = {
    async recover() { return { status: 'NO_JOURNAL' } },
    async prepareRoot(item) {
      const currentProposal = item.review!.proposal
      const binding = currentProposal.actionBinding.kind === 'DISCARD'
        ? undefined
        : currentProposal.actionBinding.rootBinding
      if (binding === undefined) throw new Error('unexpected DISCARD')
      return {
        root: binding.declaredRootPath,
        createdSegments: binding.state === 'ABSENT' ? binding.missingSegments : [],
        rootIdentityDigest: 'f'.repeat(64),
      }
    },
    async write() { return { status: 'written', txid: 'tx', target: 'target', backup: null } },
    async finalize() { return { status: 'finalized', txid: 'tx', target: 'target', backup: null } },
    ...overrides.fileSystem,
  }
  const readback: PublicationReadbackPort = overrides.readback ?? {
    async confirmExact() { return { status: 'CONFIRMED', observedHash: proposal.skillBytesDigest } },
  }
  return {
    revalidation,
    fileSystem,
    readback,
    singleFlight: { async run<T>(_path: string, task: () => Promise<T>) { return await task() } },
  }
}

describe('ApprovalPublicationSaga', () => {
  it('publishes CREATE only after exact readback and a durable r1 Lineage', async () => {
    const { domain, item, proposal } = await approvedFixture()
    const store = new PublicationSagaStore(domain, fixedNow)
    const dependencies = ports(proposal)
    const saga = new ApprovalPublicationSaga({ store, ...dependencies, now: fixedNow })

    const result = await saga.run(item.workItemId)

    expect(result).toMatchObject({
      processingState: 'TERMINAL',
      review: { reviewDecision: 'APPROVED', publicationOutcome: 'PUBLISHED' },
    })
    expect([...domain.lineages.values()][0]).toMatchObject({
      currentRevision: 1,
      revisions: [{ revision: 1, origin: 'RUN2SKILL', proposalId: proposal.proposalId }],
    })
    expect(result.publication?.journal.map(event => event.stage)).toEqual([
      'APPROVAL_COMMITTED',
      'FACTS_REVALIDATED',
      'ROOT_PREPARED',
      'TARGET_INSTALLED',
      'DISK_VERIFIED',
      'READBACK_CONFIRMED',
      'LINEAGE_PENDING',
      'LINEAGE_COMMITTED',
      'OUTCOME_COMMITTED',
    ])
  })

  it('adopts an unmanaged MERGE Base as r1 and commits approved bytes as r2', async () => {
    const { domain, item, proposal } = await approvedFixture('MERGE')
    const store = new PublicationSagaStore(domain, fixedNow)
    const saga = new ApprovalPublicationSaga({ store, ...ports(proposal), now: fixedNow })

    await saga.run(item.workItemId)

    expect([...domain.lineages.values()][0]).toMatchObject({
      currentRevision: 2,
      revisions: [
        { revision: 1, origin: 'ADOPTED_BASE' },
        { revision: 2, origin: 'RUN2SKILL', proposalId: proposal.proposalId },
      ],
    })
  })

  it('keeps APPROVED but does not touch disk when revalidation facts changed', async () => {
    const { domain, item, proposal } = await approvedFixture()
    const store = new PublicationSagaStore(domain, fixedNow)
    const dependencies = ports(proposal, {
      revalidation: {
        async revalidateRootContract() { return { status: 'VALID' } },
        async revalidate() { return { status: 'NEEDS_REFRESH', code: 'EXPECTED_ABSENCE_CHANGED' } },
      },
    })
    const write = vi.spyOn(dependencies.fileSystem, 'write')
    const saga = new ApprovalPublicationSaga({ store, ...dependencies, now: fixedNow })

    const result = await saga.run(item.workItemId)

    expect(write).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      processingState: 'NEEDS_ATTENTION',
      review: {
        reviewDecision: 'APPROVED',
        publicationOutcome: 'NEEDS_REFRESH',
        failure: { code: 'EXPECTED_ABSENCE_CHANGED', retryable: false },
      },
    })
  })

  it('stops before journal recovery when the approved root contract changed after a written crash', async () => {
    const { domain, item, proposal } = await approvedFixture()
    const store = new PublicationSagaStore(domain, fixedNow)
    const recover = vi.fn(async () => ({ status: 'written' as const, txid: 'tx', target: 'target', backup: null }))
    const readback = vi.fn(async () => ({
      status: 'CONFIRMED' as const,
      observedHash: proposal.skillBytesDigest,
    }))
    const saga = new ApprovalPublicationSaga({
      store,
      ...ports(proposal, {
        revalidation: {
          async revalidateRootContract() {
            return { status: 'NEEDS_ATTENTION', code: 'ROOT_CONTRACT_UNSUPPORTED' }
          },
          async revalidate() { return { status: 'VALID' } },
        },
        fileSystem: { recover },
        readback: { confirmExact: readback },
      }),
      now: fixedNow,
    })

    const result = await saga.run(item.workItemId)

    expect(recover).not.toHaveBeenCalled()
    expect(readback).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      processingState: 'NEEDS_ATTENTION',
      review: {
        publicationOutcome: 'NEEDS_ATTENTION',
        failure: { code: 'ROOT_CONTRACT_UNSUPPORTED', retryable: false },
      },
    })
  })

  it('keeps manual bytes visible as NEEDS_REFRESH and never commits Lineage', async () => {
    const { domain, item, proposal } = await approvedFixture()
    const store = new PublicationSagaStore(domain, fixedNow)
    const dependencies = ports(proposal, {
      readback: {
        async confirmExact() { return { status: 'CHANGED', code: 'REGISTRY_READBACK_CHANGED' } },
      },
    })
    const saga = new ApprovalPublicationSaga({ store, ...dependencies, now: fixedNow })

    const result = await saga.run(item.workItemId)

    expect(result).toMatchObject({
      processingState: 'NEEDS_ATTENTION',
      review: {
        reviewDecision: 'APPROVED',
        publicationOutcome: 'NEEDS_REFRESH',
        failure: { code: 'REGISTRY_READBACK_CHANGED', retryable: false },
      },
    })
    expect(domain.lineages.size).toBe(0)
  })

  it('does not resurrect a deleted managed CREATE target', async () => {
    const { domain, item, proposal } = await approvedFixture()
    const store = new PublicationSagaStore(domain, fixedNow)
    const binding = proposal.actionBinding
    if (binding.kind === 'DISCARD') throw new Error('unexpected DISCARD')
    const publication = item.publication!
    const lineage = materializeLineage({
      scope: proposal.persistenceScope,
      provider: binding.rootBinding.expectedProvider,
      source: binding.rootBinding.expectedSource,
      skillName: proposal.name,
      canonicalTargetPath: binding.targetBinding.skillFilePath,
      targetIdentityDigest: publication.targetIdentityDigest,
      revisions: [{
        revision: 1,
        origin: 'RUN2SKILL',
        proposalId: proposal.proposalId,
        exactSkillBytes: proposal.exactSkillBytes,
        skillBytesDigest: proposal.skillBytesDigest,
        committedAt: fixedNow(),
      }],
    })
    domain.lineages.set(lineage.lineageId, lineage)
    const dependencies = ports(proposal, {
      readback: {
        async confirmExact() { return { status: 'CHANGED', code: 'REGISTRY_READBACK_CHANGED' } },
      },
    })
    const write = vi.spyOn(dependencies.fileSystem, 'write')
    const saga = new ApprovalPublicationSaga({ store, ...dependencies, now: fixedNow })

    const result = await saga.run(item.workItemId)

    expect(write).not.toHaveBeenCalled()
    expect(result.review).toMatchObject({
      publicationOutcome: 'NEEDS_REFRESH',
      failure: { code: 'REGISTRY_READBACK_CHANGED', retryable: false },
    })
  })

  it('resumes written bytes after readback timeout without writing twice', async () => {
    const { domain, item, proposal } = await approvedFixture()
    const store = new PublicationSagaStore(domain, fixedNow)
    let writtenAttemptId: string | undefined
    let finalizedAttemptId: string | undefined
    let confirms = 0
    const dependencies = ports(proposal, {
      fileSystem: {
        async recover(input) {
          return input.attemptId === writtenAttemptId
            ? { status: 'written', txid: 'recovered', target: 'target', backup: null }
            : { status: 'NO_JOURNAL' }
        },
        async write(input) {
          writtenAttemptId = input.attemptId
          return { status: 'written', txid: 'written', target: 'target', backup: null }
        },
        async finalize(input) {
          finalizedAttemptId = input.attemptId
          return { status: 'finalized', txid: input.attemptId, target: 'target', backup: null }
        },
      },
      readback: {
        async confirmExact() {
          confirms += 1
          return confirms === 1
            ? { status: 'TIMEOUT', code: 'READBACK_TIMEOUT' }
            : { status: 'CONFIRMED', observedHash: proposal.skillBytesDigest }
        },
      },
    })
    const write = vi.spyOn(dependencies.fileSystem, 'write')
    const saga = new ApprovalPublicationSaga({ store, ...dependencies, now: fixedNow })

    const failed = await saga.run(item.workItemId)
    expect(failed.review?.publicationOutcome).toBe('PUBLISH_FAILED')
    const retried = await store.retry(
      failed.workItemId,
      failed.revision,
      proposalRefOf(failed.review!.proposal),
    )
    const completed = await saga.run(retried.workItemId)

    expect(write).toHaveBeenCalledTimes(1)
    expect(finalizedAttemptId).toBe(writtenAttemptId)
    expect(completed.review?.publicationOutcome).toBe('PUBLISHED')
    expect(completed.publication?.attemptCount).toBe(2)
  })

  it('recovers a finalized target when only the final WorkItem outcome write failed', async () => {
    const { domain, item, proposal } = await approvedFixture()
    const store = new PublicationSagaStore(domain, fixedNow)
    let finalizeCalls = 0
    let writtenAttemptId: string | undefined
    const finalizedAttemptIds: string[] = []
    const dependencies = ports(proposal, {
      fileSystem: {
        async write(input) {
          writtenAttemptId = input.attemptId
          return { status: 'written', txid: input.attemptId, target: 'target', backup: null }
        },
        async finalize(input) {
          finalizeCalls += 1
          finalizedAttemptIds.push(input.attemptId)
          if (finalizeCalls === 1) domain.failNextWorkItemWrites(1)
          return { status: 'finalized', txid: input.attemptId, target: 'target', backup: null }
        },
      },
    })
    const write = vi.spyOn(dependencies.fileSystem, 'write')
    const saga = new ApprovalPublicationSaga({ store, ...dependencies, now: fixedNow })

    const failed = await saga.run(item.workItemId)
    expect(failed.review?.publicationOutcome).toBe('PUBLISH_FAILED')
    expect(domain.lineages.size).toBe(1)
    const retried = await store.retry(failed.workItemId, failed.revision, proposalRefOf(proposal))
    const completed = await saga.run(retried.workItemId)

    expect(write).toHaveBeenCalledTimes(1)
    expect(finalizeCalls).toBe(2)
    expect(finalizedAttemptIds).toEqual([writtenAttemptId, writtenAttemptId])
    expect(completed.review?.publicationOutcome).toBe('PUBLISHED')
  })

  it.each([
    ['stops finalized recovery when the production C5 root disappears', 'ROOT_REMOVED'],
    ['refreshes finalized recovery when the target changes after readback', 'TARGET_CHANGED'],
    ['refreshes a journaled publication when the target changes after readback', 'JOURNALED_TARGET_CHANGED'],
  ] as const)('%s', async (_name, race) => {
    const workspace = await mkdtemp(join(tmpdir(), 'run2skill-saga-'))
    if (!basename(workspace).startsWith('run2skill-saga-')) throw new Error('unsafe cleanup')
    try {
      const domain = createMemoryRun2skillDomain()
      const learned = makeLearnedWorkItem({
        workspaceBinding: {
          status: 'BOUND',
          workspaceId: 'workspace-production-cas',
          canonicalPath: workspace,
          observedAt: '2026-08-20T00:00:00.000Z',
        },
      })
      domain.workItems.set(learned.workItemId, learned)
      const initial = makeCreateProposalSnapshot(learned)
      const { proposalId: _proposalId, digest: _digest, ...initialFacts } = initial
      const rootPath = join(workspace, '.dsh', 'skills')
      const observed = await new NodePublicationFactsAdapter().observeRoot(rootPath)
      if (observed.status !== 'ABSENT') throw new Error('expected absent root')
      const bundlePath = join(rootPath, initial.name)
      const skillFilePath = join(bundlePath, 'SKILL.md')
      const proposal = materializeProposalSnapshot(learned.workItemId, {
        ...initialFacts,
        workspaceBinding: {
          workspaceId: 'workspace-production-cas',
          canonicalPath: workspace,
          observedAt: initial.createdAt,
        },
        actionBinding: {
          kind: 'CREATE',
          rootBinding: {
            state: 'ABSENT',
            scope: 'PROJECT',
            expectedProvider: 'filesystem',
            expectedSource: 'project-dsh',
            resolverVersion: 'stock-root-resolver-v2',
            rootContractVersion: 'stock-dsh-web-default-roots-v1',
            resolutionContractDigest: 'a'.repeat(64),
            declaredRootPath: rootPath,
            canonicalExistingAncestorPath: observed.canonicalExistingAncestorPath,
            ancestorIdentityDigest: observed.ancestorIdentityDigest,
            missingSegments: [...observed.missingSegments],
          },
          targetBinding: { skillName: initial.name, bundlePath, skillFilePath },
          expectedAbsence: {
            catalogObservationDigest: initial.catalogObservationDigest,
            observedAt: initial.createdAt,
            flatSkillFilePath: join(rootPath, `${initial.name}.md`),
            bundlePathAbsent: true,
            skillFilePathAbsent: true,
            flatSkillFilePathAbsent: true,
          },
        },
      })
      const reviews = new ProposalReviewStore(domain, fixedNow)
      const staged = await reviews.stage(learned.workItemId, learned.revision, proposal)
      const approved = await reviews.approve(
        learned.workItemId,
        staged.item.revision,
        proposalRefOf(proposal),
      )
      const store = new PublicationSagaStore(domain, fixedNow)
      let replaceRootAfterIdentityCheck = false
      const productionFileSystem = new C5PublicationFileSystemAdapter({
        async verifyParity() { return true },
        async verifyIdentity(path, identityDigest) {
          const matches = await verifyPublicationDirectoryIdentity(path, identityDigest)
          if (matches && replaceRootAfterIdentityCheck && race === 'ROOT_REMOVED') {
            replaceRootAfterIdentityCheck = false
            await rename(rootPath, join(workspace, 'original-skills-root'))
          }
          return matches
        },
      })
      let failOutcomeWrite = true
      let readbackCount = 0
      const fileSystem: PublicationFileSystemPort = {
        async recover(input) { return await productionFileSystem.recover(input) },
        async prepareRoot(current) { return await productionFileSystem.prepareRoot(current) },
        async write(input) { return await productionFileSystem.write(input) },
        async finalize(input) {
          const finalized = await productionFileSystem.finalize(input)
          if (failOutcomeWrite && finalized.status === 'finalized') {
            failOutcomeWrite = false
            domain.failNextWorkItemWrites(1)
          }
          return finalized
        },
      }
      const saga = new ApprovalPublicationSaga({
        store,
        revalidation: {
          async revalidateRootContract() { return { status: 'VALID' } },
          async revalidate() { return { status: 'VALID' } },
        },
        fileSystem,
        readback: {
          async confirmExact() {
            readbackCount += 1
            if (
              (race === 'TARGET_CHANGED' && readbackCount === 2)
              || (race === 'JOURNALED_TARGET_CHANGED' && readbackCount === 1)
            ) {
              await writeFile(skillFilePath, 'manual target change')
            }
            return { status: 'CONFIRMED', observedHash: proposal.skillBytesDigest }
          },
        },
        now: fixedNow,
      })

      const failed = await saga.run(approved.item.workItemId)
      if (race === 'JOURNALED_TARGET_CHANGED') {
        expect(failed).toMatchObject({
          processingState: 'NEEDS_ATTENTION',
          review: {
            publicationOutcome: 'NEEDS_REFRESH',
            failure: { code: 'PUBLICATION_FACTS_CHANGED', retryable: false },
          },
        })
        return
      }
      expect(failed).toMatchObject({
        review: { publicationOutcome: 'PUBLISH_FAILED' },
      })
      const rootIdentityDigest = failed.publication!.journal.find(event => (
        event.stage === 'ROOT_PREPARED'
        && event.attemptId === approved.item.publication!.activeAttemptId
      ))?.observedHash
      if (rootIdentityDigest === undefined) throw new Error('expected durable root identity')
      expect(await readFile(skillFilePath, 'utf8')).toBe(proposal.exactSkillBytes)
      await expect(productionFileSystem.finalize({
        proposal,
        attemptId: approved.item.publication!.activeAttemptId,
        rootIdentityDigest,
      })).resolves.toMatchObject({ status: 'finalized' })
      const transactionJournal = join(rootPath, probeInternals.JOURNAL_DIR)
      await Promise.all((await readdir(transactionJournal))
        .filter(entry => entry.startsWith(`${approved.item.publication!.activeAttemptId}.`))
        .map(async entry => await unlink(join(transactionJournal, entry))))
      const unknownArtifact = join(
        bundlePath,
        `.run2skill-${approved.item.publication!.activeAttemptId}.backup`,
      )
      await writeFile(unknownArtifact, 'unknown artifact')
      await expect(productionFileSystem.finalize({
        proposal,
        attemptId: approved.item.publication!.activeAttemptId,
        rootIdentityDigest,
      })).rejects.toMatchObject({ code: 'journal_missing' })
      await rm(unknownArtifact)

      if (race === 'ROOT_REMOVED') {
        await rename(rootPath, join(workspace, 'original-skills-root'))
      }
      replaceRootAfterIdentityCheck = false
      const retried = await store.retry(failed.workItemId, failed.revision, proposalRefOf(proposal))
      const recovered = await saga.run(retried.workItemId)
      expect(recovered).toMatchObject(race === 'ROOT_REMOVED'
        ? {
            processingState: 'NEEDS_ATTENTION',
            review: {
              publicationOutcome: 'PUBLISH_FAILED',
              failure: { code: 'FILESYSTEM_FINALIZE_FAILED', retryable: true },
            },
          }
        : {
            processingState: 'NEEDS_ATTENTION',
            review: {
              publicationOutcome: 'NEEDS_REFRESH',
              failure: { code: 'PUBLICATION_FACTS_CHANGED', retryable: false },
            },
          })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
