import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer as createNetServer } from 'node:net'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  isSafeDiagnosticOutput,
  safeFailure,
} from '../support/safe-diagnostics.mjs'
import { dshWebArgs, dshWebHelp, supportsNoOpen } from './web-args.mjs'

const [cloneArg, previousArchiveArg, candidateArchiveArg, workArg, expectedCandidateHash] = process.argv.slice(2)
if (!cloneArg || !previousArchiveArg || !candidateArchiveArg || !workArg || !expectedCandidateHash) {
  throw new Error('usage: node release-upgrade-probe.mjs <built-dsh-clone> <0.1.1-alpha.tgz> <0.2.0.tgz> <work-root> <candidate-sha256>')
}

const clone = resolve(cloneArg)
const previousArchive = resolve(previousArchiveArg)
const candidateArchive = resolve(candidateArchiveArg)
const work = resolve(workArg)
const home = join(work, 'dsh-home')
const workspace = join(work, 'workspace')
const profile = join(home, 'profiles', 'web')
const manifestPath = join(profile, 'package.json')
const installedManifestPath = join(profile, 'node_modules', 'dsh-run2skill', 'package.json')
const skillPath = join(home, 'skills', 'retained-release-skill', 'SKILL.md')
const bin = join(clone, 'apps', 'cli', 'lib', 'bin.js')
const webHelp = dshWebHelp(bin)
const env = { ...process.env, DSH_HOME: home, NO_COLOR: '1', FORCE_COLOR: '0' }
const retainedSkill = '---\nname: retained-release-skill\ndescription: retained across the stable upgrade\n---\n\nretained\n'

function archiveManifest(path) {
  const result = spawnSync('tar', ['-xOf', path, 'package/package.json'], {
    encoding: 'utf8', windowsHide: true,
  })
  if (result.status !== 0) throw new Error('unable to read package manifest from release archive')
  return JSON.parse(result.stdout)
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

const previousManifest = archiveManifest(previousArchive)
const candidateManifest = archiveManifest(candidateArchive)
assert.equal(previousManifest.name, 'dsh-run2skill')
assert.equal(previousManifest.version, '0.1.1-alpha')
assert.equal(candidateManifest.name, 'dsh-run2skill')
assert.equal(candidateManifest.version, '0.2.0')
assert.equal(await sha256(previousArchive), 'c674dad6102426054d59a2843270ee86aecd36789e83604c02dd6efd345fbb26')
assert.equal(await sha256(candidateArchive), expectedCandidateHash.toLowerCase())

await mkdir(workspace, { recursive: true })
await mkdir(join(home, 'skills', 'retained-release-skill'), { recursive: true })
await writeFile(skillPath, retainedSkill)

async function run(executable, args, timeoutMs = 120_000) {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    const timer = setTimeout(() => { child.kill(); reject(new Error('release upgrade process timed out')) }, timeoutMs)
    child.on('error', reject)
    child.on('exit', code => {
      clearTimeout(timer)
      resolveResult({ code, stdout, stderr })
    })
  })
}

async function dsh(args) {
  const result = await run(process.execPath, [bin, ...args])
  if (result.code !== 0) throw new Error(safeFailure(
    `release upgrade dsh command failed (${args[0] ?? 'unknown'})`,
    result.stderr,
  ))
  return result
}

async function installedVersion() {
  return JSON.parse(await readFile(installedManifestPath, 'utf8')).version
}

async function reservePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createNetServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') return reject(new Error('port reservation failed'))
      server.close(error => error ? reject(error) : resolvePort(address.port))
    })
  })
}

async function stop(child) {
  const hasExited = () => child.exitCode !== null || child.signalCode !== null
  if (hasExited()) return
  child.kill()
  await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), delay(5_000)])
  if (hasExited()) return
  child.kill('SIGKILL')
  await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), delay(5_000)])
  if (!hasExited()) throw new Error('release upgrade Web did not exit after SIGKILL')
}

async function waitForOutputClose(stream) {
  if (stream.closed) return
  const closed = await Promise.race([
    new Promise(resolveClose => stream.once('close', () => resolveClose(true))),
    delay(5_000, false),
  ])
  if (!closed || !stream.closed) throw new Error('release upgrade Web output did not close')
}

async function observeWeb(expectCurrentRpc) {
  const port = await reservePort()
  const base = `http://127.0.0.1:${String(port)}`
  const child = spawn(process.execPath, [bin, ...dshWebArgs(port, supportsNoOpen(webHelp))], {
    cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', chunk => { logs += chunk.toString() })
  child.stderr.on('data', chunk => { logs += chunk.toString() })
  try {
    const deadline = Date.now() + 60_000
    let html
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(safeFailure('release upgrade Web exited early', logs))
      }
      try {
        const response = await fetch(`${base}/`)
        if (response.ok) { html = await response.text(); break }
      } catch { /* wait */ }
      await delay(200)
    }
    assert.equal(typeof html, 'string', 'release upgrade Web was not ready')
    assert.equal(html.includes('dsh-run2skill'), true)
    const bundle = await fetch(`${base}/plugins/dsh-run2skill/client.js`)
    assert.equal(bundle.status, 200)
    if (expectCurrentRpc) {
      const rpc = await fetch(`${base}/run2skill/observe-summary`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'stable-release-upgrade', method: 'observe-summary',
          payload: { apiVersion: 1 },
        }),
      })
      assert.equal(rpc.status, 200)
      const body = await rpc.json()
      assert.equal(body.result?.ok, true)
    }
  } finally {
    await stop(child)
    await Promise.all([waitForOutputClose(child.stdout), waitForOutputClose(child.stderr)])
  }
  assert.equal(
    isSafeDiagnosticOutput(logs),
    true,
    safeFailure('release upgrade runtime log gate failed', logs),
  )
}

console.log('CP_RELEASE_UPGRADE_STAGE=install-0.1.1-alpha')
await dsh(['plugin', '--profile', 'web', 'add', previousArchive])
assert.equal(await installedVersion(), '0.1.1-alpha')
await observeWeb(true)
const storageDirectory = join(home, 'storages')
const v1Name = (await readdir(storageDirectory)).find(name => /^run2skill_v1.*\.json$/u.test(name))
assert.ok(v1Name, '0.1.1-alpha did not create its v1 storage domain')
const v1Path = join(storageDirectory, v1Name)
const v1Before = await readFile(v1Path)

console.log('CP_RELEASE_UPGRADE_STAGE=upgrade-0.2.0')
await dsh(['plugin', '--profile', 'web', 'add', candidateArchive])
assert.equal(await installedVersion(), '0.2.0')
await observeWeb(true)
assert.deepEqual(await readFile(v1Path), v1Before, '0.2.0 modified the retained Alpha v1 storage')
const v2 = JSON.parse(await readFile(join(storageDirectory, 'run2skill_v2.json'), 'utf8'))
assert.equal(v2.unit?.name, 'run2skill_v2')
assert.equal(v2.unit?.version, 1)
assert.equal(v2.global?.migration?.source?.domainName, 'run2skill_v1')
assert.equal(v2.global?.migration?.phase, 'COMMITTED')
assert.equal(v2.global?.migration?.counts?.workItems, 0)
assert.equal(v2.global?.migration?.counts?.lineages, 0)
assert.equal(Object.keys(v2.tables?.legacy_items ?? {}).length, 0)
assert.equal(await readFile(skillPath, 'utf8'), retainedSkill)

console.log('CP_RELEASE_UPGRADE_STAGE=uninstall-0.2.0')
await dsh(['plugin', '--profile', 'web', 'remove', 'dsh-run2skill'])
const removedManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
assert.equal(removedManifest.dsh.profile.bundles.includes('dsh-run2skill'), false)
assert.equal(Object.hasOwn(removedManifest.dependencies ?? {}, 'dsh-run2skill'), false)
await assert.rejects(access(join(profile, 'node_modules', 'dsh-run2skill')), error => error?.code === 'ENOENT')
assert.deepEqual(await readFile(v1Path), v1Before, 'uninstall modified the retained Alpha v1 storage')
await access(join(storageDirectory, 'run2skill_v2.json'))
assert.equal(await readFile(skillPath, 'utf8'), retainedSkill)

console.log(`CP_RELEASE_PREVIOUS_SHA256=${await sha256(previousArchive)}`)
console.log(`CP_RELEASE_CANDIDATE_SHA256=${await sha256(candidateArchive)}`)
console.log('CP_RELEASE_UPGRADE=PASS')
