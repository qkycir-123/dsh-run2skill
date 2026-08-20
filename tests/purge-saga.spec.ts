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
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeWorkItem } from './support/work-item-fixture.js'
import { WriteBehindCheckpoint } from '../src/application/capture/write-behind-checkpoint.js'
import { LearningWorkItemStore } from '../src/adapters/dsh-storage/learning-work-item-store.js'
import { DurableCaptureStore } from '../src/adapters/dsh-storage/durable-capture-store.js'
import { HostMutationGate } from '../src/application/host-mutation-gate.js'

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
      async onHidden(journal) {
        visibility.remember(journal)
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
})
