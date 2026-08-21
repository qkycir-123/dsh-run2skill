// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import {
  RUN2SKILL_STYLE_ID,
  acquireRun2skillStyle,
  upsertRun2skillStyle,
} from '../src/client/style-lifecycle.js'

afterEach(() => {
  document.querySelectorAll(`[data-plugin-css="${RUN2SKILL_STYLE_ID}"]`).forEach(node => { node.remove() })
})

describe('run2skill CSS lifecycle', () => {
  it('updates one owner/style id across HMR and removes it after the last disposer', () => {
    const first = upsertRun2skillStyle('.old-hash{color:red}')
    const disposeA = acquireRun2skillStyle()
    const disposeB = acquireRun2skillStyle()
    const updated = upsertRun2skillStyle('.new-hash{color:blue}')

    expect(updated).toBe(first)
    expect(document.querySelectorAll(`[data-plugin-css="${RUN2SKILL_STYLE_ID}"]`)).toHaveLength(1)
    expect(updated.textContent).toContain('new-hash')
    expect(updated.textContent).not.toContain('old-hash')

    disposeA()
    expect(updated.isConnected).toBe(true)
    disposeA()
    expect(updated.isConnected).toBe(true)
    disposeB()
    expect(updated.isConnected).toBe(false)
  })
})
