import { describe, expect, it, vi } from 'vitest'
import { canonicalJson } from '../src/domain/learn/identity.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import {
  acquireStockColdPreset,
  currentStockPresetMount,
  type StockColdPresetMount,
} from '../src/adapters/dsh-skills/stock-cold-preset.js'

function fixture() {
  const rows = [{ id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' }]
  const digest = sha256Utf8(canonicalJson(rows))
  const key = {}
  const root = { config: {} } as { config: unknown; parent: { fiber: unknown } }
  root.parent = { fiber: root }
  const fiber = { config: {}, parent: { fiber: root } }
  const skill = { config: {}, parent: { fiber } }
  const mount = {
    key,
    presetId: 'standard',
    fiber: {
      ...fiber,
      ctx: { registry: { values: () => [{ name: 'skill-filesystem', fibers: [skill] }] } },
    },
    tree: { root: { data: rows } },
  } as unknown as StockColdPresetMount
  // The skill fiber must descend from the exact mount fiber by identity.
  ;(skill.parent as { fiber: unknown }).fiber = mount.fiber
  const mounts = [mount]
  const host = { fs: {}, root: { fiber: root } }
  const release = vi.fn(async () => {})
  const registry = { acquireScope: vi.fn(async () => ({ key, [Symbol.asyncDispose]: release })) }
  return { digest, key, mount, mounts, host, release, registry }
}

describe('cold stock preset generation', () => {
  it('retains only the same-generation stock composition and filesystem fiber', async () => {
    const f = fixture()
    const observed = await acquireStockColdPreset(f.registry, { liveMounts: () => f.mounts }, f.host, 'standard', f.digest)
    expect(observed?.configuration).toMatchObject({
      presetId: 'standard', providerName: 'filesystem', includeDefaultRoots: true,
      usesContextFileSystem: true,
    })
    expect(f.release).not.toHaveBeenCalled()
    await observed?.lease[Symbol.asyncDispose]()
    expect(f.release).toHaveBeenCalledOnce()
  })

  it('releases a lease when the composition is overridden or the key cannot be matched', async () => {
    const f = fixture()
    expect(await acquireStockColdPreset(f.registry, { liveMounts: () => f.mounts }, f.host, 'standard', '0'.repeat(64)))
      .toBeUndefined()
    expect(f.release).toHaveBeenCalledOnce()
    f.registry.acquireScope.mockImplementationOnce(async () => ({ key: {}, [Symbol.asyncDispose]: f.release }))
    expect(await acquireStockColdPreset(f.registry, { liveMounts: () => f.mounts }, f.host, 'standard', f.digest))
      .toBeUndefined()
    expect(f.release).toHaveBeenCalledTimes(2)
  })

  it('rejects a replacement generation while an older lease remains retained', () => {
    const f = fixture()
    expect(currentStockPresetMount({ liveMounts: () => f.mounts }, f.host, f.key, f.digest)).toBe(f.mount)
    f.mounts.push({ ...f.mount, key: {} })
    expect(currentStockPresetMount({ liveMounts: () => f.mounts }, f.host, f.key, f.digest)).toBeUndefined()
  })
})
