declare module '@deepseek-ai/dsh-agent-presets' {
  export interface StockPresetFiber {
    readonly parent: { readonly fiber: StockPresetFiber }
    readonly config: unknown
  }

  export interface StockJoinedPresetMount {
    readonly presetId: string
    readonly fiber: StockPresetFiber
  }

  export function standingMountFor(agentContext: object): StockJoinedPresetMount | undefined
}
