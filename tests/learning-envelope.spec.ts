import { describe, expect, it } from 'vitest'
import { projectLearningWindow } from '../src/adapters/dsh-session/learning-window.js'
import {
  buildLearningEnvelope,
  LEARNING_ENVELOPE_MAX_BYTES,
} from '../src/domain/learn/envelope.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import { makeLearningSessionFixture } from './support/learning-session-fixture.js'

describe('Learning Envelope', () => {
  it('builds canonical bounded JSON and keeps trigger evidence coordinates', () => {
    const fixture = makeLearningSessionFixture()
    const projected = projectLearningWindow(fixture.header, fixture.events, fixture.item)
    expect(projected.status).toBe('AVAILABLE')
    if (projected.status !== 'AVAILABLE') return

    const result = buildLearningEnvelope(fixture.item, projected.projection)
    expect(result.status).toBe('AVAILABLE')
    if (result.status !== 'AVAILABLE') return
    expect(result.byteLength).toBeLessThanOrEqual(LEARNING_ENVELOPE_MAX_BYTES)
    expect(Buffer.byteLength(result.serialized, 'utf8')).toBe(result.byteLength)
    expect(JSON.parse(result.serialized)).toEqual(result.envelope)
    expect(result.serialized).not.toContain('target-provider')
    expect(result.serialized).not.toContain('target-model-last')
    expect(result.envelope.trigger).toEqual({
      turn: fixture.item.signalKey.turn,
      turnEndSeq: fixture.item.signalKey.turnEndSeq,
      evidenceDigests: fixture.item.evidenceRefs.map(item => item.excerptDigest),
    })
    expect(result.envelope.blocks.some(block => (
      block.source === 'USER_EVIDENCE' && block.eventSeq === 11
    ))).toBe(true)
  })

  it('drops external and older history before trigger-turn assistant context', () => {
    const fixture = makeLearningSessionFixture()
    const projected = projectLearningWindow(fixture.header, fixture.events, fixture.item)
    if (projected.status !== 'AVAILABLE') throw new Error('fixture projection failed')
    const full = buildLearningEnvelope(fixture.item, projected.projection)
    if (full.status !== 'AVAILABLE') throw new Error('full envelope failed')
    const budget = full.byteLength - 150

    const trimmed = buildLearningEnvelope(fixture.item, projected.projection, budget)
    expect(trimmed.status).toBe('AVAILABLE')
    if (trimmed.status !== 'AVAILABLE') return
    expect(trimmed.byteLength).toBeLessThanOrEqual(budget)
    expect(trimmed.envelope.blocks.some(block => block.source === 'EXTERNAL_UNTRUSTED')).toBe(false)
    expect(trimmed.envelope.blocks.some(block => block.eventSeq === 12)).toBe(true)
    expect(trimmed.envelope.blocks.some(block => block.eventSeq === 11)).toBe(true)
  })

  it('fails when the fixed wrapper and trigger evidence cannot fit', () => {
    const fixture = makeLearningSessionFixture()
    const projected = projectLearningWindow(fixture.header, fixture.events, fixture.item)
    if (projected.status !== 'AVAILABLE') throw new Error('fixture projection failed')
    expect(buildLearningEnvelope(fixture.item, projected.projection, 64)).toEqual({
      status: 'UNAVAILABLE',
      failureCode: 'ENVELOPE_UNBUILDABLE',
    })
  })

  it('never permits a caller budget above the 48 KiB policy limit', () => {
    const fixture = makeLearningSessionFixture()
    const projected = projectLearningWindow(fixture.header, fixture.events, fixture.item)
    if (projected.status !== 'AVAILABLE') throw new Error('fixture projection failed')
    const largeText = 'a'.repeat(60 * 1024)
    const result = buildLearningEnvelope(
      fixture.item,
      {
        ...projected.projection,
        blocks: [...projected.projection.blocks, {
          source: 'ASSISTANT_CONTEXT',
          sessionId: fixture.item.signalKey.rootSessionId,
          turn: fixture.item.signalKey.turn,
          eventSeq: 10,
          text: largeText,
          digest: sha256Utf8(largeText),
          truncated: false,
          retention: { kind: 'ASSISTANT' },
        }],
      },
      LEARNING_ENVELOPE_MAX_BYTES + 1,
    )
    expect(result.status).toBe('AVAILABLE')
    if (result.status === 'AVAILABLE') {
      expect(result.byteLength).toBeLessThanOrEqual(LEARNING_ENVELOPE_MAX_BYTES)
    }
  })
})
