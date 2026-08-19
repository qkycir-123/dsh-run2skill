import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function freshDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

type SessionPersistenceKind = 'jsonl' | 'sqlite'

async function mountSessionPersistence(path: string, backend: SessionPersistenceKind) {
  const ctx = new Context()
  const sessionStoreFiber = await ctx.plugin(SessionStore)
  const persistenceFiber = backend === 'jsonl'
    ? await ctx.plugin(JsonlSessionPersistence, { root: path, compression: 'none' })
    : await ctx.plugin(SqliteSessionPersistence, { path })
  return { ctx, sessionStoreFiber, persistenceFiber }
}

async function disposeSessionPersistence(mount: Awaited<ReturnType<typeof mountSessionPersistence>>) {
  await mount.persistenceFiber.dispose()
  await mount.sessionStoreFiber.dispose()
}

describe('CP-SES-001 session observation and restart recovery', () => {
  it.each([
    { backend: 'jsonl' as const, medium: 'Web profile JSONL', path: (directory: string) => join(directory, 'sessions') },
    { backend: 'sqlite' as const, medium: 'portable SQLite', path: (directory: string) => join(directory, 'sessions.db') },
  ])('contains observer failure, distinguishes roots, scans a durable gap, and releases live sessions with $medium', async ({ backend, path }) => {
    const directory = await freshDirectory(`dsh-run2skill-session-${backend}-`)
    const persistencePath = path(directory)
    const first = await mountSessionPersistence(persistencePath, backend)
    const rootId = SessionId('run2skill-probe-root')
    const childId = SessionId('run2skill-probe-child')
    const observed: SessionEvent[] = []
    const disposed: SessionId[] = []
    let ownerContext!: Context

    first.ctx.on('session/event', () => {
      throw new Error('contract probe observer failure')
    })
    first.ctx.on('session/event', (_session, event) => {
      observed.push(event)
    })
    first.ctx.on('session/disposed', session => {
      disposed.push(session.id)
    })

    const ownerFiber = await first.ctx.plugin(Object.assign(
      (ctx: Context) => { ownerContext = ctx },
      { inject: ['sessions'] },
    ))

    const root = ownerContext.sessions.create(rootId, { meta: { cwd: directory } })
    expect(root.firstLiveSeq).toBe(0)
    expect(root.header).toMatchObject({ id: rootId, cwd: directory })
    expect(root.header.origin).toBeUndefined()
    expect(root.header.delegationDepth).toBeUndefined()

    root.append('turn/start', { turn: 1 })
    root.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ownerContext.sessions.flush(root)
    const checkpoint = root.events.length
    const before = await first.ctx.sessionPersistence.listSnapshots()
    const beforeRevision = before.find(snapshot => snapshot.header.id === rootId)?.revision
    expect(beforeRevision).toBeDefined()

    root.append('turn/start', { turn: 2 })
    root.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await ownerContext.sessions.flush(root)
    const after = await first.ctx.sessionPersistence.listSnapshots()
    const afterRevision = after.find(snapshot => snapshot.header.id === rootId)?.revision
    expect(afterRevision).toBeDefined()
    expect(afterRevision).not.toBe(beforeRevision)

    const child = ownerContext.sessions.create(childId, {
      meta: {
        cwd: directory,
        parentSession: rootId,
        origin: 'subagent',
        delegationDepth: 1,
      },
    })
    child.append('turn/start', { turn: 1 })
    child.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ownerContext.sessions.flush(child)

    expect(observed.map(event => event.type)).toEqual([
      'turn/start',
      'turn/end',
      'turn/start',
      'turn/end',
      'turn/start',
      'turn/end',
    ])

    await ownerFiber.dispose()
    expect(first.ctx.sessions.get(rootId)).toBeUndefined()
    expect(first.ctx.sessions.get(childId)).toBeUndefined()
    expect(disposed.map(String).sort()).toEqual([String(rootId), String(childId)].sort())
    await disposeSessionPersistence(first)

    const second = await mountSessionPersistence(persistencePath, backend)
    try {
      const listed = await second.ctx.sessionPersistence.list()
      expect(listed.map(header => header.id).sort()).toEqual([childId, rootId].sort())

      const rootLoaded = await second.ctx.sessionPersistence.load(rootId)
      expect(rootLoaded.meta.origin).toBeUndefined()
      expect(rootLoaded.meta.delegationDepth ?? 0).toBe(0)
      expect(rootLoaded.events.map(event => event.seq)).toEqual([0, 1, 2, 3])

      const childLoaded = await second.ctx.sessionPersistence.load(childId)
      expect(childLoaded.meta).toMatchObject({
        parentSession: rootId,
        origin: 'subagent',
        delegationDepth: 1,
      })

      const gap = await second.ctx.sessionPersistence.readFrom(rootId, checkpoint)
      expect(gap.events.map(event => ({ seq: event.seq, type: event.type }))).toEqual([
        { seq: checkpoint, type: 'turn/start' },
        { seq: checkpoint + 1, type: 'turn/end' },
      ])
    } finally {
      await disposeSessionPersistence(second)
    }
  })
})

const workitemSchema = z.object({
  state: z.enum(['pending', 'ready']),
  count: z.number().int().nonnegative(),
})

const run2skillDomain = StorageDomain.defineDomain({
  name: 'run2skillprobe',
  version: 1,
  tables: {
    workitems: StorageDomain.domainTable<string, z.infer<typeof workitemSchema>>(workitemSchema),
  },
})

type StorageBackendKind = 'json' | 'sqlite'

async function mountDomain(path: string, backend: StorageBackendKind) {
  const ctx = new Context()
  const storageFiber = await ctx.plugin(Storage)
  const backendFiber = backend === 'json'
    ? await ctx.plugin(StorageJson, { root: path })
    : await ctx.plugin(StorageSqlite, { path })
  const domainFiber = await ctx.plugin(StorageDomain, { backend })
  await vi.waitFor(() => {
    expect(ctx.storageDomain).toBeDefined()
  })
  const domain = await ctx.storageDomain.open(run2skillDomain)
  return { ctx, storageFiber, backendFiber, domainFiber, domain }
}

async function disposeDomain(mount: Awaited<ReturnType<typeof mountDomain>>) {
  await mount.domain.close()
  await mount.domainFiber.dispose()
  await mount.backendFiber.dispose()
  await mount.storageFiber.dispose()
}

describe('CP-STO-001 storage-domain durability and ordering', () => {
  it.each([
    { backend: 'json' as const, medium: 'Web profile JSON', path: (directory: string) => join(directory, 'storages') },
    { backend: 'sqlite' as const, medium: 'portable SQLite', path: (directory: string) => join(directory, 'run2skill.db') },
  ])('serializes concurrent updates, drains queued writes, and reloads $medium state after restart', async ({ backend, path }) => {
    const directory = await freshDirectory(`dsh-run2skill-storage-${backend}-`)
    const mediumPath = path(directory)
    const first = await mountDomain(mediumPath, backend)
    const table = first.domain.table('workitems')

    await table.put('counter', { state: 'pending', count: 0 })
    await Promise.all(Array.from({ length: 40 }, () =>
      table.update('counter', current => ({ ...current, count: current.count + 1 }))))
    expect(table.get('counter')).toEqual({ state: 'pending', count: 40 })
    await expect(table.update('missing', current => current)).rejects.toMatchObject({
      name: 'DomainError',
      code: 'missing-key',
    })

    const queued = Promise.all([
      table.put('alpha', { state: 'ready', count: 1 }),
      table.put('beta', { state: 'pending', count: 2 }),
    ])
    await first.domain.close()
    await queued
    await first.domainFiber.dispose()
    await first.backendFiber.dispose()
    await first.storageFiber.dispose()

    const second = await mountDomain(mediumPath, backend)
    try {
      const reopened = second.domain.table('workitems')
      expect(reopened.get('counter')).toEqual({ state: 'pending', count: 40 })
      expect(reopened.get('alpha')).toEqual({ state: 'ready', count: 1 })
      expect(reopened.get('beta')).toEqual({ state: 'pending', count: 2 })
      expect([...reopened.keys()].sort()).toEqual(['alpha', 'beta', 'counter'])
    } finally {
      await disposeDomain(second)
    }
  })
})
