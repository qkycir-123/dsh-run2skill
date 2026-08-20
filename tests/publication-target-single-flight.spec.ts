import { describe, expect, it } from 'vitest'
import { PublicationTargetSingleFlight } from '../src/adapters/dsh-publication/index.js'

describe('Publication target single-flight', () => {
  it('serializes one canonical target while allowing different targets to proceed', async () => {
    const flights = new PublicationTargetSingleFlight()
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const root = process.platform === 'win32' ? 'D:\\workspace\\skill\\SKILL.md' : '/workspace/skill/SKILL.md'
    const same = process.platform === 'win32' ? 'd:\\workspace\\skill\\SKILL.md' : '/workspace/skill/./SKILL.md'
    const other = process.platform === 'win32' ? 'D:\\workspace\\other\\SKILL.md' : '/workspace/other/SKILL.md'

    const first = flights.run(root, async () => {
      events.push('first:start')
      await firstGate
      events.push('first:end')
    })
    const second = flights.run(same, async () => { events.push('second') })
    const independent = flights.run(other, async () => { events.push('other') })
    await independent
    expect(events).toEqual(['first:start', 'other'])
    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'other', 'first:end', 'second'])
    expect(flights.activeTargetCount).toBe(0)
  })
})
