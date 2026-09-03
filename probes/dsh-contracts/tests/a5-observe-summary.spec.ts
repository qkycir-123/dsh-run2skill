import { Context, Service } from '@deepseek-ai/cordis'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { apply as applyClientGateway, inject as clientGatewayInject } from '@deepseek-ai/dsh-api-gateway/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it } from 'vitest'
import { createObserveSummaryRpcHandler } from '../src/adapters/dsh-connection/observe-summary-rpc.ts'
import { RUN2SKILL_REMOTE } from '../src/adapters/dsh-remote/contract.ts'
import { Run2skillRemoteService } from '../src/adapters/dsh-remote/service.ts'
import { TYPERT } from '../src/adapters/dsh-remote/typert.ts'

type RpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }
type RpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult>

class FakeHostConnection extends Service {
  channel: string | undefined
  handler: RpcHandler | undefined

  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  get rpc() {
    return {
      intercept: (channel: string, _matches: (endpoint: string) => boolean, handler: RpcHandler) =>
        this.ctx.effect(() => {
          this.channel = channel
          this.handler = handler
          return () => {
            this.channel = undefined
            this.handler = undefined
          }
        }),
    }
  }
}

async function hostBench(): Promise<{ readonly ctx: Context; readonly connection: FakeHostConnection }> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(FakeHostConnection)
  await ctx.plugin(TypertGatewayService)
  ctx.typert.register(TYPERT as never)
  new Run2skillRemoteService(ctx, createObserveSummaryRpcHandler(() => ({
    apiVersion: 1,
    status: 'READY',
    capturedCount: 1,
    blockedCaptureCount: 0,
    unsaved: { completeness: 'KNOWN', knownCount: 0 },
    recoveryLag: false,
  })))
  return { ctx, connection: ctx.get('connection') as unknown as FakeHostConnection }
}

async function *unusedStream(): AsyncGenerator<never> {
  throw new Error('run2skill probe did not request a stream')
}

describe('A5 Run2Skill on the DSH 0.1.2 Remote seam', () => {
  it('dispatches the strict Host descriptor through the shared /api gateway', async () => {
    const { connection } = await hostBench()
    expect(connection.channel).toBe('/api')
    const signal = new AbortController().signal
    await expect(connection.handler?.('run2skill/query', {
      args: { request: { endpoint: 'observe-summary', payload: { apiVersion: 1 } } },
    }, signal)).resolves.toMatchObject({
      ok: true,
      value: { ok: true, value: { apiVersion: 1, status: 'READY', capturedCount: 1 } },
    })
    await expect(connection.handler?.('run2skill/query', {
      args: { request: { endpoint: 'learning/request', payload: { apiVersion: 1 } } },
    }, signal)).resolves.toMatchObject({ ok: false, error: { code: 'gateway/input-invalid' } })
  })

  it('mounts the Client contribution and completes a typed round trip', async () => {
    const { connection } = await hostBench()
    const handler = connection.handler
    if (handler === undefined) throw new Error('Host gateway handler was not registered')
    const client = new Context()
    await client.plugin(TypertRegistry)
    client.provide('connection', {
      rpc: {
        call: async (_channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) =>
          await handler(endpoint, payload, signal ?? new AbortController().signal),
        open: () => unusedStream(),
      },
      registerGenerationSource: () => () => undefined,
      start: () => ({ stop() {} }),
    } as unknown as ConnectionHandle)
    await client.plugin({ inject: clientGatewayInject, apply: applyClientGateway })
    const dispose = await client.remote.$mount(RUN2SKILL_REMOTE)
    const result = await client.remote.run2skill.query({
      endpoint: 'observe-summary', payload: { apiVersion: 1 },
    })
    expect(result).toMatchObject({
      ok: true,
      value: { ok: true, value: { apiVersion: 1, status: 'READY' } },
    })
    await dispose()
  })
})
