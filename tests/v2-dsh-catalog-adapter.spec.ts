import { describe, expect, it } from 'vitest'
import { DshV2CatalogAdapter } from '../src/adapters/dsh-skills/v2-catalog-adapter.js'
import { GlobalV2Schema, SessionBatchV2Schema } from '../src/domain/v2/index.js'
import { canonicalJson } from '../src/domain/learn/identity.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

async function seed() {
  const domain = createMemoryRun2skillV2Domain()
  const fixture = createMinimalV2Fixtures()
  await domain.global.set(GlobalV2Schema.parse({
    ...domain.global.get(),
    migration: {
      schemaVersion: 1,
      phase: 'COMMITTED',
      source: { domainName: 'run2skill_v1', domainVersion: 2, globalSchemaVersion: 1 },
      sourceFingerprint: 'a'.repeat(64),
      counts: { workItems: 0, lineages: 0, activeLegacyProposals: 0 },
      startedAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
      committedAt: '2026-08-22T00:00:00.000Z',
      activationFenceDigest: 'b'.repeat(64),
    },
    activation: {
      committedAt: '2026-08-22T00:00:00.000Z',
      sourceFingerprint: 'a'.repeat(64),
      observerStartWatermarks: {},
      observerStartWatermarkDigest: sha256Utf8(canonicalJson({})),
      legacyPendingCatalogDigest: sha256Utf8(canonicalJson([])),
      legacyPendingCandidateCount: 0,
    },
  }))
  await domain.table('turn_observations').put(fixture.turnObservation.observationId, fixture.turnObservation)
  await domain.table('experience_intents').put(fixture.experienceIntent.intentId, fixture.experienceIntent)
  return { domain, fixture, sessionBatch: SessionBatchV2Schema.parse(fixture.sessionBatch) }
}

const runtimeSkill = {
  name: 'existing-workflow',
  description: 'An existing workflow.',
  whenToUse: 'Use for an existing workflow.',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: 'filesystem',
  source: 'project-dsh',
  resourceBase: { kind: 'directory' as const, path: 'D:\\repo\\.dsh\\skills\\existing-workflow' },
}

describe('DSH v2 Runtime and Pending Catalog adapter', () => {
  it('uses one exact DSH view and projects the same stable Catalog into both ports', async () => {
    const { domain, fixture, sessionBatch } = await seed()
    const view = { cwd: 'D:\\repo', scope: { id: 'agent' }, signal: new AbortController().signal }
    const seenViews: unknown[] = []
    const adapter = new DshV2CatalogAdapter(domain, {
      registry: {
        snapshot: async input => {
          seenViews.push(input)
          return { complete: true, skills: [runtimeSkill] }
        },
        get: async (_name, input) => {
          seenViews.push(input)
          return { ...runtimeSkill, path: `${runtimeSkill.resourceBase.path}\\SKILL.md`, content: '# Existing workflow' }
        },
      },
      resolveView: lifecycleKey => lifecycleKey === fixture.experienceIntent.sessionLifecycleKey ? view : undefined,
      resolveStockWritableRoot: summary => summary.source === 'project-dsh'
        ? {
            scope: 'PROJECT',
            expectedProvider: 'filesystem',
            expectedSource: 'project-dsh',
            canonicalRootPath: 'D:\\repo\\.dsh\\skills',
          }
        : undefined,
    })

    const recall = await adapter.recall.snapshot({ batch: sessionBatch, intent: fixture.experienceIntent })
    const generation = await adapter.generation.snapshot({ batch: sessionBatch, intent: fixture.experienceIntent })
    expect(recall.complete).toBe(true)
    expect(recall.summaries).toHaveLength(1)
    expect(recall.summaries[0]).toMatchObject({ scope: 'PROJECT', writable: true })
    expect(JSON.stringify(recall.summaries)).not.toContain('D:\\repo')
    expect(generation).toMatchObject({
      complete: true,
      runtimeCatalogDigest: recall.runtimeCatalogDigest,
      pendingCatalogDigest: recall.pendingCatalogDigest,
      externalPendingDigest: recall.pendingCatalogDigest,
      catalogEpoch: recall.catalogEpoch,
      catalogMutationReceiptDigest: recall.catalogMutationReceiptDigest,
    })
    const loaded = await adapter.recall.read({
      candidateId: recall.summaries[0]!.candidateId,
      batch: sessionBatch,
      intent: fixture.experienceIntent,
    })
    expect(loaded?.content).toBe('# Existing workflow')
    expect(seenViews.every(item => item === view)).toBe(true)
  })

  it('keeps every public DSH winner readable while granting writes only to canonical DSH bundles', async () => {
    const { domain, fixture, sessionBatch } = await seed()
    const view = { cwd: 'D:\\repo', scope: { id: 'agent' }, signal: new AbortController().signal }
    const winners = [
      {
        ...runtimeSkill,
        name: 'flat-workflow',
        description: 'A flat Markdown workflow.',
        resourceBase: { kind: 'directory' as const, path: 'D:\\repo\\.dsh\\skills' },
      },
      {
        ...runtimeSkill,
        name: 'skills',
        description: 'A flat Skill whose name matches the root basename.',
        resourceBase: { kind: 'directory' as const, path: 'D:\\repo\\.dsh\\skills' },
      },
      {
        ...runtimeSkill,
        name: 'renamed-workflow',
        description: 'A directory bundle whose folder differs from its declared name.',
        resourceBase: { kind: 'directory' as const, path: 'D:\\repo\\.dsh\\skills\\legacy-folder' },
      },
      {
        ...runtimeSkill,
        name: 'windows-case',
        description: 'A Windows bundle with a case-only folder difference.',
        resourceBase: { kind: 'directory' as const, path: 'D:\\repo\\.dsh\\skills\\WINDOWS-CASE' },
      },
      {
        ...runtimeSkill,
        name: 'posix-case',
        description: 'A POSIX bundle with a case-only folder difference.',
        resourceBase: { kind: 'directory' as const, path: '/repo/.dsh/skills/POSIX-CASE' },
      },
      {
        name: 'runtime-workflow',
        description: 'A borrowed runtime workflow.',
        provider: 'runtime',
        source: 'runtime',
      },
      {
        name: 'bundled-workflow',
        description: 'A bundled provider workflow.',
        provider: 'plugin-bundle',
        source: 'bundled',
        resourceBase: { kind: 'opaque' as const, description: 'plugin-owned resources' },
      },
    ]
    const adapter = new DshV2CatalogAdapter(domain, {
      registry: {
        snapshot: async () => ({ complete: true, skills: winners }),
        get: async name => {
          const winner = winners.find(item => item.name === name)
          return winner === undefined ? undefined : { ...winner, content: `# ${name}` }
        },
      },
      resolveView: () => view,
      resolveStockWritableRoot: summary => summary.source === 'project-dsh'
        ? {
            scope: 'PROJECT',
            expectedProvider: 'filesystem',
            expectedSource: 'project-dsh',
            canonicalRootPath: summary.resourceBase?.kind === 'directory'
              && summary.resourceBase.path.startsWith('/')
              ? '/repo/.dsh/skills'
              : 'D:\\repo\\.dsh\\skills',
          }
        : undefined,
    })

    const snapshot = await adapter.recall.snapshot({ batch: sessionBatch, intent: fixture.experienceIntent })
    expect(snapshot.complete).toBe(true)
    expect(snapshot.summaries.map(item => [item.name, item.scope, item.writable]).sort()).toEqual([
      ['bundled-workflow', 'USER', false],
      ['flat-workflow', 'PROJECT', false],
      ['posix-case', 'PROJECT', false],
      ['renamed-workflow', 'PROJECT', false],
      ['runtime-workflow', 'PROJECT', false],
      ['skills', 'PROJECT', false],
      ['windows-case', 'PROJECT', true],
    ])
    expect(JSON.stringify(snapshot.summaries)).not.toContain('D:\\repo')
    for (const summary of snapshot.summaries) {
      await expect(adapter.recall.read({
        candidateId: summary.candidateId,
        batch: sessionBatch,
        intent: fixture.experienceIntent,
      })).resolves.toMatchObject({ content: `# ${summary.name}` })
    }
  })

  it('fails a read when a public winner changes provider resource identity between snapshot and get', async () => {
    const { domain, fixture, sessionBatch } = await seed()
    const view = { cwd: 'D:\\repo', scope: {}, signal: new AbortController().signal }
    const bundled = {
      name: 'bundled-workflow',
      description: 'A bundled provider workflow.',
      provider: 'plugin-bundle',
      source: 'bundled',
      resourceBase: { kind: 'url' as const, url: 'https://example.invalid/v1/' },
    }
    const adapter = new DshV2CatalogAdapter(domain, {
      registry: {
        snapshot: async () => ({ complete: true, skills: [bundled] }),
        get: async () => ({
          ...bundled,
          resourceBase: { kind: 'url' as const, url: 'https://example.invalid/v2/' },
          content: '# Drifted bundle',
        }),
      },
      resolveView: () => view,
    })
    const snapshot = await adapter.recall.snapshot({ batch: sessionBatch, intent: fixture.experienceIntent })
    expect(snapshot.complete).toBe(true)
    await expect(adapter.recall.read({
      candidateId: snapshot.summaries[0]!.candidateId,
      batch: sessionBatch,
      intent: fixture.experienceIntent,
    })).resolves.toBeUndefined()
  })

  it('keeps the full Pending digest while exactly excluding its own sealed result externally', async () => {
    const { domain, fixture, sessionBatch } = await seed()
    await domain.table('experience_intents').put(fixture.staleAttentionIntent.intentId, fixture.staleAttentionIntent)
    const adapter = new DshV2CatalogAdapter(domain, {
      registry: {
        snapshot: async () => ({ complete: true, skills: [] }),
        get: async () => undefined,
      },
      resolveView: () => ({ cwd: 'D:\\repo', scope: {}, signal: new AbortController().signal }),
    })
    const result = fixture.staleAttentionIntent.generation.sealedResult!
    const full = await adapter.generation.snapshot({ batch: sessionBatch, intent: fixture.staleAttentionIntent })
    const excluded = await adapter.generation.snapshot({
      batch: sessionBatch,
      intent: fixture.staleAttentionIntent,
      exclude: { kind: 'GENERATION_RESULT', resultId: result.resultId, receiptDigest: result.receiptDigest },
    })
    const wrongReceipt = await adapter.generation.snapshot({
      batch: sessionBatch,
      intent: fixture.staleAttentionIntent,
      exclude: { kind: 'GENERATION_RESULT', resultId: result.resultId, receiptDigest: 'f'.repeat(64) },
    })
    expect(excluded.pendingCatalogDigest).toBe(full.pendingCatalogDigest)
    expect(excluded.externalPendingDigest).not.toBe(full.pendingCatalogDigest)
    expect(wrongReceipt.externalPendingDigest).toBe(full.pendingCatalogDigest)
  })

  it('omits only the exact stale-refresh barrier from summaries without weakening the full digest', async () => {
    const { domain, fixture, sessionBatch } = await seed()
    await domain.table('experience_intents').put(fixture.staleRefreshIntent.intentId, fixture.staleRefreshIntent)
    const adapter = new DshV2CatalogAdapter(domain, {
      registry: { snapshot: async () => ({ complete: true, skills: [] }), get: async () => undefined },
      resolveView: () => ({ cwd: 'D:\\repo', scope: {}, signal: new AbortController().signal }),
    })
    const recall = await adapter.recall.snapshot({ batch: sessionBatch, intent: fixture.staleRefreshIntent })
    expect(recall.complete).toBe(true)
    expect(recall.summaries).toHaveLength(0)
    expect(recall.pendingCatalogDigest).not.toBe(sha256Utf8(canonicalJson([])))
  })

  it('fails closed on incomplete DSH discovery, invalid custom identity, or winner drift during get', async () => {
    const { domain, fixture, sessionBatch } = await seed()
    const view = { cwd: 'D:\\repo', scope: {}, signal: new AbortController().signal }
    const incomplete = new DshV2CatalogAdapter(domain, {
      registry: { snapshot: async () => ({ complete: false, skills: [] }), get: async () => undefined },
      resolveView: () => view,
    })
    expect((await incomplete.recall.snapshot({ batch: sessionBatch, intent: fixture.experienceIntent })).complete)
      .toBe(false)

    const invalidCustomIdentity = new DshV2CatalogAdapter(domain, {
      registry: {
        snapshot: async () => ({
          complete: true,
          skills: [{ ...runtimeSkill, provider: 'third-party', source: 'unknown', resourceBase: { kind: 'opaque', description: 'secret' } }],
        }),
        get: async () => undefined,
      },
      resolveView: () => view,
      resolveRuntimeIdentity: () => ({ scope: 'PROJECT', writable: false, rootIdentityDigest: 'invalid' }),
    })
    expect((await invalidCustomIdentity.recall.snapshot({ batch: sessionBatch, intent: fixture.experienceIntent })).complete)
      .toBe(false)

    let drifted = false
    const drifting = new DshV2CatalogAdapter(domain, {
      registry: {
        snapshot: async () => ({
          complete: true,
          skills: [{ ...runtimeSkill, description: drifted ? 'Changed.' : runtimeSkill.description }],
        }),
        get: async () => {
          drifted = true
          return { ...runtimeSkill, content: '# Changed during read' }
        },
      },
      resolveView: () => view,
    })
    const snapshot = await drifting.recall.snapshot({ batch: sessionBatch, intent: fixture.experienceIntent })
    expect(snapshot.complete).toBe(true)
    await expect(drifting.recall.read({
      candidateId: snapshot.summaries[0]!.candidateId,
      batch: sessionBatch,
      intent: fixture.experienceIntent,
    })).resolves.toBeUndefined()
  })
})
