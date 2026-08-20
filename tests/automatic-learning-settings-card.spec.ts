import { describe, expect, it, vi } from 'vitest'
import {
  AutomaticLearningSettingsController,
  applyAutomaticLearningSettingsClient,
} from '../src/client/automatic-learning-settings.js'

function scopeFixture() {
  let snapshot = {
    status: 'ready' as const,
    value: { automaticLearning: true },
    revision: 0,
    writable: true,
  }
  const listeners = new Set<() => void>()
  const set = vi.fn(async (_field: string, value: unknown) => {
    snapshot = { ...snapshot, value: { automaticLearning: value as boolean }, revision: snapshot.revision + 1 }
    for (const listener of listeners) listener()
  })
  return {
    scope: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set,
    },
    rejectNextWrite() {
      set.mockRejectedValueOnce(new Error('synthetic settings revision conflict'))
    },
  }
}

describe('Automatic Learning native settings card', () => {
  it('registers a run2skill-keyed card and binds the native settings scope', () => {
    const fixture = scopeFixture()
    const install = vi.fn((_name: string, callback: () => unknown) => callback())
    const register = vi.fn(() => () => {})
    const bind = vi.fn(() => fixture.scope)

    applyAutomaticLearningSettingsClient({
      settingsScope: { bind: bind as never },
      slots: { inject: install, register },
    })

    expect(bind).toHaveBeenCalledWith({ namespace: 'run2skill' })
    expect(install).toHaveBeenCalledWith('settings.plugin.item', expect.any(Function))
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'settings.plugin.item', key: 'run2skill',
    }), expect.any(Function))
  })

  it('uses native revision-fenced writes and reports when the requested value did not land', async () => {
    const fixture = scopeFixture()
    const controller = new AutomaticLearningSettingsController(fixture.scope)

    await controller.setAutomaticLearning(false)
    expect(fixture.scope.set).toHaveBeenCalledWith('automaticLearning', false)
    expect(controller.getSnapshot()).toMatchObject({ automaticLearning: false, error: undefined })

    fixture.rejectNextWrite()
    await controller.setAutomaticLearning(true)
    expect(controller.getSnapshot()).toMatchObject({
      automaticLearning: false,
      error: 'SETTINGS_CHANGED',
    })
  })
})
