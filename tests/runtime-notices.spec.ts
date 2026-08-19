import { describe, expect, it } from 'vitest'
import { RuntimeNotices } from '../src/application/capture/runtime-notices.js'

describe('RuntimeNotices', () => {
  it('deduplicates by health code and signal coordinates without accepting text or paths', () => {
    const notices = new RuntimeNotices({ now: () => 1_000 })
    notices.record({ healthCode: 'WORK_ITEM_WRITE_FAILED', sessionId: 'session-1', turnEndSeq: 13 })
    notices.record({ healthCode: 'WORK_ITEM_WRITE_FAILED', sessionId: 'session-1', turnEndSeq: 13 })

    expect(notices.list()).toEqual([expect.objectContaining({ count: 2 })])
    expect(notices.list()[0]).not.toHaveProperty('message')
    expect(notices.list()[0]).not.toHaveProperty('path')
  })

  it('drops runtime extension fields instead of retaining caller data', () => {
    const notices = new RuntimeNotices()
    const tainted = {
      healthCode: 'WORK_ITEM_WRITE_FAILED',
      sessionId: 'session-1',
      turnEndSeq: 13,
      message: 'synthetic secret body',
      path: 'D:\\synthetic-private-path',
    }

    notices.record(tainted)

    expect(JSON.stringify(notices.list())).not.toContain('synthetic')
  })

  it('clears all unsaved notices for a signal after its WorkItem is durable', () => {
    const notices = new RuntimeNotices()
    notices.record({ healthCode: 'WORK_ITEM_WRITE_FAILED', sessionId: 'session-1', turnEndSeq: 13 })
    notices.record({ healthCode: 'REDACTION_UNAVAILABLE', sessionId: 'session-1', turnEndSeq: 13 })

    notices.clearSignal('session-1', 13)

    expect(notices.list()).toEqual([])
  })

  it('aggregates recovery health per session', () => {
    const notices = new RuntimeNotices()
    notices.record({ healthCode: 'SESSION_LOG_UNAVAILABLE', sessionId: 'session-1' })
    notices.record({ healthCode: 'SESSION_LOG_UNAVAILABLE', sessionId: 'session-1' })

    expect(notices.list()).toHaveLength(1)
    expect(notices.list()[0]?.count).toBe(2)
  })

  it('starts a new aggregate after the recovery window expires', () => {
    let now = 0
    const notices = new RuntimeNotices({ now: () => now, aggregationWindowMs: 30_000 })
    notices.record({ healthCode: 'SESSION_LOG_UNAVAILABLE', sessionId: 'session-1' })
    now = 30_001

    notices.record({ healthCode: 'SESSION_LOG_UNAVAILABLE', sessionId: 'session-1' })

    expect(notices.list()[0]).toMatchObject({ count: 1, firstObservedAt: 30_001 })
  })
})
