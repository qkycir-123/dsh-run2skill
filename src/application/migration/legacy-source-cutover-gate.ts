export class LegacySourceCutoverError extends Error {
  constructor(readonly code: 'LEGACY_SOURCE_SEALED') {
    super(code)
    this.name = 'LegacySourceCutoverError'
  }
}

/**
 * Serializes every legacy mutation with the v1 -> v2 cutover and permanently
 * rejects v1 writes after a successful migration commit.
 */
export class LegacySourceCutoverGate {
  #state: 'ACCEPTING' | 'CUTTING_OVER' | 'SEALED' = 'ACCEPTING'
  #tail: Promise<void> = Promise.resolve()

  get state(): 'ACCEPTING' | 'CUTTING_OVER' | 'SEALED' { return this.#state }

  async runLegacyMutation<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.#state !== 'ACCEPTING') throw new LegacySourceCutoverError('LEGACY_SOURCE_SEALED')
    const previous = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  async sealAndRun<T>(
    operation: () => T | Promise<T>,
    durableCommitObserved: () => boolean = () => false,
  ): Promise<T> {
    if (this.#state === 'SEALED') return operation()
    if (this.#state !== 'ACCEPTING') throw new LegacySourceCutoverError('LEGACY_SOURCE_SEALED')
    this.#state = 'CUTTING_OVER'
    const acceptedMutations = this.#tail
    await acceptedMutations
    try {
      const result = await operation()
      this.#state = 'SEALED'
      return result
    } catch (error) {
      this.#state = durableCommitObserved() ? 'SEALED' : 'ACCEPTING'
      throw error
    }
  }
}
