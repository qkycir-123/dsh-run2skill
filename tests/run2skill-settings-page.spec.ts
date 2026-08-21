// @vitest-environment jsdom

import { createElement, useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Run2skillAttentionToast,
  LearningFailureSection,
  RejectProposalModal,
  Run2skillSettingsPage,
  actionableProposalItems,
  applyRun2skillClient,
  hostTabVisible,
} from '../src/client/run2skill-settings-page.js'
import { AutomaticLearningSettingsController } from '../src/client/automatic-learning-settings.js'
import { PurgeSettingsController } from '../src/client/purge-settings.js'

afterEach(() => { cleanup() })

describe('run2skill native settings surface', () => {
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
            actions: [],
            runtimeCompleteness: 'KNOWN',
            runtimeWarnings: [],
          },
        })),
        callReview: review,
      }),
    ))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(review).not.toHaveBeenCalled()

    rendered.container.firstElementChild!.removeAttribute('hidden')
    await waitFor(() => {
      expect(review.mock.calls.some(([endpoint]) => endpoint === 'proposals/list')).toBe(true)
    })
    purge.dispose()
    automatic.dispose()
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
      effect: vi.fn((install: () => () => void) => { install() }),
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

  it('renders real learning failure facts selected by Attention and invokes the bounded retry RPC', async () => {
    const workItemId = `wi_${'a'.repeat(64)}`
    const call = vi.fn(async (endpoint: string) => endpoint === 'learning/issues/list'
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
      workspaceId: 'workspace-a',
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
    const dialog = await screen.findByRole('dialog', { name: '确认拒绝 Proposal？' })
    const buttons = Array.from(dialog.querySelectorAll('button'))
    expect(buttons[0]).toBe(document.activeElement)
    buttons[0]!.focus()
    fireEvent.keyDown(document, { key: 'Tab', ['shift' + 'Key']: true })
    expect(buttons.at(-1)).toBe(document.activeElement)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '确认拒绝 Proposal？' })).toBeNull()
    expect(trigger).toBe(document.activeElement)
  })
})
