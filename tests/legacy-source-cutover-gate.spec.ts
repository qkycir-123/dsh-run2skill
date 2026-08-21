import { describe, expect, it } from 'vitest'
import { LegacySourceCutoverGate } from '../src/application/migration/legacy-source-cutover-gate.js'

describe('LegacySourceCutoverGate', () => {
  it('drains already accepted mutations, rejects new writes during cutover, and seals permanently', async () => {
    const gate = new LegacySourceCutoverGate()
    const events: string[] = []
    let releaseMutation!: () => void
    const mutationBlocked = new Promise<void>(resolve => { releaseMutation = resolve })
    const accepted = gate.runLegacyMutation(async () => {
      events.push('legacy-start')
      await mutationBlocked
      events.push('legacy-end')
    })
    await Promise.resolve()
    const cutover = gate.sealAndRun(() => { events.push('cutover') })

    await expect(gate.runLegacyMutation(() => { events.push('late-write') }))
      .rejects.toThrow(/LEGACY_SOURCE_SEALED/)
    releaseMutation()
    await Promise.all([accepted, cutover])

    expect(events).toEqual(['legacy-start', 'legacy-end', 'cutover'])
    expect(gate.state).toBe('SEALED')
    await expect(gate.runLegacyMutation(() => {})).rejects.toThrow(/LEGACY_SOURCE_SEALED/)
  })

  it('reopens legacy writes if cutover fails before commit', async () => {
    const gate = new LegacySourceCutoverGate()
    await expect(gate.sealAndRun(() => { throw new Error('migration failed') })).rejects.toThrow('migration failed')
    await expect(gate.runLegacyMutation(() => 'ok')).resolves.toBe('ok')
  })
})
