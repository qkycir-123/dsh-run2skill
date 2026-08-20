import {
  Fragment,
  createElement,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type RefObject,
} from 'react'
import { z } from 'zod'
import { trapDialogTab } from './dialog-focus.js'

export const PURGE_IDLE_POLL_INTERVAL_MS = 10_000
export const PURGE_ACTIVE_POLL_INTERVAL_MS = 2_000

const previewId = z.string().regex(/^purv_[a-f0-9]{64}$/)
const purgeId = z.string().regex(/^purge_[a-f0-9]{64}$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const isoDateTime = z.string().datetime({ offset: true })
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const projectBinding = z.object({
  scope: z.literal('PROJECT'),
  workspaceId: z.string().min(1).max(256),
  canonicalWorkspacePath: z.string().min(1).max(32 * 1024),
  workspaceObservedAt: isoDateTime,
  canonicalRootPath: z.string().min(1).max(32 * 1024),
  rootContractVersion: z.literal('stock-dsh-web-default-roots-v1'),
  resolverVersion: z.literal('stock-root-resolver-v2'),
  resolutionContractDigest: digest,
}).strict()
const scopeBinding = z.discriminatedUnion('scope', [
  projectBinding,
  z.object({ scope: z.literal('USER') }).strict(),
])
const previewSchema = z.object({
  apiVersion: z.literal(1),
  previewId,
  digest,
  expiresAt: isoDateTime,
  scopeBinding,
  hideBefore: isoDateTime,
  workItemCount: count,
  lineageCount: count,
  blockedOrUnprovenCount: count,
  willDelete: z.array(z.object({ kind: z.enum(['WORK_ITEMS', 'LINEAGES']), count }).strict()).length(2),
  willKeep: z.array(z.object({
    reason: z.enum(['KEEP_NEW', 'KEEP_SCOPE', 'KEEP_UNPROVEN']), count,
  }).strict()).length(3),
  busyPublicationCount: count,
}).strict()
const receiptSchema = z.object({
  apiVersion: z.literal(1),
  purgeId,
  state: z.enum(['COMPLETED', 'IN_PROGRESS']),
  phase: z.enum(['HIDING', 'DELETING_LINEAGES', 'DELETING_WORK_ITEMS', 'VERIFYING']).optional(),
  deletedWorkItems: count,
  deletedLineages: count,
}).strict()
const statusSchema = z.discriminatedUnion('state', [
  z.object({ apiVersion: z.literal(1), state: z.literal('IDLE') }).strict(),
  z.object({
    apiVersion: z.literal(1),
    state: z.literal('IN_PROGRESS'),
    purgeId,
    hideBefore: isoDateTime,
    startedAt: isoDateTime,
    phase: z.enum(['HIDING', 'DELETING_LINEAGES', 'DELETING_WORK_ITEMS', 'VERIFYING']),
    deletedWorkItems: count,
    deletedLineages: count,
    lastError: z.object({
      code: z.string().regex(/^[A-Z0-9_]+$/),
      occurredAt: isoDateTime,
    }).strict().optional(),
  }).strict(),
])
const errorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string().min(1).max(128),
    message: z.string().max(512),
    details: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
}).strict()

export type PurgePreview = z.infer<typeof previewSchema>
export type PurgeReceipt = z.infer<typeof receiptSchema>
export type PurgeStatus = z.infer<typeof statusSchema>
export type PurgeScope = 'PROJECT' | 'USER'

interface PurgeClientError {
  readonly code: string
  readonly busyPublicationCount?: number | undefined
}

class PurgeResponseError extends Error {
  constructor(readonly facts: PurgeClientError) {
    super(facts.code)
  }
}

export interface PurgeSettingsState {
  readonly statusPhase: 'LOADING' | 'READY' | 'STALE' | 'UNAVAILABLE'
  readonly status?: PurgeStatus | undefined
  readonly inProgressReceipt?: PurgeReceipt | undefined
  readonly previewScope?: PurgeScope | undefined
  readonly preview?: PurgePreview | undefined
  readonly previewPending: boolean
  readonly mutationPending: boolean
  readonly error?: PurgeClientError | undefined
  readonly announcement: string
}

export interface PurgePollEnvironment {
  isVisible(): boolean
  setInterval(callback: () => void, delayMs: number): unknown
  clearInterval(handle: unknown): void
  onVisibilityChange(listener: () => void): () => void
}

export type PurgeCall = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<unknown>

function browserEnvironment(): PurgePollEnvironment {
  return {
    isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
    clearInterval: handle => { globalThis.clearInterval(handle as ReturnType<typeof setInterval>) },
    onVisibilityChange: listener => {
      if (typeof document === 'undefined') return () => undefined
      document.addEventListener('visibilitychange', listener)
      return () => { document.removeEventListener('visibilitychange', listener) }
    },
  }
}

function parseValue<T>(schema: z.ZodType<T>, response: unknown): T {
  const success = z.object({ ok: z.literal(true), value: schema }).strict().safeParse(response)
  if (success.success) return success.data.value
  const failure = errorSchema.safeParse(response)
  if (failure.success) {
    const busy = failure.data.error.details?.busyPublicationCount
    throw new PurgeResponseError({
      code: failure.data.error.code,
      ...(typeof busy === 'number' && Number.isSafeInteger(busy) && busy >= 0
        ? { busyPublicationCount: busy }
        : {}),
    })
  }
  throw new PurgeResponseError({ code: 'PURGE_STORAGE_UNAVAILABLE' })
}

function completionAnnouncement(scope: PurgeScope | undefined, receipt: PurgeReceipt): string {
  const subject = scope === undefined ? 'run2skill 数据' : `${scope} run2skill 数据`
  return `${subject}清理完成：${String(receipt.deletedWorkItems)} 条待处理数据，${String(receipt.deletedLineages)} 条发布沿袭记录。`
}

function errorAnnouncement(error: PurgeClientError): string {
  if (error.code === 'PURGE_PREVIEW_STALE') return '清理预览已失效，请重新预览后确认。'
  if (error.code === 'PURGE_BUSY') {
    return `当前有 ${String(error.busyPublicationCount ?? 0)} 条正在发布；请等待发布完成后重新预览。`
  }
  if (error.code === 'PURGE_ALREADY_RUNNING') return '已有一项数据清理正在运行，请等待完成。'
  if (error.code === 'PURGE_SCOPE_UNAVAILABLE') return '当前作用域无法可靠确认，未执行清理。'
  if (error.code === 'PURGE_INCOMPATIBLE') return '当前数据版本不兼容，未执行清理。'
  if (error.code === 'PURGE_FENCE_LIMIT') return 'PROJECT 清理保护记录已达上限，未执行清理。'
  return '数据清理未完成；已清理边界继续隐藏，可重试。'
}

const initialState: PurgeSettingsState = {
  statusPhase: 'LOADING',
  previewPending: false,
  mutationPending: false,
  announcement: '',
}

export class PurgeSettingsController {
  readonly #listeners = new Set<() => void>()
  #state: PurgeSettingsState = initialState
  #started = false
  #disposed = false
  #pending: Promise<void> | undefined
  #abort: AbortController | undefined
  #timer: unknown
  #timerDelay: number | undefined
  #removeVisibility: (() => void) | undefined

  constructor(
    private readonly call: PurgeCall,
    private readonly getWorkspaceId: () => string | undefined,
    private readonly environment: PurgePollEnvironment = browserEnvironment(),
  ) {}

  snapshot = (): PurgeSettingsState => this.#state

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  start(): void {
    if (this.#started || this.#disposed) return
    this.#started = true
    this.#removeVisibility = this.environment.onVisibilityChange(() => {
      if (this.environment.isVisible()) {
        this.#schedule()
        void this.#refreshStatus()
      } else this.#unschedule()
    })
    if (this.environment.isVisible()) {
      this.#schedule()
      void this.#refreshStatus()
    }
  }

  whenIdle(): Promise<void> {
    return this.#pending ?? Promise.resolve()
  }

  async preview(scope: PurgeScope): Promise<void> {
    if (this.#disposed || this.#state.previewPending || this.#state.mutationPending) return
    const workspaceId = this.getWorkspaceId()
    if (workspaceId === undefined) {
      const error = { code: 'PURGE_SCOPE_UNAVAILABLE' }
      this.#publish({ ...this.#state, error, announcement: errorAnnouncement(error) })
      return
    }
    await this.#execute(async signal => {
      this.#publish({
        ...this.#state,
        previewPending: true,
        previewScope: scope,
        preview: undefined,
        error: undefined,
        announcement: '',
      })
      const preview = parseValue(previewSchema, await this.call(
        'purge/preview',
        { apiVersion: 1, scope, workspaceId },
        signal,
      ))
      this.#publish({ ...this.#state, previewPending: false, preview, error: undefined })
    }, error => {
      this.#publish({
        ...this.#state,
        previewPending: false,
        preview: undefined,
        error,
        announcement: errorAnnouncement(error),
      })
    })
  }

  cancelPreview(): void {
    if (this.#disposed || this.#state.mutationPending) return
    this.#publish({
      ...this.#state,
      preview: undefined,
      previewScope: undefined,
      error: undefined,
      announcement: '',
    })
  }

  async confirm(): Promise<void> {
    const preview = this.#state.preview
    const scope = this.#state.previewScope
    if (this.#disposed || preview === undefined || scope === undefined || this.#state.mutationPending) return
    await this.#execute(async signal => {
      this.#publish({ ...this.#state, mutationPending: true, error: undefined, announcement: '' })
      const receipt = parseValue(receiptSchema, await this.call(
        'purge/confirm',
        { apiVersion: 1, previewId: preview.previewId, digest: preview.digest },
        signal,
      ))
      this.#acceptReceipt(scope, receipt)
    }, async error => {
      this.#publish({
        ...this.#state,
        mutationPending: false,
        error,
        announcement: errorAnnouncement(error),
        preview: undefined,
        previewScope: undefined,
      })
      await this.#readStatusAfterFailure()
    })
  }

  async retry(): Promise<void> {
    const status = this.#state.status
    if (
      this.#disposed
      || status?.state !== 'IN_PROGRESS'
      || status.lastError === undefined
      || this.#state.mutationPending
    ) return
    await this.#execute(async signal => {
      this.#publish({ ...this.#state, mutationPending: true, error: undefined, announcement: '正在重试数据清理。' })
      const receipt = parseValue(receiptSchema, await this.call(
        'purge/retry',
        { apiVersion: 1, purgeId: status.purgeId },
        signal,
      ))
      this.#acceptReceipt(this.#state.previewScope, receipt)
    }, async error => {
      this.#publish({
        ...this.#state,
        mutationPending: false,
        error,
        announcement: errorAnnouncement(error),
      })
      await this.#readStatusAfterFailure()
    })
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#unschedule()
    this.#removeVisibility?.()
    this.#removeVisibility = undefined
    this.#abort?.abort()
    this.#listeners.clear()
  }

  #acceptReceipt(scope: PurgeScope | undefined, receipt: PurgeReceipt): void {
    if (receipt.state === 'COMPLETED') {
      this.#publish({
        ...this.#state,
        statusPhase: 'READY',
        status: { apiVersion: 1, state: 'IDLE' },
        inProgressReceipt: undefined,
        preview: undefined,
        previewScope: undefined,
        mutationPending: false,
        error: undefined,
        announcement: completionAnnouncement(scope, receipt),
      })
      return
    }
    this.#publish({
      ...this.#state,
      mutationPending: false,
      preview: undefined,
      inProgressReceipt: receipt,
      announcement: `run2skill 数据清理进行中：${receipt.phase ?? 'HIDING'}。`,
    })
  }

  async #readStatusAfterFailure(): Promise<void> {
    try {
      const status = parseValue(statusSchema, await this.call(
        'purge/status',
        { apiVersion: 1 },
        new AbortController().signal,
      ))
      this.#publish({
        ...this.#state,
        statusPhase: 'READY',
        status,
        inProgressReceipt: status.state === 'IDLE' ? undefined : this.#state.inProgressReceipt,
      })
    } catch {
      // Preserve the actionable mutation error when status readback also fails.
    }
  }

  async #refreshStatus(): Promise<void> {
    if (this.#disposed || !this.environment.isVisible()) return
    await this.#execute(async signal => {
      const status = parseValue(statusSchema, await this.call('purge/status', { apiVersion: 1 }, signal))
      this.#publish({
        ...this.#state,
        statusPhase: 'READY',
        status,
        inProgressReceipt: status.state === 'IDLE' ? undefined : this.#state.inProgressReceipt,
      })
    }, () => {
      this.#publish({
        ...this.#state,
        statusPhase: this.#state.status === undefined ? 'UNAVAILABLE' : 'STALE',
      })
    })
  }

  async #execute(
    task: (signal: AbortSignal) => Promise<void>,
    onError: (error: PurgeClientError) => void | Promise<void>,
  ): Promise<void> {
    if (this.#disposed || this.#pending !== undefined) return this.#pending ?? Promise.resolve()
    const abort = new AbortController()
    this.#abort = abort
    const pending = (async () => {
      try {
        await task(abort.signal)
      } catch (error) {
        if (!this.#disposed && !abort.signal.aborted) {
          await onError(error instanceof PurgeResponseError
            ? error.facts
            : { code: 'PURGE_STORAGE_UNAVAILABLE' })
        }
      }
    })()
    this.#pending = pending
    await pending.finally(() => {
      if (this.#pending === pending) this.#pending = undefined
      if (this.#abort === abort) this.#abort = undefined
    })
  }

  #schedule(): void {
    if (this.#disposed) return
    const delay = this.#state.status?.state === 'IN_PROGRESS'
      || this.#state.inProgressReceipt?.state === 'IN_PROGRESS'
      ? PURGE_ACTIVE_POLL_INTERVAL_MS
      : PURGE_IDLE_POLL_INTERVAL_MS
    if (this.#timer !== undefined && this.#timerDelay === delay) return
    this.#unschedule()
    this.#timerDelay = delay
    this.#timer = this.environment.setInterval(() => { void this.#refreshStatus() }, delay)
  }

  #unschedule(): void {
    if (this.#timer === undefined) return
    this.environment.clearInterval(this.#timer)
    this.#timer = undefined
    this.#timerDelay = undefined
  }

  #publish(state: PurgeSettingsState): void {
    if (this.#disposed) return
    this.#state = state
    if (this.#started && this.environment.isVisible()) this.#schedule()
    for (const listener of this.#listeners) listener()
  }
}

const phaseCopy: Record<Exclude<PurgeStatus, { state: 'IDLE' }>['phase'], string> = {
  HIDING: '正在隐藏命中数据',
  DELETING_LINEAGES: '正在删除发布沿袭记录',
  DELETING_WORK_ITEMS: '正在删除待处理数据',
  VERIFYING: '正在验证清理结果',
}

function PreviewSummary({ preview }: { readonly preview: PurgePreview }): ReactElement {
  const keep = Object.fromEntries(preview.willKeep.map(item => [item.reason, item.count]))
  return createElement('dl', null,
    createElement('dt', null, '将删除'),
    createElement('dd', null, `${String(preview.workItemCount)} 条待处理数据；${String(preview.lineageCount)} 条发布沿袭记录`),
    createElement('dt', null, '将保留'),
    createElement('dd', null,
      `${String(keep.KEEP_NEW ?? 0)} 条边界后新数据；${String(keep.KEEP_SCOPE ?? 0)} 条其他作用域数据`,
    ),
    createElement('dt', null, '无法证明'),
    createElement('dd', null, `${String(preview.blockedOrUnprovenCount)} 条无法证明作用域的数据将保留`),
    createElement('dt', null, '正在发布'),
    createElement('dd', null, `${String(preview.busyPublicationCount)} 条；存在时确认会安全拒绝`),
  )
}

function PurgeConfirmationDialog(props: {
  readonly controller: PurgeSettingsController
  readonly state: PurgeSettingsState
  readonly restoreFocusRef: RefObject<HTMLButtonElement | null>
}): ReactElement | null {
  const dialogRef = useRef<HTMLDivElement>(null)
  const preview = props.state.preview
  const scope = props.state.previewScope
  useEffect(() => {
    if (preview === undefined || typeof document === 'undefined') return
    const dialog = dialogRef.current
    const initial = dialog?.querySelector<HTMLElement>('[data-initial-focus]')
    const recapture = (event: FocusEvent) => {
      if (dialog !== null && event.target instanceof Node && !dialog.contains(event.target)) initial?.focus()
    }
    document.addEventListener('focusin', recapture, true)
    initial?.focus()
    return () => {
      document.removeEventListener('focusin', recapture, true)
      props.restoreFocusRef.current?.focus()
    }
  }, [preview?.previewId, props.restoreFocusRef])
  if (preview === undefined || scope === undefined) return null
  const titleId = 'run2skill-purge-confirm-title'
  const descriptionId = 'run2skill-purge-confirm-description'
  return createElement(Fragment, null,
    createElement('div', {
      'aria-hidden': true,
      style: { position: 'fixed', inset: 0, zIndex: 1999, background: 'rgb(0 0 0 / 35%)' },
    }),
    createElement('div', {
      ref: dialogRef,
      role: 'alertdialog',
      'aria-modal': true,
      'aria-labelledby': titleId,
      'aria-describedby': descriptionId,
      onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          props.controller.cancelPreview()
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
        inset: '10vh max(1rem, 20vw)',
        zIndex: 2000,
        overflow: 'auto',
        padding: '1rem',
        background: 'Canvas',
        color: 'CanvasText',
        border: '2px solid currentColor',
        borderRadius: '0.5rem',
      },
    },
    createElement('h3', { id: titleId }, `确认清理 ${scope} run2skill 数据？`),
    createElement('div', { id: descriptionId },
      createElement('p', null, '此操作只清理本次预览边界内的 run2skill 数据，不会卸载插件。'),
      createElement('ul', null,
        createElement('li', null,
          '删除 run2skill 的过滤 Evidence、Experience、pending、Proposal、Revision metadata、usage 和相关审计事实。',
        ),
        createElement('li', null, '保留 DSH Session Log。'),
        createElement('li', null, '保留所有已发布的原生 Skill。'),
        createElement('li', null, '删除 Lineage 后，保留的 Skill 将作为普通现有 Skill 使用。'),
      ),
    ),
    createElement(PreviewSummary, { preview }),
    createElement('button', {
      type: 'button',
      'data-initial-focus': true,
      disabled: props.state.mutationPending,
      onClick: () => { props.controller.cancelPreview() },
    }, '取消清理'),
    createElement('button', {
      type: 'button',
      disabled: props.state.mutationPending,
      onClick: () => { void props.controller.confirm() },
    }, props.state.mutationPending ? '正在清理…' : '确认清理'),
    ),
  )
}

export function PurgeSettingsSection(props: {
  readonly controller: PurgeSettingsController
}): ReactElement {
  const state = useSyncExternalStore(
    props.controller.subscribe,
    props.controller.snapshot,
    props.controller.snapshot,
  )
  const projectRef = useRef<HTMLButtonElement>(null)
  const userRef = useRef<HTMLButtonElement>(null)
  const [restoreRef, setRestoreRef] = useState<RefObject<HTMLButtonElement | null>>(projectRef)
  const active = state.status?.state === 'IN_PROGRESS' ? state.status : undefined
  const activeReceipt = state.inProgressReceipt?.state === 'IN_PROGRESS' ? state.inProgressReceipt : undefined
  const activePhase = active?.phase ?? activeReceipt?.phase ?? (activeReceipt === undefined ? undefined : 'HIDING')
  const disabled = state.previewPending || state.mutationPending || active !== undefined || activeReceipt !== undefined
  return createElement('section', { 'aria-labelledby': 'run2skill-purge-heading' },
    createElement('h3', { id: 'run2skill-purge-heading' }, '清理 run2skill 数据'),
    createElement('p', null, '清理只影响 run2skill 派生数据；不会删除 DSH Session Log 或已发布 Skill。'),
    createElement('button', {
      ref: projectRef,
      type: 'button',
      disabled,
      onClick: () => {
        setRestoreRef(projectRef)
        void props.controller.preview('PROJECT')
      },
    }, '预览并清理当前 PROJECT 数据'),
    createElement('button', {
      ref: userRef,
      type: 'button',
      disabled,
      onClick: () => {
        setRestoreRef(userRef)
        void props.controller.preview('USER')
      },
    }, '预览并清理 USER 数据'),
    state.statusPhase === 'LOADING' ? createElement('p', { role: 'status' }, '正在读取 Purge 状态…') : null,
    state.statusPhase === 'UNAVAILABLE' ? createElement('p', { role: 'alert' }, 'Purge 状态暂不可用') : null,
    state.statusPhase === 'STALE' ? createElement('p', { role: 'status' }, 'Purge 状态可能已过期') : null,
    state.previewPending ? createElement('p', { role: 'status' }, '正在生成清理预览…') : null,
    activePhase === undefined
      ? null
      : createElement('div', { role: 'status', 'aria-label': '当前 Purge 状态' },
          createElement('p', null, phaseCopy[activePhase]),
          createElement('p', null,
            `已删除 ${String(active?.deletedWorkItems ?? activeReceipt?.deletedWorkItems ?? 0)} 条待处理数据和 ${String(active?.deletedLineages ?? activeReceipt?.deletedLineages ?? 0)} 条发布沿袭记录。`,
          ),
          active?.lastError === undefined
            ? null
            : createElement(Fragment, null,
                createElement('p', { role: 'alert' }, `清理失败：${active.lastError.code}`),
                createElement('button', {
                  type: 'button',
                  disabled: state.mutationPending,
                  onClick: () => { void props.controller.retry() },
                }, state.mutationPending ? '正在重试…' : '重试清理'),
              ),
        ),
    state.error === undefined ? null : createElement('p', { role: 'alert' }, state.announcement),
    createElement('div', {
      role: 'status',
      'aria-label': 'Purge 状态播报',
      'aria-live': 'polite',
      'aria-atomic': true,
    }, state.announcement),
    createElement(PurgeConfirmationDialog, {
      controller: props.controller,
      state,
      restoreFocusRef: restoreRef,
    }),
  )
}
