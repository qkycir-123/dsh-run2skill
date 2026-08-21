import { GlobalV2Schema, type GlobalV2 } from '../../domain/v2/index.js'
import type { Run2skillV2Domain } from './v2-types.js'

export interface V2MutationResult<T> {
  readonly value: T
  readonly global?: GlobalV2
}

export class Run2skillV2GlobalStore {
  static readonly #instances = new WeakMap<Run2skillV2Domain, Run2skillV2GlobalStore>()

  static for(domain: Run2skillV2Domain): Run2skillV2GlobalStore {
    let instance = this.#instances.get(domain)
    if (instance === undefined) {
      instance = new Run2skillV2GlobalStore(domain)
      this.#instances.set(domain, instance)
    }
    return instance
  }

  #tail: Promise<void> = Promise.resolve()

  private constructor(private readonly domain: Run2skillV2Domain) {}

  get(): GlobalV2 {
    return GlobalV2Schema.parse(this.domain.global.get())
  }

  runExclusive<T>(operation: (current: GlobalV2) => Promise<V2MutationResult<T>>): Promise<T> {
    const result = this.#tail.then(async () => {
      const mutation = await operation(this.get())
      if (mutation.global !== undefined) {
        await this.domain.global.set(GlobalV2Schema.parse(mutation.global))
      }
      return mutation.value
    })
    this.#tail = result.then(() => {}, () => {})
    return result
  }
}
