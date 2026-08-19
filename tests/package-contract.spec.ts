import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  main?: string
  exports?: Record<string, unknown>
  files?: string[]
  dsh?: {
    bundle?: { patch?: string }
    client?: { platform?: string; inject?: string[] }
  }
}
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

describe('published package contract', () => {
  it('exports Host and Client faces and declares the thin Web bundle layer', () => {
    expect(manifest.main).toBe('./lib/index.js')
    expect(manifest.exports).toMatchObject({
      '.': { default: './lib/index.js' },
      './client': { default: './lib/client.js' },
      './package.json': './package.json',
    })
    expect(manifest.files).toEqual(expect.arrayContaining(['lib', 'cordis.patch.yml']))
    expect(manifest.dsh).toEqual({
      bundle: { patch: './cordis.patch.yml' },
      client: {
        platform: 'web',
        inject: [
          '@deepseek-ai/dsh-client-connection',
          '@deepseek-ai/dsh-client-runtime',
        ],
      },
    })
  })

  it('inserts only the run2skill Host row and never mounts later-slice services', () => {
    expect(patch).toBe("- insert:\n    - id: run2skill\n      name: dsh-run2skill\n")
    expect(patch).not.toMatch(/llm|skills|settings/iu)
  })
})
