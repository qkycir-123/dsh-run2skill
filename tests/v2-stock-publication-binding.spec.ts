import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DshV2StockPublicationBindingResolver } from '../src/adapters/dsh-publication/v2-stock-publication-binding.js'
import type { StockSkillRuntimeConfiguration } from '../src/adapters/dsh-skills/stock-root-contract.js'
import type { V2ProposalPublicationInput } from '../src/application/publication/index.js'
import { deriveV2ProposalRef } from '../src/application/review/index.js'
import { deriveProjectScopeIdentityDigest } from '../src/domain/purge/index.js'
import {
  ProposalLineageV2Schema,
  SessionBatchV2Schema,
  deriveNativeProposalLineageIdV2,
} from '../src/domain/v2/index.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })))
})

function input(canonicalWorkspacePath: string): V2ProposalPublicationInput {
  const minimal = createMinimalV2Fixtures()
  const lineage = ProposalLineageV2Schema.parse(minimal.nativeActiveProposalLineage)
  if (lineage.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
  const rebound = ProposalLineageV2Schema.parse({
    ...lineage,
    proposalRevisions: lineage.proposalRevisions.map(proposal => ({
      ...proposal,
      projectScopeBinding: {
        workspaceId: 'workspace-1',
        scopeIdentityDigest: deriveProjectScopeIdentityDigest(canonicalWorkspacePath),
      },
    })),
  })
  if (rebound.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
  return {
    lineage: rebound,
    proposal: rebound.proposalRevisions[0]!,
    proposalRef: deriveV2ProposalRef(rebound),
    intent: minimal.proposalReadyIntent,
    batch: SessionBatchV2Schema.parse(minimal.sessionBatch),
  }
}

function userInput(): V2ProposalPublicationInput {
  const minimal = createMinimalV2Fixtures()
  const raw = minimal.nativeActiveProposalLineage
  const proposal = raw.proposalRevisions[0]!
  const { projectScopeBinding: _projectScopeBinding, ...userProposal } = proposal
  const lineage = ProposalLineageV2Schema.parse({
    ...raw,
    persistenceScope: 'USER',
    lineageId: deriveNativeProposalLineageIdV2('USER', raw.behaviorSignature),
    proposalRevisions: [userProposal],
  })
  if (lineage.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
  return {
    lineage,
    proposal: lineage.proposalRevisions[0]!,
    proposalRef: deriveV2ProposalRef(lineage),
    intent: minimal.proposalReadyIntent,
    batch: SessionBatchV2Schema.parse(minimal.sessionBatch),
  }
}

describe('v2 stock publication binding resolver', () => {
  it('resolves the fixed PROJECT root before and after its approved segments exist', async () => {
    const project = await mkdtemp(join(tmpdir(), 'run2skill-v2-binding-'))
    roots.push(project)
    const configuration = {
      profile: 'web',
      presetId: 'standard',
      providerName: 'filesystem',
      includeDefaultRoots: true,
      customSkillDirs: [],
    }
    const view = {}
    const resolver = new DshV2StockPublicationBindingResolver({
      resolveSession: () => ({
        view,
        configuration,
        workspaceBinding: { workspaceId: 'workspace-1', canonicalPath: project },
      }),
    })

    await expect(resolver.resolve(input(project))).resolves.toMatchObject({
      status: 'READY',
      view,
      rootBinding: {
        state: 'ABSENT',
        scope: 'PROJECT',
        expectedProvider: 'filesystem',
        expectedSource: 'project-dsh',
        declaredRootPath: join(project, '.dsh', 'skills'),
        missingSegments: ['.dsh', 'skills'],
      },
    })

    await mkdir(join(project, '.dsh', 'skills'), { recursive: true })
    await expect(resolver.resolve(input(project))).resolves.toMatchObject({
      status: 'READY',
      rootBinding: { state: 'EXISTING', canonicalRootPath: join(project, '.dsh', 'skills') },
    })
  })

  it('matches DSH project-root discovery when the Session cwd is below a git root', async () => {
    const project = await mkdtemp(join(tmpdir(), 'run2skill-v2-binding-'))
    roots.push(project)
    const cwd = join(project, 'packages', 'web')
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(cwd, { recursive: true })
    const resolver = new DshV2StockPublicationBindingResolver({
      resolveSession: () => ({
        view: {},
        configuration: {
          profile: 'web',
          presetId: 'standard',
          providerName: 'filesystem',
          includeDefaultRoots: true,
          customSkillDirs: [],
        },
        workspaceBinding: { workspaceId: 'workspace-1', canonicalPath: cwd },
      }),
    })

    await expect(resolver.resolve(input(cwd))).resolves.toMatchObject({
      status: 'READY',
      rootBinding: {
        declaredRootPath: join(project, '.dsh', 'skills'),
        missingSegments: ['.dsh', 'skills'],
      },
    })
  })

  it('rejects non-stock roots', async () => {
    const project = await mkdtemp(join(tmpdir(), 'run2skill-v2-binding-'))
    roots.push(project)
    const base = {
      profile: 'web',
      presetId: 'standard',
      providerName: 'filesystem',
      includeDefaultRoots: true,
      customSkillDirs: [],
    }
    let configuration: StockSkillRuntimeConfiguration = { ...base, customSkillDirs: [join(project, 'custom')] }
    const resolver = new DshV2StockPublicationBindingResolver({
      resolveSession: () => ({
        view: {},
        configuration,
        workspaceBinding: { workspaceId: 'workspace-1', canonicalPath: project },
      }),
    })

    await expect(resolver.resolve(input(project))).resolves.toEqual({ status: 'STALE' })
  })

  it('binds the exact Session context filesystem and a root-scoped write policy', async () => {
    const project = join(process.cwd(), 'virtual-context-project').replaceAll('\\', '/')
    const declaredRoot = join(project, '.dsh', 'skills')
    const root = declaredRoot.replaceAll('\\', '/')
    const entries = new Map([[project, { version: 'project-v1', type: 'directory' as const }]])
    const targetFor = (path: string) => ({ targetKey: `ctxfs://${path}`, displayPath: path })
    const filesystem = {
      sandboxMode: 'workspace-write' as const,
      resolve: async (path: string) => targetFor(path.replaceAll('\\', '/')),
      processPath: (target: { displayPath: string }) => target.displayPath,
      contains: (parent: { displayPath: string }, child: { displayPath: string }) => (
        child.displayPath === parent.displayPath || child.displayPath.startsWith(`${parent.displayPath}/`)
      ),
      stat: async (target: { displayPath: string }) => entries.get(target.displayPath),
      lstat: async (path: string) => entries.get(path.replaceAll('\\', '/')),
      readBytes: async () => new Uint8Array(),
      listDir: async () => [],
      writeText: async () => ({ operation: 'create' as const, version: 'v1', before: null, after: '' }),
    }
    const view = {}
    const resolver = new DshV2StockPublicationBindingResolver({
      resolveSession: () => ({
        view,
        filesystem,
        configuration: {
          profile: 'web', presetId: 'standard', providerName: 'filesystem',
          includeDefaultRoots: true, customSkillDirs: [], usesContextFileSystem: true,
        },
        workspaceBinding: { workspaceId: 'workspace-1', canonicalPath: project },
      }),
    })

    await expect(resolver.resolve(input(project))).resolves.toMatchObject({
      status: 'READY',
      view,
      filesystem,
      rootTarget: targetFor(root),
      publicationPolicy: {
        mode: 'workspace-write',
        workspaceRoot: root,
        sessionId: expect.any(String),
      },
      rootBinding: {
        state: 'ABSENT',
        scope: 'PROJECT',
        declaredRootPath: declaredRoot,
        canonicalExistingAncestorPath: project,
        missingSegments: ['.dsh', 'skills'],
      },
    })
  })

  it('observes the USER stock root through the exact Session context filesystem', async () => {
    const home = join(process.cwd(), 'virtual-context-home').replaceAll('\\', '/')
    const declaredRoot = join(home, 'skills')
    const root = declaredRoot.replaceAll('\\', '/')
    const entries = new Map([[home, { version: 'home-v1', type: 'directory' as const }]])
    const targetFor = (path: string) => ({ targetKey: `ctxfs://${path}`, displayPath: path })
    const filesystem = {
      sandboxMode: 'workspace-write' as const,
      resolve: async (path: string) => targetFor(path.replaceAll('\\', '/')),
      processPath: (target: { displayPath: string }) => target.displayPath,
      contains: (parent: { displayPath: string }, child: { displayPath: string }) => (
        child.displayPath === parent.displayPath || child.displayPath.startsWith(`${parent.displayPath}/`)
      ),
      stat: async (target: { displayPath: string }) => entries.get(target.displayPath),
      lstat: async (path: string) => entries.get(path.replaceAll('\\', '/')),
      readBytes: async () => new Uint8Array(),
      listDir: async () => [],
      writeText: async () => ({ operation: 'create' as const, version: 'v1', before: null, after: '' }),
    }
    const resolver = new DshV2StockPublicationBindingResolver({
      resolveSession: () => ({
        view: {},
        filesystem,
        configuration: {
          profile: 'web', presetId: 'standard', providerName: 'filesystem',
          includeDefaultRoots: true, customSkillDirs: [], usesContextFileSystem: true,
          configuredDshHome: home,
        },
      }),
    })

    await expect(resolver.resolve(userInput())).resolves.toMatchObject({
      status: 'READY',
      filesystem,
      rootTarget: targetFor(root),
      publicationPolicy: { mode: 'workspace-write', workspaceRoot: root },
      rootBinding: {
        state: 'ABSENT',
        scope: 'USER',
        declaredRootPath: declaredRoot,
        canonicalExistingAncestorPath: home,
        missingSegments: ['skills'],
      },
    })
  })

  it('fails closed when context filesystem observation throws', async () => {
    const project = join(process.cwd(), 'throwing-context-project')
    const filesystem = {
      resolve: async () => { throw new Error('ctx.fs unavailable') },
      processPath: () => project,
      contains: () => true,
      stat: async () => undefined,
      lstat: async () => undefined,
      readBytes: async () => new Uint8Array(),
      listDir: async () => [],
      writeText: async () => ({ operation: 'create' as const, version: 'v1', before: null, after: '' }),
    }
    const resolver = new DshV2StockPublicationBindingResolver({
      resolveSession: () => ({
        view: {},
        filesystem,
        configuration: {
          profile: 'web', presetId: 'standard', providerName: 'filesystem',
          includeDefaultRoots: true, customSkillDirs: [], usesContextFileSystem: true,
        },
        workspaceBinding: { workspaceId: 'workspace-1', canonicalPath: project },
      }),
    })

    await expect(resolver.resolve(input(project))).resolves.toEqual({ status: 'UNAVAILABLE' })
  })

  it('returns unavailable when the exact Session lifecycle is gone', async () => {
    const resolver = new DshV2StockPublicationBindingResolver({ resolveSession: () => undefined })
    await expect(resolver.resolve(input(process.cwd()))).resolves.toEqual({ status: 'UNAVAILABLE' })
  })

  it('rejects a different current Workspace than the immutable Proposal scope binding', async () => {
    const approvedProject = await mkdtemp(join(tmpdir(), 'run2skill-v2-binding-approved-'))
    const currentProject = await mkdtemp(join(tmpdir(), 'run2skill-v2-binding-current-'))
    roots.push(approvedProject, currentProject)
    const resolver = new DshV2StockPublicationBindingResolver({
      resolveSession: () => ({
        view: {},
        configuration: {
          profile: 'web', presetId: 'standard', providerName: 'filesystem',
          includeDefaultRoots: true, customSkillDirs: [],
        },
        workspaceBinding: { workspaceId: 'workspace-1', canonicalPath: currentProject },
      }),
    })

    await expect(resolver.resolve(input(approvedProject))).resolves.toEqual({ status: 'STALE' })
  })
})
