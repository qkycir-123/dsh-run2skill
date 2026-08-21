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
  'THIRD_PARTY_NOTICES.md',
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
const permittedFixtureLocations = new Set([
  ['probes/support/safe-diagnostics.mjs', 'AUTHORIZATION', 38],
  ['probes/support/safe-diagnostics.mjs', 'SECRET_ASSIGNMENT', 'provider_credential', 3],
  ['src/domain/observe/redaction.ts', 'AUTHORIZATION', 112],
  ['tests/frozen-evaluation.spec.ts', 'SECRET_ASSIGNMENT', 'synthetic_secret', 71],
  ['tests/observe-summary-rpc.spec.ts', 'SECRET_ASSIGNMENT', 'token', 60],
  ['tests/redaction.spec.ts', 'AUTHORIZATION', 13],
  ['tests/redaction.spec.ts', 'AUTHORIZATION', 81],
  ['tests/redaction.spec.ts', 'AUTHORIZATION', 84],
  ['tests/redaction.spec.ts', 'AUTHORIZATION', 87],
  ['tests/redaction.spec.ts', 'AUTHORIZATION', 89],
  ['tests/redaction.spec.ts', 'CREDENTIAL_URL', 27],
  ['tests/redaction.spec.ts', 'CREDENTIAL_URL', 62],
  ['tests/redaction.spec.ts', 'CREDENTIAL_URL', 72],
  ['tests/redaction.spec.ts', 'PRIVATE_KEY', 24],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'access_token', 167],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'api_key', 21],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'api_key', 26],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'aws_secret_access_key', 169],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'client_secret', 146],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'client_secret', 157],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'client_secret', 161],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'client_secret', 162],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'database_password', 168],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'deepseek_key', 144],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'deepseek_key', 145],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'deepseek_key', 165],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'encoded_secret', 71],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'github_token', 148],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'github_token', 159],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'github_token', 164],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'password', 20],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'password', 25],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'password', 106],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'password', 160],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'refresh_token', 147],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'refresh_token', 158],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'refresh_token', 163],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'secret', 9],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'secret', 53],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'secret', 60],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'secret', 94],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'service_credential', 166],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'token', 97],
  ['tests/redaction.spec.ts', 'SECRET_ASSIGNMENT', 'url_password', 22],
  ['tests/trigger.spec.ts', 'CREDENTIAL_URL', 78],
  ['tests/trigger.spec.ts', 'SECRET_ASSIGNMENT', 'access_token', 139],
  ['tests/trigger.spec.ts', 'SECRET_ASSIGNMENT', 'aws_secret_access_key', 141],
  ['tests/trigger.spec.ts', 'SECRET_ASSIGNMENT', 'client_secret', 111],
  ['tests/trigger.spec.ts', 'SECRET_ASSIGNMENT', 'client_secret', 130],
  ['tests/trigger.spec.ts', 'SECRET_ASSIGNMENT', 'client_secret', 134],
  ['tests/trigger.spec.ts', 'SECRET_ASSIGNMENT', 'database_password', 140],
  ['tests/trigger.spec.ts', 'SECRET_ASSIGNMENT', 'deepseek_key', 110],
  ['tests/trigger.spec.ts', 'SECRET_ASSIGNMENT', 'deepseek_key', 137],
  ['tests/trigger.spec.ts', 'SECRET_ASSIGNMENT', 'github_token', 113],
  ['tests/trigger.spec.ts', 'SECRET_ASSIGNMENT', 'github_token', 132],
  ['tests/trigger.spec.ts', 'SECRET_ASSIGNMENT', 'github_token', 136],
  ['tests/trigger.spec.ts', 'SECRET_ASSIGNMENT', 'password', 133],
  ['tests/trigger.spec.ts', 'SECRET_ASSIGNMENT', 'refresh_token', 112],
  ['tests/trigger.spec.ts', 'SECRET_ASSIGNMENT', 'refresh_token', 131],
  ['tests/trigger.spec.ts', 'SECRET_ASSIGNMENT', 'refresh_token', 135],
  ['tests/trigger.spec.ts', 'SECRET_ASSIGNMENT', 'secret', 34],
  ['tests/trigger.spec.ts', 'SECRET_ASSIGNMENT', 'secret', 77],
  ['tests/trigger.spec.ts', 'SECRET_ASSIGNMENT', 'secret', 82],
  ['tests/trigger.spec.ts', 'SECRET_ASSIGNMENT', 'secret', 87],
  ['tests/trigger.spec.ts', 'SECRET_ASSIGNMENT', 'service_credential', 138],
  ['tests/turn-capture-processor.spec.ts', 'SECRET_ASSIGNMENT', 'secret', 81],
].map(parts => parts.join(':')))
const secretRules = [
  ['PRIVATE_KEY', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu],
  ['AUTHORIZATION', /\bauthorization[^\S\r\n]*:[^\S\r\n]*[^\r\n]*/giu],
  ['BEARER_TOKEN', /\bbearer\s+[a-z0-9._~+/=-]{8,}/giu],
  ['API_KEY', /\b(?:gh[pousr]_[a-z0-9]{20,}|glpat-[a-z0-9_-]{20,}|xox[baprs]-[a-z0-9-]{10,}|npm_[a-z0-9]{20,}|aiza[a-z0-9_-]{30,}|sk-[a-z0-9][a-z0-9_-]{18,}[a-z0-9]|(?:pk|rk)-(?:live|test)-[a-z0-9_-]{16,}|(?:akia|asia|aida|aroa|aipa|anpa|anva|asca)[a-z0-9]{16})\b/giu],
  ['CREDENTIAL_URL', /https?:\/\/[^\s/:]+:[^\s/@]+@/gu],
]
const localPathRules = [
  ['WINDOWS_HOME', /\b[a-z]:[\\/](?:users|data|home|tmp)[\\/][^\s"'`<>]*/giu],
  ['POSIX_HOME', /\/(?:home\/[^/\s]+|users\/[^/\s]+|mnt\/[a-z]\/|root\/)[^\s"'`<>]*/giu],
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
      const line = content.slice(0, match.index).split('\n').length
      const location = `${name}:${rule}:${String(line)}`
      const sourceLine = content.split('\n')[line - 1]?.trim() ?? ''
      const bundledAuthorizationRedactor = name === 'package/lib/index.js'
        && rule === 'AUTHORIZATION'
        && sourceLine.startsWith('replace(/\\bauthorization')
        && sourceLine.endsWith('"authori' + 'zation: [REDACTED]");')
      const syntheticFixture = permittedSyntheticSecrets.has(value)
        || (rule === 'AUTHORIZATION'
          && /^authorization\s*:\s*\[REDACTED\]$/iu.test(value.trim()))
        || /^authorization\s*:\s*["']?authorization["']?;?$/iu.test(value.trim())
        || bundledAuthorizationRedactor
        || permittedFixtureLocations.has(location)
      if (!syntheticFixture) findings.push(location)
    }
  }
  const assignment = /(?<![a-z0-9_-])["']?([a-z][a-z0-9_-]{0,127})["']?\s*[:=]\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;】}\]]+)/giu
  for (const match of content.matchAll(assignment)) {
    const key = match[1] ?? ''
    const line = content.slice(0, match.index).split('\n').length
    const normalized = key.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase()
    const parts = normalized.split(/[_-]+/u).filter(Boolean)
    const suffix = parts.at(-1)
    const sensitive = ['password', 'passwd', 'pwd', 'token', 'secret', 'credential'].includes(suffix ?? '')
      || (suffix === 'key' && parts.length > 1)
      || ['apikey', 'accesskey'].includes(normalized)
    if (!sensitive) continue
    const assignedValue = (match[2] ?? '').trim()
    const literalValue = assignedValue.replace(/^["']|["']$/gu, '')
    const coordinateKey = [
      'candidate_key',
      'coordinate_key',
      'action_key',
      'lifecycle_key',
      'notice_key',
      'session_lifecycle_key',
      'signal_key',
    ].includes(normalized)
    const selfDescribingConstant = literalValue.toLowerCase() === normalized
    const location = `${name}:SECRET_ASSIGNMENT:${normalized}:${String(line)}`
    const safeFixture = literalValue === '[REDACTED]'
      || permittedSyntheticSecrets.has(literalValue)
      || permittedFixtureLocations.has(location)
    if (!coordinateKey && !selfDescribingConstant && !safeFixture) {
      findings.push(location)
    }
  }
  return findings
}

function scanLocalPaths(name, content) {
  const findings = []
  for (const [rule, pattern] of localPathRules) {
    for (const match of content.matchAll(pattern)) {
      const line = content.slice(0, match.index).split('\n').length
      findings.push(`${name}:${rule}:${String(line)}`)
    }
  }
  return findings
}

const rejectedAssignmentSamples = [
  ['pass' + 'word=ordinaryvalue123', 'SECRET_ASSIGNMENT'],
  ['deepseek_' + 'key=ordinaryvalue123', 'SECRET_ASSIGNMENT'],
  ['api_' + 'key=/ordinary/value', 'SECRET_ASSIGNMENT'],
  ['Authori' + 'zation: Token ordinaryvalue123', 'AUTHORIZATION'],
  ['pass' + 'word=[REDACTED]ordinaryvalue123', 'SECRET_ASSIGNMENT'],
  ['Authori' + 'zation: Bearer [REDACTED]ordinaryvalue123', 'AUTHORIZATION'],
]
for (const [sample, expectedRule] of rejectedAssignmentSamples) {
  assert.equal(
    scan('negative.fixture', sample).some(finding => finding.includes(`:${expectedRule}:`)),
    true,
    `candidate scanner must reject ${expectedRule}`,
  )
}

const packArgs = ['pack', '--json', '--pack-destination', packageDirectory]
const packOutput = process.env.npm_execpath === undefined
  ? run('pnpm', packArgs, { shell: process.platform === 'win32' })
  : run(process.execPath, [process.env.npm_execpath, ...packArgs])
const packed = JSON.parse(packOutput)
const packageFiles = packed.files.map(file => file.path).sort()
assert.deepEqual(packageFiles, [...expectedPackageFiles].sort(), 'candidate tarball file allowlist changed')
const tarballPath = resolve(root, packed.filename)
const archiveFiles = run('tar', ['-tzf', tarballPath])
  .split(/\r?\n/u)
  .filter(path => path.startsWith('package/') && !path.endsWith('/'))
  .map(path => path.slice('package/'.length))
  .sort()
assert.deepEqual(archiveFiles, [...expectedPackageFiles].sort(), 'candidate archive entries changed')

const packedManifest = JSON.parse(run('tar', ['-xOf', tarballPath, 'package/package.json']))
assert.deepEqual({
  name: packedManifest.name,
  version: packedManifest.version,
  private: packedManifest.private,
  license: packedManifest.license,
  files: packedManifest.files,
  repository: packedManifest.repository,
  bugs: packedManifest.bugs,
  homepage: packedManifest.homepage,
  publishConfig: packedManifest.publishConfig,
  exports: packedManifest.exports,
  dsh: packedManifest.dsh,
  peerDependencies: packedManifest.peerDependencies,
}, {
  name: 'dsh-run2skill',
  version: '0.1.0-alpha',
  private: undefined,
  license: 'MIT',
  files: ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
  repository: {
    type: 'git',
    url: 'git+https://github.com/qkycir-123/dsh-run2skill.git',
  },
  bugs: { url: 'https://github.com/qkycir-123/dsh-run2skill/issues' },
  homepage: 'https://github.com/qkycir-123/dsh-run2skill#readme',
  publishConfig: { access: 'public', tag: 'alpha' },
  exports: {
    '.': { types: './lib/index.d.ts', default: './lib/index.js' },
    './client': { default: './lib/client.js' },
    './package.json': './package.json',
  },
  dsh: {
    bundle: { patch: './cordis.patch.yml' },
    client: {
      platform: 'web',
      inject: [
        '@deepseek-ai/dsh-client-connection',
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-primitives',
        '@deepseek-ai/dsh-client-ui-settings',
        '@deepseek-ai/dsh-client-ui-settings-plugins',
        '@deepseek-ai/dsh-api-remotes',
      ],
    },
  },
  peerDependencies: {
    '@deepseek-ai/dsh-agent-presets': '0.1.0-rc.7 || 0.1.0-rc.8',
    '@deepseek-ai/dsh-client-ui-primitives': '0.1.0-rc.7 || 0.1.0-rc.8',
  },
}, 'candidate package metadata changed')
assert.equal(
  run('tar', ['-xOf', tarballPath, 'package/cordis.patch.yml']).replaceAll('\r\n', '\n'),
  '- insert:\n    - id: run2skill\n      name: dsh-run2skill\n',
  'candidate bundle patch does not match the package identity',
)
const thirdPartyNotices = run('tar', ['-xOf', tarballPath, 'package/THIRD_PARTY_NOTICES.md'])
assert.match(thirdPartyNotices, /Zod 4\.4\.3/u)
assert.match(thirdPartyNotices, /Copyright \(c\) 2025 Colin McDonnell/u)
assert.match(thirdPartyNotices, /The above copyright notice and this permission notice/u)

const tracked = run('git', ['ls-files', '-z']).split('\0').filter(Boolean)
const findings = []
for (const path of tracked) {
  const content = await readFile(resolve(root, path), 'utf8').catch(() => undefined)
  if (content !== undefined) findings.push(...scan(path, content))
}
for (const path of packageFiles) {
  const content = run('tar', ['-xOf', tarballPath, `package/${path}`])
  findings.push(...scan(`package/${path}`, content))
  findings.push(...scanLocalPaths(`package/${path}`, content))
}
assert.deepEqual([...new Set(findings)].sort(), [], 'secret-like material found in repository or package')

const synthetic = [
  'ghp_runtimeSyntheticValue123456789',
  'Authori' + 'zation: Digest credential=runtime-auth signature=runtime-signature',
  'Authori' + 'zation: Token runtime-token-auth',
  'Bear' + 'er runtimeBearerValue123456',
  'serviceCreden' + 'tial=runtime-credential',
  'genericTok' + 'en=runtime-token',
  'pass' + 'word: runtime-alpha runtime-bravo runtime-charlie',
  'MY_SEC' + 'RET=runtime-env-secret',
  'D:\\private\\workspace\\file.log',
  '/tmp/private/runtime.log',
  '/mnt/work/runtime.log',
  '/root/private/runtime.log',
  '/workspace/private/runtime.log',
  '/usr/local/private/runtime.log',
  '"D:\\private workspace\\runtime file.log"',
  '\\\\server\\share\\runtime file.log',
  'C:/Users/private/runtime.log',
  '/single',
].join('\n')
const runtime = spawnSync(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(synthetic)})`], {
  cwd: root, encoding: 'utf8', windowsHide: true,
})
assert.equal(isSafeDiagnosticOutput(runtime.stderr), false)
const safeLog = sanitizeDiagnostic(runtime.stderr)
assert.equal(sanitizeDiagnostic('dsh web: http://127.0.0.1:1234'), 'dsh web: http://127.0.0.1:1234')
assert.equal(safeLog.includes('ghp_runtimeSyntheticValue123456789'), false)
assert.equal(safeLog.includes('runtime-secret'), false)
assert.equal(safeLog.includes('D:\\private\\workspace'), false)
assert.equal(safeLog.includes('/tmp/private'), false)
assert.equal(safeLog.includes('/mnt/work'), false)
assert.equal(safeLog.includes('/root/private'), false)
assert.equal(safeLog.includes('/workspace/private'), false)
assert.equal(safeLog.includes('/usr/local/private'), false)
assert.equal(safeLog.includes('private workspace'), false)
assert.equal(safeLog.includes('server\\share'), false)
assert.equal(safeLog.includes('C:/Users'), false)
assert.equal(safeLog.includes('/single'), false)
assert.equal(safeLog.includes('runtime-auth'), false)
assert.equal(safeLog.includes('runtime-credential'), false)
assert.equal(safeLog.includes('runtime-token'), false)
assert.equal(safeLog.includes('runtime-charlie'), false)
assert.equal(isSafeDiagnosticOutput(safeLog), true)

console.log(`CANDIDATE_PACKAGE_FILES=${String(packageFiles.length)}`)
console.log('CANDIDATE_THIRD_PARTY_LICENSES=PASS')
console.log('CANDIDATE_METADATA=PASS')
console.log('CANDIDATE_LOCAL_PATH_SCAN=PASS')
console.log('CANDIDATE_SECRET_SCAN=PASS')
console.log('CANDIDATE_LOG_REDACTION=PASS')
console.log('CANDIDATE_VERIFY=PASS')
