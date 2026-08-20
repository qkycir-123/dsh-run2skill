import { isAbsolute, normalize, resolve } from 'node:path'

export class PublicationTargetSingleFlight {
  readonly #tails = new Map<string, Promise<void>>()

  async run<T>(canonicalTargetPath: string, task: () => Promise<T>): Promise<T> {
    if (!isAbsolute(canonicalTargetPath)) throw new Error('PUBLICATION_TARGET_NOT_ABSOLUTE')
    const key = process.platform === 'win32'
      ? normalize(resolve(canonicalTargetPath)).toLowerCase()
      : normalize(resolve(canonicalTargetPath))
    const previous = this.#tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolveCurrent) => { release = resolveCurrent })
    const tail = previous.then(() => current)
    this.#tails.set(key, tail)
    await previous
    try {
      return await task()
    } finally {
      release()
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    }
  }

  get activeTargetCount(): number {
    return this.#tails.size
  }
}
