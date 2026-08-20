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
import { DurableCaptureStore } from '../src/adapters/dsh-storage/durable-capture-store.ts'
import { WriteBehindCheckpoint } from '../src/application/capture/write-behind-checkpoint.ts'
import type { Run2skillDomain } from '../src/adapters/dsh-storage/types.ts'
import { deriveSessionLifecycleKeyFromFacts } from '../src/domain/observe/identity.ts'
import { makeWorkItem } from './support/work-item-fixture.ts'

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
  const domain = await ctx.storageDomain.open(run2skillDomainSpec)
  return { ctx, storageFiber, backendFiber, domainFiber, domain }
}

async function dispose(instance: Awaited<ReturnType<typeof mount>>) {
  await instance.domain.close()
  await instance.domainFiber.dispose()
  await instance.backendFiber.dispose()
  await instance.storageFiber.dispose()
}

describe('A3 run2skill_v1 real Storage Domain portability', () => {
  it.each([
    { backend: 'json' as const, path: (directory: string) => join(directory, 'storages') },
    { backend: 'sqlite' as const, path: (directory: string) => join(directory, 'run2skill.db') },
  ])('persists idempotent capture and global state across $backend restart', async ({ backend, path }) => {
    const directory = await mkdtemp(join(tmpdir(), `dsh-run2skill-a3-${backend}-`))
    temporaryDirectories.push(directory)
    const mediumPath = path(directory)
    const first = await mount(mediumPath, backend)
    const store = new DurableCaptureStore(first.domain as unknown as Run2skillDomain)
    const item = makeWorkItem()
    const session = {
      rootSessionId: 'session-1', sessionCreatedAt: 100,
      sessionCwdDigest: 'a'.repeat(64), triggerPolicyVersion: 'cheap-trigger-v1' as const,
      activationFenceSeq: 10, durableNextSeq: 10, observedTailSeq: 10,
    }
    const checkpoint = new WriteBehindCheckpoint(
      first.domain as unknown as Run2skillDomain,
      { now: () => 0, turnBatch: 1 },
    )

    await Promise.all(Array.from({ length: 20 }, async () => await store.persist(item)))
    await checkpoint.activate([session])
    await checkpoint.observeCompletedRoot({
      ...session, durableNextSeq: 14, observedTailSeq: 13,
    })
    expect(first.domain.table('work_items').size).toBe(1)
    await dispose(first)

    const second = await mount(mediumPath, backend)
    try {
      expect(second.domain.table('work_items').get(item.workItemId)).toEqual(item)
      expect(second.domain.global.get().lastSuccessfulStoreWriteAt).toBe('1970-01-01T00:00:00.000Z')
      expect(second.domain.global.get().sessions[deriveSessionLifecycleKeyFromFacts(session)]).toMatchObject({
        activationFenceSeq: 10,
        durableNextSeq: 14,
        observedTailSeq: 13,
      })
      expect(second.domain.global.get().checkpoint).toMatchObject({
        dirty: false, pendingSessionCount: 0,
      })
      expect(second.domain.table('lineages').size).toBe(0)
    } finally {
      await dispose(second)
    }
  })

  it.each([
    { backend: 'json' as const, path: (directory: string) => join(directory, 'storages') },
    { backend: 'sqlite' as const, path: (directory: string) => join(directory, 'run2skill.db') },
  ])('fails loud on a $backend domain version mismatch without clearing durable data', async ({ backend, path }) => {
    const directory = await mkdtemp(join(tmpdir(), `dsh-run2skill-schema-${backend}-`))
    temporaryDirectories.push(directory)
    const mediumPath = path(directory)
    const first = await mount(mediumPath, backend)
    await first.domain.global.set({
      ...first.domain.global.get(),
      lastSuccessfulStoreWriteAt: '2026-08-21T00:00:00.000Z',
    })
    await dispose(first)

    const ctx = new Context()
    const storageFiber = await ctx.plugin(Storage)
    const backendFiber = backend === 'json'
      ? await ctx.plugin(StorageJson, { root: mediumPath })
      : await ctx.plugin(StorageSqlite, { path: mediumPath })
    const domainFiber = await ctx.plugin(StorageDomain, { backend })
    await vi.waitFor(() => expect(ctx.storageDomain).toBeDefined())
    try {
      await expect(ctx.storageDomain.open({ ...run2skillDomainSpec, version: 3 })).rejects.toThrow()
    } finally {
      await domainFiber.dispose()
      await backendFiber.dispose()
      await storageFiber.dispose()
    }

    const restored = await mount(mediumPath, backend)
    try {
      expect(restored.domain.global.get().lastSuccessfulStoreWriteAt).toBe('2026-08-21T00:00:00.000Z')
    } finally {
      await dispose(restored)
    }
  })

  it('batches 10,000 no-signal turns on the real DSH JSON Storage backend', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-run2skill-a3-json-batch-'))
    temporaryDirectories.push(directory)
    const instance = await mount(join(directory, 'storages'), 'json')
    let globalPublishes = 0
    instance.ctx.on('domain/changed', (change) => {
      if (change.domain === 'run2skill_v1' && change.table === '') globalPublishes += 1
    })
    let now = 0
    const checkpoint = new WriteBehindCheckpoint(
      instance.domain as unknown as Run2skillDomain,
      { now: () => now },
    )
    const base = {
      rootSessionId: 'session-1', sessionCreatedAt: 100,
      sessionCwdDigest: 'a'.repeat(64), triggerPolicyVersion: 'cheap-trigger-v1' as const,
      activationFenceSeq: 0, durableNextSeq: 0, observedTailSeq: 0,
    }

    try {
      await checkpoint.activate([base])
      for (let turn = 0; turn < 10_000; turn += 1) {
        await checkpoint.observeCompletedRoot({
          ...base,
          durableNextSeq: turn * 2 + 2,
          observedTailSeq: turn * 2 + 1,
        })
      }
      expect(instance.domain.table('work_items').size).toBe(0)
      expect(globalPublishes).toBe(313)
      const lifecycleKey = deriveSessionLifecycleKeyFromFacts(base)
      expect(instance.domain.global.get().sessions[lifecycleKey]).toMatchObject({
        durableNextSeq: 19_968,
        observedTailSeq: 19_967,
      })
      expect(checkpoint.snapshot().sessions[lifecycleKey]).toMatchObject({
        durableNextSeq: 20_000,
        observedTailSeq: 19_999,
      })
      expect(checkpoint.snapshot().checkpoint.dirty).toBe(true)

      now = 30_000
      await checkpoint.flushIfDue()
      expect(instance.domain.global.get().sessions[lifecycleKey]).toMatchObject({
        durableNextSeq: 20_000,
        observedTailSeq: 19_999,
      })
      expect(instance.domain.global.get().checkpoint.dirty).toBe(false)
      expect(globalPublishes).toBe(314)
    } finally {
      await dispose(instance)
    }
  })
})
