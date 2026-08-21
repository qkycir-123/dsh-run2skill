// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AutomaticLearningSettingsCard,
  AutomaticLearningSettingsController,
} from '../src/client/automatic-learning-settings.js'
import {
  PurgeSettingsController,
  type PurgePollEnvironment,
} from '../src/client/purge-settings.js'

const PROJECT_PREVIEW = {
  apiVersion: 1 as const,
  previewId: `purv_${'a'.repeat(64)}`,
  digest: 'b'.repeat(64),
  expiresAt: '2026-08-21T00:05:00.000Z',
  scopeBinding: {
    scope: 'PROJECT' as const,
    workspaceId: 'workspace-a',
  },
  hideBefore: '2026-08-21T00:00:00.000Z',
  workItemCount: 3,
  lineageCount: 2,
  blockedOrUnprovenCount: 1,
  willDelete: [
    { kind: 'WORK_ITEMS' as const, count: 3 },
    { kind: 'LINEAGES' as const, count: 2 },
  ],
  willKeep: [
    { reason: 'KEEP_NEW' as const, count: 4 },
    { reason: 'KEEP_SCOPE' as const, count: 5 },
    { reason: 'KEEP_UNPROVEN' as const, count: 1 },
  ],
  busyPublicationCount: 1,
}

const USER_PREVIEW = {
  ...PROJECT_PREVIEW,
  previewId: `purv_${'e'.repeat(64)}`,
  scopeBinding: { scope: 'USER' as const },
}

function settingsScope() {
  const snapshot = {
    status: 'ready' as const,
    value: { automaticLearning: true },
    revision: 1,
    writable: true,
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    set: vi.fn(async () => undefined),
  }
}

function environment(initiallyVisible = true): PurgePollEnvironment & {
  setVisible(value: boolean): void
  tick(): void
  timerDelay(): number | undefined
  timerCount(): number
} {
  let visible = initiallyVisible
  let nextTimer = 0
  const timers = new Map<number, { callback: () => void; delay: number }>()
  const visibility = new Set<() => void>()
  return {
    isVisible: () => visible,
    setInterval(callback, delay) {
      const id = nextTimer++
      timers.set(id, { callback, delay })
      return id
    },
    clearInterval(handle) { timers.delete(handle as number) },
    onVisibilityChange(listener) {
      visibility.add(listener)
      return () => { visibility.delete(listener) }
    },
    setVisible(value) {
      visible = value
      for (const listener of visibility) listener()
    },
    tick() { for (const timer of timers.values()) timer.callback() },
    timerDelay: () => [...timers.values()][0]?.delay,
    timerCount: () => timers.size,
  }
}

afterEach(() => { cleanup() })

describe('Purge native settings UI', () => {
  it('previews USER without a Workspace but still fails PROJECT closed', async () => {
    const call = vi.fn(async (endpoint: string) => endpoint === 'purge/preview'
      ? { ok: true, value: USER_PREVIEW }
      : { ok: true, value: { apiVersion: 1, state: 'IDLE' } })
    const controller = new PurgeSettingsController(call, () => undefined, environment())

    await controller.preview('USER')
    expect(call).toHaveBeenCalledWith(
      'purge/preview',
      { apiVersion: 1, scope: 'USER' },
      expect.any(AbortSignal),
    )
    expect(controller.snapshot().preview).toEqual(USER_PREVIEW)
    controller.cancelPreview()
    await controller.preview('PROJECT')
    expect(controller.snapshot().announcement).toContain('当前作用域无法可靠确认')
    expect(call).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('previews and confirms only the immutable server preview reference', async () => {
    const call = vi.fn(async (endpoint: string) => {
      if (endpoint === 'purge/status') return { ok: true, value: { apiVersion: 1, state: 'IDLE' } }
      if (endpoint === 'purge/preview') return { ok: true, value: PROJECT_PREVIEW }
      return {
        ok: true,
        value: {
          apiVersion: 1,
          purgeId: `purge_${'d'.repeat(64)}`,
          state: 'COMPLETED',
          deletedWorkItems: 3,
          deletedLineages: 2,
        },
      }
    })
    const controller = new PurgeSettingsController(call, () => 'workspace-a', environment())

    controller.start()
    await controller.whenIdle()
    await controller.preview('PROJECT')
    expect(controller.snapshot().preview).toEqual(PROJECT_PREVIEW)
    expect(call).toHaveBeenCalledWith(
      'purge/preview',
      { apiVersion: 1, scope: 'PROJECT', workspaceId: 'workspace-a' },
      expect.any(AbortSignal),
    )
    await controller.confirm()
    expect(call).toHaveBeenCalledWith(
      'purge/confirm',
      {
        apiVersion: 1,
        scope: 'PROJECT',
        workspaceId: 'workspace-a',
        previewId: PROJECT_PREVIEW.previewId,
        digest: PROJECT_PREVIEW.digest,
      },
      expect.any(AbortSignal),
    )
    expect(controller.snapshot()).toMatchObject({
      mutationPending: false,
      announcement: 'PROJECT run2skill 数据清理完成：3 条待处理数据，2 条发布沿袭记录。',
    })
    expect(controller.snapshot().preview).toBeUndefined()
    controller.dispose()
  })

  it('invalidates a PROJECT preview when CurrentScope changes before confirm', async () => {
    let workspaceId = 'workspace-a'
    const call = vi.fn(async (endpoint: string) => endpoint === 'purge/preview'
      ? { ok: true, value: PROJECT_PREVIEW }
      : { ok: true, value: { apiVersion: 1, state: 'IDLE' } })
    const controller = new PurgeSettingsController(call, () => workspaceId, environment())

    await controller.preview('PROJECT')
    workspaceId = 'workspace-b'
    await controller.confirm()

    expect(call.mock.calls.some(([endpoint]) => endpoint === 'purge/confirm')).toBe(false)
    expect(controller.snapshot()).toMatchObject({
      preview: undefined,
      previewScope: undefined,
      announcement: '清理预览已失效，请重新预览后确认。',
    })
    controller.dispose()
  })

  it('shows busy, failed phase, and retry without issuing duplicate mutations', async () => {
    const retryGate = Promise.withResolvers<unknown>()
    let active = false
    const call = vi.fn(async (endpoint: string) => {
      if (endpoint === 'purge/status') return active
        ? {
            ok: true,
            value: {
              apiVersion: 1,
              state: 'IN_PROGRESS',
              purgeId: `purge_${'d'.repeat(64)}`,
              hideBefore: '2026-08-21T00:00:00.000Z',
              startedAt: '2026-08-21T00:00:00.000Z',
              phase: 'DELETING_WORK_ITEMS',
              deletedWorkItems: 1,
              deletedLineages: 2,
              lastError: { code: 'PURGE_STORAGE_UNAVAILABLE', occurredAt: '2026-08-21T00:00:01.000Z' },
            },
          }
        : { ok: true, value: { apiVersion: 1, state: 'IDLE' } }
      if (endpoint === 'purge/preview') return { ok: true, value: PROJECT_PREVIEW }
      if (endpoint === 'purge/confirm') {
        return { ok: false, error: { code: 'PURGE_BUSY', message: 'busy', details: { busyPublicationCount: 2 } } }
      }
      return await retryGate.promise
    })
    const poll = environment()
    const controller = new PurgeSettingsController(call, () => 'workspace-a', poll)
    controller.start()
    await controller.whenIdle()
    await controller.preview('PROJECT')
    await controller.confirm()
    expect(controller.snapshot().announcement).toContain('2 条正在发布')

    active = true
    poll.tick()
    await controller.whenIdle()
    expect(controller.snapshot().status).toMatchObject({
      state: 'IN_PROGRESS', phase: 'DELETING_WORK_ITEMS',
      lastError: { code: 'PURGE_STORAGE_UNAVAILABLE' },
    })
    expect(poll.timerDelay()).toBe(2_000)

    const first = controller.retry()
    const duplicate = controller.retry()
    expect(call.mock.calls.filter(([endpoint]) => endpoint === 'purge/retry')).toHaveLength(1)
    retryGate.resolve({
      ok: true,
      value: {
        apiVersion: 1,
        purgeId: `purge_${'d'.repeat(64)}`,
        state: 'COMPLETED',
        deletedWorkItems: 3,
        deletedLineages: 2,
      },
    })
    await Promise.all([first, duplicate])
    expect(controller.snapshot().announcement).toContain('清理完成')
    controller.dispose()
  })

  it('closes a stale preview and requires a new immutable preview', async () => {
    const call = vi.fn(async (endpoint: string) => {
      if (endpoint === 'purge/status') return { ok: true, value: { apiVersion: 1, state: 'IDLE' } }
      if (endpoint === 'purge/preview') return { ok: true, value: PROJECT_PREVIEW }
      return {
        ok: false,
        error: { code: 'PURGE_PREVIEW_STALE', message: 'stale', details: {} },
      }
    })
    const controller = new PurgeSettingsController(call, () => 'workspace-a', environment())
    controller.start()
    await controller.whenIdle()
    await controller.preview('PROJECT')
    await controller.confirm()
    expect(controller.snapshot()).toMatchObject({
      preview: undefined,
      previewScope: undefined,
      announcement: '清理预览已失效，请重新预览后确认。',
    })
    controller.dispose()
  })

  it('switches immediately to active polling for an in-progress receipt', async () => {
    const call = vi.fn(async (endpoint: string) => {
      if (endpoint === 'purge/status') return { ok: true, value: { apiVersion: 1, state: 'IDLE' } }
      if (endpoint === 'purge/preview') return { ok: true, value: PROJECT_PREVIEW }
      return {
        ok: true,
        value: {
          apiVersion: 1,
          purgeId: `purge_${'d'.repeat(64)}`,
          state: 'IN_PROGRESS',
          phase: 'HIDING',
          deletedWorkItems: 0,
          deletedLineages: 0,
        },
      }
    })
    const poll = environment()
    const controller = new PurgeSettingsController(call, () => 'workspace-a', poll)
    controller.start()
    await controller.whenIdle()
    await controller.preview('PROJECT')
    await controller.confirm()
    expect(controller.snapshot().inProgressReceipt).toMatchObject({ state: 'IN_PROGRESS', phase: 'HIDING' })
    expect(poll.timerDelay()).toBe(2_000)
    poll.tick()
    await controller.whenIdle()
    expect(controller.snapshot().inProgressReceipt).toBeUndefined()
    expect(controller.snapshot().announcement).toBe('PROJECT run2skill 数据清理完成。')
    controller.dispose()
  })

  it('polls active phase while a long confirm mutation is still in flight', async () => {
    const confirmGate = Promise.withResolvers<unknown>()
    let confirming = false
    const call = vi.fn(async (endpoint: string) => {
      if (endpoint === 'purge/preview') return { ok: true, value: PROJECT_PREVIEW }
      if (endpoint === 'purge/confirm') {
        confirming = true
        return await confirmGate.promise
      }
      return {
        ok: true,
        value: confirming
          ? {
              apiVersion: 1,
              state: 'IN_PROGRESS',
              purgeId: `purge_${'d'.repeat(64)}`,
              hideBefore: '2026-08-21T00:00:00.000Z',
              startedAt: '2026-08-21T00:00:00.000Z',
              phase: 'DELETING_LINEAGES',
              deletedWorkItems: 0,
              deletedLineages: 1,
            }
          : { apiVersion: 1, state: 'IDLE' },
      }
    })
    const poll = environment()
    const controller = new PurgeSettingsController(call, () => 'workspace-a', poll)
    controller.start()
    await controller.whenIdle()
    await controller.preview('PROJECT')
    const confirmation = controller.confirm()
    await waitFor(() => { expect(controller.snapshot().mutationPending).toBe(true) })
    expect(poll.timerDelay()).toBe(2_000)
    poll.tick()
    await waitFor(() => {
      expect(controller.snapshot().status).toMatchObject({
        state: 'IN_PROGRESS', phase: 'DELETING_LINEAGES', deletedLineages: 1,
      })
    })
    expect(call.mock.calls.filter(([endpoint]) => endpoint === 'purge/status')).toHaveLength(2)
    confirmGate.resolve({
      ok: true,
      value: {
        apiVersion: 1,
        purgeId: `purge_${'d'.repeat(64)}`,
        state: 'COMPLETED',
        deletedWorkItems: 3,
        deletedLineages: 2,
      },
    })
    await confirmation
    controller.dispose()
  })

  it('only promises continued hiding after status proves a durable boundary', async () => {
    let statusActive = false
    const call = vi.fn(async (endpoint: string) => {
      if (endpoint === 'purge/status') return {
        ok: true,
        value: statusActive
          ? {
              apiVersion: 1,
              state: 'IN_PROGRESS',
              purgeId: `purge_${'d'.repeat(64)}`,
              hideBefore: '2026-08-21T00:00:00.000Z',
              startedAt: '2026-08-21T00:00:00.000Z',
              phase: 'HIDING',
              deletedWorkItems: 0,
              deletedLineages: 0,
              lastError: { code: 'PURGE_STORAGE_UNAVAILABLE', occurredAt: '2026-08-21T00:00:01.000Z' },
            }
          : { apiVersion: 1, state: 'IDLE' },
      }
      if (endpoint === 'purge/preview') {
        return statusActive
          ? { ok: true, value: PROJECT_PREVIEW }
          : { ok: false, error: { code: 'PURGE_STORAGE_UNAVAILABLE', message: 'unavailable', details: {} } }
      }
      return { ok: false, error: { code: 'PURGE_STORAGE_UNAVAILABLE', message: 'failed', details: {} } }
    })
    const controller = new PurgeSettingsController(call, () => 'workspace-a', environment())

    await controller.preview('PROJECT')
    expect(controller.snapshot().announcement).toContain('未确认已建立清理边界')
    expect(controller.snapshot().announcement).not.toContain('继续隐藏')
    statusActive = true
    await controller.preview('PROJECT')
    await controller.confirm()
    expect(controller.snapshot().announcement).toContain('清理边界继续隐藏')
    controller.dispose()
  })

  it('polls idle at 10s, active at 2s, pauses hidden, and refreshes immediately when visible', async () => {
    let active = false
    const call = vi.fn(async () => ({
      ok: true,
      value: active
        ? {
            apiVersion: 1,
            state: 'IN_PROGRESS',
            purgeId: `purge_${'d'.repeat(64)}`,
            hideBefore: '2026-08-21T00:00:00.000Z',
            startedAt: '2026-08-21T00:00:00.000Z',
            phase: 'HIDING',
            deletedWorkItems: 0,
            deletedLineages: 0,
          }
        : { apiVersion: 1, state: 'IDLE' },
    }))
    const poll = environment()
    const controller = new PurgeSettingsController(call, () => 'workspace-a', poll)

    controller.start()
    await controller.whenIdle()
    expect(poll.timerDelay()).toBe(10_000)
    active = true
    poll.tick()
    await controller.whenIdle()
    expect(poll.timerDelay()).toBe(2_000)
    poll.setVisible(false)
    expect(poll.timerCount()).toBe(0)
    active = false
    poll.setVisible(true)
    await controller.whenIdle()
    expect(call).toHaveBeenCalledTimes(3)
    expect(poll.timerDelay()).toBe(10_000)
    controller.dispose()
  })

  it('pauses all host-tab polling and resumes without leaking timers', async () => {
    const call = vi.fn(async () => ({ ok: true, value: { apiVersion: 1, state: 'IDLE' } }))
    const poll = environment()
    const controller = new PurgeSettingsController(call, () => 'workspace-a', poll)
    controller.start()
    await controller.whenIdle()
    expect(poll.timerCount()).toBe(1)

    controller.pause()
    expect(poll.timerCount()).toBe(0)
    controller.resume()
    await controller.whenIdle()
    expect(poll.timerCount()).toBe(1)
    expect(call).toHaveBeenCalledTimes(2)

    controller.dispose()
    expect(poll.timerCount()).toBe(0)
  })

  it('uses the native modal with exact boundaries, focus trap, Escape, restoration, and live completion', async () => {
    const call = vi.fn(async (endpoint: string) => {
      if (endpoint === 'purge/status') return { ok: true, value: { apiVersion: 1, state: 'IDLE' } }
      if (endpoint === 'purge/preview') return { ok: true, value: PROJECT_PREVIEW }
      return {
        ok: true,
        value: {
          apiVersion: 1,
          purgeId: `purge_${'d'.repeat(64)}`,
          state: 'COMPLETED',
          deletedWorkItems: 3,
          deletedLineages: 2,
        },
      }
    })
    const purge = new PurgeSettingsController(call, () => 'workspace-a', environment())
    purge.start()
    await purge.whenIdle()
    const settings = new AutomaticLearningSettingsController(settingsScope())
    const outerEscape = vi.fn()
    render(createElement('div', {
      onKeyDown: (event: { key: string }) => {
        if (event.key === 'Escape') outerEscape()
      },
    }, createElement(AutomaticLearningSettingsCard, {
      controller: settings,
      purgeController: purge,
    })))

    fireEvent.click(screen.getByRole('button', { name: /run2skill/ }))
    const projectButton = screen.getByRole('button', { name: '预览并清理当前 PROJECT 数据' })
    fireEvent.click(projectButton)
    const dialog = await screen.findByRole('dialog', { name: '确认清理 PROJECT run2skill 数据？' })
    expect(dialog.textContent).toContain('3 条待处理数据')
    expect(dialog.textContent).toContain('2 条发布沿袭记录')
    expect(dialog.textContent).toContain('1 条无法证明作用域的数据将保留')
    expect(dialog.textContent).toContain('删除 run2skill 的过滤 Evidence、Experience、pending、Proposal、Revision metadata、usage 和相关审计事实')
    expect(dialog.textContent).toContain('保留 DSH Session Log')
    expect(dialog.textContent).toContain('保留所有已发布的原生 Skill')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消清理' }))
    screen.getByRole('button', { name: '关闭清理确认框' }).focus()
    fireEvent.keyDown(dialog, { key: 'Tab', ['shift' + 'Key']: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '确认清理' }))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: '确认清理 PROJECT run2skill 数据？' })).toBeNull() })
    expect(outerEscape).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(projectButton)

    fireEvent.click(projectButton)
    fireEvent.click(await screen.findByRole('button', { name: '确认清理' }))
    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'Purge 状态播报' }).textContent).toContain('清理完成')
    })
    expect(screen.queryByRole('dialog', { name: '确认清理 PROJECT run2skill 数据？' })).toBeNull()
    purge.dispose()
    settings.dispose()
  })
})
