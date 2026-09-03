import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import { DshSessionGapReader } from '../src/adapters/dsh-session/gap-reader.ts'
import type { SessionPersistencePort } from '../src/adapters/dsh-session/types.ts'
import { run2skillDomainSpec } from '../src/adapters/dsh-storage/domain.ts'
import type { Run2skillDomain } from '../src/adapters/dsh-storage/types.ts'
import { BoundedGapScanner } from '../src/application/capture/bounded-gap-scanner.ts'
import { RuntimeNotices } from '../src/application/capture/runtime-notices.ts'
import { WriteBehindCheckpoint } from '../src/application/capture/write-behind-checkpoint.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

type Backend = 'json' | 'sqlite'

async function mount(directory: string, backend: Backend) {
  const ctx = new Context()
  const sessionStoreFiber = await ctx.plugin(SessionStore)
  const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, {
    root: join(directory, 'sessions'), compression: 'none',
  })
  const storageFiber = await ctx.plugin(Storage)
  const storageBackendFiber = backend === 'json'
    ? await ctx.plugin(StorageJson, { root: join(directory, 'storages') })
    : await ctx.plugin(StorageSqlite, { path: join(directory, 'run2skill.db') })
  const domainFiber = await ctx.plugin(StorageDomain, { backend })
  await vi.waitFor(() => expect(ctx.storageDomain).toBeDefined())
  const domain = await ctx.storageDomain.open(run2skillDomainSpec)
  let ownerContext!: Context
  const ownerFiber = await ctx.plugin(Object.assign(
    (child: Context) => { ownerContext = child },
    { inject: ['sessions'] },
  ))
  return {
    ctx,
    ownerContext,
    ownerFiber,
    domain: domain as unknown as Run2skillDomain,
    domainFiber,
    storageBackendFiber,
    storageFiber,
    persistenceFiber,
    sessionStoreFiber,
  }
}

async function dispose(instance: Awaited<ReturnType<typeof mount>>) {
  await instance.ownerFiber.dispose()
  await instance.domain.close()
  await instance.domainFiber.dispose()
  await instance.storageBackendFiber.dispose()
  await instance.storageFiber.dispose()
  await instance.persistenceFiber.dispose()
  await instance.sessionStoreFiber.dispose()
}

function appendTurn(session: ReturnType<Context['sessions']['create']>, turn: number): void {
  session.append('turn/start', { turn })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function scannerFor(instance: Awaited<ReturnType<typeof mount>>, processed: Set<string>) {
  const checkpoint = new WriteBehindCheckpoint(instance.domain, { now: () => 0 })
  const reader = new DshSessionGapReader(
    instance.ctx.sessionPersistence as unknown as SessionPersistencePort,
  )
  const scanner = new BoundedGapScanner(
    reader,
    checkpoint,
    {
      processTurn: async ({ header, turnEndSeq, progress }) => {
        processed.add(`${header.id}:${String(turnEndSeq)}`)
        await checkpoint.observeCompletedRoot(progress)
      },
    },
    new RuntimeNotices({ now: () => 0 }),
  )
  return { checkpoint, scanner }
}

describe('A4 bounded recovery on real DSH persistence', () => {
  it.each([
    { backend: 'json' as const, medium: 'Web JSONL + JSON Storage' },
    { backend: 'sqlite' as const, medium: 'JSONL Session + SQLite Storage' },
  ])('fences old history, captures a changed revision, and skips it after restart on $medium', async ({ backend }) => {
    const directory = await mkdtemp(join(tmpdir(), `dsh-run2skill-a4-${backend}-`))
    temporaryDirectories.push(directory)
    const first = await mount(directory, backend)
    const sessionId = SessionId(`a4-${backend}-session`)
    try {
      const session = first.ownerContext.sessions.create(sessionId, { meta: { cwd: directory } })
      appendTurn(session, 1)
      await first.ownerContext.sessions.flush(session)
      const processed = new Set<string>()
      const firstScanner = scannerFor(first, processed)

      await expect(firstScanner.scanner.ensureActivated()).resolves.toMatchObject({
        status: 'COMPLETE', processedEvents: 2,
      })
      expect(processed.size).toBe(0)

      appendTurn(session, 2)
      await first.ownerContext.sessions.flush(session)
      await expect(firstScanner.scanner.scanBatch()).resolves.toMatchObject({
        status: 'COMPLETE', processedEvents: 2,
      })
      expect(processed).toEqual(new Set([`${sessionId}:3`]))
      expect(first.ctx.get('llm')).toBeUndefined()
    } finally {
      await dispose(first)
    }

    const second = await mount(directory, backend)
    try {
      const restartedProcessed = new Set<string>()
      const restarted = scannerFor(second, restartedProcessed)
      await expect(restarted.scanner.scanBatch()).resolves.toMatchObject({
        status: 'COMPLETE', processedSessions: 0, processedEvents: 0,
      })
      expect(restartedProcessed.size).toBe(0)
      expect(second.ctx.get('llm')).toBeUndefined()
    } finally {
      await dispose(second)
    }
  })

  it('records the real Web JSONL large-log recovery envelope without claiming bounded physical reads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-run2skill-a4-large-json-'))
    temporaryDirectories.push(directory)
    const instance = await mount(directory, 'json')
    const processed = new Set<string>()
    const { checkpoint, scanner } = scannerFor(instance, processed)
    await checkpoint.activate([])
    const session = instance.ownerContext.sessions.create(
      SessionId('a4-large-session'),
      { meta: { cwd: directory } },
    )
    for (let turn = 1; turn <= 5_001; turn += 1) appendTurn(session, turn)
    await instance.ownerContext.sessions.flush(session)

    const catchupStartedAt = performance.now()
    const first = await scanner.scanBatch()
    const second = await scanner.scanBatch()
    const catchupTimeMs = performance.now() - catchupStartedAt

    try {
      expect(first).toMatchObject({ status: 'MORE', processedEvents: 10_000 })
      expect(second).toMatchObject({ status: 'COMPLETE', processedEvents: 2 })
      expect(processed.size).toBe(5_001)
      expect(instance.domain.table('work_items').size).toBe(0)
      expect(instance.ctx.get('llm')).toBeUndefined()
      console.info(`A4_LARGE_LOG_METRICS=${JSON.stringify({
        firstReadFromLatencyMs: first.maxReadFromLatencyMs,
        secondReadFromLatencyMs: second.maxReadFromLatencyMs,
        peakHeapBytes: Math.max(first.peakHeapBytes, second.peakHeapBytes),
        recoveryLagAfterFirst: first.status === 'MORE',
        catchupTimeMs,
      })}`)
    } finally {
      await dispose(instance)
    }
  }, 30_000)
})
