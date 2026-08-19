import { describe, expect, it, vi } from 'vitest'
import {
  OBSERVE_SUMMARY_POLL_INTERVAL_MS,
  ObserveSummaryPoller,
  type ObservePollEnvironment,
} from '../src/client/observe-summary-poller.js'

const summary = {
  apiVersion: 1 as const,
  status: 'READY' as const,
  capturedCount: 1,
  blockedCaptureCount: 0,
  unsaved: { completeness: 'KNOWN' as const, knownCount: 0 },
  recoveryLag: false,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fakeEnvironment(initiallyVisible = true): ObservePollEnvironment & {
  setVisible(value: boolean): void
  focus(): void
  tick(): void
  timerCount(): number
} {
  let visible = initiallyVisible
  let nextTimer = 0
  const timers = new Map<number, () => void>()
  const focusListeners = new Set<() => void>()
  const visibilityListeners = new Set<() => void>()
  return {
    isVisible: () => visible,
    setInterval: (callback, delayMs) => {
      expect(delayMs).toBe(OBSERVE_SUMMARY_POLL_INTERVAL_MS)
      const id = nextTimer++
      timers.set(id, callback)
      return id
    },
    clearInterval: handle => { timers.delete(handle as number) },
    onFocus: listener => { focusListeners.add(listener); return () => { focusListeners.delete(listener) } },
    onVisibilityChange: listener => {
      visibilityListeners.add(listener)
      return () => { visibilityListeners.delete(listener) }
    },
    setVisible(value) {
      visible = value
      for (const listener of visibilityListeners) listener()
    },
    focus() { for (const listener of focusListeners) listener() },
    tick() { for (const callback of timers.values()) callback() },
    timerCount: () => timers.size,
  }
}

describe('ObserveSummaryPoller', () => {
  it('refreshes on mount, focus, and the visible timer with at most one request in flight', async () => {
    const first = deferred<unknown>()
    const call = vi.fn(() => first.promise)
    const environment = fakeEnvironment()
    const poller = new ObserveSummaryPoller(call, environment)

    poller.start()
    expect(poller.snapshot()).toEqual({ phase: 'LOADING' })
    expect(call).toHaveBeenCalledTimes(1)
    expect(environment.timerCount()).toBe(1)
    environment.focus()
    environment.tick()
    expect(call).toHaveBeenCalledTimes(1)

    first.resolve({ ok: true, value: summary })
    await poller.whenIdle()
    expect(poller.snapshot()).toEqual({ phase: 'READY', summary })

    environment.focus()
    await poller.whenIdle()
    environment.tick()
    await poller.whenIdle()
    expect(call).toHaveBeenCalledTimes(3)
    poller.dispose()
  })

  it('stops polling while hidden and refreshes immediately when visible again', async () => {
    const environment = fakeEnvironment(false)
    const call = vi.fn(async () => ({ ok: true as const, value: summary }))
    const poller = new ObserveSummaryPoller(call, environment)

    poller.start()
    expect(call).not.toHaveBeenCalled()
    expect(environment.timerCount()).toBe(0)
    environment.setVisible(true)
    await poller.whenIdle()
    expect(call).toHaveBeenCalledTimes(1)
    expect(environment.timerCount()).toBe(1)
    environment.setVisible(false)
    expect(environment.timerCount()).toBe(0)
    environment.focus()
    expect(call).toHaveBeenCalledTimes(1)
    poller.dispose()
  })

  it('distinguishes unavailable from stale and retains the last valid snapshot', async () => {
    const environment = fakeEnvironment()
    const call = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, value: summary })
      .mockResolvedValueOnce({ ok: false, error: { code: 'internal' } })
    const poller = new ObserveSummaryPoller(call, environment)

    poller.start()
    await poller.whenIdle()
    expect(poller.snapshot()).toEqual({ phase: 'UNAVAILABLE' })
    environment.focus()
    await poller.whenIdle()
    expect(poller.snapshot()).toEqual({ phase: 'READY', summary })
    environment.focus()
    await poller.whenIdle()
    expect(poller.snapshot()).toEqual({ phase: 'STALE', summary })
    poller.dispose()
  })

  it('aborts the request and removes all event hooks on dispose', async () => {
    const environment = fakeEnvironment()
    let receivedSignal: AbortSignal | undefined
    const pending = deferred<unknown>()
    const poller = new ObserveSummaryPoller((_payload, signal) => {
      receivedSignal = signal
      return pending.promise
    }, environment)

    poller.start()
    poller.dispose()
    expect(receivedSignal?.aborted).toBe(true)
    expect(environment.timerCount()).toBe(0)
    environment.focus()
    environment.setVisible(false)
    environment.setVisible(true)
    pending.resolve({ ok: true, value: summary })
    await poller.whenIdle()
    expect(poller.snapshot()).toEqual({ phase: 'LOADING' })
  })
})
