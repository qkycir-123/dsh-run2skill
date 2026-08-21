import type { LearningDiagnosticRecordV1 } from '../../src/domain/learn/index.js'
import type { LearningDiagnosticDomain } from '../../src/adapters/dsh-storage/learning-diagnostic-domain.js'

export function createMemoryLearningDiagnosticDomain(): LearningDiagnosticDomain & {
  records: Map<string, LearningDiagnosticRecordV1>
  failNextDeletes(count: number): void
} {
  const records = new Map<string, LearningDiagnosticRecordV1>()
  let deleteFailures = 0
  const table = {
    get: (key: string) => records.get(key),
    entries: () => [...records.entries()][Symbol.iterator](),
    keys: () => [...records.keys()][Symbol.iterator](),
    get size() { return records.size },
    put: async (key: string, value: LearningDiagnosticRecordV1) => { records.set(key, structuredClone(value)) },
    delete: async (key: string) => {
      if (deleteFailures > 0) {
        deleteFailures -= 1
        throw new Error('synthetic diagnostic delete failure')
      }
      return records.delete(key)
    },
    update: async (key: string, transform: (current: LearningDiagnosticRecordV1) => LearningDiagnosticRecordV1) => {
      const current = records.get(key)
      if (current === undefined) throw new Error('missing-key')
      const next = transform(structuredClone(current))
      records.set(key, structuredClone(next))
      return next
    },
  }
  return {
    name: 'run2skill_learning_diagnostics_v1',
    records,
    failNextDeletes(count) { deleteFailures += count },
    table: () => table,
    close: async () => {},
  }
}
