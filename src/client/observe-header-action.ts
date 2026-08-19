import {
  createElement,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactElement,
} from 'react'
import {
  OBSERVE_SUMMARY_ENDPOINT,
  RUN2SKILL_RPC_CHANNEL,
} from '../adapters/dsh-connection/observe-summary-rpc.js'
import {
  ObserveSummaryPoller,
  type ObserveSummaryCall,
  type ObserveSummaryClientState,
} from './observe-summary-poller.js'

export interface ObserveSummaryClientConnection {
  readonly rpc: {
    call(
      channel: string,
      endpoint: string,
      payload: unknown,
      signal?: AbortSignal,
    ): Promise<unknown>
  }
}

export interface ObserveSummaryClientContext {
  readonly connection: ObserveSummaryClientConnection
  readonly slots: {
    inject(name: string, install: () => () => void): void
    register(options: {
      readonly name: string
      readonly id: string
      readonly order: number
      readonly inject: { readonly callSummary: ObserveSummaryCall }
    }, component: typeof ObserveHeaderAction): () => void
  }
}

export const inject = ['connection', 'slots'] as const

function summaryFacts(state: Extract<ObserveSummaryClientState, { summary: unknown }>): string[] {
  const { summary } = state
  const facts: string[] = []
  if (summary.status === 'INCOMPATIBLE') facts.push('当前版本不兼容')
  else if (summary.status === 'DEGRADED') facts.push('观察功能暂时降级')
  else if (summary.status === 'RECOVERING') facts.push('正在恢复历史观察')
  facts.push(`已记录 ${summary.capturedCount} 条待处理事项`)
  if (summary.learning !== undefined) {
    if (summary.learning.learned > 0) facts.push(`${summary.learning.learned} 条已学习草案`)
    if (summary.learning.analyzing > 0) facts.push(`${summary.learning.analyzing} 条正在学习`)
    if (summary.learning.needsAttention > 0) {
      facts.push(`${summary.learning.needsAttention} 条学习需处理`)
    }
  }
  if (summary.blockedCaptureCount > 0) {
    facts.push(`另有 ${summary.blockedCaptureCount} 条观察不完整`)
  }
  if (summary.unsaved.completeness === 'UNKNOWN') {
    facts.push(summary.unsaved.knownCount > 0
      ? `至少有 ${summary.unsaved.knownCount} 条尚未保存，完整数量未知`
      : '尚未保存数量未知')
  } else {
    facts.push(summary.unsaved.knownCount > 0
      ? `${summary.unsaved.knownCount} 条尚未保存`
      : '没有尚未保存的事项')
  }
  return facts
}

export function describeObserveState(state: ObserveSummaryClientState): string {
  if (state.phase === 'LOADING') return 'run2skill 状态加载中'
  if (state.phase === 'UNAVAILABLE') return 'run2skill 状态暂不可用'
  const description = summaryFacts(state).join('；')
  return state.phase === 'STALE'
    ? `run2skill 状态可能已过期：${description}`
    : description
}

export function ObserveStatusPill({ state }: { readonly state: ObserveSummaryClientState }): ReactElement {
  const description = describeObserveState(state)
  const semanticStatus = 'summary' in state ? state.summary.status : state.phase
  return createElement('span', {
    role: 'status',
    tabIndex: 0,
    'aria-live': 'polite',
    'aria-label': description,
    'data-run2skill-status': semanticStatus,
    title: description,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      maxWidth: '28rem',
      padding: '0.25rem 0.5rem',
      border: '1px solid currentColor',
      borderRadius: '0.375rem',
      fontSize: '0.75rem',
      lineHeight: 1.25,
    },
  }, description)
}

export function ObserveHeaderAction({ callSummary }: { readonly callSummary: ObserveSummaryCall }): ReactElement {
  const poller = useMemo(() => new ObserveSummaryPoller(callSummary), [callSummary])
  useEffect(() => {
    poller.start()
    return () => { poller.dispose() }
  }, [poller])
  const state = useSyncExternalStore(poller.subscribe, poller.snapshot, poller.snapshot)
  return createElement(ObserveStatusPill, { state })
}

export function applyObserveSummaryClient(ctx: ObserveSummaryClientContext): void {
  const callSummary: ObserveSummaryCall = async (payload, signal) => await ctx.connection.rpc.call(
    RUN2SKILL_RPC_CHANNEL,
    OBSERVE_SUMMARY_ENDPOINT,
    payload,
    signal,
  )
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'run2skill-observe-summary',
      order: 30,
      inject: { callSummary },
    }, ObserveHeaderAction),
  )
}
