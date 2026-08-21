import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  PurgeError,
  PurgeService,
  PurgeVisibility,
  type PurgeScopeResolver,
} from '../src/application/purge/index.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import {
  derivePublicationTargetIdentityDigest,
  materializeLineage,
} from '../src/domain/publication/index.js'
import type { ProjectPurgeScopeBindingV1, PurgePhaseV1 } from '../src/domain/purge/index.js'
import {
  MAX_COMPLETED_PROJECT_PURGE_FENCES,
  deriveProjectPurgeScopeIdentityDigest,
} from '../src/domain/purge/index.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeWorkItem } from './support/work-item-fixture.js'
import { WriteBehindCheckpoint } from '../src/application/capture/write-behind-checkpoint.js'
import { LearningWorkItemStore } from '../src/adapters/dsh-storage/learning-work-item-store.js'
import { DurableCaptureStore } from '../src/adapters/dsh-storage/durable-capture-store.js'
import { HostMutationGate } from '../src/application/host-mutation-gate.js'
import { makeLearningResult } from './support/learning-fixture.js'
import { deriveExperienceId, deriveLearningProposalId } from '../src/domain/learn/index.js'

const NOW = Date.parse('2026-08-21T00:00:00.000Z')
const PROJECT = join(process.cwd(), '.probe-work', 'purge-saga-project')
const ROOT = join(PROJECT, '.dsh', 'skills')
const binding: ProjectPurgeScopeBindingV1 = {
  scope: 'PROJECT',
  workspaceId: 'workspace-saga',
  canonicalWorkspacePath: PROJECT,
  workspaceObservedAt: '2026-08-21T00:00:00.000Z',
  canonicalRootPath: ROOT,
  rootContractVersion: 'stock-dsh-web-default-roots-v1',
  resolverVersion: 'stock-root-resolver-v2',
  resolutionContractDigest: 'a'.repeat(64),
}
const resolver: PurgeScopeResolver = { async resolve() { return binding } }

function oldProjectItem(turn: number, processingState: 'CAPTURED' | 'PUBLISHING' = 'CAPTURED') {
  const signalKey = {
    rootSessionId: `session-${turn}`,
    sessionCreatedAt: turn,
    sessionCwdDigest: 'a'.repeat(64),
    turn,
    turnEndSeq: turn * 10,
    turnInstanceDigest: sha256Utf8(`turn-${turn}`),
    triggerPolicyVersion: 'cheap-trigger-v1' as const,
  }
  return makeWorkItem({
    signalKey,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    workspaceBinding: {
      status: 'BOUND',
      workspaceId: binding.workspaceId,
      canonicalPath: PROJECT,
      observedAt: '2026-08-20T00:00:00.000Z',
    },
    processingState,
  })
}

async function prepareAnalyzingLearning(store: LearningWorkItemStore, item: ReturnType<typeof oldProjectItem>) {
  let current = await store.claim(item.workItemId, item.revision)
  current = await store.reserveRequest(item.workItemId, current.revision, {
    provider: 'target-provider', model: 'target-model',
  })
  return await store.recordCall(item.workItemId, current.revision, {
    requestOrdinal: 1, kind: 'PRIMARY', outcome: 'SUCCEEDED',
  })
}

function userLearningResult(item: ReturnType<typeof oldProjectItem>) {
  const projectResult = makeLearningResult(item)
  const { experienceId: _experienceId, ...experienceFacts } = {
    ...projectResult.experiences[0]!,
    persistenceScope: 'USER' as const,
  }
  const experience = {
    experienceId: deriveExperienceId(item.workItemId, experienceFacts),
    ...experienceFacts,
  }
  const { learningProposalId: _proposalId, ...proposalFacts } = {
    ...projectResult.proposal,
    persistenceScope: 'USER' as const,
    supportingExperienceIds: [experience.experienceId],
  }
  return {
    experiences: [experience],
    proposal: {
      learningProposalId: deriveLearningProposalId(item.workItemId, proposalFacts),
      ...proposalFacts,
    },
  }
}

function projectLineage() {
  const skillName = 'purge-fixture'
  const canonicalTargetPath = join(ROOT, skillName, 'SKILL.md')
  const exactSkillBytes = '---\nname: purge-fixture\ndescription: fixture\n---\n'
  return materializeLineage({
    scope: 'PROJECT',
    provider: 'filesystem',
    source: 'project-dsh',
    skillName,
    canonicalTargetPath,
    targetIdentityDigest: derivePublicationTargetIdentityDigest({
      scope: 'PROJECT', provider: 'filesystem', source: 'project-dsh', skillName, canonicalTargetPath,
    }),
    revisions: [{
      revision: 1,
      origin: 'RUN2SKILL',
      proposalId: `prop_${'1'.repeat(64)}`,
      exactSkillBytes,
      skillBytesDigest: sha256Utf8(exactSkillBytes),
      committedAt: '2026-08-20T00:00:00.000Z',
    }],
  })
}

function populatedDomain() {
  const domain = createMemoryRun2skillDomain()
  const item = oldProjectItem(1)
  const kept = makeWorkItem({
    signalKey: { ...item.signalKey, rootSessionId: 'unproven', turn: 2, turnEndSeq: 20, turnInstanceDigest: 'b'.repeat(64) },
  })
  domain.workItems.set(item.workItemId, item)
  domain.workItems.set(kept.workItemId, kept)
  const lineage = projectLineage()
  domain.lineages.set(lineage.lineageId, lineage)
  return { domain, item, kept, lineage }
}

describe('recoverable Purge saga', () => {
  it('previews immutably, hides before deleting, completes idempotently, and keeps unproven data', async () => {
    const { domain, item, kept, lineage } = populatedDomain()
    const hidden = vi.fn()
    const service = new PurgeService(domain, resolver, { now: () => NOW, onHidden: hidden })
    const preview = await service.preview('PROJECT', binding.workspaceId)
    expect(preview).toMatchObject({
      workItemCount: 1,
      lineageCount: 1,
      blockedOrUnprovenCount: 1,
      busyPublicationCount: 0,
    })

    const [receipt, duplicate] = await Promise.all([
      service.confirm(preview.previewId, preview.digest),
      service.confirm(preview.previewId, preview.digest),
    ])
    expect(receipt).toMatchObject({ state: 'COMPLETED', deletedWorkItems: 1, deletedLineages: 1 })
    expect(duplicate).toEqual(receipt)
    expect(hidden).toHaveBeenCalledTimes(1)
    expect(domain.workItems.has(item.workItemId)).toBe(false)
    expect(domain.lineages.has(lineage.lineageId)).toBe(false)
    expect(domain.workItems.has(kept.workItemId)).toBe(true)
    expect(service.status()).toEqual({ apiVersion: 1, state: 'IDLE' })
    await expect(new LearningWorkItemStore(domain).recordCallLatest(item.workItemId, 1, {
      requestOrdinal: 1,
      kind: 'PRIMARY',
      outcome: 'SUCCEEDED',
    })).rejects.toMatchObject({ code: 'LEARNING_WORK_ITEM_NOT_FOUND' })
    expect(domain.workItems.has(item.workItemId)).toBe(false)
  })

  it('rejects stale, expired, changed, and busy previews without writing a journal', async () => {
    const expiredDomain = populatedDomain().domain
    let now = NOW
    const expired = new PurgeService(expiredDomain, resolver, { now: () => now, previewTtlMs: 100 })
    const expiredPreview = await expired.preview('PROJECT', binding.workspaceId)
    now += 100
    await expect(expired.confirm(expiredPreview.previewId, expiredPreview.digest))
      .rejects.toMatchObject({ code: 'PURGE_PREVIEW_STALE' })
    expect(expiredDomain.global.get().purgeJournal).toBeUndefined()

    const changedDomain = populatedDomain().domain
    const changed = new PurgeService(changedDomain, resolver, { now: () => NOW })
    const changedPreview = await changed.preview('PROJECT', binding.workspaceId)
    const extra = oldProjectItem(3)
    changedDomain.workItems.set(extra.workItemId, extra)
    await expect(changed.confirm(changedPreview.previewId, changedPreview.digest))
      .rejects.toMatchObject({ code: 'PURGE_PREVIEW_STALE' })
    expect(changedDomain.global.get().purgeJournal).toBeUndefined()

    const driftDomain = populatedDomain().domain
    let scopeReads = 0
    const drift = new PurgeService(driftDomain, {
      async resolve() {
        scopeReads += 1
        return scopeReads === 1 ? binding : { ...binding, resolutionContractDigest: 'f'.repeat(64) }
      },
    }, { now: () => NOW })
    const driftPreview = await drift.preview('PROJECT', binding.workspaceId)
    await expect(drift.confirm(driftPreview.previewId, driftPreview.digest))
      .rejects.toMatchObject({ code: 'PURGE_PREVIEW_STALE' })
    expect(driftDomain.global.get().purgeJournal).toBeUndefined()

    const busyDomain = createMemoryRun2skillDomain()
    const busy = oldProjectItem(4, 'PUBLISHING')
    busyDomain.workItems.set(busy.workItemId, busy)
    const busyService = new PurgeService(busyDomain, resolver, { now: () => NOW })
    const busyPreview = await busyService.preview('PROJECT', binding.workspaceId)
    await expect(busyService.confirm(busyPreview.previewId, busyPreview.digest))
      .rejects.toEqual(new PurgeError('PURGE_BUSY', 1))
    expect(busyDomain.global.get().purgeJournal).toBeUndefined()
  })

  it.each([
    'HIDING',
    'DELETING_LINEAGES',
    'DELETING_WORK_ITEMS',
    'VERIFYING',
  ] satisfies PurgePhaseV1[])('recovers after a process stop at %s', async (stopPhase) => {
    const { domain, item } = populatedDomain()
    let stopped = false
    const first = new PurgeService(domain, resolver, {
      now: () => NOW,
      onPhasePersisted(phase) {
        if (!stopped && phase === stopPhase) {
          stopped = true
          throw new Error('synthetic process stop')
        }
      },
    })
    const preview = await first.preview('PROJECT', binding.workspaceId)
    await expect(first.confirm(preview.previewId, preview.digest))
      .rejects.toMatchObject({ code: 'PURGE_STORAGE_UNAVAILABLE' })
    expect(new PurgeVisibility(domain).workItemVisible(item)).toBe(false)
    expect(domain.global.get().purgeJournal?.phase).toBe(stopPhase)

    const restarted = new PurgeService(domain, resolver, { now: () => NOW + 1 })
    await expect(restarted.recover()).resolves.toMatchObject({ state: 'COMPLETED' })
    expect(domain.global.get().purgeJournal).toBeUndefined()
  })

  it('keeps data hidden after delete failure and retry resumes the same purgeId', async () => {
    const { domain, item } = populatedDomain()
    domain.failNextLineageDeletes(1)
    const service = new PurgeService(domain, resolver, { now: () => NOW })
    const preview = await service.preview('PROJECT', binding.workspaceId)
    await expect(service.confirm(preview.previewId, preview.digest))
      .rejects.toMatchObject({ code: 'PURGE_STORAGE_UNAVAILABLE' })
    const journal = domain.global.get().purgeJournal!
    expect(journal.lastError?.code).toBe('PURGE_STORAGE_UNAVAILABLE')
    expect(new PurgeVisibility(domain).workItemVisible(item)).toBe(false)

    const receipt = await service.retry(journal.purgeId)
    expect(receipt).toMatchObject({ purgeId: journal.purgeId, state: 'COMPLETED' })
  })

  it('recovers after partial cross-table deletion without restoring hidden records', async () => {
    const { domain, item, lineage } = populatedDomain()
    domain.failNextWorkItemDeletes(1)
    const service = new PurgeService(domain, resolver, { now: () => NOW })
    const preview = await service.preview('PROJECT', binding.workspaceId)
    await expect(service.confirm(preview.previewId, preview.digest))
      .rejects.toMatchObject({ code: 'PURGE_STORAGE_UNAVAILABLE' })
    expect(domain.lineages.has(lineage.lineageId)).toBe(false)
    expect(domain.workItems.has(item.workItemId)).toBe(true)
    expect(new PurgeVisibility(domain).workItemVisible(item)).toBe(false)
    const purgeId = domain.global.get().purgeJournal!.purgeId
    await expect(service.retry(purgeId)).resolves.toMatchObject({
      purgeId,
      state: 'COMPLETED',
      deletedLineages: 1,
      deletedWorkItems: 1,
    })
  })

  it('deletes sidecar facts before each main WorkItem and safely resumes a crash between domains', async () => {
    const { domain, item } = populatedDomain()
    const sidecars = new Set([item.workItemId])
    let crash = true
    const beforeDeleteWorkItem = async (workItemId: string) => {
      expect(domain.workItems.has(workItemId)).toBe(true)
      sidecars.delete(workItemId)
      if (crash) {
        crash = false
        throw new Error('synthetic crash after sidecar delete')
      }
    }
    const first = new PurgeService(domain, resolver, { now: () => NOW, beforeDeleteWorkItem })
    const preview = await first.preview('PROJECT', binding.workspaceId)

    await expect(first.confirm(preview.previewId, preview.digest))
      .rejects.toMatchObject({ code: 'PURGE_STORAGE_UNAVAILABLE' })
    expect(sidecars.has(item.workItemId)).toBe(false)
    expect(domain.workItems.has(item.workItemId)).toBe(true)

    const restarted = new PurgeService(domain, resolver, { now: () => NOW + 1, beforeDeleteWorkItem })
    await expect(restarted.recover()).resolves.toMatchObject({ state: 'COMPLETED' })
    expect(domain.workItems.has(item.workItemId)).toBe(false)
  })

  it('serializes checkpoint writes with the journal and never resurrects a cleared fence', async () => {
    const domain = createMemoryRun2skillDomain()
    const checkpoint = new WriteBehindCheckpoint(domain, { now: () => NOW })
    const journal = {
      schemaVersion: 1 as const,
      purgeId: `purge_${'1'.repeat(64)}`,
      scopeBinding: binding,
      hideBefore: new Date(NOW).toISOString(),
      candidateDigest: '2'.repeat(64),
      startedAt: new Date(NOW).toISOString(),
      phase: 'HIDING' as const,
      deletedWorkItems: 0,
      deletedLineages: 0,
    }
    await domain.global.set({ ...domain.global.get(), purgeJournal: journal })
    const session = (id: string, createdAt: number) => ({
      rootSessionId: id,
      sessionCreatedAt: createdAt,
      sessionCwdDigest: sha256Utf8(id),
      triggerPolicyVersion: 'cheap-trigger-v1' as const,
      activationFenceSeq: 0,
      durableNextSeq: 0,
      observedTailSeq: 0,
    })
    await checkpoint.activate([session('checkpoint-one', 1)])
    expect(domain.global.get().purgeJournal).toEqual(journal)
    await domain.global.set({ ...domain.global.get(), purgeJournal: undefined })
    await checkpoint.activate([session('checkpoint-two', 2)])
    expect(domain.global.get().purgeJournal).toBeUndefined()
    const scopeIdentityDigest = deriveProjectPurgeScopeIdentityDigest(binding)
    const completedPurgeFences = {
      schemaVersion: 1 as const,
      projects: {
        [scopeIdentityDigest]: {
          schemaVersion: 1 as const,
          scope: 'PROJECT' as const,
          purgeId: journal.purgeId,
          completedAt: new Date(NOW).toISOString(),
          hideBefore: journal.hideBefore,
          scopeIdentityDigest,
        },
      },
    }
    await domain.global.set({ ...domain.global.get(), completedPurgeFences })
    await checkpoint.activate([session('checkpoint-three', 3)])
    expect(domain.global.get().completedPurgeFences).toEqual(completedPurgeFences)
  })

  it('serializes capture writes with Purge and rejects a late recreation after the journal clears', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = oldProjectItem(12)
    domain.workItems.set(item.workItemId, item)
    const visibility = new PurgeVisibility(domain)
    const gate = new HostMutationGate()
    const store = new DurableCaptureStore(
      domain,
      undefined,
      visibility,
      operation => gate.run(operation),
    )
    let markHidden!: () => void
    const hidden = new Promise<void>(resolve => { markHidden = resolve })
    let continuePurge!: () => void
    const purgeCanContinue = new Promise<void>(resolve => { continuePurge = resolve })
    const service = new PurgeService(domain, resolver, {
      now: () => NOW,
      async onHidden() {
        markHidden()
        await purgeCanContinue
      },
    })
    const preview = await service.preview('PROJECT', binding.workspaceId)

    const confirmation = gate.run(async () => await service.confirm(preview.previewId, preview.digest))
    await hidden
    const lateWrite = store.persist(item)
    continuePurge()
    await confirmation
    expect(domain.global.get().purgeJournal).toBeUndefined()
    expect(domain.workItems.has(item.workItemId)).toBe(false)

    await expect(lateWrite).rejects.toMatchObject({ code: 'PURGED_WORK_ITEM' })
    expect(domain.workItems.has(item.workItemId)).toBe(false)
  })

  it('rejects a late Learning completion that would enter the purged scope', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = oldProjectItem(13)
    domain.workItems.set(item.workItemId, item)
    const visibility = new PurgeVisibility(domain)
    const gate = new HostMutationGate()
    const learning = new LearningWorkItemStore(
      domain,
      () => '2026-08-20T00:00:10.000Z',
      visibility,
      operation => gate.run(operation),
    )
    const current = await prepareAnalyzingLearning(learning, item)
    let markHidden!: () => void
    const hidden = new Promise<void>(resolve => { markHidden = resolve })
    let continuePurge!: () => void
    const purgeCanContinue = new Promise<void>(resolve => { continuePurge = resolve })
    const service = new PurgeService(domain, { async resolve() { return { scope: 'USER' } } }, {
      now: () => NOW,
      async onHidden() {
        markHidden()
        await purgeCanContinue
      },
    })
    const preview = await service.preview('USER')
    expect(preview.workItemCount).toBe(0)

    const confirmation = gate.run(async () => await service.confirm(preview.previewId, preview.digest))
    await hidden
    const completion = learning.complete(item.workItemId, current.revision, userLearningResult(item))
    continuePurge()
    await confirmation

    await expect(completion).rejects.toMatchObject({ code: 'INVALID_LEARNING_STATE' })
    expect(domain.workItems.get(item.workItemId)?.learning?.proposal).toBeUndefined()
  })

  it('does not let a late USER Learning completion escape a PROJECT purge', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = oldProjectItem(14)
    domain.workItems.set(item.workItemId, item)
    const visibility = new PurgeVisibility(domain)
    const gate = new HostMutationGate()
    const learning = new LearningWorkItemStore(
      domain,
      () => '2026-08-20T00:00:10.000Z',
      visibility,
      operation => gate.run(operation),
    )
    const current = await prepareAnalyzingLearning(learning, item)
    let markHidden!: () => void
    const hidden = new Promise<void>(resolve => { markHidden = resolve })
    let continuePurge!: () => void
    const purgeCanContinue = new Promise<void>(resolve => { continuePurge = resolve })
    const service = new PurgeService(domain, resolver, {
      now: () => NOW,
      async onHidden() {
        markHidden()
        await purgeCanContinue
      },
    })
    const preview = await service.preview('PROJECT', binding.workspaceId)
    expect(preview.workItemCount).toBe(1)

    const confirmation = gate.run(async () => await service.confirm(preview.previewId, preview.digest))
    await hidden
    const completion = learning.complete(item.workItemId, current.revision, userLearningResult(item))
    continuePurge()
    await confirmation

    await expect(completion).rejects.toMatchObject({ code: 'LEARNING_WORK_ITEM_NOT_FOUND' })
    expect(domain.workItems.has(item.workItemId)).toBe(false)
  })

  it('atomically persists a completed fence while clearing the active journal', async () => {
    const { domain } = populatedDomain()
    const writes: ReturnType<typeof domain.global.get>[] = []
    const setGlobal = domain.global.set.bind(domain.global)
    domain.global.set = async value => {
      writes.push(structuredClone(value))
      await setGlobal(value)
    }
    const service = new PurgeService(domain, resolver, { now: () => NOW })
    const preview = await service.preview('PROJECT', binding.workspaceId)

    const receipt = await service.confirm(preview.previewId, preview.digest)

    const final = domain.global.get()
    const scopeIdentityDigest = deriveProjectPurgeScopeIdentityDigest(binding)
    expect(receipt.state).toBe('COMPLETED')
    expect(final.purgeJournal).toBeUndefined()
    expect(final.completedPurgeFences?.projects[scopeIdentityDigest]).toMatchObject({
      schemaVersion: 1,
      scope: 'PROJECT',
      purgeId: receipt.purgeId,
      hideBefore: preview.hideBefore,
      completedAt: new Date(NOW).toISOString(),
      scopeIdentityDigest,
    })
    const verifying = writes.findLastIndex(value => value.purgeJournal?.phase === 'VERIFYING')
    expect(verifying).toBeGreaterThanOrEqual(0)
    expect(writes[verifying + 1]).toMatchObject({
      purgeJournal: undefined,
      completedPurgeFences: { schemaVersion: 1 },
    })
  })

  it('rebuilds PROJECT visibility from durable fences and permits only new turns', async () => {
    const { domain } = populatedDomain()
    const service = new PurgeService(domain, resolver, { now: () => NOW })
    const preview = await service.preview('PROJECT', binding.workspaceId)
    await service.confirm(preview.previewId, preview.digest)

    const restartedVisibility = new PurgeVisibility(domain)
    const restartedStore = new DurableCaptureStore(domain, undefined, restartedVisibility)
    await expect(restartedStore.persist(oldProjectItem(19)))
      .rejects.toMatchObject({ code: 'PURGED_WORK_ITEM' })
    const fresh = oldProjectItem(16)
    const afterBoundary = {
      ...fresh,
      createdAt: '2026-08-21T00:00:00.001Z',
      updatedAt: '2026-08-21T00:00:00.001Z',
    }
    await expect(restartedStore.persist(afterBoundary)).resolves.toMatchObject({ changed: true })
  })

  it('rebuilds USER fences after restart, blocks late USER classification, and allows PROJECT', async () => {
    const domain = createMemoryRun2skillDomain()
    const userCandidate = oldProjectItem(17)
    const projectCandidate = oldProjectItem(18)
    domain.workItems.set(userCandidate.workItemId, userCandidate)
    domain.workItems.set(projectCandidate.workItemId, projectCandidate)
    const before = new LearningWorkItemStore(domain, () => '2026-08-20T00:00:10.000Z')
    const pendingUser = await prepareAnalyzingLearning(before, userCandidate)
    const pendingProject = await prepareAnalyzingLearning(before, projectCandidate)
    const service = new PurgeService(domain, { async resolve() { return { scope: 'USER' } } }, {
      now: () => NOW,
    })
    const preview = await service.preview('USER')
    expect(preview.workItemCount).toBe(0)
    await service.confirm(preview.previewId, preview.digest)

    const restarted = new LearningWorkItemStore(
      domain,
      () => '2026-08-21T00:00:00.001Z',
      new PurgeVisibility(domain),
    )
    await expect(restarted.complete(
      userCandidate.workItemId,
      pendingUser.revision,
      userLearningResult(userCandidate),
    )).rejects.toMatchObject({ code: 'INVALID_LEARNING_STATE' })
    await expect(restarted.complete(
      projectCandidate.workItemId,
      pendingProject.revision,
      makeLearningResult(projectCandidate),
    )).resolves.toMatchObject({ processingState: 'LEARNED', learning: { proposal: { persistenceScope: 'PROJECT' } } })
  })

  it('upserts the latest same-scope fence without growing the PROJECT set', async () => {
    const domain = createMemoryRun2skillDomain()
    let now = NOW
    const service = new PurgeService(domain, resolver, { now: () => now })
    const first = await service.preview('PROJECT', binding.workspaceId)
    const firstReceipt = await service.confirm(first.previewId, first.digest)
    now += 1_000
    const second = await service.preview('PROJECT', binding.workspaceId)
    const secondReceipt = await service.confirm(second.previewId, second.digest)

    const fences = domain.global.get().completedPurgeFences!
    expect(Object.keys(fences.projects)).toHaveLength(1)
    expect(fences.projects[deriveProjectPurgeScopeIdentityDigest(binding)]).toMatchObject({
      purgeId: secondReceipt.purgeId,
      hideBefore: second.hideBefore,
    })
    expect(secondReceipt.purgeId).not.toBe(firstReceipt.purgeId)
  })

  it('allows existing scope at the 1024 limit and rejects a new PROJECT before preview or journal', async () => {
    const domain = createMemoryRun2skillDomain()
    const scopeIdentityDigest = deriveProjectPurgeScopeIdentityDigest(binding)
    const projects = Object.fromEntries(Array.from(
      { length: MAX_COMPLETED_PROJECT_PURGE_FENCES },
      (_, index) => {
        const digest = index === 0 ? scopeIdentityDigest : index.toString(16).padStart(64, '0')
        return [digest, {
          schemaVersion: 1 as const,
          scope: 'PROJECT' as const,
          purgeId: `purge_${digest}`,
          completedAt: '2026-08-20T00:00:00.000Z',
          hideBefore: '2026-08-20T00:00:00.000Z',
          scopeIdentityDigest: digest,
        }]
      },
    ))
    await domain.global.set({
      ...domain.global.get(),
      completedPurgeFences: { schemaVersion: 1, projects },
    })
    const existing = new PurgeService(domain, resolver, { now: () => NOW })
    await expect(existing.preview('PROJECT', binding.workspaceId)).resolves.toBeDefined()

    const overflowBinding = {
      ...binding,
      workspaceId: 'workspace-overflow',
      canonicalWorkspacePath: join(PROJECT, 'overflow'),
      canonicalRootPath: join(PROJECT, 'overflow', '.dsh', 'skills'),
      resolutionContractDigest: 'f'.repeat(64),
    }
    const overflow = new PurgeService(domain, { async resolve() { return overflowBinding } }, { now: () => NOW })
    await expect(overflow.preview('PROJECT', overflowBinding.workspaceId))
      .rejects.toMatchObject({ code: 'PURGE_FENCE_LIMIT' })
    expect(domain.global.get().purgeJournal).toBeUndefined()

    const confirmDomain = createMemoryRun2skillDomain()
    const entries = Object.entries(projects)
    await confirmDomain.global.set({
      ...confirmDomain.global.get(),
      completedPurgeFences: {
        schemaVersion: 1,
        projects: Object.fromEntries(entries.slice(0, MAX_COMPLETED_PROJECT_PURGE_FENCES - 1)),
      },
    })
    const confirmService = new PurgeService(
      confirmDomain,
      { async resolve() { return overflowBinding } },
      { now: () => NOW },
    )
    const confirmPreview = await confirmService.preview('PROJECT', overflowBinding.workspaceId)
    await confirmDomain.global.set({
      ...confirmDomain.global.get(),
      completedPurgeFences: { schemaVersion: 1, projects },
    })
    await expect(confirmService.confirm(confirmPreview.previewId, confirmPreview.digest))
      .rejects.toMatchObject({ code: 'PURGE_FENCE_LIMIT' })
    expect(confirmDomain.global.get().purgeJournal).toBeUndefined()
  })
})
