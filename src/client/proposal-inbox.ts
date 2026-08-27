import { createElement, type ReactElement } from 'react'
import css from './run2skill-settings-page.module.css'
import type { ExperienceRecordV1 } from '../domain/learn/index.js'
import type { EvidenceRef } from '../domain/observe/schemas.js'
import type { ProposalRefV1 } from '../domain/review/index.js'
import {
  parseMutationReceipt,
  parseProposalDetail,
  parseProposalList,
  parseProposalSummary,
} from './proposal-inbox-wire.js'

export const PROPOSAL_POLL_INTERVAL_MS = 10_000
export const PROPOSAL_ACTIVE_POLL_INTERVAL_MS = 2_000

const endpoint = {
  summary: 'summary',
  list: 'proposals/list',
  get: 'proposals/get',
  approve: 'proposals/approve',
  reject: 'proposals/reject',
  retry: 'proposals/retry',
  refresh: 'proposals/refresh',
  revise: 'proposals/revise',
  confirmDiscard: 'coverage/confirm-discard',
} as const

type HealthStatus = 'READY' | 'RECOVERING' | 'DEGRADED' | 'INCOMPATIBLE'
type ProcessingState = 'READY_FOR_REVIEW' | 'REVISING' | 'PUBLISHING' | 'NEEDS_ATTENTION' | 'TERMINAL'
type PublicationOutcome =
  | 'PENDING_REVIEW' | 'DISCARDED' | 'NEEDS_ATTENTION' | 'NEEDS_REFRESH' | 'PUBLISHED' | 'PUBLISH_FAILED'

export interface ProposalReviewSummary {
  readonly apiVersion: 1
  readonly status: HealthStatus
  readonly recoveryLag: boolean
  readonly lastHealthCode?: string | undefined
  readonly queue:
    | { readonly completeness: 'UNKNOWN' }
    | {
        readonly completeness: 'KNOWN'
        readonly pendingReview: number
        readonly publishing: number
        readonly needsAttention: number
      }
}

export interface ProposalListItem {
  readonly workItemId: string
  readonly workItemRevision: number
  readonly proposalRef: ProposalRefV1
  readonly kind: 'CREATE' | 'MERGE' | 'DISCARD'
  readonly name: string
  readonly description: string
  readonly persistenceScope: 'PROJECT' | 'USER'
  readonly createdAt: string
  readonly processingState: Exclude<ProcessingState, 'TERMINAL'>
  readonly publicationOutcome: Exclude<PublicationOutcome, 'DISCARDED' | 'PUBLISHED'>
}

export interface ProposalDetail {
  readonly apiVersion: 1
  readonly workItemId: string
  readonly workItemRevision: number
  readonly processingState: ProcessingState
  readonly reviewDecision: 'PENDING' | 'APPROVED' | 'REJECTED'
  readonly publicationOutcome: PublicationOutcome
  readonly proposal: SafeProposalDetail
  readonly sessionCoordinate: {
    readonly rootSessionId: string
    readonly sessionCreatedAt: number
    readonly turn: number
    readonly turnEndSeq: number
  }
  readonly evidenceRefs: readonly EvidenceRef[]
  readonly experiences: readonly ExperienceRecordV1[]
  readonly action?: ProposalAttentionAction
}

export interface ProposalAttentionAction {
  readonly actionKey: string
  readonly subjectId: string
  readonly kind: 'REVIEW_PROPOSAL' | 'REFRESH_PROPOSAL' | 'RETRY_PUBLICATION'
  readonly proposalRef: ProposalRefV1
}

export type ProposalMutation = 'APPROVE' | 'REJECT' | 'REFRESH' | 'RETRY' | 'CONFIRM_DISCARD'

export function describeProposalKind(kind: ProposalListItem['kind']): string {
  if (kind === 'CREATE') return '新建技能'
  if (kind === 'MERGE') return '更新已有技能'
  return '无需新建技能'
}

export function describePersistenceScope(scope: ProposalListItem['persistenceScope']): string {
  return scope === 'PROJECT' ? '仅当前项目可用' : '所有项目可用'
}

export function describeProposalScope(
  kind: ProposalListItem['kind'],
  scope: ProposalListItem['persistenceScope'],
): string {
  if (kind !== 'DISCARD') return describePersistenceScope(scope)
  return scope === 'PROJECT' ? '本次经验来自当前项目' : '本次经验适用于所有项目'
}

export function describeProposalOutcome(detail: Pick<ProposalDetail, 'processingState' | 'publicationOutcome'>): string {
  if (detail.processingState === 'REVISING') return '正在按修改意见生成新草稿'
  if (detail.publicationOutcome === 'PUBLISHED') return 'Skill 已保存，DSH 已确认可以使用'
  if (detail.publicationOutcome === 'DISCARDED') return '技能草稿已放弃，Skill 未更改'
  if (detail.publicationOutcome === 'NEEDS_REFRESH') return '保存目标已变化，需要生成新的技能草稿'
  if (detail.publicationOutcome === 'PUBLISH_FAILED') return '保存失败，可重试'
  if (detail.processingState === 'NEEDS_ATTENTION') return '需要处理后才能继续'
  if (detail.processingState === 'PUBLISHING') return '已确认，正在保存'
  return '待审核'
}

export function describeProposalListItem(item: Pick<
  ProposalListItem,
  'processingState' | 'publicationOutcome'
>): string {
  return describeProposalOutcome(item)
}

export function describeReviewDecision(decision: ProposalDetail['reviewDecision']): string {
  if (decision === 'APPROVED') return '已确认'
  if (decision === 'REJECTED') return '已放弃'
  return '待决定'
}

export function describeProcessingState(state: ProposalDetail['processingState']): string {
  if (state === 'REVISING') return '正在生成新草稿'
  if (state === 'PUBLISHING') return '正在保存'
  if (state === 'NEEDS_ATTENTION') return '需要处理'
  if (state === 'TERMINAL') return '已结束'
  return '待审核'
}

export function describePublicationOutcome(outcome: ProposalDetail['publicationOutcome']): string {
  if (outcome === 'PUBLISHED') return '已保存，DSH 已确认可以使用'
  if (outcome === 'DISCARDED') return '未修改 Skill，技能草稿已放弃'
  if (outcome === 'NEEDS_REFRESH') return '保存目标已变化，需要新的技能草稿'
  if (outcome === 'PUBLISH_FAILED') return '保存失败，可重试'
  if (outcome === 'NEEDS_ATTENTION') return '保存前需要先处理当前问题'
  return '尚未产生保存结果'
}

export interface ProposalInboxState {
  readonly open: boolean
  readonly summaryPhase: 'LOADING' | 'READY' | 'STALE' | 'UNAVAILABLE'
  readonly summary?: ProposalReviewSummary | undefined
  readonly listPhase: 'IDLE' | 'LOADING' | 'READY' | 'ERROR'
  readonly items: readonly ProposalListItem[]
  readonly selectedProposalId?: string | undefined
  readonly detailPhase: 'IDLE' | 'LOADING' | 'READY' | 'ERROR'
  readonly detail?: ProposalDetail | undefined
  readonly mutationPending: boolean
  readonly announcement: string
}

export interface ProposalPollEnvironment {
  isVisible(): boolean
  setInterval(callback: () => void, delayMs: number): unknown
  clearInterval(handle: unknown): void
  onFocus(listener: () => void): () => void
  onVisibilityChange(listener: () => void): () => void
  onOnline(listener: () => void): () => void
}

export type ProposalReviewCall = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<unknown>

export interface ProposalScopeAccess {
  readonly currentScope:
    | { readonly kind: 'USER_ONLY'; readonly generation: number }
    | { readonly kind: 'WORKSPACE'; readonly generation: number; readonly workspaceId: string }
  readonly actions: readonly {
    readonly actionKey: string
    readonly subjectId: string
    readonly kind: 'REVIEW_PROPOSAL' | 'REFRESH_PROPOSAL' | 'RETRY_PUBLICATION'
    readonly proposalRef: ProposalRefV1
  }[]
}

export interface SafeProposalDetail {
  readonly schemaVersion: 1
  readonly revision: number
  readonly createdAt: string
  readonly sourceLearningProposalId: string
  readonly kind: 'CREATE' | 'MERGE' | 'DISCARD'
  readonly name: string
  readonly description: string
  readonly whenToUse: string
  readonly invocation: { readonly modelInvocable: true; readonly userInvocable: false }
  readonly exactSkillBytes: string
  readonly skillBytesDigest: string
  readonly rendererVersion: string
  readonly persistenceScope: 'PROJECT' | 'USER'
  readonly workspaceBinding?: { readonly workspaceId: string }
  readonly dshHomeBinding?: { readonly resolutionKind: 'CONFIGURATION' | 'ENVIRONMENT' | 'DEFAULT'; readonly identityDigest: string }
  readonly supportingExperienceIds: readonly string[]
  readonly catalogObservationDigest: string
  readonly curationRationale: string
  readonly revisionParent?: {
    readonly proposalId: string
    readonly revision: number
    readonly digest: string
    readonly exactSkillBytes: string
  }
  readonly actionBinding?:
    | {
        readonly kind: 'CREATE'
        readonly rootBinding: SafeRootBinding
        readonly targetBinding: { readonly skillName: string }
        readonly expectedAbsence: { readonly observedAt: string }
      }
    | {
        readonly kind: 'MERGE'
        readonly rootBinding: SafeRootBinding
        readonly targetBinding: { readonly skillName: string }
        readonly baseBinding: {
          readonly candidateKey: string
          readonly exactBytes: string
          readonly bytesDigest: string
          readonly observedAt: string
        }
      }
    | {
        readonly kind: 'DISCARD'
        readonly coveringCandidateBinding: {
          readonly candidateKey: string
          readonly name: string
          readonly source: string
          readonly content: string
          readonly contentDigest: string
          readonly observedAt: string
        }
      }
  readonly proposalId: string
  readonly digest: string
}

interface SafeRootBinding {
  readonly state: 'EXISTING' | 'ABSENT'
  readonly scope: 'PROJECT' | 'USER'
  readonly expectedProvider: string
  readonly expectedSource: 'project-dsh' | 'user-dsh'
  readonly resolverVersion: string
  readonly rootContractVersion: string
  readonly resolutionContractDigest: string
}

function browserEnvironment(): ProposalPollEnvironment {
  return {
    isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
    clearInterval: handle => { globalThis.clearInterval(handle as ReturnType<typeof setInterval>) },
    onFocus: listener => {
      if (typeof window === 'undefined') return () => undefined
      window.addEventListener('focus', listener)
      return () => { window.removeEventListener('focus', listener) }
    },
    onVisibilityChange: listener => {
      if (typeof document === 'undefined') return () => undefined
      document.addEventListener('visibilitychange', listener)
      return () => { document.removeEventListener('visibilitychange', listener) }
    },
    onOnline: listener => {
      if (typeof window === 'undefined') return () => undefined
      window.addEventListener('online', listener)
      return () => { window.removeEventListener('online', listener) }
    },
  }
}

const initialState: ProposalInboxState = {
  open: false,
  summaryPhase: 'LOADING',
  listPhase: 'IDLE',
  items: [],
  detailPhase: 'IDLE',
  mutationPending: false,
  announcement: '',
}

export class ProposalInboxController {
  readonly #listeners = new Set<() => void>()
  #state: ProposalInboxState = initialState
  #started = false
  #active = true
  #disposed = false
  #pending: Promise<void> | undefined
  #abort: AbortController | undefined
  #timer: unknown
  #timerDelay: number | undefined
  #removeFocus: (() => void) | undefined
  #removeVisibility: (() => void) | undefined
  #removeOnline: (() => void) | undefined
  #revisionAttempt: { readonly feedback: string; readonly actionId: string } | undefined

  constructor(
    private readonly workspaceId: string,
    private readonly call: ProposalReviewCall,
    private readonly environment: ProposalPollEnvironment = browserEnvironment(),
    private readonly options: {
      readonly attentionDriven?: boolean
      readonly scopeAccess?: () => ProposalScopeAccess
    } = {},
  ) {}

  snapshot = (): ProposalInboxState => this.#state

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  start(): void {
    if (this.#started || this.#disposed) return
    this.#started = true
    const refresh = () => { if (this.#active && this.environment.isVisible()) void this.#refreshVisible() }
    this.#removeFocus = this.environment.onFocus(refresh)
    this.#removeOnline = this.environment.onOnline(refresh)
    this.#removeVisibility = this.environment.onVisibilityChange(() => {
      if (this.#active && this.environment.isVisible()) {
        this.#schedule()
        void this.#refreshVisible()
      } else {
        this.#unschedule()
      }
    })
    if (this.#active && this.environment.isVisible()) {
      this.#schedule()
      void this.#refreshVisible()
    }
  }

  pause(): void {
    if (this.#disposed || !this.#active) return
    this.#active = false
    this.#unschedule()
    this.#abort?.abort()
  }

  resume(): void {
    if (this.#disposed || this.#active) return
    this.#active = true
    if (!this.#started || !this.environment.isVisible()) return
    this.#schedule()
    void this.whenIdle().then(() => {
      if (this.#active && !this.#disposed) void this.#refreshVisible()
    })
  }

  whenIdle(): Promise<void> {
    return this.#pending ?? Promise.resolve()
  }

  async open(): Promise<void> {
    if (this.#disposed) return
    this.#publish({ ...this.#state, open: true })
    await this.whenIdle()
    if (this.#disposed || !this.#state.open) return
    if (this.options.attentionDriven === true && this.#scopeAccess().actions.length === 0) {
      this.#publish({
        ...this.#state,
        listPhase: 'READY',
        items: [],
        selectedProposalId: undefined,
        detailPhase: 'IDLE',
        detail: undefined,
      })
      return
    }
    await this.#loadList()
  }

  close(): void {
    if (this.#disposed) return
    this.#publish({ ...this.#state, open: false })
  }

  async select(proposalId: string): Promise<void> {
    if (this.#disposed || !/^prop_[a-f0-9]{64}$/.test(proposalId)) return
    await this.whenIdle()
    if (this.#disposed || !this.#state.open) return
    await this.#execute(async signal => {
      this.#publish({
        ...this.#state,
        selectedProposalId: proposalId,
        detailPhase: 'LOADING',
        detail: undefined,
        announcement: '',
      })
      const scopeAccess = this.#scopeAccess()
      const action = scopeAccess.actions.find(candidate => candidate.proposalRef.proposalId === proposalId)
      if (action === undefined) throw new Error('proposal action is stale')
      const detail = parseProposalDetail(await this.call(endpoint.get, {
        apiVersion: 1, proposalId, currentScope: scopeAccess.currentScope, action,
      }, signal))
      if (detail === undefined) throw new Error('invalid detail response')
      this.#publish({
        ...this.#state,
        detailPhase: 'READY',
        detail,
        announcement: describeProposalOutcome(detail),
      })
    }, () => {
      this.#publish({ ...this.#state, detailPhase: 'ERROR', detail: undefined })
    })
  }

  async mutate(action: ProposalMutation): Promise<void> {
    await this.whenIdle()
    const detail = this.#state.detail
    if (this.#disposed || detail === undefined || this.#state.mutationPending) return
    const proposalRef: ProposalRefV1 = detail.action?.proposalRef ?? {
      proposalId: detail.proposal.proposalId,
      revision: detail.proposal.revision,
      digest: detail.proposal.digest,
    }
    const targetEndpoint = action === 'APPROVE'
      ? endpoint.approve
      : action === 'REJECT'
        ? endpoint.reject
        : action === 'REFRESH'
          ? endpoint.refresh
          : action === 'RETRY'
            ? endpoint.retry
            : endpoint.confirmDiscard
    const request = {
      apiVersion: 1 as const,
      workItemId: detail.workItemId,
      workItemRevision: detail.workItemRevision,
      proposalRef,
      currentScope: this.#scopeAccess().currentScope,
      action: detail.action
        ?? this.#scopeAccess().actions.find(candidate => candidate.proposalRef.proposalId === proposalRef.proposalId),
      ...(action === 'REJECT' ? { confirm: true as const } : {}),
    }
    await this.#execute(async signal => {
      if (request.action === undefined) throw new Error('proposal action is stale')
      this.#publish({ ...this.#state, mutationPending: true, announcement: '' })
      const receipt = parseMutationReceipt(await this.call(targetEndpoint, request, signal))
      if (receipt === undefined) throw new Error('invalid mutation receipt')
      const announcement = describeProposalOutcome(receipt) || '技能草稿状态已更新'
      this.#publish({
        ...this.#state,
        mutationPending: false,
        announcement,
        detail: {
          ...detail,
          workItemRevision: receipt.workItemRevision,
          processingState: receipt.processingState,
          reviewDecision: receipt.reviewDecision,
          publicationOutcome: receipt.publicationOutcome,
        },
      })
      try {
        await this.#refreshWithin(signal)
      } catch {
        if (!this.#disposed && !signal.aborted) this.#publish({
          ...this.#state,
          summaryPhase: this.#state.summary === undefined ? 'UNAVAILABLE' : 'STALE',
          listPhase: this.#state.listPhase === 'LOADING' ? 'ERROR' : this.#state.listPhase,
        })
      }
    }, () => {
      this.#publish({
        ...this.#state,
        mutationPending: false,
        announcement: '操作未完成，请刷新后重试',
      })
    })
  }

  async revise(feedback: string): Promise<void> {
    await this.whenIdle()
    const detail = this.#state.detail
    const normalized = feedback.normalize('NFKC').trim()
    if (
      this.#disposed
      || detail === undefined
      || this.#state.mutationPending
      || normalized.length === 0
      || new TextEncoder().encode(normalized).byteLength > 2_048
    ) return
    const proposalRef: ProposalRefV1 = detail.action?.proposalRef ?? {
      proposalId: detail.proposal.proposalId,
      revision: detail.proposal.revision,
      digest: detail.proposal.digest,
    }
    const action = this.#scopeAccess().actions.find(candidate => (
      candidate.proposalRef.proposalId === proposalRef.proposalId
    )) ?? detail.action
    if (action === undefined) return
    const attempt = this.#revisionAttempt?.feedback === normalized
      ? this.#revisionAttempt
      : { feedback: normalized, actionId: createRevisionActionId() }
    this.#revisionAttempt = attempt
    await this.#execute(async signal => {
      this.#publish({ ...this.#state, mutationPending: true, announcement: '正在按修改意见生成新草稿…' })
      const raw = await this.call(endpoint.revise, {
        apiVersion: 1,
        workItemId: detail.workItemId,
        workItemRevision: detail.workItemRevision,
        proposalRef,
        currentScope: this.#scopeAccess().currentScope,
        action,
        actionId: attempt.actionId,
        feedback: normalized,
      }, signal)
      const receipt = parseMutationReceipt(raw)
      if (receipt === undefined) {
        if (raw !== null && typeof raw === 'object' && 'ok' in raw && raw.ok === false) {
          this.#revisionAttempt = undefined
        }
        throw new Error('invalid revision receipt')
      }
      this.#revisionAttempt = undefined
      this.#publish({
        ...this.#state,
        mutationPending: false,
        selectedProposalId: receipt.proposalRef.proposalId,
        detailPhase: 'LOADING',
        detail: undefined,
        announcement: '已生成新草稿，请重新审核',
      })
      await this.#loadListWithin(signal)
    }, () => {
      this.#publish({
        ...this.#state,
        mutationPending: false,
        detailPhase: 'ERROR',
        detail: undefined,
        announcement: '修改未完成，原草稿未被替换；请重新打开后重试',
      })
    })
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#unschedule()
    this.#removeFocus?.()
    this.#removeVisibility?.()
    this.#removeOnline?.()
    this.#removeFocus = undefined
    this.#removeVisibility = undefined
    this.#removeOnline = undefined
    this.#abort?.abort()
    this.#listeners.clear()
  }

  async #refreshVisible(): Promise<void> {
    if (this.#disposed || !this.#active || !this.environment.isVisible()) return
    await this.#execute(async signal => { await this.#refreshWithin(signal) }, () => {
      this.#publish({
        ...this.#state,
        summaryPhase: this.#state.summary === undefined ? 'UNAVAILABLE' : 'STALE',
      })
    })
  }

  async #refreshWithin(signal: AbortSignal): Promise<void> {
    if (this.options.attentionDriven === true) {
      if (!this.#state.open) return
      if (this.#scopeAccess().actions.length === 0) {
        this.#publish({
          ...this.#state,
          listPhase: 'READY',
          items: [],
          selectedProposalId: undefined,
          detailPhase: 'IDLE',
          detail: undefined,
        })
        return
      }
      await this.#loadListWithin(signal)
      await this.#refreshPublishingDetailWithin(signal)
      return
    }
    const summary = parseProposalSummary(await this.call(
      endpoint.summary,
      { apiVersion: 1, workspaceId: this.workspaceId },
      signal,
    ))
    if (summary === undefined) throw new Error('invalid summary response')
    this.#publish({ ...this.#state, summaryPhase: 'READY', summary })
    if (!this.#state.open) return
    await this.#loadListWithin(signal)
    await this.#refreshPublishingDetailWithin(signal)
  }

  async #refreshPublishingDetailWithin(signal: AbortSignal): Promise<void> {
    const selected = this.#state.selectedProposalId
    if (selected !== undefined && ['PUBLISHING', 'REVISING'].includes(this.#state.detail?.processingState ?? '')) {
      const scopeAccess = this.#scopeAccess()
      const action = scopeAccess.actions.find(candidate => candidate.proposalRef.proposalId === selected)
      if (action === undefined) return
      const detail = parseProposalDetail(await this.call(endpoint.get, {
        apiVersion: 1, proposalId: selected, currentScope: scopeAccess.currentScope, action,
      }, signal))
      if (detail !== undefined) this.#publish({
        ...this.#state,
        detailPhase: 'READY',
        detail,
        announcement: describeProposalOutcome(detail) || this.#state.announcement,
      })
    }
  }

  async #loadList(): Promise<void> {
    await this.#execute(async signal => { await this.#loadListWithin(signal) }, () => {
      this.#publish({ ...this.#state, listPhase: 'ERROR' })
    })
  }

  async #loadListWithin(signal: AbortSignal): Promise<void> {
    if (this.#state.listPhase !== 'READY') {
      this.#publish({ ...this.#state, listPhase: 'LOADING' })
    }
    const items: ProposalListItem[] = []
    let cursor: string | undefined
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page = parseProposalList(await this.call(endpoint.list, {
        apiVersion: 1,
        currentScope: this.#scopeAccess().currentScope,
        limit: 20,
        ...(cursor === undefined ? {} : { cursor }),
      }, signal))
      if (page === undefined) throw new Error('invalid list response')
      items.push(...page.items)
      cursor = page.nextCursor
      if (cursor === undefined) {
        this.#publish({ ...this.#state, listPhase: 'READY', items })
        return
      }
    }
    throw new Error('proposal list page limit exceeded')
  }

  async #execute(
    task: (signal: AbortSignal) => Promise<void>,
    onError: () => void,
  ): Promise<void> {
    if (this.#disposed || this.#pending !== undefined) return this.#pending ?? Promise.resolve()
    const abort = new AbortController()
    this.#abort = abort
    const pending = (async () => {
      try {
        await task(abort.signal)
      } catch {
        if (!this.#disposed && !abort.signal.aborted) onError()
      }
    })()
    this.#pending = pending
    await pending.finally(() => {
      if (this.#pending === pending) this.#pending = undefined
      if (this.#abort === abort) this.#abort = undefined
    })
  }

  #schedule(): void {
    if (this.#disposed || !this.#active) return
    const hasVisibleWork = this.options.attentionDriven !== true || this.#scopeAccess().actions.length > 0
    const delay = this.#state.open && hasVisibleWork
      ? PROPOSAL_ACTIVE_POLL_INTERVAL_MS
      : PROPOSAL_POLL_INTERVAL_MS
    if (this.#timer !== undefined && this.#timerDelay === delay) return
    this.#unschedule()
    this.#timerDelay = delay
    this.#timer = this.environment.setInterval(() => { void this.#refreshVisible() }, delay)
  }

  #unschedule(): void {
    if (this.#timer === undefined) return
    this.environment.clearInterval(this.#timer)
    this.#timer = undefined
    this.#timerDelay = undefined
  }

  #publish(state: ProposalInboxState): void {
    if (this.#disposed) return
    this.#state = state
    if (this.#started && this.#active && this.environment.isVisible()) this.#schedule()
    for (const listener of this.#listeners) listener()
  }

  #scopeAccess(): ProposalScopeAccess {
    return this.options.scopeAccess?.() ?? {
      currentScope: { kind: 'WORKSPACE', generation: 1, workspaceId: this.workspaceId },
      actions: [],
    }
  }
}

function createRevisionActionId(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return `rev_${Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')}`
}

const formatCharacters = new Map<number, string>([
  [0x0000, 'NULL'],
  [0x0009, 'CHARACTER TABULATION'],
  [0x061c, 'ARABIC LETTER MARK'],
  [0x200b, 'ZERO WIDTH SPACE'],
  [0x200c, 'ZERO WIDTH NON-JOINER'],
  [0x200d, 'ZERO WIDTH JOINER'],
  [0x200e, 'LEFT-TO-RIGHT MARK'],
  [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
  [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'POP DIRECTIONAL FORMATTING'],
  [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'],
  [0x2060, 'WORD JOINER'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
  [0x2068, 'FIRST STRONG ISOLATE'],
  [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE'],
])

export function makeSafeText(value: string): string {
  let result = ''
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (character === '\n') {
      result += character
      continue
    }
    const name = formatCharacters.get(codePoint)
      ?? (/\p{Cf}/u.test(character)
        ? 'FORMAT'
        : codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)
          ? 'CONTROL'
          : undefined)
    result += name === undefined
      ? character
      : `[U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} ${name}]`
  }
  return result
}

export function ProposalTextView(props: {
  readonly value: string
  readonly mode: 'SAFE' | 'RAW'
  readonly label: string
}): ReactElement {
  return createElement('pre', {
    'aria-label': props.label,
    'data-run2skill-text-mode': props.mode,
    className: css.textBlock,
  }, props.mode === 'SAFE' ? makeSafeText(props.value) : props.value)
}

export interface ExactDiffLine {
  readonly kind: 'CONTEXT' | 'REMOVE' | 'ADD'
  readonly text: string
}

export function makeExactLineDiff(before: string, after: string): ExactDiffLine[] {
  const left = before.split('\n')
  const right = after.split('\n')
  if (left.length * right.length > 250_000) {
    return [
      ...left.map(text => ({ kind: 'REMOVE' as const, text })),
      ...right.map(text => ({ kind: 'ADD' as const, text })),
    ]
  }
  const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1))
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      table[leftIndex]![rightIndex] = left[leftIndex] === right[rightIndex]
        ? table[leftIndex + 1]![rightIndex + 1]! + 1
        : Math.max(table[leftIndex + 1]![rightIndex]!, table[leftIndex]![rightIndex + 1]!)
    }
  }
  const result: ExactDiffLine[] = []
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length || rightIndex < right.length) {
    if (leftIndex < left.length && rightIndex < right.length && left[leftIndex] === right[rightIndex]) {
      result.push({ kind: 'CONTEXT', text: left[leftIndex]! })
      leftIndex += 1
      rightIndex += 1
    } else if (
      leftIndex < left.length
      && (rightIndex >= right.length || table[leftIndex + 1]![rightIndex]! >= table[leftIndex]![rightIndex + 1]!)
    ) {
      result.push({ kind: 'REMOVE', text: left[leftIndex]! })
      leftIndex += 1
    } else {
      result.push({ kind: 'ADD', text: right[rightIndex]! })
      rightIndex += 1
    }
  }
  return result
}
