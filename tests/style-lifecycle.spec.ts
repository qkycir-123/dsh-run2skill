// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  RUN2SKILL_STYLE_ID,
  acquireRun2skillStyle,
  upsertRun2skillStyle,
} from '../src/client/style-lifecycle.js'

afterEach(() => {
  document.querySelectorAll(`[data-plugin-css="${RUN2SKILL_STYLE_ID}"]`).forEach(node => { node.remove() })
})

describe('run2skill CSS lifecycle', () => {
  it('uses only DSH public theme token families in the native settings stylesheet', () => {
    const css = readFileSync(resolve('src/client/run2skill-settings-page.module.css'), 'utf8')
    expect(css).not.toMatch(/--dsw-alias-(?:content|surface|overlay|shadow|border-subtle)/)
    for (const token of [
      '--dsw-alias-label-primary',
      '--dsw-alias-label-secondary',
      '--dsw-alias-border-l1',
      '--dsw-alias-border-l2',
      '--dsw-alias-bg-layer-1',
      '--dsw-alias-bg-layer-2',
      '--dsw-alias-bg-mask-1',
      '--dsw-alias-brand-primary',
      '--dsw-alias-interactive-bg-active',
      '--dsw-alias-state-error-primary',
    ]) expect(css).toContain(token)
  })

  it('keeps the populated Attention panel readable at the panel width', () => {
    const css = readFileSync(resolve('src/client/run2skill-settings-page.module.css'), 'utf8')

    expect(css).toMatch(/\.sectionBody\s*\{[^}]*container-type:\s*inline-size/s)
    expect(css).toMatch(/\.proposalLayout\s*\{[^}]*grid-template-columns:\s*1fr/s)
    expect(css).toMatch(/@container\s*\(min-width:\s*760px\)/)
    expect(css).toMatch(/\.detailFacts\s*\{[^}]*grid-template-columns:\s*minmax\(6rem,\s*max-content\)\s+minmax\(0,\s*1fr\)/s)
    expect(css).toMatch(/\.proposalListButton\[aria-current=['"]true['"]\]/)
    expect(css).toMatch(/@container\s*\(max-width:\s*30rem\)[\s\S]*\.learningStatusRow[\s\S]*flex-direction:\s*column/)
  })

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
