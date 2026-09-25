import { describe, expectTypeOf, it } from 'vitest'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { DshSessionPersistencePort } from '../src/adapters/dsh-session/index.js'

describe('DSH 0.1.3-alpha.2 Session persistence contract', () => {
  it('keeps the official service structurally compatible with the run2skill reader boundary', () => {
    expectTypeOf<SessionPersistence>().toMatchTypeOf<DshSessionPersistencePort>()
  })
})
