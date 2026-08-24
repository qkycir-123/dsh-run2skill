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
  describePersistenceScope,
  describeProposalListItem,
  describeProposalKind,
  describeProposalOutcome,
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
  if (queue === undefined || queue.completeness === 'UNKNOWN') return '技能草稿待处理数量未知'
  const total = queue.pendingReview + queue.publishing + queue.needsAttention
  const facts = [
    queue.pendingReview > 0 ? `${String(queue.pendingReview)} 份待审核` : undefined,
    queue.publishing > 0 ? `${String(queue.publishing)} 份正在保存` : undefined,
    queue.needsAttention > 0 ? `${String(queue.needsAttention)} 份需要处理` : undefined,
  ].filter(fact => fact !== undefined)
  return facts.length === 0
    ? '当前没有待处理的技能草稿'
    : `${String(total)} 份技能草稿待处理：${facts.join('，')}`
}

export function describeProposalSummaryState(state: ProposalInboxState): string {
  if (state.summaryPhase === 'LOADING') return '正在加载技能草稿队列'
  if (state.summaryPhase === 'UNAVAILABLE') return '技能草稿队列暂不可用'
  if (state.summary === undefined) return '技能草稿队列状态未知'
  const health = describeRun2skillHealth(state.summary.status)
  const queue = state.summary.queue.completeness === 'UNKNOWN'
    ? '技能草稿待处理数量未知'
    : countLabel(state)
  return state.summaryPhase === 'STALE'
    ? `技能草稿队列状态可能已过期：${health}；${queue}`
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
  createElement('section', { 'aria-label': '技能草稿待处理队列', className: css.queue },
    createElement('div', { className: css.legacyHeader },
      createElement('h2', { id: 'run2skill-proposal-inbox-title' }, '技能草稿'),
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
      ? createElement('p', null, '当前没有待处理的技能草稿')
      : null,
    createElement('ul', { className: css.legacyList },
      ...state.items.map(item => createElement('li', { key: item.proposalRef.proposalId },
        createElement('button', {
          type: 'button',
          disabled: contentBlocked || state.detailPhase === 'LOADING',
          'aria-current': state.selectedProposalId === item.proposalRef.proposalId ? 'true' : undefined,
          onClick: () => { void controller.select(item.proposalRef.proposalId) },
          className: css.proposalListButton,
        }, `${describeProposalKind(item.kind)} · ${makeSafeText(item.name)} · ${describePersistenceScope(item.persistenceScope)} · ${describeProposalListItem(item)}`),
      )),
    ),
  ),
  createElement('section', { 'aria-label': '技能草稿详情', className: css.legacyDetail },
    state.detailPhase === 'IDLE' ? createElement('p', null, '选择一份技能草稿查看完整内容') : null,
    state.detailPhase === 'LOADING' ? createElement('p', null, '正在加载技能草稿详情…') : null,
    state.detailPhase === 'ERROR' ? createElement('p', { role: 'alert' }, '技能草稿详情暂不可用') : null,
    state.detail === undefined ? null : createElement(ProposalDetailView, {
      detail: state.detail,
      textMode: props.textMode,
      setTextMode: props.setTextMode,
      mutationPending: contentBlocked,
      onApprove: () => { void controller.mutate('APPROVE') },
      onReject: () => { props.setRejectConfirm(true) },
      onRetry: () => { void controller.mutate('RETRY') },
      onRefresh: () => { void controller.mutate('REFRESH') },
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
  if (action === undefined) {
    if (detail.publicationOutcome === 'NEEDS_REFRESH') {
      return '这份草稿的保存目标已失效；请生成新草稿后重新审核。'
    }
    if (detail.publicationOutcome === 'PUBLISH_FAILED') {
      return '这份草稿的保存目标暂时不可确认；请等待目录恢复后重试保存。'
    }
    return '这份草稿的保存目标暂时不可确认；请等待目录恢复后重新打开详情。'
  }
  if (action.kind === 'CREATE') {
    return [
      `Skill 存储规则版本：${action.rootBinding.rootContractVersion}`,
      `Skill 存储定位器版本：${action.rootBinding.resolverVersion}`,
      `预期存储方式 / 来源：${action.rootBinding.expectedProvider} / ${action.rootBinding.expectedSource}`,
      `存储定位规则校验值：${action.rootBinding.resolutionContractDigest}`,
      `存储目录状态：${action.rootBinding.state}`,
      `Skill 名称：${action.targetBinding.skillName}`,
      `Skill 内容校验值：${detail.proposal.skillBytesDigest}`,
      `确认目标不存在的时间：${action.expectedAbsence.observedAt}`,
      '目标文件夹不存在：是',
      '目标 SKILL.md 不存在：是',
      '同名扁平 Skill 文件不存在：是',
    ].join('\n')
  }
  if (action.kind === 'MERGE') {
    return [
      `Skill 存储规则版本：${action.rootBinding.rootContractVersion}`,
      `Skill 存储定位器版本：${action.rootBinding.resolverVersion}`,
      `预期存储方式 / 来源：${action.rootBinding.expectedProvider} / ${action.rootBinding.expectedSource}`,
      `存储定位规则校验值：${action.rootBinding.resolutionContractDigest}`,
      `存储目录状态：${action.rootBinding.state}`,
      `现有 Skill 标识：${action.baseBinding.candidateKey}`,
      `Skill 名称：${action.targetBinding.skillName}`,
      `原内容校验值：${action.baseBinding.bytesDigest}`,
      `原内容确认时间：${action.baseBinding.observedAt}`,
    ].join('\n')
  }
  return [
    `匹配到的现有 Skill 标识：${action.coveringCandidateBinding.candidateKey}`,
    `名称：${action.coveringCandidateBinding.name}`,
    `来源：${action.coveringCandidateBinding.source}`,
    `内容校验值：${action.coveringCandidateBinding.contentDigest}`,
    `确认时间：${action.coveringCandidateBinding.observedAt}`,
  ].join('\n')
}

function describeProposalAction(detail: ProposalDetail): string {
  const proposal = detail.proposal
  if (proposal.actionBinding === undefined) return factsFromAction(detail)
  if (proposal.actionBinding.kind === 'CREATE') {
    return `确认后会新建技能“${makeSafeText(proposal.name)}”。`
  }
  if (proposal.actionBinding.kind === 'MERGE') {
    return `确认后会把这次经验补充到已有技能“${makeSafeText(proposal.name)}”中。`
  }
  return `已有技能“${makeSafeText(proposal.name)}”已包含这次经验，无需重复创建。`
}

function describeExperienceType(type: ProposalDetail['experiences'][number]['type']): string {
  if (type === 'CORRECTION') return '纠错经验'
  if (type === 'CONSTRAINT') return '使用约束'
  return '操作流程'
}

function describeResolutionKind(kind: NonNullable<ProposalDetail['proposal']['dshHomeBinding']>['resolutionKind']): string {
  if (kind === 'CONFIGURATION') return '由 DSH 配置指定'
  if (kind === 'ENVIRONMENT') return '由运行环境指定'
  return '使用 DSH 默认位置'
}

export function proposalDetailAction(
  detail: Pick<ProposalDetail, 'reviewDecision' | 'processingState' | 'publicationOutcome'>,
  mutationPending: boolean,
): 'REVIEW' | 'REFRESH' | 'RETRY_PUBLICATION' | 'NONE' {
  if (mutationPending) return 'NONE'
  if (
    detail.processingState === 'NEEDS_ATTENTION'
    && detail.publicationOutcome === 'NEEDS_REFRESH'
  ) return 'REFRESH'
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
  readonly onRefresh: () => void
  readonly onConfirmDiscard: () => void
}): ReactElement {
  const { detail, mutationPending } = props
  const proposal = detail.proposal
  const action = proposalDetailAction(detail, mutationPending)
  const actionable = action === 'REVIEW'
  const coordinate = detail.sessionCoordinate
  const baseBytes = proposal.actionBinding?.kind === 'MERGE'
    ? proposal.actionBinding.baseBinding.exactBytes
    : undefined
  const coveringBytes = proposal.actionBinding?.kind === 'DISCARD'
    ? proposal.actionBinding.coveringCandidateBinding.content
    : undefined
  const diff = baseBytes === undefined ? [] : makeExactLineDiff(baseBytes, proposal.exactSkillBytes)

  return createElement(Fragment, null,
    createElement('h3', null, `${describeProposalKind(proposal.kind)}：${makeSafeText(proposal.name)}`),
    createElement('dl', { className: css.detailFacts },
      createElement('dt', null, '这个技能有什么用'), createElement('dd', null, makeSafeText(proposal.description)),
      createElement('dt', null, '什么时候会用到'), createElement('dd', null, makeSafeText(proposal.whenToUse)),
      createElement('dt', null, '保存后在哪里可用'),
      createElement('dd', null, describePersistenceScope(proposal.persistenceScope)),
      createElement('dt', null, '当前进度'),
      createElement('dd', null, describeProposalOutcome(detail)),
    ),
    createElement('h4', null, '为什么建议保存'),
    createElement('p', null, makeSafeText(proposal.curationRationale)),
    ...detail.experiences.map(experience => createElement('article', { key: experience.experienceId },
      createElement('strong', null, `${describeExperienceType(experience.type)} · 来自明确表达`),
      createElement('p', null, makeSafeText(experience.lesson)),
    )),
    createElement('h4', null, '参考的对话内容'),
    createElement('p', { className: css.muted }, '以下片段来自本次对话，并已过滤不可安全展示的内容。'),
    ...detail.evidenceRefs.map(evidence => createElement('article', { key: `${String(evidence.messageSeq)}:${evidence.excerptDigest}` },
      createElement('strong', null, evidence.truncated ? '对话片段（内容较长，已节选）' : '对话片段'),
      createElement(ProposalTextView, {
        value: evidence.excerpt,
        mode: 'SAFE',
        label: '参考的对话内容',
      }),
    )),
    createElement('h4', null, '这次会怎么处理'),
    createElement('p', null, describeProposalAction(detail)),
    createElement('details', { className: css.technicalDetails },
      createElement('summary', null, '技术信息（排查问题时使用）'),
      createElement('dl', { className: css.detailFacts },
        createElement('dt', null, '草稿版本'), createElement('dd', null, String(proposal.revision)),
        createElement('dt', null, '草稿内容指纹'), createElement('dd', null, proposal.digest),
        createElement('dt', null, '来源会话'),
        createElement('dd', null,
          `${coordinate.rootSessionId} / 第 ${String(coordinate.turn)} 回合 / 记录 ${String(coordinate.turnEndSeq)}`,
        ),
        proposal.workspaceBinding === undefined
          ? null
          : createElement(Fragment, null,
              createElement('dt', null, '项目标识'),
              createElement('dd', null, proposal.workspaceBinding.workspaceId),
            ),
        proposal.dshHomeBinding === undefined
          ? null
          : createElement(Fragment, null,
              createElement('dt', null, '保存位置识别方式'),
              createElement('dd', null, describeResolutionKind(proposal.dshHomeBinding.resolutionKind)),
              createElement('dt', null, '用户技能目录指纹'),
              createElement('dd', null, proposal.dshHomeBinding.identityDigest),
            ),
        createElement('dt', null, '用户决定'),
        createElement('dd', null, describeReviewDecision(detail.reviewDecision)),
        createElement('dt', null, '处理进度'),
        createElement('dd', null, describeProcessingState(detail.processingState)),
        createElement('dt', null, '保存结果'),
        createElement('dd', null, describePublicationOutcome(detail.publicationOutcome)),
      ),
      createElement(ProposalTextView, { value: factsFromAction(detail), mode: 'SAFE', label: '保存目标技术信息' }),
    ),
    createElement('div', { role: 'group', 'aria-label': '内容显示方式', className: css.modeGroup },
      createElement(Pill, {
        'aria-pressed': props.textMode === 'SAFE',
        active: props.textMode === 'SAFE',
        onClick: () => { props.setTextMode('SAFE') },
      }, '标出隐藏字符'),
      createElement(Pill, {
        'aria-pressed': props.textMode === 'RAW',
        active: props.textMode === 'RAW',
        onClick: () => { props.setTextMode('RAW') },
      }, '按原文显示'),
    ),
    createElement('h4', null, '确认要保存的技能说明'),
    createElement('p', { className: css.muted },
      '这是 Agent 以后会遵循的完整说明。开头是技能名称和设置，标题下方是具体规则。',
    ),
    createElement(ProposalTextView, {
      value: proposal.exactSkillBytes,
      mode: props.textMode,
      label: '确认要保存的技能说明',
    }),
    baseBytes === undefined ? null : createElement(Fragment, null,
      createElement('h4', null, '现有技能内容'),
      createElement(ProposalTextView, { value: baseBytes, mode: props.textMode, label: '现有技能内容' }),
      createElement('h4', null, '将发生的内容变化'),
      createElement('p', { className: css.muted }, '“+”表示新增内容，“-”表示将被替换的内容。'),
      createElement('pre', { 'aria-label': '将发生的内容变化' },
        diff.map(line => `${line.kind === 'ADD' ? '+' : line.kind === 'REMOVE' ? '-' : ' '} ${makeSafeText(line.text)}`).join('\n'),
      ),
    ),
    coveringBytes === undefined ? null : createElement(Fragment, null,
      createElement('h4', null, '匹配到的已有技能内容'),
      createElement(ProposalTextView, { value: coveringBytes, mode: props.textMode, label: '匹配到的已有技能内容' }),
    ),
    createElement('div', { role: 'group', 'aria-label': '技能草稿操作', className: css.actions },
      action === 'RETRY_PUBLICATION'
        ? createElement(Button, {
            variant: 'primary', disabled: mutationPending, onClick: props.onRetry,
          }, '重试保存')
        : action === 'REFRESH'
          ? createElement(Button, {
              variant: 'primary', disabled: mutationPending, onClick: props.onRefresh,
            }, '生成新草稿')
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
            }, detail.processingState === 'PUBLISHING' ? '正在保存…' : '确认并保存'),
            createElement(Button, {
              variant: 'outline', disabled: !actionable, onClick: event => { props.onReject(event.currentTarget) },
            }, '放弃草稿'),
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
    createElement('h3', { id: 'run2skill-reject-title' }, '确认放弃这份技能草稿？'),
    createElement('p', { id: 'run2skill-reject-description' },
      '现有 Skill 不会改变；这份技能草稿将离开待处理队列；经过筛选的学习材料仍按项目规则保留。',
    ),
    createElement('button', {
      type: 'button', 'data-initial-focus': true, disabled: props.disabled, onClick: props.onCancel,
    }, '取消'),
    createElement('button', {
      type: 'button', disabled: props.disabled, onClick: props.onConfirm,
    }, '确认放弃'),
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
