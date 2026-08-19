import { DomainError } from '../../domain/observe/errors.js'
import {
  CaptureWorkItemV1Schema,
  type CaptureWorkItemV1,
} from '../../domain/observe/schemas.js'
import {
  mergeCaptureWorkItems,
  sameCaptureWorkItemFacts,
} from '../../domain/observe/work-item.js'
import { canonicalizeSignalKey } from '../../domain/observe/signal-key.js'
import type { Run2skillDomain } from './types.js'

export interface DurableCaptureResult {
  readonly item: CaptureWorkItemV1
  readonly changed: boolean
}

function latestIso(...values: string[]): string {
  return values.reduce((latest, candidate) => (
    Date.parse(candidate) > Date.parse(latest) ? candidate : latest
  ))
}

export class DurableCaptureStore {
  readonly #table
  readonly #now
  #tail: Promise<void> = Promise.resolve()

  constructor(
    domain: Run2skillDomain,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.#table = domain.table('work_items')
    this.#now = now
  }

  persist(value: CaptureWorkItemV1): Promise<DurableCaptureResult> {
    const operation = this.#tail.then(async () => await this.#persist(value))
    this.#tail = operation.then(() => {}, () => {})
    return operation
  }

  get(workItemId: string): CaptureWorkItemV1 | undefined {
    return this.#table.get(workItemId)
  }

  async #persist(value: CaptureWorkItemV1): Promise<DurableCaptureResult> {
    const storedAtRequestedId = this.#table.get(value.workItemId)
    if (
      storedAtRequestedId !== undefined
      && canonicalizeSignalKey(storedAtRequestedId.signalKey) !== canonicalizeSignalKey(value.signalKey)
    ) {
      throw new DomainError('SIGNAL_KEY_CONFLICT')
    }
    const parsed = CaptureWorkItemV1Schema.safeParse(value)
    if (!parsed.success) throw new DomainError('INVALID_WORK_ITEM')
    const incoming = parsed.data
    const existing = storedAtRequestedId
    if (existing === undefined) {
      const initial = CaptureWorkItemV1Schema.parse({ ...incoming, revision: 1 })
      await this.#table.put(initial.workItemId, initial)
      return { item: initial, changed: true }
    }

    const preview = mergeCaptureWorkItems(existing, incoming)
    if (sameCaptureWorkItemFacts(existing, preview)) return { item: existing, changed: false }

    const item = await this.#table.update(incoming.workItemId, (current) => {
      const merged = mergeCaptureWorkItems(current, incoming)
      if (sameCaptureWorkItemFacts(current, merged)) return current
      return CaptureWorkItemV1Schema.parse({
        ...merged,
        revision: current.revision + 1,
        updatedAt: latestIso(current.updatedAt, incoming.updatedAt, this.#now()),
      })
    })
    return { item, changed: true }
  }
}
