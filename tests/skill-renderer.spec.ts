import { describe, expect, it } from 'vitest'
import { renderCanonicalSkill } from '../src/application/curation/index.js'

describe('canonical Skill renderer', () => {
  it('renders DSH-recognized invocation keys and stable LF bytes', () => {
    expect(renderCanonicalSkill({
      name: 'review-hygiene',
      description: 'Review "carefully".',
      whenToUse: 'Use for reviews.\r\nAlways.',
      content: '# Review\r\n\r\nCheck the diff.\r\n',
      invocation: { modelInvocable: true, userInvocable: false },
    })).toBe([
      '---',
      'name: review-hygiene',
      'description: "Review \\"carefully\\"."',
      'whenToUse: "Use for reviews.\\nAlways."',
      'disable-model-invocation: false',
      'user-invocable: false',
      '---',
      '',
      '# Review',
      '',
      'Check the diff.',
      '',
    ].join('\n'))
  })
})
