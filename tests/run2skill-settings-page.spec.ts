// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Run2skillAttentionToast,
  applyRun2skillClient,
  hostTabVisible,
} from '../src/client/run2skill-settings-page.js'

afterEach(() => { cleanup() })

describe('run2skill native settings surface', () => {
  it('treats a DSH tab hidden by an ancestor as inactive', () => {
    const hostTab = document.createElement('section')
    const surface = document.createElement('div')
    hostTab.append(surface)
    document.body.append(hostTab)
    expect(hostTabVisible(surface)).toBe(true)
    hostTab.hidden = true
    expect(hostTabVisible(surface)).toBe(false)
  })

  it('registers one independent settings.plugins.tab and a header lifecycle mount with no persistent DOM', () => {
    const registrations: Array<{ name: string; id?: string }> = []
    const context = {
      connection: { rpc: { call: vi.fn() } },
      settingsScope: { bind: vi.fn(() => ({
        getSnapshot: () => ({ status: 'ready', value: { automaticLearning: true }, revision: 1, writable: true }),
        subscribe: () => () => undefined,
        set: vi.fn(),
      })) },
      sessions: { list: { getSnapshot: () => ({ current: 'session-a' }), subscribe: () => () => undefined } },
      workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'workspace-a', sessionIds: ['session-a'] }] }), subscribe: () => () => undefined } },
      slots: {
        inject: vi.fn((_name: string, install: () => () => void) => { install() }),
        register: vi.fn((options: { name: string; id?: string }) => {
          registrations.push(options)
          return () => undefined
        }),
      },
    }

    applyRun2skillClient(context as never)

    expect(registrations).toContainEqual(expect.objectContaining({
      name: 'settings.plugins.tab', id: 'run2skill',
    }))
    expect(registrations).toContainEqual(expect.objectContaining({
      name: 'conversation.session.header.actions', id: 'run2skill-attention',
    }))
  })

  it('renders no header element without an actionable key', () => {
    const { container } = render(createElement(Run2skillAttentionToast, {
      sessionId: 'session-a',
      workspaceId: 'workspace-a',
      callAttention: vi.fn(async () => ({
        ok: true,
        value: {
          apiVersion: 1,
          userCompleteness: 'KNOWN',
          projectCompleteness: 'KNOWN',
          actions: [],
          runtimeCompleteness: 'KNOWN',
          runtimeWarnings: [],
        },
      })),
    }))
    expect(container.childElementCount).toBe(0)
  })

  it('fails closed without visible header chrome when attention is unavailable', async () => {
    const { container } = render(createElement(Run2skillAttentionToast, {
      sessionId: 'session-a',
      callAttention: vi.fn(async () => { throw new Error('offline') }),
    }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(container.childElementCount).toBe(0)
  })

  it('uses the DSH alert Toast once for an actionable generation', async () => {
    const call = vi.fn(async () => ({
      ok: true,
      value: {
        apiVersion: 1,
        userCompleteness: 'KNOWN',
        projectCompleteness: 'KNOWN',
        actions: [{ actionKey: `act_${'a'.repeat(64)}` }],
        runtimeCompleteness: 'KNOWN',
        runtimeWarnings: [],
      },
    }))
    render(createElement(Run2skillAttentionToast, {
      sessionId: 'session-a', workspaceId: 'workspace-a', callAttention: call,
    }))
    expect((await screen.findByRole('alert')).textContent).toContain('设置 → 插件 → run2skill')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })
})
