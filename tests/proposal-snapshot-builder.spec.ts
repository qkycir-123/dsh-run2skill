import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ProposalSnapshotBuilder,
  type PublicationFactsPort,
  type ProposalSnapshotBuilderOptions,
  type WorkspaceRevalidationPort,
} from '../src/application/curation/index.js'
import {
  deriveLearningProposalId,
  deriveExperienceId,
  recallExistingSkills,
  type LearningProposalV1,
  type SkillCatalogPort,
  type SkillCatalogSnapshotProjection,
  type SkillDefinitionProjection,
} from '../src/domain/learn/index.js'
import { CaptureWorkItemV1Schema, type CaptureWorkItemV1 } from '../src/domain/observe/schemas.js'
import { makeLearnedWorkItem } from './support/review-fixture.js'
import { ProposalReviewStore } from '../src/adapters/dsh-storage/proposal-review-store.js'
import { proposalRefOf } from '../src/domain/review/index.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'

type View = { readonly cwd: string }

const workspace = resolve('fixture-workspace')
const root = join(workspace, '.dsh', 'skills')
const skillName = 'generated-file-hygiene'
const bundlePath = join(root, skillName)
const skillFilePath = join(bundlePath, 'SKILL.md')
const userHome = resolve('fixture-dsh-home')
const userRoot = join(userHome, 'skills')

function snapshot(overrides: Partial<SkillCatalogSnapshotProjection> = {}): SkillCatalogSnapshotProjection {
  return {
    complete: true,
    skills: [],
    roots: [{ provider: 'filesystem', source: 'project-dsh', path: root }],
    ...overrides,
  }
}

function catalog(
  current: () => SkillCatalogSnapshotProjection,
  definitions: Record<string, SkillDefinitionProjection> = {},
): SkillCatalogPort<View> {
  return {
    snapshot: async () => current(),
    get: async name => definitions[name],
  }
}

function publicationFacts(overrides: Partial<PublicationFactsPort> = {}): PublicationFactsPort {
  return {
    observeRoot: async () => ({
      status: 'ABSENT',
      canonicalExistingAncestorPath: workspace,
      ancestorIdentityDigest: 'a'.repeat(64),
      missingSegments: ['.dsh', 'skills'],
    }),
    observeEntry: async () => ({ status: 'ABSENT' }),
    readExactText: async () => ({ status: 'UNAVAILABLE' }),
    ...overrides,
  }
}

function workspaceFacts(overrides: Partial<WorkspaceRevalidationPort> = {}): WorkspaceRevalidationPort {
  return {
    resolve: async () => ({
      status: 'BOUND', workspaceId: 'workspace-fixture', canonicalPath: workspace,
    }),
    ...overrides,
  }
}

function proposalBuilder(
  skills: SkillCatalogPort<View>,
  facts: PublicationFactsPort = publicationFacts(),
  options: ProposalSnapshotBuilderOptions = {},
  workspaces: WorkspaceRevalidationPort = workspaceFacts(),
): ProposalSnapshotBuilder<View> {
  return new ProposalSnapshotBuilder(skills, facts, workspaces, options)
}

async function learnedFor(
  skills: SkillCatalogPort<View>,
  curation: LearningProposalV1['curation'],
): Promise<CaptureWorkItemV1> {
  const base = makeLearnedWorkItem({
    workspaceBinding: {
      status: 'BOUND',
      workspaceId: 'workspace-fixture',
      canonicalPath: workspace,
      observedAt: '2026-08-20T00:00:00.000Z',
    },
  })
  const observation = await recallExistingSkills(
    skills,
    { cwd: workspace },
    base.evidenceRefs.map(item => item.excerpt).join('\n'),
  )
  if (observation.status !== 'AVAILABLE') throw new Error('fixture catalog must be available')
  const previous = base.learning!.proposal!
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
    catalogObservationDigest: observation.observation.catalogObservationDigest,
    shortlistDigests: observation.observation.candidates.map(item => item.candidateDigest),
  }
  return CaptureWorkItemV1Schema.parse({
    ...base,
    learning: {
      ...base.learning!,
      proposal: { learningProposalId: deriveLearningProposalId(base.workItemId, facts), ...facts },
    },
  })
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

function withProposalContent(item: CaptureWorkItemV1, content: string): CaptureWorkItemV1 {
  const previous = item.learning!.proposal!
  const facts = {
    policyVersion: previous.policyVersion,
    name: previous.name,
    description: previous.description,
    whenToUse: previous.whenToUse,
    content,
    invocation: previous.invocation,
    persistenceScope: previous.persistenceScope,
    supportingExperienceIds: previous.supportingExperienceIds,
    curation: previous.curation,
    catalogObservationDigest: previous.catalogObservationDigest,
    shortlistDigests: previous.shortlistDigests,
  }
  return CaptureWorkItemV1Schema.parse({
    ...item,
    learning: {
      ...item.learning!,
      proposal: { learningProposalId: deriveLearningProposalId(item.workItemId, facts), ...facts },
    },
  })
}

describe('ProposalSnapshotBuilder', () => {
  it('builds a Host-owned CREATE snapshot for an observed but absent project root', async () => {
    const current = snapshot()
    const skills = catalog(() => current)
    const item = await learnedFor(skills, { decision: 'CREATE', rationale: 'No existing Skill matched.' })
    const builder = proposalBuilder(skills, publicationFacts(), {
      now: () => '2026-08-20T01:00:00.000Z',
    })

    const result = await builder.build(item, { cwd: workspace })

    expect(result.status).toBe('READY')
    if (result.status !== 'READY') return
    expect(result.proposal).toMatchObject({
      kind: 'CREATE',
      workspaceBinding: {
        workspaceId: 'workspace-fixture',
        canonicalPath: workspace,
        observedAt: '2026-08-20T01:00:00.000Z',
      },
      actionBinding: {
        kind: 'CREATE',
        rootBinding: { state: 'ABSENT', declaredRootPath: root, missingSegments: ['.dsh', 'skills'] },
        targetBinding: { bundlePath, skillFilePath },
        expectedAbsence: {
          flatSkillFilePath: join(root, `${skillName}.md`),
          flatSkillFilePathAbsent: true,
        },
      },
    })
    expect(result.proposal.exactSkillBytes).toContain('disable-model-invocation: false')
    expect(result.proposal.exactSkillBytes).toContain('user-invocable: false')
  })

  it('revalidates the exact approved facts and accepts only an approved partial root preparation', async () => {
    const skills = catalog(() => snapshot())
    const learned = await learnedFor(skills, { decision: 'CREATE', rationale: 'Create it.' })
    const initialBuilder = proposalBuilder(skills, publicationFacts(), {
      now: () => '2026-08-20T01:00:00.000Z',
    })
    const built = await initialBuilder.build(learned, { cwd: workspace })
    if (built.status !== 'READY') throw new Error('fixture proposal must be ready')
    const domain = createMemoryRun2skillDomain()
    domain.workItems.set(learned.workItemId, learned)
    const reviews = new ProposalReviewStore(domain, () => '2026-08-20T01:00:01.000Z')
    const staged = await reviews.stage(learned.workItemId, learned.revision, built.proposal)
    const approved = await reviews.approve(
      learned.workItemId,
      staged.item.revision,
      proposalRefOf(built.proposal),
    )
    const partialRootBuilder = proposalBuilder(skills, publicationFacts({
      observeRoot: async () => ({
        status: 'ABSENT',
        canonicalExistingAncestorPath: join(workspace, '.dsh'),
        ancestorIdentityDigest: 'f'.repeat(64),
        missingSegments: ['skills'],
      }),
    }), { now: () => '2026-08-20T09:00:00.000Z' })

    await expect(partialRootBuilder.revalidateApproved(
      approved.item,
      { cwd: workspace },
    )).resolves.toEqual({ status: 'READY', proposal: built.proposal })

    const occupiedTargetBuilder = proposalBuilder(skills, publicationFacts({
      observeEntry: async path => ({ status: path === bundlePath ? 'DIRECTORY' : 'ABSENT' }),
    }))
    await expect(occupiedTargetBuilder.revalidateApproved(
      approved.item,
      { cwd: workspace },
    )).resolves.toEqual({ status: 'UNAVAILABLE', failureCode: 'TARGET_ALREADY_EXISTS' })
  })

  it.each([
    ['unregistered', { status: 'UNREGISTERED' as const }],
    ['same path with a new identity', {
      status: 'BOUND' as const, workspaceId: 'replacement-workspace', canonicalPath: workspace,
    }],
    ['same identity with a changed canonical path', {
      status: 'BOUND' as const, workspaceId: 'workspace-fixture', canonicalPath: resolve('replacement-workspace'),
    }],
  ])('rejects a stale PROJECT workspace when it is %s', async (_label, currentWorkspace) => {
    const skills = catalog(() => snapshot())
    const item = await learnedFor(skills, { decision: 'CREATE', rationale: 'Create it.' })
    const builder = proposalBuilder(skills, publicationFacts(), {}, workspaceFacts({
      resolve: async () => currentWorkspace,
    }))

    await expect(builder.build(item, { cwd: workspace })).resolves.toEqual({
      status: 'UNAVAILABLE', failureCode: 'WORKSPACE_BINDING_UNAVAILABLE',
    })
  })

  it.each([
    ['CATALOG_INCOMPLETE', snapshot({ complete: false })],
    ['ROOT_OBSERVATION_UNAVAILABLE', snapshot({ roots: undefined })],
    ['ROOT_BINDING_AMBIGUOUS', snapshot({ roots: [
      { provider: 'filesystem', source: 'project-dsh', path: root },
      { provider: 'filesystem', source: 'project-dsh', path: root },
    ] })],
    ['ROOT_BINDING_AMBIGUOUS', snapshot({ roots: [
      { provider: 'filesystem', source: 'project-dsh', path: join(workspace, 'other-skills') },
    ] })],
  ] as const)('fails closed with %s', async (failureCode, nextSnapshot) => {
    const stable = snapshot()
    const initialSkills = catalog(() => stable)
    const item = await learnedFor(initialSkills, { decision: 'CREATE', rationale: 'Create it.' })
    const builder = proposalBuilder(catalog(() => nextSnapshot), publicationFacts())

    await expect(builder.build(item, { cwd: workspace })).resolves.toEqual({
      status: 'UNAVAILABLE', failureCode,
    })
  })

  it('binds an exact writable MERGE Base from the same catalog observation', async () => {
    const definition: SkillDefinitionProjection = {
      name: skillName,
      description: '把这个流程保存成 skill',
      whenToUse: 'Use for generated files.',
      provider: 'filesystem',
      source: 'project-dsh',
      path: skillFilePath,
      content: '# Existing\n\nOld behavior.',
    }
    const current = snapshot({ skills: [definition] })
    const skills = catalog(() => current, { [skillName]: definition })
    const recalled = await recallExistingSkills(skills, { cwd: workspace }, makeLearnedWorkItem().evidenceRefs[0]!.excerpt)
    if (recalled.status !== 'AVAILABLE') throw new Error('fixture recall must be available')
    const candidateKey = recalled.observation.candidates[0]!.candidateKey
    const item = await learnedFor(skills, { decision: 'MERGE', candidateKey, rationale: 'Same capability.' })
    const exactBase = '---\nname: generated-file-hygiene\ndescription: old\n---\n\n# Existing\n\nOld behavior.\n'
    const builder = proposalBuilder(skills, publicationFacts({
      observeRoot: async () => ({
        status: 'EXISTING', canonicalRootPath: root, rootIdentityDigest: 'b'.repeat(64),
      }),
      readExactText: async path => path === skillFilePath
        ? { status: 'AVAILABLE', text: exactBase }
        : { status: 'UNAVAILABLE' },
    }), { now: () => '2026-08-20T00:00:00.000Z' })

    const result = await builder.build(item, { cwd: workspace })

    expect(result.status).toBe('READY')
    if (result.status !== 'READY') return
    expect(result.proposal.actionBinding).toMatchObject({
      kind: 'MERGE',
      baseBinding: { path: skillFilePath, exactBytes: exactBase },
    })

    const unsafeBase = `---\nname: ${skillName}\ndescription: old\n---\n\n# Existing\n\n${[
      'client', 'secret',
    ].join('_')}=synthetic-fixture-value\n`
    await expect(proposalBuilder(skills, publicationFacts({
      observeRoot: async () => ({
        status: 'EXISTING', canonicalRootPath: root, rootIdentityDigest: 'b'.repeat(64),
      }),
      readExactText: async () => ({ status: 'AVAILABLE', text: unsafeBase }),
    })).build(item, { cwd: workspace })).resolves.toEqual({
      status: 'UNAVAILABLE', failureCode: 'UNSAFE_SKILL',
    })
  })

  it('accepts an existing root for CREATE and rejects an absent root for MERGE', async () => {
    const emptySkills = catalog(() => snapshot())
    const create = await learnedFor(emptySkills, { decision: 'CREATE', rationale: 'Create it.' })
    const existingRoot = publicationFacts({
      observeRoot: async () => ({
        status: 'EXISTING', canonicalRootPath: root, rootIdentityDigest: 'b'.repeat(64),
      }),
    })
    const created = await proposalBuilder(emptySkills, existingRoot).build(create, { cwd: workspace })
    expect(created).toMatchObject({
      status: 'READY', proposal: { actionBinding: { rootBinding: { state: 'EXISTING' } } },
    })

    const definition: SkillDefinitionProjection = {
      name: skillName,
      description: '把这个流程保存成 skill',
      provider: 'filesystem',
      source: 'project-dsh',
      path: skillFilePath,
      content: '# Existing\n\nOld behavior.',
    }
    const mergeSkills = catalog(() => snapshot({ skills: [definition] }), { [skillName]: definition })
    const recall = await recallExistingSkills(
      mergeSkills, { cwd: workspace }, makeLearnedWorkItem().evidenceRefs[0]!.excerpt,
    )
    if (recall.status !== 'AVAILABLE') throw new Error('fixture recall must be available')
    const merge = await learnedFor(mergeSkills, {
      decision: 'MERGE', candidateKey: recall.observation.candidates[0]!.candidateKey, rationale: 'Merge it.',
    })
    await expect(proposalBuilder(mergeSkills, publicationFacts()).build(
      merge, { cwd: workspace },
    )).resolves.toEqual({ status: 'UNAVAILABLE', failureCode: 'TARGET_FORMAT_UNSUPPORTED' })
  })

  it('binds USER targets only to the effective DSH Home', async () => {
    const current = snapshot({
      roots: [{ provider: 'filesystem', source: 'user-dsh', path: userRoot }],
    })
    const skills = catalog(() => current)
    const item = withUserScope(await learnedFor(skills, { decision: 'CREATE', rationale: 'Create user Skill.' }))
    const facts = publicationFacts({
      observeRoot: async () => ({
        status: 'ABSENT',
        canonicalExistingAncestorPath: userHome,
        ancestorIdentityDigest: 'a'.repeat(64),
        missingSegments: ['skills'],
      }),
    })
    await expect(proposalBuilder(skills, facts).build(item, { cwd: workspace }))
      .resolves.toEqual({ status: 'UNAVAILABLE', failureCode: 'WORKSPACE_BINDING_UNAVAILABLE' })

    const result = await proposalBuilder(skills, facts, {
      effectiveDshHome: userHome,
      now: () => '2026-08-20T00:00:00.000Z',
    }).build(item, { cwd: workspace })
    expect(result).toMatchObject({
      status: 'READY',
      proposal: {
        persistenceScope: 'USER',
        actionBinding: {
          rootBinding: { source: 'user-dsh', declaredRootPath: userRoot, missingSegments: ['skills'] },
          targetBinding: { bundlePath: join(userRoot, skillName) },
        },
      },
    })
  })

  it('rejects a stale catalog and read-only or other-scope MERGE candidates', async () => {
    const initial = snapshot()
    const initialSkills = catalog(() => initial)
    const item = await learnedFor(initialSkills, { decision: 'CREATE', rationale: 'Create it.' })
    const changed = snapshot({ skills: [{
      name: 'unrelated', description: 'changed catalog', provider: 'runtime', source: 'runtime',
    }] })
    await expect(proposalBuilder(catalog(() => changed), publicationFacts()).build(
      item, { cwd: workspace },
    )).resolves.toEqual({ status: 'UNAVAILABLE', failureCode: 'CATALOG_CHANGED' })

    for (const source of ['project-agents', 'user-dsh'] as const) {
      const definition: SkillDefinitionProjection = {
        name: skillName,
        description: '把这个流程保存成 skill',
        provider: 'filesystem',
        source,
        path: skillFilePath,
        content: '# Existing\n\nOld behavior.',
      }
      const skills = catalog(() => snapshot({ skills: [definition] }), { [skillName]: definition })
      const recalled = await recallExistingSkills(
        skills, { cwd: workspace }, makeLearnedWorkItem().evidenceRefs[0]!.excerpt,
      )
      if (recalled.status !== 'AVAILABLE') throw new Error('fixture recall must be available')
      const merge = await learnedFor(skills, {
        decision: 'MERGE', candidateKey: recalled.observation.candidates[0]!.candidateKey, rationale: 'Merge it.',
      })
      await expect(proposalBuilder(skills, publicationFacts({
        observeRoot: async () => ({
          status: 'EXISTING', canonicalRootPath: root, rootIdentityDigest: 'b'.repeat(64),
        }),
      })).build(merge, { cwd: workspace })).resolves.toEqual({
        status: 'UNAVAILABLE', failureCode: 'CURATION_CONFLICT',
      })
    }
  })

  it('fails closed when root or target observations cannot prove fixed facts', async () => {
    const skills = catalog(() => snapshot())
    const item = await learnedFor(skills, { decision: 'CREATE', rationale: 'Create it.' })
    await expect(proposalBuilder(skills, publicationFacts({
      observeRoot: async () => ({
        status: 'ABSENT',
        canonicalExistingAncestorPath: workspace,
        ancestorIdentityDigest: 'a'.repeat(64),
        missingSegments: ['skills'],
      }),
    })).build(item, { cwd: workspace })).resolves.toEqual({
      status: 'UNAVAILABLE', failureCode: 'ROOT_BINDING_AMBIGUOUS',
    })
    await expect(proposalBuilder(skills, publicationFacts({
      observeEntry: async () => ({ status: 'UNAVAILABLE' }),
    })).build(item, { cwd: workspace })).resolves.toEqual({
      status: 'UNAVAILABLE', failureCode: 'TARGET_FACTS_UNAVAILABLE',
    })
    await expect(proposalBuilder(skills, publicationFacts({
      observeEntry: async path => path.endsWith(`${skillName}.md`)
        ? { status: 'UNAVAILABLE' }
        : { status: 'ABSENT' },
    })).build(item, { cwd: workspace })).resolves.toEqual({
      status: 'UNAVAILABLE', failureCode: 'TARGET_FACTS_UNAVAILABLE',
    })
  })

  it('binds a complete read-only DISCARD candidate without requiring a filesystem path', async () => {
    const definition: SkillDefinitionProjection = {
      name: skillName,
      description: '把这个流程保存成 skill',
      provider: 'runtime',
      source: 'runtime',
      content: '# Existing\n\nAlready covered.',
    }
    const current = snapshot({ skills: [definition] })
    const skills = catalog(() => current, { [skillName]: definition })
    const recalled = await recallExistingSkills(skills, { cwd: workspace }, makeLearnedWorkItem().evidenceRefs[0]!.excerpt)
    if (recalled.status !== 'AVAILABLE') throw new Error('fixture recall must be available')
    const candidateKey = recalled.observation.candidates[0]!.candidateKey
    const item = await learnedFor(skills, { decision: 'DISCARD', candidateKey, rationale: 'Fully covered.' })
    const builder = proposalBuilder(skills, publicationFacts(), {
      now: () => '2026-08-20T00:00:00.000Z',
    })

    const result = await builder.build(item, { cwd: workspace })

    expect(result.status).toBe('READY')
    if (result.status !== 'READY') return
    expect(result.proposal.actionBinding).toMatchObject({
      kind: 'DISCARD',
      coveringCandidateBinding: { provider: 'runtime', source: 'runtime', content: definition.content },
    })
  })

  it('rejects CREATE collisions, existing target entries, and secret-like final bytes', async () => {
    const collision = snapshot({ skills: [{
      name: skillName,
      description: 'other',
      provider: 'runtime',
      source: 'runtime',
    }] })
    const collisionSkills = catalog(() => collision)
    const collisionItem = await learnedFor(collisionSkills, { decision: 'CREATE', rationale: 'Create it.' })
    await expect(proposalBuilder(collisionSkills, publicationFacts()).build(
      collisionItem, { cwd: workspace },
    )).resolves.toEqual({ status: 'UNAVAILABLE', failureCode: 'CURATION_CONFLICT' })

    const stable = snapshot()
    const skills = catalog(() => stable)
    const item = await learnedFor(skills, { decision: 'CREATE', rationale: 'Create it.' })
    await expect(proposalBuilder(skills, publicationFacts({
      observeEntry: async () => ({ status: 'DIRECTORY' }),
    })).build(item, { cwd: workspace })).resolves.toEqual({
      status: 'UNAVAILABLE', failureCode: 'TARGET_ALREADY_EXISTS',
    })

    const observedPaths: string[] = []
    await expect(proposalBuilder(skills, publicationFacts({
      observeEntry: async path => {
        observedPaths.push(path)
        return path.endsWith(`${skillName}.md`) ? { status: 'FILE' } : { status: 'ABSENT' }
      },
    })).build(item, { cwd: workspace })).resolves.toEqual({
      status: 'UNAVAILABLE', failureCode: 'TARGET_ALREADY_EXISTS',
    })
    expect(observedPaths).toContain(join(root, `${skillName}.md`))

    for (const content of [
      `# Unsafe\n\n${['api', 'key'].join('_')}=synthetic-fixture-secret`,
      '# Unsafe\n\nzero\u200bwidth',
      'Missing a Markdown heading.',
    ]) {
      await expect(proposalBuilder(skills, publicationFacts()).build(
        withProposalContent(item, content), { cwd: workspace },
      )).resolves.toEqual({ status: 'UNAVAILABLE', failureCode: 'UNSAFE_SKILL' })
    }
  })
})
