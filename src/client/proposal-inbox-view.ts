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
import {
  ProposalInboxController,
  ProposalTextView,
  makeExactLineDiff,
  makeSafeText,
  type ProposalDetail,
  type ProposalInboxState,
  type ProposalReviewCall,
} from './proposal-inbox.js'

const focusableSelector = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

interface FocusRoot {
  querySelectorAll(selector: string): ArrayLike<{ focus(): void }>
}

export function trapDialogTab(
  key: string,
  backwards: boolean,
  preventDefault: () => void,
  root: FocusRoot,
  activeElement: unknown,
): void {
  if (key !== 'Tab') return
  const focusable = Array.from(root.querySelectorAll(focusableSelector))
  if (focusable.length === 0) {
    preventDefault()
    return
  }
  const first = focusable[0]!
  const last = focusable.at(-1)!
  if (!focusable.includes(activeElement as { focus(): void })) {
    preventDefault()
    ;(backwards ? last : first).focus()
    return
  }
  if (backwards && activeElement === first) {
    preventDefault()
    last.focus()
  } else if (!backwards && activeElement === last) {
    preventDefault()
    first.focus()
  }
}

export function proposalInboxContentBlocked(mutationPending: boolean, rejectConfirm: boolean): boolean {
  return mutationPending || rejectConfirm
}

function useDialogFocus(
  open: boolean,
  triggerRef: RefObject<HTMLButtonElement | null>,
  dialogRef: RefObject<HTMLDivElement | null>,
): void {
  useEffect(() => {
    if (!open) return
    if (typeof document === 'undefined') return
    const dialog = dialogRef.current
    const initial = dialog?.querySelector<HTMLElement>('[data-initial-focus]')
      ?? dialog?.querySelector<HTMLElement>(focusableSelector)
    const recapture = (event: FocusEvent) => {
      if (dialog !== null && event.target instanceof Node && !dialog.contains(event.target)) initial?.focus()
    }
    document.addEventListener('focusin', recapture, true)
    initial?.focus()
    return () => {
      document.removeEventListener('focusin', recapture, true)
      triggerRef.current?.focus()
    }
  }, [dialogRef, open, triggerRef])
}

function countLabel(state: ProposalInboxState): string {
  const queue = state.summary?.queue
  if (queue === undefined || queue.completeness === 'UNKNOWN') return 'Skill 提案，待处理数量未知'
  const total = queue.pendingReview + queue.publishing + queue.needsAttention
  return `${total} 条 Skill 提案待处理`
}

export function ProposalInboxHeaderAction(props: {
  readonly workspaceId: string
  readonly callReview: ProposalReviewCall
}): ReactElement {
  const controller = useMemo(
    () => new ProposalInboxController(props.workspaceId, props.callReview),
    [props.callReview, props.workspaceId],
  )
  useEffect(() => {
    controller.start()
    return () => { controller.dispose() }
  }, [controller])
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(state.open, triggerRef, dialogRef)
  const [textMode, setTextMode] = useState<'SAFE' | 'RAW'>('SAFE')
  const [rejectConfirm, setRejectConfirm] = useState(false)
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
      style: { outlineOffset: '0.2rem' },
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
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 999,
      background: 'rgb(0 0 0 / 35%)',
    },
  }),
  createElement('div', {
    ref: props.dialogRef,
    role: 'dialog',
    'aria-modal': true,
    'aria-labelledby': 'run2skill-proposal-inbox-title',
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
      closeOnKeyboard(event, controller, props.dialogRef.current)
    },
    style: {
      position: 'fixed',
      inset: '5vh 5vw',
      zIndex: 1000,
      display: 'grid',
      gridTemplateColumns: 'minmax(16rem, 24rem) minmax(0, 1fr)',
      gap: '1rem',
      padding: '1rem',
      overflow: 'hidden',
      background: 'Canvas',
      color: 'CanvasText',
      border: '2px solid currentColor',
      borderRadius: '0.5rem',
      boxShadow: '0 1rem 3rem rgb(0 0 0 / 35%)',
    },
  },
  createElement('div', {
    'aria-hidden': props.rejectConfirm || undefined,
    inert: props.rejectConfirm ? '' : undefined,
    style: { display: 'contents', pointerEvents: props.rejectConfirm ? 'none' : undefined },
  },
  createElement('section', { 'aria-label': 'Proposal 待处理队列', style: { overflow: 'auto' } },
    createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
      createElement('h2', { id: 'run2skill-proposal-inbox-title' }, 'Skill Proposal Inbox'),
      createElement('button', {
        type: 'button',
        'data-initial-focus': true,
        onClick: () => { controller.close() },
      }, '关闭'),
    ),
    createElement('p', { role: 'status' }, countLabel(state)),
    state.listPhase === 'LOADING' ? createElement('p', null, '正在加载待处理队列…') : null,
    state.listPhase === 'ERROR' ? createElement('p', { role: 'alert' }, '待处理队列暂不可用') : null,
    state.listPhase === 'READY' && state.items.length === 0
      ? createElement('p', null, '当前没有待处理 Proposal')
      : null,
    createElement('ul', { style: { listStyle: 'none', padding: 0 } },
      ...state.items.map(item => createElement('li', { key: item.proposalRef.proposalId },
        createElement('button', {
          type: 'button',
          disabled: contentBlocked || state.detailPhase === 'LOADING',
          'aria-current': state.selectedProposalId === item.proposalRef.proposalId ? 'true' : undefined,
          onClick: () => { void controller.select(item.proposalRef.proposalId) },
          style: {
            display: 'block',
            width: '100%',
            padding: '0.75rem',
            marginBlock: '0.25rem',
            textAlign: 'start',
            outlineOffset: '0.15rem',
          },
        }, `${item.kind} · ${makeSafeText(item.name)} · ${item.persistenceScope} · ${item.processingState}`),
      )),
    ),
  ),
  createElement('section', { 'aria-label': 'Proposal 详情', style: { overflow: 'auto', minWidth: 0 } },
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

function factsFromAction(detail: ProposalDetail): string {
  const action = detail.proposal.actionBinding
  if (action.kind === 'CREATE') {
    return [
      `Root state: ${action.rootBinding.state}`,
      `Declared root: ${action.rootBinding.declaredRootPath}`,
      `Bundle target: ${action.targetBinding.bundlePath}`,
      `Skill target: ${action.targetBinding.skillFilePath}`,
      `Flat target checked: ${action.expectedAbsence.flatSkillFilePath}`,
      `Expected absence observed: ${action.expectedAbsence.observedAt}`,
      'Bundle absent: yes',
      'Skill file absent: yes',
      'Flat Skill file absent: yes',
    ].join('\n')
  }
  if (action.kind === 'MERGE') {
    return [
      `Root state: ${action.rootBinding.state}`,
      `Declared root: ${action.rootBinding.declaredRootPath}`,
      `Target identity: ${action.baseBinding.candidateKey}`,
      `Observed target path: ${action.baseBinding.path}`,
      `Bundle target: ${action.targetBinding.bundlePath}`,
      `Skill target: ${action.targetBinding.skillFilePath}`,
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
    ...(action.coveringCandidateBinding.path === undefined
      ? []
      : [`Path: ${action.coveringCandidateBinding.path}`]),
  ].join('\n')
}

export function ProposalDetailView(props: {
  readonly detail: ProposalDetail
  readonly textMode: 'SAFE' | 'RAW'
  readonly setTextMode: (mode: 'SAFE' | 'RAW') => void
  readonly mutationPending: boolean
  readonly onApprove: () => void
  readonly onReject: () => void
  readonly onRetry: () => void
  readonly onConfirmDiscard: () => void
}): ReactElement {
  const { detail, mutationPending } = props
  const proposal = detail.proposal
  const actionable = detail.reviewDecision === 'PENDING'
    && detail.processingState === 'READY_FOR_REVIEW'
    && !mutationPending
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
            createElement('dd', null, `${proposal.workspaceBinding.workspaceId} · ${makeSafeText(proposal.workspaceBinding.canonicalPath)}`),
          ),
      createElement('dt', null, '状态'),
      createElement('dd', null, `${detail.reviewDecision} · ${detail.processingState} · ${detail.publicationOutcome}`),
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
    createElement('div', { role: 'group', 'aria-label': '内容显示方式' },
      createElement('button', {
        type: 'button',
        'aria-pressed': props.textMode === 'SAFE',
        onClick: () => { props.setTextMode('SAFE') },
      }, '安全视图'),
      createElement('button', {
        type: 'button',
        'aria-pressed': props.textMode === 'RAW',
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
      createElement('pre', { 'aria-label': '精确 Diff', style: { whiteSpace: 'pre-wrap', unicodeBidi: 'isolate' } },
        diff.map(line => `${line.kind === 'ADD' ? '+' : line.kind === 'REMOVE' ? '-' : ' '} ${makeSafeText(line.text)}`).join('\n'),
      ),
    ),
    coveringBytes === undefined ? null : createElement(Fragment, null,
      createElement('h4', null, '覆盖已有 Skill 的完整内容'),
      createElement(ProposalTextView, { value: coveringBytes, mode: props.textMode, label: '覆盖已有 Skill 的完整内容' }),
    ),
    createElement('div', { role: 'group', 'aria-label': 'Proposal 操作' },
      proposal.kind === 'DISCARD'
        ? createElement(Fragment, null,
            createElement('button', {
              type: 'button', disabled: !actionable, onClick: props.onConfirmDiscard,
            }, '确认无需新建 Skill'),
            createElement('button', {
              type: 'button', disabled: !actionable, onClick: props.onRetry,
            }, '不同意，重新分析一次'),
          )
        : createElement(Fragment, null,
            createElement('button', {
              type: 'button', disabled: !actionable, onClick: props.onApprove,
            }, detail.processingState === 'PUBLISHING' ? '正在发布…' : '批准并发布'),
            createElement('button', {
              type: 'button', disabled: !actionable, onClick: props.onReject,
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
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 1001,
      display: 'grid',
      placeItems: 'center',
      padding: '1rem',
      background: 'rgb(0 0 0 / 35%)',
    },
  },
  createElement('div', {
    style: {
      maxWidth: '32rem',
      padding: '1rem',
      background: 'Canvas',
      color: 'CanvasText',
      border: '2px solid currentColor',
      borderRadius: '0.5rem',
    },
  }, createElement(RejectConfirmationBody, props)),
  )
}
