import type { StockPresetMountPort } from './stock-root-contract.js'

/** Stock DSH's exact mounted-generation locator, kept behind a narrow production port. */
export const stockPresetMounts: StockPresetMountPort = {
  async standingMountFor(agentContext) {
    const { standingMountFor } = await import('@deepseek-ai/dsh-agent-presets')
    return standingMountFor(agentContext as Parameters<typeof standingMountFor>[0])
  },
}
