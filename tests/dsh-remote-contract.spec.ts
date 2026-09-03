import { describe, expect, it, vi } from 'vitest'
import {
  RUN2SKILL_COMMAND_ENDPOINTS,
  RUN2SKILL_QUERY_ENDPOINTS,
  RUN2SKILL_REMOTE,
  routeRun2skillEndpoint,
} from '../src/adapters/dsh-remote/contract.js'
import { createRun2skillRemoteCaller } from '../src/adapters/dsh-remote/client.js'
import { Run2skillRemoteService } from '../src/adapters/dsh-remote/service.js'
import { TYPERT } from '../src/adapters/dsh-remote/typert.js'

describe('DSH 0.1.2 Remote contract', () => {
  it('publishes one strict descriptor source to both Host and Client', () => {
    expect(RUN2SKILL_REMOTE).toMatchObject({ package: 'dsh-run2skill' })
    expect(RUN2SKILL_REMOTE.descriptors).toBe(TYPERT.invocations)
    expect(RUN2SKILL_REMOTE.descriptors.map(descriptor => descriptor.method)).toEqual([
      'query',
      'command',
    ])
    for (const descriptor of RUN2SKILL_REMOTE.descriptors) {
      expect(descriptor.parameters).toHaveLength(1)
      expect(descriptor.parameters[0]?.codec.mode).toBe('strict')
      expect(descriptor.result.mode).toBe('strict')
      expect(descriptor.cancellation).toEqual({ parameter: 'signal' })
    }
  })

  it('classifies every supported endpoint and rejects unknown endpoints', () => {
    for (const endpoint of RUN2SKILL_QUERY_ENDPOINTS) {
      expect(routeRun2skillEndpoint(endpoint)).toBe('query')
    }
    for (const endpoint of RUN2SKILL_COMMAND_ENDPOINTS) {
      expect(routeRun2skillEndpoint(endpoint)).toBe('command')
    }
    expect(() => routeRun2skillEndpoint('not-supported')).toThrow('unknown run2skill endpoint')
  })

  it('keeps queries and commands separated on the Host and forwards cancellation', async () => {
    let published: unknown
    const context = {
      reflect: {
        provide(_name: string, service: unknown) { published = service },
      },
    }
    const handler = vi.fn(async () => ({ ok: true as const, value: { status: 'READY' } }))
    const service = new Run2skillRemoteService(context as never, handler)
    expect(published).toBe(service)

    const signal = new AbortController().signal
    await expect(service.query({ endpoint: 'observe-summary', payload: { apiVersion: 1 } }, signal))
      .resolves.toEqual({ ok: true, value: { status: 'READY' } })
    expect(handler).toHaveBeenLastCalledWith('observe-summary', { apiVersion: 1 }, signal)

    await expect(service.command({ endpoint: 'learning/request', payload: { apiVersion: 1 } }, signal))
      .resolves.toEqual({ ok: true, value: { status: 'READY' } })
    expect(handler).toHaveBeenLastCalledWith('learning/request', { apiVersion: 1 }, signal)

    await expect(service.query({ endpoint: 'learning/request', payload: {} } as never, signal))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(service.command({ endpoint: 'observe-summary', payload: {} } as never, signal))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('mounts the Client contribution, chooses the right method, and unwraps carrier failures', async () => {
    const dispose = vi.fn(async () => undefined)
    const query = vi.fn(async () => ({ ok: true as const, value: { ok: true, value: { status: 'READY' } } }))
    const command = vi.fn(async () => ({ ok: true as const, value: { ok: true, value: { accepted: true } } }))
    const remote = {
      run2skill: { query, command },
      $mount: vi.fn(async () => dispose),
    }
    const mounted = await createRun2skillRemoteCaller(remote as never)
    expect(remote.$mount).toHaveBeenCalledWith(RUN2SKILL_REMOTE)

    const signal = new AbortController().signal
    await expect(mounted.call('attention', { apiVersion: 1 }, signal))
      .resolves.toEqual({ ok: true, value: { status: 'READY' } })
    expect(query).toHaveBeenCalledWith({ endpoint: 'attention', payload: { apiVersion: 1 } }, signal)

    await expect(mounted.call('purge/confirm', { apiVersion: 1 }, signal))
      .resolves.toEqual({ ok: true, value: { accepted: true } })
    expect(command).toHaveBeenCalledWith({ endpoint: 'purge/confirm', payload: { apiVersion: 1 } }, signal)

    query.mockResolvedValueOnce({
      ok: false,
      error: { code: 'gateway/cancelled', message: 'cancelled', details: {} },
    } as never)
    await expect(mounted.call('observe-summary', { apiVersion: 1 }, signal)).resolves.toEqual({
      ok: false,
      error: { code: 'gateway/cancelled', message: 'cancelled', details: {} },
    })
    await mounted.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
