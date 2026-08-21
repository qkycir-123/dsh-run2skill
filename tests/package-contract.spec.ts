import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name?: string
  version?: string
  private?: boolean
  description?: string
  license?: string
  repository?: { type?: string; url?: string }
  bugs?: { url?: string }
  homepage?: string
  publishConfig?: { access?: string; tag?: string }
  main?: string
  exports?: Record<string, unknown>
  files?: string[]
  peerDependencies?: Record<string, string>
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
const thirdPartyNotices = readPortableText('../THIRD_PARTY_NOTICES.md')

describe('published package contract', () => {
  it('pins the first public alpha identity and portable repository metadata', () => {
    expect(manifest).toMatchObject({
      name: 'dsh-run2skill',
      version: '0.1.0-alpha',
      description: 'A DSH-native, local-first Run to Skill plugin',
      license: 'MIT',
      repository: {
        type: 'git',
        url: 'git+https://github.com/qkycir-123/dsh-run2skill.git',
      },
      bugs: { url: 'https://github.com/qkycir-123/dsh-run2skill/issues' },
      homepage: 'https://github.com/qkycir-123/dsh-run2skill#readme',
      publishConfig: { access: 'public', tag: 'alpha' },
    })
    expect(manifest.private).not.toBe(true)
  })

  it('exports Host and Client faces and declares the thin Web bundle layer', () => {
    expect(manifest.main).toBe('./lib/index.js')
    expect(manifest.exports).toMatchObject({
      '.': { default: './lib/index.js' },
      './client': { default: './lib/client.js' },
      './package.json': './package.json',
    })
    expect(manifest.files).toEqual([
      'lib',
      'cordis.patch.yml',
      'README.md',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ])
    expect(manifest.peerDependencies).toEqual({
      '@deepseek-ai/dsh-agent-presets': '0.1.0-rc.7 || 0.1.0-rc.8',
    })
    expect(manifest.dsh).toEqual({
      bundle: { patch: './cordis.patch.yml' },
      client: {
        platform: 'web',
        inject: [
          '@deepseek-ai/dsh-client-connection',
          '@deepseek-ai/dsh-client-runtime',
          '@deepseek-ai/dsh-client-ui-settings',
          '@deepseek-ai/dsh-client-ui-settings-plugins',
          '@deepseek-ai/dsh-api-remotes',
        ],
      },
    })
  })

  it('ships the license notice for the Zod code embedded in the Client bundle', () => {
    expect(thirdPartyNotices).toContain('Zod 4.4.3')
    expect(thirdPartyNotices).toContain('Copyright (c) 2025 Colin McDonnell')
    expect(thirdPartyNotices).toContain('The above copyright notice and this permission notice')
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
