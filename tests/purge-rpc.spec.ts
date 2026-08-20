import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createPurgeRpcHandler } from '../src/adapters/dsh-connection/purge-rpc.js'
import { PurgeService } from '../src/application/purge/index.js'
import {
  MAX_COMPLETED_PROJECT_PURGE_FENCES,
  type ProjectPurgeScopeBindingV1,
} from '../src/domain/purge/index.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'

const project = join(process.cwd(), '.probe-work', 'purge-rpc')
const binding: ProjectPurgeScopeBindingV1 = {
  scope: 'PROJECT',
  workspaceId: 'workspace-rpc',
  canonicalWorkspacePath: project,
  workspaceObservedAt: '2026-08-21T00:00:00.000Z',
  canonicalRootPath: join(project, '.dsh', 'skills'),
  rootContractVersion: 'stock-dsh-web-default-roots-v1',
  resolverVersion: 'stock-root-resolver-v2',
  resolutionContractDigest: 'a'.repeat(64),
}

describe('Purge RPC v1', () => {
  it('strictly dispatches preview, confirm, status, and retry without exposing paths in errors', async () => {
    const domain = createMemoryRun2skillDomain()
    const service = new PurgeService(domain, { async resolve() { return binding } }, {
      now: () => Date.parse('2026-08-21T00:00:00.000Z'),
    })
    const gate = vi.fn()
    const handler = createPurgeRpcHandler(service, undefined, {
      runMutation: async operation => {
        gate()
        return await operation()
      },
    })
    const signal = new AbortController().signal

    const preview = await handler('purge/preview', {
      apiVersion: 1, scope: 'PROJECT', workspaceId: binding.workspaceId,
    }, signal)
    expect(preview.ok).toBe(true)
    if (!preview.ok) throw new Error('preview failed')
    const value = preview.value as { previewId: string; digest: string }

    await expect(handler('purge/confirm', {
      apiVersion: 1, previewId: value.previewId, digest: value.digest,
    }, signal)).resolves.toMatchObject({ ok: true, value: { state: 'COMPLETED' } })
    await expect(handler('purge/status', { apiVersion: 1 }, signal))
      .resolves.toEqual({ ok: true, value: { apiVersion: 1, state: 'IDLE' } })
    expect(gate).toHaveBeenCalledTimes(1)

    const invalid = await handler('purge/preview', {
      apiVersion: 1, scope: 'PROJECT', workspaceId: binding.workspaceId, path: project,
    }, signal)
    expect(invalid).toEqual({
      ok: false,
      error: { code: 'bad-request', message: 'bad-request', details: {} },
    })
    expect(JSON.stringify(invalid)).not.toContain(project)
  })

  it('delegates non-purge endpoints and rejects cancelled calls', async () => {
    const domain = createMemoryRun2skillDomain()
    const service = new PurgeService(domain, { async resolve() { return binding } })
    const fallback = vi.fn(async () => ({ ok: true as const, value: { delegated: true } }))
    const handler = createPurgeRpcHandler(service, fallback)
    const signal = new AbortController().signal
    await expect(handler('summary', {}, signal)).resolves.toEqual({ ok: true, value: { delegated: true } })
    expect(fallback).toHaveBeenCalledTimes(1)

    const aborted = new AbortController()
    aborted.abort()
    await expect(handler('purge/status', { apiVersion: 1 }, aborted.signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('returns PURGE_FENCE_LIMIT without writing a journal', async () => {
    const domain = createMemoryRun2skillDomain()
    const projects = Object.fromEntries(Array.from(
      { length: MAX_COMPLETED_PROJECT_PURGE_FENCES },
      (_, index) => {
        const digest = index.toString(16).padStart(64, '0')
        return [digest, {
          schemaVersion: 1 as const,
          scope: 'PROJECT' as const,
          purgeId: `purge_${digest}`,
          completedAt: '2026-08-20T00:00:00.000Z',
          hideBefore: '2026-08-20T00:00:00.000Z',
          scopeIdentityDigest: digest,
        }]
      },
    ))
    await domain.global.set({
      ...domain.global.get(),
      completedPurgeFences: { schemaVersion: 1, projects },
    })
    const service = new PurgeService(domain, { async resolve() { return binding } })
    const handler = createPurgeRpcHandler(service)

    await expect(handler('purge/preview', {
      apiVersion: 1, scope: 'PROJECT', workspaceId: binding.workspaceId,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'PURGE_FENCE_LIMIT', details: {} },
    })
    expect(domain.global.get().purgeJournal).toBeUndefined()
  })
})
