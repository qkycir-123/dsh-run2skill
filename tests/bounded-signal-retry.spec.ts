import { describe, expect, it, vi } from 'vitest'
import {
  BoundedSignalRetry,
  SIGNAL_RETRY_DELAYS_MS,
} from '../src/application/capture/bounded-signal-retry.js'

describe('BoundedSignalRetry', () => {
  it('runs one initial attempt and exactly three delayed retries', async () => {
    const sleeps: number[] = []
    const attempts: number[] = []
    const retry = new BoundedSignalRetry({
      sleep: async (delay) => { sleeps.push(delay) },
    })

    const result = await retry.run('signal-a', async (attempt) => {
      attempts.push(attempt)
      throw new Error('synthetic store failure')
    })

    expect(result).toEqual({ status: 'EXHAUSTED', attempts: 4 })
    expect(attempts).toEqual([0, 1, 2, 3])
    expect(sleeps).toEqual(SIGNAL_RETRY_DELAYS_MS)
  })

  it('coalesces concurrent requests for the same signal into one retry chain', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const operation = vi.fn(async () => {
      await gate
      return 'durable'
    })
    const retry = new BoundedSignalRetry({ sleep: async () => undefined })

    const first = retry.run('signal-a', operation)
    const duplicate = retry.run('signal-a', operation)
    release?.()

    await expect(first).resolves.toEqual({ status: 'SUCCEEDED', attempts: 1, value: 'durable' })
    await expect(duplicate).resolves.toEqual({ status: 'SUCCEEDED', attempts: 1, value: 'durable' })
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('stops pending retry delays on dispose without starting another attempt', async () => {
    let waitSignal: AbortSignal | undefined
    const operation = vi.fn(async () => { throw new Error('synthetic store failure') })
    const retry = new BoundedSignalRetry({
      sleep: (_delay, signal) => new Promise<void>((_resolve, reject) => {
        waitSignal = signal
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    })

    const result = retry.run('signal-a', operation)
    await vi.waitFor(() => expect(waitSignal).toBeDefined())
    retry.dispose()

    await expect(result).resolves.toEqual({ status: 'CANCELLED', attempts: 1 })
    expect(waitSignal?.aborted).toBe(true)
    expect(operation).toHaveBeenCalledTimes(1)
  })
})
