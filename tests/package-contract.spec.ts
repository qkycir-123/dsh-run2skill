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
  scripts?: Record<string, string>
}
function readPortableText(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('\r\n', '\n')
}

const patch = readPortableText('../cordis.patch.yml')
const workspace = readPortableText('../pnpm-workspace.yaml')

describe('published package contract', () => {
  it('exports Host and Client faces and declares the thin Web bundle layer', () => {
    expect(manifest.main).toBe('./lib/index.js')
    expect(manifest.exports).toMatchObject({
      '.': { default: './lib/index.js' },
      './client': { default: './lib/client.js' },
      './package.json': './package.json',
    })
    expect(manifest.files).toEqual(['lib', 'cordis.patch.yml'])
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

  it('runs the exact candidate verifier and permits only the required build helper', () => {
    expect(manifest.scripts?.['verify:candidate']).toContain('probes/candidate/verify.mjs')
    expect(workspace).toBe("packages:\n  - '.'\n\nallowBuilds:\n  esbuild: true\n")
  })

  it('inserts only the run2skill Host row and never mounts later-slice services', () => {
    expect(patch).toBe("- insert:\n    - id: run2skill\n      name: dsh-run2skill\n")
    expect(patch).not.toMatch(/llm|skills|settings/iu)
  })
})
