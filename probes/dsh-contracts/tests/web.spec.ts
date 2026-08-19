import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ClientRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { WebRoute, WebServer, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'

function fakeWebServer(routes: WebRoute[], upgrades: WebUpgradeRoute[]): Pick<
  WebServer,
  'register' | 'registerUpgrade' | 'tapIndex' | 'port'
> {
  return {
    register(route) {
      if (routes.some(candidate => candidate.kind === route.kind && candidate.path === route.path)) {
        throw new Error(`duplicate route ${route.path}`)
      }
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade(route) {
      upgrades.push(route)
      return () => { upgrades.splice(upgrades.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
  }
}

function fakePost(headers: Record<string, string>, url: string, body: unknown): IncomingMessage {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  Object.assign(request, {
    url,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
  })
  return request
}

function fakeResponse(): { response: ServerResponse; state: { status?: number; body?: string } } {
  const state: { status?: number; body?: string } = {}
  const chunks: Buffer[] = []
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(value: number) { state.status = value; return this },
    write(value: string | Uint8Array) { chunks.push(Buffer.from(value)); return true },
    end(this: { writableEnded: boolean }, value?: unknown) {
      if (typeof value === 'string' || value instanceof Uint8Array) chunks.push(Buffer.from(value))
      if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

describe('CP-WEB-001 loopback RPC and dual-face extension seams', () => {
  it('allows loopback RPC and rejects trusted remote plus cross-origin requests before the handler', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    const upgrades: WebUpgradeRoute[] = []
    ctx.provide('webServer', fakeWebServer(routes, upgrades) as WebServer)
    const connectionFiber = await ctx.plugin(Connection, { trustedHosts: ['harness.example'] })
    const connection = ctx.get('connection') as HostConnectionHandle
    const calls: unknown[] = []
    const remove = connection.rpc.handle('/run2skill', async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: { proposalCount: 0 } }
    }, { authority: 'loopback' })
    const route = routes.find(candidate => candidate.path === '/run2skill')
    if (route === undefined) throw new Error('run2skill route was not registered')
    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('run2skill-probe-rpc'),
      method: 'proposals/list',
      payload: { sessionId: 'session-1' },
    }
    try {
      const loopback = fakeResponse()
      await route.handler(fakePost(
        { host: '127.0.0.1:3080' },
        '/run2skill/proposals/list',
        request,
      ), loopback.response)
      expect(loopback.state.status).toBe(200)
      expect(JSON.parse(String(loopback.state.body))).toMatchObject({
        type: 'server-response',
        rpcId: 'run2skill-probe-rpc',
        result: { ok: true, value: { proposalCount: 0 } },
      })

      const trustedRemote = fakeResponse()
      await route.handler(fakePost({
        host: 'harness.example',
        origin: 'http://harness.example',
        'sec-fetch-site': 'same-origin',
      }, '/run2skill/proposals/list', request), trustedRemote.response)
      expect(trustedRemote.state).toMatchObject({ status: 403, body: 'forbidden' })

      const crossOrigin = fakeResponse()
      await route.handler(fakePost({
        host: '127.0.0.1:3080',
        origin: 'http://evil.example',
        'sec-fetch-site': 'cross-site',
      }, '/run2skill/proposals/list', request), crossOrigin.response)
      expect(crossOrigin.state).toMatchObject({ status: 403, body: 'forbidden' })
      expect(calls).toEqual([{
        endpoint: 'proposals/list',
        payload: { sessionId: 'session-1' },
      }])
    } finally {
      await remove()
      await connectionFiber.dispose()
    }
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
  })

  it('pins the DSH client export and session-header action slot declarations', async () => {
    const require = createRequire(import.meta.url)
    const connectionPackagePath = require.resolve('@deepseek-ai/dsh-client-connection/package.json')
    const conversationPackagePath = require.resolve('@deepseek-ai/dsh-client-ui-conversation/package.json')
    for (const packagePath of [connectionPackagePath, conversationPackagePath]) {
      const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as {
        exports?: Record<string, unknown>
        dsh?: { client?: { platform?: string } }
      }
      expect(manifest.exports?.['./client']).toBeDefined()
      expect(manifest.dsh?.client?.platform).toBe('web')
    }

    const conversationRoot = dirname(conversationPackagePath)
    const applySource = await readFile(join(conversationRoot, 'src', 'client', 'apply.ts'), 'utf8')
    const slotContract = await readFile(join(conversationRoot, 'src', 'client', 'contract', 'slots.ts'), 'utf8')
    expect(applySource).toContain(
      "'conversation.session.header.actions': { kind: 'list', scope: 'session' }",
    )
    expect(slotContract).toContain(
      "'conversation.session.header.actions': { kind: 'list'; scope: 'session'; owner: ConversationHeaderActionOwnerProps }",
    )
  })
})
