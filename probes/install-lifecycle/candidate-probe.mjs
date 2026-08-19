import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { access, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { safeFailure } from '../support/safe-diagnostics.mjs'

const [cloneArg, candidateArg, workArg] = process.argv.slice(2)
if (!cloneArg || !candidateArg || !workArg) {
  throw new Error('usage: node candidate-probe.mjs <built-dsh-clone> <candidate-root> <work-root>')
}

const clone = resolve(cloneArg)
const candidate = resolve(candidateArg)
const work = resolve(workArg)
const home = join(work, 'dsh-home')
const workspace = join(work, 'workspace')
const stages = join(work, 'stages')
const bin = join(clone, 'apps', 'cli', 'lib', 'bin.js')
const profile = join(home, 'profiles', 'web')
const manifestPath = join(profile, 'package.json')
const patchPath = join(profile, 'cordis.patch.yml')
const skillPath = join(home, 'skills', 'retained-skill', 'SKILL.md')
const packageName = 'dsh-run2skill'
const retainedSkill = '---\nname: retained-skill\ndescription: retained lifecycle fixture\n---\n\nretained\n'

await mkdir(workspace, { recursive: true })
await mkdir(join(home, 'skills', 'retained-skill'), { recursive: true })
await writeFile(skillPath, retainedSkill)

async function stage(version) {
  const root = join(stages, version)
  await mkdir(root, { recursive: true })
  await cp(join(candidate, 'lib'), join(root, 'lib'), { recursive: true })
  await cp(join(candidate, 'cordis.patch.yml'), join(root, 'cordis.patch.yml'))
  const manifest = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ ...manifest, version }, null, 2))
  return root
}

const v1 = await stage('0.0.0-a6.1')
const v2 = await stage('0.0.0-a6.2')
const env = { ...process.env, DSH_HOME: home, NO_COLOR: '1', FORCE_COLOR: '0' }

async function run(executable, args, timeoutMs = 120_000) {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    const timer = setTimeout(() => { child.kill(); reject(new Error('candidate process timed out')) }, timeoutMs)
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
    `candidate dsh command failed (${args[0] ?? 'unknown'})`,
    result.stderr,
  ))
  return result
}

async function manifest() {
  return JSON.parse(await readFile(manifestPath, 'utf8'))
}

async function reservePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') return reject(new Error('port reservation failed'))
      server.close(error => error ? reject(error) : resolvePort(address.port))
    })
  })
}

async function stop(child) {
  if (child.exitCode !== null) return
  child.kill()
  await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), delay(5_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

const requireFromWeb = createRequire(join(clone, 'apps', 'web', 'package.json'))
const { chromium } = requireFromWeb('playwright')
async function browserExecutable() {
  const candidates = [
    chromium.executablePath(),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  for (const path of candidates) {
    try { await access(path); return path } catch { /* continue */ }
  }
  throw new Error('No Chromium-compatible browser executable is installed')
}

async function observe(present) {
  const port = await reservePort()
  const base = `http://127.0.0.1:${String(port)}`
  const child = spawn(process.execPath, [bin, 'web', '--port', String(port)], {
    cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', chunk => { logs += chunk.toString() })
  child.stderr.on('data', chunk => { logs += chunk.toString() })
  let browser
  try {
    const deadline = Date.now() + 60_000
    let html
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(safeFailure('candidate Web exited early', logs))
      try {
        const response = await fetch(`${base}/`)
        if (response.ok) { html = await response.text(); break }
      } catch { /* wait */ }
      await delay(200)
    }
    assert.equal(typeof html, 'string', 'candidate Web was not ready')
    assert.equal(html.includes(packageName), present)
    const bundle = await fetch(`${base}/plugins/${packageName}/client.js`)
    assert.equal(bundle.status, present ? 200 : 404)
    const rpcRequest = () => fetch(`${base}/run2skill/observe-summary`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'a6-candidate', method: 'observe-summary',
        payload: { apiVersion: 1 },
      }),
    })
    let rpc = await rpcRequest()
    const rpcDeadline = Date.now() + 30_000
    while (present && rpc.status !== 200 && Date.now() < rpcDeadline) {
      await delay(100)
      rpc = await rpcRequest()
    }
    if (present) assert.equal(rpc.status, 200)
    else assert.notEqual(rpc.status, 200)
    if (present) {
      const body = await rpc.json()
      assert.equal(body.result?.ok, true)
      assert.equal(body.result?.value?.capturedCount, 0)
      browser = await chromium.launch({ headless: true, executablePath: await browserExecutable() })
      const page = await browser.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(String(error)))
      await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await delay(2_000)
      assert.equal(errors.filter(error => /run2skill/iu.test(error)).length, 0)
    }
  } finally {
    await browser?.close()
    await stop(child)
  }
}

console.log('CP_INS_A6_STAGE=add')
await dsh(['plugin', '--profile', 'web', 'add', v1])
assert.ok((await manifest()).dsh.profile.bundles.includes(packageName))
assert.ok((await dsh(['--profile', 'web', '--dump-config'])).stdout.includes('id: run2skill'))
await observe(true)

console.log('CP_INS_A6_STAGE=disable')
await writeFile(patchPath, '- id: run2skill\n  disabled: true\n')
await observe(false)

console.log('CP_INS_A6_STAGE=upgrade')
await writeFile(patchPath, '[]\n')
await dsh(['plugin', '--profile', 'web', 'add', v2])
const installedManifest = JSON.parse(await readFile(join(profile, 'node_modules', packageName, 'package.json'), 'utf8'))
assert.equal(installedManifest.version, '0.0.0-a6.2')
await observe(true)

const storageEntries = await readdir(join(home, 'storages'))
assert.ok(storageEntries.some(entry => /run2skill/iu.test(entry)), 'run2skill domain was not retained')

console.log('CP_INS_A6_STAGE=uninstall')
await dsh(['plugin', '--profile', 'web', 'remove', packageName])
assert.equal((await manifest()).dsh.profile.bundles.includes(packageName), false)
await observe(false)
assert.equal(await readFile(skillPath, 'utf8'), retainedSkill)
console.log('CP_INS_A6=PASS')
