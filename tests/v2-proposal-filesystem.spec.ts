import { lstat, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DshV2ProposalFileSystemAdapter } from '../src/adapters/dsh-publication/v2-proposal-filesystem.js'
import {
  finalizeTransaction,
  observePublicationRoot,
} from '../src/adapters/dsh-publication/filesystem-cas.mjs'
import { parseCanonicalSkillBody, renderCanonicalSkill } from '../src/application/curation/skill-renderer.js'
import type { V2ProposalPublicationInput } from '../src/application/publication/index.js'
import { deriveV2ProposalRef } from '../src/application/review/index.js'
import {
  ROOT_CONTRACT_VERSION_V2,
  ROOT_RESOLVER_VERSION_V2,
  RootBindingV2Schema,
} from '../src/domain/review/index.js'
import {
  ProposalLineageV2Schema,
  SessionBatchV2Schema,
  deriveCreateTargetDigestV2,
} from '../src/domain/v2/index.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import { deriveProjectScopeIdentityDigest } from '../src/domain/purge/index.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })))
})

async function fixture(options: {
  beforeSnapshot?: () => Promise<void>
  preferFlatWinner?: boolean
} = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'run2skill-v2-publication-'))
  roots.push(temporary)
  const root = join(temporary, '.dsh', 'skills')
  await mkdir(root, { recursive: true })
  const observed = await observePublicationRoot(root)
  if (observed.status !== 'EXISTING') throw new Error('expected publication root')
  const minimal = createMinimalV2Fixtures()
  const exactSkillBytes = renderCanonicalSkill({
    name: 'fixture-v2',
    description: 'A native v2 fixture.',
    whenToUse: 'Use for v2 schema tests.',
    content: '# Fixture v2',
    invocation: { modelInvocable: true, userInvocable: false },
  })
  const raw = minimal.nativeActiveProposalLineage
  const lineage = ProposalLineageV2Schema.parse({
    ...raw,
    proposalRevisions: raw.proposalRevisions.map(proposal => ({
      ...proposal,
      body: {
        ...proposal.body,
        exactSkillBytes,
        skillBytesDigest: sha256Utf8(exactSkillBytes),
      },
      targetIdentityDigest: deriveCreateTargetDigestV2({
        persistenceScope: raw.persistenceScope,
        behaviorSignature: raw.behaviorSignature,
      }),
      projectScopeBinding: {
        workspaceId: 'workspace-1',
        scopeIdentityDigest: deriveProjectScopeIdentityDigest(temporary),
      },
    })),
  })
  if (lineage.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
  const proposal = lineage.proposalRevisions.at(-1)!
  const input: V2ProposalPublicationInput = {
    lineage,
    proposal,
    proposalRef: deriveV2ProposalRef(lineage),
    intent: minimal.proposalReadyIntent,
    batch: SessionBatchV2Schema.parse(minimal.sessionBatch),
  }
  const rootBinding = RootBindingV2Schema.parse({
    state: 'EXISTING',
    scope: 'PROJECT',
    expectedProvider: 'filesystem',
    expectedSource: 'project-dsh',
    resolverVersion: ROOT_RESOLVER_VERSION_V2,
    rootContractVersion: ROOT_CONTRACT_VERSION_V2,
    resolutionContractDigest: 'a'.repeat(64),
    declaredRootPath: root,
    canonicalRootPath: observed.canonicalRootPath,
    rootIdentityDigest: observed.rootIdentityDigest,
  })
  const view = {}
  let registryAvailable = true
  const target = join(root, proposal.body.name, 'SKILL.md')
  const registry = {
    snapshot: async () => {
      if (!registryAvailable) throw new Error('registry unavailable')
      await options.beforeSnapshot?.()
      try {
        await readFile(target, 'utf8')
      } catch {
        return { complete: true, skills: [] }
      }
      return {
        complete: true,
        skills: [{
          name: proposal.body.name,
          description: proposal.body.description,
          whenToUse: proposal.body.whenToUse,
          provider: 'filesystem',
          source: 'project-dsh',
          path: options.preferFlatWinner ? join(root, `${proposal.body.name}.md`) : target,
          invocation: { modelInvocable: true, userInvocable: false },
        }],
      }
    },
    get: async () => {
      if (!registryAvailable) throw new Error('registry unavailable')
      const current = await readFile(target, 'utf8')
      return {
        name: proposal.body.name,
        description: proposal.body.description,
        whenToUse: proposal.body.whenToUse,
        provider: 'filesystem',
        source: 'project-dsh',
        path: target,
        invocation: { modelInvocable: true, userInvocable: false },
        content: parseCanonicalSkillBody(current),
      }
    },
  }
  const adapter = new DshV2ProposalFileSystemAdapter({
    bindings: { resolve: async () => ({ status: 'READY', rootBinding, view }) },
    registry,
    readbackAttempts: 1,
  })
  return {
    adapter,
    input,
    root,
    rootBinding,
    target,
    setRegistryAvailable(value: boolean) { registryAvailable = value },
  }
}

describe('v2 DSH Proposal filesystem adapter', () => {
  it('reports an absent recovery attempt without starting a new filesystem write', async () => {
    const seeded = await fixture()
    const request = { ...seeded.input, attemptId: `pcm_${'0'.repeat(64)}` }

    await expect(seeded.adapter.recover(request)).resolves.toEqual({ status: 'ABSENT' })
    await expect(readFile(seeded.target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('publishes a CREATE through the real CAS, exact DSH readback, and finalization', async () => {
    const seeded = await fixture()
    const request = { ...seeded.input, attemptId: `pcm_${'1'.repeat(64)}` }

    const first = await seeded.adapter.publish(request)

    expect(first).toMatchObject({ status: 'PUBLISHED' })
    expect(await readFile(seeded.target, 'utf8')).toBe(seeded.input.proposal.body.exactSkillBytes)
    await expect(seeded.adapter.publish(request)).resolves.toEqual(first)
  })

  it('refuses CREATE when a flat Skill with the same name already exists', async () => {
    const seeded = await fixture()
    await writeFile(join(seeded.root, `${seeded.input.proposal.body.name}.md`), 'existing', 'utf8')

    await expect(seeded.adapter.publish({
      ...seeded.input,
      attemptId: `pcm_${'2'.repeat(64)}`,
    })).resolves.toEqual({ status: 'CONFLICT' })
    await expect(readFile(seeded.target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('withdraws an unfinalized CREATE when a flat Skill appears during Runtime readback', async () => {
    let flatTarget = ''
    let injected = false
    const seeded = await fixture({
      beforeSnapshot: async () => {
        if (injected) return
        injected = true
        await writeFile(flatTarget, 'concurrent flat skill', 'utf8')
      },
    })
    flatTarget = join(seeded.root, `${seeded.input.proposal.body.name}.md`)

    await expect(seeded.adapter.publish({
      ...seeded.input,
      attemptId: `pcm_${'d'.repeat(64)}`,
    })).resolves.toEqual({ status: 'CONFLICT' })
    await expect(readFile(seeded.target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(seeded.root, seeded.input.proposal.body.name))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(flatTarget, 'utf8')).resolves.toBe('concurrent flat skill')
  })

  it('withdraws CREATE when the concurrent flat Skill becomes the Runtime winner', async () => {
    let flatTarget = ''
    let injected = false
    const seeded = await fixture({
      preferFlatWinner: true,
      beforeSnapshot: async () => {
        if (injected) return
        injected = true
        await writeFile(flatTarget, 'winning flat skill', 'utf8')
      },
    })
    flatTarget = join(seeded.root, `${seeded.input.proposal.body.name}.md`)

    await expect(seeded.adapter.publish({
      ...seeded.input,
      attemptId: `pcm_${'e'.repeat(64)}`,
    })).resolves.toEqual({ status: 'CONFLICT' })
    await expect(readFile(seeded.target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(seeded.root, seeded.input.proposal.body.name))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(flatTarget, 'utf8')).resolves.toBe('winning flat skill')
  })

  it('does not attribute a pre-existing same-byte bundle to a new CREATE attempt', async () => {
    const seeded = await fixture()
    await mkdir(join(seeded.root, seeded.input.proposal.body.name), { recursive: true })
    await writeFile(seeded.target, seeded.input.proposal.body.exactSkillBytes, 'utf8')

    await expect(seeded.adapter.publish({
      ...seeded.input,
      attemptId: `pcm_${'b'.repeat(64)}`,
    })).resolves.toEqual({ status: 'CONFLICT' })
  })

  it('does not reuse another Skill\'s FINALIZED journal for the same attempt id', async () => {
    const seeded = await fixture()
    const attemptId = `pcm_${'e'.repeat(64)}`
    await expect(seeded.adapter.publish({ ...seeded.input, attemptId }))
      .resolves.toMatchObject({ status: 'PUBLISHED' })
    const secondBytes = renderCanonicalSkill({
      name: 'second-v2',
      description: 'A second v2 fixture.',
      whenToUse: 'Use for the second v2 fixture.',
      content: '# Second v2',
      invocation: { modelInvocable: true, userInvocable: false },
    })
    const secondLineage = ProposalLineageV2Schema.parse({
      ...seeded.input.lineage,
      proposalRevisions: [{
        ...seeded.input.proposal,
        body: {
          name: 'second-v2',
          description: 'A second v2 fixture.',
          whenToUse: 'Use for the second v2 fixture.',
          exactSkillBytes: secondBytes,
          skillBytesDigest: sha256Utf8(secondBytes),
        },
      }],
    })
    if (secondLineage.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
    const secondTarget = join(seeded.root, 'second-v2', 'SKILL.md')
    await mkdir(join(seeded.root, 'second-v2'))
    await writeFile(secondTarget, secondBytes, 'utf8')
    const secondAdapter = new DshV2ProposalFileSystemAdapter({
      bindings: {
        resolve: async () => ({ status: 'READY', rootBinding: seeded.rootBinding, view: {} }),
      },
      registry: {
        snapshot: async () => ({
          complete: true,
          skills: [{
            name: 'second-v2', description: 'A second v2 fixture.',
            whenToUse: 'Use for the second v2 fixture.', provider: 'filesystem',
            source: 'project-dsh', path: secondTarget,
            invocation: { modelInvocable: true, userInvocable: false },
          }],
        }),
        get: async () => ({
          name: 'second-v2', description: 'A second v2 fixture.',
          whenToUse: 'Use for the second v2 fixture.', provider: 'filesystem',
          source: 'project-dsh', path: secondTarget, content: '# Second v2',
          invocation: { modelInvocable: true, userInvocable: false },
        }),
      },
      readbackAttempts: 1,
    })

    await expect(secondAdapter.publish({
      ...seeded.input,
      lineage: secondLineage,
      proposal: secondLineage.proposalRevisions[0]!,
      proposalRef: deriveV2ProposalRef(secondLineage),
      attemptId,
    })).resolves.toEqual({ status: 'CONFLICT' })
  })

  it('retains the filesystem transaction until DSH exact readback becomes available', async () => {
    const seeded = await fixture()
    const request = { ...seeded.input, attemptId: `pcm_${'3'.repeat(64)}` }
    seeded.setRegistryAvailable(false)

    await expect(seeded.adapter.publish(request)).resolves.toEqual({ status: 'UNAVAILABLE' })
    expect(await readFile(seeded.target, 'utf8')).toBe(seeded.input.proposal.body.exactSkillBytes)

    seeded.setRegistryAvailable(true)
    await expect(seeded.adapter.recover(request)).resolves.toMatchObject({ status: 'PUBLISHED' })
  })

  it('publishes MERGE only when the exact reviewed base hash still matches', async () => {
    const seeded = await fixture()
    await seeded.adapter.publish({ ...seeded.input, attemptId: `pcm_${'5'.repeat(64)}` })
    const nextBytes = renderCanonicalSkill({
      name: seeded.input.proposal.body.name,
      description: seeded.input.proposal.body.description,
      whenToUse: seeded.input.proposal.body.whenToUse,
      content: '# Fixture v2 updated',
      invocation: { modelInvocable: true, userInvocable: false },
    })
    const mergeLineage = ProposalLineageV2Schema.parse({
      ...seeded.input.lineage,
      proposalRevisions: [{
        ...seeded.input.proposal,
        action: 'MERGE',
        body: {
          ...seeded.input.proposal.body,
          exactSkillBytes: nextBytes,
          skillBytesDigest: sha256Utf8(nextBytes),
        },
        targetIdentityDigest: sha256Utf8(parseCanonicalSkillBody(
          seeded.input.proposal.body.exactSkillBytes,
        )),
        baseSkillBytesDigest: seeded.input.proposal.body.skillBytesDigest,
      }],
    })
    if (mergeLineage.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
    const mergeInput = {
      ...seeded.input,
      lineage: mergeLineage,
      proposal: mergeLineage.proposalRevisions[0]!,
      proposalRef: deriveV2ProposalRef(mergeLineage),
    }

    const request = {
      ...mergeInput,
      attemptId: `pcm_${'6'.repeat(64)}`,
    }
    const published = await seeded.adapter.publish(request)
    expect(published).toMatchObject({ status: 'PUBLISHED' })
    expect(await readFile(seeded.target, 'utf8')).toBe(nextBytes)
    seeded.setRegistryAvailable(false)
    await expect(seeded.adapter.publish(request)).resolves.toEqual({ status: 'UNAVAILABLE' })
    seeded.setRegistryAvailable(true)
    await expect(seeded.adapter.publish(request)).resolves.toEqual(published)
  })

  it('recovers the same MERGE attempt after finalization removed the Base backup and crashed', async () => {
    const seeded = await fixture()
    await seeded.adapter.publish({ ...seeded.input, attemptId: `pcm_${'9'.repeat(64)}` })
    const nextBytes = renderCanonicalSkill({
      name: seeded.input.proposal.body.name,
      description: seeded.input.proposal.body.description,
      whenToUse: seeded.input.proposal.body.whenToUse,
      content: '# Fixture v2 recovered',
      invocation: { modelInvocable: true, userInvocable: false },
    })
    const mergeLineage = ProposalLineageV2Schema.parse({
      ...seeded.input.lineage,
      proposalRevisions: [{
        ...seeded.input.proposal,
        action: 'MERGE',
        body: {
          ...seeded.input.proposal.body,
          exactSkillBytes: nextBytes,
          skillBytesDigest: sha256Utf8(nextBytes),
        },
        targetIdentityDigest: sha256Utf8(parseCanonicalSkillBody(
          seeded.input.proposal.body.exactSkillBytes,
        )),
        baseSkillBytesDigest: seeded.input.proposal.body.skillBytesDigest,
      }],
    })
    if (mergeLineage.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
    const request = {
      ...seeded.input,
      lineage: mergeLineage,
      proposal: mergeLineage.proposalRevisions[0]!,
      proposalRef: deriveV2ProposalRef(mergeLineage),
      attemptId: `pcm_${'a'.repeat(64)}`,
    }
    seeded.setRegistryAvailable(false)
    await expect(seeded.adapter.publish(request)).resolves.toEqual({ status: 'UNAVAILABLE' })

    await expect(finalizeTransaction({
      root: seeded.root,
      txid: `v2-${sha256Utf8(request.attemptId)}`,
      confirmedExactReadback: true,
      hooks: { afterBackupRemoval: async () => { throw new Error('synthetic finalize crash') } },
    })).rejects.toThrow('synthetic finalize crash')

    seeded.setRegistryAvailable(true)
    await expect(seeded.adapter.publish(request)).resolves.toMatchObject({ status: 'PUBLISHED' })
    expect(await readFile(seeded.target, 'utf8')).toBe(nextBytes)
  })

  it('preserves a Base whose frontmatter changed after review', async () => {
    const seeded = await fixture()
    await seeded.adapter.publish({ ...seeded.input, attemptId: `pcm_${'c'.repeat(64)}` })
    const reviewedBase = seeded.input.proposal.body.exactSkillBytes
    const userBytes = reviewedBase.replace('user-invocable: false', 'user-invocable: true')
    expect(parseCanonicalSkillBody(userBytes)).toBe(parseCanonicalSkillBody(reviewedBase))
    await writeFile(seeded.target, userBytes, 'utf8')
    const mergeLineage = ProposalLineageV2Schema.parse({
      ...seeded.input.lineage,
      proposalRevisions: [{
        ...seeded.input.proposal,
        action: 'MERGE',
        targetIdentityDigest: sha256Utf8(parseCanonicalSkillBody(reviewedBase)),
        baseSkillBytesDigest: sha256Utf8(reviewedBase),
      }],
    })
    if (mergeLineage.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')

    await expect(seeded.adapter.publish({
      ...seeded.input,
      lineage: mergeLineage,
      proposal: mergeLineage.proposalRevisions[0]!,
      proposalRef: deriveV2ProposalRef(mergeLineage),
      attemptId: `pcm_${'d'.repeat(64)}`,
    })).resolves.toEqual({ status: 'CONFLICT' })
    expect(await readFile(seeded.target, 'utf8')).toBe(userBytes)
  })

  it('preserves user bytes when a MERGE base has changed', async () => {
    const seeded = await fixture()
    await seeded.adapter.publish({ ...seeded.input, attemptId: `pcm_${'7'.repeat(64)}` })
    const userBytes = `${seeded.input.proposal.body.exactSkillBytes}\nmanual change\n`
    await writeFile(seeded.target, userBytes, 'utf8')
    const mergeLineage = ProposalLineageV2Schema.parse({
      ...seeded.input.lineage,
      proposalRevisions: [{
        ...seeded.input.proposal,
        action: 'MERGE',
        targetIdentityDigest: sha256Utf8(parseCanonicalSkillBody(
          seeded.input.proposal.body.exactSkillBytes,
        )),
        baseSkillBytesDigest: seeded.input.proposal.body.skillBytesDigest,
      }],
    })
    if (mergeLineage.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')

    await expect(seeded.adapter.publish({
      ...seeded.input,
      lineage: mergeLineage,
      proposal: mergeLineage.proposalRevisions[0]!,
      proposalRef: deriveV2ProposalRef(mergeLineage),
      attemptId: `pcm_${'8'.repeat(64)}`,
    })).resolves.toEqual({ status: 'CONFLICT' })
    expect(await readFile(seeded.target, 'utf8')).toBe(userBytes)
  })

  it('fails closed before touching the filesystem when the binding is stale', async () => {
    const seeded = await fixture()
    const adapter = new DshV2ProposalFileSystemAdapter({
      bindings: { resolve: async () => ({ status: 'STALE' as const }) },
      registry: { snapshot: async () => { throw new Error('must not read') }, get: async () => undefined },
      readbackAttempts: 1,
    })

    await expect(adapter.publish({
      ...seeded.input,
      attemptId: `pcm_${'4'.repeat(64)}`,
    })).resolves.toEqual({ status: 'STALE' })
    await expect(readFile(seeded.target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not write when the approved root is replaced during parity revalidation', async () => {
    const seeded = await fixture()
    const movedRoot = `${seeded.root}-approved`
    let calls = 0
    const adapter = new DshV2ProposalFileSystemAdapter({
      bindings: {
        resolve: async () => {
          calls += 1
          if (calls === 2) {
            await rename(seeded.root, movedRoot)
            await mkdir(seeded.root)
          }
          const observed = await observePublicationRoot(seeded.root)
          if (observed.status !== 'EXISTING') return { status: 'UNAVAILABLE' as const }
          return {
            status: 'READY' as const,
            rootBinding: RootBindingV2Schema.parse({
              ...seeded.rootBinding,
              canonicalRootPath: observed.canonicalRootPath,
              rootIdentityDigest: observed.rootIdentityDigest,
            }),
            view: {},
          }
        },
      },
      registry: {
        snapshot: async () => { throw new Error('must not read Runtime after parity failure') },
        get: async () => undefined,
      },
      readbackAttempts: 1,
    })

    await expect(adapter.publish({
      ...seeded.input,
      attemptId: `pcm_${'f'.repeat(64)}`,
    })).resolves.toEqual({ status: 'UNAVAILABLE' })
    await expect(readFile(seeded.target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
