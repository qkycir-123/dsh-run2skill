import { describe, expect, it, vi } from 'vitest'
import {
  AUTOMATIC_LEARNING_DEFAULT,
  RUN2SKILL_SETTINGS_NAMESPACE,
  AutomaticLearningSettingsSchema,
  createAutomaticLearningSettings,
} from '../src/adapters/dsh-settings/automatic-learning.js'

describe('DSH Automatic Learning volatile configuration', () => {
  it('declares the existing entry and a default-ON volatile boolean', () => {
    expect(RUN2SKILL_SETTINGS_NAMESPACE).toBe('run2skill')
    expect(AutomaticLearningSettingsSchema({}).automaticLearning.get()).toBe(AUTOMATIC_LEARNING_DEFAULT)
    expect(() => AutomaticLearningSettingsSchema({ automaticLearning: 'yes' as unknown as boolean })).toThrow()
  })

  it('reads an immutable operation snapshot from the live config reference', () => {
    let current = true
    const policy = createAutomaticLearningSettings({
      config: { automaticLearning: { get: () => current } },
      on: () => {},
    })
    const before = policy.snapshot()
    current = false

    expect(before).toEqual({ automaticLearning: true })
    expect(Object.isFrozen(before)).toBe(true)
    expect(policy.snapshot()).toEqual({ automaticLearning: false })
  })

  it('notifies only on this field changing and detaches its listener', () => {
    let current = false
    let notify: ((paths: readonly (readonly string[])[]) => void) | undefined
    const policy = createAutomaticLearningSettings({
      config: { automaticLearning: { get: () => current } },
      on: (name, listener) => {
        expect(name).toBe('loader/volatile-update')
        notify = listener
      },
    })
    const listener = vi.fn()
    const detach = policy.watch(listener)

    notify?.([['unrelated']])
    current = true
    notify?.([['automaticLearning']])
    notify?.([['automaticLearning']])
    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(
      { automaticLearning: true },
      { automaticLearning: false },
    )
    expect(Object.isFrozen(listener.mock.calls[0]![0])).toBe(true)

    detach()
    current = false
    notify?.([['automaticLearning']])
    expect(listener).toHaveBeenCalledOnce()
  })
})
