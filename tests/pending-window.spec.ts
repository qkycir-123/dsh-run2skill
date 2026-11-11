import { describe, expect, it } from 'vitest'
import { selectPendingWindow } from '../src/domain/v2/pending-window.js'
import type { BatchDetectorInput } from '../src/application/detection/batch-detector-worker.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

function input(): BatchDetectorInput {
  const fixture = createMinimalV2Fixtures()
  return {
    batchId: fixture.sessionBatch.batchId, sessionLifecycleKey: fixture.sessionBatch.sessionLifecycleKey,
    triggerReasons: ['THRESHOLD'], route: fixture.sessionBatch.routeSnapshot, carry: [],
    observations: Array.from({ length: 100 }, (_, index) => ({
      observationId: `obs_${index.toString(16).padStart(64, '0')}`, turnEndSeq: index,
      evidenceDigest: index.toString(16).padStart(64, '0'), completeness: 'COMPLETE',
      assistantOutcomeSummary: 'task result', toolOutcomeSummary: [],
      directUserEvidence: [{
        source: 'USER_DIRECT', messageSeq: index, excerpt: index === 8 ? '以后这个项目必须先运行测试' : '查询一次状态',
        excerptDigest: 'f'.repeat(64), redactionKinds: [], truncated: false,
      }],
    })),
  }
}

describe('bounded pending windows', () => {
  it('keeps an early correction, adjacent action/result and recent feedback in a long conversation', () => {
    const source = input()
    const result = selectPendingWindow(source)
    expect(result.observations).toHaveLength(32)
    expect(result.observations.map(item => item.turnEndSeq)).toEqual(expect.arrayContaining([7, 8, 9, 96, 97, 98, 99]))
    expect(result.observations.map(item => item.turnEndSeq)).toEqual(result.observations.map(item => item.turnEndSeq).sort((a, b) => a - b))
    expect(selectPendingWindow(result)).toEqual(result)
  })

  it('preserves non-adjacent original evidence for pending experiences and never selects other sessions', () => {
    const source = input()
    const result = selectPendingWindow({ ...source, carry: [{
      summary: '等待验证构建流程', behaviorSignatureDraft: 'a'.repeat(64),
      evidenceDigests: [source.observations[30]!.evidenceDigest], remainingBatches: 1,
    }] })
    expect(result.observations.map(item => item.turnEndSeq)).toContain(30)
    expect(result.carry[0]!.remainingBatches).toBe(1) // only the worker consumes a lifetime
  })

  it('leaves short conversations intact, including complete explicit requests', () => {
    const source = input()
    const short = { ...source, triggerReasons: ['EXPLICIT'] as const, observations: source.observations.slice(0, 10) }
    expect(selectPendingWindow({ ...short, triggerReasons: [...short.triggerReasons] }).observations).toEqual(short.observations)
  })
})
