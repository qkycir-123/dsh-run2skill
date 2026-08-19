import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeDiagnostic } from '../support/safe-diagnostics.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const packageDirectory = resolve(root, '.probe-work', 'package')
const expectedPackageFiles = [
  'cordis.patch.yml',
  'lib/client.js',
  'lib/index.d.ts',
  'lib/index.js',
  'LICENSE',
  'package.json',
  'README.md',
]
const permittedSyntheticSecrets = new Set([
  'ghp_abcdefghijklmnopqrstuvwxyz123456',
  'ghp_runtimeSyntheticValue123456789',
  'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
  'sk-abcdefghijklmnopqrstuvwxyz123456789012345678901234',
])
const secretRules = [
  ['PRIVATE_KEY', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu],
  ['GITHUB_TOKEN', /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu],
  ['API_KEY', /\bsk-[A-Za-z0-9_-]{20,}\b/gu],
  ['CREDENTIAL_URL', /https?:\/\/[^\s/:]+:[^\s/@]+@/gu],
]

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: root, encoding: 'utf8', windowsHide: true, ...options,
  })
  if (result.status !== 0) throw new Error(`${executable} failed with exit ${String(result.status)}`)
  return result.stdout
}

function scan(name, content) {
  const findings = []
  for (const [rule, pattern] of secretRules) {
    for (const match of content.matchAll(pattern)) {
      const value = match[0]
      const syntheticFixture = permittedSyntheticSecrets.has(value)
        || value.includes('${')
        || value.includes('synthetic')
        || value.includes('example.invalid')
      if (!syntheticFixture) findings.push(`${name}:${rule}`)
    }
  }
  return findings
}

const packArgs = ['pack', '--json', '--pack-destination', packageDirectory]
const packOutput = process.env.npm_execpath === undefined
  ? run('pnpm', packArgs, { shell: process.platform === 'win32' })
  : run(process.execPath, [process.env.npm_execpath, ...packArgs])
const packed = JSON.parse(packOutput)
const packageFiles = packed.files.map(file => file.path).sort()
assert.deepEqual(packageFiles, [...expectedPackageFiles].sort(), 'candidate tarball file allowlist changed')

const tracked = run('git', ['ls-files', '-z']).split('\0').filter(Boolean)
const findings = []
for (const path of tracked) {
  const content = await readFile(resolve(root, path), 'utf8').catch(() => undefined)
  if (content !== undefined) findings.push(...scan(path, content))
}
for (const path of packageFiles) {
  const content = await readFile(resolve(root, path), 'utf8')
  findings.push(...scan(`package/${path}`, content))
}
assert.deepEqual([...new Set(findings)].sort(), [], 'secret-like material found in repository or package')

const synthetic = 'ghp_runtimeSyntheticValue123456789 deepseekKey=runtime-secret D:\\private\\workspace\\file.log'
const runtime = spawnSync(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(synthetic)})`], {
  cwd: root, encoding: 'utf8', windowsHide: true,
})
const safeLog = sanitizeDiagnostic(runtime.stderr)
assert.equal(safeLog.includes('ghp_runtimeSyntheticValue123456789'), false)
assert.equal(safeLog.includes('runtime-secret'), false)
assert.equal(safeLog.includes('D:\\private\\workspace'), false)
assert.ok(safeLog.length <= 4_096)

console.log(`CANDIDATE_PACKAGE_FILES=${String(packageFiles.length)}`)
console.log('CANDIDATE_SECRET_SCAN=PASS')
console.log('CANDIDATE_LOG_REDACTION=PASS')
console.log('CANDIDATE_VERIFY=PASS')
