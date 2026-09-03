import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime, {
  BlockAssembler,
  createMessage,
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import SessionStore, { foldRequestHeader, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import {
  RestrictedLearningClient,
  type LearningCallLedger,
} from '../src/adapters/dsh-llm/restricted-learning-client.js'
import { DshSkillCatalogAdapter } from '../src/adapters/dsh-skills/skill-catalog.js'
import { recallExistingSkills } from '../src/domain/learn/skill-recall.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function freshDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

class RepairRecordingAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  private readonly responses = [
    '{"summary":',
    '{"summary":"verified"}',
  ]

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const text = this.responses[this.calls.length - 1]
    if (text === undefined) throw new Error('unexpected third semantic call')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield {
      type: 'usage',
      usage: { inputTokens: 5 + this.calls.length, outputTokens: 2 },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function oneShotJson(
  ctx: Context,
  request: GenerateOptions,
): Promise<{ text: string; usage: TokenUsage }> {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(request)) assembler.push(chunk)
  expect(assembler.finish).toEqual({ kind: 'stop' })
  const usage = assembler.usage
  if (usage === undefined) throw new Error('learning call returned no usage')
  const text = assembler.blocks()
    .map(block => block.type === 'text' ? block.text : '')
    .join('')
  return { text, usage }
}

async function runJsonWithOneRepair(ctx: Context, provider: string, model: string) {
  const usages: TokenUsage[] = []
  let messages = [createMessage({
    role: 'user',
    content: [{ type: 'text', text: 'Return one JSON learning proposal.' }],
    source: { kind: 'user' },
  })]
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await oneShotJson(ctx, {
      provider,
      model,
      messages,
      system: 'Return JSON only. Do not request tools.',
    })
    usages.push(result.usage)
    try {
      return { value: JSON.parse(result.text) as unknown, usages }
    } catch (error) {
      if (attempt === 1) throw error
      messages = [createMessage({
        role: 'user',
        content: [{ type: 'text', text: `Repair this invalid JSON without changing its meaning: ${result.text}` }],
        source: { kind: 'user' },
      })]
    }
  }
  throw new Error('unreachable repair loop')
}

describe('CP-LLM-001 bounded inherited-route learning calls', () => {
  it('keeps one provider/model, sends no tools, records usage, and permits one JSON repair', async () => {
    const ctx = new Context()
    const llmFiber = await ctx.plugin(LlmRuntime)
    const sessionFiber = await ctx.plugin(SessionStore)
    const adapter = new RepairRecordingAdapter()
    ctx.llm.registerAdapter(['session-provider'], adapter)
    try {
      const session = ctx.sessions.create(SessionId('run2skill-llm-route'))
      session.append('request/header', {
        header: { config: { provider: 'older-provider', model: 'older-model' } },
        reason: 'initial',
      })
      session.append('request/header', {
        header: {
          config: { provider: 'session-provider', model: 'session-model' },
          system: 'Original Agent system prompt that Learning must not inherit.',
          tools: [{
            name: 'dangerous-tool',
            description: 'Must not reach Learning.',
            parameters: { type: 'object' },
          }],
        },
        reason: 'change',
      })
      const inherited = foldRequestHeader(session.snapshotEvents())
      if (inherited === undefined) throw new Error('missing folded Session request route')

      const result = await runJsonWithOneRepair(ctx, inherited.config.provider, inherited.config.model)
      expect(result.value).toEqual({ summary: 'verified' })
      expect(result.usages).toEqual([
        { inputTokens: 6, outputTokens: 2 },
        { inputTokens: 7, outputTokens: 2 },
      ])
      expect(adapter.calls).toHaveLength(2)
      expect(adapter.calls.map(call => [call.provider, call.model])).toEqual([
        ['session-provider', 'session-model'],
        ['session-provider', 'session-model'],
      ])
      expect(adapter.calls.every(call => call.tools === undefined)).toBe(true)
      expect(adapter.calls.every(call => call.purpose === undefined)).toBe(true)
    } finally {
      await sessionFiber.dispose()
      await llmFiber.dispose()
    }
  })

  it('surfaces cancellation as a terminal aborted finish', async () => {
    const ctx = new Context()
    const llmFiber = await ctx.plugin(LlmRuntime)
    const started = Promise.withResolvers<undefined>()
    const adapter = new class extends LlmAdapter {
      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        started.resolve(undefined)
        const signal = options.signal
        if (signal === undefined) throw new Error('missing cancellation signal')
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason)
            return
          }
          signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
        })
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }()
    ctx.llm.registerAdapter(['cancel-provider'], adapter)
    const controller = new AbortController()
    try {
      const draining = collect(ctx.llm.stream({
        provider: 'cancel-provider',
        model: 'cancel-model',
        messages: [],
        signal: controller.signal,
      }))
      await started.promise
      controller.abort(new Error('contract probe cancelled'))
      const chunks = await draining
      expect(chunks.at(-1)).toMatchObject({
        type: 'finish',
        reason: {
          kind: 'aborted',
          failure: { message: 'contract probe cancelled' },
        },
      })
    } finally {
      await llmFiber.dispose()
    }
  })

  it('runs the production restricted client through ctx.llm with one durable repair', async () => {
    const ctx = new Context()
    const llmFiber = await ctx.plugin(LlmRuntime)
    const valid = JSON.stringify({
      experiences: [{
        type: 'WORKFLOW',
        lesson: 'Run the focused verification first.',
        persistenceScope: 'PROJECT',
        evidenceStrength: 'HIGH',
        supportingEvidence: [{ messageSeq: 11, excerptDigest: 'a'.repeat(64) }],
      }],
      proposal: {
        policyVersion: 'learning-v1',
        name: 'focused-verification',
        description: 'Run focused verification before the full suite.',
        whenToUse: 'Use after changing a narrow implementation unit.',
        content: '# Focused verification\n\nRun the focused test, then the full suite.',
        invocation: { modelInvocable: true, userInvocable: false },
        persistenceScope: 'PROJECT',
        curation: { decision: 'CREATE', rationale: 'No existing Skill covers it.' },
      },
    })
    const adapter = new class extends LlmAdapter {
      readonly calls: GenerateOptions[] = []
      readonly responses = ['{"experiences":', valid]

      override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 32_000 } })
      }

      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        this.calls.push(options)
        const text = this.responses[this.calls.length - 1]
        if (text === undefined) throw new Error('unexpected third call')
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }()
    ctx.llm.registerAdapter(['session-provider'], adapter)
    const calls: Parameters<LearningCallLedger['record']>[0][] = []
    const ledger: LearningCallLedger = {
      async reserve(kind) {
        return { requestOrdinal: kind === 'PRIMARY' ? 1 : 2 }
      },
      async record(call) { calls.push(call) },
    }
    try {
      const client = new RestrictedLearningClient({
        resolveModelInfo: (provider, model, signal) => (
          ctx.llm.resolveModelInfo(provider, model, signal)
        ),
        stream: options => ctx.llm.stream(options),
      })
      const result = await client.learn({
        route: { provider: 'session-provider', model: 'session-model' },
        envelope: JSON.stringify({
          policyVersion: 'learning-v1',
          workItemId: `wi_${'b'.repeat(64)}`,
          trigger: { turn: 2, turnEndSeq: 12, evidenceDigests: ['a'.repeat(64)] },
          blocks: [],
        }),
        workItemId: `wi_${'b'.repeat(64)}`,
        catalogObservationDigest: 'c'.repeat(64),
        shortlistDigests: [],
        requestBudgetAvailable: 2,
        initialCallKind: 'PRIMARY',
        expectedPersistenceScope: 'PROJECT',
        ledger,
      })

      expect(result.status).toBe('SUCCEEDED')
      expect(adapter.calls).toHaveLength(2)
      expect(adapter.calls.every(call => call.tools === undefined && call.purpose === undefined)).toBe(true)
      expect(adapter.calls.every(call => call.provider === 'session-provider')).toBe(true)
      expect(calls.map(call => [call.requestOrdinal, call.kind, call.outcome])).toEqual([
        [1, 'PRIMARY', 'SUCCEEDED'],
        [2, 'FORMAT_REPAIR', 'SUCCEEDED'],
      ])
    } finally {
      await llmFiber.dispose()
    }
  })
})

async function writeSkill(root: string, name: string, description: string, body: string): Promise<void> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    body,
    '',
  ].join('\n'))
}

async function writeFlatSkill(root: string, name: string, description: string, body: string): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, `${name}.md`), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    body,
    '',
  ].join('\n'))
}

async function waitUntil<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() >= deadline) throw new Error('timed out waiting for Skill catalog refresh')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function mountWorkspaceAndSkills(base: string) {
  const ctx = new Context()
  const storageFiber = await ctx.plugin(Storage)
  const sqliteFiber = await ctx.plugin(StorageSqlite, { path: join(base, 'storage.db') })
  const domainFiber = await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  const sessionStoreFiber = await ctx.plugin(SessionStore)
  const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, {
    root: join(base, 'sessions'), compression: 'none',
  })
  const workspaceFiber = await ctx.plugin(WorkspaceRegistry)
  const skillRegistryFiber = await ctx.plugin(SkillRegistry)
  return {
    ctx,
    storageFiber,
    sqliteFiber,
    domainFiber,
    sessionStoreFiber,
    persistenceFiber,
    workspaceFiber,
    skillRegistryFiber,
  }
}

async function disposeWorkspaceAndSkills(mount: Awaited<ReturnType<typeof mountWorkspaceAndSkills>>) {
  await mount.skillRegistryFiber.dispose()
  await mount.workspaceFiber.dispose()
  await mount.persistenceFiber.dispose()
  await mount.sessionStoreFiber.dispose()
  await mount.domainFiber.dispose()
  await mount.sqliteFiber.dispose()
  await mount.storageFiber.dispose()
}

describe('CP-SKL-001 and CP-ROOT-001 catalog and root parity', () => {
  it('keeps scoped-only Skills behind the exact borrowed Agent view', async () => {
    const ctx = new Context()
    const skillRegistryFiber = await ctx.plugin(SkillRegistry)
    const preset = createScope(ctx, { preset: 'run2skill-probe' })
    const scopedSkills = preset.ctx.get('skills')
    if (scopedSkills === undefined) throw new Error('scoped Skill registry unavailable')
    scopedSkills.register({
      name: 'scoped-review',
      description: 'Review code changes.',
      whenToUse: 'Use for code review.',
      source: 'preset-probe',
      content: '# Scoped review\n\nReview the exact changes.',
    })
    const exactAgent = {}
    bindScopeParent(exactAgent, scopeOf(preset.ctx) as object)
    const exactView = { cwd: '/contract/project', scope: exactAgent }
    try {
      expect((await ctx.skills.snapshot()).skills.map(skill => skill.name)).not.toContain('scoped-review')
      const result = await recallExistingSkills(ctx.skills, exactView, 'code review')
      expect(result.status).toBe('AVAILABLE')
      if (result.status !== 'AVAILABLE') return
      expect(result.observation.candidates).toHaveLength(1)
      expect(result.observation.candidates[0]).toMatchObject({
        name: 'scoped-review',
        persistenceScope: 'UNKNOWN',
        writable: false,
        content: '# Scoped review\n\nReview the exact changes.',
      })
    } finally {
      await preset.dispose()
      await skillRegistryFiber.dispose()
    }
  })

  it('uses complete snapshots, project rank, exact bodies, hot invalidation, and composition-owned roots', async () => {
    const base = await freshDirectory('dsh-run2skill-skill-root-')
    const project = join(base, 'project')
    const dshHome = join(base, 'dsh-home')
    const agentsHome = join(base, 'agents-home')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(join(project, '.dsh', 'skills'), 'same-skill', 'Project wins', 'Project body v1.')
    await writeFlatSkill(join(project, '.dsh', 'skills'), 'flat-skill', 'Flat project skill', 'Flat project body.')
    await writeSkill(join(dshHome, 'skills'), 'same-skill', 'User loses', 'User body.')
    await writeSkill(join(dshHome, 'skills'), 'user-only', 'User only', 'User-only body.')
    await writeSkill(join(dshHome, 'skills', '.system'), 'hidden-system', 'Hidden', 'Hidden body.')

    const mount = await mountWorkspaceAndSkills(base)
    const skillFileSystemFiber = await mount.ctx.plugin(SkillFileSystem, {
      dshHome,
      agentsHome,
      watch: true,
      watchUsePolling: true,
      watchStabilityThresholdMs: 20,
      watchPollIntervalMs: 10,
    })
    let changes = 0
    mount.ctx.on('skills/change', () => { changes += 1 })
    mount.ctx.skills.register({
      name: 'runtime-skill',
      description: 'Borrowed runtime skill',
      source: 'runtime',
      content: 'Runtime body.',
    })
    mount.ctx.skills.register({
      name: 'bundled-provider-skill',
      description: 'Bundled non-filesystem skill',
      source: 'bundled',
      provider: 'plugin-bundle',
      resourceBase: { kind: 'opaque', description: 'plugin-owned resources' },
      content: 'Bundled provider body.',
    })
    try {
      const workspace = await mount.ctx.workspaceRegistry.create(project)
      const canonicalProject = await realpath(project)
      expect(workspace.path).toBe(canonicalProject)
      expect(await workspace.status()).toBe('ok')
      expect(await mount.ctx.workspaceRegistry.resolveByPath(project)).toBe(workspace)

      const initial = await mount.ctx.skills.snapshot({ cwd: workspace.path })
      expect(initial.complete).toBe(true)
      expect((await new DshSkillCatalogAdapter(mount.ctx.skills).snapshot({ cwd: workspace.path })).roots)
        .toBeUndefined()
      expect(initial.skills.map(skill => skill.name)).toEqual([
        'bundled-provider-skill',
        'flat-skill',
        'runtime-skill',
        'same-skill',
        'user-only',
      ])
      expect(initial.skills.find(skill => skill.name === 'same-skill')).toMatchObject({
        provider: 'filesystem',
        source: 'project-dsh',
        description: 'Project wins',
        resourceBase: { kind: 'directory', path: join(workspace.path, '.dsh', 'skills', 'same-skill') },
      })
      expect(initial.skills.some(skill => skill.name === 'hidden-system')).toBe(false)
      expect(initial.skills.find(skill => skill.name === 'flat-skill')).toMatchObject({
        provider: 'filesystem',
        source: 'project-dsh',
        resourceBase: { kind: 'directory', path: join(workspace.path, '.dsh', 'skills') },
      })
      expect(initial.skills.find(skill => skill.name === 'runtime-skill')).toMatchObject({
        provider: 'runtime',
        source: 'runtime',
      })
      expect(initial.skills.find(skill => skill.name === 'bundled-provider-skill')).toMatchObject({
        provider: 'plugin-bundle',
        source: 'bundled',
        resourceBase: { kind: 'opaque', description: 'plugin-owned resources' },
      })

      const expectedProjectRoot = join(workspace.path, '.dsh', 'skills')
      const expectedUserRoot = join(resolveDshHome(dshHome, {}), 'skills')
      const projectSkill = await mount.ctx.skills.get('same-skill', { cwd: workspace.path })
      const flatSkill = await mount.ctx.skills.get('flat-skill', { cwd: workspace.path })
      const runtimeSkill = await mount.ctx.skills.get('runtime-skill', { cwd: workspace.path })
      const bundledProviderSkill = await mount.ctx.skills.get('bundled-provider-skill', { cwd: workspace.path })
      const userSkill = await mount.ctx.skills.get('user-only', { cwd: workspace.path })
      expect(projectSkill).toMatchObject({
        source: 'project-dsh',
        path: join(expectedProjectRoot, 'same-skill', 'SKILL.md'),
        resourceBase: { kind: 'directory', path: join(expectedProjectRoot, 'same-skill') },
        content: 'Project body v1.',
      })
      expect(userSkill).toMatchObject({
        source: 'user-dsh',
        path: join(expectedUserRoot, 'user-only', 'SKILL.md'),
        content: 'User-only body.',
      })
      expect(flatSkill).toMatchObject({
        path: join(expectedProjectRoot, 'flat-skill.md'),
        resourceBase: { kind: 'directory', path: expectedProjectRoot },
        content: 'Flat project body.',
      })
      expect(runtimeSkill).toMatchObject({ provider: 'runtime', source: 'runtime', content: 'Runtime body.' })
      expect(bundledProviderSkill).toMatchObject({
        provider: 'plugin-bundle',
        source: 'bundled',
        content: 'Bundled provider body.',
      })
      expect(Reflect.has(mount.ctx.skills, 'roots')).toBe(false)

      const disposeIncomplete = mount.ctx.skills.registerProvider(() => ({
        name: 'incomplete-contract-probe',
        list: async () => ({ candidates: [], complete: false }),
        get: async () => undefined,
      }))
      expect((await mount.ctx.skills.snapshot({ cwd: workspace.path })).complete).toBe(false)
      disposeIncomplete()
      expect((await mount.ctx.skills.snapshot({ cwd: workspace.path })).complete).toBe(true)

      const changesBeforeWrite = changes
      await writeSkill(expectedProjectRoot, 'same-skill', 'Project refreshed', 'Project body v2.')
      const refreshed = await waitUntil(
        () => mount.ctx.skills.snapshot({ cwd: workspace.path }),
        snapshot => snapshot.complete
          && snapshot.skills.find(skill => skill.name === 'same-skill')?.description === 'Project refreshed',
      )
      expect(refreshed.complete).toBe(true)
      expect(changes).toBeGreaterThan(changesBeforeWrite)
      expect(await mount.ctx.skills.get('same-skill', { cwd: workspace.path })).toMatchObject({
        content: 'Project body v2.',
        path: join(expectedProjectRoot, 'same-skill', 'SKILL.md'),
      })
    } finally {
      await skillFileSystemFiber.dispose()
      await disposeWorkspaceAndSkills(mount)
    }
  }, 20_000)
})
