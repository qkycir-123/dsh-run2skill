import { describe, expect, it, vi } from 'vitest'
import { SessionCoordinateIngress } from '../src/adapters/dsh-session/ingress.js'
import { WriteBehindCheckpoint } from '../src/application/capture/write-behind-checkpoint.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'

describe('A3 ordinary-turn performance gates', () => {
  it('keeps 10,000 no-signal Root turns free of WorkItems and per-turn checkpoint writes', async () => {
    const domain = createMemoryRun2skillDomain()
    const checkpoint = new WriteBehindCheckpoint(domain, { now: () => 0 })
    const base = {
      rootSessionId: 'session-1', sessionCreatedAt: 100,
      sessionCwdDigest: 'a'.repeat(64), triggerPolicyVersion: 'cheap-trigger-v1' as const,
      activationFenceSeq: 0, durableNextSeq: 0, observedTailSeq: 0,
    }
    await checkpoint.activate([base])

    for (let turn = 0; turn < 10_000; turn += 1) {
      await checkpoint.observeCompletedRoot({
        ...base,
        durableNextSeq: turn * 2 + 2,
        observedTailSeq: turn * 2 + 1,
      })
    }

    expect(domain.workItems.size).toBe(0)
    expect(domain.writeLog.filter((entry) => entry === 'work_items')).toHaveLength(0)
    expect(domain.writeLog.filter((entry) => entry === 'global').length).toBeLessThan(400)
  })

  it('keeps synchronous ingress candidate p99 increment below 1 ms', () => {
    const samples: number[] = []
    const baseline: number[] = []
    const ingress = new SessionCoordinateIngress(vi.fn())
    const header = { version: 0, id: 'session-1', createdAt: 100 }

    for (let turn = 0; turn < 10_000; turn += 1) {
      const startSeq = turn * 2
      let startedAt = performance.now()
      void ({ seq: startSeq, turn })
      baseline.push(performance.now() - startedAt)
      startedAt = performance.now()
      ingress.observe(header, { type: 'turn/start', seq: startSeq, time: startSeq, data: { turn } })
      ingress.observe(header, {
        type: 'turn/end', seq: startSeq + 1, time: startSeq + 1,
        data: { turn, reason: { kind: 'completed' } },
      })
      samples.push(performance.now() - startedAt)
    }

    samples.sort((left, right) => left - right)
    baseline.sort((left, right) => left - right)
    const index = Math.ceil(samples.length * 0.99) - 1
    expect(samples[index]! - baseline[index]!).toBeLessThan(1)
  })
})
