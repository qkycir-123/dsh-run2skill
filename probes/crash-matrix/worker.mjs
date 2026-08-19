import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [candidateArg, rootArg, mode] = process.argv.slice(2)
if (!candidateArg || !rootArg || !mode) throw new Error('missing crash worker arguments')
const candidate = resolve(candidateArg)
const root = resolve(rootArg)
mkdirSync(root, { recursive: true })
const globalPath = join(root, 'global.json')
const itemsPath = join(root, 'work-items.json')
const sessionPath = join(root, 'session.json')
const header = { version: 1, id: 'crash-session', createdAt: 1_725_000_000_000 }

function events(seed) {
  return [
    { type: 'turn/start', seq: 0, time: 1_725_000_001_000 + seed, data: { turn: 0 } },
    {
      type: 'user/message', seq: 1, time: 1_725_000_001_100 + seed,
      data: {
        id: `message-${String(seed)}`,
        source: { kind: 'user' },
        content: [{ type: 'text', text: '把这个流程保存成 Skill。' }],
      },
    },
    {
      type: 'turn/end', seq: 2, time: 1_725_000_002_000 + seed,
      data: { turn: 0, reason: { kind: 'completed' } },
    },
  ]
}

function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback
}

function initialize() {
  if (!existsSync(globalPath)) {
    const lifecycleKey = `sl_${'0'.repeat(64)}`
    writeFileSync(globalPath, JSON.stringify({
      schemaVersion: 1,
      activeTriggerPolicyVersion: 'cheap-trigger-v1',
      sessions: {},
      health: { counts: {} },
      recovery: { recoveryLag: false },
      lastSuccessfulStoreWriteAt: '2024-08-30T06:00:00.000Z',
      checkpoint: { dirty: false, pendingSessionCount: 0 },
      _placeholderLifecycleKey: lifecycleKey,
    }))
    writeFileSync(itemsPath, '{}')
  }
}

initialize()
if (mode === 'crash-before-upstream') process.exit(23)
if (mode === 'crash-after-turn') {
  writeFileSync(sessionPath, JSON.stringify(events(0)))
  process.exit(23)
}

const host = await import(pathToFileURL(join(candidate, 'lib', 'index.js')).href)
let global = readJson(globalPath, {})
delete global._placeholderLifecycleKey
const items = new Map(Object.entries(readJson(itemsPath, {})))
let volatileEvents = readJson(sessionPath, [])
let revision = `json:${String(volatileEvents.length)}`
let crashAfterPut = mode === 'crash-after-work-item' || mode === 'volatile-old-crash'

const cwdDigest = 'e0d52d700598d4fcbac5ac5350694f541f89510c7ca61774cad9c1742f031fa5'
const lifecycleKey = 'sl_20dfc7b5b90e8fee54c4f02126488939d66c675f4af72536c7bfd0e75bb767ec'
if (Object.keys(global.sessions).length === 0) {
  global.sessions[lifecycleKey] = {
    rootSessionId: header.id,
    sessionCreatedAt: header.createdAt,
    sessionCwdDigest: cwdDigest,
    triggerPolicyVersion: 'cheap-trigger-v1',
    activationFenceSeq: 0,
    durableNextSeq: 0,
    observedTailSeq: 0,
  }
  writeFileSync(globalPath, JSON.stringify(global))
}

function persistItems() {
  writeFileSync(itemsPath, JSON.stringify(Object.fromEntries(items)))
}

const domain = {
  name: 'run2skill_v1',
  global: {
    get: () => structuredClone(global),
    set: async value => {
      global = structuredClone(value)
      writeFileSync(globalPath, JSON.stringify(global))
    },
  },
  table: name => {
    if (name !== 'work_items') throw new Error('unexpected table')
    return {
      get: key => items.get(key),
      entries: () => items.entries(),
      keys: () => items.keys(),
      get size() { return items.size },
      put: async (key, value) => {
        items.set(key, structuredClone(value))
        persistItems()
        if (crashAfterPut) process.exit(23)
      },
      delete: async key => items.delete(key),
      update: async (key, transform) => {
        const current = items.get(key)
        if (current === undefined) throw new Error('missing item')
        const value = transform(structuredClone(current))
        items.set(key, structuredClone(value))
        persistItems()
        return value
      },
    }
  },
  close: async () => {},
}

const listeners = new Map()
const context = {
  sessions: {},
  llm: {
    resolveModelInfo: async () => ({ context: { contextWindow: 16_384 } }),
    stream: async function * () { yield { type: 'finish', reason: { kind: 'stop' } } },
  },
  skills: {
    snapshot: async () => ({ skills: [], complete: true }),
    get: async () => undefined,
  },
  storageDomain: { open: async () => domain },
  sessionPersistence: {
    listSnapshots: async () => [{ header, revision }],
    readFrom: async (_id, fromSeq) => ({
      meta: header,
      events: volatileEvents.filter(event => event.seq >= fromSeq),
    }),
  },
  workspaceRegistry: { resolveByPath: async () => undefined },
  connection: { rpc: { handle: () => async () => {} } },
  on: (event, handler) => { listeners.set(event, handler) },
}

if (mode === 'crash-after-work-item') {
  volatileEvents = events(0)
  revision = `json:${String(volatileEvents.length)}`
  writeFileSync(sessionPath, JSON.stringify(volatileEvents))
}
if (mode === 'recover-new') {
  volatileEvents = events(10_000)
  revision = `json:${String(volatileEvents.length)}:new`
  writeFileSync(sessionPath, JSON.stringify(volatileEvents))
}

const dispose = await host.apply(context)
if (mode === 'volatile-old-crash') {
  volatileEvents = events(0)
  revision = 'volatile:old'
  const sessionListener = listeners.get('session/event')
  if (sessionListener === undefined) throw new Error('missing session listener')
  for (const event of volatileEvents) sessionListener({ header }, event)
  await new Promise(() => {})
}
await dispose()
