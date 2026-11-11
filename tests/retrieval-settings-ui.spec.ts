// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AutomaticLearningSettingsController, RetrievalSettingsSection,
  type AutomaticLearningClientSettings, type ClientSettingsScopeSnapshot,
} from '../src/client/automatic-learning-settings.js'

afterEach(cleanup)

it('keeps advanced recall off by default and persists model/service selections through the host settings seam', async () => {
  let snapshot: ClientSettingsScopeSnapshot<AutomaticLearningClientSettings> = {
    status: 'ready', value: { automaticLearning: true }, revision: 1, writable: true,
  }
  const listeners = new Set<() => void>()
  const set = vi.fn(async (key: string, value: unknown) => {
    snapshot = { ...snapshot, value: { ...snapshot.value!, [key]: value }, revision: snapshot.revision! + 1 }
    for (const listener of listeners) listener()
    return true
  })
  const controller = new AutomaticLearningSettingsController({
    getSnapshot: () => snapshot, subscribe: callback => { listeners.add(callback); return () => { listeners.delete(callback) } }, set,
  })
  render(createElement(RetrievalSettingsSection, { controller }))
  expect((screen.getByRole('checkbox', { name: '高级召回' }) as HTMLInputElement).checked).toBe(false)
  expect(screen.queryByLabelText('Embedding 接口地址')).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: '高级召回' }))
  await waitFor(() => expect(screen.getByLabelText('Embedding 接口地址')).toBeTruthy())
  const endpoint = screen.getByLabelText('Embedding 接口地址')
  fireEvent.change(endpoint, { target: { value: 'https://example.com/v1/embeddings' } })
  fireEvent.blur(endpoint)
  await waitFor(() => expect(set).toHaveBeenCalledWith('embeddingEndpoint', 'https://example.com/v1/embeddings'))
  fireEvent.change(screen.getByLabelText('重排方式'), { target: { value: 'SERVICE' } })
  await waitFor(() => expect(screen.getByLabelText('Reranker 模型')).toBeTruthy())
  expect((screen.getByLabelText('Reranker 模型') as HTMLInputElement).value).toBe('Qwen/Qwen3-Reranker-0.6B')
  fireEvent.click(screen.getByRole('checkbox', { name: '高级召回' }))
  await waitFor(() => expect(screen.queryByLabelText('Embedding 接口地址')).toBeNull())
  expect(snapshot.value!.embeddingEndpoint).toBe('https://example.com/v1/embeddings')
  controller.dispose()
})
