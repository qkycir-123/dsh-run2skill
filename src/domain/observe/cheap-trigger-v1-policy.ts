import { TRIGGER_KIND_ORDER, TRIGGER_POLICY_VERSION } from './constants.js'
import type { TriggerHit } from './schemas.js'

export type TriggerKind = TriggerHit['kind']

export const CHEAP_TRIGGER_V1_POLICY = Object.freeze({
  version: TRIGGER_POLICY_VERSION,
  kindOrder: TRIGGER_KIND_ORDER satisfies readonly TriggerKind[],
  explicitSave: {
    saveWords: String.raw`(?:保存|记录|记住|沉淀|存成|\b(?:save|remember|capture)\b)`,
    targetWords: String.raw`(?:技能|规则|流程|做法|复用|\b(?:skill(?:s)?|workflow|process|reuse)\b)`,
    fixedPhrases: String.raw`(?:记住这个(?:做法|流程|规则)|\bremember this\b)`,
    requestContext: String.raw`(?:^|[。！？.!?]\s*)(?:(?:(?:(?:could|would) you please|please|can you|could you|would you)\s+)?\b(?:save|remember|capture)\b|i (?:want|need) you to \b(?:save|remember|capture)\b|(?:请|请把|把|将|帮我|麻烦).{0,24}(?:保存|记录|记住|沉淀|存成|\b(?:save|remember|capture)\b)|(?:保存|记录|记住|沉淀|存成))`,
    negation: String.raw`(?:\b(?:do not|don't|never|without)\b|不要|别|无需|不用|禁止).{0,32}(?:保存|记录|记住|沉淀|存成|\b(?:save|remember|capture)\b)`,
    maxDistance: 64,
  },
  correction: {
    anchors: String.raw`(?:不对|错了|不是这样|更正|纠正|that's wrong|that is wrong|incorrect)`,
    behaviorWords: String.raw`(?:以后|后续|必须|应该|不要|不得|不能|只允许|只能|先.+?(?:再|然后)|from now on|going forward|must|should|never|always|instead)`,
  },
  constraint: {
    persistentScope: String.raw`(?:以后|后续|从现在开始|这个项目|本项目|所有(?:文档|任务|回复)|每次|from now on|going forward|for this project|all future|every time)`,
    operators: String.raw`(?:必须|不得|禁止|不能|只允许|只能|务必|must|never|only|always|prohibit|forbid|should always)`,
  },
  workflow: {
    reusableScope: String.raw`(?:以后|后续|每次|遇到|当.+?时|from now on|whenever|every time|for future|going forward)`,
    processWords: String.raw`(?:流程|步骤|workflow|process)`,
    orderedSteps: [
      { start: '先', ends: ['再', '然后', '最后'] },
      { start: 'first', ends: ['then', 'next', 'finally'] },
    ],
  },
})
