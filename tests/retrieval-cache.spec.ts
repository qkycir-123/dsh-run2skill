import { expect, it } from 'vitest'
import { PersistentVectorCache, type StoredSkillVector } from '../src/adapters/dsh-storage/retrieval-domain.js'
import type { Run2skillTable } from '../src/adapters/dsh-storage/types.js'

it('clear waits for an accepted native put before enumerating keys, and fences stale writers', async () => {
  const values = new Map<string, StoredSkillVector>()
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const native: Run2skillTable<string, StoredSkillVector> = {
    get: key => values.get(key), entries: () => [...values.entries()][Symbol.iterator](), keys: () => [...values.keys()][Symbol.iterator](),
    get size() { return values.size },
    put: async (key, value) => { entered(); await blocked; values.set(key, value) },
    delete: async key => values.delete(key),
    update: async (key, transform) => { const value = transform(values.get(key)!); values.set(key, value); return value },
  }
  const cache = new PersistentVectorCache({ storageDomain: { open: async () => ({ table: () => native, close: async () => {} }) } })
  const table = await cache.table()
  const record: StoredSkillVector = { candidateId: 'a', rootDigest: 'a'.repeat(64), fingerprint: 'b'.repeat(64), summaryDigest: 'c'.repeat(64), vector: [1, 0], updatedAt: 1 }
  const write = table.put('new-key', record)
  await started
  let cleared = false
  const clear = cache.clear().then(() => { cleared = true })
  await Promise.resolve()
  expect(cleared).toBe(false)
  release()
  await Promise.all([write, clear])
  expect(values.size).toBe(0)
  await expect(cache.table(0)).rejects.toThrow('RETRIEVAL_CACHE_CLEARED')
  await expect(table.put('stale-key', record)).rejects.toThrow('RETRIEVAL_CACHE_CLEARED')
  await (await cache.table()).put('new-generation', record)
  expect(values.size).toBe(1)
  await cache.close()
})
