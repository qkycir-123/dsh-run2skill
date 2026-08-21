export const RUN2SKILL_STYLE_ID = 'dsh-run2skill/native-ui'

function styleSelector(): string {
  return `style[data-plugin-css="${RUN2SKILL_STYLE_ID}"]`
}

export function upsertRun2skillStyle(css: string): HTMLStyleElement {
  const existing = document.querySelector<HTMLStyleElement>(styleSelector())
  const tag = existing ?? document.createElement('style')
  tag.dataset.plugin = 'dsh-run2skill'
  tag.dataset.pluginCss = RUN2SKILL_STYLE_ID
  tag.textContent = css
  if (existing === null) document.head.appendChild(tag)
  return tag
}

export function acquireRun2skillStyle(): () => void {
  if (typeof document === 'undefined') return () => undefined
  const tag = document.querySelector<HTMLStyleElement>(styleSelector())
  if (tag === null) return () => undefined
  const count = Number(tag.dataset.pluginMounts ?? '0')
  tag.dataset.pluginMounts = String(Number.isSafeInteger(count) && count >= 0 ? count + 1 : 1)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const current = Number(tag.dataset.pluginMounts ?? '1')
    if (current <= 1) tag.remove()
    else tag.dataset.pluginMounts = String(current - 1)
  }
}
