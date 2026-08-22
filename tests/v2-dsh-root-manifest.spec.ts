import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DshV2RootManifestAdapter,
  type DshV2RuntimeCatalogManifestPort,
} from '../src/adapters/dsh-skills/v2-root-manifest.js'
import type { StockSkillRuntimeConfiguration } from '../src/adapters/dsh-skills/stock-root-contract.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function tempRoot() {
  const path = await mkdtemp(join(tmpdir(), 'run2skill-v2-manifest-'))
  cleanup.push(path)
  return path
}

async function write(path: string, content: string) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
}

function runtime(
  observe: DshV2RuntimeCatalogManifestPort['observeRuntimeCatalog'] = async () => ({
    complete: true,
    runtimeCatalogDigest: 'a'.repeat(64),
  }),
): DshV2RuntimeCatalogManifestPort {
  return { observeRuntimeCatalog: observe }
}

describe('DshV2RootManifestAdapter', () => {
  it('observes every effective stock Skill root and detects a shadowed candidate outside the Runtime winners', async () => {
    const root = await tempRoot()
    const project = join(root, 'project')
    const cwd = join(project, 'nested')
    const dshHome = join(root, 'dsh-home')
    const agentsHome = join(root, 'agents-home')
    const custom = join(root, 'custom')
    const bundled = join(root, 'bundled')
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(cwd, { recursive: true })
    await write(join(project, '.dsh', 'skills', 'project-skill', 'SKILL.md'), '# project')
    await write(join(project, '.agents', 'skills', 'agent-flat.md'), '# agent')
    await write(join(dshHome, 'skills', 'user-skill', 'SKILL.md'), '# user')
    await write(join(agentsHome, 'skills', 'user-agent', 'SKILL.md'), '# user agent')
    await write(join(custom, 'custom-skill', 'SKILL.md'), '# custom')
    await write(join(bundled, 'bundled-skill', 'SKILL.md'), '# bundled')
    const configuration: StockSkillRuntimeConfiguration = {
      profile: 'web', presetId: 'standard', providerName: 'filesystem', includeDefaultRoots: true,
      customSkillDirs: [custom], configuredDshHome: dshHome, configuredAgentsHome: agentsHome,
      configuredBundledSkillDir: bundled,
    }
    const adapter = new DshV2RootManifestAdapter({
      resolveSession: key => key === 'sl_session' ? { cwd, configuration } : undefined,
      runtimeCatalog: runtime(),
      environment: {},
      homeDirectory: () => join(root, 'unused-home'),
    })

    const before = await adapter.capture('sl_session')
    expect(before).toMatchObject({ complete: true, runtimeCatalogDigest: 'a'.repeat(64) })
    expect(before.rootManifestDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(JSON.stringify(before)).not.toContain(root)

    // This lower-ranked candidate can be absent from the Runtime winner list,
    // but it still has to invalidate the ownership baseline.
    await write(join(project, '.agents', 'skills', 'project-skill', 'SKILL.md'), '# shadowed')
    const after = await adapter.capture('sl_session')
    expect(after.complete).toBe(true)
    expect(after.runtimeCatalogDigest).toBe(before.runtimeCatalogDigest)
    expect(after.rootManifestDigest).not.toBe(before.rootManifestDigest)
  })

  it('fails closed on environment drift, runtime incompleteness, or a mixed root/catalog sample', async () => {
    const root = await tempRoot()
    const project = join(root, 'project')
    await mkdir(join(project, '.git'), { recursive: true })
    const environment: Record<string, string | undefined> = { DSH_HOME: join(root, 'home-a') }
    const configuration: StockSkillRuntimeConfiguration = {
      profile: 'web', presetId: 'standard', providerName: 'filesystem', includeDefaultRoots: true,
      customSkillDirs: [],
    }
    const base = {
      resolveSession: () => ({ cwd: project, configuration }),
      environment,
      currentEnvironment: () => environment,
      homeDirectory: () => join(root, 'fallback-home'),
    }
    const incomplete = new DshV2RootManifestAdapter({
      ...base,
      runtimeCatalog: runtime(async () => ({ complete: false, runtimeCatalogDigest: '0'.repeat(64) })),
    })
    expect((await incomplete.capture('sl_session')).complete).toBe(false)

    const virtualFileSystem = new DshV2RootManifestAdapter({
      ...base,
      resolveSession: () => ({ cwd: project, configuration: { ...configuration, usesContextFileSystem: true } }),
      runtimeCatalog: runtime(),
    })
    expect((await virtualFileSystem.capture('sl_session')).complete).toBe(false)

    const mixed = new DshV2RootManifestAdapter({
      ...base,
      runtimeCatalog: runtime(async () => {
        await write(join(project, '.dsh', 'skills', 'late', 'SKILL.md'), '# late')
        return { complete: true, runtimeCatalogDigest: 'b'.repeat(64) }
      }),
    })
    expect((await mixed.capture('sl_session')).complete).toBe(false)

    const drifted = new DshV2RootManifestAdapter({ ...base, runtimeCatalog: runtime() })
    environment.DSH_HOME = join(root, 'home-b')
    expect((await drifted.capture('sl_session')).complete).toBe(false)
  })
})
