import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openRun2skillDomain } from '../src/adapters/dsh-storage/domain.js'
import { DurableCaptureStore } from '../src/adapters/dsh-storage/durable-capture-store.js'
import { PurgeVisibility } from '../src/adapters/dsh-storage/purge-visibility.js'
import { PurgeService } from '../src/application/purge/index.js'
import {
  deriveProjectPurgeScopeIdentityDigest,
  type ProjectPurgeScopeBindingV1,
} from '../src/domain/purge/index.js'
import { makeWorkItem } from './support/work-item-fixture.js'

const cleanup = new Set<string>()

async function freshDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  cleanup.add(directory)
  return directory
}

afterEach(async () => {
  await Promise.all([...cleanup].map(async directory => await rm(directory, { recursive: true, force: true })))
  cleanup.clear()
})

type Backend = 'json' | 'sqlite'

async function mount(path: string, backend: Backend) {
  const ctx = new Context()
  const storageFiber = await ctx.plugin(Storage)
  const backendFiber = backend === 'json'
    ? await ctx.plugin(StorageJson, { root: path })
    : await ctx.plugin(StorageSqlite, { path })
  const domainFiber = await ctx.plugin(StorageDomain, { backend })
  await vi.waitFor(() => { expect(ctx.storageDomain).toBeDefined() })
  const domain = await openRun2skillDomain(ctx)
  return { ctx, storageFiber, backendFiber, domainFiber, domain }
}

async function dispose(value: Awaited<ReturnType<typeof mount>>) {
  await value.domain.close()
  await value.domainFiber.dispose()
  await value.backendFiber.dispose()
  await value.storageFiber.dispose()
}

describe('D2 Purge on stock DSH Storage Domain', () => {
  it.each([
    { backend: 'json' as const, medium: 'Web JSON', path: (base: string) => join(base, 'storage') },
    { backend: 'sqlite' as const, medium: 'SQLite comparison', path: (base: string) => join(base, 'storage.db') },
  ])('keeps the hide fence durable and resumes deletion after restart on $medium', async ({ backend, path }) => {
    const base = await freshDirectory(`dsh-run2skill-d2-purge-${backend}-`)
    const project = join(base, 'project')
    const root = join(project, '.dsh', 'skills')
    const sessionLog = join(base, 'session-log.jsonl')
    const publishedSkill = join(base, 'published-SKILL.md')
    const sessionBytes = '{"type":"turn/end","data":{"private":"preserved"}}\n'
    const skillBytes = '---\nname: preserved\ndescription: preserved\n---\n\nExact bytes.\n'
    await writeFile(sessionLog, sessionBytes)
    await writeFile(publishedSkill, skillBytes)
    const binding: ProjectPurgeScopeBindingV1 = {
      scope: 'PROJECT',
      workspaceId: 'workspace-d2-probe',
      canonicalWorkspacePath: project,
      workspaceObservedAt: '2026-08-21T00:00:00.000Z',
      canonicalRootPath: root,
      rootContractVersion: 'stock-dsh-web-default-roots-v1',
      resolverVersion: 'stock-root-resolver-v2',
      resolutionContractDigest: 'a'.repeat(64),
    }
    const resolver = { async resolve() { return binding } }
    const mediumPath = path(base)
    const first = await mount(mediumPath, backend)
    const item = makeWorkItem({
      workspaceBinding: {
        status: 'BOUND', workspaceId: binding.workspaceId, canonicalPath: project,
        observedAt: '2026-08-20T00:00:00.000Z',
      },
    })
    await first.domain.table('work_items').put(item.workItemId, item)
    let stopped = false
    const service = new PurgeService(first.domain, resolver, {
      now: () => Date.parse('2026-08-21T00:00:00.000Z'),
      onPhasePersisted(phase) {
        if (!stopped && phase === 'DELETING_WORK_ITEMS') {
          stopped = true
          throw new Error('synthetic process stop')
        }
      },
    })
    const preview = await service.preview('PROJECT', binding.workspaceId)
    await expect(service.confirm(preview.previewId, preview.digest))
      .rejects.toMatchObject({ code: 'PURGE_STORAGE_UNAVAILABLE' })
    expect(first.domain.global.get().purgeJournal?.phase).toBe('DELETING_WORK_ITEMS')
    await dispose(first)

    const second = await mount(mediumPath, backend)
    try {
      const restarted = new PurgeService(second.domain, resolver, {
        now: () => Date.parse('2026-08-21T00:00:01.000Z'),
      })
      await expect(restarted.recover()).resolves.toMatchObject({ state: 'COMPLETED' })
      expect(second.domain.table('work_items').get(item.workItemId)).toBeUndefined()
      expect(second.domain.global.get().purgeJournal).toBeUndefined()
      const scopeIdentityDigest = deriveProjectPurgeScopeIdentityDigest(binding)
      expect(second.domain.global.get().completedPurgeFences?.projects[scopeIdentityDigest])
        .toMatchObject({ scope: 'PROJECT', hideBefore: preview.hideBefore, scopeIdentityDigest })
    } finally {
      await dispose(second)
    }

    const third = await mount(mediumPath, backend)
    try {
      const restartedStore = new DurableCaptureStore(
        third.domain,
        undefined,
        new PurgeVisibility(third.domain),
      )
      await expect(restartedStore.persist(item)).rejects.toMatchObject({ code: 'PURGED_WORK_ITEM' })
      expect(await readFile(sessionLog, 'utf8')).toBe(sessionBytes)
      expect(await readFile(publishedSkill, 'utf8')).toBe(skillBytes)
    } finally {
      await dispose(third)
    }
  })
})
