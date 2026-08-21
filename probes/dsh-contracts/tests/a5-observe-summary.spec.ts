import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { RpcId, type ClientRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { WebRoute, WebServer, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import {
  OBSERVE_SUMMARY_ENDPOINT,
  RUN2SKILL_RPC_CHANNEL,
  registerObserveSummaryRpc,
} from '../src/adapters/dsh-connection/observe-summary-rpc.ts'
import { applyRun2skillClient, type Run2skillClientContext } from '../src/client/run2skill-settings-page.ts'
import { inject as clientInject } from '../src/client/index.ts'
import { ProposalInboxController } from '../src/client/proposal-inbox.ts'
import { ProposalInboxHeaderAction, ProposalInboxPanel } from '../src/client/proposal-inbox-view.ts'

function fakeWebServer(routes: WebRoute[], upgrades: WebUpgradeRoute[]): Pick<
  WebServer,
  'register' | 'registerUpgrade' | 'tapIndex' | 'port'
> {
  return {
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade(route) {
      upgrades.push(route)
      return () => { upgrades.splice(upgrades.indexOf(route), 1) }
    },
    tapIndex: () => () => undefined,
    port: 0,
  }
}

function fakePost(headers: Record<string, string>, body: unknown): IncomingMessage {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  Object.assign(request, {
    url: `${RUN2SKILL_RPC_CHANNEL}/${OBSERVE_SUMMARY_ENDPOINT}`,
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

describe('A5 Observe Summary on the pinned DSH Web seam', () => {
  it('serves the bounded DTO only to loopback and removes the route on dispose', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    const upgrades: WebUpgradeRoute[] = []
    ctx.provide('webServer', fakeWebServer(routes, upgrades) as WebServer)
    const connectionFiber = await ctx.plugin(Connection, { trustedHosts: ['harness.example'] })
    const connection = ctx.get('connection') as HostConnectionHandle
    const readSummary = vi.fn(() => ({
      apiVersion: 1 as const,
      status: 'READY' as const,
      capturedCount: 1,
      blockedCaptureCount: 0,
      unsaved: { completeness: 'KNOWN' as const, knownCount: 0 },
      recoveryLag: false,
    }))
    const remove = registerObserveSummaryRpc(connection, readSummary)
    const route = routes.find(candidate => candidate.path === RUN2SKILL_RPC_CHANNEL)
    if (route === undefined) throw new Error('Observe Summary route was not registered')
    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('a5-observe-summary'),
      method: OBSERVE_SUMMARY_ENDPOINT,
      payload: { apiVersion: 1 },
    }

    try {
      const loopback = fakeResponse()
      await route.handler(fakePost({ host: '127.0.0.1:3080' }, request), loopback.response)
      expect(loopback.state.status).toBe(200)
      expect(JSON.parse(String(loopback.state.body))).toMatchObject({
        type: 'server-response',
        rpcId: 'a5-observe-summary',
        result: { ok: true, value: { apiVersion: 1, capturedCount: 1 } },
      })
      expect(loopback.state.body).not.toMatch(/session|evidence|token|stack|[A-Z]:\\/i)

      const trustedRemote = fakeResponse()
      await route.handler(fakePost({
        host: 'harness.example',
        origin: 'http://harness.example',
        'sec-fetch-site': 'same-origin',
      }, request), trustedRemote.response)
      expect(trustedRemote.state).toMatchObject({ status: 403, body: 'forbidden' })

      const crossOrigin = fakeResponse()
      await route.handler(fakePost({
        host: '127.0.0.1:3080',
        origin: 'http://evil.example',
        'sec-fetch-site': 'cross-site',
      }, request), crossOrigin.response)
      expect(crossOrigin.state).toMatchObject({ status: 403, body: 'forbidden' })
      expect(readSummary).toHaveBeenCalledTimes(1)
    } finally {
      await remove()
      await connectionFiber.dispose()
    }
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
  })

  it('registers and removes the native settings tab and zero-chrome Header lifecycle entry', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: {
        'conversation.session.header.actions': { kind: 'list', scope: 'session' },
        'settings.plugins.tab': { kind: 'list', scope: 'root' },
      },
    } as never, () => null)
    ctx.provide('connection', {
      rpc: { call: async () => ({ ok: true, value: null }) },
    } as never)
    ctx.provide('workspaces', {
      list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => undefined },
    } as never)
    ctx.provide('sessions', {
      list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => undefined },
    } as never)
    ctx.provide('settingsScope', {
      bind: () => ({
        getSnapshot: () => ({
          status: 'ready', value: { automaticLearning: true }, revision: 1, writable: true,
        }),
        subscribe: () => () => undefined,
        set: async () => undefined,
      }),
    } as never)
    ctx.provide('remote', {} as never)
    const fiber = ctx.plugin({
      inject: [...clientInject],
      apply: (scope: Context) => {
        applyRun2skillClient(scope as unknown as Run2skillClientContext)
      },
    })
    await fiber.await()

    expect(ctx.slots.entries('conversation.session.header.actions'))
      .toContainEqual(expect.objectContaining({
        options: expect.objectContaining({ id: 'run2skill-attention' }),
      }))
    expect(ctx.slots.entries('settings.plugins.tab'))
      .toContainEqual(expect.objectContaining({
        options: expect.objectContaining({ id: 'run2skill' }),
      }))
    await fiber.dispose()
    expect(ctx.slots.entries('conversation.session.header.actions')).toHaveLength(0)
    expect(ctx.slots.entries('settings.plugins.tab')).toHaveLength(0)
  })

  it('keeps the Reject confirmation modal isolated with the pinned React runtime', async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>')
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('Node', dom.window.Node)
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
    vi.stubGlobal('navigator', dom.window.navigator)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const before = document.createElement('button')
    const host = document.createElement('div')
    document.body.append(before, host)
    before.focus()
    const root = createRoot(host)
    const setRejectConfirm = vi.fn()
    const controller = new ProposalInboxController(
      'workspace-fixture',
      async () => ({ ok: false, error: { code: 'UNAVAILABLE' } }),
    )

    try {
      await act(async () => {
        root.render(createElement(ProposalInboxPanel, {
          controller,
          state: {
            open: true,
            summaryPhase: 'READY',
            summary: {
              apiVersion: 1,
              status: 'READY',
              recoveryLag: false,
              queue: { completeness: 'KNOWN', pendingReview: 0, publishing: 0, needsAttention: 0 },
            },
            listPhase: 'READY',
            items: [],
            detailPhase: 'IDLE',
            mutationPending: false,
            announcement: '',
          },
          dialogRef: { current: null },
          textMode: 'SAFE',
          setTextMode: vi.fn(),
          rejectConfirm: true,
          setRejectConfirm,
        }))
      })

      const isolated = host.querySelector('[inert]')
      const alert = host.querySelector<HTMLElement>('[role="alertdialog"]')
      expect(isolated?.getAttribute('inert')).toBe('')
      expect(isolated?.getAttribute('aria-hidden')).toBe('true')
      expect(document.activeElement?.textContent).toBe('取消')

      const escaped = document.createElement('button')
      document.body.append(escaped)
      escaped.focus()
      expect(document.activeElement?.textContent).toBe('取消')

      alert?.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }))
      expect(setRejectConfirm).toHaveBeenCalledWith(false)
    } finally {
      await act(async () => { root.unmount() })
      expect(document.activeElement).toBe(before)
      controller.dispose()
      dom.window.close()
      vi.unstubAllGlobals()
    }
  })

  it('contains focus in the main Inbox and restores its Header trigger on close', async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>')
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('Node', dom.window.Node)
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
    vi.stubGlobal('navigator', dom.window.navigator)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const outside = document.createElement('button')
    const host = document.createElement('div')
    document.body.append(outside, host)
    const root = createRoot(host)

    try {
      await act(async () => {
        root.render(createElement(ProposalInboxHeaderAction, {
          workspaceId: 'workspace-fixture',
          callReview: async (calledEndpoint) => calledEndpoint === 'summary'
            ? {
                ok: true,
                value: {
                  apiVersion: 1,
                  status: 'READY',
                  recoveryLag: false,
                  queue: { completeness: 'KNOWN', pendingReview: 0, publishing: 0, needsAttention: 0 },
                },
              }
            : { ok: true, value: { apiVersion: 1, items: [] } },
        }))
      })
      const trigger = host.querySelector<HTMLElement>('[data-run2skill-proposal-trigger]')
      trigger?.focus()
      await act(async () => {
        trigger?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      const dialog = host.querySelector<HTMLElement>('[role="dialog"]')
      const close = dialog?.querySelector<HTMLElement>('[data-initial-focus]')
      expect(host.querySelector('[data-run2skill-proposal-backdrop]')).not.toBeNull()
      expect(document.activeElement).toBe(close)

      outside.focus()
      expect(document.activeElement).toBe(close)

      await act(async () => {
        close?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      expect(document.activeElement).toBe(trigger)
    } finally {
      await act(async () => { root.unmount() })
      dom.window.close()
      vi.unstubAllGlobals()
    }
  })
})
