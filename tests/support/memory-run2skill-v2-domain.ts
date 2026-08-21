import type {
  ExperienceIntentV2,
  GlobalV2,
  LegacyItemV2,
  ProposalLineageV2,
  SessionBatchV2,
  TurnObservationV2,
} from '../../src/domain/v2/index.js'
import type { Run2skillTable } from '../../src/adapters/dsh-storage/types.js'
import type { Run2skillV2Domain } from '../../src/adapters/dsh-storage/v2-types.js'
import { createInitialGlobalV2 } from '../../src/adapters/dsh-storage/v2-domain.js'

function memoryTable<V>(values: Map<string, V>, writeLog: string[], name: string): Run2skillTable<string, V> {
  return {
    get: key => values.get(key),
    entries: () => [...values.entries()][Symbol.iterator](),
    keys: () => [...values.keys()][Symbol.iterator](),
    get size() { return values.size },
    put: async (key, value) => {
      values.set(key, structuredClone(value))
      writeLog.push(name)
    },
    delete: async (key) => {
      const deleted = values.delete(key)
      if (deleted) writeLog.push(`delete:${name}`)
      return deleted
    },
    update: async (key, transform) => {
      const current = values.get(key)
      if (current === undefined) throw new Error('missing-key')
      const next = transform(structuredClone(current))
      values.set(key, structuredClone(next))
      writeLog.push(name)
      return next
    },
  }
}

export function createMemoryRun2skillV2Domain(): Run2skillV2Domain & {
  turnObservations: Map<string, TurnObservationV2>
  sessionBatches: Map<string, SessionBatchV2>
  experienceIntents: Map<string, ExperienceIntentV2>
  proposalLineages: Map<string, ProposalLineageV2>
  legacyItems: Map<string, LegacyItemV2>
  writeLog: string[]
} {
  let global = createInitialGlobalV2()
  const writeLog: string[] = []
  const turnObservations = new Map<string, TurnObservationV2>()
  const sessionBatches = new Map<string, SessionBatchV2>()
  const experienceIntents = new Map<string, ExperienceIntentV2>()
  const proposalLineages = new Map<string, ProposalLineageV2>()
  const legacyItems = new Map<string, LegacyItemV2>()
  const tables = {
    turn_observations: memoryTable(turnObservations, writeLog, 'turn_observations'),
    session_batches: memoryTable(sessionBatches, writeLog, 'session_batches'),
    experience_intents: memoryTable(experienceIntents, writeLog, 'experience_intents'),
    proposal_lineages: memoryTable(proposalLineages, writeLog, 'proposal_lineages'),
    legacy_items: memoryTable(legacyItems, writeLog, 'legacy_items'),
  }
  function table(name: 'turn_observations'): typeof tables.turn_observations
  function table(name: 'session_batches'): typeof tables.session_batches
  function table(name: 'experience_intents'): typeof tables.experience_intents
  function table(name: 'proposal_lineages'): typeof tables.proposal_lineages
  function table(name: 'legacy_items'): typeof tables.legacy_items
  function table(name: keyof typeof tables) { return tables[name] }
  return {
    name: 'run2skill_v2',
    turnObservations,
    sessionBatches,
    experienceIntents,
    proposalLineages,
    legacyItems,
    writeLog,
    global: {
      get: () => structuredClone(global),
      set: async (value: GlobalV2) => {
        global = structuredClone(value)
        writeLog.push('global')
      },
    },
    table,
    close: async () => {},
  }
}
