import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { access, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const [exeArg, candidateArg, workArg, playwrightArg] = process.argv.slice(2)
if (!exeArg || !candidateArg || !workArg || !playwrightArg || process.platform !== 'win32') {
  throw new Error('usage (Windows): node probe.mjs <official-extracted-exe> <candidate-root> <new-work-root> <playwright-module>')
}
const exe = resolve(exeArg), candidate = resolve(candidateArg), work = resolve(workArg)
await access(exe)
await mkdir(work) // Existing data is never reused by this lifecycle probe.
// A nested profile must never join the candidate repository's pnpm workspace.
await writeFile(join(work, 'pnpm-workspace.yaml'), 'packages:\n  - home/profiles/*\n')
const home = join(work, 'home'), workspace = join(work, 'workspace')
const profile = join(home, 'profiles', 'desktop'), patchPath = join(profile, 'cordis.patch.yml')
const { chromium } = await import(pathToFileURL(resolve(playwrightArg)).href)
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/KEY|SECRET|TOKEN|PASSWORD|NODE_OPTIONS|ELECTRON_RUN_AS_NODE/iu.test(name)))
Object.assign(env, { DSH_HOME: home, DSH_AGENTS_HOME: join(work, 'agents'), DSH_TELEMETRY_DISABLED: '1' })
const browserCredentialPattern = new RegExp(`([?&]${['to', 'ken'].join('')}=)[^\\s)]+`, 'gu')
const sanitize = value => String(value).replace(browserCredentialPattern, '$1<redacted>')
const protocolSnapshot = () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "if(Test-Path -LiteralPath 'HKCU:\\Software\\Classes\\dsh'){@(Get-Item -LiteralPath 'HKCU:\\Software\\Classes\\dsh'; Get-ChildItem -LiteralPath 'HKCU:\\Software\\Classes\\dsh' -Recurse) | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } | ConvertTo-Json -Depth 8 -Compress}"],
  { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, 'protocol association snapshot failed')
  return result.stdout
}
const originalProtocol = protocolSnapshot()
for (const name of ['browser-data', 'session-data', 'logs', 'crash-dumps', 'workspace', 'documents']) {
  await mkdir(join(work, name), { recursive: true })
}
// DSH locates PROJECT roots by the nearest Git boundary, including ancestors.
const initialized = spawnSync('git', ['init', workspace], { encoding: 'utf8', windowsHide: true })
assert.equal(initialized.status, 0, 'isolated Git workspace initialization failed')
await mkdir(profile, { recursive: true })
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', private: true,
  dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2))
await writeFile(patchPath, `- id: workspace-controller\n  config:\n    documentsDirectory: ${JSON.stringify(join(work, 'documents'))}\n- id: ui-settings-account\n  config:\n    version: 1\n    step: done\n    usage: detailed\n    developerTools: true\n    purpose: null\n    process: standard\n    completion: api-key\n`)

async function freePort() {
  const server = createServer()
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  await new Promise(r => server.close(r))
  return port
}

async function desktop(check) {
  const mainPort = await freePort(), rendererPort = await freePort()
  const child = spawn(exe, [`--user-data-dir=${join(work, 'browser-data')}`,
    `--remote-debugging-port=${rendererPort}`, `--inspect-brk=127.0.0.1:${mainPort}`],
  { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = '', socket, browser, id = 0
  const pending = new Map()
  const call = (method, params = {}) => new Promise((resolveCall, reject) => {
    const requestId = ++id
    const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error('main debugger request timed out')) }, 15_000)
    pending.set(requestId, { resolve: value => { clearTimeout(timeout); resolveCall(value) },
      reject: error => { clearTimeout(timeout); reject(error) } })
    socket.send(JSON.stringify({ id: requestId, method, params }))
  })
  child.stdout.on('data', data => { log += sanitize(data) })
  child.stderr.on('data', data => { log += sanitize(data) })
  try {
    let target
    for (let n = 0; n < 100; n++) {
      assert.equal(child.exitCode, null, 'Desktop exited before debugger startup')
      try { target = (await (await fetch(`http://127.0.0.1:${mainPort}/json/list`)).json())[0]; break } catch { await delay(200) }
    }
    assert.ok(target, 'main debugger did not start')
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((r, reject) => { socket.onopen = r; socket.onerror = reject })
    let pauseResolve
    const paused = new Promise(r => { pauseResolve = r })
    socket.onmessage = event => {
      const message = JSON.parse(event.data)
      if (message.method === 'Debugger.paused') pauseResolve(message.params)
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id)
      if (message.error) request.reject(new Error(JSON.stringify(message.error)))
      else request.resolve(message.result)
    }
    await call('Debugger.enable')
    await call('Debugger.setBreakpointByUrl', { urlRegex: 'app\\.asar[/\\\\]lib[/\\\\]main\\.js$', lineNumber: 0 })
    await call('Runtime.runIfWaitingForDebugger')
    await Promise.race([paused, delay(15_000).then(() => { throw new Error('Desktop entry breakpoint missing') })])
    const paths = { userData: join(work, 'browser-data'), sessionData: join(work, 'session-data'),
      logs: join(work, 'logs'), crashDumps: join(work, 'crash-dumps') }
    const configured = await call('Runtime.evaluate', { returnByValue: true,
      expression: `(()=>{const {app}=process.getBuiltinModule('module').createRequire(${JSON.stringify(exe)})('electron');globalThis.__run2skillProbeApp=app;const before=app.getPath('userData');for(const [name,path] of Object.entries(${JSON.stringify(paths)}))app.setPath(name,path);app.setAsDefaultProtocolClient=()=>false;return {before,paths:Object.fromEntries(Object.keys(${JSON.stringify(paths)}).map(name=>[name,app.getPath(name)]))}})()` })
    assert.equal(configured.exceptionDetails, undefined, 'Desktop isolation configuration failed')
    assert.equal(configured.result.value.before, paths.userData, '--user-data-dir was not honored')
    assert.deepEqual(configured.result.value.paths, paths)
    await call('Debugger.disable')
    for (let n = 0; n < 120; n++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${rendererPort}`); break } catch { await delay(500) }
    }
    assert.ok(browser, 'Desktop renderer did not start')
    const page = browser.contexts()[0].pages()[0]
    await page.waitForFunction(() => document.title === 'DeepSeek Harness')
    assert.equal(new URL(page.url()).protocol, 'dsh-app:')
    assert.equal(new URL(page.url()).host, 'app')
    await page.waitForFunction(async () => {
      try {
        const response = await fetch('/api/settings/describe', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'ready', method: 'settings/describe', payload: { args: {} } }) })
        return response.status === 200 && (await response.json()).result?.ok === true
      } catch { return false }
    }, undefined, { timeout: 60_000 })
    await page.getByRole('button', { name: /^(插件|Plugins)$/u }).waitFor({ timeout: 60_000 })
    const hostOrigin = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/u.exec(log)?.[1]
    assert.ok(hostOrigin, 'Desktop did not report its own host origin')
    await check(page, hostOrigin)
    await call('Runtime.evaluate', { expression: 'globalThis.__run2skillProbeApp.quit()' })
  } finally {
    await browser?.close().catch(() => {})
    socket?.close()
    for (let n = 0; n < 50 && child.exitCode === null && child.signalCode === null; n++) await delay(100)
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await delay(1000) }
    await writeFile(join(work, `desktop-${Date.now()}.log`), log)
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'Desktop main process did not exit')
    assert.equal(protocolSnapshot(), originalProtocol, 'system dsh protocol association changed')
  }
}

async function remote(page, method, args) {
  return await page.evaluate(async ({ method, args }) => {
    const response = await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'desktop-probe', method, payload: { args } }) })
    const body = await response.json()
    if (response.status !== 200 || !body.result?.ok) throw new Error(`${method} failed`)
    return body.result.value
  }, { method, args })
}
async function observe(present, expectedLearning = true, setLearning) {
  await desktop(async (page, hostOrigin) => {
    const described = await remote(page, 'settings/describe', {})
    const ns = described.namespaces.find(item => item.ns === 'run2skill')
    assert.equal(ns !== undefined, present)
    if (!present) return
    assert.equal(ns.value.automaticLearning, expectedLearning)
    const query = await remote(page, 'run2skill/query', { request: { endpoint: 'observe-summary', payload: { apiVersion: 1 } } })
    assert.equal(query.ok, true)
    const command = await remote(page, 'run2skill/command', { request: { endpoint: 'learning/request', payload: { apiVersion: 1 } } })
    assert.equal(command.ok, false) // Reaches the descriptor and rejects incomplete scope.
    const unauthenticated = await fetch(`${hostOrigin}/api/run2skill/query`, { method: 'POST' })
    assert.ok([401, 403].includes(unauthenticated.status))
    if (setLearning !== undefined) {
      const changed = await remote(page, 'settings/mutate', { ns: 'run2skill',
        ops: [{ op: 'set', path: ['automaticLearning'], value: setLearning }], expectedRevision: ns.revision })
      assert.equal(changed.value.automaticLearning, setLearning)
    }
    await page.getByRole('button', { name: /^(插件|Plugins)$/u }).click()
    await page.getByText('dsh-run2skill', { exact: true }).waitFor()
    // Catalog presence and successful RPC do not prove the bundle detail can
    // resolve the selected session. Exercise the host's actual selector hooks.
    await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
    await page.getByRole('button', { name: /^(插件|Plugins)$/u }).click()
    await page.locator('[data-plugin-package="dsh-run2skill"]').getByText('dsh-run2skill', { exact: true }).click()
    const settingsPage = page.locator('[data-plugin-detail="dsh-run2skill"] [data-run2skill-settings-page]')
    await settingsPage.getByText('暂无可整理的经验。', { exact: true }).waitFor()
    assert.equal(await settingsPage.getByText('请先打开一个会话。', { exact: true }).count(), 0)
    await page.screenshot({ path: join(work, `plugin-detail-learning-${expectedLearning ? 'on' : 'off'}.png`) })
    await page.getByRole('button', { name: '账号菜单', exact: true }).click()
    await page.getByText('设置', { exact: true }).click()
    await page.getByRole('button', { name: '内置插件', exact: true }).click()
    assert.equal(await page.getByRole('tab', { name: 'Run2Skill', exact: true }).count(), 0)
  })
}
async function cli(args) {
  const entry = join(dirname(exe), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
  const result = spawnSync(exe, ['--expose-internals', entry, ...args], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    cwd: workspace, windowsHide: true, encoding: 'utf8', timeout: 120_000 })
  assert.equal(result.status, 0, sanitize(result.stderr))
}
async function archive(version) {
  const stage = join(work, version)
  await mkdir(stage)
  for (const name of ['lib', 'cordis.patch.yml', 'README.md', 'README.en.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    await cp(join(candidate, name), join(stage, name), { recursive: true })
  }
  const manifest = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'))
  await writeFile(join(stage, 'package.json'), JSON.stringify({ ...manifest, version }, null, 2))
  const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm', 'pack', '--pack-destination', work],
    { cwd: stage, encoding: 'utf8', windowsHide: true, env, timeout: 120_000 })
  assert.equal(result.status, 0, sanitize(result.stderr))
  return join(work, `dsh-run2skill-${version}.tgz`)
}

const first = await archive('0.5.0-alpha.3.probe.1'), second = await archive('0.5.0-alpha.3.probe.2')
await observe(false)
await cli(['plugin', '--profile', 'desktop', 'add', first])
await observe(true, true, false)
const savedPatch = await readFile(patchPath, 'utf8')
await observe(true, false)
const skill = join(home, 'skills', 'desktop-retained', 'SKILL.md')
await mkdir(dirname(skill), { recursive: true })
await writeFile(skill, '---\nname: desktop-retained\ndescription: lifecycle fixture\n---\n\nretained\n')
const retainedSkill = await readFile(skill, 'utf8')
const storage = (await readdir(join(home, 'storages'))).filter(name => /run2skill/iu.test(name)).sort()
assert.ok(storage.length > 0)
await writeFile(patchPath, savedPatch.replace('- id: run2skill', '- id: run2skill\n  disabled: true'))
await observe(false)
await writeFile(patchPath, savedPatch)
await cli(['plugin', '--profile', 'desktop', 'add', second])
await observe(true, false, true)
await cli(['plugin', '--profile', 'desktop', 'remove', 'dsh-run2skill'])
await observe(false)
assert.equal(await readFile(skill, 'utf8'), retainedSkill)
assert.deepEqual((await readdir(join(home, 'storages'))).filter(name => /run2skill/iu.test(name)).sort(), storage)
console.log('DESKTOP_INSTALL_SETTINGS_RESTART_DISABLE_UPGRADE_REMOVE=PASS')
console.log('DESKTOP_AUTHENTICATED_RENDERER_AND_RPC=PASS')
console.log('DESKTOP_ISOLATION_PROTOCOL_AND_RETAINED_DATA=PASS')
