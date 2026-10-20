import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { createScope, scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { StockPresetMountPort } from './stock-root-contract.js'
import type { StockColdPresetMounts } from './stock-cold-preset.js'

/** Locate preset trees through the public Loader entries of their filesystem provider. */
function filesystemMounts(context: Context) {
  const trees = new Set<import('@deepseek-ai/cordis-plugin-loader').EntryTree>()
  for (const runtime of context.registry.values()) {
    if (runtime.name !== 'skill-filesystem') continue
    for (const fiber of runtime.fibers) {
      const tree = fiber.entry?.parent.tree
      if (tree !== undefined) trees.add(tree)
    }
  }
  return [...trees].flatMap(tree => {
    const key = scopeOf(tree.ctx)
    if (key === undefined) return []
    // A child scope asks the public registry for this exact retained generation.
    const reader = createScope(tree.ctx, {}, { parent: key })
    try {
      const presetId = context.get('agentPresets')?.composedPreset(reader.ctx)
      return presetId === undefined ? [] : [{ presetId, key, fiber: tree.ctx.fiber, tree }]
    } finally {
      // This reader installs no listeners or services. Its parent also owns teardown.
      void reader.dispose().catch(() => {})
    }
  })
}

export const stockPresetMounts: StockPresetMountPort = {
  standingMountFor(agentContext) {
    const context = agentContext as Context
    const registry = context.get('agentPresets')
    if (registry?.composedPreset(context) !== 'standard') return undefined
    const key = scopeOf(context)
    const parent = key === undefined ? undefined : scopeParentOf(key)
    if (parent === undefined) return undefined
    const matches = filesystemMounts(context).filter(mount => mount.key === parent)
    return matches.length === 1 ? matches[0] : undefined
  },
}

export const stockColdPresetMounts: StockColdPresetMounts = {
  liveMounts(hostContext) {
    return filesystemMounts(hostContext as Context)
  },
}
