import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import { run2skillDomainSpec } from '../src/adapters/dsh-storage/domain.ts'
import { learningDiagnosticDomainSpec } from '../src/adapters/dsh-storage/learning-diagnostic-domain.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function mount(path: string, backend: 'json' | 'sqlite') {
  const ctx = new Context()
  const storageFiber = await ctx.plugin(Storage)
  const backendFiber = backend === 'json'
    ? await ctx.plugin(StorageJson, { root: path })
    : await ctx.plugin(StorageSqlite, { path })
  const domainFiber = await ctx.plugin(StorageDomain, { backend })
  await vi.waitFor(() => expect(ctx.storageDomain).toBeDefined())
  const main = await ctx.storageDomain.open(run2skillDomainSpec)
  const sidecar = await ctx.storageDomain.open(learningDiagnosticDomainSpec)
  return { storageFiber, backendFiber, domainFiber, main, sidecar }
}

async function dispose(instance: Awaited<ReturnType<typeof mount>>) {
  await instance.sidecar.close()
  await instance.main.close()
  await instance.domainFiber.dispose()
  await instance.backendFiber.dispose()
  await instance.storageFiber.dispose()
}

describe('independent learning diagnostic Storage Domain', () => {
  it.each([
    { backend: 'json' as const, path: (directory: string) => join(directory, 'storages') },
    { backend: 'sqlite' as const, path: (directory: string) => join(directory, 'run2skill.db') },
  ])('opens, persists, and rejoins a strict sidecar independently on $backend', async ({ backend, path }) => {
    const directory = await mkdtemp(join(tmpdir(), `dsh-run2skill-diagnostic-${backend}-`))
    temporaryDirectories.push(directory)
    const storagePath = path(directory)
    const record = {
      schemaVersion: 1 as const,
      workItemId: `wi_${'a'.repeat(64)}`,
      workItemRevision: 4,
      attempt: 1,
      requestOrdinal: 1 as const,
      callKind: 'PRIMARY' as const,
      callOutcome: 'FAILED' as const,
      failureCode: 'MODEL_TERMINAL_FAILURE' as const,
      failureOccurredAt: '2026-08-21T00:00:00.000Z',
      detail: 'MODEL_USAGE_INVALID' as const,
    }
    const key = `${record.workItemId}:1:1`
    const first = await mount(storagePath, backend)
    await first.main.global.set({ ...first.main.global.get(), lastSuccessfulStoreWriteAt: record.failureOccurredAt })
    await first.sidecar.table('terminal_details').put(key, record)
    await first.sidecar.table('health_checks').put('purge-readiness', { schemaVersion: 1, generation: 1 })
    expect(first.sidecar.table('health_checks').get('purge-readiness')).toEqual({ schemaVersion: 1, generation: 1 })
    expect(await first.sidecar.table('health_checks').delete('purge-readiness')).toBe(true)
    await dispose(first)

    const second = await mount(storagePath, backend)
    try {
      expect(second.main.global.get().lastSuccessfulStoreWriteAt).toBe(record.failureOccurredAt)
      expect(second.sidecar.table('terminal_details').get(key)).toEqual(record)
      expect(second.sidecar.table('health_checks').size).toBe(0)
    } finally {
      await dispose(second)
    }
  })
})
