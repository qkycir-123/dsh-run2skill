import { describe, expect, it } from 'vitest'
import { migrateRun2skillV1ToV2, type Run2skillV2MigrationOptions } from '../src/application/migration/v1-to-v2.js'
import { LegacySourceCutoverGate } from '../src/application/migration/legacy-source-cutover-gate.js'
import { materializeLegacyItemV2 } from '../src/adapters/dsh-storage/legacy-v1-adapter.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'
import { makeLearnedWorkItem } from './support/review-fixture.js'
import { makeWorkItem } from './support/work-item-fixture.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'
import { deriveSessionLifecycleKeyFromFacts } from '../src/domain/observe/identity.js'
import { ProposalReviewStore } from '../src/adapters/dsh-storage/proposal-review-store.js'
import { PublicationSagaStore } from '../src/adapters/dsh-storage/publication-saga-store.js'
import { materializeLineage } from '../src/domain/publication/index.js'
import { proposalRefOf } from '../src/domain/review/index.js'
import { makeCreateProposalSnapshot } from './support/review-fixture.js'

const NOW = '2026-08-22T00:00:00.000Z'

function migrationOptions(overrides: Omit<Run2skillV2MigrationOptions, 'cutoverGate'> = {}): Run2skillV2MigrationOptions {
  return { cutoverGate: new LegacySourceCutoverGate(), now: () => NOW, ...overrides }
}

describe('run2skill_v1 -> run2skill_v2 migration', () => {
  it('copies deterministic legacy envelopes and commits activation without writing v1', async () => {
    const v1 = createMemoryRun2skillDomain()
    const captured = makeWorkItem()
    const learned = makeLearnedWorkItem({
      signalKey: {
        ...captured.signalKey,
        turn: 3,
        turnEndSeq: 20,
        turnInstanceDigest: 'e'.repeat(64),
      },
    })
    v1.workItems.set(captured.workItemId, captured)
    v1.workItems.set(learned.workItemId, learned)
    const legacyLineage = createMinimalV2Fixtures().proposalLineage.legacySnapshot
    v1.lineages.set(legacyLineage.lineageId, legacyLineage)
    const sessionFacts = {
      rootSessionId: 'legacy-session',
      sessionCreatedAt: 100,
      sessionCwdDigest: '7'.repeat(64),
    }
    const sessionLifecycleKey = deriveSessionLifecycleKeyFromFacts(sessionFacts)
    await v1.global.set({
      ...v1.global.get(),
      sessions: {
        [sessionLifecycleKey]: {
          ...sessionFacts,
          triggerPolicyVersion: 'cheap-trigger-v1',
          activationFenceSeq: 0,
          durableNextSeq: 9,
          observedTailSeq: 8,
          headerRevision: 'rev-8',
          headerDigest: '6'.repeat(64),
        },
      },
      completedPurgeFences: {
        schemaVersion: 1,
        user: {
          schemaVersion: 1,
          scope: 'USER',
          purgeId: `purge_${'a'.repeat(64)}`,
          completedAt: NOW,
          hideBefore: NOW,
        },
        projects: {},
      },
    })
    v1.writeLog.length = 0
    const v1Before = structuredClone([...v1.workItems.entries()])
    const v2 = createMemoryRun2skillV2Domain()

    const result = await migrateRun2skillV1ToV2(v1, v2, migrationOptions())

    expect(result.status).toBe('COMMITTED')
    expect(v2.global.get().migration.phase).toBe('COMMITTED')
    expect(v2.legacyItems.size).toBe(2)
    expect(v2.proposalLineages.get(legacyLineage.lineageId)).toEqual(createMinimalV2Fixtures().proposalLineage)
    expect(v2.global.get().legacyCompletedPurgeFences).toEqual(v1.global.get().completedPurgeFences)
    expect(v2.global.get().sessions[sessionLifecycleKey]).toMatchObject({
      observedThroughTurnEndSeq: 8,
      detectedThroughTurnEndSeq: 8,
      openExperienceCarry: [],
    })
    expect(v2.global.get().activation).toMatchObject({
      legacyPendingCandidateCount: 1,
      observerStartWatermarks: {
        [sessionLifecycleKey]: { nextSeq: 9, observedTailSeq: 8, headerRevision: 'rev-8' },
      },
    })
    expect([...v1.workItems.entries()]).toEqual(v1Before)
    expect(v1.writeLog).toEqual([])
  })

  it('resumes an interrupted deterministic copy without duplicating records', async () => {
    const v1 = createMemoryRun2skillDomain()
    const item = makeWorkItem()
    v1.workItems.set(item.workItemId, item)
    const v2 = createMemoryRun2skillV2Domain()

    await expect(migrateRun2skillV1ToV2(v1, v2, migrationOptions({
      afterPhase: phase => {
        if (phase === 'COPYING') throw new Error('synthetic process stop')
      },
    }))).rejects.toThrow('synthetic process stop')
    expect(v2.global.get().migration.phase).toBe('COPYING')
    const partial = materializeLegacyItemV2(item, NOW)
    await v2.table('legacy_items').put(partial.legacyItemId, partial)

    await expect(migrateRun2skillV1ToV2(v1, v2, migrationOptions()))
      .resolves.toMatchObject({ status: 'COMMITTED' })
    expect(v2.legacyItems.size).toBe(1)
    await expect(migrateRun2skillV1ToV2(v1, v2, migrationOptions()))
      .resolves.toMatchObject({ status: 'ALREADY_COMMITTED' })
  })

  it('detects a changed v1 snapshot before commit instead of activating a partial copy', async () => {
    const v1 = createMemoryRun2skillDomain()
    const first = makeWorkItem()
    v1.workItems.set(first.workItemId, first)
    const v2 = createMemoryRun2skillV2Domain()
    let changed = false

    await expect(migrateRun2skillV1ToV2(v1, v2, migrationOptions({
      afterPhase: (phase) => {
        if (phase !== 'VALIDATING' || changed) return
        changed = true
        const second = makeWorkItem({
          signalKey: {
            ...first.signalKey,
            turn: 9,
            turnEndSeq: 90,
            turnInstanceDigest: '8'.repeat(64),
          },
        })
        v1.workItems.set(second.workItemId, second)
      },
    }))).rejects.toThrow(/SOURCE_CHANGED_DURING_MIGRATION/)
    expect(v2.global.get().migration).toMatchObject({
      phase: 'FAILED',
      failureCode: 'SOURCE_CHANGED_DURING_MIGRATION',
    })
    expect(v2.global.get().activation).toBeUndefined()
  })

  it('marks a conflicting partial v2 identity as FAILED instead of overwriting it', async () => {
    const v1 = createMemoryRun2skillDomain()
    const item = makeWorkItem()
    v1.workItems.set(item.workItemId, item)
    const v2 = createMemoryRun2skillV2Domain()
    await expect(migrateRun2skillV1ToV2(v1, v2, migrationOptions({
      afterPhase: () => { throw new Error('synthetic process stop') },
    }))).rejects.toThrow('synthetic process stop')
    const partial = materializeLegacyItemV2(item, NOW)
    v2.legacyItems.set(partial.legacyItemId, { ...partial, sourceDigest: 'f'.repeat(64) })

    await expect(migrateRun2skillV1ToV2(v1, v2, migrationOptions()))
      .rejects.toThrow(/V2_IDENTITY_CONFLICT/)
    expect(v2.global.get().migration).toMatchObject({
      phase: 'FAILED',
      failureCode: 'V2_IDENTITY_CONFLICT',
    })
  })

  it('refuses migration while legacy Purge is active', async () => {
    const v1 = createMemoryRun2skillDomain()
    await v1.global.set({
      ...v1.global.get(),
      purgeJournal: {
        schemaVersion: 1,
        purgeId: `purge_${'a'.repeat(64)}`,
        scopeBinding: { scope: 'USER' },
        hideBefore: NOW,
        candidateDigest: 'b'.repeat(64),
        phase: 'HIDING',
        deletedWorkItems: 0,
        deletedLineages: 0,
        startedAt: NOW,
      },
    })
    const v2 = createMemoryRun2skillV2Domain()

    await expect(migrateRun2skillV1ToV2(v1, v2, migrationOptions()))
      .rejects.toThrow(/LEGACY_PURGE_ACTIVE/)
    expect(v2.global.get().migration.phase).toBe('NOT_STARTED')
  })

  it('refuses migration until v1 recovery and checkpoints are quiescent', async () => {
    const v1 = createMemoryRun2skillDomain()
    await v1.global.set({
      ...v1.global.get(),
      checkpoint: { dirty: true, pendingSessionCount: 1 },
    })
    const v2 = createMemoryRun2skillV2Domain()

    await expect(migrateRun2skillV1ToV2(v1, v2, migrationOptions()))
      .rejects.toThrow(/LEGACY_SOURCE_NOT_QUIESCENT/)
    expect(v2.global.get().migration.phase).toBe('NOT_STARTED')
  })

  it('rejects legacy mutations once cutover starts so no write can race the final commit', async () => {
    const v1 = createMemoryRun2skillDomain()
    const item = makeWorkItem()
    v1.workItems.set(item.workItemId, item)
    const v2 = createMemoryRun2skillV2Domain()
    const cutoverGate = new LegacySourceCutoverGate()
    let rejected = false

    await migrateRun2skillV1ToV2(v1, v2, {
      cutoverGate,
      now: () => NOW,
      afterPhase: async (phase) => {
        if (phase !== 'VALIDATING') return
        await expect(cutoverGate.runLegacyMutation(() => {
          v1.workItems.set('late', item)
        })).rejects.toThrow(/LEGACY_SOURCE_SEALED/)
        rejected = true
      },
    })

    expect(rejected).toBe(true)
    expect(v1.workItems.has('late')).toBe(false)
    expect(v2.global.get().migration.phase).toBe('COMMITTED')
  })

  it('fails closed when a PUBLISHED v1 item has no matching committed Lineage', async () => {
    const v1 = createMemoryRun2skillDomain()
    const learned = makeLearnedWorkItem()
    v1.workItems.set(learned.workItemId, learned)
    const reviews = new ProposalReviewStore(v1, () => NOW)
    const staged = (await reviews.stage(learned.workItemId, learned.revision, makeCreateProposalSnapshot(learned))).item
    const approved = (await reviews.approve(
      staged.workItemId,
      staged.revision,
      proposalRefOf(staged.review!.proposal),
    )).item
    const proposal = approved.review!.proposal
    const publication = approved.publication!
    if (proposal.actionBinding.kind !== 'CREATE') throw new Error('expected CREATE fixture')
    const lineage = materializeLineage({
      scope: proposal.persistenceScope,
      provider: proposal.actionBinding.rootBinding.expectedProvider,
      source: 'project-dsh',
      skillName: proposal.name,
      canonicalTargetPath: proposal.actionBinding.targetBinding.skillFilePath,
      targetIdentityDigest: publication.targetIdentityDigest,
      revisions: [{
        revision: 1,
        origin: 'RUN2SKILL',
        proposalId: proposal.proposalId,
        exactSkillBytes: proposal.exactSkillBytes,
        skillBytesDigest: proposal.skillBytesDigest,
        committedAt: NOW,
      }],
    })
    const saga = new PublicationSagaStore(v1, () => NOW)
    await saga.appendEvent(approved.workItemId, 'FACTS_REVALIDATED', { expectedHash: proposal.skillBytesDigest })
    await saga.appendEvent(approved.workItemId, 'READBACK_CONFIRMED', {
      expectedHash: proposal.skillBytesDigest,
      observedHash: proposal.skillBytesDigest,
    })
    await saga.stageLineage(approved.workItemId, lineage)
    await saga.commitLineage(approved.workItemId)
    await saga.complete(approved.workItemId)
    v1.lineages.delete(lineage.lineageId)
    const v2 = createMemoryRun2skillV2Domain()

    await expect(migrateRun2skillV1ToV2(v1, v2, migrationOptions()))
      .rejects.toThrow(/LEGACY_SOURCE_INVALID/)
    expect(v2.global.get().migration.phase).toBe('NOT_STARTED')
  })

  it('keeps v1 sealed when a post-commit notification fails', async () => {
    const v1 = createMemoryRun2skillDomain()
    const v2 = createMemoryRun2skillV2Domain()
    const cutoverGate = new LegacySourceCutoverGate()

    await expect(migrateRun2skillV1ToV2(v1, v2, {
      cutoverGate,
      now: () => NOW,
      afterPhase: phase => {
        if (phase === 'COMMITTED') throw new Error('notification failed')
      },
    })).rejects.toThrow('notification failed')

    expect(v2.global.get().migration.phase).toBe('COMMITTED')
    expect(cutoverGate.state).toBe('SEALED')
    await expect(cutoverGate.runLegacyMutation(() => {})).rejects.toThrow(/LEGACY_SOURCE_SEALED/)
  })
})
