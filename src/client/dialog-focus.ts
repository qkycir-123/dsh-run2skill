export const focusableSelector = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export interface FocusRoot {
  querySelectorAll(selector: string): ArrayLike<{ focus(): void }>
}

export function trapDialogTab(
  key: string,
  backwards: boolean,
  preventDefault: () => void,
  root: FocusRoot,
  activeElement: unknown,
): void {
  if (key !== 'Tab') return
  const focusable = Array.from(root.querySelectorAll(focusableSelector))
  if (focusable.length === 0) {
    preventDefault()
    return
  }
  const first = focusable[0]!
  const last = focusable.at(-1)!
  if (!focusable.includes(activeElement as { focus(): void })) {
    preventDefault()
    ;(backwards ? last : first).focus()
    return
  }
  if (backwards && activeElement === first) {
    preventDefault()
    last.focus()
  } else if (!backwards && activeElement === last) {
    preventDefault()
    first.focus()
  }
}
