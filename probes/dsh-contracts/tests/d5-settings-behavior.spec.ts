import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  registerAutomaticLearningSettings,
  type DshSettingsPort,
} from '../src/adapters/dsh-settings/automatic-learning.js'
import { openRun2skillDomain } from '../src/adapters/dsh-storage/domain.js'
import { DurableCaptureStore } from '../src/adapters/dsh-storage/durable-capture-store.js'
import { DurableCaptureCoordinator } from '../src/application/capture/durable-capture-coordinator.js'
import { RuntimeNotices } from '../src/application/capture/runtime-notices.js'
import { TurnCaptureProcessor } from '../src/application/capture/turn-capture-processor.js'
import { WriteBehindCheckpoint } from '../src/application/capture/write-behind-checkpoint.js'
import { LearningScheduler } from '../src/application/learn/learning-scheduler.js'
import type { CaptureWorkItemV1, SessionCheckpointV1 } from '../src/domain/observe/schemas.js'
import { deriveSessionCwdDigest } from '../src/domain/observe/signal-key.js'
import { makeWorkItem } from './support/work-item-fixture.js'

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

const cleanup = new Set<string>()

afterEach(async () => {
  await Promise.all([...cleanup].map(async path => await rm(path, { recursive: true, force: true })))
  cleanup.clear()
})

function header(id: string, createdAt: number) {
  return { version: 1 as const, id, createdAt, cwd: 'D:/work/d5-settings' }
}

function events(text: string) {
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
      data: { turn: 3, reason: { kind: 'completed' } },
    },
  ]
}

function progress(id: string, createdAt: number, durableNextSeq = 13): SessionCheckpointV1 {
  return {
    rootSessionId: id,
    sessionCreatedAt: createdAt,
    sessionCwdDigest: deriveSessionCwdDigest('D:/work/d5-settings'),
    triggerPolicyVersion: 'cheap-trigger-v1',
    activationFenceSeq: 10,
    durableNextSeq,
    observedTailSeq: durableNextSeq - 1,
  }
}

function queuedItem(
  sessionId: string,
  turnEndSeq: number,
  kind: 'EXPLICIT_SAVE' | 'CONSTRAINT',
): CaptureWorkItemV1 {
  return makeWorkItem({
    signalKey: {
      ...makeWorkItem().signalKey,
      rootSessionId: sessionId,
      turn: turnEndSeq,
      turnEndSeq,
      turnInstanceDigest: (kind === 'EXPLICIT_SAVE' ? 'b' : 'a').repeat(64),
    },
    triggerHits: [{
      kind,
      messageSeq: turnEndSeq,
      ruleId: kind === 'EXPLICIT_SAVE'
        ? 'ctv1.explicit-save.save-target'
        : 'ctv1.constraint.persistent-operator',
      confidence: 'HIGH',
    }],
  })
}

describe('D5 Automatic Learning semantics on stock DSH Settings and Storage', () => {
  it('enforces OFF/explicit capture and freezes the launch-time analysis snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-run2skill-d5-settings-'))
    cleanup.add(root)
    const ctx = new Context()
    const settingsFiber = ctx.plugin(MemorySettings)
    await settingsFiber.await()
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(root, 'storage') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await vi.waitFor(() => { expect(ctx.storageDomain).toBeDefined() })
    const domain = await openRun2skillDomain(ctx)
    try {
      const policy = registerAutomaticLearningSettings(ctx.settings as unknown as DshSettingsPort)
      const namespace = 'run2skill' as SettingsNamespace
      expect(policy.snapshot()).toEqual({ automaticLearning: true })
      await ctx.settings.update(namespace, { automaticLearning: false })
      expect(policy.snapshot()).toEqual({ automaticLearning: false })

      const ordinary = { id: 'ordinary-session', createdAt: 1_725_000_000_000 }
      const explicit = { id: 'explicit-session', createdAt: 1_725_000_000_100 }
      const checkpoint = new WriteBehindCheckpoint(domain, { turnBatch: 1 })
      await checkpoint.activate([
        progress(ordinary.id, ordinary.createdAt, 10),
        progress(explicit.id, explicit.createdAt, 10),
      ])
      const notices = new RuntimeNotices()
      const processor = new TurnCaptureProcessor(
        new DurableCaptureCoordinator(new DurableCaptureStore(domain), checkpoint, notices),
        notices,
        { resolve: async cwd => ({ status: 'BOUND', workspaceId: 'workspace-d5', canonicalPath: cwd }) },
        policy,
      )

      await processor.processTurn({
        header: header(ordinary.id, ordinary.createdAt),
        events: events('这个项目以后必须统一使用 pnpm。'),
        turnEndSeq: 12,
        progress: progress(ordinary.id, ordinary.createdAt),
      })
      expect([...domain.table('work_items').entries()]).toHaveLength(0)

      await processor.processTurn({
        header: header(explicit.id, explicit.createdAt),
        events: events('把这个流程保存成 Skill。'),
        turnEndSeq: 12,
        progress: progress(explicit.id, explicit.createdAt),
      })
      const captured = [...domain.table('work_items').entries()].map(([, item]) => item)
      expect(captured).toHaveLength(1)
      expect(captured[0]?.processingState).toBe('CAPTURED')
      expect(captured[0]?.triggerHits.some(hit => hit.kind === 'EXPLICIT_SAVE')).toBe(true)

      const queuedOrdinary = queuedItem('queued-ordinary', 21, 'CONSTRAINT')
      const queuedExplicit = queuedItem('queued-explicit', 22, 'EXPLICIT_SAVE')
      let remaining = [queuedOrdinary, queuedExplicit]
      const launched: Array<{ id: string; snapshot: { automaticLearning: boolean }; frozen: boolean }> = []
      const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
      const scheduler = new LearningScheduler({
        policy,
        notices,
        store: {
          recoverInterrupted: async () => [],
          resumeAvailableAgentScopes: async () => [],
          listEligible: () => [...remaining],
          nextEligibleAt: () => undefined,
        },
        worker: {
          canResolveScope: () => true,
          run: async (item, _signal, snapshot) => {
            remaining = remaining.filter(candidate => candidate.workItemId !== item.workItemId)
            launched.push({ id: item.workItemId, snapshot, frozen: Object.isFrozen(snapshot) })
            const gate = Promise.withResolvers<void>()
            gates.set(item.workItemId, gate)
            await gate.promise
          },
        },
      })

      await scheduler.start()
      await vi.waitFor(() => { expect(launched).toHaveLength(1) })
      expect(launched[0]).toMatchObject({
        id: queuedExplicit.workItemId,
        snapshot: { automaticLearning: false },
        frozen: true,
      })

      await ctx.settings.update(namespace, { automaticLearning: true })
      scheduler.wake()
      await vi.waitFor(() => { expect(launched).toHaveLength(2) })
      expect(launched[1]).toMatchObject({
        id: queuedOrdinary.workItemId,
        snapshot: { automaticLearning: true },
        frozen: true,
      })
      await ctx.settings.update(namespace, { automaticLearning: false })
      expect(launched[1]?.snapshot.automaticLearning).toBe(true)

      for (const gate of gates.values()) gate.resolve()
      await scheduler.dispose()
    } finally {
      await domain.close()
      await ctx.fiber.dispose()
    }
  })
})
