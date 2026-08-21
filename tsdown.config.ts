import { defineConfig } from 'tsdown'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'

const CSS_PREFIX = '\0run2skill-css:'
const CSS_SUFFIX = '.mjs'
const STYLE_RUNTIME = resolve('src/client/style-lifecycle.ts')

function inlineCssModules() {
  const files = new Map<string, string>()
  return {
    name: 'run2skill-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css') || importer === undefined) return null
      const id = `${CSS_PREFIX}${basename(source)}${CSS_SUFFIX}`
      files.set(id, resolve(dirname(importer), source))
      return id
    },
    async load(id: string) {
      if (!id.startsWith(CSS_PREFIX)) return null
      const file = files.get(id)
      if (file === undefined) return null
      const { code, exports } = transform({
        filename: file,
        code: await readFile(file),
        cssModules: { pattern: 'run2skill_[local]_[hash]' },
        minify: true,
      })
      const classes = Object.fromEntries(Object.entries(exports ?? {}).map(([key, value]) => [key, value.name]))
      return [
        `import { upsertRun2skillStyle } from ${JSON.stringify(STYLE_RUNTIME)};`,
        `const css = ${JSON.stringify(code.toString())};`,
        'if (typeof document !== "undefined") upsertRun2skillStyle(css);',
        `export default ${JSON.stringify(classes)};`,
      ].join('\n')
    },
  }
}

export default defineConfig([
  {
    name: 'dsh-run2skill',
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    dts: true,
    fixedExtension: false,
    clean: true,
    deps: {
      neverBundle: ['zod'],
      dts: { neverBundle: ['zod'] },
    },
  },
  {
    name: 'dsh-run2skill/client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    fixedExtension: false,
    clean: false,
    deps: {
      neverBundle: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
      alwaysBundle: ['zod'],
      onlyBundle: false,
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-run2skill", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
    plugins: [inlineCssModules()],
  },
])
