import { describe, expect, it } from 'vitest'
import { DshV2ProposalFileSystemAdapter } from '../src/adapters/dsh-publication/v2-proposal-filesystem.js'
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
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

function normalize(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/{2,}/gu, '/').replace(/\/$/u, '')
}

function contextFixture() {
  const root = '/workspace/.dsh/skills'
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
    canonicalRootPath: root,
    rootIdentityDigest: sha256Utf8('ctxfs://root'),
  })
  const files = new Map<string, { type: 'file' | 'directory'; version: string; content?: string }>([
    [root, { type: 'directory', version: 'root-v1' }],
  ])
  const targetFor = (path: string) => {
    const displayPath = normalize(path)
    return { targetKey: `ctxfs://${displayPath}`, displayPath }
  }
  let nextVersion = 1
  const writes: Array<{ expected: unknown; policy: unknown }> = []
  const filesystem = {
    sandboxMode: 'workspace-write' as const,
    resolve: async (path: string, options?: { cwd?: string }) => targetFor(
      path.startsWith('/') ? path : `${options?.cwd ?? '/workspace'}/${path}`,
    ),
    processPath: (target: { displayPath: string }) => target.displayPath,
    contains: (parent: { displayPath: string }, child: { displayPath: string }) => {
      const base = normalize(parent.displayPath)
      const value = normalize(child.displayPath)
      return value === base || value.startsWith(`${base}/`)
    },
    lstat: async (path: string, options?: { cwd?: string }) => {
      const target = await filesystem.resolve(path, options)
      const entry = files.get(target.displayPath)
      return entry === undefined ? undefined : { version: entry.version, type: entry.type }
    },
    stat: async (target: { displayPath: string }) => {
      const entry = files.get(normalize(target.displayPath))
      return entry === undefined
        ? undefined
        : {
            version: entry.version,
            type: entry.type,
            ...(entry.type === 'file' ? { size: Buffer.byteLength(entry.content ?? '') } : {}),
          }
    },
    readBytes: async (target: { displayPath: string }, _signal: AbortSignal | undefined, maxBytes: number) => {
      const entry = files.get(normalize(target.displayPath))
      if (entry?.type !== 'file') throw Object.assign(new Error('missing'), { code: 'FS_NOT_FOUND' })
      const bytes = Buffer.from(entry.content ?? '')
      if (bytes.byteLength > maxBytes) throw Object.assign(new Error('too large'), { code: 'FS_TOO_LARGE' })
      return bytes
    },
    listDir: async (target: { displayPath: string }) => {
      const base = `${normalize(target.displayPath)}/`
      return [...files.entries()].flatMap(([path, entry]) => {
        if (!path.startsWith(base)) return []
        const rest = path.slice(base.length)
        if (rest.length === 0 || rest.includes('/')) return []
        return [{
          name: rest,
          type: entry.type,
          target: targetFor(path),
          version: entry.version,
          ...(entry.type === 'file' ? { size: Buffer.byteLength(entry.content ?? '') } : {}),
        }]
      })
    },
    writeText: async (
      target: { displayPath: string },
      content: string,
      expected: { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: string } | undefined,
      _signal: AbortSignal | undefined,
      policy: unknown,
    ) => {
      const path = normalize(target.displayPath)
      const before = files.get(path)
      if (expected?.kind === 'createIfAbsent' && before !== undefined) {
        throw Object.assign(new Error('already exists'), { code: 'FS_NOT_OBSERVED' })
      }
      if (expected?.kind === 'replaceIfVersion' && before?.version !== expected.version) {
        throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' })
      }
      const parent = path.slice(0, path.lastIndexOf('/'))
      files.set(parent, { type: 'directory', version: `dir-v${++nextVersion}` })
      const version = `file-v${++nextVersion}`
      files.set(path, { type: 'file', version, content })
      writes.push({ expected, policy })
      return { operation: before === undefined ? 'create' as const : 'update' as const, version, before: before?.content ?? null, after: content }
    },
  }
  const rootTarget = targetFor(root)
  const target = normalize(`${root}/${proposal.body.name}/SKILL.md`)
  let runtimeVisible = true
  const registry = {
    snapshot: async () => runtimeVisible && files.has(target)
      ? {
          complete: true,
          skills: [{
            name: proposal.body.name,
            description: proposal.body.description,
            whenToUse: proposal.body.whenToUse,
            provider: 'filesystem',
            source: 'project-dsh',
            path: target,
            invocation: { modelInvocable: true, userInvocable: false },
          }],
        }
      : { complete: true, skills: [] },
    get: async () => runtimeVisible && files.has(target)
      ? {
          name: proposal.body.name,
          description: proposal.body.description,
          whenToUse: proposal.body.whenToUse,
          provider: 'filesystem',
          source: 'project-dsh',
          path: target,
          invocation: { modelInvocable: true, userInvocable: false },
          content: '# Fixture v2',
        }
      : undefined,
  }
  const view = { signal: new AbortController().signal }
  const adapter = new DshV2ProposalFileSystemAdapter({
    bindings: {
      resolve: async () => ({
        status: 'READY' as const,
        rootBinding,
        view,
        filesystem,
        rootTarget,
        publicationPolicy: {
          mode: 'workspace-write' as const,
          workspaceRoot: root,
          sessionId: 'session-v2',
        },
      }),
    },
    registry,
    readbackAttempts: 1,
  })
  return {
    adapter, input, files, writes, target, root,
    setRuntimeVisible(value: boolean) { runtimeVisible = value },
  }
}

describe('v2 context-filesystem Proposal publication', () => {
  it('recovers absence without writing and publishes with DSH file-level CAS', async () => {
    const seeded = contextFixture()
    const request = { ...seeded.input, attemptId: `pcm_${'1'.repeat(64)}` }

    await expect(seeded.adapter.recover(request)).resolves.toEqual({ status: 'ABSENT' })
    expect(seeded.writes).toHaveLength(0)

    const first = await seeded.adapter.publish(request)
    expect(first).toMatchObject({ status: 'PUBLISHED' })
    expect(seeded.files.get(seeded.target)?.content).toBe(seeded.input.proposal.body.exactSkillBytes)
    expect(seeded.writes).toEqual([{
      expected: { kind: 'createIfAbsent' },
      policy: { mode: 'workspace-write', workspaceRoot: seeded.root, sessionId: 'session-v2' },
    }])

    await expect(seeded.adapter.publish(request)).resolves.toEqual(first)
    expect(seeded.writes).toHaveLength(1)
  })

  it('keeps an exact written attempt unavailable until the DSH runtime Catalog catches up', async () => {
    const seeded = contextFixture()
    const request = { ...seeded.input, attemptId: `pcm_${'3'.repeat(64)}` }

    seeded.setRuntimeVisible(false)
    await expect(seeded.adapter.publish(request)).resolves.toEqual({ status: 'UNAVAILABLE' })
    expect(seeded.files.get(seeded.target)?.content).toBe(seeded.input.proposal.body.exactSkillBytes)
    expect(seeded.writes).toHaveLength(1)

    await expect(seeded.adapter.recover(request)).resolves.toEqual({ status: 'UNAVAILABLE' })
    expect(seeded.writes).toHaveLength(1)

    seeded.setRuntimeVisible(true)
    await expect(seeded.adapter.recover(request)).resolves.toMatchObject({ status: 'PUBLISHED' })
    expect(seeded.writes).toHaveLength(1)
  })

  it('publishes a MERGE only with the exact DSH version observed for its Base', async () => {
    const seeded = contextFixture()
    const baseSkillBytes = renderCanonicalSkill({
      name: seeded.input.proposal.body.name,
      description: 'The reviewed Base.',
      whenToUse: 'Use for the reviewed Base.',
      content: '# Reviewed Base',
      invocation: { modelInvocable: true, userInvocable: false },
    })
    seeded.files.set(seeded.target.slice(0, seeded.target.lastIndexOf('/')), {
      type: 'directory', version: 'bundle-base-v1',
    })
    seeded.files.set(seeded.target, { type: 'file', version: 'file-base-v1', content: baseSkillBytes })
    const lineage = ProposalLineageV2Schema.parse({
      ...seeded.input.lineage,
      proposalRevisions: [{
        ...seeded.input.proposal,
        action: 'MERGE',
        targetIdentityDigest: sha256Utf8(parseCanonicalSkillBody(baseSkillBytes)),
        baseSkillBytes,
        baseSkillBytesDigest: sha256Utf8(baseSkillBytes),
      }],
    })
    if (lineage.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
    const proposal = lineage.proposalRevisions.at(-1)!
    const request = {
      ...seeded.input,
      lineage,
      proposal,
      proposalRef: deriveV2ProposalRef(lineage),
      attemptId: `pcm_${'2'.repeat(64)}`,
    }

    await expect(seeded.adapter.publish(request)).resolves.toMatchObject({ status: 'PUBLISHED' })
    expect(seeded.writes).toEqual([{
      expected: { kind: 'replaceIfVersion', version: 'file-base-v1' },
      policy: { mode: 'workspace-write', workspaceRoot: seeded.root, sessionId: 'session-v2' },
    }])
  })
})
