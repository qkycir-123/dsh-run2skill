import {
  createElement,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react'
import type { TypertClientRemote, TypertDisposer } from '@deepseek-ai/dsh-typert-protocol'
import { createRun2skillRemoteCaller } from '../adapters/dsh-remote/client.js'
import {
  PurgeSettingsController,
  PurgeSettingsSection,
  type PurgeCall,
} from './purge-settings.js'
import { RETRIEVAL_DEFAULTS, type RetrievalSettings } from '../domain/retrieval/settings.js'

export interface AutomaticLearningClientSettings extends Partial<RetrievalSettings> {
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
  set(field: string, value: unknown): Promise<boolean | void>
}

export interface AutomaticLearningCardState {
  readonly retrieval: RetrievalSettings
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
    await this.setField('automaticLearning', value)
  }

  async setField(field: keyof AutomaticLearningClientSettings, value: unknown): Promise<void> {
    const before = this.scope.getSnapshot()
    if (before.status !== 'ready' || !before.writable || this.#saving) return
    this.#saving = true
    this.#error = undefined
    this.#publish()
    try {
      const accepted = await this.scope.set(field, value)
      const after = this.scope.getSnapshot()
      this.#error = accepted !== false && after.status === 'ready' && after.value?.[field] === value
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
      retrieval: { ...RETRIEVAL_DEFAULTS, ...snapshot.value },
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
  readonly purgeController: PurgeSettingsController
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
    }, 'Run2Skill', createElement('span', null, '将真实执行中的明确经验整理为待确认的技能草稿')),
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
            '自动学习',
          ),
          createElement('p', null,
            '关闭后暂停普通自动学习；显式“保存为 Skill”仍会持久保存。已开始的分析继续使用启动时快照。',
          ),
          createElement('p', null, '分析时沿用发起会话已经选择的模型。'),
          createElement(RetrievalSettingsSection, { controller: props.controller }),
          state.error === undefined
            ? null
            : createElement('p', { role: 'status' }, '设置已变化，请刷新后重试。'),
          createElement(PurgeSettingsSection, { controller: props.purgeController }),
        )
      : null,
  )
}

/** Both entry points use this same settings section; credential values never enter Client state. */
export function RetrievalSettingsSection({ controller }: { readonly controller: AutomaticLearningSettingsController }): ReactElement {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const disabled = state.status !== 'ready' || !state.writable || state.saving
  const settings = state.retrieval
  const field = (key: keyof RetrievalSettings, label: string, placeholder = '') => createElement('label', { key },
    createElement('span', null, label),
    createElement('input', {
      key: `${key}:${String(settings[key])}`, type: 'text', defaultValue: String(settings[key]), disabled, placeholder,
      maxLength: key.endsWith('Endpoint') ? 2048 : 256,
      'aria-label': label, spellCheck: false,
      onBlur: (event: { currentTarget: { value: string } }) => {
        if (event.currentTarget.value.trim() !== settings[key]) void controller.setField(key, event.currentTarget.value.trim())
      },
    }),
  )
  return createElement('section', { 'data-run2skill-retrieval': true },
    createElement('label', null,
      createElement('input', {
        type: 'checkbox', checked: settings.advancedRecall, disabled,
        onChange: (event: { currentTarget: { checked: boolean } }) => { void controller.setField('advancedRecall', event.currentTarget.checked) },
      }), '高级召回',
    ),
    createElement('p', null, settings.advancedRecall
      ? '使用关键词与语义检索筛选相关技能，再检查正文覆盖关系。服务不可用时自动恢复标准召回。'
      : '当前使用标准召回：逐页检查技能摘要，无需额外模型服务。'),
    settings.advancedRecall ? createElement('div', null,
      createElement('h4', null, '向量模型'),
      field('embeddingEndpoint', 'Embedding 接口地址', 'https://example.com/v1/embeddings'),
      field('embeddingModel', 'Embedding 模型'),
      field('embeddingApiKeyEnv', 'Embedding 凭证环境变量名', 'RUN2SKILL_EMBEDDING_KEY'),
      createElement('p', null, '填写运行 DSH 的设备上的环境变量名，无需在这里粘贴密钥。本机服务可留空。'),
      createElement('h4', null, '摘要重排'),
      createElement('label', null, '重排方式', createElement('select', {
        'aria-label': '重排方式', value: settings.rerankerMode, disabled,
        onChange: (event: { currentTarget: { value: string } }) => { void controller.setField('rerankerMode', event.currentTarget.value) },
      }, createElement('option', { value: 'SESSION' }, '使用 DSH 当前模型'), createElement('option', { value: 'SERVICE' }, '使用专用重排服务'))),
      settings.rerankerMode === 'SERVICE' ? createElement('div', null,
        field('rerankerEndpoint', 'Reranker 接口地址', 'https://example.com/v1/rerank'),
        field('rerankerModel', 'Reranker 模型'),
        field('rerankerApiKeyEnv', 'Reranker 凭证环境变量名', 'RUN2SKILL_RERANKER_KEY'),
      ) : null,
      createElement('p', null, '首次检索时建立持久化向量索引，后续仅更新变化的技能；关闭开关保留索引，清除学习数据时一并删除。'),
    ) : null,
    state.error ? createElement('p', { role: 'status' }, '设置未保存，请重试。') : null,
  )
}

export interface AutomaticLearningSettingsClientContext {
  readonly remote: TypertClientRemote
  readonly workspaces: {
    readonly list: {
      getSnapshot(): {
        readonly recentWorkspaceId?: string | undefined
        readonly items: readonly { readonly workspaceId: string }[]
      }
    }
  }
  readonly configForms: {
    get<T>(entryId: string): ClientSettingsScope<T>
  }
  readonly slots: {
    inject(name: string, install: () => unknown): void
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  effect?(install: () => (() => void), label?: string): void
}

export function applyAutomaticLearningSettingsClient(
  context: AutomaticLearningSettingsClientContext,
): Promise<TypertDisposer> {
  return applyAutomaticLearningSettingsClientRemote(context)
}

async function applyAutomaticLearningSettingsClientRemote(
  context: AutomaticLearningSettingsClientContext,
): Promise<TypertDisposer> {
  const mounted = await createRun2skillRemoteCaller(context.remote)
  const scope = context.configForms.get<AutomaticLearningClientSettings>('run2skill')
  const controller = new AutomaticLearningSettingsController(scope)
  const callPurge: PurgeCall = mounted.call
  const purgeController = new PurgeSettingsController(callPurge, () => {
    const snapshot = context.workspaces.list.getSnapshot()
    return snapshot.recentWorkspaceId
  })
  purgeController.start()
  context.effect?.(() => () => {
    controller.dispose()
    purgeController.dispose()
  }, 'run2skill: settings and purge')
  context.slots.inject('plugins.item', () => context.slots.register({
    name: 'plugins.item',
    id: 'run2skill',
    inject: () => ({ controller, purgeController }),
  }, AutomaticLearningSettingsCard))
  return mounted.dispose
}
