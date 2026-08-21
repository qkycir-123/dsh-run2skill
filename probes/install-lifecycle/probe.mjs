import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import {
  access,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { dshWebArgs, dshWebHelp, supportsNoOpen } from './web-args.mjs'

const [cloneArg, fixtureRootArg, workRootArg] = process.argv.slice(2)
if (!cloneArg || !fixtureRootArg || !workRootArg) {
  throw new Error('usage: node probe.mjs <built-dsh-clone> <fixture-root> <work-root>')
}

const clone = resolve(cloneArg)
const fixtureRoot = resolve(fixtureRootArg)
const workRoot = resolve(workRootArg)
const home = join(workRoot, 'dsh-home')
const workspace = join(workRoot, 'workspace')
const privateRoots = [clone, fixtureRoot, workRoot, home, workspace]
  .sort((left, right) => right.length - left.length)

function sanitize(value) {
  let result = String(value)
  for (const privateRoot of privateRoots) {
    for (const form of new Set([privateRoot, privateRoot.replaceAll('\\', '/'), privateRoot.replaceAll('/', '\\')])) {
      result = result.split(form).join('<probe-path>')
    }
  }
  return result
}

process.on('uncaughtException', (error) => {
  console.error(sanitize(error?.stack ?? error))
  process.exitCode = 1
})
process.on('unhandledRejection', (reason) => {
  console.error(sanitize(reason?.stack ?? reason))
  process.exitCode = 1
})

const packageName = '@dsh-run2skill/install-probe'
const bin = join(clone, 'apps', 'cli', 'lib', 'bin.js')
const webHelp = dshWebHelp(bin)
const profileDir = join(home, 'profiles', 'web')
const profileManifestPath = join(profileDir, 'package.json')
const profilePatchPath = join(profileDir, 'cordis.patch.yml')
const hostMarkerPath = join(home, 'run2skill-install-probe.json')
const retainedSkillPath = join(home, 'skills', 'retained-skill', 'SKILL.md')
const retainedSkill = [
  '---',
  'name: retained-skill',
  'description: Skill retained across plugin lifecycle tests',
  'user-invocable: false',
  '---',
  '',
  'This file belongs to DSH, not the plugin package.',
  '',
].join('\n')

await mkdir(workspace, { recursive: true })
await mkdir(join(home, 'skills', 'retained-skill'), { recursive: true })
await writeFile(retainedSkillPath, retainedSkill)

const env = {
  ...process.env,
  DSH_HOME: home,
  NO_COLOR: '1',
  FORCE_COLOR: '0',
}

async function runProcess(executable, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? workspace,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(sanitize(`process timeout after ${timeoutMs}ms: ${executable} ${args.join(' ')}`)))
    }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(sanitize(error.message)))
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolveResult({ code, signal, stdout, stderr })
    })
  })
}

async function runDsh(args) {
  const result = await runProcess(process.execPath, [bin, ...args], { cwd: workspace })
  if (result.code !== 0) {
    throw new Error(sanitize([
      `dsh command failed (${String(result.code)}): ${args.join(' ')}`,
      result.stdout,
      result.stderr,
    ].join('\n')))
  }
  return result
}

async function manifest() {
  return JSON.parse(await readFile(profileManifestPath, 'utf8'))
}

function assertInstalled(profile, fixtureName) {
  assert.ok(profile.dependencies?.[packageName]?.includes(fixtureName), 'profile dependency does not point at expected fixture')
  assert.ok(profile.dsh?.profile?.bundles?.includes(packageName), 'bundle was not reconciled into the Web profile')
}

function assertUninstalled(profile) {
  assert.equal(profile.dependencies?.[packageName], undefined)
  assert.equal(profile.dsh?.profile?.bundles?.includes(packageName), false)
}

async function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('failed to reserve an IPv4 port'))
        return
      }
      server.close(error => error ? reject(error) : resolvePort(address.port))
    })
  })
}

async function waitForPage(url, child, logs) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(sanitize(`Web profile exited before readiness\n${logs.stdout}\n${logs.stderr}`))
    }
    try {
      const response = await fetch(url)
      if (response.ok) return response.text()
    } catch {
      // The listener is not ready yet.
    }
    await delay(200)
  }
  throw new Error(sanitize(`Web profile did not become ready\n${logs.stdout}\n${logs.stderr}`))
}

async function waitForFile(path, child, logs) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(sanitize(`Web profile exited before Host activation\n${logs.stdout}\n${logs.stderr}`))
    }
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await delay(100)
  }
  throw new Error('Host plugin did not activate before the bounded deadline')
}

async function stopWeb(child) {
  if (child.exitCode !== null) return
  child.kill()
  const exited = await Promise.race([
    new Promise(resolveExit => child.once('exit', resolveExit)),
    delay(5_000).then(() => false),
  ])
  if (exited === false && child.exitCode === null) child.kill('SIGKILL')
}

const requireFromWeb = createRequire(join(clone, 'apps', 'web', 'package.json'))
const { chromium } = requireFromWeb('playwright')

async function findBrowserExecutable() {
  const candidates = [
    chromium.executablePath(),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(value => typeof value === 'string')
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try the next installed browser.
    }
  }
  throw new Error('No Chromium-compatible browser executable is installed')
}

const browserExecutable = await findBrowserExecutable()

async function observeWeb({ expectedVersion, present }) {
  const port = await reservePort()
  const url = `http://127.0.0.1:${String(port)}/`
  const child = spawn(process.execPath, [bin, ...dshWebArgs(port, supportsNoOpen(webHelp))], {
    cwd: workspace,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = { stdout: '', stderr: '' }
  child.stdout.on('data', chunk => { logs.stdout += chunk.toString() })
  child.stderr.on('data', chunk => { logs.stderr += chunk.toString() })

  let browser
  try {
    const html = await waitForPage(url, child, logs)
    assert.equal(html.includes(packageName), present, 'boot graph package presence differs from expected state')

    if (present) {
      const bundleUrl = `${url}plugins/${packageName}/client.js`
      const bundleResponse = await fetch(bundleUrl)
      assert.equal(bundleResponse.status, 200)
      const bundle = await bundleResponse.text()
      assert.ok(bundle.includes(`= '${expectedVersion}'`), 'served Client bundle has the wrong version')

      const hostMarker = JSON.parse(await waitForFile(hostMarkerPath, child, logs))
      assert.deepEqual(hostMarker, {
        host: expectedVersion,
        storageDomain: true,
        workspaceRegistry: true,
        skills: true,
        userSkillRoot: join(home, 'skills'),
      })

      browser = await chromium.launch({
        headless: true,
        executablePath: browserExecutable,
      })
      const page = await browser.newPage()
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForFunction(
        version => globalThis.__DSH_RUN2SKILL_INSTALL_PROBE__ === version,
        expectedVersion,
        { timeout: 60_000 },
      )
      assert.equal(
        await page.evaluate(() => globalThis.__DSH_RUN2SKILL_INSTALL_PROBE__),
        expectedVersion,
      )
    } else {
      const response = await fetch(`${url}plugins/${packageName}/client.js`)
      assert.equal(response.status, 404)
    }
  } finally {
    await browser?.close()
    await stopWeb(child)
  }
}

const v1 = join(fixtureRoot, 'v1')
const v2 = join(fixtureRoot, 'v2')

console.log('CP_INS_STAGE=add-v1')
await runDsh(['plugin', '--profile', 'web', 'add', v1])
assertInstalled(await manifest(), 'v1')
const dumpV1 = await runDsh(['--profile', 'web', '--dump-config'])
assert.ok(dumpV1.stdout.includes('id: run2skill-install-probe'))
assert.ok(dumpV1.stdout.includes(packageName))
await observeWeb({ expectedVersion: 'v1', present: true })

console.log('CP_INS_STAGE=disable')
await writeFile(profilePatchPath, '- id: run2skill-install-probe\n  disabled: true\n')
await rm(hostMarkerPath, { force: true })
const disabledDump = await runDsh(['--profile', 'web', '--dump-config'])
assert.ok(/id: run2skill-install-probe[\s\S]*?disabled: true/.test(disabledDump.stdout))
await observeWeb({ expectedVersion: 'v1', present: false })
await assert.rejects(readFile(hostMarkerPath, 'utf8'), { code: 'ENOENT' })

console.log('CP_INS_STAGE=upgrade-v2')
await writeFile(profilePatchPath, '[]\n')
await runDsh(['plugin', '--profile', 'web', 'add', v2])
assertInstalled(await manifest(), 'v2')
await observeWeb({ expectedVersion: 'v2', present: true })

console.log('CP_INS_STAGE=uninstall')
await runDsh(['plugin', '--profile', 'web', 'remove', packageName])
assertUninstalled(await manifest())
const dumpRemoved = await runDsh(['--profile', 'web', '--dump-config'])
assert.equal(dumpRemoved.stdout.includes('id: run2skill-install-probe'), false)
await observeWeb({ expectedVersion: undefined, present: false })
assert.equal(await readFile(retainedSkillPath, 'utf8'), retainedSkill)

console.log('CP_INS_001=PASS')
