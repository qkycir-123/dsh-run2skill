import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isSafeDiagnosticOutput,
  sanitizeDiagnostic,
} from '../support/safe-diagnostics.mjs'

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
  'AKIAABCDEFGHIJKLMNOP',
  'glpat-abcdefghijklmnopqrstuvwxyz123456',
  'xoxb-1234567890-synthetic-slack-token',
])
const syntheticFixtureFiles = new Set([
  'probes/candidate/verify.mjs',
  'tests/frozen-evaluation.spec.ts',
  'tests/observe-summary-rpc.spec.ts',
  'tests/redaction.spec.ts',
  'tests/trigger.spec.ts',
  'tests/turn-capture-processor.spec.ts',
])
const secretRules = [
  ['PRIVATE_KEY', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu],
  ['AUTHORIZATION', /\bauthorization[^\S\r\n]*:[^\S\r\n]*[^\r\n]*/giu],
  ['BEARER_TOKEN', /\bbearer\s+[a-z0-9._~+/=-]{8,}/giu],
  ['API_KEY', /\b(?:gh[pousr]_[a-z0-9]{20,}|glpat-[a-z0-9_-]{20,}|xox[baprs]-[a-z0-9-]{10,}|npm_[a-z0-9]{20,}|aiza[a-z0-9_-]{30,}|sk-[a-z0-9][a-z0-9_-]{18,}[a-z0-9]|(?:pk|rk)-(?:live|test)-[a-z0-9_-]{16,}|(?:akia|asia|aida|aroa|aipa|anpa|anva|asca)[a-z0-9]{16})\b/giu],
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
      const lowerValue = value.toLowerCase()
      const syntheticFixture = permittedSyntheticSecrets.has(value)
        || value.includes('[REDACTED]')
        || /^authorization\s*:\s*["']?authorization["']?;?$/iu.test(value.trim())
        || (syntheticFixtureFiles.has(name) && (
          value.includes('${')
          || lowerValue.includes('synthetic')
          || lowerValue.includes('invalid')
          || lowerValue.includes('runtime')
          || lowerValue.includes('example.invalid')
        ))
      if (!syntheticFixture) findings.push(`${name}:${rule}`)
    }
  }
  const assignment = /(?<![a-z0-9_-])["']?([a-z][a-z0-9_-]{0,127})["']?\s*[:=]\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;】}\]]+)/giu
  for (const match of content.matchAll(assignment)) {
    const key = match[1] ?? ''
    const normalized = key.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase()
    const parts = normalized.split(/[_-]+/u).filter(Boolean)
    const suffix = parts.at(-1)
    const sensitive = ['password', 'passwd', 'pwd', 'token', 'secret', 'credential'].includes(suffix ?? '')
      || (suffix === 'key' && parts.length > 1)
      || ['apikey', 'accesskey'].includes(normalized)
    if (!sensitive) continue
    const value = match[0]
    const assignedValue = (match[2] ?? '').trim()
    const literalValue = assignedValue.replace(/^["']|["']$/gu, '')
    const coordinateKey = ['signal_key', 'lifecycle_key', 'candidate_key'].includes(normalized)
    const selfDescribingConstant = literalValue.toLowerCase() === normalized
    const structuralValue = assignedValue.startsWith('{')
      || assignedValue.startsWith('[')
      || assignedValue.startsWith('(')
      || assignedValue.startsWith('/')
      || assignedValue.includes('(')
      || /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*(?:\([^)]*\))?$/u.test(assignedValue)
    const safeFixture = value.includes('${')
      || value.includes('[REDACTED]')
      || permittedSyntheticSecrets.has(literalValue)
      || (syntheticFixtureFiles.has(name) && (
        value.toLowerCase().includes('synthetic')
        || value.toLowerCase().includes('invalid')
        || value.toLowerCase().includes('runtime')
      ))
    if (!coordinateKey && !selfDescribingConstant && !structuralValue && !safeFixture) {
      findings.push(`${name}:SECRET_ASSIGNMENT:${normalized}`)
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

const synthetic = [
  'ghp_runtimeSyntheticValue123456789',
  'Authorization: Digest credential=runtime-auth signature=runtime-signature',
  'Authorization: Token runtime-token-auth',
  'Bearer runtimeBearerValue123456',
  'serviceCredential=runtime-credential',
  'genericToken=runtime-token',
  'password: runtime-alpha runtime-bravo runtime-charlie',
  'MY_SECRET=runtime-env-secret',
  'D:\\private\\workspace\\file.log',
  '/tmp/private/runtime.log',
  '/mnt/work/runtime.log',
  '/root/private/runtime.log',
  '/workspace/private/runtime.log',
  '/usr/local/private/runtime.log',
  '"D:\\private workspace\\runtime file.log"',
].join('\n')
const runtime = spawnSync(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(synthetic)})`], {
  cwd: root, encoding: 'utf8', windowsHide: true,
})
assert.equal(isSafeDiagnosticOutput(runtime.stderr), false)
const safeLog = sanitizeDiagnostic(runtime.stderr)
assert.equal(safeLog.includes('ghp_runtimeSyntheticValue123456789'), false)
assert.equal(safeLog.includes('runtime-secret'), false)
assert.equal(safeLog.includes('D:\\private\\workspace'), false)
assert.equal(safeLog.includes('/tmp/private'), false)
assert.equal(safeLog.includes('/mnt/work'), false)
assert.equal(safeLog.includes('/root/private'), false)
assert.equal(safeLog.includes('/workspace/private'), false)
assert.equal(safeLog.includes('/usr/local/private'), false)
assert.equal(safeLog.includes('private workspace'), false)
assert.equal(safeLog.includes('runtime-auth'), false)
assert.equal(safeLog.includes('runtime-credential'), false)
assert.equal(safeLog.includes('runtime-token'), false)
assert.equal(safeLog.includes('runtime-charlie'), false)
assert.equal(isSafeDiagnosticOutput(safeLog), true)

console.log(`CANDIDATE_PACKAGE_FILES=${String(packageFiles.length)}`)
console.log('CANDIDATE_SECRET_SCAN=PASS')
console.log('CANDIDATE_LOG_REDACTION=PASS')
console.log('CANDIDATE_VERIFY=PASS')
