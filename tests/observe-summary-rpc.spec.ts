import { describe, expect, it, vi } from 'vitest'
import {
  OBSERVE_SUMMARY_ENDPOINT,
  createObserveSummaryRpcHandler,
} from '../src/adapters/dsh-connection/observe-summary-rpc.js'

const summary = {
  apiVersion: 1 as const,
  status: 'READY' as const,
  capturedCount: 2,
  blockedCaptureCount: 1,
  unsaved: { completeness: 'KNOWN' as const, knownCount: 0 },
  recoveryLag: false,
}

describe('Observe Summary RPC', () => {
  it('creates the unary summary handler consumed by the Remote service', async () => {
    const readSummary = vi.fn(() => summary)
    const handler = createObserveSummaryRpcHandler(readSummary)
    expect(await handler(OBSERVE_SUMMARY_ENDPOINT, { apiVersion: 1 }, new AbortController().signal))
      .toEqual({ ok: true, value: summary })
    expect(readSummary).toHaveBeenCalledTimes(1)
  })

  it('rejects unknown endpoints and non-empty or wrong-version payloads before reading state', async () => {
    const readSummary = vi.fn(() => summary)
    const handler = createObserveSummaryRpcHandler(readSummary)

    for (const [endpoint, payload] of [
      ['other', { apiVersion: 1 }],
      [OBSERVE_SUMMARY_ENDPOINT, {}],
      [OBSERVE_SUMMARY_ENDPOINT, { apiVersion: 2 }],
      [OBSERVE_SUMMARY_ENDPOINT, { apiVersion: 1, token: 'synthetic-value' }],
    ] as const) {
      const result = await handler(endpoint, payload, new AbortController().signal)
      expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
      expect(JSON.stringify(result)).not.toContain('synthetic-value')
    }
    expect(readSummary).not.toHaveBeenCalled()
  })

  it('returns generic cancellation and internal errors without leaking exception text', async () => {
    const handler = createObserveSummaryRpcHandler(
      () => { throw new Error('synthetic secret and D:\\private\\path') },
    )

    const failed = await handler(
      OBSERVE_SUMMARY_ENDPOINT,
      { apiVersion: 1 },
      new AbortController().signal,
    )
    expect(failed).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(JSON.stringify(failed)).not.toContain('synthetic')
    expect(JSON.stringify(failed)).not.toContain('private')

    const aborted = new AbortController()
    aborted.abort()
    await expect(handler(OBSERVE_SUMMARY_ENDPOINT, { apiVersion: 1 }, aborted.signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })
})
