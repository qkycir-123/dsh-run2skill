import { defineConfig } from 'tsdown'

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
      neverBundle: ['react'],
      alwaysBundle: ['zod'],
      onlyBundle: false,
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-run2skill", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
