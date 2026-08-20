import { describe, expect, it } from 'vitest'
import {
  LineageV1Schema,
  PublicationStateV1Schema,
  appendPublicationJournalEvent,
  createPublicationState,
  deriveLineageId,
  derivePublicationTargetIdentityDigest,
  materializeLineage,
} from '../src/domain/publication/index.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'

const now = '2026-08-20T00:00:01.000Z'
const target = {
  scope: 'PROJECT' as const,
  provider: 'filesystem',
  source: 'project-dsh' as const,
  skillName: 'generated-file-hygiene',
  canonicalTargetPath: 'D:\\workspace\\.dsh\\skills\\generated-file-hygiene\\SKILL.md',
  targetIdentityDigest: derivePublicationTargetIdentityDigest({
    scope: 'PROJECT',
    provider: 'filesystem',
    source: 'project-dsh',
    skillName: 'generated-file-hygiene',
    canonicalTargetPath: 'D:\\workspace\\.dsh\\skills\\generated-file-hygiene\\SKILL.md',
  }),
}

describe('publication durable schemas', () => {
  it('chains bounded publication journal facts and rejects tampering', () => {
    const started = createPublicationState({
      workItemId: `wi_${'1'.repeat(64)}`,
      proposalId: `prop_${'2'.repeat(64)}`,
      targetIdentityDigest: target.targetIdentityDigest,
      occurredAt: now,
    })
    const revalidated = appendPublicationJournalEvent(started, {
      stage: 'FACTS_REVALIDATED',
      occurredAt: '2026-08-20T00:00:02.000Z',
      expectedHash: 'b'.repeat(64),
    })

    expect(revalidated.journal.map(entry => entry.stage)).toEqual([
      'APPROVAL_COMMITTED',
      'FACTS_REVALIDATED',
    ])
    expect(revalidated.journal[1]?.previousDigest).toBe(revalidated.journal[0]?.digest)
    expect(() => PublicationStateV1Schema.parse({
      ...revalidated,
      journal: revalidated.journal.map((entry, index) => (
        index === 1 ? { ...entry, expectedHash: 'c'.repeat(64) } : entry
      )),
    })).toThrow()
  })

  it('stores full consecutive lineage revisions and derives a stable target id', () => {
    const lineage = materializeLineage({
      ...target,
      revisions: [
        {
          revision: 1,
          origin: 'ADOPTED_BASE',
          exactSkillBytes: '# Base\n',
          skillBytesDigest: sha256Utf8('# Base\n'),
          committedAt: now,
        },
        {
          revision: 2,
          origin: 'RUN2SKILL',
          proposalId: `prop_${'2'.repeat(64)}`,
          exactSkillBytes: '# Next\n',
          skillBytesDigest: sha256Utf8('# Next\n'),
          committedAt: '2026-08-20T00:00:03.000Z',
        },
      ],
    })

    expect(lineage.lineageId).toBe(deriveLineageId(target.scope, target.targetIdentityDigest))
    expect(lineage.currentRevision).toBe(2)
    expect(LineageV1Schema.parse(JSON.parse(JSON.stringify(lineage)))).toEqual(lineage)
    expect(() => LineageV1Schema.parse({
      ...lineage,
      revisions: lineage.revisions.map((revision, index) => (
        index === 1 ? { ...revision, revision: 3 } : revision
      )),
      currentRevision: 3,
    })).toThrow()
  })
})
