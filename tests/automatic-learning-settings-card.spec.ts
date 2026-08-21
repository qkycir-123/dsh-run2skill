// @vitest-environment jsdom

import { createElement, type ComponentType } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AutomaticLearningSettingsController,
  applyAutomaticLearningSettingsClient,
} from '../src/client/automatic-learning-settings.js'

afterEach(() => { cleanup() })

function scopeFixture() {
  let snapshot = {
    status: 'ready' as const,
    value: { automaticLearning: true },
    revision: 0,
    writable: true,
  }
  const listeners = new Set<() => void>()
  const set = vi.fn(async (_field: string, value: unknown) => {
    snapshot = { ...snapshot, value: { automaticLearning: value as boolean }, revision: snapshot.revision + 1 }
    for (const listener of listeners) listener()
  })
  return {
    scope: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set,
    },
    rejectNextWrite() {
      set.mockRejectedValueOnce(new Error('synthetic settings revision conflict'))
    },
  }
}

describe('Automatic Learning native settings card', () => {
  it('registers a run2skill-keyed card and binds the native settings scope', () => {
    const fixture = scopeFixture()
    const install = vi.fn((_name: string, callback: () => unknown) => callback())
    const register = vi.fn((_options: Record<string, unknown>, _component: unknown) => () => {})
    const bind = vi.fn(() => fixture.scope)

    applyAutomaticLearningSettingsClient({
      connection: { rpc: { call: vi.fn(async () => ({ ok: true, value: { apiVersion: 1, state: 'IDLE' } })) } },
      workspaces: { list: { getSnapshot: () => ({ items: [], recentWorkspaceId: undefined }) } },
      settingsScope: { bind: bind as never },
      slots: { inject: install, register },
    })

    expect(bind).toHaveBeenCalledWith({ namespace: 'run2skill' })
    expect(install).toHaveBeenCalledWith('settings.plugin.item', expect.any(Function))
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'settings.plugin.item', key: 'run2skill',
    }), expect.any(Function))

    const [options, component] = register.mock.calls[0]!
    const cardProps = (options.inject as () => Record<string, unknown>)()
    render(createElement(component as ComponentType<Record<string, unknown>>, cardProps))
    expect(screen.getByText('将真实执行中的明确经验整理为待确认的技能草稿')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /run2skill/ }))
    expect(screen.getByRole('checkbox', { name: '自动学习' })).toBeTruthy()
    expect(screen.getByText('分析时沿用发起会话已经选择的模型。')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/Skill Proposal|Automatic Learning|inherit-session/)
  })

  it('wires USER Purge through the loopback channel without a Workspace identity', async () => {
    const fixture = scopeFixture()
    const rpc = vi.fn(async (_channel: string, endpoint: string) => endpoint === 'purge/preview'
      ? {
          ok: true,
          value: {
            apiVersion: 1,
            previewId: `purv_${'a'.repeat(64)}`,
            digest: 'b'.repeat(64),
            expiresAt: '2026-08-21T00:05:00.000Z',
            scopeBinding: { scope: 'USER' },
            hideBefore: '2026-08-21T00:00:00.000Z',
            workItemCount: 0,
            lineageCount: 0,
            blockedOrUnprovenCount: 0,
            willDelete: [
              { kind: 'WORK_ITEMS', count: 0 },
              { kind: 'LINEAGES', count: 0 },
            ],
            willKeep: [
              { reason: 'KEEP_NEW', count: 0 },
              { reason: 'KEEP_SCOPE', count: 0 },
              { reason: 'KEEP_UNPROVEN', count: 0 },
            ],
            busyPublicationCount: 0,
          },
        }
      : { ok: true, value: { apiVersion: 1, state: 'IDLE' } })
    let face: { purgeController: { whenIdle(): Promise<void>; preview(scope: 'USER'): Promise<void> } } | undefined
    const register = vi.fn((options: { inject: () => typeof face }) => {
      face = options.inject()
      return () => undefined
    })

    applyAutomaticLearningSettingsClient({
      connection: { rpc: { call: rpc } },
      workspaces: {
        list: {
          getSnapshot: () => ({ items: [], recentWorkspaceId: undefined }),
        },
      },
      settingsScope: { bind: (() => fixture.scope) as never },
      slots: { inject: (_name, install) => { install() }, register },
    })

    await face!.purgeController.whenIdle()
    await face!.purgeController.preview('USER')
    expect(rpc).toHaveBeenCalledWith(
      '/run2skill',
      'purge/preview',
      { apiVersion: 1, scope: 'USER' },
      expect.any(AbortSignal),
    )
  })

  it('uses native revision-fenced writes and reports when the requested value did not land', async () => {
    const fixture = scopeFixture()
    const controller = new AutomaticLearningSettingsController(fixture.scope)

    await controller.setAutomaticLearning(false)
    expect(fixture.scope.set).toHaveBeenCalledWith('automaticLearning', false)
    expect(controller.getSnapshot()).toMatchObject({ automaticLearning: false, error: undefined })

    fixture.rejectNextWrite()
    await controller.setAutomaticLearning(true)
    expect(controller.getSnapshot()).toMatchObject({
      automaticLearning: false,
      error: 'SETTINGS_CHANGED',
    })
  })
})
