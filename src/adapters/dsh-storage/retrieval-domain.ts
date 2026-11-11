import { z } from 'zod'
import type { Run2skillTable } from './types.js'

const vectorRecord = z.object({
  candidateId: z.string().max(256),
  rootDigest: z.string().regex(/^[a-f0-9]{64}$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  summaryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  vector: z.array(z.number().finite()).min(1).max(4096),
  updatedAt: z.number().finite(),
}).strict()
export type StoredSkillVector = z.infer<typeof vectorRecord>
export const retrievalDomainSpec = {
  name: 'run2skill_retrieval_v1', version: 1,
  global: { schema: z.object({ version: z.literal(1) }).strict(), initial: { version: 1 as const } },
  tables: { vectors: { valueSchema: vectorRecord } },
} as const
export interface RetrievalDomain {
  table(name: 'vectors'): Run2skillTable<string, StoredSkillVector>
  close(): Promise<void>
}
export interface RetrievalStorageContext {
  readonly storageDomain: { open(spec: typeof retrievalDomainSpec): Promise<RetrievalDomain> }
}

/** Derived data has its own domain: no migration of authoritative learning records. */
export class PersistentVectorCache {
  #opening: Promise<RetrievalDomain> | undefined
  #epoch = 0
  constructor(private readonly context: RetrievalStorageContext) {}
  async table(): Promise<Run2skillTable<string, StoredSkillVector>> {
    const epoch = this.#epoch
    this.#opening ??= this.context.storageDomain.open(retrievalDomainSpec).catch(error => {
      this.#opening = undefined
      throw error
    })
    const table = (await this.#opening).table('vectors')
    const assertCurrent = () => { if (epoch !== this.#epoch) throw new Error('RETRIEVAL_CACHE_CLEARED') }
    return {
      get: key => { assertCurrent(); return table.get(key) },
      entries: () => { assertCurrent(); return table.entries() },
      keys: () => { assertCurrent(); return table.keys() },
      get size() { assertCurrent(); return table.size },
      put: async (key, value) => { assertCurrent(); await table.put(key, value) },
      delete: async key => { assertCurrent(); return table.delete(key) },
      update: async (key, transform) => { assertCurrent(); return table.update(key, transform) },
    }
  }
  async clear(): Promise<void> {
    this.#epoch += 1
    const table = await this.table()
    const keys = Array.from(table.keys())
    for (const id of keys) await table.delete(id)
  }
  async close(): Promise<void> {
    if (this.#opening) await (await this.#opening).close()
    this.#opening = undefined
  }
}
