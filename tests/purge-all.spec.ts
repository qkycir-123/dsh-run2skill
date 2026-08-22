import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PurgeService, type PurgeScopeResolver } from '../src/application/purge/index.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import {
  derivePublicationTargetIdentityDigest,
  materializeLineage,
} from '../src/domain/publication/index.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'
import { makeWorkItem } from './support/work-item-fixture.js'
import { SessionBatchV2Schema, deriveTurnObservationIdV2 } from '../src/domain/v2/index.js'

const NOW = Date.parse('2026-08-22T12:00:00.000Z')

function legacyLineage() {
  const canonicalTargetPath = join(process.cwd(), '.dsh', 'skills', 'published-fixture', 'SKILL.md')
  const exactSkillBytes = '---\nname: published-fixture\ndescription: Published fixture.\n---\n'
  return materializeLineage({
    scope: 'PROJECT',
    provider: 'filesystem',
    source: 'project-dsh',
    skillName: 'published-fixture',
    canonicalTargetPath,
    targetIdentityDigest: derivePublicationTargetIdentityDigest({
      scope: 'PROJECT', provider: 'filesystem', source: 'project-dsh', skillName: 'published-fixture', canonicalTargetPath,
    }),
    revisions: [{
      revision: 1,
      origin: 'RUN2SKILL',
      proposalId: `prop_${'a'.repeat(64)}`,
      exactSkillBytes,
      skillBytesDigest: sha256Utf8(exactSkillBytes),
      committedAt: '2026-08-21T00:00:00.000Z',
    }],
  })
}

describe('all-cache Purge', () => {
  it('clears every v1 and v2 derived table without resolving an internal scope', async () => {
    const v1 = createMemoryRun2skillDomain()
    const workItem = makeWorkItem({
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
    })
    const lineage = legacyLineage()
    v1.workItems.set(workItem.workItemId, workItem)
    v1.lineages.set(lineage.lineageId, lineage)

    const v2 = createMemoryRun2skillV2Domain()
    const fixtures = createMinimalV2Fixtures()
    v2.turnObservations.set(fixtures.turnObservation.observationId, fixtures.turnObservation)
    const futureObservationFacts = {
      sessionLifecycleKey: fixtures.turnObservation.sessionLifecycleKey,
      turnEndSeq: fixtures.turnObservation.turnEndSeq + 1,
      turnInstanceDigest: 'd'.repeat(64),
    }
    const futureObservation = {
      ...fixtures.turnObservation,
      ...futureObservationFacts,
      observationId: deriveTurnObservationIdV2(futureObservationFacts),
      observedAt: '2026-08-22T13:00:00.000Z',
    }
    v2.turnObservations.set(futureObservation.observationId, futureObservation)
    v2.sessionBatches.set(fixtures.sessionBatch.batchId, SessionBatchV2Schema.parse(fixtures.sessionBatch))
    v2.experienceIntents.set(fixtures.experienceIntent.intentId, fixtures.experienceIntent)
    v2.proposalLineages.set(fixtures.proposalLineage.lineageId, fixtures.proposalLineage)
    v2.legacyItems.set(fixtures.legacyItem.legacyItemId, fixtures.legacyItem)

    const resolver: PurgeScopeResolver = { resolve: vi.fn(async () => { throw new Error('must not resolve') }) }
    const deleteDiagnostics = vi.fn(async () => undefined)
    const service = new PurgeService(v1, resolver, {
      now: () => NOW,
      v2Domain: v2,
      beforeDeleteAll: deleteDiagnostics,
    })

    const preview = await service.preview('ALL')
    expect(preview.scopeBinding).toEqual({ scope: 'ALL' })
    expect(preview.derivedRecordCount).toBe(5)
    const receipt = await service.confirm(preview.previewId, preview.digest, { scope: 'ALL' })

    expect(receipt).toMatchObject({ state: 'COMPLETED', deletedWorkItems: 1, deletedLineages: 1 })
    expect(resolver.resolve).not.toHaveBeenCalled()
    expect(deleteDiagnostics).toHaveBeenCalledTimes(1)
    expect(v1.workItems.size).toBe(0)
    expect(v1.lineages.size).toBe(0)
    expect([...v2.turnObservations.keys()]).toEqual([futureObservation.observationId])
    expect(v2.sessionBatches.size).toBe(0)
    expect(v2.experienceIntents.size).toBe(0)
    expect(v2.proposalLineages.size).toBe(0)
    expect(v2.legacyItems.size).toBe(0)
    expect(v1.global.get().completedPurgeFences?.all?.scope).toBe('ALL')
  })
})
