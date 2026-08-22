import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshV2RouteSnapshotAdapter } from '../src/adapters/dsh-llm/v2-route-snapshot.js'
import { DshV2CatalogAdapter } from '../src/adapters/dsh-skills/v2-catalog-adapter.js'
import { DshV2RootManifestAdapter } from '../src/adapters/dsh-skills/v2-root-manifest.js'
import type { TurnObservationV2 } from '../src/domain/v2/index.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function writeSkill(root: string, name: string, description: string): Promise<void> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), [
    '---', `name: ${name}`, `description: ${description}`, '---', '', `# ${name}`, '',
  ].join('\n'), 'utf8')
}

describe('B2 v2 frozen route and ownership manifest on real DSH services', () => {
  it('reads exact LLM capacity without streaming and sees a shadowed filesystem candidate', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-run2skill-b2-v2-facts-'))
    temporaryDirectories.push(base)
    const project = join(base, 'project')
    const dshHome = join(base, 'dsh-home')
    const agentsHome = join(base, 'agents-home')
    const custom = join(base, 'custom')
    const bundled = join(base, 'bundled')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(join(project, '.dsh', 'skills'), 'same-skill', 'Project winner')
    await writeSkill(join(dshHome, 'skills'), 'user-only', 'User Skill')
    await writeSkill(custom, 'custom-only', 'Custom Skill')
    await writeSkill(bundled, 'bundled-only', 'Bundled Skill')

    const ctx = new Context()
    const llmFiber = await ctx.plugin(LlmRuntime)
    const skillsFiber = await ctx.plugin(SkillRegistry)
    const filesystemFiber = await ctx.plugin(SkillFileSystem, {
      dshHome, agentsHome, customSkillDirs: [custom], bundledSkillDir: bundled, watch: false,
    })
    let streamed = false
    const llm = new class extends LlmAdapter {
      override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return Promise.resolve({
          provider, id: model, name: model,
          context: { contextWindow: 128_000 }, defaultMaxTokens: 8_192,
        })
      }

      override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        streamed = true
        yield* []
      }
    }()
    ctx.llm.registerAdapter(['probe-provider'], llm)
    try {
      const route = await new DshV2RouteSnapshotAdapter({
        resolveModelInfo: (provider, model, signal) => ctx.llm.resolveModelInfo(provider, model, signal),
        stream: options => ctx.llm.stream(options),
      }).capture('sl_probe', [{
        turnEndSeq: 10,
        routeObservation: { provider: 'probe-provider', model: 'probe-model', complete: true },
      } as TurnObservationV2])
      expect(route).toMatchObject({ maxInputBytes: 117_760, maxOutputBytes: 32_768 })
      expect(streamed).toBe(false)

      const view = { cwd: project }
      const runtimeCatalog = new DshV2CatalogAdapter(createMemoryRun2skillV2Domain(), {
        registry: ctx.skills,
        resolveView: key => key === 'sl_probe' ? view : undefined,
        resolveStockWritableRoot: summary => summary.source === 'project-dsh'
          ? {
              scope: 'PROJECT', expectedProvider: 'filesystem', expectedSource: 'project-dsh',
              canonicalRootPath: join(project, '.dsh', 'skills'),
            }
          : summary.source === 'user-dsh'
            ? {
                scope: 'USER', expectedProvider: 'filesystem', expectedSource: 'user-dsh',
                canonicalRootPath: join(dshHome, 'skills'),
              }
            : undefined,
      })
      const manifest = new DshV2RootManifestAdapter({
        resolveSession: () => ({
          cwd: project,
          configuration: {
            profile: 'web', presetId: 'standard', providerName: 'filesystem', includeDefaultRoots: true,
            customSkillDirs: [custom], configuredDshHome: dshHome, configuredAgentsHome: agentsHome,
            configuredBundledSkillDir: bundled,
          },
        }),
        runtimeCatalog,
        environment: {},
        homeDirectory: () => join(base, 'unused-home'),
      })
      const before = await manifest.capture('sl_probe')
      expect(before.complete).toBe(true)
      expect(before.ownershipCandidates).toHaveLength(4)
      expect(before.ownershipCandidates?.find(candidate => candidate.name === 'same-skill')).toMatchObject({
        provider: 'filesystem', source: 'project-dsh', scope: 'PROJECT', writable: true,
      })
      expect(before.ownershipCandidates?.every(candidate => /^[a-f0-9]{64}$/u.test(candidate.bodyDigest))).toBe(true)
      expect(before.ownershipCandidates?.some(candidate => candidate.targetPathDigest !== undefined)).toBe(true)
      expect(JSON.stringify(before)).not.toContain(base)

      await writeSkill(join(project, '.agents', 'skills'), 'same-skill', 'Shadowed Agent copy')
      const after = await manifest.capture('sl_probe')
      expect(after.complete).toBe(true)
      expect(after.runtimeCatalogDigest).toBe(before.runtimeCatalogDigest)
      expect(after.rootManifestDigest).not.toBe(before.rootManifestDigest)
    } finally {
      await filesystemFiber.dispose()
      await skillsFiber.dispose()
      await llmFiber.dispose()
    }
  })
})
