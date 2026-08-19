import type { CaptureWorkItemV1, GlobalV1 } from '../../src/domain/observe/schemas.js'
import type { Run2skillDomain } from '../../src/adapters/dsh-storage/types.js'
import { createInitialGlobalV1 } from '../../src/adapters/dsh-storage/domain.js'

export function createMemoryRun2skillDomain(options: {
  failGlobalWrites?: number
  failWorkItemWrites?: number
} = {}): Run2skillDomain & {
  workItems: Map<string, CaptureWorkItemV1>
  writeLog: string[]
  failNextGlobalWrites(count: number): void
} {
  const workItems = new Map<string, CaptureWorkItemV1>()
  const writeLog: string[] = []
  let global = createInitialGlobalV1()
  let remainingGlobalFailures = options.failGlobalWrites ?? 0
  let remainingWorkItemFailures = options.failWorkItemWrites ?? 0
  return {
    name: 'run2skill_v1',
    workItems,
    writeLog,
    failNextGlobalWrites(count) { remainingGlobalFailures += count },
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
    table: (name) => {
      if (name !== 'work_items') throw new Error(`unsupported table: ${name}`)
      return {
        get: key => workItems.get(key),
        entries: () => [...workItems.entries()][Symbol.iterator](),
        keys: () => [...workItems.keys()][Symbol.iterator](),
        get size() { return workItems.size },
        put: async (key, value) => {
          if (remainingWorkItemFailures > 0) {
            remainingWorkItemFailures -= 1
            throw new Error('synthetic work item failure')
          }
          workItems.set(key, structuredClone(value))
          writeLog.push('work_items')
        },
        delete: async key => workItems.delete(key),
        update: async (key, transform) => {
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
    },
    close: async () => {},
  }
}
