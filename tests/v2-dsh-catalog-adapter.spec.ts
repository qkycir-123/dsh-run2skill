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

function rawSkill(body: string, name = runtimeSkill.name): string {
  return ['---', `name: ${name}`, 'description: A bounded fixture Skill.', '---', '', body, ''].join('\n')
}

function openText(value: string): () => AsyncIterable<Uint8Array> {
  return async function* () { yield Buffer.from(value, 'utf8') }
}

function openBundleText(value: string): (path: string) => AsyncIterable<Uint8Array> {
  return path => {
    if (/(?:^|[\\/])skill\.md$/iu.test(path)) return openText(value)()
    throw Object.assign(new Error('not found'), { code: 'ENOENT' })
  }
}

async function* openBundleDirectory() {
  yield { name: 'SKILL.md', kind: 'file' as const }
}

describe('DSH v2 Runtime and Pending Catalog adapter', () => {
  it('exposes one stable Runtime-only manifest for the pre-Turn ownership baseline', async () => {
    const { domain, fixture } = await seed()
    let calls = 0
    const view = { cwd: 'D:\\repo', scope: {}, signal: new AbortController().signal }
    const adapter = new DshV2CatalogAdapter(domain, {
      registry: {
        snapshot: async input => {
          expect(input).toBe(view)
          calls += 1
          return { complete: true, skills: [runtimeSkill] }
        },
        get: async () => undefined,
      },
      resolveView: key => key === fixture.experienceIntent.sessionLifecycleKey ? view : undefined,
    })

    const observed = await adapter.observeRuntimeCatalog(fixture.experienceIntent.sessionLifecycleKey)
    expect(observed).toMatchObject({ complete: true })
    expect(observed.runtimeCatalogDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(calls).toBe(2)
    await expect(adapter.observeRuntimeCatalog('sl_missing')).resolves.toMatchObject({ complete: false })
  })

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
      internalOpenOwnershipFile: openBundleText(rawSkill('# Existing workflow')),
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

  it('captures stable exact bodies and path-free target identities for ownership baselines', async () => {
    const { domain, fixture } = await seed()
    const view = { cwd: 'D:\\repo', scope: { id: 'agent' }, signal: new AbortController().signal }
    const exactSkillBody = [
      '# Existing workflow', '', 'x'.repeat(16 * 1024),
    ].join('\n')
    expect(Buffer.byteLength(exactSkillBody, 'utf8')).toBeGreaterThan(8 * 1024)
    const adapter = new DshV2CatalogAdapter(domain, {
      registry: {
        snapshot: async () => ({ complete: true, skills: [runtimeSkill] }),
        get: async () => { throw new Error('ownership capture must not call registry.get') },
      },
      resolveView: () => view,
      internalOpenOwnershipFile: openBundleText(rawSkill(exactSkillBody)),
      internalOpenOwnershipDirectory: openBundleDirectory,
      resolveStockWritableRoot: () => ({
        scope: 'PROJECT', expectedProvider: 'filesystem', expectedSource: 'project-dsh',
        canonicalRootPath: 'D:\\repo\\.dsh\\skills',
      }),
    })

    const observed = await adapter.observeOwnershipCatalog(fixture.experienceIntent.sessionLifecycleKey)
    expect(observed.complete).toBe(true)
    expect(observed.candidates).toHaveLength(1)
    expect(observed.candidates[0]).toMatchObject({
      name: runtimeSkill.name,
      provider: 'filesystem', source: 'project-dsh', scope: 'PROJECT', writable: true,
      bodyDigest: sha256Utf8(exactSkillBody),
    })
    expect(observed.candidates[0]?.targetPathDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(JSON.stringify(observed)).not.toContain('D:\\repo')
  })

  it('resolves a renamed flat filesystem winner through bounded layout discovery', async () => {
    const { domain, fixture } = await seed()
    const flat = {
      ...runtimeSkill,
      name: 'flat-workflow',
      resourceBase: { kind: 'directory' as const, path: 'D:\\repo\\.dsh\\skills' },
    }
    const opened: string[] = []
    const adapter = new DshV2CatalogAdapter(domain, {
      registry: {
        snapshot: async () => ({ complete: true, skills: [flat] }),
        get: async () => { throw new Error('ownership capture must not call registry.get') },
      },
      resolveView: () => ({ cwd: 'D:\\repo' }),
      internalOpenOwnershipFile: path => {
        opened.push(path)
        if (path.toLowerCase().endsWith('legacy-filename.md')) {
          return openText(rawSkill('# Flat workflow', flat.name))()
        }
        throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      },
      internalOpenOwnershipDirectory: async function* () {
        yield { name: 'legacy-filename.md', kind: 'file' }
      },
    })

    const observed = await adapter.observeOwnershipCatalog(fixture.experienceIntent.sessionLifecycleKey)
    expect(observed).toMatchObject({
      complete: true,
      candidates: [{ name: flat.name, bodyDigest: sha256Utf8('# Flat workflow') }],
    })
    expect(opened.some(path => path.toLowerCase().endsWith('legacy-filename.md'))).toBe(true)
  })

  it('fails closed when SKILL.md and a flat file declare the same path-free Skill name', async () => {
    const { domain, fixture } = await seed()
    const flat = {
      ...runtimeSkill,
      name: 'duplicate-workflow',
      resourceBase: { kind: 'directory' as const, path: 'D:\\repo\\.dsh\\skills' },
    }
    const adapter = new DshV2CatalogAdapter(domain, {
      registry: {
        snapshot: async () => ({ complete: true, skills: [flat] }),
        get: async () => { throw new Error('ownership capture must not call registry.get') },
      },
      resolveView: () => ({ cwd: 'D:\\repo' }),
      internalOpenOwnershipFile: path => {
        if (path.toLowerCase().endsWith('skill.md')) {
          return openText(rawSkill('# Shadowed bundle body', flat.name))()
        }
        if (path.toLowerCase().endsWith('legacy.md')) {
          return openText(rawSkill('# Runtime winner body', flat.name))()
        }
        throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      },
      internalOpenOwnershipDirectory: async function* () {
        yield { name: 'legacy.md', kind: 'file' }
        yield { name: 'SKILL.md', kind: 'file' }
      },
    })

    await expect(adapter.observeOwnershipCatalog(fixture.experienceIntent.sessionLifecycleKey))
      .resolves.toMatchObject({ complete: false, candidates: [] })
  })

  it('scans one shared flat resource base only once per stability pass', async () => {
    const { domain, fixture } = await seed()
    const root = 'D:\\repo\\.dsh\\skills'
    const flatSkills = ['first-workflow', 'second-workflow'].map(name => ({
      ...runtimeSkill, name, resourceBase: { kind: 'directory' as const, path: root },
    }))
    let directoryReads = 0
    const adapter = new DshV2CatalogAdapter(domain, {
      registry: {
        snapshot: async () => ({ complete: true, skills: flatSkills }),
        get: async () => { throw new Error('ownership capture must not call registry.get') },
      },
      resolveView: () => ({ cwd: 'D:\\repo' }),
      internalOpenOwnershipFile: path => {
        const name = path.toLowerCase().endsWith('legacy-first.md')
          ? 'first-workflow'
          : path.toLowerCase().endsWith('legacy-second.md')
            ? 'second-workflow'
            : undefined
        if (name !== undefined) return openText(rawSkill(`# ${name}`, name))()
        throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      },
      internalOpenOwnershipDirectory: async function* () {
        directoryReads += 1
        yield { name: 'legacy-first.md', kind: 'file' }
        yield { name: 'legacy-second.md', kind: 'file' }
      },
    })

    await expect(adapter.observeOwnershipCatalog(fixture.experienceIntent.sessionLifecycleKey))
      .resolves.toMatchObject({ complete: true, candidates: [{}, {}] })
    expect(directoryReads).toBe(2)
  })

  it('fails closed when an exact candidate body changes during ownership capture', async () => {
    const { domain, fixture } = await seed()
    let reads = 0
    const adapter = new DshV2CatalogAdapter(domain, {
      registry: {
        snapshot: async () => ({ complete: true, skills: [runtimeSkill] }),
        get: async () => { throw new Error('ownership capture must not call registry.get') },
      },
      resolveView: () => ({ cwd: 'D:\\repo' }),
      internalOpenOwnershipFile: () => openText(rawSkill(reads++ === 0 ? '# First body' : '# Changed body'))(),
      internalOpenOwnershipDirectory: openBundleDirectory,
    })

    await expect(adapter.observeOwnershipCatalog(fixture.experienceIntent.sessionLifecycleKey)).resolves.toEqual({
      complete: false,
      runtimeCatalogDigest: sha256Utf8(canonicalJson([])),
      candidates: [],
    })
  })

  it('fails closed when bounded file frontmatter cannot prove the discovered Skill name', async () => {
    const { domain, fixture } = await seed()
    const ambiguous = [
      '---', `name: ${runtimeSkill.name}`, 'name: "different-workflow"',
      'description: Ambiguous fixture.', '---', '', '# Body', '',
    ].join('\n')
    const adapter = new DshV2CatalogAdapter(domain, {
      registry: {
        snapshot: async () => ({ complete: true, skills: [runtimeSkill] }),
        get: async () => { throw new Error('ownership capture must not call registry.get') },
      },
      resolveView: () => ({ cwd: 'D:\\repo' }),
      internalOpenOwnershipFile: openText(ambiguous),
      internalOpenOwnershipDirectory: openBundleDirectory,
    })

    await expect(adapter.observeOwnershipCatalog(fixture.experienceIntent.sessionLifecycleKey))
      .resolves.toMatchObject({ complete: false, candidates: [] })
  })

  it('accepts one simple quoted DSH Skill name during bounded ownership parsing', async () => {
    const { domain, fixture } = await seed()
    const quoted = rawSkill('# Quoted name').replace(
      `name: ${runtimeSkill.name}`,
      `name: "${runtimeSkill.name}"`,
    )
    const adapter = new DshV2CatalogAdapter(domain, {
      registry: {
        snapshot: async () => ({ complete: true, skills: [runtimeSkill] }),
        get: async () => { throw new Error('ownership capture must not call registry.get') },
      },
      resolveView: () => ({ cwd: 'D:\\repo' }),
      internalOpenOwnershipFile: openBundleText(quoted),
      internalOpenOwnershipDirectory: openBundleDirectory,
    })

    await expect(adapter.observeOwnershipCatalog(fixture.experienceIntent.sessionLifecycleKey))
      .resolves.toMatchObject({ complete: true, candidates: [{ bodyDigest: sha256Utf8('# Quoted name') }] })
  })

  it('does not load bodies from non-filesystem providers during ownership capture', async () => {
    const { domain, fixture } = await seed()
    const borrowed = {
      name: 'borrowed-workflow', description: 'A runtime-provided workflow.',
      provider: 'runtime', source: 'runtime',
    }
    let getCalls = 0
    const adapter = new DshV2CatalogAdapter(domain, {
      registry: {
        snapshot: async () => ({ complete: true, skills: [borrowed] }),
        get: async () => { getCalls += 1; throw new Error('ownership capture must not call registry.get') },
      },
      resolveView: () => ({ cwd: 'D:\\repo' }),
    })

    await expect(adapter.observeOwnershipCatalog(fixture.experienceIntent.sessionLifecycleKey))
      .resolves.toMatchObject({ complete: true, candidates: [] })
    expect(getCalls).toBe(0)
  })

  it('redacts non-canonical provider and source labels before persisting an ownership baseline', async () => {
    const { domain, fixture } = await seed()
    const sensitive = {
      ...runtimeSkill,
      source: 'D:\\client\\skill-source',
    }
    const adapter = new DshV2CatalogAdapter(domain, {
      registry: {
        snapshot: async () => ({ complete: true, skills: [sensitive] }),
        get: async () => { throw new Error('ownership capture must not call registry.get') },
      },
      resolveView: () => ({ cwd: 'D:\\repo' }),
      internalOpenOwnershipFile: openBundleText(rawSkill('# Third-party Skill')),
      internalOpenOwnershipDirectory: openBundleDirectory,
    })

    const observed = await adapter.observeOwnershipCatalog(fixture.experienceIntent.sessionLifecycleKey)
    expect(observed.complete).toBe(true)
    expect(observed.candidates[0]).toMatchObject({
      provider: 'filesystem',
      source: expect.stringMatching(/^opaque-source-[a-f0-9]{64}$/u),
    })
    expect(JSON.stringify(observed)).not.toContain('D:\\client')
  })

  it('fails closed when ownership body reads exceed the bounded candidate or total budget', async () => {
    const { domain, fixture } = await seed()
    let getCalls = 0
    const makeAdapter = (content: string, maxBodyBytes: number, maxTotalBytes: number) => new DshV2CatalogAdapter(domain, {
      registry: {
        snapshot: async () => ({ complete: true, skills: [runtimeSkill] }),
        get: async () => { getCalls += 1; throw new Error('ownership capture must not call registry.get') },
      },
      resolveView: () => ({ cwd: 'D:\\repo' }),
      internalOpenOwnershipFile: openText(rawSkill(content)),
      internalOwnershipPolicy: { maxBodyBytes, maxTotalBytes },
    })

    await expect(makeAdapter('x'.repeat(1_025), 1_024, 10_000)
      .observeOwnershipCatalog(fixture.experienceIntent.sessionLifecycleKey))
      .resolves.toMatchObject({ complete: false, candidates: [] })
    await expect(makeAdapter('x'.repeat(600), 1_024, 1_200)
      .observeOwnershipCatalog(fixture.experienceIntent.sessionLifecycleKey))
      .resolves.toMatchObject({ complete: false, candidates: [] })
    expect(getCalls).toBe(0)
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
      internalOpenOwnershipFile: path => openBundleText(rawSkill(
        `# ${path.toLowerCase().includes('windows-case') ? 'windows-case' : 'unknown'}`,
        path.toLowerCase().includes('windows-case') ? 'windows-case' : 'unknown',
      ))(path),
      internalOpenOwnershipDirectory: openBundleDirectory,
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
