import type { CaptureWorkItemV1, GlobalV1 } from '../../domain/observe/schemas.js'

export interface Run2skillTable<K extends string, V> {
  get(key: K): V | undefined
  entries(): IterableIterator<[K, V]>
  keys(): IterableIterator<K>
  readonly size: number
  put(key: K, value: V): Promise<void>
  delete(key: K): Promise<boolean>
  update(key: K, transform: (current: V) => V): Promise<V>
}

export interface Run2skillDomain {
  readonly name: 'run2skill_v1'
  readonly global: {
    get(): GlobalV1
    set(value: GlobalV1): Promise<void>
  }
  table(name: 'work_items'): Run2skillTable<string, CaptureWorkItemV1>
  close(): Promise<void>
}

export interface Run2skillStorageContext {
  readonly storageDomain: {
    open(spec: typeof import('./domain.js').run2skillDomainSpec): Promise<Run2skillDomain>
  }
}
