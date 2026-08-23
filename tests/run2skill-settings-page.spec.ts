// @vitest-environment jsdom

import { createElement, useRef, useState, useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Run2skillAttentionToast,
  AttentionSettingsSummary,
  LearningFailureSection,
  RecentSkillActivitySection,
  RejectProposalModal,
  Run2skillSettingsPage,
  actionableProposalItems,
  applyRun2skillClient,
  hostTabVisible,
} from '../src/client/run2skill-settings-page.js'
import { AutomaticLearningSettingsController } from '../src/client/automatic-learning-settings.js'
import { PurgeSettingsController } from '../src/client/purge-settings.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('run2skill native settings surface', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(yes => { resolve = yes })
    return { promise, resolve }
  }

  it('uses Attention action identity as the only source of visible Proposal work', () => {
    const review = {
      workItemId: 'wi-review',
      workItemRevision: 1,
      proposalRef: { proposalId: `prop_${'a'.repeat(64)}`, revision: 1, digest: 'b'.repeat(64) },
      kind: 'CREATE' as const,
      name: 'review',
      description: 'review',
      persistenceScope: 'PROJECT' as const,
      createdAt: '2026-08-21T00:00:00.000Z',
      processingState: 'READY_FOR_REVIEW' as const,
      publicationOutcome: 'PENDING_REVIEW' as const,
    }
    const publishing = {
      ...review,
      workItemId: 'wi-publishing',
      proposalRef: { ...review.proposalRef, proposalId: `prop_${'c'.repeat(64)}` },
      processingState: 'PUBLISHING' as const,
    }
    expect(actionableProposalItems([
      {
        actionKey: `act_${'d'.repeat(64)}`,
        subjectId: review.workItemId,
        kind: 'REVIEW_PROPOSAL',
        proposalRef: review.proposalRef,
      },
    ], [review, publishing])).toEqual([review])
  })

  it('treats a DSH tab hidden by an ancestor as inactive', () => {
    const hostTab = document.createElement('section')
    const surface = document.createElement('div')
    hostTab.append(surface)
    document.body.append(hostTab)
    expect(hostTabVisible(surface)).toBe(true)
    hostTab.hidden = true
    expect(hostTabVisible(surface)).toBe(false)
  })

  it('does not start Proposal polling while the host settings tab is initially hidden, then resumes on reveal', async () => {
    const review = vi.fn(async (_endpoint: string) => ({
      ok: true,
      value: { apiVersion: 1 as const, items: [] },
    }))
    const automatic = new AutomaticLearningSettingsController({
      getSnapshot: () => ({
        status: 'ready', value: { automaticLearning: true }, revision: 1, writable: true,
      }),
      subscribe: () => () => undefined,
      set: vi.fn(),
    })
    const purge = new PurgeSettingsController(
      vi.fn(async () => ({ ok: true, value: { apiVersion: 1, state: 'IDLE' } })),
      () => 'workspace-a',
    )
    const rendered = render(createElement('section', { hidden: true },
      createElement(Run2skillSettingsPage, {
        controller: automatic,
        purgeController: purge,
        workspaceId: 'workspace-a',
        callAttention: vi.fn(async () => ({
          ok: true,
          value: {
            apiVersion: 1,
            userCompleteness: 'KNOWN',
            projectCompleteness: 'KNOWN',
            actions: [{
              actionKey: `act_${'a'.repeat(64)}`,
              subjectId: `wi_${'b'.repeat(64)}`,
              kind: 'REVIEW_PROPOSAL',
              proposalRef: {
                proposalId: `prop_${'c'.repeat(64)}`,
                revision: 1,
                digest: 'd'.repeat(64),
              },
            }],
            runtimeCompleteness: 'KNOWN',
            runtimeWarnings: [],
          },
        })),
        callReview: review,
        callActivity: vi.fn(async () => ({ ok: true, value: { apiVersion: 1, items: [] } })),
      }),
    ))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.getByText('缓存清理')).toBeTruthy()
    expect(screen.queryByText('数据管理')).toBeNull()
    expect(review).not.toHaveBeenCalled()

    rendered.container.firstElementChild!.removeAttribute('hidden')
    await waitFor(() => {
      expect(review.mock.calls.some(([endpoint]) => endpoint === 'proposals/list')).toBe(true)
    })
    purge.dispose()
    automatic.dispose()
  })

  it('loads recent activity only while expanded and shows scope only to disambiguate', async () => {
    const call = vi.fn(async () => ({
      ok: true,
      value: {
        apiVersion: 1,
        visibilityRevision: `visibility_${'a'.repeat(64)}`,
        items: [
          {
            activityId: `activity_${'a'.repeat(64)}`,
            skillName: 'shared-skill',
            operation: 'UPDATED',
            scope: 'PROJECT',
            occurredAt: '2026-08-22T11:00:00.000Z',
          },
          {
            activityId: `activity_${'b'.repeat(64)}`,
            skillName: 'shared-skill',
            operation: 'CREATED',
            scope: 'USER',
            occurredAt: '2026-08-22T10:00:00.000Z',
          },
          {
            activityId: `activity_${'c'.repeat(64)}`,
            skillName: 'project-only',
            operation: 'CREATED',
            scope: 'PROJECT',
            occurredAt: '2026-08-22T09:00:00.000Z',
          },
        ],
      },
    }))
    const rendered = render(createElement(RecentSkillActivitySection, {
      workspaceId: 'workspace-a', call, active: false, scopeGeneration: 1,
    }))
    expect(call).not.toHaveBeenCalled()
    expect(screen.getByText('展示最近沉淀的 Skill')).toBeTruthy()

    rendered.rerender(createElement(RecentSkillActivitySection, {
      workspaceId: 'workspace-a', call, active: true, scopeGeneration: 1,
    }))
    await screen.findByText('project-only')
    expect(call).toHaveBeenCalledWith({
      apiVersion: 1,
      currentScope: { kind: 'WORKSPACE', generation: 1, workspaceId: 'workspace-a' },
    }, expect.any(AbortSignal))
    expect(call).toHaveBeenCalledWith({
      apiVersion: 1,
      currentScope: { kind: 'WORKSPACE', generation: 1, workspaceId: 'workspace-a' },
      expectedVisibilityRevision: `visibility_${'a'.repeat(64)}`,
    }, expect.any(AbortSignal))
    expect(screen.getAllByText('创建')).toHaveLength(2)
    expect(screen.getByText('更新')).toBeTruthy()
    expect(screen.getByText('项目')).toBeTruthy()
    expect(screen.getByText('用户')).toBeTruthy()
    expect(screen.getByText('project-only').closest('li')?.textContent).not.toContain('项目')
  })

  it('hides the previous scope immediately and ignores its late activity response', async () => {
    const lateA = deferred<unknown>()
    const response = (skillName: string, suffix: string) => ({
      ok: true,
      value: { apiVersion: 1, visibilityRevision: `visibility_${suffix.repeat(64)}`, items: [{
        activityId: `activity_${suffix.repeat(64)}`,
        skillName,
        operation: 'CREATED',
        scope: 'PROJECT',
        occurredAt: '2026-08-22T11:00:00.000Z',
      }] },
    })
    let aUnfencedCalls = 0
    const call = vi.fn(async payload => {
      if (payload.currentScope.kind === 'WORKSPACE' && payload.currentScope.workspaceId === 'workspace-a') {
        if (payload.expectedVisibilityRevision !== undefined) return response('scope-a-loaded', 'a')
        aUnfencedCalls += 1
        return aUnfencedCalls === 1 ? response('scope-a-loaded', 'a') : await lateA.promise
      }
      return response('scope-b-current', 'b')
    })
    const rendered = render(createElement(RecentSkillActivitySection, {
      workspaceId: 'workspace-a', call, active: true, scopeGeneration: 1, hostDataEpoch: 0,
    }))
    await screen.findByText('scope-a-loaded')
    rendered.rerender(createElement(RecentSkillActivitySection, {
      workspaceId: 'workspace-a', call, active: true, scopeGeneration: 1, hostDataEpoch: 1,
    }))
    rendered.rerender(createElement(RecentSkillActivitySection, {
      workspaceId: 'workspace-b', call, active: true, scopeGeneration: 2, hostDataEpoch: 1,
    }))
    expect(screen.queryByText('scope-a-loaded')).toBeNull()
    await act(async () => { lateA.resolve(response('scope-a-late', 'c')) })
    expect(screen.queryByText('scope-a-late')).toBeNull()
    await screen.findByText('scope-b-current')
  })

  it('drops a pre-purge response and reloads after the host-data epoch advances', async () => {
    const beforePurge = deferred<unknown>()
    const afterPurge = {
      ok: true,
      value: { apiVersion: 1, visibilityRevision: `visibility_${'e'.repeat(64)}`, items: [] },
    }
    let first = true
    const call = vi.fn(async () => {
      if (first) {
        first = false
        return await beforePurge.promise
      }
      return afterPurge
    })
    const rendered = render(createElement(RecentSkillActivitySection, {
      workspaceId: 'workspace-a', call, active: true, scopeGeneration: 1, hostDataEpoch: 0,
    }))
    rendered.rerender(createElement(RecentSkillActivitySection, {
      workspaceId: 'workspace-a', call, active: true, scopeGeneration: 1, hostDataEpoch: 1,
    }))
    await act(async () => { beforePurge.resolve({
      ok: true,
      value: { apiVersion: 1, visibilityRevision: `visibility_${'d'.repeat(64)}`, items: [{
        activityId: `activity_${'d'.repeat(64)}`,
        skillName: 'purged-skill',
        operation: 'CREATED',
        scope: 'PROJECT',
        occurredAt: '2026-08-22T11:00:00.000Z',
      }] },
    }) })
    expect(screen.queryByText('purged-skill')).toBeNull()
    await screen.findByText('最近 7 天没有成功沉淀的 Skill。')
    expect(call).toHaveBeenCalledTimes(4)
  })

  it('invalidates a final confirmation generated before an external Purge but delivered after it', async () => {
    const finalConfirmation = deferred<unknown>()
    const beforePurge = {
      ok: true,
      value: { apiVersion: 1, visibilityRevision: `visibility_${'a'.repeat(64)}`, items: [{
        activityId: `activity_${'d'.repeat(64)}`,
        skillName: 'externally-purged-skill',
        operation: 'CREATED',
        scope: 'PROJECT',
        occurredAt: '2026-08-22T11:00:00.000Z',
      }] },
    }
    const current = {
      ok: true,
      value: { apiVersion: 1, visibilityRevision: `visibility_${'f'.repeat(64)}`, items: [] },
    }
    let hostRevision = 'a'
    let oldBarrierCalls = 0
    const call = vi.fn(async (payload: { expectedVisibilityRevision?: string }) => {
      if (payload.expectedVisibilityRevision === undefined) {
        return hostRevision === 'a' ? beforePurge : current
      }
      if (payload.expectedVisibilityRevision === `visibility_${'a'.repeat(64)}`) {
        oldBarrierCalls += 1
        if (oldBarrierCalls === 2) return await finalConfirmation.promise
        if (hostRevision === 'a') return beforePurge
        return { ok: false, error: { code: 'visibility-stale', message: 'stale', details: {} } }
      }
      return current
    })
    render(createElement(RecentSkillActivitySection, {
      workspaceId: 'workspace-a', call, active: true, scopeGeneration: 1, hostDataEpoch: 0,
      visibilityPollMs: 5,
    }))
    await waitFor(() => { expect(call).toHaveBeenCalledTimes(3) })
    hostRevision = 'f'
    await act(async () => { finalConfirmation.resolve(beforePurge) })
    await screen.findByText('最近 7 天没有成功沉淀的 Skill。')
    expect(screen.queryByText('externally-purged-skill')).toBeNull()
    const visibilityRevisions = call.mock.calls
      .map(([payload]) => payload.expectedVisibilityRevision)
    expect(visibilityRevisions).toContain(undefined)
    expect(visibilityRevisions).toContain(`visibility_${'a'.repeat(64)}`)
    expect(visibilityRevisions).toContain(`visibility_${'f'.repeat(64)}`)
  })

  it('invalidates already rendered activity when the Host Purge revision changes', async () => {
    const response = (revision: string, includeItem: boolean) => ({
      ok: true,
      value: {
        apiVersion: 1,
        visibilityRevision: `visibility_${revision.repeat(64)}`,
        items: includeItem ? [{
          activityId: `activity_${'e'.repeat(64)}`,
          skillName: 'visible-before-external-purge',
          operation: 'CREATED',
          scope: 'PROJECT',
          occurredAt: '2026-08-22T11:00:00.000Z',
        }] : [],
      },
    })
    let hostRevision = 'a'
    const call = vi.fn(async (payload: { expectedVisibilityRevision?: string }) => {
      const currentRevision = `visibility_${hostRevision.repeat(64)}`
      if (
        payload.expectedVisibilityRevision !== undefined
        && payload.expectedVisibilityRevision !== currentRevision
      ) return { ok: false, error: { code: 'visibility-stale', message: 'stale', details: {} } }
      return response(hostRevision, hostRevision === 'a')
    })
    render(createElement(RecentSkillActivitySection, {
      workspaceId: 'workspace-a',
      call,
      active: true,
      scopeGeneration: 1,
      hostDataEpoch: 0,
      visibilityPollMs: 5,
    }))
    await screen.findByText('visible-before-external-purge')
    hostRevision = 'f'
    await screen.findByText('最近 7 天没有成功沉淀的 Skill。')
    expect(screen.queryByText('visible-before-external-purge')).toBeNull()
  })

  it('remounts activity on reopen so a collapsed pre-Purge READY state cannot flash again', async () => {
    const response = (revision: string, includeItem: boolean) => ({
      ok: true,
      value: {
        apiVersion: 1,
        visibilityRevision: `visibility_${revision.repeat(64)}`,
        items: includeItem ? [{
          activityId: `activity_${'b'.repeat(64)}`,
          skillName: 'collapsed-before-purge',
          operation: 'CREATED',
          scope: 'PROJECT',
          occurredAt: '2026-08-22T11:00:00.000Z',
        }] : [],
      },
    })
    let hostRevision = 'a'
    const call = vi.fn(async () => response(hostRevision, hostRevision === 'a'))
    const element = (active: boolean) => createElement(RecentSkillActivitySection, {
      key: JSON.stringify(['workspace-a', 1, 0, active]),
      workspaceId: 'workspace-a',
      call,
      active,
      scopeGeneration: 1,
      hostDataEpoch: 0,
    })
    const rendered = render(element(true))
    await screen.findByText('collapsed-before-purge')
    rendered.rerender(element(false))
    hostRevision = 'f'
    rendered.rerender(element(true))
    expect(screen.queryByText('collapsed-before-purge')).toBeNull()
    await screen.findByText('最近 7 天没有成功沉淀的 Skill。')
  })

  it('registers one independent settings.plugins.tab and a header lifecycle mount with no persistent DOM', () => {
    const registrations: Array<{ name: string; id?: string; label?: string }> = []
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
      effect: vi.fn((install: () => () => void) => { install() }),
    }

    applyRun2skillClient(context as never)

    expect(registrations).toContainEqual(expect.objectContaining({
      name: 'settings.plugins.tab', id: 'run2skill', label: 'Run2Skill',
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
    const call = vi.fn(async (_payload: unknown) => ({
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
    expect((await screen.findByRole('alert')).textContent).toContain('设置 → 插件 → Run2Skill')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('renders a stable quiet attention body for a healthy empty queue and never loads Proposal data', async () => {
    const review = vi.fn(async () => ({ ok: true, value: { apiVersion: 1 as const, items: [] } }))
    const projection = vi.fn()
    const summary = render(createElement(AttentionSettingsSummary, {
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
      refreshGeneration: 0,
      onProjection: projection,
    }))

    await waitFor(() => expect(projection).toHaveBeenLastCalledWith(expect.objectContaining({ actions: [] })))
    expect(summary.container.childElementCount).toBe(0)
    expect(screen.queryByText('0 项可操作事项')).toBeNull()
    expect(screen.queryByRole('button', { name: '刷新状态' })).toBeNull()

    const automatic = new AutomaticLearningSettingsController({
      getSnapshot: () => ({
        status: 'ready', value: { automaticLearning: true }, revision: 1, writable: true,
      }),
      subscribe: () => () => undefined,
      set: vi.fn(),
    })
    const purge = new PurgeSettingsController(
      vi.fn(async () => ({ ok: true, value: { apiVersion: 1, state: 'IDLE' } })),
      () => 'workspace-a',
    )
    const page = render(createElement(Run2skillSettingsPage, {
      controller: automatic,
      purgeController: purge,
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
      callReview: review,
      callActivity: vi.fn(async () => ({ ok: true, value: { apiVersion: 1, items: [] } })),
    }))
    await waitFor(() => expect(page.container.textContent).toContain('Run2Skill'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(review).not.toHaveBeenCalled()
    expect(page.container.textContent).not.toContain('当前 PROJECT 与 USER 没有待处理事项')
    expect(page.container.textContent).not.toContain('选择一项查看审核事实')
    expect(page.container.textContent).not.toContain('筛选 Proposal')
    expect(page.container.textContent).toContain('暂无')
    const attentionToggle = screen.getByRole('button', { name: '需要处理' })
    expect(attentionToggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(attentionToggle)
    expect(attentionToggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(attentionToggle)
    expect(attentionToggle.getAttribute('aria-expanded')).toBe('true')
    purge.dispose()
    automatic.dispose()
  })

  it('polls a visible empty Attention projection at low frequency and reveals new work without manual refresh', async () => {
    vi.useFakeTimers()
    const empty = {
      apiVersion: 1 as const,
      userCompleteness: 'KNOWN' as const,
      projectCompleteness: 'KNOWN' as const,
      actions: [],
      runtimeCompleteness: 'KNOWN' as const,
      runtimeWarnings: [],
    }
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: empty })
      .mockResolvedValue({
        ok: true,
        value: {
          ...empty,
          actions: [{ actionKey: `act_${'a'.repeat(64)}`, kind: 'REVIEW_PROPOSAL' }],
        },
      })
    const projection = vi.fn()
    render(createElement(AttentionSettingsSummary, {
      active: true,
      workspaceId: 'workspace-a',
      callAttention: call,
      refreshGeneration: 0,
      onProjection: projection,
    }))

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(call).toHaveBeenCalledTimes(1)
    expect(projection).toHaveBeenLastCalledWith(expect.objectContaining({ actions: [] }))

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(call).toHaveBeenCalledTimes(2)
    expect(screen.getByText('1 项可操作事项')).toBeTruthy()
  })

  it('does not poll Attention while the settings tab is inactive', async () => {
    vi.useFakeTimers()
    const response = {
      ok: true,
      value: {
        apiVersion: 1 as const,
        userCompleteness: 'KNOWN' as const,
        projectCompleteness: 'KNOWN' as const,
        actions: [],
        runtimeCompleteness: 'KNOWN' as const,
        runtimeWarnings: [],
      },
    }
    const call = vi.fn(async () => response)
    const props = {
      workspaceId: 'workspace-a',
      callAttention: call,
      refreshGeneration: 0,
      onProjection: vi.fn(),
    }
    const rendered = render(createElement(AttentionSettingsSummary, { ...props, active: false }))

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(call).not.toHaveBeenCalled()

    rendered.rerender(createElement(AttentionSettingsSummary, { ...props, active: true }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(call).toHaveBeenCalledTimes(1)

    rendered.rerender(createElement(AttentionSettingsSummary, { ...props, active: false }))
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('rebinds the Header Attention subscription from the renderer live workspace snapshot', async () => {
    let Header: ((props: Record<string, unknown>) => ReturnType<typeof createElement>) | undefined
    let snapshot = { items: [] as Array<{ workspaceId: string; sessionIds: string[] }> }
    const listeners = new Set<() => void>()
    const call = vi.fn(async (_payload: unknown) => ({
      ok: true,
      value: {
        apiVersion: 1, userCompleteness: 'KNOWN', projectCompleteness: 'KNOWN',
        actions: [], runtimeCompleteness: 'KNOWN', runtimeWarnings: [],
      },
    }))
    const context = {
      connection: { rpc: { call: vi.fn() } },
      settingsScope: { bind: vi.fn(() => ({
        getSnapshot: () => ({ status: 'ready', value: { automaticLearning: true }, revision: 1, writable: true }),
        subscribe: () => () => undefined, set: vi.fn(),
      })) },
      workspaces: { list: { getSnapshot: () => snapshot, subscribe: () => () => undefined } },
      slots: {
        inject: vi.fn((_name: string, install: () => unknown) => { install() }),
        register: vi.fn((options: { id?: string }, component: typeof Header) => {
          if (options.id === 'run2skill-attention') Header = component
          return () => undefined
        }),
      },
      effect: vi.fn((install: () => unknown) => { install() }),
    }
    applyRun2skillClient(context as never)
    function Harness() {
      const useWorkspaces = <T,>(selector: (value: typeof snapshot) => T) => useSyncExternalStore(
        listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
        () => selector(snapshot),
        () => selector(snapshot),
      )
      return createElement(Header!, { sessionId: 'session-a', callAttention: call, useWorkspaces })
    }
    render(createElement(Harness))
    await waitFor(() => expect(call).toHaveBeenCalled())
    expect(call.mock.calls.at(-1)?.[0]).toMatchObject({ currentScope: { kind: 'USER_ONLY' } })
    snapshot = { items: [{ workspaceId: 'workspace-a', sessionIds: ['session-a'] }] }
    for (const listener of listeners) listener()
    await waitFor(() => expect(call.mock.calls.at(-1)?.[0])
      .toMatchObject({ currentScope: { kind: 'WORKSPACE', workspaceId: 'workspace-a' } }))
  })

  it('never lets a slow previous scope overwrite a fast current Attention projection', async () => {
    const a = deferred<unknown>()
    const b = deferred<unknown>()
    const call = vi.fn(async payload => payload.currentScope.kind === 'WORKSPACE'
      && payload.currentScope.workspaceId === 'workspace-a' ? await a.promise : await b.promise)
    const projection = vi.fn()
    const rendered = render(createElement(AttentionSettingsSummary, {
      workspaceId: 'workspace-a', callAttention: call, refreshGeneration: 0, onProjection: projection,
    }))
    rendered.rerender(createElement(AttentionSettingsSummary, {
      workspaceId: 'workspace-b', callAttention: call, refreshGeneration: 0, onProjection: projection,
    }))
    b.resolve({ ok: true, value: {
      apiVersion: 1, userCompleteness: 'KNOWN', projectCompleteness: 'KNOWN',
      actions: [{ actionKey: `act_${'b'.repeat(64)}` }], runtimeCompleteness: 'KNOWN', runtimeWarnings: [],
    } })
    await screen.findByText('1 项可操作事项')
    a.resolve({ ok: true, value: {
      apiVersion: 1, userCompleteness: 'KNOWN', projectCompleteness: 'KNOWN',
      actions: [], runtimeCompleteness: 'KNOWN', runtimeWarnings: [],
    } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.getByText('1 项可操作事项')).toBeTruthy()
    expect(projection.mock.calls.at(-1)?.[0]).toMatchObject({ actions: [{ actionKey: `act_${'b'.repeat(64)}` }] })
  })

  it('aborts a mutation-driven Attention refresh when the scope changes and restores no stale value', async () => {
    const initial = { ok: true, value: {
      apiVersion: 1 as const, userCompleteness: 'KNOWN' as const, projectCompleteness: 'KNOWN' as const,
      actions: [{ actionKey: `act_${'a'.repeat(64)}` }], runtimeCompleteness: 'KNOWN' as const, runtimeWarnings: [],
    } }
    const manual = deferred<unknown>()
    const current = deferred<unknown>()
    let calls = 0
    const call = vi.fn(async payload => {
      calls += 1
      if (calls === 1) return initial
      return payload.currentScope.kind === 'WORKSPACE' && payload.currentScope.workspaceId === 'workspace-a'
        ? await manual.promise
        : await current.promise
    })
    const rendered = render(createElement(AttentionSettingsSummary, {
      workspaceId: 'workspace-a', callAttention: call, refreshGeneration: 0, onProjection: vi.fn(),
    }))
    await screen.findByText('1 项可操作事项')
    rendered.rerender(createElement(AttentionSettingsSummary, {
      workspaceId: 'workspace-a', callAttention: call, refreshGeneration: 1, onProjection: vi.fn(),
    }))
    rendered.rerender(createElement(AttentionSettingsSummary, {
      workspaceId: 'workspace-b', callAttention: call, refreshGeneration: 1, onProjection: vi.fn(),
    }))
    current.resolve({ ok: true, value: { ...initial.value, actions: [{ actionKey: `act_${'b'.repeat(64)}` }] } })
    await screen.findByText('1 项可操作事项')
    manual.resolve({ ok: true, value: { ...initial.value, actions: [] } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.getByText('1 项可操作事项')).toBeTruthy()
    expect(call.mock.calls.at(-1)?.[0]).toMatchObject({
      currentScope: { kind: 'WORKSPACE', workspaceId: 'workspace-b' },
    })
  })

  it('renders real learning failure facts selected by Attention and invokes the bounded retry RPC', async () => {
    const workItemId = `wi_${'a'.repeat(64)}`
    const call = vi.fn(async (endpoint: string, _payload?: unknown, _signal?: AbortSignal) => endpoint === 'learning/issues/list'
      ? {
          ok: true,
          value: {
            apiVersion: 1,
            items: [{
              workItemId,
              workItemRevision: 3,
              createdAt: '2026-08-21T00:00:00.000Z',
              updatedAt: '2026-08-21T00:00:01.000Z',
              failureCode: 'MODEL_TERMINAL_FAILURE',
              failureDetail: 'MODEL_USAGE_INVALID',
              retryable: true,
              attempt: 1,
              requestBudgetUsed: 2,
              calls: [
                { requestOrdinal: 1, kind: 'PRIMARY', outcome: 'FAILED' },
                { requestOrdinal: 2, kind: 'FORMAT_REPAIR', outcome: 'FAILED' },
              ],
            }],
          },
        }
      : {
          ok: true,
          value: {
            apiVersion: 1,
            workItemId,
            workItemRevision: 4,
            changed: true,
            processingState: 'CAPTURED',
            disposition: 'ACTIVE',
          },
        })
    const settled = vi.fn()
    render(createElement(LearningFailureSection, {
      call,
      active: true,
      actions: [{
        actionKey: `act_${'b'.repeat(64)}`,
        subjectId: workItemId,
        kind: 'RETRY_LEARNING',
        availableActions: ['RETRY', 'DISMISS'],
      }],
      onMutationSettled: settled,
    }))

    expect((await screen.findByRole('button', { name: '重试学习' })).closest('article')?.textContent)
      .toContain('MODEL_USAGE_INVALID')
    expect(call.mock.calls.find(([endpoint]) => endpoint === 'learning/issues/list')?.[1])
      .toMatchObject({ currentScope: { kind: 'USER_ONLY', generation: 1 }, limit: 20 })
    expect(call.mock.calls.find(([endpoint]) => endpoint === 'learning/issues/list')?.[1])
      .not.toHaveProperty('actions')
    fireEvent.click(screen.getByRole('button', { name: '重试学习' }))
    await waitFor(() => {
      expect(call.mock.calls.some(([endpoint]) => endpoint === 'learning/issues/retry')).toBe(true)
      expect(settled).toHaveBeenCalledOnce()
    })
  })

  it('gives Reject Modal initial focus, a bidirectional trap, Escape, and trigger restoration', async () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      const triggerRef = useRef<HTMLButtonElement>(null)
      return createElement('div', null,
        createElement('button', { ref: triggerRef, onClick: () => { setOpen(true) } }, '打开拒绝确认'),
        createElement(RejectProposalModal, {
          open,
          disabled: false,
          triggerRef,
          onClose: () => { setOpen(false) },
          onConfirm: () => { setOpen(false) },
        }),
      )
    }
    render(createElement(Harness))
    const trigger = screen.getByRole('button', { name: '打开拒绝确认' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '确认放弃这份技能草稿？' })
    expect(screen.getByRole('button', { name: '确认放弃' })).toBeTruthy()
    const buttons = Array.from(dialog.querySelectorAll('button'))
    expect(buttons[0]).toBe(document.activeElement)
    buttons[0]!.focus()
    fireEvent.keyDown(document, { key: 'Tab', ['shift' + 'Key']: true })
    expect(buttons.at(-1)).toBe(document.activeElement)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '确认放弃这份技能草稿？' })).toBeNull()
    expect(trigger).toBe(document.activeElement)
  })

  it('gives Learning dismiss the same focus trap, escape, and trigger restoration', async () => {
    const workItemId = `wi_${'c'.repeat(64)}`
    const call = vi.fn(async (endpoint: string) => endpoint === 'learning/issues/list'
      ? { ok: true, value: { apiVersion: 1, items: [{
          workItemId, workItemRevision: 1,
          createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:01.000Z',
          failureCode: 'MODEL_TERMINAL_FAILURE', retryable: false, attempt: 3,
          requestBudgetUsed: 2, calls: [],
        }] } }
      : { ok: true, value: {} })
    render(createElement(LearningFailureSection, {
      call, active: true,
      actions: [{
        actionKey: `act_${'d'.repeat(64)}`, subjectId: workItemId,
        kind: 'DISMISS_LEARNING', availableActions: ['DISMISS'],
      }],
      onMutationSettled: vi.fn(),
    }))
    const trigger = await screen.findByRole('button', { name: '关闭此失败' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '确认关闭此学习失败？' })
    const buttons = Array.from(dialog.querySelectorAll('button'))
    expect(buttons[0]).toBe(document.activeElement)
    document.body.focus()
    fireEvent.focusIn(document.body)
    expect(buttons[0]).toBe(document.activeElement)
    buttons[0]!.focus()
    fireEvent.keyDown(document, { key: 'Tab', ['shift' + 'Key']: true })
    expect(buttons.at(-1)).toBe(document.activeElement)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '确认关闭此学习失败？' })).toBeNull()
    expect(trigger).toBe(document.activeElement)
  })
})
