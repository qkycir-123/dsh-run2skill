import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { C5PublicationFileSystemAdapter } from '../src/adapters/dsh-publication/publication-filesystem.js'
import { NodePublicationFactsAdapter } from '../src/adapters/dsh-publication/publication-facts.js'
import { DshSkillCatalogAdapter } from '../src/adapters/dsh-skills/skill-catalog.js'
import { DshPublicationReadbackAdapter } from '../src/adapters/dsh-skills/publication-readback.js'
import {
  StockDshRootContractResolver,
  deriveStockResolutionContractDigest,
  resolveStockSkillRuntimeConfiguration,
  type StockSkillRuntimeConfiguration,
} from '../src/adapters/dsh-skills/stock-root-contract.js'
import { stockPresetMounts } from '../src/adapters/dsh-skills/stock-preset-mount.js'
import {
  DshWorkspaceBindingResolver,
  type DshWorkspaceRegistryPort,
} from '../src/adapters/dsh-workspace/binding.js'
import { ProposalReviewStore } from '../src/adapters/dsh-storage/proposal-review-store.js'
import { PublicationSagaStore } from '../src/adapters/dsh-storage/publication-saga-store.js'
import {
  ProposalSnapshotBuilder,
  type PublicationRootContractPort,
} from '../src/application/curation/proposal-snapshot-builder.js'
import { ApprovedProposalRevalidator } from '../src/application/publication/approved-proposal-revalidator.js'
import { ApprovalPublicationSaga } from '../src/application/publication/approval-publication-saga.js'
import {
  deriveExperienceId,
  deriveLearningProposalId,
  recallExistingSkills,
} from '../src/domain/learn/index.js'
import { CaptureWorkItemV1Schema, type CaptureWorkItemV1 } from '../src/domain/observe/schemas.js'
import { proposalRefOf } from '../src/domain/review/index.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeLearnedWorkItem } from './support/review-fixture.js'

type SkillView = { readonly cwd: string; readonly scope: object }
type Scope = 'PROJECT' | 'USER'
type Decision = 'CREATE' | 'MERGE'

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

async function freshDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function writeExistingSkill(root: string): Promise<void> {
  const bundle = join(root, 'generated-file-hygiene')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'SKILL.md'), [
    '---',
    'name: generated-file-hygiene',
    'description: 把这个流程保存成 skill',
    '---',
    '',
    '# Existing file hygiene',
    '',
    'Keep only the old behavior.',
    '',
  ].join('\n'))
}

interface FileSystemCompositionOverrides {
  readonly providerName?: string | undefined
  readonly includeDefaultRoots?: boolean | undefined
  readonly dshHome?: string | undefined
  readonly customSkillDirs?: readonly string[] | undefined
}

interface StockCompositionWitness {
  readonly dshHome: string
  readonly presetId: string
  readonly fileSystem: FileSystemCompositionOverrides
}

function compositionWitness(
  dshHome: string,
  fileSystem: FileSystemCompositionOverrides = {},
  presetId = 'standard',
): StockCompositionWitness {
  return { dshHome, presetId, fileSystem }
}

function fileSystemComposition(
  agentsHome: string,
  overrides: FileSystemCompositionOverrides = {},
): string {
  const rows = [
    '- id: skill-filesystem',
    '  name: "@deepseek-ai/dsh-skill-filesystem"',
    '  config:',
    `    agentsHome: ${JSON.stringify(agentsHome)}`,
    '    watch: true',
    '    watchUsePolling: true',
    '    watchStabilityThresholdMs: 20',
    '    watchPollIntervalMs: 10',
  ]
  if (overrides.providerName !== undefined) {
    rows.push(`    providerName: ${JSON.stringify(overrides.providerName)}`)
  }
  if (overrides.includeDefaultRoots !== undefined) {
    rows.push(`    includeDefaultRoots: ${String(overrides.includeDefaultRoots)}`)
  }
  if (overrides.dshHome !== undefined) rows.push(`    dshHome: ${JSON.stringify(overrides.dshHome)}`)
  if (overrides.customSkillDirs !== undefined) {
    rows.push('    customSkillDirs:')
    for (const root of overrides.customSkillDirs) rows.push(`      - ${JSON.stringify(root)}`)
  }
  return `${rows.join('\n')}\n`
}

async function writePresetComposition(
  presetRoot: string,
  presetId: string,
  agentsHome: string,
  overrides: FileSystemCompositionOverrides,
): Promise<void> {
  const directory = join(presetRoot, presetId)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'agent.cordis.yml'), fileSystemComposition(agentsHome, overrides))
}

async function mountStockDsh(
  base: string,
  agentsHome: string,
  composition: StockCompositionWitness,
) {
  const presetRoot = join(base, 'presets')
  await writePresetComposition(presetRoot, composition.presetId, agentsHome, composition.fileSystem)
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(join(process.cwd(), 'apps', 'cli', 'package.json')).href
  const disposers: Array<() => Promise<void>> = []
  async function track<T extends { dispose(): void | Promise<void> }>(pending: Promise<T>): Promise<T> {
    const fiber = await pending
    disposers.push(async () => { await fiber.dispose() })
    return fiber
  }
  await track(ctx.plugin(Loader))
  const agent = {} as { ctx: Context }
  const agentScope = createScope(ctx, agent)
  agent.ctx = agentScope.ctx
  const dispose = async () => {
    await agentScope.dispose()
    for (const release of [...disposers].reverse()) await release()
  }
  try {
    await track(ctx.plugin(SkillRegistry))
    await track(ctx.plugin(AgentPresets, {
      default: composition.presetId,
      roots: [{ path: presetRoot, trust: 'system' }],
      includeUserRoot: false,
    }))
    await ctx.agentPresets.mount(agentScope.ctx, composition.presetId)
    await track(ctx.plugin(Storage))
    await track(ctx.plugin(StorageSqlite, { path: join(base, 'storage.db') }))
    await track(ctx.plugin(StorageDomain, { backend: 'sqlite' }))
    await track(ctx.plugin(SessionStore))
    await track(ctx.plugin(SqliteSessionPersistence, { path: join(base, 'sessions.db') }))
    await track(ctx.plugin(WorkspaceRegistry))
  } catch (error) {
    await dispose()
    throw error
  }
  return {
    ctx,
    agent,
    async recompose(next: StockCompositionWitness) {
      await writePresetComposition(presetRoot, next.presetId, agentsHome, next.fileSystem)
      await ctx.agentPresets.recompose(agentScope.ctx, next.presetId)
    },
    async remountSkills() {
      await writePresetComposition(presetRoot, 'code', agentsHome, {})
      await ctx.agentPresets.recompose(agentScope.ctx, 'code')
    },
    dispose,
  }
}

function withUserScope(item: CaptureWorkItemV1): CaptureWorkItemV1 {
  const experiences = item.learning!.experiences!.map((experience) => {
    const facts = {
      type: experience.type,
      lesson: experience.lesson,
      persistenceScope: 'USER' as const,
      evidenceStrength: experience.evidenceStrength,
      supportingEvidence: experience.supportingEvidence,
      ...(experience.contextSummary === undefined ? {} : { contextSummary: experience.contextSummary }),
    }
    return { experienceId: deriveExperienceId(item.workItemId, facts), ...facts }
  })
  const previous = item.learning!.proposal!
  const facts = {
    policyVersion: previous.policyVersion,
    name: previous.name,
    description: previous.description,
    whenToUse: previous.whenToUse,
    content: previous.content,
    invocation: previous.invocation,
    persistenceScope: 'USER' as const,
    supportingExperienceIds: experiences.map(experience => experience.experienceId),
    curation: previous.curation,
    catalogObservationDigest: previous.catalogObservationDigest,
    shortlistDigests: previous.shortlistDigests,
  }
  return CaptureWorkItemV1Schema.parse({
    ...item,
    learning: {
      ...item.learning!,
      experiences,
      proposal: { learningProposalId: deriveLearningProposalId(item.workItemId, facts), ...facts },
    },
  })
}

async function learnedFor(
  skills: DshSkillCatalogAdapter<SkillView>,
  view: SkillView,
  workspaceId: string,
  scope: Scope,
  decision: Decision,
): Promise<CaptureWorkItemV1> {
  const base = makeLearnedWorkItem({
    workspaceBinding: {
      status: 'BOUND',
      workspaceId,
      canonicalPath: view.cwd,
      observedAt: '2026-08-20T00:00:00.000Z',
    },
  })
  const recall = await recallExistingSkills(
    skills,
    view,
    base.evidenceRefs.map(item => item.excerpt).join('\n'),
  )
  if (recall.status !== 'AVAILABLE') throw new Error('stock catalog must be complete')
  const previous = base.learning!.proposal!
  const candidate = recall.observation.candidates.find(item => item.name === previous.name)
  if (decision === 'MERGE' && candidate === undefined) throw new Error('MERGE candidate is unavailable')
  const curation = decision === 'CREATE'
    ? { decision, rationale: 'No existing Skill matched.' } as const
    : { decision, candidateKey: candidate!.candidateKey, rationale: 'Merge the exact existing Skill.' } as const
  const facts = {
    policyVersion: previous.policyVersion,
    name: previous.name,
    description: previous.description,
    whenToUse: previous.whenToUse,
    content: previous.content,
    invocation: previous.invocation,
    persistenceScope: previous.persistenceScope,
    supportingExperienceIds: previous.supportingExperienceIds,
    curation,
    catalogObservationDigest: recall.observation.catalogObservationDigest,
    shortlistDigests: recall.observation.candidates.map(item => item.candidateDigest),
  }
  const learned = CaptureWorkItemV1Schema.parse({
    ...base,
    learning: {
      ...base.learning!,
      proposal: { learningProposalId: deriveLearningProposalId(base.workItemId, facts), ...facts },
    },
  })
  return scope === 'USER' ? withUserScope(learned) : learned
}

function rootContract(
  agent: Parameters<typeof resolveStockSkillRuntimeConfiguration>[1],
  resolver: StockDshRootContractResolver,
): PublicationRootContractPort<SkillView> {
  return {
    resolve: async (input) => {
      const configuration: StockSkillRuntimeConfiguration | undefined =
        await resolveStockSkillRuntimeConfiguration(stockPresetMounts, agent)
      if (configuration === undefined) {
        return { status: 'UNSUPPORTED', code: 'ROOT_CONTRACT_UNSUPPORTED' }
      }
      return resolver.resolve({
        scope: input.scope,
        configuration,
        ...(input.workspaceBinding === undefined ? {} : { workspaceBinding: input.workspaceBinding }),
      })
    },
    deriveResolutionContractDigest: deriveStockResolutionContractDigest,
  }
}

function makeBuilder(
  skills: DshSkillCatalogAdapter<SkillView>,
  workspaceRegistry: DshWorkspaceRegistryPort,
  agent: Parameters<typeof resolveStockSkillRuntimeConfiguration>[1],
  resolver: StockDshRootContractResolver,
) {
  return new ProposalSnapshotBuilder(
    skills,
    new NodePublicationFactsAdapter(),
    new DshWorkspaceBindingResolver(workspaceRegistry),
    {
      now: () => '2026-08-20T02:00:00.000Z',
      rootContract: rootContract(agent, resolver),
    },
  )
}

async function setupCase(scope: Scope, decision: Decision) {
  const base = await freshDirectory(`dsh-run2skill-cp-root-003-${scope.toLowerCase()}-${decision.toLowerCase()}-`)
  const project = join(base, 'project')
  const dshHome = join(base, 'dsh-home')
  const agentsHome = join(base, 'agents-home')
  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(dshHome, { recursive: true })
  const canonicalProject = await realpath(project)
  const root = scope === 'PROJECT'
    ? join(canonicalProject, '.dsh', 'skills')
    : join(dshHome, 'skills')
  if (decision === 'MERGE') await writeExistingSkill(root)
  const composition = compositionWitness(dshHome)
  const previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = composition.dshHome
  const rootResolver = new StockDshRootContractResolver()
  const restoreDshHome = () => {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  }
  let mount: Awaited<ReturnType<typeof mountStockDsh>>
  try {
    mount = await mountStockDsh(base, agentsHome, composition)
  } catch (caught) {
    restoreDshHome()
    throw caught
  }
  try {
    const workspace = await mount.ctx.workspaceRegistry.create(canonicalProject)
    const view = { cwd: workspace.path, scope: mount.agent }
    const skills = new DshSkillCatalogAdapter<SkillView>(mount.ctx.skills)
    const builder = makeBuilder(skills, mount.ctx.workspaceRegistry, mount.agent, rootResolver)
    const learned = await learnedFor(skills, view, workspace.id, scope, decision)
    return {
      base,
      dshHome,
      composition,
      mount,
      workspace,
      view,
      skills,
      builder,
      rootResolver,
      learned,
      root,
      restoreDshHome,
    }
  } catch (caught) {
    await mount.dispose()
    restoreDshHome()
    throw caught
  }
}

async function publish(scope: Scope, decision: Decision, verifyRemount: boolean): Promise<void> {
  const setup = await setupCase(scope, decision)
  try {
    const before = await setup.mount.ctx.skills.snapshot(setup.view)
    expect(before.complete).toBe(true)
    const built = await setup.builder.build(setup.learned, setup.view)
    expect(built.status).toBe('READY')
    if (built.status !== 'READY') return
    const action = built.proposal.actionBinding
    if (action.kind === 'DISCARD') throw new Error('publication probe requires a writable action')
    expect(action.kind).toBe(decision)
    expect(action.rootBinding).toMatchObject({
      scope,
      state: decision === 'CREATE' ? 'ABSENT' : 'EXISTING',
      expectedProvider: 'filesystem',
      expectedSource: scope === 'PROJECT' ? 'project-dsh' : 'user-dsh',
      resolverVersion: 'stock-root-resolver-v2',
      rootContractVersion: 'stock-dsh-web-default-roots-v1',
      declaredRootPath: setup.root,
    })
    expect(action.rootBinding).not.toHaveProperty('observationDigest')
    if (scope === 'PROJECT') {
      expect(built.proposal.workspaceBinding).toEqual(expect.objectContaining({
        workspaceId: setup.workspace.id, canonicalPath: setup.view.cwd,
      }))
      expect(built.proposal.dshHomeBinding).toBeUndefined()
    } else {
      expect(built.proposal.workspaceBinding).toBeUndefined()
      expect(built.proposal.dshHomeBinding).toEqual(expect.objectContaining({
        resolutionKind: 'ENVIRONMENT', canonicalPath: setup.dshHome,
      }))
    }

    const domain = createMemoryRun2skillDomain()
    domain.workItems.set(setup.learned.workItemId, setup.learned)
    const reviews = new ProposalReviewStore(domain)
    const staged = await reviews.stage(setup.learned.workItemId, setup.learned.revision, built.proposal)
    const approved = await reviews.approve(
      setup.learned.workItemId,
      staged.item.revision,
      proposalRefOf(built.proposal),
    )
    const publicationView = () => setup.view
    const saga = new ApprovalPublicationSaga({
      store: new PublicationSagaStore(domain),
      revalidation: new ApprovedProposalRevalidator(setup.builder, publicationView),
      fileSystem: new C5PublicationFileSystemAdapter({
        verifyParity: async (binding, canonicalRoot, item) => {
          const revalidated = await setup.builder.revalidateApproved(item, setup.view)
          if (revalidated.status !== 'READY') return false
          const current = revalidated.proposal.actionBinding
          return current.kind !== 'DISCARD'
            && current.rootBinding.resolutionContractDigest === binding.resolutionContractDigest
            && samePath(current.rootBinding.declaredRootPath, binding.declaredRootPath)
            && samePath(canonicalRoot, binding.declaredRootPath)
        },
      }),
      readback: new DshPublicationReadbackAdapter(setup.skills, publicationView, { attempts: 5 }),
    })

    const completed = await saga.run(approved.item.workItemId)
    expect(completed).toMatchObject({
      processingState: 'TERMINAL',
      review: { reviewDecision: 'APPROVED', publicationOutcome: 'PUBLISHED' },
    })
    expect(domain.lineages.size).toBe(1)
    const expectedPath = join(setup.root, built.proposal.name, 'SKILL.md')
    const nativeSnapshot = await setup.mount.ctx.skills.snapshot(setup.view)
    expect(nativeSnapshot.complete).toBe(true)
    expect(nativeSnapshot.skills.filter(skill => skill.name === built.proposal.name)).toHaveLength(1)
    expect(await setup.mount.ctx.skills.get(built.proposal.name, setup.view)).toMatchObject({
      provider: 'filesystem',
      source: scope === 'PROJECT' ? 'project-dsh' : 'user-dsh',
      path: expectedPath,
      content: setup.learned.learning!.proposal!.content,
    })
    expect(await setup.skills.get(built.proposal.name, setup.view)).toMatchObject({ path: expectedPath })

    if (verifyRemount) {
      await setup.mount.remountSkills()
      const remounted = await setup.mount.ctx.skills.snapshot(setup.view)
      expect(remounted.complete).toBe(true)
      expect(await setup.mount.ctx.skills.get(built.proposal.name, setup.view)).toMatchObject({
        provider: 'filesystem', source: 'user-dsh', path: expectedPath,
      })
    }
  } finally {
    await setup.mount.dispose()
    setup.restoreDshHome()
  }
}

describe('CP-ROOT-003 stock DSH publication root contract', () => {
  it.each([
    ['PROJECT', 'CREATE', false],
    ['PROJECT', 'MERGE', false],
    ['USER', 'CREATE', true],
    ['USER', 'MERGE', false],
  ] as const)('publishes %s %s through native filesystem roots', async (scope, decision, remount) => {
    await publish(scope, decision, remount)
  }, 30_000)

  it.each(['NO_JOURNAL', 'written'] as const)(
    'stops %s recovery before touching C5 when the approved absent-root ancestor identity changes',
    async (recoveryStatus) => {
      const setup = await setupCase('PROJECT', 'CREATE')
      try {
        const built = await setup.builder.build(setup.learned, setup.view)
        if (built.status !== 'READY') throw new Error('fixture proposal must be ready')
        const domain = createMemoryRun2skillDomain()
        domain.workItems.set(setup.learned.workItemId, setup.learned)
        const reviews = new ProposalReviewStore(domain)
        const staged = await reviews.stage(setup.learned.workItemId, setup.learned.revision, built.proposal)
        const approved = await reviews.approve(
          setup.learned.workItemId,
          staged.item.revision,
          proposalRefOf(built.proposal),
        )
        await rename(setup.view.cwd, join(setup.base, 'approved-project-replaced'))
        await mkdir(setup.view.cwd, { recursive: true })
        const revalidation = new ApprovedProposalRevalidator(setup.builder, () => setup.view)
        await expect(revalidation.revalidateRootContract(approved.item)).resolves.toEqual({
          status: 'NEEDS_ATTENTION', code: 'ROOT_BINDING_AMBIGUOUS',
        })
        let boundaryCalls = 0
        const unreachable = async () => {
          boundaryCalls += 1
          throw new Error('root identity drift must stop before C5 or readback')
        }
        const saga = new ApprovalPublicationSaga({
          store: new PublicationSagaStore(domain),
          revalidation,
          fileSystem: {
            recover: async () => {
              boundaryCalls += 1
              return recoveryStatus === 'NO_JOURNAL'
                ? { status: 'NO_JOURNAL' as const }
                : { status: 'written' as const, txid: 'recovered', target: 'target', backup: null }
            },
            prepareRoot: unreachable,
            write: unreachable,
            finalize: unreachable,
          },
          readback: { confirmExact: unreachable },
        })

        const completed = await saga.run(approved.item.workItemId)
        expect(completed).toMatchObject({
          processingState: 'NEEDS_ATTENTION',
          review: { publicationOutcome: 'NEEDS_ATTENTION' },
        })
        expect(boundaryCalls).toBe(0)
      } finally {
        await setup.mount.dispose()
        setup.restoreDshHome()
      }
    },
    30_000,
  )

  it.each([
    ['renamed provider', 'provider', 'PROJECT'],
    ['disabled defaults', 'defaults', 'PROJECT'],
    ['custom roots', 'roots', 'PROJECT'],
    ['custom preset', 'preset', 'PROJECT'],
    ['mounted DSH_HOME environment', 'environment', 'USER'],
  ] as const)('fails closed with NEEDS_ATTENTION for %s drift', async (_label, drift, scope) => {
    for (const recoveryStatus of ['NO_JOURNAL', 'written'] as const) {
      const setup = await setupCase(scope, 'CREATE')
      try {
        const built = await setup.builder.build(setup.learned, setup.view)
        if (built.status !== 'READY') throw new Error('fixture proposal must be ready')
        const domain = createMemoryRun2skillDomain()
        domain.workItems.set(setup.learned.workItemId, setup.learned)
        const reviews = new ProposalReviewStore(domain)
        const staged = await reviews.stage(setup.learned.workItemId, setup.learned.revision, built.proposal)
        const approved = await reviews.approve(
          setup.learned.workItemId,
          staged.item.revision,
          proposalRefOf(built.proposal),
        )
        const customRoot = join(setup.base, 'custom-skills')
        if (drift === 'roots') await mkdir(customRoot, { recursive: true })
        const mismatchedComposition = compositionWitness(
          setup.dshHome,
          {
            ...(drift === 'provider' ? { providerName: 'run2skill-filesystem' } : {}),
            ...(drift === 'defaults' ? { includeDefaultRoots: false } : {}),
            ...(drift === 'roots' ? { customSkillDirs: [customRoot] } : {}),
          },
          drift === 'preset' ? 'team-preset' : 'standard',
        )
        if (drift === 'environment') {
          process.env.DSH_HOME = join(setup.base, 'drifted-dsh-home')
        } else {
          await setup.mount.recompose(mismatchedComposition)
        }
        const mismatched = makeBuilder(
          setup.skills,
          setup.mount.ctx.workspaceRegistry,
          setup.mount.agent,
          setup.rootResolver,
        )
        const publicationView = () => setup.view
        const revalidation = new ApprovedProposalRevalidator(mismatched, publicationView)
        await expect(revalidation.revalidateRootContract(approved.item)).resolves.toEqual({
          status: 'NEEDS_ATTENTION', code: 'ROOT_CONTRACT_UNSUPPORTED',
        })
        await expect(revalidation.revalidate(approved.item)).resolves.toEqual({
          status: 'NEEDS_ATTENTION', code: 'ROOT_CONTRACT_UNSUPPORTED',
        })
        let boundaryCalls = 0
        const unreachable = async () => {
          boundaryCalls += 1
          throw new Error('configuration drift must stop before recover/prepare/write/readback')
        }
        const saga = new ApprovalPublicationSaga({
          store: new PublicationSagaStore(domain),
          revalidation,
          fileSystem: {
            recover: async () => {
              boundaryCalls += 1
              return recoveryStatus === 'NO_JOURNAL'
                ? { status: 'NO_JOURNAL' as const }
                : { status: 'written' as const, txid: 'recovered', target: 'target', backup: null }
            },
            prepareRoot: unreachable,
            write: unreachable,
            finalize: unreachable,
          },
          readback: { confirmExact: unreachable },
        })

        const completed = await saga.run(approved.item.workItemId)
        expect(completed).toMatchObject({
          processingState: 'NEEDS_ATTENTION',
          review: { publicationOutcome: 'NEEDS_ATTENTION' },
        })
        expect(boundaryCalls).toBe(0)
        await expect(new NodePublicationFactsAdapter().observeEntry(
          join(setup.root, built.proposal.name, 'SKILL.md'),
        )).resolves.toEqual({ status: 'ABSENT' })
      } finally {
        await setup.mount.dispose()
        setup.restoreDshHome()
      }
    }
  }, 30_000)

  it.each([
    ['renamed provider', { profile: 'web', presetId: 'standard', providerName: 'run2skill-filesystem', includeDefaultRoots: true, customSkillDirs: [] }],
    ['disabled defaults', { profile: 'web', presetId: 'standard', providerName: 'filesystem', includeDefaultRoots: false, customSkillDirs: [] }],
    ['custom roots', { profile: 'web', presetId: 'standard', providerName: 'filesystem', includeDefaultRoots: true, customSkillDirs: ['/custom/skills'] }],
    ['custom preset', { profile: 'web', presetId: 'team-preset', providerName: 'filesystem', includeDefaultRoots: true, customSkillDirs: [] }],
  ])('rejects %s without inventing a run2skill provider or root', (_label, configuration) => {
    const resolver = new StockDshRootContractResolver({ environment: { DSH_HOME: '/tmp/dsh-home' } })
    expect(resolver.resolve({
      scope: 'PROJECT',
      configuration,
      workspaceBinding: { workspaceId: 'workspace', canonicalPath: '/tmp/project' },
    })).toEqual({ status: 'UNSUPPORTED', code: 'ROOT_CONTRACT_UNSUPPORTED' })
  })
})
