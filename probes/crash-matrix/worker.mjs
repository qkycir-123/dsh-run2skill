import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [candidateArg, rootArg, mode] = process.argv.slice(2)
if (!candidateArg || !rootArg || !mode) throw new Error('missing crash worker arguments')
const candidate = resolve(candidateArg)
const root = resolve(rootArg)
mkdirSync(root, { recursive: true })

const globalPath = join(root, 'global-v2.json')
const sessionPath = join(root, 'session.json')
const header = { version: 1, id: 'crash-session', createdAt: 1_725_000_000_000, cwd: 'D:/workspace' }

function turn(turnNumber, firstSeq, seed) {
  return [
    { type: 'turn/start', seq: firstSeq, time: header.createdAt + firstSeq * 10 + seed, data: { turn: turnNumber } },
    {
      type: 'request/header', seq: firstSeq + 1, time: header.createdAt + firstSeq * 10 + seed + 1,
      data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-chat' } } },
    },
    {
      type: 'user/message', seq: firstSeq + 2, time: header.createdAt + firstSeq * 10 + seed + 2,
      data: {
        id: `message-${String(turnNumber)}-${String(seed)}`,
        source: { kind: 'user' },
        content: [{ type: 'text', text: '继续完成当前任务。' }],
      },
    },
    {
      type: 'assistant/message', seq: firstSeq + 3, time: header.createdAt + firstSeq * 10 + seed + 3,
      data: {
        turn: turnNumber,
        message: {
          id: `assistant-${String(turnNumber)}-${String(seed)}`,
          role: 'assistant',
          source: { kind: 'assistant' },
          content: [{ type: 'text', text: '当前任务已经完成。' }],
        },
      },
    },
    { type: 'turn/end', seq: firstSeq + 4, time: header.createdAt + firstSeq * 10 + seed + 4, data: { turn: turnNumber, reason: { kind: 'completed' } } },
  ]
}

function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback
}

function writeSession(turnCount) {
  const events = []
  for (let index = 0; index < turnCount; index += 1) events.push(...turn(index, index * 5, index * 1000))
  writeFileSync(sessionPath, JSON.stringify(events))
}

if (mode === 'crash-before-upstream') process.exit(23)
if (mode === 'historical-turn-crash' || mode === 'offline-turn-crash' || mode === 'gap-crash-after-observation') {
  writeSession(1)
  if (mode !== 'gap-crash-after-observation') process.exit(23)
}
if (mode === 'append-second-turn-crash') {
  writeSession(2)
  process.exit(23)
}

const host = await import(pathToFileURL(join(candidate, 'lib', 'index.js')).href)
const tableNames = ['turn_observations', 'session_batches', 'experience_intents', 'proposal_lineages', 'legacy_items']
const tables = Object.fromEntries(tableNames.map(name => [name, new Map(Object.entries(readJson(join(root, `${name}.json`), {})))]))
let global
let crashAfterObservation = mode === 'gap-crash-after-observation'

function persistTable(name) {
  writeFileSync(join(root, `${name}.json`), JSON.stringify(Object.fromEntries(tables[name])))
}

const domain = {
  name: 'run2skill_v2',
  global: {
    get: () => structuredClone(global),
    set: async value => {
      global = structuredClone(value)
      writeFileSync(globalPath, JSON.stringify(global))
    },
  },
  table: name => {
    const records = tables[name]
    if (records === undefined) throw new Error(`unexpected table: ${name}`)
    return {
      get: key => records.get(key),
      entries: () => records.entries(),
      keys: () => records.keys(),
      get size() { return records.size },
      put: async (key, value) => {
        records.set(key, structuredClone(value))
        persistTable(name)
        if (name === 'turn_observations' && crashAfterObservation) {
          crashAfterObservation = false
          process.exit(23)
        }
      },
      delete: async key => {
        const changed = records.delete(key)
        if (changed) persistTable(name)
        return changed
      },
      update: async (key, transform) => {
        const current = records.get(key)
        if (current === undefined) throw new Error('missing item')
        const value = transform(structuredClone(current))
        records.set(key, structuredClone(value))
        persistTable(name)
        return value
      },
    }
  },
  close: async () => {},
}

const context = {
  sessions: { get: () => undefined },
  agents: { get: () => undefined },
  llm: {
    resolveModelInfo: async () => ({ context: { contextWindow: 16_384 } }),
    stream: async function * () { yield { type: 'finish', reason: { kind: 'stop' } } },
  },
  skills: {
    snapshot: async () => ({ skills: [], complete: true }),
    get: async () => undefined,
  },
  agentPresets: {
    composedPreset: () => undefined,
    resolve: async id => ({ id, trust: 'system' }),
    read: async () => '',
  },
  settings: {
    register: (_namespace, schema) => {
      const value = schema({})
      return { get: () => value, watch: () => () => {} }
    },
  },
  storageDomain: {
    open: async spec => {
      if (!existsSync(globalPath)) writeFileSync(globalPath, JSON.stringify(spec.global.initial))
      global = readJson(globalPath, spec.global.initial)
      return domain
    },
  },
  sessionPersistence: {
    listSnapshots: async () => {
      const events = readJson(sessionPath, [])
      return events.length === 0 ? [] : [{ header, revision: `json:${String(events.length)}` }]
    },
    readFrom: async (_id, fromSeq) => ({
      meta: header,
      events: readJson(sessionPath, []).filter(event => event.seq >= fromSeq),
    }),
  },
  workspaceRegistry: {
    resolveByPath: async () => ({ id: 'workspace-v2', path: 'D:/workspace' }),
    get: () => ({ id: 'workspace-v2', path: 'D:/workspace' }),
  },
  reflect: { provide() {} },
  connection: { rpc: { handle: () => async () => {} } },
  on: () => {},
}

const dispose = await host.apply(context)
await dispose()
