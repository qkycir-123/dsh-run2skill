import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  STOCK_DSH_BASELINE_COMMIT,
  StockDshRootContractResolver,
  deriveStockResolutionContractDigest,
  resolveStockSkillRuntimeConfiguration,
  type StockSkillRuntimeConfiguration,
} from '../src/adapters/dsh-skills/stock-root-contract.js'
import { RootBindingV2Schema } from '../src/domain/review/index.js'

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
  it('derives the exact filesystem configuration from the stock fiber mounted for one Agent generation', async () => {
    const configuredHome = resolve('configured-dsh-home')
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
    })
    const duplicate = { parent: { fiber: mount }, config: {} } as Fiber
    await expect(resolveStockSkillRuntimeConfiguration(mounts, {
      ctx: { registry: { values: () => [{ name: 'skill-filesystem', fibers: [filesystem, duplicate] }] } },
    })).resolves.toBeUndefined()
    await expect(resolveStockSkillRuntimeConfiguration({ standingMountFor: () => undefined }, agent))
      .resolves.toBeUndefined()
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

  it('fails closed when PROJECT has no exact Workspace binding', () => {
    const resolver = new StockDshRootContractResolver({
      environment: {},
      homeDirectory: () => resolve('home'),
    })

    expect(resolver.resolve({ scope: 'PROJECT', configuration: configuration() }))
      .toEqual({ status: 'UNSUPPORTED', code: 'WORKSPACE_BINDING_UNAVAILABLE' })
  })
})
