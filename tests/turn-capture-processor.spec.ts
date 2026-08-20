import { describe, expect, it, vi } from 'vitest'
import { DurableCaptureStore } from '../src/adapters/dsh-storage/durable-capture-store.js'
import { TurnCaptureProcessor } from '../src/application/capture/turn-capture-processor.js'
import { DurableCaptureCoordinator } from '../src/application/capture/durable-capture-coordinator.js'
import { RuntimeNotices } from '../src/application/capture/runtime-notices.js'
import { WriteBehindCheckpoint } from '../src/application/capture/write-behind-checkpoint.js'
import { deriveSessionCwdDigest, deriveSessionLifecycleKey } from '../src/domain/observe/signal-key.js'
import type { SessionCheckpointV1 } from '../src/domain/observe/schemas.js'
import { analyzeCheapTriggerV1 } from '../src/domain/observe/trigger.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'

const header = {
  version: 1,
  id: 'root-session',
  createdAt: 1_725_000_000_000,
  cwd: 'D:/work/demo',
} as const

function turn(text: string, outcomeKind = 'completed') {
  return [
    { type: 'turn/start', seq: 10, time: 1_725_000_001_000, data: { turn: 3 } },
    {
      type: 'user/message', seq: 11, time: 1_725_000_001_010,
      data: {
        id: 'message-1', source: { kind: 'user' },
        content: [{ type: 'text', text }],
      },
    },
    {
      type: 'turn/end', seq: 12, time: 1_725_000_002_000,
      data: { turn: 3, reason: { kind: outcomeKind } },
    },
  ]
}

function progress(): SessionCheckpointV1 {
  return {
    rootSessionId: header.id,
    sessionCreatedAt: header.createdAt,
    sessionCwdDigest: deriveSessionCwdDigest(header.cwd),
    triggerPolicyVersion: 'cheap-trigger-v1',
    activationFenceSeq: 10,
    durableNextSeq: 13,
    observedTailSeq: 12,
  }
}

async function setup(
  resolveWorkspace = vi.fn(async () => ({
  status: 'BOUND' as const,
  workspaceId: 'workspace-1',
  canonicalPath: 'D:/work/demo',
  })),
  automaticLearning = true,
  analyze = analyzeCheapTriggerV1,
) {
  const domain = createMemoryRun2skillDomain()
  const checkpoint = new WriteBehindCheckpoint(domain)
  await checkpoint.activate([{ ...progress(), durableNextSeq: 10, observedTailSeq: 9 }])
  const notices = new RuntimeNotices()
  const store = new DurableCaptureStore(domain)
  const coordinator = new DurableCaptureCoordinator(store, checkpoint, notices)
  return {
    domain,
    checkpoint,
    notices,
    processor: new TurnCaptureProcessor(
      coordinator,
      notices,
      { resolve: resolveWorkspace },
      { snapshot: () => ({ automaticLearning }) },
      analyze,
    ),
    resolveWorkspace,
  }
}

describe('TurnCaptureProcessor', () => {
  it('persists one deterministic redacted WorkItem for a direct-user trigger', async () => {
    const fixture = await setup()
    const secret = 'synthetic-provider-value'
    const input = {
      header,
      events: turn(`把这个流程保存成 Skill。 deepseekKey=${secret}`),
      turnEndSeq: 12,
      progress: progress(),
    }

    await fixture.processor.processTurn(input)
    await fixture.processor.processTurn(input)

    const items = [...fixture.domain.table('work_items').entries()].map(([, item]) => item)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      revision: 1,
      createdAt: '2024-08-30T06:40:02.000Z',
      updatedAt: '2024-08-30T06:40:02.000Z',
      captureReason: 'CHEAP_TRIGGER',
      scanStatus: 'COMPLETE',
      workspaceBinding: {
        status: 'BOUND', workspaceId: 'workspace-1', canonicalPath: 'D:/work/demo',
        observedAt: '2024-08-30T06:40:02.000Z',
      },
    })
    expect(JSON.stringify(items)).not.toContain(secret)
    expect(fixture.resolveWorkspace).toHaveBeenCalledTimes(2)
  })

  it('does not create a WorkItem for an ordinary complete Turn', async () => {
    const fixture = await setup()

    await fixture.processor.processTurn({
      header, events: turn('请解释一下这个函数。'), turnEndSeq: 12, progress: progress(),
    })

    expect(fixture.domain.table('work_items').size).toBe(0)
    expect(fixture.resolveWorkspace).not.toHaveBeenCalled()
    const lifecycleKey = deriveSessionLifecycleKey({
      rootSessionId: header.id,
      sessionCreatedAt: header.createdAt,
      sessionCwdDigest: deriveSessionCwdDigest(header.cwd),
    })
    expect(fixture.checkpoint.snapshot().sessions[lifecycleKey]?.durableNextSeq).toBe(13)
  })

  it('does not create an ordinary triggered WorkItem while Automatic Learning is OFF', async () => {
    const fixture = await setup(undefined, false)

    await fixture.processor.processTurn({
      header,
      events: turn('这个项目以后必须统一使用 pnpm。'),
      turnEndSeq: 12,
      progress: progress(),
    })

    expect(fixture.domain.table('work_items').size).toBe(0)
    expect(fixture.checkpoint.snapshot().checkpoint.dirty).toBe(true)
  })

  it('keeps explicit save durable while Automatic Learning is OFF', async () => {
    const fixture = await setup(undefined, false)

    await fixture.processor.processTurn({
      header,
      events: turn('把这个流程保存成 Skill。'),
      turnEndSeq: 12,
      progress: progress(),
    })

    const item = [...fixture.domain.table('work_items').entries()][0]?.[1]
    expect(item?.triggerHits.some(hit => hit.kind === 'EXPLICIT_SAVE')).toBe(true)
    expect(item?.processingState).toBe('CAPTURED')
  })

  it('keeps an incomplete metadata record and closes it when a later OFF scan finds only ordinary triggers', async () => {
    let attempt = 0
    const fixture = await setup(undefined, false, (messages, options) => {
      attempt += 1
      return attempt === 1
        ? { status: 'INCOMPLETE', captureBlockers: ['REDACTION_UNAVAILABLE'], triggerHits: [], evidenceRefs: [] }
        : analyzeCheapTriggerV1(messages, options)
    })
    const input = {
      header,
      events: turn('这个项目以后必须统一使用 pnpm。'),
      turnEndSeq: 12,
      progress: progress(),
    } as const

    await fixture.processor.processTurn(input)
    expect([...fixture.domain.table('work_items').entries()][0]?.[1]).toMatchObject({
      scanStatus: 'COMPLETE', processingState: 'RESOLVED_NO_SIGNAL', triggerHits: [],
    })
    expect(fixture.domain.writeLog.filter(entry => entry === 'work_items')).toHaveLength(2)
  })

  it('persists metadata only when trigger scanning exceeds its text bound', async () => {
    const fixture = await setup()

    await fixture.processor.processTurn({
      header, events: turn('字'.repeat(64 * 1024 + 1)), turnEndSeq: 12, progress: progress(),
    })

    const item = [...fixture.domain.table('work_items').entries()][0]?.[1]
    expect(item).toMatchObject({
      captureReason: 'SCAN_INCOMPLETE',
      scanStatus: 'INCOMPLETE',
      captureBlockers: ['TEXT_LIMIT_EXCEEDED'],
      triggerHits: [],
      evidenceRefs: [],
    })
  })

  it.each(['error', 'aborted'])('captures a direct-user signal when the Turn ends as %s', async (outcomeKind) => {
    const fixture = await setup()

    await fixture.processor.processTurn({
      header,
      events: turn('把这个流程保存成 Skill。', outcomeKind),
      turnEndSeq: 12,
      progress: progress(),
    })

    const item = [...fixture.domain.table('work_items').entries()][0]?.[1]
    expect(item).toMatchObject({ captureReason: 'CHEAP_TRIGGER', turnOutcomeKind: outcomeKind })
  })

  it('uses NO_CWD without asking the workspace registry', async () => {
    const fixture = await setup()
    const { cwd: _cwd, ...noCwd } = header
    const noCwdProgress = { ...progress(), sessionCwdDigest: deriveSessionCwdDigest(undefined) }
    await fixture.checkpoint.activate([{
      ...noCwdProgress,
      durableNextSeq: 10,
      observedTailSeq: 9,
    }])

    await fixture.processor.processTurn({
      header: noCwd,
      events: turn('把这个流程保存成 Skill。'),
      turnEndSeq: 12,
      progress: noCwdProgress,
    })

    const item = [...fixture.domain.table('work_items').entries()][0]?.[1]
    expect(item?.workspaceBinding.status).toBe('NO_CWD')
    expect(fixture.resolveWorkspace).not.toHaveBeenCalled()
  })

  it('fails closed without advancing the checkpoint when the Turn boundary is incomplete', async () => {
    const fixture = await setup()
    const before = fixture.checkpoint.snapshot()

    await expect(fixture.processor.processTurn({
      header,
      events: turn('把这个流程保存成 Skill。').slice(1),
      turnEndSeq: 12,
      progress: progress(),
    })).rejects.toThrow('TURN_BOUNDARY_INCOMPLETE')

    expect(fixture.checkpoint.snapshot()).toEqual(before)
    expect(fixture.notices.list()).toMatchObject([{
      healthCode: 'TURN_BOUNDARY_INCOMPLETE', sessionId: header.id, turnEndSeq: 12,
    }])
  })
})
