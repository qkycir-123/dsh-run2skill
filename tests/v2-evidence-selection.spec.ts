import { describe, expect, it } from 'vitest'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import { isExplicitSaveRequestV1 } from '../src/domain/observe/trigger.js'
import { selectBoundedEvidenceRefsV2 } from '../src/domain/v2/index.js'

function ref(messageSeq: number, excerpt: string) {
  return {
    source: 'USER_DIRECT' as const,
    messageSeq,
    excerpt,
    excerptDigest: sha256Utf8(excerpt),
    redactionKinds: [],
    truncated: false,
    observationId: `observation-${String(messageSeq)}`,
  }
}

describe('v2 bounded evidence selection', () => {
  it.each([
    ['请把这个流程记录为技能。', true],
    ['Please capture this workflow as a skill.', true],
    ['不要把这个流程保存成技能。', false],
    ['Do not save this workflow as a skill.', false],
    ['请解释如何把流程保存成技能。', false],
    ['Please explain how to capture this workflow as a skill.', false],
    ['文档示例写的是“把这个流程保存成技能”。', false],
    ['The quoted example says "save this workflow as a skill".', false],
  ])('reuses full cheap-trigger explicit-save semantics: %s', (text, expected) => {
    expect(isExplicitSaveRequestV1(text as string)).toBe(expected)
  })

  it.each([8 * 1024, 16 * 1024])(
    'keeps the true save request when negative, explanatory, and quoted save text competes at %i bytes',
    budget => {
      const positive = '请把这套流程记录为技能。'
      const negativeFlood = Array.from({ length: 80 }, (_, index) => (
        `Do not save this workflow as a skill NEGATIVE_${String(index)}.`
      )).join('\n')
      const explanationFlood = Array.from({ length: 80 }, (_, index) => (
        `Please explain how to capture this workflow as a skill EXPLANATION_${String(index)}.`
      )).join('\n')
      const quotedFlood = Array.from({ length: 80 }, (_, index) => (
        `The docs say "save this workflow as a skill" QUOTED_${String(index)}.`
      )).join('\n')
      const selected = selectBoundedEvidenceRefsV2([
        ref(1, `${positive}\n${'旧背景。'.repeat(1_000)}`),
        ref(2, negativeFlood),
        ref(3, explanationFlood),
        ref(4, quotedFlood),
        ref(5, `${'最新背景。'.repeat(1_000)}\nTRUE_LATEST_TAIL`),
      ], budget)
      const text = selected.map(item => item.excerpt).join('\n')

      expect(text).toContain(positive)
      expect(selected.reduce((total, item) => total + Buffer.byteLength(item.excerpt, 'utf8'), 0))
        .toBeLessThanOrEqual(budget)
    },
  )

  it('reserves every strong semantic class and the true latest tail before competitive fill', () => {
    const saveFlood = Array.from({ length: 20 }, (_, index) => (
      `Please capture this workflow as a skill for reuse SAVE_FLOOD_${String(index)}.`
    )).join('\n')
    const selected = selectBoundedEvidenceRefsV2([
      ref(1, saveFlood),
      ref(2, [
        '禁止项：不得跳过读回核验。',
        '验收条件：typecheck、lint 和完整测试全部通过。',
        '关键步骤：先读取，再修改，最后重新读取。',
        '约束：必须只修改目标字段。',
      ].join('\n')),
      ref(3, `${'最新普通背景。'.repeat(180)}\nTRUE_LATEST_TAIL: 最终用户更正了发布目录。`),
    ], 4 * 1024)

    const text = selected.map(item => item.excerpt).join('\n')
    expect(text).toContain('capture this workflow')
    expect(text).toContain('不得跳过读回核验')
    expect(text).toContain('验收条件')
    expect(text).toContain('先读取，再修改，最后重新读取')
    expect(text).toContain('必须只修改目标字段')
    expect(text).toContain('TRUE_LATEST_TAIL')
    expect(text.match(/SAVE_FLOOD_/gu)?.length ?? 0).toBeLessThanOrEqual(2)
    expect(selected.reduce((total, item) => total + Buffer.byteLength(item.excerpt, 'utf8'), 0))
      .toBeLessThanOrEqual(4 * 1024)
  })

  it.each([
    '请把这个流程存成技能。',
    '请记录这套做法为技能。',
    'Please capture this workflow as a skill.',
  ])('shares explicit-save vocabulary with the cheap trigger policy: %s', phrase => {
    const selected = selectBoundedEvidenceRefsV2([
      ref(1, `${'普通背景。'.repeat(1_500)}\n${phrase}`),
      ref(2, `${'更新背景。'.repeat(1_500)}\nLATEST`),
    ], 2 * 1024)

    expect(selected.map(item => item.excerpt).join('\n')).toContain(phrase)
  })

  it('never splits a multibyte character at the exact UTF-8 budget', () => {
    const selected = selectBoundedEvidenceRefsV2([
      ref(1, `${'甲乙丙丁🙂。'.repeat(1_000)}\n不得跳过验证。`),
      ref(2, `${'戊己庚辛🚀。'.repeat(1_000)}\nLATEST_TAIL`),
    ], 2_047)
    const text = selected.map(item => item.excerpt).join('\n')

    expect(selected.reduce((total, item) => total + Buffer.byteLength(item.excerpt, 'utf8'), 0))
      .toBeLessThanOrEqual(2_047)
    expect(text).not.toContain('\uFFFD')
    expect(text).toContain('LATEST_TAIL')
  })

  it('fails closed when the budget cannot retain every present mandatory class', () => {
    const selected = selectBoundedEvidenceRefsV2([
      ref(1, '请把这个流程记录为技能。'),
      ref(2, '不得跳过验证。'),
      ref(3, 'LATEST_TAIL'),
    ], 16)

    expect(selected).toEqual([])
  })
})
