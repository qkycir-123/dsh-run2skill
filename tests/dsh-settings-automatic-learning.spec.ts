import { describe, expect, it, vi } from 'vitest'
import {
  AUTOMATIC_LEARNING_DEFAULT,
  RUN2SKILL_SETTINGS_NAMESPACE,
  registerAutomaticLearningSettings,
} from '../src/adapters/dsh-settings/automatic-learning.js'

describe('DSH Automatic Learning settings adapter', () => {
  it('registers the live run2skill namespace with a default-ON boolean schema', () => {
    const register = vi.fn((_namespace, schema, _options) => ({
      get: () => schema({}),
      watch: () => () => {},
    }))

    const scope = registerAutomaticLearningSettings({ register: register as never })

    expect(register).toHaveBeenCalledOnce()
    const [namespace, schema, options] = register.mock.calls[0]!
    expect(namespace).toBe(RUN2SKILL_SETTINGS_NAMESPACE)
    expect(options).toEqual({ applies: 'live' })
    expect(schema({})).toEqual({ automaticLearning: AUTOMATIC_LEARNING_DEFAULT })
    expect(() => schema({ automaticLearning: 'yes' })).toThrow()
    expect(scope.snapshot()).toEqual({ automaticLearning: true })
  })

  it('reads live frozen snapshots from the registered DSH scope', () => {
    let current = { automaticLearning: true }
    const scope = registerAutomaticLearningSettings({
      register: (() => ({ get: () => current, watch: () => () => {} })) as never,
    })
    const before = scope.snapshot()
    current = { automaticLearning: false }

    expect(Object.isFrozen(before)).toBe(true)
    expect(before).toEqual({ automaticLearning: true })
    expect(scope.snapshot()).toEqual({ automaticLearning: false })
  })

  it('forwards live changes and detaches the native settings watcher', async () => {
    const dispose = vi.fn()
    let notify: ((next: { automaticLearning: boolean }, previous: { automaticLearning: boolean }) => Promise<void>) | undefined
    const policy = registerAutomaticLearningSettings({
      register: (() => ({
        get: () => ({ automaticLearning: true }),
        watch: (callback: typeof notify) => { notify = callback; return dispose },
      })) as never,
    })
    const listener = vi.fn()
    const detach = policy.watch(listener)

    await notify?.({ automaticLearning: false }, { automaticLearning: true })

    expect(listener).toHaveBeenCalledWith(
      { automaticLearning: false },
      { automaticLearning: true },
    )
    expect(Object.isFrozen(listener.mock.calls[0]![0])).toBe(true)
    detach()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
