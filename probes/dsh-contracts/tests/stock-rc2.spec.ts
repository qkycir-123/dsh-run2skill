import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import PresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import Projections from '@deepseek-ai/dsh-session-projection'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { createScope } from '@deepseek-ai/dsh-scope'
import { stockPresetMounts, stockColdPresetMounts } from '../src/adapters/dsh-skills/stock-preset-mount.js'
import { currentStockPresetMount } from '../src/adapters/dsh-skills/stock-cold-preset.js'
import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { canonicalJson } from '../src/domain/learn/identity.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import { STOCK_PRESET_COMPOSITION_DIGESTS } from '../src/adapters/dsh-skills/stock-root-contract.js'

describe('DSH rc.2 stock preset evidence', () => {
  it('locates the exact live and cold generation through Loader entries and scope identity', async () => {
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(join(process.cwd(), 'apps', 'cli', 'package.json')).href
    const fibers = []
    const scope = createScope(ctx, {})
    const rows = [{ id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', config: { watch: false } }]
    const digest = sha256Utf8(canonicalJson(rows))
    let lease: Awaited<ReturnType<typeof ctx.agentPresets.acquireScope>> | undefined
    try {
      fibers.push(await ctx.plugin(Loader))
      fibers.push(await ctx.plugin(Projections))
      fibers.push(await ctx.plugin(SkillRegistry))
      fibers.push(await ctx.plugin(PresetRegistry, { default: 'standard' }))
      fibers.push(await ctx.plugin(AgentPreset, { id: 'standard', plugins: rows }))
      await ctx.agentPresets.mount(scope.ctx, 'standard')
      lease = await ctx.agentPresets.acquireScope('standard')
      const live = await stockPresetMounts.standingMountFor(scope.ctx)
      expect(live?.key).toBe(lease.key)
      expect(currentStockPresetMount(stockColdPresetMounts, ctx, lease.key, digest)?.key).toBe(lease.key)
      expect(currentStockPresetMount(stockColdPresetMounts, ctx, {}, digest)).toBeUndefined()
      expect(currentStockPresetMount(stockColdPresetMounts, ctx, lease.key, '0'.repeat(64))).toBeUndefined()
      expect(stockColdPresetMounts.liveMounts(new Context())).toEqual([])
      // Keep the old generation leased while the same id acquires a replacement.
      await fibers.pop()!.dispose()
      fibers.push(await ctx.plugin(AgentPreset, { id: 'standard', plugins: rows }))
      const replacement = await ctx.agentPresets.acquireScope('standard')
      try {
        expect(replacement.key).not.toBe(lease.key)
        expect(currentStockPresetMount(stockColdPresetMounts, ctx, lease.key, digest)).toBeUndefined()
        expect(currentStockPresetMount(stockColdPresetMounts, ctx, replacement.key, digest)).toBeUndefined()
      } finally { await replacement[Symbol.asyncDispose]() }

    } finally {
      await scope.dispose()
      await lease?.[Symbol.asyncDispose]()
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  })

  it('pins the exact official Web bundle composition used by the cold-session mount guard', async () => {
    const source = await readFile(join(process.cwd(), 'packages/bundle/web-app/presets/standard.patch.yml'), 'utf8')
    const patch = load(source, { schema: entryListSchema }) as Array<{
      insert?: Array<{ id?: string; config?: { id?: string; plugins?: unknown } }>
    }>
    const declarations = patch.flatMap(row => row.insert ?? [])
    const standard = declarations.filter(row => row.id === 'preset-standard' && row.config?.id === 'standard')
    expect(standard).toHaveLength(1)
    expect(Array.isArray(standard[0]?.config?.plugins)).toBe(true)
    expect(sha256Utf8(canonicalJson(standard[0]?.config?.plugins))).toBe(STOCK_PRESET_COMPOSITION_DIGESTS.standard[0])
  })
})
