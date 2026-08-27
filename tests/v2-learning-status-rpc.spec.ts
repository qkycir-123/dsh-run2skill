import { describe, expect, it, vi } from 'vitest'
import { createV2LearningStatusRpcHandler } from '../src/adapters/dsh-connection/v2-learning-status-rpc.js'
import { SessionBatchCoordinator } from '../src/application/batch/index.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

describe('v2 learning status RPC', () => {
  it('projects a recorded Session and queues one durable idempotent immediate request', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const fixture = createMinimalV2Fixtures()
    const coordinator = new SessionBatchCoordinator(domain, {
      captureBaseline: async () => fixture.sessionBatch.batchManifestBaseline,
      captureRouteSnapshot: async () => fixture.sessionBatch.routeSnapshot,
    })
    await coordinator.recordObservation(fixture.turnObservation)
    const handler = createV2LearningStatusRpcHandler(() => domain, {
      resolveSession: lifecycleKey => lifecycleKey === fixture.turnObservation.sessionLifecycleKey
        ? {
            sessionId: 'session-a',
            workspaceBinding: { workspaceId: 'workspace-a', canonicalPath: 'D:/workspace' },
          }
        : undefined,
      resolveWorkspace: async workspaceId => ({ workspaceId, canonicalPath: 'D:/workspace' }),
      requestSynthesis: lifecycleKey => coordinator.requestSynthesis(lifecycleKey),
    })
    const payload = {
      apiVersion: 1,
      currentScope: { kind: 'WORKSPACE' as const, generation: 1, workspaceId: 'workspace-a' },
      sessionId: 'session-a',
    }
    const signal = new AbortController().signal

    await expect(handler('learning/status', payload, signal)).resolves.toMatchObject({
      ok: true,
      value: { apiVersion: 1, state: 'RECORDED', canRequest: true },
    })
    await expect(handler('learning/request', payload, signal)).resolves.toMatchObject({
      ok: true,
      value: { changed: true, disposition: 'QUEUED' },
    })
    await expect(handler('learning/request', payload, signal)).resolves.toMatchObject({
      ok: true,
      value: { changed: false, disposition: 'QUEUED' },
    })
    expect(domain.sessionBatches.size).toBe(0)
  })

  it('rejects a Session projected through a different current Workspace', async () => {
    const domain = createMemoryRun2skillV2Domain()
    const fixture = createMinimalV2Fixtures()
    const coordinator = new SessionBatchCoordinator(domain, {
      captureBaseline: async () => fixture.sessionBatch.batchManifestBaseline,
      captureRouteSnapshot: async () => fixture.sessionBatch.routeSnapshot,
    })
    await coordinator.recordObservation(fixture.turnObservation)
    const handler = createV2LearningStatusRpcHandler(() => domain, {
      resolveSession: () => ({
        sessionId: 'session-a',
        workspaceBinding: { workspaceId: 'workspace-a', canonicalPath: 'D:/workspace-a' },
      }),
      resolveWorkspace: async workspaceId => ({ workspaceId, canonicalPath: 'D:/workspace-b' }),
      requestSynthesis: lifecycleKey => coordinator.requestSynthesis(lifecycleKey),
    })

    await expect(handler('learning/request', {
      apiVersion: 1,
      currentScope: { kind: 'WORKSPACE', generation: 1, workspaceId: 'workspace-b' },
      sessionId: 'session-a',
    }, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } })
  })

  it.each(['learning/status', 'learning/request'] as const)(
    'rejects %s when a Workspace-bound Session is projected through USER_ONLY',
    async endpoint => {
      const domain = createMemoryRun2skillV2Domain()
      const fixture = createMinimalV2Fixtures()
      const coordinator = new SessionBatchCoordinator(domain, {
        captureBaseline: async () => fixture.sessionBatch.batchManifestBaseline,
        captureRouteSnapshot: async () => fixture.sessionBatch.routeSnapshot,
      })
      await coordinator.recordObservation(fixture.turnObservation)
      const requestSynthesis = vi.fn((lifecycleKey: string) => coordinator.requestSynthesis(lifecycleKey))
      const handler = createV2LearningStatusRpcHandler(() => domain, {
        resolveSession: () => ({
          sessionId: 'session-a',
          workspaceBinding: { workspaceId: 'workspace-a', canonicalPath: 'D:/workspace-a' },
        }),
        resolveWorkspace: async workspaceId => ({ workspaceId, canonicalPath: 'D:/workspace-a' }),
        requestSynthesis,
      })

      await expect(handler(endpoint, {
        apiVersion: 1,
        currentScope: { kind: 'USER_ONLY', generation: 1 },
        sessionId: 'session-a',
      }, new AbortController().signal)).resolves.toMatchObject({
        ok: false,
        error: { code: 'conflict' },
      })
      expect(requestSynthesis).not.toHaveBeenCalled()
    },
  )

  it.each(['learning/status', 'learning/request'] as const)(
    'allows %s through USER_ONLY only when the Session has no Workspace binding',
    async endpoint => {
      const domain = createMemoryRun2skillV2Domain()
      const fixture = createMinimalV2Fixtures()
      const coordinator = new SessionBatchCoordinator(domain, {
        captureBaseline: async () => fixture.sessionBatch.batchManifestBaseline,
        captureRouteSnapshot: async () => fixture.sessionBatch.routeSnapshot,
      })
      await coordinator.recordObservation(fixture.turnObservation)
      const requestSynthesis = vi.fn((lifecycleKey: string) => coordinator.requestSynthesis(lifecycleKey))
      const handler = createV2LearningStatusRpcHandler(() => domain, {
        resolveSession: () => ({ sessionId: 'session-a' }),
        resolveWorkspace: async () => undefined,
        requestSynthesis,
      })

      await expect(handler(endpoint, {
        apiVersion: 1,
        currentScope: { kind: 'USER_ONLY', generation: 1 },
        sessionId: 'session-a',
      }, new AbortController().signal)).resolves.toMatchObject({ ok: true })
      expect(requestSynthesis).toHaveBeenCalledTimes(endpoint === 'learning/request' ? 1 : 0)
    },
  )
})
