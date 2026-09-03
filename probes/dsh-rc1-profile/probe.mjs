import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { access, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { dshWebArgs, dshWebHelp, supportsNoOpen } from '../install-lifecycle/web-args.mjs'

const [cloneArg, candidateArg, workArg] = process.argv.slice(2)
if (!cloneArg || !candidateArg || !workArg) {
  throw new Error('usage: node probe.mjs <built-dsh-clone> <candidate-root> <work-root>')
}

const clone = resolve(cloneArg)
const candidate = resolve(candidateArg)
const work = resolve(workArg)
const home = join(work, 'dsh-home')
const workspace = join(work, 'workspace')
const stages = join(work, 'stages')
const archives = join(work, 'archives')
const bin = join(clone, 'apps', 'cli', 'lib', 'bin.js')
const profile = join(home, 'profiles', 'web')
const manifestPath = join(profile, 'package.json')
const patchPath = join(profile, 'cordis.patch.yml')
const packageName = 'dsh-run2skill'
const privateRoots = [clone, candidate, work, home, workspace]
  .sort((left, right) => right.length - left.length)

function sanitize(value) {
  const browserCredentialPattern = new RegExp(`([?&]${['to', 'ken'].join('')}=)[^\\s)]+`, 'gu')
  let result = String(value).replace(browserCredentialPattern, '$1<redacted>')
  for (const privateRoot of privateRoots) {
    for (const form of new Set([privateRoot, privateRoot.replaceAll('\\', '/'), privateRoot.replaceAll('/', '\\')])) {
      result = result.split(form).join('<probe-path>')
    }
  }
  return result
}

const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)))
Object.assign(env, {
  DSH_AGENTS_HOME: join(work, '.agents'),
  DSH_HOME: home,
  DSH_TELEMETRY_DISABLED: '1',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  NODE_NO_WARNINGS: '1',
  SSH_CONNECTION: '',
  SSH_TTY: '',
})

await mkdir(workspace, { recursive: true })

async function run(executable, args, timeoutMs = 120_000, cwd = workspace) {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(sanitize(`process timeout: ${executable} ${args.join(' ')}`)))
    }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', code => {
      clearTimeout(timer)
      resolveResult({ code, stdout, stderr })
    })
  })
}

async function dsh(args) {
  const result = await run(process.execPath, [bin, ...args])
  if (result.code !== 0) {
    throw new Error(sanitize(`dsh ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`))
  }
  return result
}

async function stage(version) {
  const root = join(stages, version)
  await mkdir(root, { recursive: true })
  for (const entry of ['lib', 'cordis.patch.yml', 'README.md', 'README.en.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    await cp(join(candidate, entry), join(root, entry), { recursive: true })
  }
  const sourceManifest = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ ...sourceManifest, version }, null, 2))
  const archive = join(archives, version)
  await mkdir(archive, { recursive: true })
  const packed = process.platform === 'win32'
    ? await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm', 'pack', '--pack-destination', archive], 120_000, root)
    : await run('pnpm', ['pack', '--pack-destination', archive], 120_000, root)
  if (packed.code !== 0) throw new Error(sanitize(`candidate pack failed\n${packed.stderr}`))
  const tarballs = (await readdir(archive)).filter(entry => entry.endsWith('.tgz'))
  assert.equal(tarballs.length, 1)
  return join(archive, tarballs[0])
}

async function reservePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') return reject(new Error('port reservation failed'))
      server.close(error => error ? reject(error) : resolvePort(address.port))
    })
  })
}

async function startWeb() {
  const port = await reservePort()
  const webHelp = dshWebHelp(bin)
  const child = spawn(process.execPath, [bin, ...dshWebArgs(port, supportsNoOpen(webHelp))], {
    cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const launchUrl = await new Promise((resolveUrl, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(sanitize(`dsh web did not become ready\n${output}`)))
    }, 90_000)
    const append = chunk => {
      output = `${output}${String(chunk)}`.slice(-100_000)
      const match = /dsh web: (http:\/\/[^\s]+)/u.exec(output)
      if (settled || match?.[1] === undefined) return
      settled = true
      clearTimeout(timer)
      resolveUrl(match[1])
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', reject)
    child.once('exit', code => {
      if (!settled) reject(new Error(sanitize(`dsh web exited early (${String(code)})\n${output}`)))
    })
  })
  return { child, launchUrl, output: () => output }
}

async function stopWeb(running) {
  if (running.child.exitCode !== null) return
  const exited = new Promise(resolveExit => running.child.once('exit', resolveExit))
  running.child.kill('SIGTERM')
  const result = await Promise.race([exited.then(() => true), delay(10_000, false)])
  if (!result && running.child.exitCode === null) running.child.kill('SIGKILL')
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
  const running = await startWeb()
  let browser
  let browserContext
  try {
    const launchUrl = new URL(running.launchUrl)
    assert.match(launchUrl.searchParams.get('token') ?? '', /^[A-Za-z0-9_-]{43}$/u)
    const exchanged = await fetch(running.launchUrl, { redirect: 'manual' })
    assert.equal(exchanged.status, 303)
    const setCookie = exchanged.headers.get('set-cookie')
    assert.notEqual(setCookie, null)
    const cookie = setCookie.split(';', 1)[0]
    const headers = { cookie, host: launchUrl.host }
    const index = await fetch(launchUrl.origin, { headers })
    assert.equal(index.status, 200)
    const html = await index.text()
    assert.equal(html.includes(packageName), present)
    const bundlePath = new RegExp(`/plugins/\\?\\?${packageName}/client\\.js&rev=[A-Za-z0-9_-]+`, 'u')
      .exec(html)?.[0]
    assert.equal(bundlePath !== undefined, present)
    const bundle = await fetch(`${launchUrl.origin}${bundlePath ?? `/plugins/${packageName}/client.js`}`, { headers })
    assert.equal(bundle.status, present ? 200 : 404)

    const rpc = await fetch(`${launchUrl.origin}/api/run2skill/query`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'run2skill-rc1-profile',
        method: 'run2skill/query',
        payload: { args: { request: { endpoint: 'observe-summary', payload: { apiVersion: 1 } } } },
      }),
    })
    assert.equal(rpc.status, present ? 200 : 404)
    if (present) {
      const body = await rpc.json()
      assert.equal(body.type, 'server-response')
      assert.equal(body.rpcId, 'run2skill-rc1-profile')
      assert.equal(body.result?.ok, true)
      assert.equal(body.result?.value?.ok, true)
      assert.equal(body.result?.value?.value?.apiVersion, 1)

      browser = await chromium.launch({ headless: true, executablePath: await browserExecutable() })
      browserContext = await browser.newContext()
      const separator = cookie.indexOf('=')
      assert.ok(separator > 0)
      await browserContext.addCookies([{
        name: cookie.slice(0, separator),
        value: cookie.slice(separator + 1),
        url: launchUrl.origin,
      }])
      const page = await browserContext.newPage()
      const pageErrors = []
      page.on('pageerror', error => pageErrors.push(String(error)))
      await page.goto(launchUrl.origin, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await delay(2_000)
      assert.equal(pageErrors.filter(error => /run2skill/iu.test(error)).length, 0)
    }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${sanitize(running.output())}`, { cause: error })
  } finally {
    await browserContext?.close()
    await browser?.close()
    await stopWeb(running)
  }
}

const v1 = await stage('0.4.0-probe.1')
const v2 = await stage('0.4.0-probe.2')

console.log('CP_INS_RC1_STAGE=add')
await dsh(['plugin', '--profile', 'web', 'add', v1])
let manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
assert.ok(manifest.dsh.profile.bundles.includes(packageName))
assert.ok((await dsh(['--profile', 'web', '--dump-config'])).stdout.includes('id: run2skill'))
await observe(true)

console.log('CP_INS_RC1_STAGE=disable')
await writeFile(patchPath, '- id: run2skill\n  disabled: true\n')
await observe(false)

console.log('CP_INS_RC1_STAGE=upgrade')
await writeFile(patchPath, '[]\n')
await dsh(['plugin', '--profile', 'web', 'add', v2])
const installed = JSON.parse(await readFile(join(profile, 'node_modules', packageName, 'package.json'), 'utf8'))
assert.equal(installed.version, '0.4.0-probe.2')
await observe(true)
const retainedStorage = (await readdir(join(home, 'storages'))).filter(entry => /run2skill/iu.test(entry))
assert.ok(retainedStorage.length > 0)

console.log('CP_INS_RC1_STAGE=uninstall')
await dsh(['plugin', '--profile', 'web', 'remove', packageName])
manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
assert.equal(manifest.dsh.profile.bundles.includes(packageName), false)
assert.equal(Object.hasOwn(manifest.dependencies ?? {}, packageName), false)
await observe(false)
assert.deepEqual(
  (await readdir(join(home, 'storages'))).filter(entry => /run2skill/iu.test(entry)).sort(),
  retainedStorage.sort(),
)

console.log('CP_INS_RC1=PASS')
