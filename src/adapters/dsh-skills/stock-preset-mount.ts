import type { StockPresetMountPort } from './stock-root-contract.js'
import type { StockColdPresetMounts } from './stock-cold-preset.js'
import { livePresetMounts, standingMountFor } from '@deepseek-ai/dsh-agent-preset-registry'

/** Stock DSH's exact mounted-generation locator, kept behind a narrow production port. */
export const stockPresetMounts: StockPresetMountPort = {
  standingMountFor(agentContext) {
    return standingMountFor(agentContext as Parameters<typeof standingMountFor>[0])
  },
}

export const stockColdPresetMounts: StockColdPresetMounts = {
  liveMounts(hostContext) {
    const root = 'root' in hostContext ? hostContext.root : undefined
    if (typeof root !== 'object' || root === null || !('fiber' in root)) return []
    // DSH filters the module-wide mount set to this Host's Cordis root.
    return livePresetMounts(root.fiber as Parameters<typeof livePresetMounts>[0]) as unknown as ReturnType<StockColdPresetMounts['liveMounts']>
  },
}
