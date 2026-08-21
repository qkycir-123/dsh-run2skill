import type { LearningDiagnosticHealthV1, LearningDiagnosticRecordV1 } from '../../src/domain/learn/index.js'
import type { LearningDiagnosticDomain } from '../../src/adapters/dsh-storage/learning-diagnostic-domain.js'

export function createMemoryLearningDiagnosticDomain(): LearningDiagnosticDomain & {
  records: Map<string, LearningDiagnosticRecordV1>
  healthChecks: Map<string, LearningDiagnosticHealthV1>
  failNextDeletes(count: number): void
  failNextHealthPuts(count: number): void
  failNextHealthDeletes(count: number): void
  setUnavailable(unavailable: boolean): void
} {
  const records = new Map<string, LearningDiagnosticRecordV1>()
  const healthChecks = new Map<string, LearningDiagnosticHealthV1>()
  let deleteFailures = 0
  let healthPutFailures = 0
  let healthDeleteFailures = 0
  let unavailable = false
  const assertAvailable = () => {
    if (unavailable) throw new Error('synthetic diagnostic backend unavailable')
  }
  const terminalTable = {
    get: (key: string) => { assertAvailable(); return records.get(key) },
    entries: () => [...records.entries()][Symbol.iterator](),
    keys: () => [...records.keys()][Symbol.iterator](),
    get size() { return records.size },
    put: async (key: string, value: LearningDiagnosticRecordV1) => { assertAvailable(); records.set(key, structuredClone(value)) },
    delete: async (key: string) => {
      assertAvailable()
      if (deleteFailures > 0) {
        deleteFailures -= 1
        throw new Error('synthetic diagnostic delete failure')
      }
      return records.delete(key)
    },
    update: async (key: string, transform: (current: LearningDiagnosticRecordV1) => LearningDiagnosticRecordV1) => {
      assertAvailable()
      const current = records.get(key)
      if (current === undefined) throw new Error('missing-key')
      const next = transform(structuredClone(current))
      records.set(key, structuredClone(next))
      return next
    },
  }
  const healthTable = {
    get: (key: string) => { assertAvailable(); return healthChecks.get(key) },
    entries: () => [...healthChecks.entries()][Symbol.iterator](),
    keys: () => [...healthChecks.keys()][Symbol.iterator](),
    get size() { return healthChecks.size },
    put: async (key: string, value: LearningDiagnosticHealthV1) => {
      assertAvailable()
      if (healthPutFailures > 0) {
        healthPutFailures -= 1
        throw new Error('synthetic diagnostic health put failure')
      }
      healthChecks.set(key, structuredClone(value))
    },
    delete: async (key: string) => {
      assertAvailable()
      if (healthDeleteFailures > 0) {
        healthDeleteFailures -= 1
        throw new Error('synthetic diagnostic health delete failure')
      }
      return healthChecks.delete(key)
    },
    update: async (key: string, transform: (current: LearningDiagnosticHealthV1) => LearningDiagnosticHealthV1) => {
      assertAvailable()
      const current = healthChecks.get(key)
      if (current === undefined) throw new Error('missing-key')
      const next = transform(structuredClone(current))
      healthChecks.set(key, structuredClone(next))
      return next
    },
  }
  function table(name: 'terminal_details'): typeof terminalTable
  function table(name: 'health_checks'): typeof healthTable
  function table(name: 'terminal_details' | 'health_checks') {
    return name === 'terminal_details' ? terminalTable : healthTable
  }
  return {
    name: 'run2skill_learning_diagnostics_v1',
    records,
    healthChecks,
    failNextDeletes(count) { deleteFailures += count },
    failNextHealthPuts(count) { healthPutFailures += count },
    failNextHealthDeletes(count) { healthDeleteFailures += count },
    setUnavailable(value) { unavailable = value },
    table,
    close: async () => {},
  }
}
