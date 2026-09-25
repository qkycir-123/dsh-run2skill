import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { canonicalJson } from '../src/domain/learn/identity.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import { STOCK_PRESET_COMPOSITION_DIGESTS } from '../src/adapters/dsh-skills/stock-root-contract.js'

describe('DSH rc.2 stock preset evidence', () => {
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
