import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyzeCheapTriggerV1 } from '../src/domain/observe/trigger.js'

interface FrozenFixture {
  fixtureVersion: number
  policyVersion: string
  cases: Array<{
    id: string
    sourceKind: 'user' | 'synthetic' | 'tool' | 'plugin'
    text: string
    expectedKinds: string[]
  }>
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/cheap-trigger-v1.json', import.meta.url), 'utf8'),
) as FrozenFixture

describe('Cheap Trigger v1 frozen evaluation', () => {
  it('meets the frozen Slice A quality gates without printing sample text', () => {
    let truePositive = 0
    let falsePositive = 0
    let trueNegative = 0
    let falseNegative = 0
    let explicitExpected = 0
    let explicitDetected = 0
    const failedCaseIds: string[] = []

    for (const sample of fixture.cases) {
      const analysis = analyzeCheapTriggerV1([{
        messageSeq: 1,
        sourceKind: sample.sourceKind,
        text: sample.text,
      }])
      const actualKinds = analysis.triggerHits.map(hit => hit.kind)
      const expectedPositive = sample.expectedKinds.length > 0
      const actualPositive = actualKinds.length > 0
      if (expectedPositive && actualPositive) truePositive += 1
      else if (!expectedPositive && actualPositive) falsePositive += 1
      else if (!expectedPositive) trueNegative += 1
      else falseNegative += 1
      if (sample.expectedKinds.includes('EXPLICIT_SAVE')) {
        explicitExpected += 1
        if (actualKinds.includes('EXPLICIT_SAVE')) explicitDetected += 1
      }
      if (JSON.stringify(actualKinds) !== JSON.stringify(sample.expectedKinds)) {
        failedCaseIds.push(sample.id)
      }
    }

    const precision = truePositive / Math.max(1, truePositive + falsePositive)
    const recall = truePositive / Math.max(1, truePositive + falseNegative)
    const explicitSaveRecall = explicitDetected / Math.max(1, explicitExpected)
    const noSignalRate = trueNegative / Math.max(1, trueNegative + falsePositive)
    const longText = analyzeCheapTriggerV1([{
      messageSeq: 1,
      sourceKind: 'user',
      text: '字'.repeat(64 * 1024 + 1),
    }])
    const failedTurnSignal = analyzeCheapTriggerV1([{
      messageSeq: 1,
      sourceKind: 'user',
      text: '把这个流程保存成 Skill。',
    }])
    const cancelledTurnSignal = analyzeCheapTriggerV1([{
      messageSeq: 1,
      sourceKind: 'user',
      text: 'Remember this workflow for future reuse.',
    }])
    const syntheticSecret = 'synthetic-frozen-provider-value'
    const secretSignal = analyzeCheapTriggerV1([{
      messageSeq: 1,
      sourceKind: 'user',
      text: `Remember this workflow. deepseekKey=${syntheticSecret}`,
    }])
    const boundaryCaseIds = [
      'long-text-incomplete',
      'failed-turn-direct-signal',
      'cancelled-turn-direct-signal',
      'synthetic-secret-redaction',
    ]
    const report = {
      fixtureVersion: fixture.fixtureVersion,
      policyVersion: fixture.policyVersion,
      sampleCount: fixture.cases.length + boundaryCaseIds.length,
      boundaryCaseIds,
      confusionMatrix: { truePositive, falsePositive, trueNegative, falseNegative },
      metrics: { precision, recall, explicitSaveRecall, noSignalRate },
      failedCaseIds,
    }
    console.info(`FROZEN_EVALUATION=${JSON.stringify(report)}`)

    expect(explicitSaveRecall).toBe(1)
    expect(precision).toBeGreaterThanOrEqual(0.9)
    expect(recall).toBeGreaterThanOrEqual(0.9)
    expect(noSignalRate).toBeGreaterThanOrEqual(0.95)
    expect(failedCaseIds).toEqual([])
    expect(longText.status).toBe('INCOMPLETE')
    expect(failedTurnSignal.triggerHits).not.toHaveLength(0)
    expect(cancelledTurnSignal.triggerHits).not.toHaveLength(0)
    expect(JSON.stringify(secretSignal.evidenceRefs)).not.toContain(syntheticSecret)
  })
})
