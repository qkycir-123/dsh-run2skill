import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { createServer as createNetServer } from 'node:net'
import { access, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  isSafeDiagnosticOutput,
  safeFailure,
} from '../support/safe-diagnostics.mjs'
import { dshWebArgs } from './web-args.mjs'

const [cloneArg, candidateArg, workArg, uiFixtureArg, mode] = process.argv.slice(2)
if (!cloneArg || !candidateArg || !workArg || !uiFixtureArg) {
  throw new Error('usage: node candidate-probe.mjs <built-dsh-clone> <candidate-root> <work-root> <ui-fixture> [--web-only]')
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
const skillPath = join(home, 'skills', 'retained-skill', 'SKILL.md')
const packageName = 'dsh-run2skill'
const uiFixture = JSON.parse(await readFile(resolve(uiFixtureArg), 'utf8'))
assert.equal(uiFixture.kind, 'run2skill-controlled-web-probe-fixture-v1')
const retainedSkill = '---\nname: retained-skill\ndescription: retained lifecycle fixture\n---\n\nretained\n'
const webOnly = mode === '--web-only'

await mkdir(workspace, { recursive: true })
await mkdir(join(home, 'skills', 'retained-skill'), { recursive: true })
await writeFile(skillPath, retainedSkill)

async function stage(version) {
  const root = join(stages, version)
  await mkdir(root, { recursive: true })
  await cp(join(candidate, 'lib'), join(root, 'lib'), { recursive: true })
  await cp(join(candidate, 'cordis.patch.yml'), join(root, 'cordis.patch.yml'))
  await cp(join(candidate, 'README.md'), join(root, 'README.md'))
  await cp(join(candidate, 'LICENSE'), join(root, 'LICENSE'))
  await cp(join(candidate, 'THIRD_PARTY_NOTICES.md'), join(root, 'THIRD_PARTY_NOTICES.md'))
  const manifest = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ ...manifest, version }, null, 2))
  const archiveDirectory = join(archives, version)
  await mkdir(archiveDirectory, { recursive: true })
  const packCommand = process.platform === 'win32'
    ? {
        executable: process.env.ComSpec ?? 'cmd.exe',
        args: ['/d', '/s', '/c', 'pnpm', 'pack', '--pack-destination', archiveDirectory],
      }
    : { executable: 'pnpm', args: ['pack', '--pack-destination', archiveDirectory] }
  const packed = await run(packCommand.executable, packCommand.args, 120_000, root)
  if (packed.code !== 0) throw new Error(safeFailure('candidate staging pack failed', packed.stderr))
  const tarballs = (await readdir(archiveDirectory)).filter(entry => entry.endsWith('.tgz'))
  assert.equal(tarballs.length, 1)
  return join(archiveDirectory, tarballs[0])
}

const env = { ...process.env, DSH_HOME: home, NO_COLOR: '1', FORCE_COLOR: '0' }

async function run(executable, args, timeoutMs = 120_000, cwd = workspace) {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
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

const v1 = await stage('0.1.0-alpha.1')
const v2 = await stage('0.1.0-alpha.2')

async function manifest() {
  return JSON.parse(await readFile(manifestPath, 'utf8'))
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

async function startProbeProvider() {
  const server = createHttpServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([
        'data: {"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
        'data: {"choices":[{"delta":{"content":"done"}}]}',
        'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
        'data: [DONE]',
        '',
      ].join('\n\n'))
    })
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('controlled provider did not bind a TCP port')
  return { server, baseUrl: `http://127.0.0.1:${String(address.port)}` }
}

async function closeServer(server) {
  if (!server.listening) return
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
}

async function stop(child) {
  const hasExited = () => child.exitCode !== null || child.signalCode !== null
  if (hasExited()) return
  child.kill()
  await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), delay(5_000)])
  if (hasExited()) return
  child.kill('SIGKILL')
  await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), delay(5_000)])
  if (!hasExited()) throw new Error('candidate Web did not exit after SIGKILL')
}

async function waitForOutputClose(stream) {
  if (stream.closed) return
  const closed = await Promise.race([
    new Promise(resolveClose => stream.once('close', () => resolveClose(true))),
    delay(5_000, false),
  ])
  if (!closed || !stream.closed) {
    throw new Error('candidate Web output did not close')
  }
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

async function waitForAutomaticLearningSetting(expected) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const settings = await readFile(join(home, 'settings.yaml'), 'utf8')
      if (settings.includes(`run2skill:\n  automaticLearning: ${String(expected)}`)) return
    } catch { /* wait for the native settings commit */ }
    await delay(100)
  }
  throw new Error('native run2skill settings write did not become durable')
}

async function observe(present, expectedAutomaticLearning) {
  const port = await reservePort()
  const base = `http://127.0.0.1:${String(port)}`
  const provider = present ? await startProbeProvider() : undefined
  const childEnv = provider === undefined
    ? env
    : {
        ...env,
        [['DEEPSEEK', 'API', 'KEY'].join('_')]: ['run2skill', 'controlled', 'probe'].join('-'),
        [['DEEPSEEK', 'BASE', 'URL'].join('_')]: provider.baseUrl,
      }
  const child = spawn(process.execPath, [bin, ...dshWebArgs(port)], {
    cwd: workspace, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', chunk => { logs += chunk.toString() })
  child.stderr.on('data', chunk => { logs += chunk.toString() })
  let browser
  try {
    const deadline = Date.now() + 60_000
    let html
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(safeFailure('candidate Web exited early', logs))
      }
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
      const workspaceResponse = await fetch(`${base}/api/workspace.create`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'a6-ui-workspace', method: 'workspace.create', payload: { path: workspace },
        }),
      })
      const workspaceBody = await workspaceResponse.json()
      assert.equal(workspaceBody.result?.ok, true, 'controlled UI probe could not register its disposable workspace')
      const sessionResponse = await fetch(`${base}/api/session.create`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'a6-ui-session', method: 'session.create', payload: { cwd: workspace },
        }),
      })
      const sessionBody = await sessionResponse.json()
      assert.equal(sessionBody.result?.ok, true, 'controlled UI probe could not create a DSH session')
      browser = await chromium.launch({ headless: true, executablePath: await browserExecutable() })
      console.log('CP_INS_A6_BROWSER_MODE=headless+dsh-no-open')
      const page = await browser.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(String(error)))
      let uiPhase = 'quiet'
      await page.route('**/run2skill/**', async route => {
        let request
        try { request = route.request().postDataJSON() } catch { return await route.continue() }
        const method = request?.method
        const result = method === 'attention'
          ? uiPhase === 'review'
            ? uiFixture.review.attention
            : uiPhase === 'failure'
              ? uiFixture.failure.attention
              : uiFixture.failure.doneAttention
          : method === 'proposals/list'
            ? uiPhase === 'review'
              ? uiFixture.review.list
              : uiPhase === 'failure'
                ? uiFixture.failure.list
                : uiFixture.failure.afterRetry
            : method === 'proposals/get'
              ? uiPhase === 'review' ? uiFixture.review.detail : uiFixture.failure.detail
              : method === 'proposals/approve'
                ? (() => { uiPhase = 'failure'; return uiFixture.review.approve })()
                : method === 'proposals/retry'
                  ? (() => { uiPhase = 'done'; return uiFixture.failure.retry })()
                  : undefined
        if (result === undefined) return await route.continue()
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result }),
        })
      })
      await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      assert.equal(errors.filter(error => /run2skill/iu.test(error)).length, 0)
      const onboarding = page.locator('[class*="onboardingOverlay"]')
      if (await onboarding.count() > 0) {
        await onboarding.getByRole('button').click()
        await onboarding.waitFor({ state: 'detached', timeout: 15_000 })
      }
      const acknowledgeNotice = page.getByRole('button', { name: /^(Continue|继续)$/ })
      const noticeVisible = await acknowledgeNotice.waitFor({ timeout: 10_000 })
        .then(() => true, () => false)
      if (noticeVisible) {
        const noticeDialog = page.getByRole('dialog').filter({ has: acknowledgeNotice })
        await acknowledgeNotice.click()
        await noticeDialog.waitFor({ state: 'detached', timeout: 15_000 })
      }
      const deferSetup = page.getByRole('button', { name: /^(Configure later|稍后配置)$/ })
      const setupVisible = await deferSetup.waitFor({ timeout: 10_000 })
        .then(() => true, () => false)
      if (setupVisible) {
        const setupDialog = page.getByRole('dialog').filter({ has: deferSetup })
        await deferSetup.click()
        await setupDialog.waitFor({ state: 'detached', timeout: 15_000 })
      }
      await page.getByRole('button', { name: /^(?:New session|新.*会话)$/ }).last().click()
      await page.locator('textarea').last().fill('run2skill controlled UI probe draft')
      uiPhase = 'review'
      await page.locator('textarea').last().press('Enter')
      await page.getByText(/run2skill 有 1 项需要处理/u).waitFor({ timeout: 15_000 })
      await page.getByRole('button', { name: /^(Settings|设置)$/ }).click()
      const dialog = page.getByRole('dialog', { name: /^(Settings|设置)$/ })
      await dialog.getByRole('button', { name: /^(Plugins|插件)$/ }).click()
      await dialog.getByRole('tab', { name: 'run2skill' }).click()
      const surface = dialog.locator('[data-run2skill-settings-page]')
      await surface.waitFor({ timeout: 10_000 })
      assert.equal(await page.locator('[data-run2skill-status], [data-run2skill-proposal-trigger]').count(), 0)
      const detailResponsePromise = page.waitForResponse(response => {
        if (!response.url().includes('/run2skill/')) return false
        try { return response.request().postDataJSON()?.method === 'proposals/get' } catch { return false }
      })
      await surface.getByRole('button', { name: /CREATE · generated-file-hygiene/u }).click()
      const detailResponse = await detailResponsePromise
      const detailPayload = await detailResponse.json()
      const detailWire = JSON.stringify(detailPayload?.result)
      assert.equal(detailPayload?.result?.ok, true)
      assert.doesNotMatch(
        detailWire,
        /canonicalPath|declaredRootPath|bundlePath|skillFilePath|flatSkillFilePath|"path"|[A-Za-z]:\\/u,
        'Proposal detail network DTO leaked an absolute or target path',
      )
      console.log('CP_INS_A6_DETAIL_NETWORK_PRIVACY=PASS')
      await surface.getByRole('button', { name: '批准并发布' }).waitFor({ timeout: 10_000 })
      assert.equal((await surface.innerText()).includes('D:\\workspace'), false)
      await surface.getByRole('button', { name: '批准并发布' }).click()
      const retryPublication = surface.getByRole('button', { name: '重试发布' })
      await retryPublication.waitFor({ timeout: 10_000 })
      assert.match(await surface.innerText(), /发布失败，可重试/u)
      await retryPublication.click()
      await retryPublication.waitFor({ state: 'detached', timeout: 10_000 })
      await surface.getByText('0 项可操作事项').waitFor({ timeout: 10_000 })
      console.log('CP_INS_A6_ACTIONABLE_UI=PASS')
      await surface.getByRole('button', { name: '自动学习' }).click()
      const toggle = surface.getByRole('button', { name: /自动学习已(?:开启|关闭)/u })
      assert.equal(await toggle.getAttribute('aria-pressed'), String(expectedAutomaticLearning))
      await surface.getByRole('button', { name: '数据管理' }).click()
      const userPurge = surface.getByRole('button', { name: '预览并清理 USER 数据' })
      await userPurge.click()
      const purgeDialog = page.getByRole('dialog', { name: '确认清理 USER run2skill 数据？' })
      await purgeDialog.waitFor({ timeout: 10_000 })
      assert.match(await purgeDialog.innerText(), /保留 DSH Session Log/u)
      assert.match(await purgeDialog.innerText(), /保留所有已发布的原生 Skill/u)
      await page.keyboard.press('Escape')
      await purgeDialog.waitFor({ state: 'detached', timeout: 10_000 })
      assert.equal(await userPurge.evaluate(element => element === document.activeElement), true)
      if (expectedAutomaticLearning) {
        const mutation = page.waitForResponse(response => response.url().endsWith('/api/settings.mutate'))
        await toggle.click()
        const mutationBody = await (await mutation).json()
        assert.equal(mutationBody.result?.ok, true, 'native settings mutation was rejected')
        await waitForAutomaticLearningSetting(false)
      }
    }
  } finally {
    await browser?.close()
    await stop(child)
    await Promise.all([waitForOutputClose(child.stdout), waitForOutputClose(child.stderr)])
    if (provider !== undefined) await closeServer(provider.server)
  }
  assert.equal(
    isSafeDiagnosticOutput(logs),
    true,
    safeFailure('candidate runtime log gate failed', logs),
  )
}

console.log('CP_INS_A6_STAGE=add')
await dsh(['plugin', '--profile', 'web', 'add', v1])
assert.ok((await manifest()).dsh.profile.bundles.includes(packageName))
assert.ok((await dsh(['--profile', 'web', '--dump-config'])).stdout.includes('id: run2skill'))
await observe(true, true)

if (webOnly) {
  console.log('CP_D3_WEB=PASS')
} else {
  console.log('CP_INS_A6_STAGE=disable')
  await writeFile(patchPath, '- id: run2skill\n  disabled: true\n')
  await observe(false)

  console.log('CP_INS_A6_STAGE=upgrade')
  await writeFile(patchPath, '[]\n')
  await dsh(['plugin', '--profile', 'web', 'add', v2])
  const installedManifest = JSON.parse(await readFile(join(profile, 'node_modules', packageName, 'package.json'), 'utf8'))
  assert.equal(installedManifest.version, '0.1.0-alpha.2')
  await observe(true, false)

  const storageEntries = await readdir(join(home, 'storages'))
  assert.ok(storageEntries.some(entry => /run2skill/iu.test(entry)), 'run2skill domain was not retained')

  console.log('CP_INS_A6_STAGE=uninstall')
  await dsh(['plugin', '--profile', 'web', 'remove', packageName])
  const removedManifest = await manifest()
  assert.equal(removedManifest.dsh.profile.bundles.includes(packageName), false)
  assert.equal(Object.hasOwn(removedManifest.dependencies ?? {}, packageName), false)
  await assert.rejects(
    access(join(profile, 'node_modules', packageName)),
    error => error?.code === 'ENOENT',
    'uninstall left the candidate package path behind',
  )
  await observe(false)
  const retainedStorageEntries = await readdir(join(home, 'storages'))
  assert.ok(
    retainedStorageEntries.some(entry => /run2skill/iu.test(entry)),
    'uninstall removed run2skill storage',
  )
  assert.equal(await readFile(skillPath, 'utf8'), retainedSkill)
  console.log('CP_INS_A6=PASS')
}
