import { describe, expect, it, vi } from 'vitest'
import { ProposalReviewStore } from '../src/adapters/dsh-storage/proposal-review-store.js'
import { createProposalReviewRpcHandler } from '../src/adapters/dsh-connection/proposal-review-rpc.js'
import { CurrentScopeAuthorizer } from '../src/adapters/dsh-connection/current-scope-authorizer.js'
import { PurgeVisibility } from '../src/application/purge/index.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import { materializeProposalSnapshot } from '../src/domain/review/index.js'
import {
  ProposalInboxController,
  ProposalTextView,
  describeProposalOutcome,
  makeExactLineDiff,
  makeSafeText,
  type ProposalPollEnvironment,
} from '../src/client/proposal-inbox.js'
import {
  RejectConfirmationBody,
  describeProposalSummaryState,
  factsFromAction,
  proposalDetailAction,
  proposalInboxContentBlocked,
  trapDialogTab,
} from '../src/client/proposal-inbox-view.js'
import { parseProposalDetail } from '../src/client/proposal-inbox-wire.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import {
  makeCreateProposalSnapshot,
  makeDiscardProposalSnapshot,
  makeLearnedWorkItem,
} from './support/review-fixture.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

function makeMergeProposal(item = makeLearnedWorkItem()) {
  const create = makeCreateProposalSnapshot(item)
  if (create.actionBinding.kind !== 'CREATE') throw new Error('fixture must be CREATE')
  const { proposalId: _proposalId, digest: _digest, ...facts } = create
  const baseBytes = create.exactSkillBytes.replace('# Generated file hygiene', '# Existing file hygiene')
  return materializeProposalSnapshot(item.workItemId, {
    ...facts,
    kind: 'MERGE',
    actionBinding: {
      kind: 'MERGE',
      rootBinding: create.actionBinding.rootBinding,
      targetBinding: create.actionBinding.targetBinding,
      baseBinding: {
        candidateKey: `cand_${'e'.repeat(64)}`,
        provider: 'filesystem',
        source: 'project-dsh',
        path: 'D:\\workspace\\.dsh\\skills\\generated-file-hygiene\\SKILL.md',
        exactBytes: baseBytes,
        bytesDigest: sha256Utf8(baseBytes),
        catalogObservationDigest: create.catalogObservationDigest,
        observedAt: create.createdAt,
      },
    },
  })
}

function fakeEnvironment(initiallyVisible = true): ProposalPollEnvironment & {
  focus(): void
  reconnect(): void
  setVisible(value: boolean): void
  tick(): void
  timerCount(): number
  timerDelay(): number | undefined
} {
  let visible = initiallyVisible
  let nextTimer = 0
  const timers = new Map<number, { callback: () => void; delayMs: number }>()
  const focus = new Set<() => void>()
  const visibility = new Set<() => void>()
  const online = new Set<() => void>()
  return {
    isVisible: () => visible,
    setInterval(callback, delayMs) {
      expect([2_000, 10_000]).toContain(delayMs)
      const id = nextTimer++
      timers.set(id, { callback, delayMs })
      return id
    },
    clearInterval(handle) { timers.delete(handle as number) },
    onFocus(listener) { focus.add(listener); return () => { focus.delete(listener) } },
    onVisibilityChange(listener) { visibility.add(listener); return () => { visibility.delete(listener) } },
    onOnline(listener) { online.add(listener); return () => { online.delete(listener) } },
    focus() { for (const listener of focus) listener() },
    reconnect() { for (const listener of online) listener() },
    setVisible(value) { visible = value; for (const listener of visibility) listener() },
    tick() { for (const timer of timers.values()) timer.callback() },
    timerCount: () => timers.size,
    timerDelay: () => [...timers.values()][0]?.delayMs,
  }
}

const currentScope = { kind: 'WORKSPACE' as const, generation: 1, workspaceId: 'workspace-fixture' }
const authorizer = new CurrentScopeAuthorizer(async workspaceId => workspaceId === 'workspace-fixture'
  ? { workspaceId, canonicalPath: 'D:\\workspace' }
  : undefined)

async function securedReview(domain: ReturnType<typeof createMemoryRun2skillDomain>) {
  const actions = (await authorizer.project(domain, currentScope, new PurgeVisibility(domain))).flatMap(action => (
    action.proposalRef === undefined ? [] : [{
      actionKey: action.actionKey,
      subjectId: action.subjectId,
      kind: action.kind as 'REVIEW_PROPOSAL' | 'RETRY_PUBLICATION',
      proposalRef: action.proposalRef,
    }]
  ))
  return {
    scopeAccess: () => ({ currentScope, actions }),
    host: createProposalReviewRpcHandler(() => domain, undefined, { authorizer }),
  }
}

describe('Proposal Inbox client', () => {
  it('visualizes hidden format characters while raw text remains byte-for-byte content', () => {
    const raw = 'safe\u202Ehidden\u200B\t\u0000\nnext'
    const safe = makeSafeText(raw)
    expect(safe).toContain('[U+202E RIGHT-TO-LEFT OVERRIDE]')
    expect(safe).toContain('[U+200B ZERO WIDTH SPACE]')
    expect(safe).toContain('[U+0009 CHARACTER TABULATION]')
    expect(safe).toContain('[U+0000 NULL]')
    expect(safe).toContain('\nnext')

    const safeElement = ProposalTextView({ value: raw, mode: 'SAFE', label: 'safe view' })
    const rawElement = ProposalTextView({ value: raw, mode: 'RAW', label: 'raw view' })
    expect(safeElement.type).toBe('pre')
    expect(safeElement.props.children).toBe(safe)
    expect(rawElement.type).toBe('pre')
    expect(rawElement.props.children).toBe(raw)
    expect(rawElement.props.dangerouslySetInnerHTML).toBeUndefined()
  })

  it('produces an exact deterministic line transformation for MERGE review', () => {
    expect(makeExactLineDiff('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual([
      { kind: 'CONTEXT', text: 'a' },
      { kind: 'REMOVE', text: 'b' },
      { kind: 'ADD', text: 'B' },
      { kind: 'CONTEXT', text: 'c' },
      { kind: 'ADD', text: 'd' },
      { kind: 'CONTEXT', text: '' },
    ])
  })

  it('announces publishing and truthful terminal outcomes', () => {
    expect(describeProposalOutcome({ processingState: 'PUBLISHING', publicationOutcome: 'PENDING_REVIEW' }))
      .toContain('正在发布')
    expect(describeProposalOutcome({ processingState: 'TERMINAL', publicationOutcome: 'PUBLISHED' }))
      .toContain('完成 Registry 回读')
    expect(describeProposalOutcome({ processingState: 'NEEDS_ATTENTION', publicationOutcome: 'NEEDS_REFRESH' }))
      .toContain('新的 Proposal')
  })

  it('uses one factual vocabulary for publishing and retryable failure', () => {
    expect(describeProposalOutcome({ processingState: 'PUBLISHING', publicationOutcome: 'PENDING_REVIEW' }))
      .toBe('已批准，正在发布')
    expect(describeProposalOutcome({ processingState: 'NEEDS_ATTENTION', publicationOutcome: 'PUBLISH_FAILED' }))
      .toBe('发布失败，可重试')
    expect(proposalDetailAction({
      reviewDecision: 'APPROVED',
      processingState: 'NEEDS_ATTENTION',
      publicationOutcome: 'PUBLISH_FAILED',
    }, false)).toBe('RETRY_PUBLICATION')
  })

  it('never exposes absolute Workspace, DSH Home, root, or Skill target paths in review facts', () => {
    const item = makeLearnedWorkItem()
    const proposal = makeCreateProposalSnapshot(item)
    const facts = factsFromAction({ proposal } as never)
    expect(facts).toContain(`Skill name: ${proposal.name}`)
    expect(facts).not.toMatch(/[A-Z]:\\|\/home\/|Declared root|Bundle target|Skill target|Flat target/iu)
  })

  it('gives UNKNOWN, RECOVERING, DEGRADED, and INCOMPATIBLE explicit summary copy', () => {
    const base = {
      open: false,
      summaryPhase: 'READY' as const,
      listPhase: 'IDLE' as const,
      items: [],
      detailPhase: 'IDLE' as const,
      mutationPending: false,
      announcement: '',
    }
    for (const [status, copy] of [
      ['RECOVERING', 'run2skill 正在恢复历史观察'],
      ['DEGRADED', 'run2skill 暂时降级'],
      ['INCOMPATIBLE', 'run2skill 当前版本不兼容'],
    ] as const) {
      expect(describeProposalSummaryState({
        ...base,
        summary: {
          apiVersion: 1,
          status,
          recoveryLag: status === 'RECOVERING',
          queue: { completeness: 'UNKNOWN' },
        },
      })).toBe(`${copy}；待处理数量未知`)
    }
  })

  it('traps keyboard focus at both dialog boundaries', () => {
    const first = { focus: vi.fn() }
    const middle = { focus: vi.fn() }
    const last = { focus: vi.fn() }
    const root = { querySelectorAll: vi.fn(() => [first, middle, last]) }
    const preventBackwards = vi.fn()
    trapDialogTab('Tab', true, preventBackwards, root, first)
    expect(preventBackwards).toHaveBeenCalledTimes(1)
    expect(last.focus).toHaveBeenCalledTimes(1)

    const preventForwards = vi.fn()
    trapDialogTab('Tab', false, preventForwards, root, last)
    expect(preventForwards).toHaveBeenCalledTimes(1)
    expect(first.focus).toHaveBeenCalledTimes(1)

    const preventInside = vi.fn()
    trapDialogTab('Tab', false, preventInside, root, middle)
    expect(preventInside).not.toHaveBeenCalled()

    const preventEscaped = vi.fn()
    trapDialogTab('Tab', false, preventEscaped, root, { focus: vi.fn() })
    expect(preventEscaped).toHaveBeenCalledTimes(1)
    expect(first.focus).toHaveBeenCalledTimes(2)

    const preventReverseEscape = vi.fn()
    trapDialogTab('Tab', true, preventReverseEscape, root, { focus: vi.fn() })
    expect(preventReverseEscape).toHaveBeenCalledTimes(1)
    expect(last.focus).toHaveBeenCalledTimes(2)
  })

  it('requires an explicit Reject confirmation and cancellation has no side effect', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    const element = RejectConfirmationBody({ disabled: false, onCancel, onConfirm })
    const children = element.props.children as Array<{ type: string; props: Record<string, unknown> }>
    const copy = children.find(child => child.type === 'p')?.props.children
    const buttons = children.filter(child => child.type === 'button')
    expect(buttons).toHaveLength(2)
    expect(copy).toContain('现有 Skill 不会改变')
    expect(copy).toContain('Evidence 仍按项目策略保留')
    ;(buttons[0]!.props.onClick as () => void)()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
    ;(buttons[1]!.props.onClick as () => void)()
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(proposalInboxContentBlocked(false, true)).toBe(true)
    expect(proposalInboxContentBlocked(false, false)).toBe(false)
  })

  it('loads summary/list/detail lazily and approves using only the immutable reference', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeLearnedWorkItem()
    domain.workItems.set(item.workItemId, item)
    const staged = await new ProposalReviewStore(domain).stage(
      item.workItemId,
      item.revision,
      makeCreateProposalSnapshot(item),
    )
    const { host, scopeAccess } = await securedReview(domain)
    const call = vi.fn(async (endpoint: string, payload: unknown, signal: AbortSignal) => (
      await host(endpoint, payload, signal)
    ))
    const environment = fakeEnvironment()
    const controller = new ProposalInboxController('workspace-fixture', call, environment, { scopeAccess })

    controller.start()
    await controller.whenIdle()
    expect(controller.snapshot().summary?.queue).toEqual({
      completeness: 'KNOWN', pendingReview: 1, publishing: 0, needsAttention: 0,
    })
    expect(controller.snapshot().items).toEqual([])

    await controller.open()
    expect(controller.snapshot()).toMatchObject({ open: true, listPhase: 'READY' })
    expect(controller.snapshot().items).toHaveLength(1)
    expect(environment.timerDelay()).toBe(2_000)
    expect(call.mock.calls.some(([endpoint]) => endpoint === 'proposals/get')).toBe(false)

    await controller.select(staged.item.review!.proposal.proposalId)
    expect(controller.snapshot().detail?.proposal.exactSkillBytes)
      .toBe(staged.item.review!.proposal.exactSkillBytes)
    expect(factsFromAction(controller.snapshot().detail!)).toContain('Root contract: stock-dsh-web-default-roots-v1')
    expect(factsFromAction(controller.snapshot().detail!)).toContain('Expected provider/source: filesystem / project-dsh')

    await controller.mutate('APPROVE')
    expect(controller.snapshot().announcement).toContain('正在发布')
    expect(controller.snapshot().detail).toMatchObject({
      reviewDecision: 'APPROVED', processingState: 'PUBLISHING', publicationOutcome: 'PENDING_REVIEW',
    })
    expect(environment.timerDelay()).toBe(2_000)
    expect(domain.workItems.get(item.workItemId)?.review?.reviewDecision).toBe('APPROVED')
    const approveCall = call.mock.calls.find(([endpoint]) => endpoint === 'proposals/approve')
    expect(approveCall?.[1]).toMatchObject({
      apiVersion: 1,
      workItemId: item.workItemId,
      workItemRevision: staged.item.revision,
      proposalRef: {
        proposalId: staged.item.review!.proposal.proposalId,
        revision: staged.item.review!.proposal.revision,
        digest: staged.item.review!.proposal.digest,
      },
      currentScope,
    })
    controller.close()
    expect(environment.timerDelay()).toBe(10_000)
    controller.dispose()
  })

  it('pauses all host-tab summary/detail polling and resumes without timer leaks', async () => {
    const domain = createMemoryRun2skillDomain()
    const { host, scopeAccess } = await securedReview(domain)
    const call = vi.fn(async (endpoint: string, payload: unknown, signal: AbortSignal) => (
      await host(endpoint, payload, signal)
    ))
    const environment = fakeEnvironment()
    const controller = new ProposalInboxController('workspace-fixture', call, environment, { scopeAccess })
    controller.start()
    await controller.whenIdle()
    expect(environment.timerCount()).toBe(1)

    controller.pause()
    expect(environment.timerCount()).toBe(0)
    controller.resume()
    await controller.whenIdle()
    expect(environment.timerCount()).toBe(1)
    expect(call.mock.calls.filter(([endpoint]) => endpoint === 'summary')).toHaveLength(2)

    controller.dispose()
    expect(environment.timerCount()).toBe(0)
  })

  it('uses Attention as the only queue summary when embedded in the settings surface', async () => {
    const domain = createMemoryRun2skillDomain()
    const { host } = await securedReview(domain)
    const call = vi.fn(async (endpoint: string, payload: unknown, signal: AbortSignal) => (
      await host(endpoint, payload, signal)
    ))
    const environment = fakeEnvironment()
    const controller = new ProposalInboxController(
      'workspace-fixture',
      call,
      environment,
      { attentionDriven: true },
    )

    controller.start()
    await controller.whenIdle()
    await controller.open()

    expect(call.mock.calls.some(([endpoint]) => endpoint === 'summary')).toBe(false)
    expect(call.mock.calls.some(([endpoint]) => endpoint === 'proposals/list')).toBe(true)
    controller.dispose()
  })

  it('keeps a successful mutation receipt when the immediate refresh fails', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeLearnedWorkItem()
    domain.workItems.set(item.workItemId, item)
    const staged = await new ProposalReviewStore(domain).stage(
      item.workItemId,
      item.revision,
      makeCreateProposalSnapshot(item),
    )
    const { host, scopeAccess } = await securedReview(domain)
    let failNextSummary = false
    const controller = new ProposalInboxController(
      'workspace-fixture',
      async (calledEndpoint, payload, signal) => {
        if (calledEndpoint === 'summary' && failNextSummary) throw new Error('offline after receipt')
        const response = await host(calledEndpoint, payload, signal)
        if (calledEndpoint === 'proposals/approve') failNextSummary = true
        return response
      },
      fakeEnvironment(),
      { scopeAccess },
    )

    controller.start()
    await controller.whenIdle()
    await controller.open()
    await controller.select(staged.item.review!.proposal.proposalId)
    await controller.mutate('APPROVE')

    expect(domain.workItems.get(item.workItemId)?.review?.reviewDecision).toBe('APPROVED')
    expect(controller.snapshot()).toMatchObject({
      mutationPending: false,
      summaryPhase: 'STALE',
      announcement: '已批准，正在发布',
      detail: { reviewDecision: 'APPROVED', processingState: 'PUBLISHING' },
    })
    controller.dispose()
  })

  it('confirms a DISCARD coverage decision without ever calling approve', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeLearnedWorkItem()
    domain.workItems.set(item.workItemId, item)
    const staged = await new ProposalReviewStore(domain).stage(
      item.workItemId,
      item.revision,
      makeDiscardProposalSnapshot(item),
    )
    const { host, scopeAccess } = await securedReview(domain)
    const call = vi.fn(async (endpoint: string, payload: unknown, signal: AbortSignal) => (
      await host(endpoint, payload, signal)
    ))
    const controller = new ProposalInboxController('workspace-fixture', call, fakeEnvironment(), { scopeAccess })

    controller.start()
    await controller.whenIdle()
    await controller.open()
    await controller.select(staged.item.review!.proposal.proposalId)
    expect(controller.snapshot().detail?.proposal.kind).toBe('DISCARD')
    await controller.mutate('CONFIRM_DISCARD')

    expect(domain.workItems.get(item.workItemId)?.review).toMatchObject({
      reviewDecision: 'REJECTED',
      publicationOutcome: 'DISCARDED',
      decisionReason: 'COVERAGE_CONFIRMED',
    })
    expect(call.mock.calls.some(([calledEndpoint]) => calledEndpoint === 'proposals/approve')).toBe(false)
    controller.dispose()
  })

  it('loads a MERGE Base and exact target for review without mutating either', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeLearnedWorkItem()
    const proposal = makeMergeProposal(item)
    domain.workItems.set(item.workItemId, item)
    const staged = await new ProposalReviewStore(domain).stage(item.workItemId, item.revision, proposal)
    const { host, scopeAccess } = await securedReview(domain)
    const controller = new ProposalInboxController(
      'workspace-fixture',
      async (calledEndpoint, payload, signal) => await host(calledEndpoint, payload, signal),
      fakeEnvironment(),
      { scopeAccess },
    )

    controller.start()
    await controller.whenIdle()
    await controller.open()
    await controller.select(staged.item.review!.proposal.proposalId)
    const detail = controller.snapshot().detail
    expect(detail?.proposal.actionBinding).toMatchObject({
      kind: 'MERGE',
      targetBinding: { skillName: 'generated-file-hygiene' },
      baseBinding: { exactBytes: expect.stringContaining('Existing file hygiene') },
    })
    expect(domain.workItems.get(item.workItemId)?.review?.reviewDecision).toBe('PENDING')
    controller.dispose()
  })

  it('rejects a response whose Proposal kind disagrees with its action binding', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeLearnedWorkItem()
    domain.workItems.set(item.workItemId, item)
    const staged = await new ProposalReviewStore(domain).stage(
      item.workItemId,
      item.revision,
      makeCreateProposalSnapshot(item),
    )
    const { host, scopeAccess } = await securedReview(domain)
    const action = scopeAccess().actions[0]!
    const response = await host('proposals/get', {
      apiVersion: 1,
      currentScope,
      action,
      proposalId: staged.item.review!.proposal.proposalId,
    }, new AbortController().signal)
    const mismatched = structuredClone(response) as {
      value: { proposal: { kind: 'CREATE' | 'MERGE' | 'DISCARD' } }
    }
    mismatched.value.proposal.kind = 'MERGE'

    expect(parseProposalDetail(mismatched)).toBeUndefined()
  })

  it('projects review detail without any absolute Workspace, root, or Skill target path', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeLearnedWorkItem()
    domain.workItems.set(item.workItemId, item)
    const staged = await new ProposalReviewStore(domain).stage(
      item.workItemId,
      item.revision,
      makeCreateProposalSnapshot(item),
    )
    const { host, scopeAccess } = await securedReview(domain)
    const response = await host('proposals/get', {
      apiVersion: 1,
      currentScope,
      action: scopeAccess().actions[0],
      proposalId: staged.item.review!.proposal.proposalId,
    }, new AbortController().signal)
    expect(response).toMatchObject({ ok: true, value: { proposal: {
      workspaceBinding: { workspaceId: 'workspace-fixture' },
      actionBinding: { targetBinding: { skillName: 'generated-file-hygiene' } },
    } } })
    const wire = JSON.stringify(response)
    expect(wire).not.toContain('D:\\workspace')
    expect(wire).not.toMatch(/canonicalPath|declaredRootPath|bundlePath|skillFilePath|flatSkillFilePath|"path"/)
    expect(parseProposalDetail(response)).toBeDefined()
  })

  it('stops while hidden and refreshes on visibility, focus, and reconnect', async () => {
    const environment = fakeEnvironment(false)
    let lastSignal: AbortSignal | undefined
    const call = vi.fn(async (_endpoint: string, _payload: unknown, signal: AbortSignal) => {
      lastSignal = signal
      return {
        ok: true,
        value: {
          apiVersion: 1,
          status: 'READY',
          recoveryLag: false,
          queue: { completeness: 'KNOWN', pendingReview: 0, publishing: 0, needsAttention: 0 },
        },
      }
    })
    const controller = new ProposalInboxController('workspace-fixture', call, environment)

    controller.start()
    expect(call).not.toHaveBeenCalled()
    expect(environment.timerCount()).toBe(0)
    environment.setVisible(true)
    await controller.whenIdle()
    expect(call).toHaveBeenCalledTimes(1)
    expect(environment.timerCount()).toBe(1)
    environment.focus()
    await controller.whenIdle()
    environment.reconnect()
    await controller.whenIdle()
    environment.tick()
    await controller.whenIdle()
    expect(call).toHaveBeenCalledTimes(4)
    environment.setVisible(false)
    expect(environment.timerCount()).toBe(0)
    controller.dispose()
    expect(lastSignal?.aborted).toBe(false)
  })

  it('aborts an in-flight request and ignores its result on dispose', async () => {
    const pending = deferred<unknown>()
    let signal: AbortSignal | undefined
    const controller = new ProposalInboxController(
      'workspace-fixture',
      (_endpoint, _payload, requestSignal) => {
        signal = requestSignal
        return pending.promise
      },
      fakeEnvironment(),
    )
    controller.start()
    expect(signal?.aborted).toBe(false)
    controller.dispose()
    expect(signal?.aborted).toBe(true)
    pending.resolve({
      ok: true,
      value: {
        apiVersion: 1,
        status: 'READY',
        recoveryLag: false,
        queue: { completeness: 'KNOWN', pendingReview: 0, publishing: 0, needsAttention: 0 },
      },
    })
    await controller.whenIdle()
    expect(controller.snapshot().summaryPhase).toBe('LOADING')
  })
})
