import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  STOCK_DSH_BASELINE_COMMIT,
  STOCK_PRESET_COMPOSITION_DIGESTS,
  StockDshRootContractResolver,
  StockSkillRuntimeConfigurationCache,
  deriveStockResolutionContractDigest,
  resolvePinnedStockPresetConfiguration,
  resolvePinnedStockPresetConfigurationById,
  resolveStockSkillRuntimeConfiguration,
  type StockSkillRuntimeConfiguration,
} from '../src/adapters/dsh-skills/stock-root-contract.js'
import { RootBindingV2Schema } from '../src/domain/review/index.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'

const workspace = resolve('stock-contract-workspace')
const dshHome = resolve('stock-contract-dsh-home')

function configuration(
  overrides: Partial<StockSkillRuntimeConfiguration> = {},
): StockSkillRuntimeConfiguration {
  return {
    profile: 'web',
    presetId: 'standard',
    providerName: 'filesystem',
    includeDefaultRoots: true,
    customSkillDirs: [],
    ...overrides,
  }
}

describe('stock DSH root contract', () => {
  it('invalidates a cached configuration when authoritative recapture becomes unsupported', async () => {
    const agent = { ctx: {} }
    let mounted = true
    const expected = configuration()
    const cache = new StockSkillRuntimeConfigurationCache(async candidate => (
      candidate === agent && mounted ? expected : undefined
    ))

    await expect(cache.capture(agent)).resolves.toEqual(expected)
    mounted = false

    await expect(cache.capture(agent)).resolves.toBeUndefined()
    expect(cache.get(agent)).toBeUndefined()
    cache.release(agent)
    expect(cache.get(agent)).toBeUndefined()
  })

  it('accepts the rc.2 stock preset composition and rejects the retired rc.7 digest', async () => {
    const agent = { ctx: {} }
    const rc7Content = '- id: skill-filesystem\n  name: rc.7\n'
    const rc2Content = '- id: skill-filesystem\n  name: rc.2\n'
    let content = rc2Content
    const service = {
      composedPreset: (ctx: object) => ctx === agent.ctx ? 'standard' : undefined,
      resolve: async () => ({ id: 'standard', trust: 'system' as const }),
      read: async () => content,
    }
    const digests = {
      standard: [sha256Utf8(rc2Content)],
      code: ['f'.repeat(64)],
    }

    await expect(resolvePinnedStockPresetConfiguration(service, agent, digests))
      .resolves.toEqual(configuration())
    content = rc7Content
    await expect(resolvePinnedStockPresetConfiguration(service, agent, digests)).resolves.toBeUndefined()
    await expect(resolvePinnedStockPresetConfiguration({
      ...service,
      read: async () => `${rc2Content}# unknown\n`,
    }, agent, digests)).resolves.toBeUndefined()
    await expect(resolvePinnedStockPresetConfiguration({
      ...service,
      resolve: async () => ({ id: 'standard', trust: 'user' as const }),
    }, agent, digests)).resolves.toBeUndefined()
  })

  it('restores a pinned stock preset by durable id without a live Agent context', async () => {
    const content = '- id: skill-filesystem\n  name: stock\n'
    const presets = {
      resolve: async (id: string) => ({ id, trust: 'system' as const }),
      read: async () => content,
    }
    const digests = { standard: [sha256Utf8(content)], code: ['f'.repeat(64)] }

    await expect(resolvePinnedStockPresetConfigurationById(
      presets,
      'standard',
      true,
      digests,
    )).resolves.toEqual(configuration({ usesContextFileSystem: true }))
    await expect(resolvePinnedStockPresetConfigurationById(
      presets,
      'standard',
      false,
      digests,
    )).resolves.toEqual(configuration())
    await expect(resolvePinnedStockPresetConfigurationById(
      presets,
      'standard',
      false,
      { ...digests, standard: ['0'.repeat(64)] },
    )).resolves.toBeUndefined()
    await expect(resolvePinnedStockPresetConfigurationById(
      presets,
      'custom',
      false,
      digests,
    )).resolves.toBeUndefined()
  })

  it('pins the rc.2 baseline and exact stock preset digest allowlists', () => {
    expect(STOCK_DSH_BASELINE_COMMIT).toBe('b150a551b8d465e31e418e1b2eaf5e79bbb7d28e')
    expect(STOCK_PRESET_COMPOSITION_DIGESTS).toEqual({
      standard: [
        'fa14feb98daef20b810fef30bb7239a89a786de3c45c602b37743f7100d9a5af',
      ],
      code: [
        'bdecfe0b26a9d56a2ffcb79694fc123bc395247969e135c62945a1ec8fb92e87',
      ],
    })
  })

  it('derives the exact filesystem configuration from the stock fiber mounted for one Agent generation', async () => {
    const configuredHome = resolve('configured-dsh-home')
    const configuredAgentsHome = resolve('configured-agents-home')
    const configuredBundledSkillDir = resolve('configured-bundled-skills')
    const customRoot = resolve('custom-skills')
    type Fiber = { parent: { fiber: Fiber }; config: unknown }
    const root = { config: {} } as Fiber
    root.parent = { fiber: root }
    const mount = { parent: { fiber: root }, config: {} } as Fiber
    const filesystem = {
      parent: { fiber: mount },
      config: {
        providerName: 'renamed-filesystem',
        includeDefaultRoots: false,
        dshHome: configuredHome,
        agentsHome: configuredAgentsHome,
        bundledSkillDir: configuredBundledSkillDir,
        customSkillDirs: [customRoot],
      },
    } as Fiber
    const agent = {
      ctx: {
        registry: {
          values: () => [{ name: 'skill-filesystem', fibers: [filesystem] }],
        },
      },
    }
    const mounts = {
      standingMountFor: (ctx: object) => ctx === agent.ctx
        ? { presetId: 'standard', fiber: mount }
        : undefined,
    }

    await expect(resolveStockSkillRuntimeConfiguration(mounts, agent)).resolves.toEqual({
      profile: 'web',
      presetId: 'standard',
      providerName: 'renamed-filesystem',
      includeDefaultRoots: false,
      customSkillDirs: [customRoot],
      configuredDshHome: configuredHome,
      configuredAgentsHome,
      configuredBundledSkillDir,
    })
    const duplicate = { parent: { fiber: mount }, config: {} } as Fiber
    await expect(resolveStockSkillRuntimeConfiguration(mounts, {
      ctx: { registry: { values: () => [{ name: 'skill-filesystem', fibers: [filesystem, duplicate] }] } },
    })).resolves.toBeUndefined()
    await expect(resolveStockSkillRuntimeConfiguration({ standingMountFor: () => undefined }, agent))
      .resolves.toBeUndefined()

    await expect(resolveStockSkillRuntimeConfiguration({ standingMountFor: () => ({ presetId: 'standard', fiber: mount }) }, {
      ...agent,
      ctx: { ...agent.ctx, get: name => name === 'fs' ? {} : undefined },
    })).resolves.toMatchObject({ usesContextFileSystem: true })
  })

  it('accepts only the versioned RootBindingV2 stock contract facts', () => {
    const value = {
      state: 'EXISTING' as const,
      scope: 'PROJECT' as const,
      expectedProvider: 'filesystem',
      expectedSource: 'project-dsh' as const,
      resolverVersion: 'stock-root-resolver-v2',
      rootContractVersion: 'stock-dsh-web-default-roots-v1',
      resolutionContractDigest: 'a'.repeat(64),
      declaredRootPath: join(workspace, '.dsh', 'skills'),
      canonicalRootPath: join(workspace, '.dsh', 'skills'),
      rootIdentityDigest: 'b'.repeat(64),
    }

    expect(RootBindingV2Schema.parse(value)).toEqual(value)
    expect(RootBindingV2Schema.safeParse({
      ...value,
      observationDigest: 'c'.repeat(64),
    }).success).toBe(false)
    expect(RootBindingV2Schema.safeParse({ ...value, expectedProvider: 'run2skill' }).success).toBe(false)
    expect(RootBindingV2Schema.safeParse({ ...value, rootContractVersion: 'future-contract' }).success).toBe(false)
  })

  it('resolves only the fixed stock PROJECT and USER default roots', () => {
    const resolver = new StockDshRootContractResolver({
      environment: { DSH_HOME: dshHome },
      homeDirectory: () => resolve('unused-home'),
    })

    const project = resolver.resolve({
      scope: 'PROJECT',
      configuration: configuration(),
      workspaceBinding: { workspaceId: 'workspace-1', canonicalPath: workspace },
    })
    const user = resolver.resolve({ scope: 'USER', configuration: configuration() })

    expect(project).toMatchObject({
      status: 'SUPPORTED',
      baselineCommit: STOCK_DSH_BASELINE_COMMIT,
      expectedProvider: 'filesystem',
      expectedSource: 'project-dsh',
      declaredRootPath: join(workspace, '.dsh', 'skills'),
    })
    expect(user).toMatchObject({
      status: 'SUPPORTED',
      baselineCommit: STOCK_DSH_BASELINE_COMMIT,
      expectedProvider: 'filesystem',
      expectedSource: 'user-dsh',
      declaredRootPath: join(dshHome, 'skills'),
      dshHome: { resolutionKind: 'ENVIRONMENT', declaredPath: dshHome },
    })
    if (project.status !== 'SUPPORTED') throw new Error('PROJECT contract must be supported')
    expect(deriveStockResolutionContractDigest(project, {
      kind: 'WORKSPACE', workspaceId: 'workspace-1', canonicalPath: workspace,
    })).toMatch(/^[a-f0-9]{64}$/u)
  })

  it.each([
    ['wrong profile', { profile: 'tui' }],
    ['custom preset', { presetId: 'mine' }],
    ['preset without the filesystem provider', { presetId: 'minimal' }],
    ['renamed provider', { providerName: 'renamed-filesystem' }],
    ['defaults disabled', { includeDefaultRoots: false }],
    ['custom roots', { customSkillDirs: [resolve('custom-skills')] }],
  ] as const)('fails closed for %s', (_label, override) => {
    const resolver = new StockDshRootContractResolver({
      environment: { DSH_HOME: dshHome },
      homeDirectory: () => resolve('unused-home'),
    })

    expect(resolver.resolve({
      scope: 'PROJECT',
      configuration: configuration(override),
      workspaceBinding: { workspaceId: 'workspace-1', canonicalPath: workspace },
    })).toEqual({ status: 'UNSUPPORTED', code: 'ROOT_CONTRACT_UNSUPPORTED' })
  })

  it('uses the stock provider explicit DSH Home before the environment', () => {
    const configuredHome = resolve('configured-home')
    const resolver = new StockDshRootContractResolver({
      environment: { DSH_HOME: dshHome },
      homeDirectory: () => resolve('unused-home'),
    })

    expect(resolver.resolve({
      scope: 'USER',
      configuration: configuration({ configuredDshHome: configuredHome }),
    })).toMatchObject({
      status: 'SUPPORTED',
      declaredRootPath: join(configuredHome, 'skills'),
      dshHome: { resolutionKind: 'CONFIGURATION', declaredPath: configuredHome },
    })
  })

  it('fails USER closed when the provider environment witness drifts after mount', () => {
    const environment: Record<string, string | undefined> = { DSH_HOME: dshHome }
    const resolver = new StockDshRootContractResolver({
      environment,
      currentEnvironment: () => environment,
      homeDirectory: () => resolve('unused-home'),
    })
    environment.DSH_HOME = resolve('drifted-dsh-home')

    expect(resolver.resolve({ scope: 'USER', configuration: configuration() }))
      .toEqual({ status: 'UNSUPPORTED', code: 'ROOT_CONTRACT_UNSUPPORTED' })
    expect(resolver.resolve({
      scope: 'USER',
      configuration: configuration({ configuredDshHome: resolve('configured-home') }),
    })).toMatchObject({ status: 'SUPPORTED', dshHome: { resolutionKind: 'CONFIGURATION' } })
  })

  it('fails closed when PROJECT has no exact Workspace binding', () => {
    const resolver = new StockDshRootContractResolver({
      environment: {},
      homeDirectory: () => resolve('home'),
    })

    expect(resolver.resolve({ scope: 'PROJECT', configuration: configuration() }))
      .toEqual({ status: 'UNSUPPORTED', code: 'WORKSPACE_BINDING_UNAVAILABLE' })
  })
})
