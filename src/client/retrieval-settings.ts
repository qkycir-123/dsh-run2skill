import {
  createElement,
  useSyncExternalStore,
  type ReactElement,
} from 'react'
import { RETRIEVAL_DEFAULTS, type RetrievalSettings } from '../domain/retrieval/settings.js'

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

export interface RetrievalSettingsState {
  readonly retrieval: RetrievalSettings
  readonly status: ClientSettingsScopeSnapshot<Partial<RetrievalSettings>>['status']
  readonly writable: boolean
  readonly saving: boolean
  readonly error: 'SETTINGS_CHANGED' | undefined
}

export class RetrievalSettingsController {
  readonly #listeners = new Set<() => void>()
  #snapshot: RetrievalSettingsState
  #saving = false
  #error: RetrievalSettingsState['error']
  readonly #unsubscribe: () => void

  constructor(private readonly scope: ClientSettingsScope<Partial<RetrievalSettings>>) {
    this.#snapshot = this.#project()
    this.#unsubscribe = scope.subscribe(() => { this.#publish() })
  }

  getSnapshot = (): RetrievalSettingsState => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  async setField(field: keyof RetrievalSettings, value: unknown): Promise<void> {
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

  #project(): RetrievalSettingsState {
    const snapshot = this.scope.getSnapshot()
    return Object.freeze({
      retrieval: { ...RETRIEVAL_DEFAULTS, ...snapshot.value },
      status: snapshot.status,
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

export function RetrievalSettingsSection({ controller }: { readonly controller: RetrievalSettingsController }): ReactElement {
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
