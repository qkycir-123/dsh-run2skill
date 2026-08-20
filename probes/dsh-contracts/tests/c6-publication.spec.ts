import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { C5PublicationFileSystemAdapter } from '../src/adapters/dsh-publication/publication-filesystem.js'
import { NodePublicationFactsAdapter } from '../src/adapters/dsh-publication/publication-facts.js'
import { DshSkillCatalogAdapter } from '../src/adapters/dsh-skills/skill-catalog.js'
import { DshPublicationReadbackAdapter } from '../src/adapters/dsh-skills/publication-readback.js'
import { ProposalReviewStore } from '../src/adapters/dsh-storage/proposal-review-store.js'
import { PublicationSagaStore } from '../src/adapters/dsh-storage/publication-saga-store.js'
import { renderCanonicalSkill } from '../src/application/curation/skill-renderer.js'
import { ApprovalPublicationSaga } from '../src/application/publication/approval-publication-saga.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import { materializeProposalSnapshot, proposalRefOf } from '../src/domain/review/index.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeCreateProposalSnapshot, makeLearnedWorkItem } from './support/review-fixture.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

function samePath(left: string, right: string): boolean {
  const a = normalize(resolve(left))
  const b = normalize(resolve(right))
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

describe('CP-ROOT-002 and CP-PUB-002 candidate publication contract', () => {
  it('publishes through the production saga and confirms exact DSH catalog readback', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-run2skill-c6-'))
    temporaryDirectories.push(base)
    const project = join(base, 'project')
    const dshHome = join(base, 'dsh-home')
    const agentsHome = join(base, 'agents-home')
    await mkdir(join(project, '.git'), { recursive: true })
    const canonicalProject = await realpath(project)

    const ctx = new Context()
    const registryFiber = await ctx.plugin(SkillRegistry)
    const filesystemFiber = await ctx.plugin(SkillFileSystem, {
      dshHome,
      agentsHome,
      watch: true,
      watchUsePolling: true,
      watchStabilityThresholdMs: 20,
      watchPollIntervalMs: 10,
    })
    try {
      const view = { cwd: canonicalProject }
      const skills = new DshSkillCatalogAdapter(ctx.skills)
      const before = await skills.snapshot(view)
      expect(before.complete).toBe(true)
      const projectRoot = join(canonicalProject, '.dsh', 'skills')
      expect(before.roots).toContainEqual({
        provider: 'filesystem',
        source: 'project-dsh',
        path: projectRoot,
      })

      const domain = createMemoryRun2skillDomain()
      const learned = makeLearnedWorkItem({
        workspaceBinding: {
          status: 'BOUND',
          workspaceId: 'candidate-workspace',
          canonicalPath: canonicalProject,
          observedAt: '2026-08-20T00:00:00.000Z',
        },
      })
      domain.workItems.set(learned.workItemId, learned)
      const initial = makeCreateProposalSnapshot(learned)
      const { proposalId: _proposalId, digest: _digest, ...facts } = initial
      const exactSkillBytes = renderCanonicalSkill({
        name: initial.name,
        description: initial.description,
        whenToUse: initial.whenToUse,
        content: learned.learning!.proposal!.content,
        invocation: initial.invocation,
      })
      const observed = await new NodePublicationFactsAdapter().observeRoot(projectRoot)
      if (observed.status !== 'ABSENT') throw new Error('expected the project Skill root to be absent')
      const bundlePath = join(projectRoot, initial.name)
      const skillFilePath = join(bundlePath, 'SKILL.md')
      const proposal = materializeProposalSnapshot(learned.workItemId, {
        ...facts,
        exactSkillBytes,
        skillBytesDigest: sha256Utf8(exactSkillBytes),
        workspaceBinding: {
          workspaceId: 'candidate-workspace',
          canonicalPath: canonicalProject,
          observedAt: initial.createdAt,
        },
        actionBinding: {
          kind: 'CREATE',
          rootBinding: {
            state: 'ABSENT',
            scope: 'PROJECT',
            provider: 'filesystem',
            source: 'project-dsh',
            resolverVersion: 'root-resolver-v1',
            observationDigest: 'a'.repeat(64),
            declaredRootPath: projectRoot,
            canonicalExistingAncestorPath: observed.canonicalExistingAncestorPath,
            ancestorIdentityDigest: observed.ancestorIdentityDigest,
            missingSegments: [...observed.missingSegments],
          },
          targetBinding: { skillName: initial.name, bundlePath, skillFilePath },
          expectedAbsence: {
            catalogObservationDigest: initial.catalogObservationDigest,
            observedAt: initial.createdAt,
            flatSkillFilePath: join(projectRoot, `${initial.name}.md`),
            bundlePathAbsent: true,
            skillFilePathAbsent: true,
            flatSkillFilePathAbsent: true,
          },
        },
      })
      const reviews = new ProposalReviewStore(domain)
      const staged = await reviews.stage(learned.workItemId, learned.revision, proposal)
      const approved = await reviews.approve(staged.item.workItemId, staged.item.revision, proposalRefOf(proposal))
      const store = new PublicationSagaStore(domain)
      const saga = new ApprovalPublicationSaga({
        store,
        revalidation: { async revalidate() { return { status: 'VALID' } } },
        fileSystem: new C5PublicationFileSystemAdapter({
          verifyParity: async (binding, canonicalRoot) => {
            const snapshot = await skills.snapshot(view)
            return snapshot.complete && snapshot.roots?.filter(root => (
              root.provider === binding.provider
              && root.source === binding.source
              && samePath(root.path, binding.declaredRootPath)
              && samePath(root.path, canonicalRoot)
            )).length === 1
          },
        }),
        readback: new DshPublicationReadbackAdapter(skills, () => view, { attempts: 5 }),
      })

      const completed = await saga.run(approved.item.workItemId)
      expect(completed).toMatchObject({
        processingState: 'TERMINAL',
        review: { reviewDecision: 'APPROVED', publicationOutcome: 'PUBLISHED' },
      })
      expect(domain.lineages.size).toBe(1)
      expect(await skills.get(proposal.name, view)).toMatchObject({
        provider: 'filesystem',
        source: 'project-dsh',
        path: skillFilePath,
        content: learned.learning!.proposal!.content,
      })
    } finally {
      await filesystemFiber.dispose()
      await registryFiber.dispose()
    }
  }, 20_000)
})
