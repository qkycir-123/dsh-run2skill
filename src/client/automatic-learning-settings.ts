import {
  createElement,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react'

export interface AutomaticLearningClientSettings {
  readonly automaticLearning: boolean
}

export interface ClientSettingsScopeSnapshot<T> {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value: T | undefined
  readonly revision: number | undefined
  readonly writable: boolean
}

export interface ClientSettingsScope<T> {
  getSnapshot(): ClientSettingsScopeSnapshot<T>
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

export interface AutomaticLearningCardState {
  readonly status: ClientSettingsScopeSnapshot<AutomaticLearningClientSettings>['status']
  readonly automaticLearning: boolean | undefined
  readonly writable: boolean
  readonly saving: boolean
  readonly error: 'SETTINGS_CHANGED' | undefined
}

export class AutomaticLearningSettingsController {
  readonly #listeners = new Set<() => void>()
  #snapshot: AutomaticLearningCardState
  #saving = false
  #error: AutomaticLearningCardState['error']
  readonly #unsubscribe: () => void

  constructor(private readonly scope: ClientSettingsScope<AutomaticLearningClientSettings>) {
    this.#snapshot = this.#project()
    this.#unsubscribe = scope.subscribe(() => { this.#publish() })
  }

  getSnapshot = (): AutomaticLearningCardState => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  async setAutomaticLearning(value: boolean): Promise<void> {
    const before = this.scope.getSnapshot()
    if (before.status !== 'ready' || !before.writable || this.#saving) return
    this.#saving = true
    this.#error = undefined
    this.#publish()
    try {
      await this.scope.set('automaticLearning', value)
      const after = this.scope.getSnapshot()
      this.#error = after.status === 'ready' && after.value?.automaticLearning === value
        ? undefined
        : 'SETTINGS_CHANGED'
    } catch {
      this.#error = 'SETTINGS_CHANGED'
    } finally {
      this.#saving = false
      this.#publish()
    }
  }

  dispose(): void {
    this.#unsubscribe()
    this.#listeners.clear()
  }

  #project(): AutomaticLearningCardState {
    const snapshot = this.scope.getSnapshot()
    return Object.freeze({
      status: snapshot.status,
      automaticLearning: snapshot.value?.automaticLearning,
      writable: snapshot.writable,
      saving: this.#saving,
      error: this.#error,
    })
  }

  #publish(): void {
    this.#snapshot = this.#project()
    for (const listener of this.#listeners) listener()
  }
}

export function AutomaticLearningSettingsCard(props: {
  readonly controller: AutomaticLearningSettingsController
}): ReactElement | null {
  const state = useSyncExternalStore(
    props.controller.subscribe,
    props.controller.getSnapshot,
    props.controller.getSnapshot,
  )
  const [open, setOpen] = useState(false)
  if (state.status === 'unavailable') return null
  const disabled = state.status !== 'ready' || !state.writable || state.saving
  return createElement('li', { 'data-run2skill-settings-card': true },
    createElement('button', {
      type: 'button',
      'aria-expanded': open,
      onClick: () => { setOpen(value => !value) },
    }, 'run2skill', createElement('span', null, '将真实执行中的明确经验转为待审核 Skill Proposal')),
    open
      ? createElement('div', null,
          createElement('label', null,
            createElement('input', {
              type: 'checkbox',
              checked: state.automaticLearning === true,
              disabled,
              onChange: (event: { currentTarget: { checked: boolean } }) => {
                void props.controller.setAutomaticLearning(event.currentTarget.checked)
              },
            }),
            'Automatic Learning',
          ),
          createElement('p', null,
            '关闭后暂停普通自动学习；显式“保存为 Skill”仍会持久保存。已开始的分析继续使用启动时快照。',
          ),
          createElement('p', null, 'Learning 模型沿用发起 Session 的 provider/model（inherit-session）。'),
          state.error === undefined
            ? null
            : createElement('p', { role: 'status' }, '设置已变化，请刷新后重试。'),
        )
      : null,
  )
}

export interface AutomaticLearningSettingsClientContext {
  readonly settingsScope: {
    bind<T>(spec: { readonly namespace: string }): ClientSettingsScope<T>
  }
  readonly slots: {
    inject(name: string, install: () => unknown): void
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  effect?(install: () => (() => void), label?: string): void
}

export function applyAutomaticLearningSettingsClient(
  context: AutomaticLearningSettingsClientContext,
): void {
  const scope = context.settingsScope.bind<AutomaticLearningClientSettings>({ namespace: 'run2skill' })
  const controller = new AutomaticLearningSettingsController(scope)
  context.effect?.(() => () => { controller.dispose() }, 'run2skill: automatic learning settings')
  context.slots.inject('settings.plugin.item', () => context.slots.register({
    name: 'settings.plugin.item',
    key: 'run2skill',
    inject: () => ({ controller }),
  }, AutomaticLearningSettingsCard))
}
