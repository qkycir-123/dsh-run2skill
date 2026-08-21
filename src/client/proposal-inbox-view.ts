import {
  Fragment,
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type RefObject,
} from 'react'
import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  ProposalInboxController,
  ProposalTextView,
  describeProposalListItem,
  describeProcessingState,
  describePublicationOutcome,
  describeReviewDecision,
  makeExactLineDiff,
  makeSafeText,
  type ProposalDetail,
  type ProposalInboxState,
  type ProposalReviewCall,
  type ProposalScopeAccess,
} from './proposal-inbox.js'
import { focusableSelector, trapDialogTab } from './dialog-focus.js'
import { describeRun2skillHealth } from './status-copy.js'
import css from './run2skill-settings-page.module.css'
export { trapDialogTab } from './dialog-focus.js'

export function proposalInboxContentBlocked(mutationPending: boolean, rejectConfirm: boolean): boolean {
  return mutationPending || rejectConfirm
}

function useDialogFocus(
  open: boolean,
  triggerRef: RefObject<HTMLButtonElement | null>,
  dialogRef: RefObject<HTMLDivElement | null>,
  focusTrapSuspended: RefObject<boolean>,
): void {
  useEffect(() => {
    if (!open) return
    if (typeof document === 'undefined') return
    const dialog = dialogRef.current
    const initial = dialog?.querySelector<HTMLElement>('[data-initial-focus]')
      ?? dialog?.querySelector<HTMLElement>(focusableSelector)
    const recapture = (event: FocusEvent) => {
      if (focusTrapSuspended.current) return
      if (dialog !== null && event.target instanceof Node && !dialog.contains(event.target)) initial?.focus()
    }
    document.addEventListener('focusin', recapture, true)
    initial?.focus()
    return () => {
      document.removeEventListener('focusin', recapture, true)
      triggerRef.current?.focus()
    }
  }, [dialogRef, focusTrapSuspended, open, triggerRef])
}

function countLabel(state: ProposalInboxState): string {
  const queue = state.summary?.queue
  if (queue === undefined || queue.completeness === 'UNKNOWN') return 'Skill 提案，待处理数量未知'
  const total = queue.pendingReview + queue.publishing + queue.needsAttention
  const facts = [
    queue.pendingReview > 0 ? `${String(queue.pendingReview)} 条待审核` : undefined,
    queue.publishing > 0 ? `${String(queue.publishing)} 条正在发布` : undefined,
    queue.needsAttention > 0 ? `${String(queue.needsAttention)} 条需要处理` : undefined,
  ].filter(fact => fact !== undefined)
  return facts.length === 0
    ? '当前没有待处理 Skill 提案'
    : `${String(total)} 条 Skill 提案待处理：${facts.join('，')}`
}

export function describeProposalSummaryState(state: ProposalInboxState): string {
  if (state.summaryPhase === 'LOADING') return 'Proposal 队列状态加载中'
  if (state.summaryPhase === 'UNAVAILABLE') return 'Proposal 队列状态暂不可用'
  if (state.summary === undefined) return 'Proposal 队列状态未知'
  const health = describeRun2skillHealth(state.summary.status)
  const queue = state.summary.queue.completeness === 'UNKNOWN'
    ? '待处理数量未知'
    : countLabel(state)
  return state.summaryPhase === 'STALE'
    ? `Proposal 队列状态可能已过期：${health}；${queue}`
    : `${health}；${queue}`
}

export function ProposalInboxHeaderAction(props: {
  readonly workspaceId: string
  readonly callReview: ProposalReviewCall
  readonly scopeAccess?: () => ProposalScopeAccess
}): ReactElement {
  const controller = useMemo(
    () => new ProposalInboxController(
      props.workspaceId,
      props.callReview,
      undefined,
      props.scopeAccess === undefined ? {} : { scopeAccess: props.scopeAccess },
    ),
    [props.scopeAccess, props.callReview, props.workspaceId],
  )
  useEffect(() => {
    controller.start()
    return () => { controller.dispose() }
  }, [controller])
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const [textMode, setTextMode] = useState<'SAFE' | 'RAW'>('SAFE')
  const [rejectConfirm, setRejectConfirm] = useState(false)
  const focusTrapSuspended = useRef(false)
  focusTrapSuspended.current = rejectConfirm
  useDialogFocus(state.open, triggerRef, dialogRef, focusTrapSuspended)
  const label = countLabel(state)

  return createElement(Fragment, null,
    createElement('button', {
      ref: triggerRef,
      type: 'button',
      'aria-label': label,
      'aria-haspopup': 'dialog',
      'aria-expanded': state.open,
      'data-run2skill-proposal-trigger': true,
      onClick: () => { void controller.open() },
    }, label),
    state.open
      ? createElement(ProposalInboxPanel, {
          controller,
          state,
          dialogRef,
          textMode,
          setTextMode,
          rejectConfirm,
          setRejectConfirm,
        })
      : null,
  )
}

function closeOnKeyboard(
  event: ReactKeyboardEvent<HTMLDivElement>,
  controller: ProposalInboxController,
  dialog: HTMLDivElement | null,
): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    controller.close()
  } else if (dialog !== null) {
    trapDialogTab(
      event.key,
      event.shiftKey,
      () => { event.preventDefault() },
      dialog,
      typeof document === 'undefined' ? undefined : document.activeElement,
    )
  }
}

export function ProposalInboxPanel(props: {
  readonly controller: ProposalInboxController
  readonly state: ProposalInboxState
  readonly dialogRef: RefObject<HTMLDivElement | null>
  readonly textMode: 'SAFE' | 'RAW'
  readonly setTextMode: (mode: 'SAFE' | 'RAW') => void
  readonly rejectConfirm: boolean
  readonly setRejectConfirm: (value: boolean) => void
}): ReactElement {
  const { controller, state } = props
  const contentBlocked = proposalInboxContentBlocked(state.mutationPending, props.rejectConfirm)
  return createElement(Fragment, null,
  createElement('div', {
    'aria-hidden': true,
    'data-run2skill-proposal-backdrop': true,
    className: css.backdrop,
  }),
  createElement('div', {
    ref: props.dialogRef,
    role: 'dialog',
    'aria-modal': true,
    'aria-labelledby': 'run2skill-proposal-inbox-title',
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
      closeOnKeyboard(event, controller, props.dialogRef.current)
    },
    className: css.legacyDialog,
  },
  createElement('div', {
    'aria-hidden': props.rejectConfirm || undefined,
    inert: props.rejectConfirm ? '' : undefined,
    className: props.rejectConfirm ? css.blocked : undefined,
  },
  createElement('section', { 'aria-label': 'Proposal 待处理队列', className: css.queue },
    createElement('div', { className: css.legacyHeader },
      createElement('h2', { id: 'run2skill-proposal-inbox-title' }, 'Skill Proposal Inbox'),
      createElement('button', {
        type: 'button',
        'data-initial-focus': true,
        onClick: () => { controller.close() },
      }, '关闭'),
    ),
    createElement('p', { role: 'status' }, countLabel(state)),
    createElement('p', { role: 'status', 'aria-live': 'polite' }, describeProposalSummaryState(state)),
    state.listPhase === 'LOADING' ? createElement('p', null, '正在加载待处理队列…') : null,
    state.listPhase === 'ERROR' ? createElement('p', { role: 'alert' }, '待处理队列暂不可用') : null,
    state.listPhase === 'READY' && state.items.length === 0
      ? createElement('p', null, '当前没有待处理 Proposal')
      : null,
    createElement('ul', { className: css.legacyList },
      ...state.items.map(item => createElement('li', { key: item.proposalRef.proposalId },
        createElement('button', {
          type: 'button',
          disabled: contentBlocked || state.detailPhase === 'LOADING',
          'aria-current': state.selectedProposalId === item.proposalRef.proposalId ? 'true' : undefined,
          onClick: () => { void controller.select(item.proposalRef.proposalId) },
          className: css.proposalListButton,
        }, `${item.kind} · ${makeSafeText(item.name)} · ${item.persistenceScope} · ${describeProposalListItem(item)}`),
      )),
    ),
  ),
  createElement('section', { 'aria-label': 'Proposal 详情', className: css.legacyDetail },
    state.detailPhase === 'IDLE' ? createElement('p', null, '选择一个 Proposal 查看完整事实') : null,
    state.detailPhase === 'LOADING' ? createElement('p', null, '正在加载 Proposal 详情…') : null,
    state.detailPhase === 'ERROR' ? createElement('p', { role: 'alert' }, 'Proposal 详情暂不可用') : null,
    state.detail === undefined ? null : createElement(ProposalDetailView, {
      detail: state.detail,
      textMode: props.textMode,
      setTextMode: props.setTextMode,
      mutationPending: contentBlocked,
      onApprove: () => { void controller.mutate('APPROVE') },
      onReject: () => { props.setRejectConfirm(true) },
      onRetry: () => { void controller.mutate('RETRY') },
      onConfirmDiscard: () => { void controller.mutate('CONFIRM_DISCARD') },
    }),
    createElement('div', { 'aria-live': 'polite', 'aria-atomic': true }, state.announcement),
  ),
  ),
  props.rejectConfirm
    ? createElement(RejectConfirmation, {
        disabled: state.mutationPending,
        onCancel: () => { props.setRejectConfirm(false) },
        onConfirm: () => {
          props.setRejectConfirm(false)
          void controller.mutate('REJECT')
        },
      })
    : null,
  ),
  )
}

export function factsFromAction(detail: ProposalDetail): string {
  const action = detail.proposal.actionBinding
  if (action.kind === 'CREATE') {
    return [
      `Root contract: ${action.rootBinding.rootContractVersion}`,
      `Root resolver: ${action.rootBinding.resolverVersion}`,
      `Expected provider/source: ${action.rootBinding.expectedProvider} / ${action.rootBinding.expectedSource}`,
      `Resolution digest: ${action.rootBinding.resolutionContractDigest}`,
      `Root state: ${action.rootBinding.state}`,
      `Skill name: ${action.targetBinding.skillName}`,
      `Skill bytes digest: ${detail.proposal.skillBytesDigest}`,
      `Expected absence observed: ${action.expectedAbsence.observedAt}`,
      'Bundle absent: yes',
      'Skill file absent: yes',
      'Flat Skill file absent: yes',
    ].join('\n')
  }
  if (action.kind === 'MERGE') {
    return [
      `Root contract: ${action.rootBinding.rootContractVersion}`,
      `Root resolver: ${action.rootBinding.resolverVersion}`,
      `Expected provider/source: ${action.rootBinding.expectedProvider} / ${action.rootBinding.expectedSource}`,
      `Resolution digest: ${action.rootBinding.resolutionContractDigest}`,
      `Root state: ${action.rootBinding.state}`,
      `Target identity: ${action.baseBinding.candidateKey}`,
      `Skill name: ${action.targetBinding.skillName}`,
      `Base digest: ${action.baseBinding.bytesDigest}`,
      `Base observed: ${action.baseBinding.observedAt}`,
    ].join('\n')
  }
  return [
    `Covering candidate: ${action.coveringCandidateBinding.candidateKey}`,
    `Name: ${action.coveringCandidateBinding.name}`,
    `Source: ${action.coveringCandidateBinding.source}`,
    `Digest: ${action.coveringCandidateBinding.contentDigest}`,
    `Observed: ${action.coveringCandidateBinding.observedAt}`,
  ].join('\n')
}

export function proposalDetailAction(
  detail: Pick<ProposalDetail, 'reviewDecision' | 'processingState' | 'publicationOutcome'>,
  mutationPending: boolean,
): 'REVIEW' | 'RETRY_PUBLICATION' | 'NONE' {
  if (mutationPending) return 'NONE'
  if (
    detail.reviewDecision === 'PENDING'
    && detail.processingState === 'READY_FOR_REVIEW'
    && detail.publicationOutcome === 'PENDING_REVIEW'
  ) return 'REVIEW'
  if (
    detail.reviewDecision === 'APPROVED'
    && detail.processingState === 'NEEDS_ATTENTION'
    && detail.publicationOutcome === 'PUBLISH_FAILED'
  ) return 'RETRY_PUBLICATION'
  return 'NONE'
}

export function ProposalDetailView(props: {
  readonly detail: ProposalDetail
  readonly textMode: 'SAFE' | 'RAW'
  readonly setTextMode: (mode: 'SAFE' | 'RAW') => void
  readonly mutationPending: boolean
  readonly onApprove: () => void
  readonly onReject: (trigger?: HTMLButtonElement) => void
  readonly onRetry: () => void
  readonly onConfirmDiscard: () => void
}): ReactElement {
  const { detail, mutationPending } = props
  const proposal = detail.proposal
  const action = proposalDetailAction(detail, mutationPending)
  const actionable = action === 'REVIEW'
  const coordinate = detail.sessionCoordinate
  const baseBytes = proposal.actionBinding.kind === 'MERGE'
    ? proposal.actionBinding.baseBinding.exactBytes
    : undefined
  const coveringBytes = proposal.actionBinding.kind === 'DISCARD'
    ? proposal.actionBinding.coveringCandidateBinding.content
    : undefined
  const diff = baseBytes === undefined ? [] : makeExactLineDiff(baseBytes, proposal.exactSkillBytes)

  return createElement(Fragment, null,
    createElement('h3', null, `${proposal.kind}: ${makeSafeText(proposal.name)}`),
    createElement('dl', null,
      createElement('dt', null, '说明'), createElement('dd', null, makeSafeText(proposal.description)),
      createElement('dt', null, '何时使用'), createElement('dd', null, makeSafeText(proposal.whenToUse)),
      createElement('dt', null, 'Scope'), createElement('dd', null, proposal.persistenceScope),
      createElement('dt', null, 'Proposal revision'), createElement('dd', null, String(proposal.revision)),
      createElement('dt', null, 'Proposal digest'), createElement('dd', null, proposal.digest),
      createElement('dt', null, 'Session / Turn'),
      createElement('dd', null, `${coordinate.rootSessionId} / ${String(coordinate.turn)} / seq ${String(coordinate.turnEndSeq)}`),
      proposal.workspaceBinding === undefined
        ? null
        : createElement(Fragment, null,
            createElement('dt', null, 'Workspace'),
            createElement('dd', null, `PROJECT · ${proposal.workspaceBinding.workspaceId}`),
          ),
      proposal.dshHomeBinding === undefined
        ? null
        : createElement(Fragment, null,
            createElement('dt', null, 'DSH Home'),
            createElement('dd', null, `USER · ${proposal.dshHomeBinding.resolutionKind}`),
            createElement('dt', null, 'DSH Home identity'),
            createElement('dd', null, proposal.dshHomeBinding.identityDigest),
          ),
      createElement('dt', null, '审核决定'),
      createElement('dd', null, describeReviewDecision(detail.reviewDecision)),
      createElement('dt', null, '处理状态'),
      createElement('dd', null, describeProcessingState(detail.processingState)),
      createElement('dt', null, '发布结果'),
      createElement('dd', null, describePublicationOutcome(detail.publicationOutcome)),
    ),
    createElement('h4', null, 'Why learned'),
    createElement('p', null, makeSafeText(proposal.curationRationale)),
    ...detail.experiences.map(experience => createElement('article', { key: experience.experienceId },
      createElement('strong', null, `${experience.type} · ${experience.evidenceStrength}`),
      createElement('p', null, makeSafeText(experience.lesson)),
    )),
    createElement('h4', null, '过滤后的 Evidence'),
    ...detail.evidenceRefs.map(evidence => createElement('article', { key: `${String(evidence.messageSeq)}:${evidence.excerptDigest}` },
      createElement('strong', null, `message seq ${String(evidence.messageSeq)}${evidence.truncated ? ' · 已截断' : ''}`),
      createElement(ProposalTextView, {
        value: evidence.excerpt,
        mode: 'SAFE',
        label: `Evidence ${String(evidence.messageSeq)}`,
      }),
    )),
    createElement('h4', null, '绑定事实'),
    createElement(ProposalTextView, { value: factsFromAction(detail), mode: 'SAFE', label: '绑定事实' }),
    createElement('div', { role: 'group', 'aria-label': '内容显示方式', className: css.modeGroup },
      createElement(Pill, {
        'aria-pressed': props.textMode === 'SAFE',
        active: props.textMode === 'SAFE',
        onClick: () => { props.setTextMode('SAFE') },
      }, '安全视图'),
      createElement(Pill, {
        'aria-pressed': props.textMode === 'RAW',
        active: props.textMode === 'RAW',
        onClick: () => { props.setTextMode('RAW') },
      }, '原始内容'),
    ),
    createElement('h4', null, '将要批准的完整 SKILL.md'),
    createElement(ProposalTextView, {
      value: proposal.exactSkillBytes,
      mode: props.textMode,
      label: '将要批准的完整 SKILL.md',
    }),
    baseBytes === undefined ? null : createElement(Fragment, null,
      createElement('h4', null, 'MERGE Base'),
      createElement(ProposalTextView, { value: baseBytes, mode: props.textMode, label: 'MERGE Base' }),
      createElement('h4', null, '精确 Diff'),
      createElement('pre', { 'aria-label': '精确 Diff' },
        diff.map(line => `${line.kind === 'ADD' ? '+' : line.kind === 'REMOVE' ? '-' : ' '} ${makeSafeText(line.text)}`).join('\n'),
      ),
    ),
    coveringBytes === undefined ? null : createElement(Fragment, null,
      createElement('h4', null, '覆盖已有 Skill 的完整内容'),
      createElement(ProposalTextView, { value: coveringBytes, mode: props.textMode, label: '覆盖已有 Skill 的完整内容' }),
    ),
    createElement('div', { role: 'group', 'aria-label': 'Proposal 操作', className: css.actions },
      action === 'RETRY_PUBLICATION'
        ? createElement(Button, {
            variant: 'primary', disabled: mutationPending, onClick: props.onRetry,
          }, '重试发布')
        : proposal.kind === 'DISCARD'
        ? createElement(Fragment, null,
            createElement(Button, {
              variant: 'primary', disabled: !actionable, onClick: props.onConfirmDiscard,
            }, '确认无需新建 Skill'),
            createElement(Button, {
              variant: 'outline', disabled: !actionable, onClick: props.onRetry,
            }, '不同意，重新分析一次'),
          )
        : createElement(Fragment, null,
            createElement(Button, {
              variant: 'primary', disabled: !actionable, onClick: props.onApprove,
            }, detail.processingState === 'PUBLISHING' ? '正在发布…' : '批准并发布'),
            createElement(Button, {
              variant: 'outline', disabled: !actionable, onClick: event => { props.onReject(event.currentTarget) },
            }, '拒绝 Proposal'),
          ),
    ),
  )
}

export function RejectConfirmationBody(props: {
  readonly disabled: boolean
  readonly onCancel: () => void
  readonly onConfirm: () => void
}): ReactElement {
  return createElement(Fragment, null,
    createElement('h3', { id: 'run2skill-reject-title' }, '确认拒绝 Proposal？'),
    createElement('p', { id: 'run2skill-reject-description' },
      '现有 Skill 不会改变；该 Proposal 将离开待处理队列；过滤后的 Evidence 仍按项目策略保留。',
    ),
    createElement('button', {
      type: 'button', 'data-initial-focus': true, disabled: props.disabled, onClick: props.onCancel,
    }, '取消'),
    createElement('button', {
      type: 'button', disabled: props.disabled, onClick: props.onConfirm,
    }, '确认拒绝'),
  )
}

function RejectConfirmation(props: {
  readonly disabled: boolean
  readonly onCancel: () => void
  readonly onConfirm: () => void
}): ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const previous = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    const initial = dialog?.querySelector<HTMLElement>('[data-initial-focus]')
    const recapture = (event: FocusEvent) => {
      if (dialog !== null && event.target instanceof Node && !dialog.contains(event.target)) initial?.focus()
    }
    document.addEventListener('focusin', recapture, true)
    initial?.focus()
    return () => {
      document.removeEventListener('focusin', recapture, true)
      previous?.focus()
    }
  }, [])
  return createElement('div', {
    ref: dialogRef,
    role: 'alertdialog',
    'aria-modal': true,
    'aria-labelledby': 'run2skill-reject-title',
    'aria-describedby': 'run2skill-reject-description',
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
      event.stopPropagation()
      if (event.key === 'Escape') {
        event.preventDefault()
        props.onCancel()
      } else if (dialogRef.current !== null) {
        trapDialogTab(
          event.key,
          event.shiftKey,
          () => { event.preventDefault() },
          dialogRef.current,
          typeof document === 'undefined' ? undefined : document.activeElement,
        )
      }
    },
    className: css.rejectOverlay,
  },
  createElement('div', {
    className: css.rejectCard,
  }, createElement(RejectConfirmationBody, props)),
  )
}
