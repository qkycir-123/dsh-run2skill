import {
  STOCK_PRESET_COMPOSITION_DIGESTS,
  hasStockPresetComposition,
  resolveMountedStockSkillRuntimeConfiguration,
  type StockSkillRuntimeConfiguration,
} from './stock-root-contract.js'

export interface StockPresetLease {
  readonly key: object
  [Symbol.asyncDispose](): Promise<void>
}

export interface StockColdPresetRegistry {
  acquireScope(id: string): Promise<StockPresetLease>
}

export interface StockColdPresetMount {
  readonly key: object | undefined
  readonly presetId: string
  readonly fiber: {
    readonly config: unknown
    readonly parent: { readonly fiber: StockColdPresetMount['fiber'] }
    readonly ctx: {
      readonly registry: { values(): Iterable<{
        readonly name?: string
        readonly fibers: Iterable<{ readonly parent: { readonly fiber: StockColdPresetMount['fiber'] }; readonly config: unknown }>
      }> }
    }
  }
  readonly tree: { readonly root: { readonly data: unknown } }
}

export interface StockColdPresetMounts {
  liveMounts(hostContext: object): readonly StockColdPresetMount[]
}

/** A retained generation remains usable only while it is the sole standard mount in this Host. */
export function currentStockPresetMount(
  mounts: StockColdPresetMounts,
  hostContext: object,
  key: object,
  expectedDigest = STOCK_PRESET_COMPOSITION_DIGESTS.standard[0],
): StockColdPresetMount | undefined {
  const standard = mounts.liveMounts(hostContext).filter(mount => mount.presetId === 'standard')
  if (standard.length !== 1 || standard[0]?.key !== key) return undefined
  const mount = standard[0]
  return mount !== undefined
    && expectedDigest !== undefined
    && hasStockPresetComposition(mount, expectedDigest)
    ? mount
    : undefined
}

export async function acquireStockColdPreset(
  presets: StockColdPresetRegistry,
  mounts: StockColdPresetMounts,
  hostContext: { readonly fs: unknown },
  id: string | undefined,
  expectedDigest = STOCK_PRESET_COMPOSITION_DIGESTS.standard[0],
): Promise<{ readonly lease: StockPresetLease; readonly configuration: StockSkillRuntimeConfiguration } | undefined> {
  if (id !== 'standard') return undefined
  let lease: StockPresetLease
  try {
    lease = await presets.acquireScope(id)
  } catch {
    return undefined
  }
  let accepted = false
  try {
    const mount = currentStockPresetMount(mounts, hostContext, lease.key, expectedDigest)
    if (mount === undefined) return undefined
    const configuration = resolveMountedStockSkillRuntimeConfiguration(mount, {
      ctx: {
        registry: mount.fiber.ctx.registry,
        get: name => name === 'fs' ? hostContext.fs : undefined,
      },
    })
    if (configuration === undefined) return undefined
    accepted = true
    return { lease, configuration }
  } finally {
    if (!accepted) await lease[Symbol.asyncDispose]()
  }
}
