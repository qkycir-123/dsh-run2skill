import { describe, expect, it, vi } from 'vitest'
import {
  ObserveStatusPill,
  applyObserveSummaryClient,
  describeObserveState,
} from '../src/client/observe-header-action.js'
import type { ObserveSummaryClientState } from '../src/client/observe-summary-poller.js'

function readyState(
  overrides: Record<string, unknown> = {},
): Extract<ObserveSummaryClientState, { phase: 'READY' }> {
  return {
    phase: 'READY',
    summary: {
      apiVersion: 1,
      status: 'READY',
      capturedCount: 2,
      blockedCaptureCount: 1,
      unsaved: { completeness: 'KNOWN', knownCount: 0 },
      recoveryLag: false,
      ...overrides,
    },
  }
}

describe('Observe Header action', () => {
  it('uses factual, non-actionable copy and never renders unknown unsaved as zero', () => {
    const unknown = readyState({
      status: 'RECOVERING',
      recoveryLag: true,
      unsaved: { completeness: 'UNKNOWN', knownCount: 0 },
    })
    const description = describeObserveState(unknown)

    expect(description).toContain('正在恢复历史观察')
    expect(description).toContain('尚未保存数量未知')
    expect(description).not.toContain('0 条尚未保存')
    expect(description).not.toMatch(/Approve|Reject|Retry|Purge|审核|批准|拒绝/)
  })

  it('keeps loading, unavailable, stale, and normal snapshots visibly distinct', () => {
    expect(describeObserveState({ phase: 'LOADING' })).toContain('加载中')
    expect(describeObserveState({ phase: 'UNAVAILABLE' })).toContain('暂不可用')
    expect(describeObserveState({ ...readyState(), phase: 'STALE' })).toContain('可能已过期')
    expect(describeObserveState(readyState())).toContain('已记录 2 条待处理事项')
    expect(describeObserveState(readyState())).toContain('另有 1 条观察不完整')
    expect(describeObserveState(readyState())).not.toContain('其中 1 条观察不完整')
  })

  it('uses the same health wording expected by the Inbox', () => {
    expect(describeObserveState(readyState({ status: 'INCOMPATIBLE' }))).toContain('run2skill 当前版本不兼容')
    expect(describeObserveState(readyState({ status: 'DEGRADED' }))).toContain('run2skill 暂时降级')
    expect(describeObserveState(readyState({ status: 'RECOVERING' }))).toContain('run2skill 正在恢复')
  })

  it('shows only aggregate learning counts in the Header summary', () => {
    const description = describeObserveState(readyState({
      learning: { captured: 2, analyzing: 1, learned: 3, needsAttention: 1 },
    }))

    expect(description).toContain('3 条已学习草案')
    expect(description).toContain('1 条正在学习')
    expect(description).toContain('1 条学习需处理')
    expect(description).not.toMatch(/正文|证据|Diff|Approve|Reject|批准|拒绝/)
  })

  it('renders a keyboard-focusable status whose meaning is not color-only', () => {
    const element = ObserveStatusPill({ state: readyState() })
    expect(element.type).toBe('span')
    expect(element.props).toMatchObject({ role: 'status', tabIndex: 0 })
    expect(element.props['aria-label']).toContain('已记录 2 条待处理事项')
    expect(element.props.children).toContain('已记录 2 条待处理事项')
  })

  it('registers exactly one Session Header entry with current-workspace review RPC and releases it', async () => {
    const remove = vi.fn()
    let injectedDispose: (() => void) | undefined
    const register = vi.fn((_options, _component) => remove)
    const inject = vi.fn((_name, install: () => () => void) => {
      injectedDispose = install()
    })
    const context = {
      connection: { rpc: { call: vi.fn() } },
      workspaces: {
        list: {
          getSnapshot: () => ({ items: [{ workspaceId: 'workspace-a', sessionIds: ['session-a'] }] }),
        },
      },
      slots: { inject, register },
    }

    applyObserveSummaryClient(context)

    expect(inject).toHaveBeenCalledWith('conversation.session.header.actions', expect.any(Function))
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'conversation.session.header.actions',
      id: 'run2skill-observe-summary',
    }), expect.any(Function))
    const options = register.mock.calls[0]?.[0] as {
      inject: () => {
        callReview(endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown>
        getWorkspaceId(sessionId: string): string
      }
    }
    expect(options.inject).toBeTypeOf('function')
    const face = options.inject()
    expect(face.getWorkspaceId('session-a')).toBe('workspace-a')
    expect(face.getWorkspaceId('unbound-session')).toBe('unbound-session')
    const signal = new AbortController().signal
    await face.callReview('proposals/list', { apiVersion: 1 }, signal)
    expect(context.connection.rpc.call).toHaveBeenCalledWith(
      '/run2skill', 'proposals/list', { apiVersion: 1 }, signal,
    )
    injectedDispose?.()
    expect(remove).toHaveBeenCalledTimes(1)
  })
})
