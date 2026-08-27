import {
  Fragment,
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type RefObject,
} from 'react'
import { z } from 'zod'
import {
  Button,
  DisclosureRow,
  IconRefreshOutline16,
  IconSettingsOutline16,
  IconSparkle16,
  IconTrashOutline16,
  IconWarningOutline16,
  Input,
  Modal,
  Pill,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { RUN2SKILL_RPC_CHANNEL } from '../adapters/dsh-connection/observe-summary-rpc.js'
import {
  AutomaticLearningSettingsController,
  type AutomaticLearningClientSettings,
  type ClientSettingsScope,
} from './automatic-learning-settings.js'
import {
  ProposalInboxController,
  describePersistenceScope,
  describeProposalKind,
  describeProposalListItem,
  describeProposalScope,
  type ProposalListItem,
  type ProposalReviewCall,
  type ProposalScopeAccess,
} from './proposal-inbox.js'
import { ProposalDetailView } from './proposal-inbox-view.js'
import { focusableSelector, trapDialogTab } from './dialog-focus.js'
import { PurgeSettingsController, PurgeSettingsSection, type PurgeCall } from './purge-settings.js'
import css from './run2skill-settings-page.module.css'
import { acquireRun2skillStyle } from './style-lifecycle.js'

export interface AttentionAction {
  readonly actionKey: string
  readonly subjectId?: string
  readonly kind?: string
  readonly scope?: 'PROJECT' | 'USER'
  readonly reasonCode?: string
  readonly availableActions?: readonly string[]
  readonly proposalRef?: {
    readonly proposalId: string
    readonly revision: number
    readonly digest: string
  }
}

export interface AttentionProjection {
  readonly apiVersion: 1
  readonly userCompleteness: 'KNOWN' | 'UNKNOWN'
  readonly projectCompleteness: 'KNOWN' | 'UNKNOWN' | 'UNAVAILABLE'
  readonly actions: readonly AttentionAction[]
  readonly runtimeCompleteness: 'KNOWN' | 'UNKNOWN'
  readonly runtimeWarnings: readonly {
    readonly noticeKey: string
    readonly message?: string
  }[]
}

export type AttentionCall = (
  payload: {
    readonly apiVersion: 1
    readonly currentScope:
      | { readonly kind: 'USER_ONLY'; readonly generation: number }
      | { readonly kind: 'WORKSPACE'; readonly generation: number; readonly workspaceId: string }
    readonly sessionId?: string
  },
  signal: AbortSignal,
) => Promise<unknown>

export type RecentSkillActivityCall = (
  payload: {
    readonly apiVersion: 1
    readonly currentScope:
      | { readonly kind: 'USER_ONLY'; readonly generation: number }
      | { readonly kind: 'WORKSPACE'; readonly generation: number; readonly workspaceId: string }
    readonly expectedVisibilityRevision?: string
  },
  signal: AbortSignal,
) => Promise<unknown>

export type LearningStatusCall = (
  endpoint: 'learning/status' | 'learning/request',
  payload: {
    readonly apiVersion: 1
    readonly currentScope:
      | { readonly kind: 'USER_ONLY'; readonly generation: number }
      | { readonly kind: 'WORKSPACE'; readonly generation: number; readonly workspaceId: string }
    readonly sessionId: string
  },
  signal: AbortSignal,
) => Promise<unknown>

const learningStatusResultSchema = z.object({
  ok: z.literal(true),
  value: z.object({
    apiVersion: z.literal(1),
    state: z.enum(['EMPTY', 'RECORDED', 'PROCESSING', 'CHECKING', 'COVERED', 'NEEDS_ATTENTION']),
    canRequest: z.boolean(),
  }).strict(),
}).strict()

const learningRequestResultSchema = z.object({
  ok: z.literal(true),
  value: z.object({
    apiVersion: z.literal(1),
    changed: z.boolean(),
    disposition: z.enum(['EMPTY', 'PROCESSING', 'QUEUED']),
  }).strict(),
}).strict()

const learningStatusCopy = {
  EMPTY: '暂无可整理的经验。',
  RECORDED: '已记下，待本次会话结束后整理。',
  PROCESSING: '正在整理本次经验…',
  CHECKING: '正在检查已有 Skill…',
  COVERED: '已有 Skill 已覆盖这次经验。',
  NEEDS_ATTENTION: '整理结果需要你处理。',
} as const

export function LearningStatusSection(props: {
  readonly sessionId?: string
  readonly workspaceId?: string
  readonly scopeGeneration?: number
  readonly active: boolean
  readonly call: LearningStatusCall
  readonly pollMs?: number
}): ReactElement {
  const [state, setState] = useState<
    | { readonly phase: 'LOADING' }
    | { readonly phase: 'ERROR' }
    | { readonly phase: 'READY'; readonly value: z.infer<typeof learningStatusResultSchema>['value'] }
  >({ phase: 'LOADING' })
  const [refreshGeneration, setRefreshGeneration] = useState(0)
  const requestPending = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  useEffect(() => {
    if (!props.active || props.sessionId === undefined) return
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      try {
        const parsed = learningStatusResultSchema.safeParse(await props.call('learning/status', {
          apiVersion: 1,
          currentScope: currentScope(props.workspaceId, props.scopeGeneration ?? 1),
          sessionId: props.sessionId!,
        }, abort.signal))
        if (!abort.signal.aborted) setState(parsed.success ? { phase: 'READY', value: parsed.data.value } : { phase: 'ERROR' })
      } catch {
        if (!abort.signal.aborted) setState({ phase: 'ERROR' })
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(() => { void refresh() }, props.pollMs ?? 5_000)
      }
    }
    void refresh()
    return () => {
      abort.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [props.active, props.call, props.pollMs, props.scopeGeneration, props.sessionId, props.workspaceId, refreshGeneration])
  const request = () => {
    if (!props.active || requestPending.current || state.phase !== 'READY' || !state.value.canRequest || props.sessionId === undefined) return
    requestPending.current = true
    setSubmitting(true)
    const abort = new AbortController()
    void (async () => {
      try {
        const result = learningRequestResultSchema.safeParse(await props.call('learning/request', {
          apiVersion: 1,
          currentScope: currentScope(props.workspaceId, props.scopeGeneration ?? 1),
          sessionId: props.sessionId!,
        }, abort.signal))
        if (!result.success) throw new Error('LEARNING_REQUEST_UNAVAILABLE')
        setState({
          phase: 'READY',
          value: {
            apiVersion: 1,
            state: result.data.value.disposition === 'PROCESSING'
              ? 'PROCESSING'
              : result.data.value.disposition === 'QUEUED'
                ? 'RECORDED'
                : 'EMPTY',
            canRequest: false,
          },
        })
        setRefreshGeneration(value => value + 1)
      } catch {
        setState({ phase: 'ERROR' })
      } finally {
        requestPending.current = false
        setSubmitting(false)
      }
    })()
  }
  const disabled = !props.active || state.phase !== 'READY' || !state.value.canRequest || submitting
  const statusText = props.sessionId === undefined
    ? '请先打开一个会话。'
    : state.phase === 'LOADING'
      ? '正在读取整理状态…'
      : state.phase === 'ERROR'
        ? '整理状态暂不可用，请刷新后重试。'
        : learningStatusCopy[state.value.state]
  return createElement('div', { className: css.sectionBody },
    createElement('div', { className: css.learningStatusRow },
      createElement('p', { role: state.phase === 'ERROR' ? 'alert' : 'status', 'aria-live': 'polite', className: css.status },
        statusText,
      ),
      createElement('div', { className: css.actions },
        createElement(Button, {
          variant: 'primary',
          disabled,
          onClick: request,
        }, submitting ? '正在提交…' : '立即整理本次经验'),
        createElement(Button, {
          variant: 'outline',
          'aria-label': '刷新整理状态',
          disabled: !props.active || props.sessionId === undefined || submitting,
          onClick: () => { setState({ phase: 'LOADING' }); setRefreshGeneration(value => value + 1) },
        }, createElement(IconRefreshOutline16)),
      ),
    ),
  )
}

const recentSkillActivityResultSchema = z.object({
  ok: z.literal(true),
  value: z.object({
    apiVersion: z.literal(1),
    visibilityRevision: z.string().regex(/^visibility_[a-f0-9]{64}$/),
    items: z.array(z.object({
      activityId: z.string().regex(/^activity_[a-f0-9]{64}$/),
      skillName: z.string().min(1).max(128),
      operation: z.enum(['CREATED', 'UPDATED']),
      scope: z.enum(['PROJECT', 'USER']),
      occurredAt: z.string().datetime({ offset: true }),
    }).strict()).max(256),
  }).strict(),
}).strict()

const recentSkillActivityVisibilityStaleSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.literal('visibility-stale') }).passthrough(),
}).passthrough()

const RECENT_SKILL_ACTIVITY_VISIBILITY_POLL_MS = 2_000

function waitForActivityVisibilityPoll(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const finish = () => {
      globalThis.clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = globalThis.setTimeout(finish, delayMs)
    signal.addEventListener('abort', finish, { once: true })
  })
}

type RecentSkillActivity = z.infer<typeof recentSkillActivityResultSchema>['value']['items'][number]

function formatActivityTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function usefulActivityScope(
  items: readonly RecentSkillActivity[],
  selected: RecentSkillActivity,
): boolean {
  return items.some(item => item.skillName === selected.skillName && item.scope !== selected.scope)
}

export function RecentSkillActivitySection(props: {
  readonly workspaceId?: string
  readonly call: RecentSkillActivityCall
  readonly active: boolean
  readonly scopeGeneration: number
  readonly hostDataEpoch?: number
  readonly visibilityPollMs?: number
}): ReactElement {
  const scopeIdentity = JSON.stringify([
    props.workspaceId ?? null,
    props.scopeGeneration,
    props.hostDataEpoch ?? 0,
  ])
  const [state, setState] = useState<{
    readonly phase: 'IDLE' | 'LOADING' | 'READY' | 'ERROR'
    readonly items: readonly RecentSkillActivity[]
    readonly scopeIdentity?: string
  }>({ phase: 'IDLE', items: [] })
  const visibleState = state.scopeIdentity === scopeIdentity ? state : { phase: 'IDLE' as const, items: [] }
  useEffect(() => {
    if (!props.active) return
    const abort = new AbortController()
    setState({ phase: 'LOADING', items: [], scopeIdentity })
    void (async () => {
      const readStable = async () => {
        let expectedVisibilityRevision: string | undefined
        let confirmedReads = 0
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const result = await props.call({
            apiVersion: 1,
            currentScope: currentScope(props.workspaceId, props.scopeGeneration),
            ...(expectedVisibilityRevision === undefined ? {} : { expectedVisibilityRevision }),
          }, abort.signal)
          if (abort.signal.aborted) return undefined
          if (recentSkillActivityVisibilityStaleSchema.safeParse(result).success) {
            expectedVisibilityRevision = undefined
            confirmedReads = 0
            continue
          }
          const parsed = recentSkillActivityResultSchema.safeParse(result)
          if (!parsed.success) throw new Error('RECENT_ACTIVITY_UNAVAILABLE')
          if (parsed.data.value.visibilityRevision === expectedVisibilityRevision) {
            confirmedReads += 1
            if (confirmedReads >= 2) return parsed.data.value
          } else {
            expectedVisibilityRevision = parsed.data.value.visibilityRevision
            confirmedReads = 0
          }
        }
        throw new Error('RECENT_ACTIVITY_VISIBILITY_UNSTABLE')
      }
      let current = await readStable()
      if (current === undefined || abort.signal.aborted) return
      setState({ phase: 'READY', items: current.items, scopeIdentity })
      while (!abort.signal.aborted) {
        await waitForActivityVisibilityPoll(
          abort.signal,
          props.visibilityPollMs ?? RECENT_SKILL_ACTIVITY_VISIBILITY_POLL_MS,
        )
        if (abort.signal.aborted) return
        const result = await props.call({
          apiVersion: 1,
          currentScope: currentScope(props.workspaceId, props.scopeGeneration),
          expectedVisibilityRevision: current.visibilityRevision,
        }, abort.signal)
        if (abort.signal.aborted) return
        const parsed = recentSkillActivityResultSchema.safeParse(result)
        if (
          recentSkillActivityVisibilityStaleSchema.safeParse(result).success
          || !parsed.success
          || parsed.data.value.visibilityRevision !== current.visibilityRevision
        ) {
          setState({ phase: 'LOADING', items: [], scopeIdentity })
          current = await readStable()
          if (current === undefined || abort.signal.aborted) return
        } else {
          current = parsed.data.value
        }
        setState({ phase: 'READY', items: current.items, scopeIdentity })
      }
    })().catch(() => {
      if (!abort.signal.aborted) setState({ phase: 'ERROR', items: [], scopeIdentity })
    })
    return () => { abort.abort() }
  }, [
    props.active,
    props.call,
    props.hostDataEpoch,
    props.scopeGeneration,
    props.visibilityPollMs,
    props.workspaceId,
    scopeIdentity,
  ])
  return createElement('div', { className: css.sectionBody },
    createElement('p', { className: css.muted }, '展示最近沉淀的 Skill'),
    visibleState.phase === 'LOADING' ? createElement('p', { role: 'status' }, '正在读取最近活动…') : null,
    visibleState.phase === 'ERROR' ? createElement('p', { role: 'alert' }, '最近活动暂不可用。') : null,
    visibleState.phase === 'READY' && visibleState.items.length === 0
      ? createElement('p', null, '最近 7 天没有成功沉淀的 Skill。')
      : null,
    visibleState.items.length === 0 ? null : createElement('ul', { className: css.activityList },
      ...visibleState.items.map(item => createElement('li', { className: css.activityItem, key: item.activityId },
        createElement('div', { className: css.activitySummary },
          createElement('strong', null, item.skillName),
          createElement(Pill, null, item.operation === 'CREATED' ? '新建技能' : '更新技能'),
          usefulActivityScope(visibleState.items, item)
            ? createElement(Pill, null, describePersistenceScope(item.scope))
            : null,
        ),
        createElement('time', { dateTime: item.occurredAt, className: css.muted }, formatActivityTime(item.occurredAt)),
      )),
    ),
  )
}

const learningIssueSchema = z.object({
  workItemId: z.string().regex(/^wi_[a-f0-9]{64}$/),
  workItemRevision: z.number().int().safe().positive(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  failureCode: z.string().min(1).max(256),
  failureDetail: z.string().min(1).max(256).optional(),
  retryable: z.boolean(),
  attempt: z.number().int().nonnegative().max(3),
  requestBudgetUsed: z.number().int().nonnegative().max(2),
  modelRoute: z.object({
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
  }).strict().optional(),
  calls: z.array(z.object({
    requestOrdinal: z.number().int().positive(),
    kind: z.string().min(1).max(256),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    outcome: z.string().min(1).max(256),
  }).strict()).max(2),
  attentionKind: z.enum(['SAFETY_STOP', 'PROCESSING_FAILURE', 'STALE_RESULT', 'NEEDS_DECISION']).optional(),
  currentStage: z.enum(['DETECTION', 'OWNERSHIP', 'RECALL', 'COVERAGE', 'GENERATION']).optional(),
  stages: z.array(z.object({
    stage: z.enum(['DETECTION', 'OWNERSHIP', 'RECALL', 'COVERAGE', 'GENERATION']),
    state: z.enum(['NOT_STARTED', 'COMPLETED', 'STOPPED']),
    modelCalls: z.object({
      total: z.number().int().nonnegative(),
      reserved: z.number().int().nonnegative(),
      succeeded: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      aborted: z.number().int().nonnegative(),
      timedOut: z.number().int().nonnegative(),
      outcomeUnknown: z.number().int().nonnegative(),
    }).strict(),
  }).strict()).max(5).optional(),
}).strict()
type LearningIssue = z.infer<typeof learningIssueSchema>
const learningIssuePageSchema = z.object({
  ok: z.literal(true),
  value: z.object({
    apiVersion: z.literal(1),
    items: z.array(learningIssueSchema).max(20),
    nextCursor: z.string().regex(/^c_[1-9][0-9]*_[1-9][0-9]*_[a-f0-9]{64}$/).optional(),
  }).strict(),
}).strict()

const learningStageLabels: Record<NonNullable<LearningIssue['currentStage']>, string> = {
  DETECTION: '语义检测',
  OWNERSHIP: '重复保存检查',
  RECALL: '已有 Skill 检索',
  COVERAGE: '重复与合并判断',
  GENERATION: 'Skill 草稿生成',
}

function learningIssueDescription(item: LearningIssue): { readonly title: string; readonly detail: string } {
  if (item.failureCode === 'BASELINE_INCOMPLETE') return {
    title: '自动沉淀已停止',
    detail: '缺少任务开始前的 Skill 状态记录，无法确认 Agent 是否已经保存过同类 Skill。为避免重复生成，本次已停止。已有 Skill 和原始会话记录不受影响。',
  }
  if (item.failureCode === 'MODEL_TERMINAL_FAILURE') return {
    title: '自动沉淀未完成',
    detail: '模型没有返回可用的结果，本次自动沉淀未完成。已有 Skill 和原始会话记录不受影响。',
  }
  if (item.failureCode === 'MODEL_OUTPUT_TRUNCATED') return {
    title: '语义判断没有完成',
    detail: '模型在返回简短判断前用完了本次输出额度，因此没有继续生成 Skill 草稿。已有 Skill 和原始会话记录不受影响。',
  }
  if (item.failureCode === 'SESSION_CONTEXT_UNAVAILABLE') return {
    title: '自动沉淀已停止',
    detail: '任务结束后没能恢复当时的会话信息，无法确认 Agent 是否已经保存过同类 Skill。为避免重复生成，本次已停止。已有 Skill 和原始会话记录不受影响。',
  }
  if (item.failureCode === 'SESSION_SNAPSHOT_UNAVAILABLE') return {
    title: '自动沉淀已停止',
    detail: '没能读取任务结束时的会话快照，无法确认 Skill 状态是否稳定。为避免重复生成，本次已停止。已有 Skill 和原始会话记录不受影响。',
  }
  if (item.failureCode === 'SESSION_LOG_UNAVAILABLE') return {
    title: '自动沉淀已停止',
    detail: '没能完整读取本次任务的会话记录，无法确认 Agent 是否已经保存过同类 Skill。为避免重复生成，本次已停止。已有 Skill 和原始会话记录不受影响。',
  }
  if (item.failureCode === 'SESSION_WINDOW_INCOMPLETE') return {
    title: '自动沉淀已停止',
    detail: '本次任务的会话记录不完整或超出安全检查范围，无法可靠判断是否已经生成过 Skill。为避免重复生成，本次已停止。',
  }
  if (item.failureCode === 'SESSION_CHANGED_DURING_CHECK') return {
    title: '自动沉淀已停止',
    detail: '核对期间会话又发生了变化，当前结果已经失效。为避免使用过期记录或重复生成，本次已停止。',
  }
  if (item.failureCode === 'OWNERSHIP_ANALYSIS_UNAVAILABLE' || item.failureCode === 'OBSERVATION_FAILED') return {
    title: '自动沉淀已停止',
    detail: '系统没能完整核对本次任务结束时的 Skill 状态和 Agent 操作记录，因此无法确认是否已经保存过同类 Skill。为避免重复生成，本次已停止。已有 Skill 和原始会话记录不受影响。',
  }
  if (item.attentionKind === 'STALE_RESULT') return {
    title: '自动沉淀结果已过期',
    detail: '生成依据已经发生变化，本次结果已停止使用，以免覆盖新的 Skill 状态。',
  }
  if (item.attentionKind === 'NEEDS_DECISION') return {
    title: '自动沉淀需要确认',
    detail: '系统无法明确判断是否还需要生成 Skill，因此没有自动继续。',
  }
  if (item.attentionKind === 'SAFETY_STOP') return {
    title: '自动沉淀已停止',
    detail: '系统无法确认继续处理是否安全，因此本次自动沉淀已停止。已有 Skill 和原始会话记录不受影响。',
  }
  return {
    title: '自动沉淀未完成',
    detail: '处理过程中出现问题，本次自动沉淀未能继续。已有 Skill 和原始会话记录不受影响。',
  }
}

function stageDescription(stage: NonNullable<LearningIssue['stages']>[number]): string {
  const label = learningStageLabels[stage.stage]
  if (stage.state === 'NOT_STARTED') return `${label}：未开始`
  if (stage.state === 'STOPPED') return `${label}：未完成`
  if (stage.modelCalls.total === 0) return `${label}：已完成`
  const succeeded = stage.modelCalls.succeeded === 0 ? '' : `，成功 ${String(stage.modelCalls.succeeded)} 次`
  return `${label}：已完成（模型调用 ${String(stage.modelCalls.total)} 次${succeeded}）`
}

function attentionValue(value: unknown): AttentionProjection | undefined {
  if (value === null || typeof value !== 'object' || !('ok' in value) || value.ok !== true || !('value' in value)) {
    return undefined
  }
  const projection = value.value as Partial<AttentionProjection>
  if (
    projection.apiVersion !== 1
    || !Array.isArray(projection.actions)
    || !Array.isArray(projection.runtimeWarnings)
  ) return undefined
  return projection as AttentionProjection
}

const seenAttentionKeys = new Set<string>()
const ATTENTION_SETTINGS_POLL_INTERVAL_MS = 10_000

function currentScope(workspaceId: string | undefined, generation: number) {
  return workspaceId === undefined
    ? { kind: 'USER_ONLY' as const, generation }
    : { kind: 'WORKSPACE' as const, generation, workspaceId }
}

export function Run2skillAttentionToast(props: {
  readonly sessionId: string
  readonly workspaceId?: string
  readonly callAttention: AttentionCall
}): ReactElement | null {
  const [toast, setToast] = useState<{ readonly sequence: number; readonly count: number }>()
  const scopeGeneration = useRef(0)
  useEffect(() => {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let sequence = 0
    const generation = ++scopeGeneration.current
    const refresh = async (): Promise<void> => {
      try {
        const projection = attentionValue(await props.callAttention({
          apiVersion: 1,
          currentScope: currentScope(props.workspaceId, generation),
          sessionId: props.sessionId,
        }, abort.signal))
        if (projection === undefined || abort.signal.aborted) return
        const keys = [
          ...projection.actions.map(action => action.actionKey),
          ...projection.runtimeWarnings.map(warning => warning.noticeKey),
        ].filter(key => /^act_[a-f0-9]{64}$|^notice_[a-f0-9]{64}$/.test(key))
        const fresh = keys.filter(key => !seenAttentionKeys.has(key))
        if (fresh.length > 0) {
          for (const key of fresh) seenAttentionKeys.add(key)
          sequence += 1
          setToast({ sequence, count: fresh.length })
        }
      } catch {
        // An unavailable or untrusted Attention response is not an empty queue and creates no Header chrome.
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(() => { void refresh() }, 10_000)
      }
    }
    void refresh()
    return () => {
      abort.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [props.callAttention, props.sessionId, props.workspaceId])
  if (toast === undefined) return null
  return createElement(Toast, {
    key: toast.sequence,
    icon: createElement(IconWarningOutline16),
    text: `Run2Skill 有 ${String(toast.count)} 项需要处理，请前往设置 → 插件 → Run2Skill`,
    onDone: () => { setToast(undefined) },
  })
}

function AutomaticLearningSection(props: {
  readonly controller: AutomaticLearningSettingsController
}): ReactElement {
  const state = useSyncExternalStore(
    props.controller.subscribe,
    props.controller.getSnapshot,
    props.controller.getSnapshot,
  )
  const disabled = state.status !== 'ready' || !state.writable || state.saving
  return createElement('div', { className: css.sectionBody },
    createElement('p', { className: css.muted },
      '在后台识别可复用经验并生成待确认的技能草稿；关闭后，明确说“保存为 Skill”仍然有效。',
    ),
    createElement('div', { className: css.actions },
      createElement(Button, {
        variant: state.automaticLearning ? 'primary' : 'outline',
        'aria-pressed': state.automaticLearning === true,
        disabled,
        onClick: () => { void props.controller.setAutomaticLearning(state.automaticLearning !== true) },
      }, state.saving ? '正在保存…' : state.automaticLearning ? '自动学习已开启' : '自动学习已关闭'),
      createElement(Pill, null, '沿用当前会话模型'),
    ),
    state.error === undefined
      ? null
      : createElement('p', { role: 'status', className: css.danger }, '设置已变化，请刷新后重试。'),
  )
}

function ProposalSettingsSection(props: {
  readonly workspaceId?: string
  readonly callReview: ProposalReviewCall
  readonly active: boolean
  readonly actions: readonly AttentionAction[]
  readonly onMutationSettled: () => void
  readonly scopeGeneration: number
}): ReactElement {
  const scopeAccessRef = useRef<ProposalScopeAccess>({
    currentScope: currentScope(props.workspaceId, props.scopeGeneration),
    actions: [],
  })
  scopeAccessRef.current = {
    currentScope: currentScope(props.workspaceId, props.scopeGeneration),
    actions: props.actions.flatMap(action => (
      action.subjectId === undefined
      || action.proposalRef === undefined
      || !['REVIEW_PROPOSAL', 'REFRESH_PROPOSAL', 'RETRY_PUBLICATION'].includes(action.kind ?? '')
        ? []
        : [{
            actionKey: action.actionKey,
            subjectId: action.subjectId,
            kind: action.kind as 'REVIEW_PROPOSAL' | 'REFRESH_PROPOSAL' | 'RETRY_PUBLICATION',
            proposalRef: action.proposalRef,
          }]
    )),
  }
  const controller = useMemo(
    () => new ProposalInboxController(
      props.workspaceId ?? '__run2skill_user_only__',
      props.callReview,
      undefined,
      {
        attentionDriven: true,
        scopeAccess: () => scopeAccessRef.current,
      },
    ),
    [props.callReview, props.scopeGeneration, props.workspaceId],
  )
  useEffect(() => {
    if (!props.active) controller.pause()
    controller.start()
    return () => { controller.dispose() }
  }, [controller])
  useEffect(() => {
    if (props.active) {
      controller.resume()
      void controller.open()
    } else {
      controller.pause()
      controller.close()
    }
  }, [controller, props.active])
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  const [filter, setFilter] = useState('')
  const [textMode, setTextMode] = useState<'SAFE' | 'RAW'>('SAFE')
  const [rejectConfirm, setRejectConfirm] = useState(false)
  const rejectTriggerRef = useRef<HTMLButtonElement | null>(null)
  const actionableItems = actionableProposalItems(props.actions, state.items)
  const showFilter = actionableItems.length > 1
  const items = showFilter
    ? actionableItems.filter(item => `${item.name} ${item.description} ${item.kind}`
      .toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
    : actionableItems
  const selectedActionable = items.some(item => item.proposalRef.proposalId === state.selectedProposalId)
  if (props.actions.length === 0) return createElement(Fragment)
  return createElement('div', { className: css.attentionGroup },
    createElement('div', {
      className: showFilter
        ? css.proposalToolbar
        : `${css.proposalToolbar} ${css.proposalToolbarCompact}`,
    },
      showFilter
        ? createElement(Input, {
            value: filter,
            placeholder: '筛选技能草稿',
            'aria-label': '筛选技能草稿',
            onChange: event => { setFilter(event.currentTarget.value) },
          })
        : null,
      createElement(Button, {
        variant: 'outline',
        size: 'sm',
        icon: createElement(IconRefreshOutline16),
        onClick: () => { void controller.open() },
      }, '刷新'),
    ),
    state.listPhase === 'LOADING' ? createElement('p', { role: 'status' }, '正在加载待处理事项…') : null,
    state.listPhase === 'ERROR' ? createElement('p', { role: 'alert' }, '待处理事项暂不可用。') : null,
    createElement('div', { className: css.proposalLayout },
      createElement('ul', { className: css.proposalList },
        ...items.map(item => createElement('li', { key: item.proposalRef.proposalId },
          createElement(Button, {
            variant: 'outline',
            className: css.proposalListButton,
            'aria-current': state.selectedProposalId === item.proposalRef.proposalId ? 'true' : undefined,
            'aria-label': `${item.name}，${describeProposalKind(item.kind)}，${describeProposalScope(item.kind, item.persistenceScope)}，${describeProposalListItem(item)}`,
            disabled: state.mutationPending || state.detailPhase === 'LOADING',
            onClick: () => { void controller.select(item.proposalRef.proposalId) },
          },
          createElement('span', { className: css.proposalName }, item.name),
          createElement('span', { className: css.proposalMeta },
            `${describeProposalKind(item.kind)} · ${describeProposalScope(item.kind, item.persistenceScope)} · ${describeProposalListItem(item)}`,
          )),
        )),
      ),
      createElement('section', { className: css.detail, 'aria-label': '技能草稿详情' },
        !selectedActionable || state.detailPhase === 'IDLE'
          ? createElement('p', null, '选择一项查看审核事实。')
          : null,
        selectedActionable && state.detailPhase === 'LOADING'
          ? createElement('p', { role: 'status' }, '正在加载详情…')
          : null,
        selectedActionable && state.detailPhase === 'ERROR'
          ? createElement('p', { role: 'alert' }, '详情暂不可用。')
          : null,
        !selectedActionable || state.detail === undefined ? null : createElement(ProposalDetailView, {
          detail: state.detail,
          textMode,
          setTextMode,
          mutationPending: state.mutationPending,
          onApprove: () => { void controller.mutate('APPROVE').finally(props.onMutationSettled) },
          onReject: trigger => {
            rejectTriggerRef.current = trigger ?? null
            setRejectConfirm(true)
          },
          onRetry: () => { void controller.mutate('RETRY').finally(props.onMutationSettled) },
          onRefresh: () => { void controller.mutate('REFRESH').finally(props.onMutationSettled) },
          onConfirmDiscard: () => { void controller.mutate('CONFIRM_DISCARD').finally(props.onMutationSettled) },
        }),
      ),
    ),
    createElement('p', {
      role: 'status', 'aria-live': 'polite', 'aria-atomic': true, className: css.status,
    }, state.announcement),
    createElement(RejectProposalModal, {
      open: rejectConfirm,
      disabled: state.mutationPending,
      triggerRef: rejectTriggerRef,
      onClose: () => { setRejectConfirm(false) },
      onConfirm: () => {
        setRejectConfirm(false)
        void controller.mutate('REJECT').finally(props.onMutationSettled)
      },
    }),
  )
}

export function LearningFailureSection(props: {
  readonly workspaceId?: string
  readonly call: ProposalReviewCall
  readonly active: boolean
  readonly actions: readonly AttentionAction[]
  readonly onMutationSettled: () => void
  readonly scopeGeneration?: number
}): ReactElement {
  const [phase, setPhase] = useState<'IDLE' | 'LOADING' | 'READY' | 'ERROR'>('IDLE')
  const [items, setItems] = useState<readonly LearningIssue[]>([])
  const [refreshGeneration, setRefreshGeneration] = useState(0)
  const [pending, setPending] = useState<string>()
  const [dismiss, setDismiss] = useState<LearningIssue>()
  const dismissTriggerRef = useRef<HTMLButtonElement | null>(null)
  const learningActions = useMemo(() => new Map(props.actions.flatMap(action => (
    action.subjectId === undefined
    || !['RETRY_LEARNING', 'DISMISS_LEARNING'].includes(action.kind ?? '')
      ? []
      : [[action.subjectId, action] as const]
  ))), [props.actions])
  useEffect(() => {
    if (!props.active || learningActions.size === 0) {
      setPhase('IDLE')
      setItems([])
      return
    }
    const abort = new AbortController()
    setPhase('LOADING')
    void (async () => {
      const next: LearningIssue[] = []
      let cursor: string | undefined
      for (let page = 0; page < 10; page += 1) {
        const parsed = learningIssuePageSchema.safeParse(await props.call(
          'learning/issues/list',
          {
            apiVersion: 1,
            currentScope: currentScope(props.workspaceId, props.scopeGeneration ?? 1),
            limit: 20,
            ...(cursor === undefined ? {} : { cursor }),
          },
          abort.signal,
        ))
        if (!parsed.success) throw new Error('invalid learning issue response')
        next.push(...parsed.data.value.items.filter(item => learningActions.has(item.workItemId)))
        cursor = parsed.data.value.nextCursor
        if (cursor === undefined) {
          if (!abort.signal.aborted) {
            setItems(next)
            setPhase('READY')
          }
          return
        }
      }
      throw new Error('learning issue page limit exceeded')
    })().catch(() => {
      if (!abort.signal.aborted) {
        setItems([])
        setPhase('ERROR')
      }
    })
    return () => { abort.abort() }
  }, [learningActions, props.active, props.call, props.scopeGeneration, props.workspaceId, refreshGeneration])
  const mutate = (endpoint: 'learning/issues/retry' | 'learning/issues/dismiss', item: LearningIssue) => {
    if (pending !== undefined) return
    const selectedAction = learningActions.get(item.workItemId)
    if (selectedAction?.subjectId === undefined || selectedAction.kind === undefined) return
    setPending(item.workItemId)
    void props.call(endpoint, {
      apiVersion: 1,
      workItemId: item.workItemId,
      workItemRevision: item.workItemRevision,
      currentScope: currentScope(props.workspaceId, props.scopeGeneration ?? 1),
      action: {
        actionKey: selectedAction.actionKey,
        subjectId: selectedAction.subjectId,
        kind: selectedAction.kind,
        ...(selectedAction.proposalRef === undefined ? {} : { proposalRef: selectedAction.proposalRef }),
      },
      ...(endpoint === 'learning/issues/dismiss' ? { confirm: true } : {}),
    }, new AbortController().signal).then(result => {
      if (
        result === null
        || typeof result !== 'object'
        || !('ok' in result)
        || result.ok !== true
      ) throw new Error('learning issue mutation rejected')
      setItems(current => current.filter(candidate => candidate.workItemId !== item.workItemId))
      props.onMutationSettled()
    }).catch(() => { setPhase('ERROR') }).finally(() => { setPending(undefined) })
  }
  if (learningActions.size === 0) return createElement(Fragment)
  return createElement('section', { className: css.attentionGroup, 'aria-label': '自动沉淀未继续' },
    createElement('div', { className: css.toolbar },
      createElement('strong', null, `自动沉淀未继续 · ${String(learningActions.size)} 项`),
      createElement(Button, {
        variant: 'outline',
        size: 'sm',
        icon: createElement(IconRefreshOutline16),
        disabled: !props.active || pending !== undefined,
        onClick: () => { setRefreshGeneration(value => value + 1) },
      }, '刷新详情'),
    ),
    phase === 'LOADING' ? createElement('p', { role: 'status' }, '正在加载自动沉淀详情…') : null,
    phase === 'ERROR' ? createElement('p', { role: 'alert' }, '自动沉淀详情暂不可用，请保持 DSH 运行并稍后重试。') : null,
    ...items.map(item => {
      const action = learningActions.get(item.workItemId)
      const busy = pending === item.workItemId
      const isCoverageConfirmation = item.failureCode === 'COVERED_NEEDS_CONFIRMATION'
      const description = isCoverageConfirmation
        ? {
            title: '发现可能重复的 Skill',
            detail: 'Run2Skill 发现已有 Skill 可能已经包含这次经验，因此暂停生成新草稿。请选择下一步。',
          }
        : learningIssueDescription(item)
      return createElement('article', { className: css.detail, key: item.workItemId },
        createElement('strong', null, description.title),
        createElement('p', null, description.detail),
        item.stages === undefined
          ? item.calls.length === 0 ? null : createElement('p', null, `已记录模型调用 ${String(item.calls.length)} 次`)
          : createElement('div', null,
              ...item.stages.map(stage => createElement('p', { key: stage.stage }, stageDescription(stage))),
            ),
        item.modelRoute === undefined
          ? null
          : createElement('details', { className: css.technicalDetails },
              createElement('summary', null, '本次处理的技术信息'),
              createElement('p', null, `使用的模型：${item.modelRoute.model}（${item.modelRoute.provider}）`),
            ),
        createElement('div', { className: css.actions },
          action?.availableActions?.includes('RETRY') === true
            ? createElement(Button, {
                variant: 'primary',
                disabled: busy || pending !== undefined,
                onClick: () => { mutate('learning/issues/retry', item) },
              }, busy
                ? '正在处理…'
                : isCoverageConfirmation ? '继续生成新 Skill 草稿' : '重试学习')
            : null,
          action?.availableActions?.includes('DISMISS') === true
            ? createElement(Button, {
                variant: 'outline',
                disabled: busy || pending !== undefined,
                onClick: event => {
                  dismissTriggerRef.current = event.currentTarget
                  setDismiss(item)
                },
              }, isCoverageConfirmation ? '使用已有 Skill，不生成草稿' : '关闭此事项')
            : null,
        ),
      )
    }),
    createElement(ManagedConfirmationModal, {
      open: dismiss !== undefined,
      title: dismiss?.failureCode === 'COVERED_NEEDS_CONFIRMATION'
        ? '使用已有 Skill，不生成新草稿？'
        : '确认关闭此待处理事项？',
      description: dismiss?.failureCode === 'COVERED_NEEDS_CONFIRMATION'
        ? '确认后，此项将从待处理列表移除，Run2Skill 不会为这次经验生成新草稿；已有 Skill 和 DSH 原始会话记录不会改变。'
        : '关闭后，本次自动沉淀不会继续，也不会生成草稿；已有 Skill 和 DSH 的原始会话记录不会改变。',
      disabled: pending !== undefined,
      triggerRef: dismissTriggerRef,
      onClose: () => { setDismiss(undefined) },
      confirmLabel: dismiss?.failureCode === 'COVERED_NEEDS_CONFIRMATION' ? '使用已有 Skill' : '确认关闭',
      onConfirm: () => {
        const selected = dismiss
        setDismiss(undefined)
        if (selected !== undefined) mutate('learning/issues/dismiss', selected)
      },
    }),
  )
}

export function RejectProposalModal(props: {
  readonly open: boolean
  readonly disabled: boolean
  readonly triggerRef: RefObject<HTMLButtonElement | null>
  readonly onClose: () => void
  readonly onConfirm: () => void
}): ReactElement {
  return createElement(ManagedConfirmationModal, {
    ...props,
    title: '确认放弃这份技能草稿？',
    description: '现有 Skill 不会改变；这份技能草稿将离开待处理队列。',
    confirmLabel: '确认放弃',
  })
}

function ManagedConfirmationModal(props: {
  readonly open: boolean
  readonly disabled: boolean
  readonly triggerRef: RefObject<HTMLButtonElement | null>
  readonly title: string
  readonly description: string
  readonly confirmLabel: string
  readonly onClose: () => void
  readonly onConfirm: () => void
}): ReactElement {
  const contentRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef<(() => void) | null>(props.onClose)
  onCloseRef.current = props.onClose
  useEffect(() => {
    if (!props.open || typeof document === 'undefined') return
    const dialog = contentRef.current?.closest<HTMLElement>('[role="dialog"]')
    const initial = dialog?.querySelector<HTMLElement>('[autofocus]')
      ?? dialog?.querySelector<HTMLElement>(focusableSelector)
    const onFocus = (event: FocusEvent) => {
      if (dialog != null && event.target instanceof Node && !dialog.contains(event.target)) initial?.focus()
    }
    const onKeyboardEvent = (event: KeyboardEvent) => {
      if (dialog == null) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        onCloseRef.current?.()
      } else if (event.key === 'Tab') {
        trapDialogTab(event.key, event.shiftKey, () => { event.preventDefault() }, dialog, document.activeElement)
      }
    }
    document.addEventListener('focusin', onFocus, true)
    document.addEventListener('keydown', onKeyboardEvent, true)
    initial?.focus()
    return () => {
      document.removeEventListener('focusin', onFocus, true)
      document.removeEventListener('keydown', onKeyboardEvent, true)
      props.triggerRef.current?.focus()
    }
  }, [props.open, props.triggerRef])
  return createElement(Modal, {
    open: props.open,
    title: props.title,
    closeLabel: '取消',
    description: props.description,
    onClose: props.onClose,
    footer: createElement('div', { className: css.actions },
      createElement(Button, {
        variant: 'ghost',
        autoFocus: true,
        disabled: props.disabled,
        onClick: props.onClose,
      }, '取消'),
      createElement(Button, {
        variant: 'primary',
        disabled: props.disabled,
        onClick: props.onConfirm,
      }, props.confirmLabel),
    ),
  }, createElement('div', { ref: contentRef }))
}

export function actionableProposalItems(
  actions: readonly AttentionAction[],
  items: readonly ProposalListItem[],
): readonly ProposalListItem[] {
  const identities = new Set(actions.flatMap(action => (
    action.subjectId === undefined
    || action.proposalRef === undefined
    || !['REVIEW_PROPOSAL', 'REFRESH_PROPOSAL', 'RETRY_PUBLICATION'].includes(action.kind ?? '')
      ? []
      : [`${action.subjectId}\u0000${action.proposalRef.proposalId}\u0000${String(action.proposalRef.revision)}\u0000${action.proposalRef.digest}`]
  )))
  return items.filter(item => identities.has(
    `${item.workItemId}\u0000${item.proposalRef.proposalId}\u0000${String(item.proposalRef.revision)}\u0000${item.proposalRef.digest}`,
  ))
}

export function hostTabVisible(element: Element | null): boolean {
  return element !== null && element.closest('[hidden]') === null
}

function useHostTabVisibility(): {
  readonly ref: RefObject<HTMLDivElement>
  readonly visible: boolean
} {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const update = () => { setVisible(hostTabVisible(ref.current)) }
    update()
    if (ref.current === null || typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(update)
    let current: Element | null = ref.current
    while (current !== null) {
      observer.observe(current, { attributes: true, attributeFilter: ['hidden'] })
      current = current.parentElement
    }
    return () => { observer.disconnect() }
  }, [])
  return { ref, visible }
}

export function AttentionSettingsSummary(props: {
  readonly active?: boolean
  readonly sessionId?: string
  readonly workspaceId?: string
  readonly callAttention: AttentionCall
  readonly refreshGeneration: number
  readonly onProjection: (value: AttentionProjection | undefined) => void
}): ReactElement {
  const [state, setState] = useState<
    { readonly phase: 'LOADING' | 'READY' | 'UNAVAILABLE'; readonly value?: AttentionProjection }
  >({ phase: 'LOADING' })
  const requestGeneration = useRef(0)
  const activeAbort = useRef<AbortController>()
  const currentValue = useRef<AttentionProjection>()
  const currentScopeIdentity = useRef<string>()
  const scopeIdentity = `${props.sessionId ?? ''}:${props.workspaceId ?? ''}`
  const refresh = useCallback(() => {
    activeAbort.current?.abort()
    const abort = new AbortController()
    activeAbort.current = abort
    const generation = ++requestGeneration.current
    const scopeChanged = currentScopeIdentity.current !== scopeIdentity
    currentScopeIdentity.current = scopeIdentity
    if (scopeChanged) currentValue.current = undefined
    if (currentValue.current === undefined) {
      setState({ phase: 'LOADING' })
      props.onProjection(undefined)
    }
    void props.callAttention({
      apiVersion: 1,
      currentScope: currentScope(props.workspaceId, generation),
      ...(props.sessionId === undefined ? {} : { sessionId: props.sessionId }),
    }, abort.signal).then(result => {
      if (abort.signal.aborted || requestGeneration.current !== generation) return
      const value = attentionValue(result)
      if (value === undefined) {
        if (currentValue.current === undefined) {
          setState({ phase: 'UNAVAILABLE' })
          props.onProjection(undefined)
        }
        return
      }
      currentValue.current = value
      setState({ phase: 'READY', value })
      props.onProjection(value)
    }, () => {
      if (abort.signal.aborted || requestGeneration.current !== generation) return
      if (currentValue.current === undefined) {
        setState({ phase: 'UNAVAILABLE' })
        props.onProjection(undefined)
      }
    })
    return () => {
      abort.abort()
      if (activeAbort.current === abort) activeAbort.current = undefined
    }
  }, [props.callAttention, props.onProjection, props.refreshGeneration, props.sessionId, props.workspaceId, scopeIdentity])
  useEffect(() => {
    if (props.active === false) {
      activeAbort.current?.abort()
      activeAbort.current = undefined
      return
    }
    refresh()
    const timer = setInterval(() => { refresh() }, ATTENTION_SETTINGS_POLL_INTERVAL_MS)
    return () => {
      clearInterval(timer)
      activeAbort.current?.abort()
      activeAbort.current = undefined
    }
  }, [props.active, refresh])
  const value = state.value
  if (
    value === undefined
    || (
      value.actions.length === 0
      && value.runtimeWarnings.length === 0
      && value.projectCompleteness !== 'UNKNOWN'
      && value.runtimeCompleteness !== 'UNKNOWN'
    )
  ) return createElement(Fragment)
  return createElement('div', { className: css.toolbar },
    createElement(Fragment, null,
      createElement(Pill, null, `${String(value.actions.length)} 项可操作事项`),
      value.projectCompleteness === 'UNAVAILABLE'
        ? createElement(Pill, null, '未选择当前项目')
        : value.projectCompleteness === 'UNKNOWN'
          ? createElement(Pill, null, '当前项目的待处理状态暂时无法确认')
          : null,
      value.runtimeCompleteness === 'UNKNOWN' ? createElement(Pill, null, '未保存数量未知') : null,
      ...value.runtimeWarnings.map(warning => createElement('span', {
        key: warning.noticeKey,
        role: 'alert',
      }, warning.message ?? '存在尚未持久化的学习信号。')),
    ),
  )
}

export function Run2skillSettingsPage(props: {
  readonly controller: AutomaticLearningSettingsController
  readonly purgeController: PurgeSettingsController
  readonly workspaceId?: string
  readonly sessionId?: string
  readonly callAttention: AttentionCall
  readonly callReview: ProposalReviewCall
  readonly callActivity: RecentSkillActivityCall
  readonly callLearningStatus?: LearningStatusCall
  readonly useSessions?: <T>(selector: (state: { readonly current?: string }) => T) => T
  readonly useWorkspaces?: <T>(selector: (state: {
    readonly items: readonly { readonly workspaceId: string; readonly sessionIds?: readonly string[] }[]
  }) => T) => T
}): ReactElement {
  const liveSessionId = props.useSessions?.(state => state.current)
  const liveWorkspaceId = props.useWorkspaces?.(state => state.items
    .find(workspace => workspace.sessionIds?.includes(liveSessionId ?? ''))?.workspaceId)
  const workspaceId = props.useSessions === undefined ? props.workspaceId : liveWorkspaceId
  const sessionId = props.useSessions === undefined ? props.sessionId : liveSessionId
  const [open, setOpen] = useState(() => new Set(['status', 'attention']))
  const hostTab = useHostTabVisibility()
  const [attention, setAttention] = useState<AttentionProjection>()
  const [attentionRefresh, setAttentionRefresh] = useState(0)
  const [scopeGeneration, setScopeGeneration] = useState(1)
  const purgeState = useSyncExternalStore(
    props.purgeController.subscribe,
    props.purgeController.snapshot,
    props.purgeController.snapshot,
  )
  const purgeDataChanging = purgeState.mutationPending
    || purgeState.status?.state === 'IN_PROGRESS'
    || purgeState.inProgressReceipt?.state === 'IN_PROGRESS'
  useEffect(() => {
    setAttention(undefined)
    setScopeGeneration(value => value + 1)
  }, [sessionId, workspaceId])
  const attentionEmpty = attention !== undefined
    && attention.actions.length === 0
    && attention.runtimeWarnings.length === 0
    && attention.projectCompleteness !== 'UNKNOWN'
    && attention.runtimeCompleteness !== 'UNKNOWN'
  const disclosure = (
    id: string,
    title: string,
    icon: ReactElement,
    content: ReactElement,
    collapsedContent?: ReactElement,
  ): ReactElement => createElement('section', { className: css.section, key: id },
    createElement(DisclosureRow, {
      icon,
      title,
      rowClassName: css.sectionHeader,
      titleClassName: css.sectionTitle,
      open: open.has(id),
      expandable: true,
      expandOnRowClick: true,
      collapsedContent,
      onToggle: () => {
        setOpen(previous => {
          const next = new Set(previous)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      },
    }, content),
  )
  return createElement('div', { ref: hostTab.ref, className: css.page, 'data-run2skill-settings-page': true },
    createElement('p', { className: css.intro }, 'Run2Skill 在后台自动沉淀经验；这里展示当前状态、需要处理的事项和持久设置。'),
    props.callLearningStatus === undefined ? null : disclosure('status', '整理状态', createElement(IconSparkle16),
      createElement(LearningStatusSection, {
        key: JSON.stringify([sessionId ?? null, workspaceId ?? null, scopeGeneration, purgeState.hostDataEpoch]),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(workspaceId === undefined ? {} : { workspaceId }),
        scopeGeneration,
        active: hostTab.visible && open.has('status') && !purgeDataChanging,
        call: props.callLearningStatus,
      })),
    disclosure('attention', '需要处理', createElement(IconWarningOutline16),
      createElement('div', { className: css.sectionBody },
        createElement(AttentionSettingsSummary, {
          active: hostTab.visible && open.has('attention'),
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(workspaceId === undefined ? {} : { workspaceId }),
          callAttention: props.callAttention,
          refreshGeneration: attentionRefresh,
          onProjection: setAttention,
        }),
        attention?.actions.some(action => ['REVIEW_PROPOSAL', 'REFRESH_PROPOSAL', 'RETRY_PUBLICATION'].includes(action.kind ?? '')) === true
          ? createElement(ProposalSettingsSection, {
              ...(workspaceId === undefined ? {} : { workspaceId }),
              callReview: props.callReview,
              active: hostTab.visible && open.has('attention'),
              actions: attention.actions,
              onMutationSettled: () => { setAttentionRefresh(value => value + 1) },
              scopeGeneration,
            })
          : null,
        createElement(LearningFailureSection, {
          ...(workspaceId === undefined ? {} : { workspaceId }),
          call: props.callReview,
          active: hostTab.visible && open.has('attention'),
          actions: attention?.actions ?? [],
          onMutationSettled: () => { setAttentionRefresh(value => value + 1) },
          scopeGeneration,
        }),
        attentionEmpty ? createElement('p', { className: css.empty }, '暂无') : null,
      )),
    disclosure('activity', '最近活动', createElement(IconSparkle16),
      createElement(RecentSkillActivitySection, {
        key: JSON.stringify([
          workspaceId ?? null,
          scopeGeneration,
          purgeState.hostDataEpoch,
          hostTab.visible && open.has('activity') && !purgeDataChanging,
        ]),
        ...(workspaceId === undefined ? {} : { workspaceId }),
        call: props.callActivity,
        active: hostTab.visible && open.has('activity') && !purgeDataChanging,
        scopeGeneration,
        hostDataEpoch: purgeState.hostDataEpoch,
      }), createElement(Pill, null, '最近 7 天')),
    disclosure('automatic', '自动学习', createElement(IconSettingsOutline16),
      createElement(AutomaticLearningSection, { controller: props.controller })),
    disclosure('purge', '缓存清理', createElement(IconTrashOutline16),
      createElement('div', { className: css.sectionBody },
        createElement(PurgeSettingsSection, {
          controller: props.purgeController,
          active: hostTab.visible && open.has('purge'),
          onCompleted: () => { setAttentionRefresh(value => value + 1) },
        }),
      )),
  )
}

export interface Run2skillClientContext {
  readonly connection: { readonly rpc: { call(
    channel: string, endpoint: string, payload: unknown, signal?: AbortSignal,
  ): Promise<unknown> } }
  readonly settingsScope: { bind<T>(spec: { readonly namespace: string }): ClientSettingsScope<T> }
  readonly sessions?: { readonly list: {
    getSnapshot(): { readonly current?: string }
    subscribe?(listener: () => void): () => void
  } }
  readonly workspaces: { readonly list: {
    getSnapshot(): { readonly items: readonly { readonly workspaceId: string; readonly sessionIds?: readonly string[] }[] }
    subscribe?(listener: () => void): () => void
  } }
  readonly slots: {
    inject(name: string, install: () => unknown): void
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  effect(install: () => (() => void), label?: string): void
}

function currentSessionId(context: Run2skillClientContext): string | undefined {
  return context.sessions?.list.getSnapshot().current
}

function workspaceFor(context: Run2skillClientContext, sessionId: string | undefined): string | undefined {
  if (sessionId === undefined) return undefined
  return context.workspaces.list.getSnapshot().items
    .find(workspace => workspace.sessionIds?.includes(sessionId))?.workspaceId
}

export function applyRun2skillClient(context: Run2skillClientContext): void {
  const controller = new AutomaticLearningSettingsController(
    context.settingsScope.bind<AutomaticLearningClientSettings>({ namespace: 'run2skill' }),
  )
  const callReview: ProposalReviewCall = async (endpoint, payload, signal) => await context.connection.rpc.call(
    RUN2SKILL_RPC_CHANNEL, endpoint, payload, signal,
  )
  const callAttention: AttentionCall = async (payload, signal) => await context.connection.rpc.call(
    RUN2SKILL_RPC_CHANNEL, 'attention', payload, signal,
  )
  const callActivity: RecentSkillActivityCall = async (payload, signal) => await context.connection.rpc.call(
    RUN2SKILL_RPC_CHANNEL, 'recent-activity/list', payload, signal,
  )
  const callLearningStatus: LearningStatusCall = async (endpoint, payload, signal) => await context.connection.rpc.call(
    RUN2SKILL_RPC_CHANNEL, endpoint, payload, signal,
  )
  const callPurge: PurgeCall = async (endpoint, payload, signal) => await context.connection.rpc.call(
    RUN2SKILL_RPC_CHANNEL, endpoint, payload, signal,
  )
  const purgeController = new PurgeSettingsController(callPurge, () => (
    workspaceFor(context, currentSessionId(context))
  ))
  context.effect(() => {
    const disposeStyle = acquireRun2skillStyle()
    return () => {
      controller.dispose()
      purgeController.dispose()
      disposeStyle()
    }
  }, 'run2skill: native settings surface')

  context.slots.inject('settings.plugins.tab', () => context.slots.register({
    name: 'settings.plugins.tab',
    id: 'run2skill',
    order: 20,
    label: 'Run2Skill',
    inject: () => ({
      controller,
      purgeController,
      workspaceId: workspaceFor(context, currentSessionId(context)),
      sessionId: currentSessionId(context),
      callAttention,
      callReview,
      callActivity,
      callLearningStatus,
    }),
  }, Run2skillSettingsPage))

  context.slots.inject('conversation.session.header.actions', () => context.slots.register({
    name: 'conversation.session.header.actions',
    id: 'run2skill-attention',
    order: 30,
    inject: () => ({
      callAttention,
    }),
  }, function HeaderAttention(props: {
    readonly sessionId: string
    readonly callAttention: AttentionCall
    readonly useWorkspaces: <T>(selector: (state: {
      readonly items: readonly { readonly workspaceId: string; readonly sessionIds?: readonly string[] }[]
    }) => T) => T
  }) {
    const workspaceId = props.useWorkspaces(state => state.items
      .find(workspace => workspace.sessionIds?.includes(props.sessionId))?.workspaceId)
    return createElement(Run2skillAttentionToast, {
      sessionId: props.sessionId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      callAttention: props.callAttention,
    })
  }))
}
