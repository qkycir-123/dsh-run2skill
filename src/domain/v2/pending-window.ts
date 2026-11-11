import type { BatchDetectorInput } from '../../application/detection/batch-detector-worker.js'

const reusableCue = /以后|今后|每次|统一|始终|必须|禁止|不要再|应该先|改成|纠正|记住|保存.*(?:skill|技能)|可复用|流程|约束|instead|always|never|from now on|remember|workflow|constraint|correction/iu

/** Select evidence windows, not conclusions. The model still decides NONE/DEFER/READY. */
export function selectPendingWindow(input: BatchDetectorInput, limit = 32): BatchDetectorInput {
  if (input.observations.length <= limit) return input
  const carried = new Set(input.carry.flatMap(item => item.evidenceDigests))
  const observations = input.observations
  const priority = observations.map((item, index) => {
    const text = item.directUserEvidence.map(evidence => evidence.excerpt).join('\n')
    const related = carried.has(item.evidenceDigest)
    const cue = reusableCue.test(text)
    return { index, priority: related ? 5 : cue ? 4 : index >= observations.length - 4 ? 3 : 0 }
  })
  // Keep the surrounding action/result, including non-adjacent evidence of the same pending experience.
  for (const item of priority) {
    if (item.priority < 4) continue
    for (const index of [item.index - 1, item.index + 1]) {
      if (priority[index]) priority[index]!.priority = Math.max(priority[index]!.priority, 2)
    }
  }
  const selected = new Set(priority.sort((a, b) => b.priority - a.priority || b.index - a.index).slice(0, limit).map(item => item.index))
  return { ...input, observations: observations.filter((_, index) => selected.has(index)) }
}
