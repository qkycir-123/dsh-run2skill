import { GlobalV1Schema, type GlobalV1 } from '../../domain/observe/schemas.js'
import type { Run2skillDomain } from './types.js'

export class Run2skillGlobalStore {
  static readonly #instances = new WeakMap<Run2skillDomain, Run2skillGlobalStore>()

  static for(domain: Run2skillDomain): Run2skillGlobalStore {
    let instance = this.#instances.get(domain)
    if (instance === undefined) {
      instance = new Run2skillGlobalStore(domain)
      this.#instances.set(domain, instance)
    }
    return instance
  }

  #tail: Promise<void> = Promise.resolve()

  private constructor(private readonly domain: Run2skillDomain) {}

  get(): GlobalV1 {
    return GlobalV1Schema.parse(this.domain.global.get())
  }

  update(transform: (current: GlobalV1) => GlobalV1): Promise<GlobalV1> {
    const result = this.#tail.then(async () => {
      const next = GlobalV1Schema.parse(transform(this.get()))
      await this.domain.global.set(next)
      return next
    })
    this.#tail = result.then(() => {}, () => {})
    return result
  }
}
