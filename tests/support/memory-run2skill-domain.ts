import type { CaptureWorkItemV1, GlobalV1 } from '../../src/domain/observe/schemas.js'
import type { Run2skillDomain } from '../../src/adapters/dsh-storage/types.js'
import { createInitialGlobalV1 } from '../../src/adapters/dsh-storage/domain.js'
import type { LineageV1 } from '../../src/domain/publication/index.js'

export function createMemoryRun2skillDomain(options: {
  failGlobalWrites?: number
  failWorkItemWrites?: number
  failLineageWrites?: number
} = {}): Run2skillDomain & {
  workItems: Map<string, CaptureWorkItemV1>
  lineages: Map<string, LineageV1>
  writeLog: string[]
  failNextGlobalWrites(count: number): void
  failNextWorkItemWrites(count: number): void
  failNextWorkItemDeletes(count: number): void
  failNextLineageDeletes(count: number): void
} {
  const workItems = new Map<string, CaptureWorkItemV1>()
  const lineages = new Map<string, LineageV1>()
  const writeLog: string[] = []
  let global = createInitialGlobalV1()
  let remainingGlobalFailures = options.failGlobalWrites ?? 0
  let remainingWorkItemFailures = options.failWorkItemWrites ?? 0
  let remainingLineageFailures = options.failLineageWrites ?? 0
  let remainingWorkItemDeleteFailures = 0
  let remainingLineageDeleteFailures = 0
  const workItemTable = {
    get: (key: string) => workItems.get(key),
    entries: () => [...workItems.entries()][Symbol.iterator](),
    keys: () => [...workItems.keys()][Symbol.iterator](),
    get size() { return workItems.size },
    put: async (key: string, value: CaptureWorkItemV1) => {
      if (remainingWorkItemFailures > 0) {
        remainingWorkItemFailures -= 1
        throw new Error('synthetic work item failure')
      }
      workItems.set(key, structuredClone(value))
      writeLog.push('work_items')
    },
    delete: async (key: string) => {
      if (remainingWorkItemDeleteFailures > 0) {
        remainingWorkItemDeleteFailures -= 1
        throw new Error('synthetic work item delete failure')
      }
      const deleted = workItems.delete(key)
      if (deleted) writeLog.push('delete:work_items')
      return deleted
    },
    update: async (key: string, transform: (current: CaptureWorkItemV1) => CaptureWorkItemV1) => {
      if (remainingWorkItemFailures > 0) {
        remainingWorkItemFailures -= 1
        throw new Error('synthetic work item failure')
      }
      const current = workItems.get(key)
      if (current === undefined) throw new Error('missing-key')
      const next = transform(structuredClone(current))
      workItems.set(key, structuredClone(next))
      writeLog.push('work_items')
      return next
    },
  }
  const lineageTable = {
    get: (key: string) => lineages.get(key),
    entries: () => [...lineages.entries()][Symbol.iterator](),
    keys: () => [...lineages.keys()][Symbol.iterator](),
    get size() { return lineages.size },
    put: async (key: string, value: LineageV1) => {
      if (remainingLineageFailures > 0) {
        remainingLineageFailures -= 1
        throw new Error('synthetic lineage failure')
      }
      lineages.set(key, structuredClone(value))
      writeLog.push('lineages')
    },
    delete: async (key: string) => {
      if (remainingLineageDeleteFailures > 0) {
        remainingLineageDeleteFailures -= 1
        throw new Error('synthetic lineage delete failure')
      }
      const deleted = lineages.delete(key)
      if (deleted) writeLog.push('delete:lineages')
      return deleted
    },
    update: async (key: string, transform: (current: LineageV1) => LineageV1) => {
      if (remainingLineageFailures > 0) {
        remainingLineageFailures -= 1
        throw new Error('synthetic lineage failure')
      }
      const current = lineages.get(key)
      if (current === undefined) throw new Error('missing-key')
      const next = transform(structuredClone(current))
      lineages.set(key, structuredClone(next))
      writeLog.push('lineages')
      return next
    },
  }
  function table(name: 'work_items'): typeof workItemTable
  function table(name: 'lineages'): typeof lineageTable
  function table(name: 'work_items' | 'lineages') {
    return name === 'work_items' ? workItemTable : lineageTable
  }
  return {
    name: 'run2skill_v1',
    workItems,
    lineages,
    writeLog,
    failNextGlobalWrites(count) { remainingGlobalFailures += count },
    failNextWorkItemWrites(count) { remainingWorkItemFailures += count },
    failNextWorkItemDeletes(count) { remainingWorkItemDeleteFailures += count },
    failNextLineageDeletes(count) { remainingLineageDeleteFailures += count },
    global: {
      get: () => structuredClone(global),
      set: async (value: GlobalV1) => {
        if (remainingGlobalFailures > 0) {
          remainingGlobalFailures -= 1
          throw new Error('synthetic global failure')
        }
        global = structuredClone(value)
        writeLog.push('global')
      },
    },
    table,
    close: async () => {},
  }
}
