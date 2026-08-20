import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyLineageForPurge,
  classifyWorkItemForPurge,
  type ProjectPurgeScopeBindingV1,
} from '../src/domain/purge/index.js'
import {
  deriveExperienceId,
  deriveLearningProposalId,
} from '../src/domain/learn/index.js'
import {
  derivePublicationTargetIdentityDigest,
  materializeLineage,
} from '../src/domain/publication/index.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import { makeLearnedWorkItem } from './support/review-fixture.js'
import { makeWorkItem } from './support/work-item-fixture.js'

const HIDE_BEFORE = '2026-08-20T12:00:00.000Z'
const PROJECT = join(process.cwd(), '.probe-work', 'purge-project')
const ROOT = join(PROJECT, '.dsh', 'skills')

const projectBinding: ProjectPurgeScopeBindingV1 = {
  scope: 'PROJECT',
  workspaceId: 'workspace-purge',
  canonicalWorkspacePath: PROJECT,
  workspaceObservedAt: HIDE_BEFORE,
  canonicalRootPath: ROOT,
  rootContractVersion: 'stock-dsh-web-default-roots-v1',
  resolverVersion: 'stock-root-resolver-v2',
  resolutionContractDigest: 'a'.repeat(64),
}

function projectItem(createdAt = '2026-08-20T00:00:00.000Z') {
  return makeLearnedWorkItem({
    createdAt,
    updatedAt: createdAt,
    workspaceBinding: {
      status: 'BOUND',
      workspaceId: projectBinding.workspaceId,
      canonicalPath: PROJECT,
      observedAt: createdAt,
    },
  })
}

function userItem() {
  const item = projectItem()
  const evidence = item.evidenceRefs[0]!
  const experienceFacts = {
    type: 'CONSTRAINT' as const,
    lesson: 'Always read collaboration rules first.',
    persistenceScope: 'USER' as const,
    evidenceStrength: 'HIGH' as const,
    supportingEvidence: [{ messageSeq: evidence.messageSeq, excerptDigest: evidence.excerptDigest }],
  }
  const experience = { experienceId: deriveExperienceId(item.workItemId, experienceFacts), ...experienceFacts }
  const proposalFacts = {
    ...item.learning!.proposal!,
    persistenceScope: 'USER' as const,
    supportingExperienceIds: [experience.experienceId],
  }
  const { learningProposalId: _oldId, ...proposalWithoutId } = proposalFacts
  return {
    ...item,
    learning: {
      ...item.learning!,
      experiences: [experience],
      proposal: {
        ...proposalWithoutId,
        learningProposalId: deriveLearningProposalId(item.workItemId, proposalWithoutId),
      },
    },
  }
}

function lineage(scope: 'PROJECT' | 'USER', root = ROOT, committedAt = '2026-08-20T00:00:00.000Z') {
  const skillName = scope === 'PROJECT' ? 'project-skill' : 'user-skill'
  const source = scope === 'PROJECT' ? 'project-dsh' as const : 'user-dsh' as const
  const canonicalTargetPath = join(root, skillName, 'SKILL.md')
  return materializeLineage({
    scope,
    provider: 'filesystem',
    source,
    skillName,
    canonicalTargetPath,
    targetIdentityDigest: derivePublicationTargetIdentityDigest({
      scope, provider: 'filesystem', source, skillName, canonicalTargetPath,
    }),
    revisions: [{
      revision: 1,
      origin: 'RUN2SKILL',
      proposalId: `prop_${'1'.repeat(64)}`,
      exactSkillBytes: '---\nname: fixture\ndescription: fixture\n---\n',
      skillBytesDigest: sha256Utf8('---\nname: fixture\ndescription: fixture\n---\n'),
      committedAt,
    }],
  })
}

describe('Purge scope truth table', () => {
  it('deletes only proven PROJECT data at or before hideBefore', () => {
    expect(classifyWorkItemForPurge(projectItem(), projectBinding, HIDE_BEFORE)).toBe('DELETE')
    expect(classifyWorkItemForPurge(projectItem('2026-08-20T12:00:00.001Z'), projectBinding, HIDE_BEFORE)).toBe('KEEP_NEW')
    expect(classifyWorkItemForPurge(userItem(), projectBinding, HIDE_BEFORE)).toBe('KEEP_SCOPE')

    const provisional = makeWorkItem({
      workspaceBinding: {
        status: 'BOUND', workspaceId: projectBinding.workspaceId, canonicalPath: PROJECT,
        observedAt: '2026-08-20T00:00:00.000Z',
      },
    })
    expect(classifyWorkItemForPurge(provisional, projectBinding, HIDE_BEFORE)).toBe('DELETE')
    expect(classifyWorkItemForPurge(makeWorkItem(), projectBinding, HIDE_BEFORE)).toBe('KEEP_UNPROVEN')
  })

  it('deletes USER learned data but keeps provisional and PROJECT data', () => {
    expect(classifyWorkItemForPurge(userItem(), { scope: 'USER' }, HIDE_BEFORE)).toBe('DELETE')
    expect(classifyWorkItemForPurge(projectItem(), { scope: 'USER' }, HIDE_BEFORE)).toBe('KEEP_SCOPE')
    expect(classifyWorkItemForPurge(makeWorkItem(), { scope: 'USER' }, HIDE_BEFORE)).toBe('KEEP_UNPROVEN')
  })

  it('requires exact stock-root lineage proof and respects first commit time', async () => {
    expect(classifyLineageForPurge(await lineage('PROJECT'), projectBinding, HIDE_BEFORE)).toBe('DELETE')
    expect(classifyLineageForPurge(
      await lineage('PROJECT', join(PROJECT, 'lookalike', '.dsh', 'skills')),
      projectBinding,
      HIDE_BEFORE,
    )).toBe('KEEP_UNPROVEN')
    expect(classifyLineageForPurge(
      await lineage('PROJECT', ROOT, '2026-08-20T12:00:00.001Z'),
      projectBinding,
      HIDE_BEFORE,
    )).toBe('KEEP_NEW')
    expect(classifyLineageForPurge(await lineage('USER'), { scope: 'USER' }, HIDE_BEFORE)).toBe('DELETE')
  })
})
