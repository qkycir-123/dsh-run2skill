# SessionBatch 语义检测、完整召回与分阶段学习设计

状态：PROPOSED

对应 Issue：[#84](https://github.com/qkycir-123/dsh-run2skill/issues/84)

更新时间：2026-08-22

## 1. 范围审计

本设计只重构 Run2Skill 从会话观察到 Proposal 生成之前的核心流水线。当前插件尚无外部用户，`run2skill_v1` 中的 Proposal 和中间缓存不做兼容迁移。

本设计包含：

- `TurnObservation -> SessionBatch -> ExperienceIntent` 的 durable 状态机；
- 5 个完整 Turn、空闲 30 分钟和显式保存三类调度；
- ExperienceIntent 级单一生成所有者；
- complete Catalog 的全量摘要筛选、候选全文读取与动态总预算；
- coverage 与 generation 分阶段调用和独立账本；
- 去重、崩溃恢复、fresh activation、回退、Action Queue 和验收矩阵。

本设计不包含：

- 大型 Skill 的自动 Markdown patch merge；
- 自动批准或发布 Proposal；
- 向量数据库、DSH 上游修改或第二套模型 Provider；
- 把内部窗口、预算或重试常数暴露为普通用户设置；
- 改写已发布 Skill 或 DSH Session Log。

现有发布文件 CAS、审核、exact readback 和 Purge 的安全边界继续有效。Proposal 生成不要求 DSH Runtime Catalog 提供 CAS 或共享锁。`single-owner-skill-save.md` 中 Agent-first、完整事实和 fail-closed 原则继续有效，但其“每个命中 Turn 建立 WorkItem/TurnBaseline”的机制由本设计取代。

## 2. 设计结论

1. 普通 durable root `turn/end` 只写最小 `TurnObservation`，不做语义判断。
2. 一个 Session lifecycle 内每 5 个完整 Turn 只做一次轻量检测；READY 只持久化 Intent。自动 Intent 等会话空闲 30 分钟后才进入 Agent-first/recall/coverage/generation；显式保存可在当前 Turn 完成且会话静默时立即继续。
3. 调度竞争通过同一连续 Turn 范围的确定性 `batchId` 和 durable CAS 收敛；触发原因不是身份的一部分。
4. Detector 只产出 `NONE | DEFER | READY`，不查 Skill、不生成正文。
5. READY Intent 先进入 `WAITING_FOR_QUIESCENCE`。只有 durable Turn 水位无缺口、没有更新 Turn、Agent 未运行且 activity revision 稳定，才取得 Session quiescence fence 并开始 Agent-first。
6. Catalog 必须 `complete=true`，且每个 summary 都得到确定性或语义分类；未完整扫描时 `CREATE=0`。
7. 取消单候选 8 KiB 限制。候选正文必须完整读取并以总模型输入预算决定能否参与；不得静默截断。
8. coverage 只产出 `UNRELATED | COVERED | PARTIAL | AMBIGUOUS`；generation 只接受已证明安全的 CREATE 或唯一 MERGE target。
9. 以 behavior signature 的全局 single-flight 和唯一 active lineage 避免跨批次、跨 Session 重复 Proposal。
10. 使用新 `run2skill_v2` Domain；首次启用只为现有 DSH Session 建立观察水位，不复制 `run2skill_v1` Proposal 或中间缓存。已发布 Skill 和 DSH Session Log 不受影响。
11. Proposal commit 使用“Session quiescence fence + generation 前 Catalog 重校验 + 审核/发布前再次校验 + stale 回退”；不修改 DSH 上游，也不把 Runtime Catalog CAS/共享锁作为前置条件。

## 3. Durable 模型

### 3.1 TurnObservation

`TurnObservationV2` 是一个完整 root Turn 的最小、不可变投影：

| 字段 | 语义 |
|---|---|
| `observationId` | `sessionLifecycleKey + turnEndSeq + turnInstanceDigest` 的确定性 hash |
| `sessionLifecycleKey` | root session id、session createdAt、cwd digest 的稳定组合 |
| `turn / turnEndSeq / turnInstanceDigest` | DSH durable 坐标与重放身份 |
| `workspaceBinding` | PROJECT 绑定或明确的 unavailable 状态 |
| `directUserEvidence` | 脱敏、限长、带 message/event 坐标的用户证据 |
| `assistantOutcomeSummary` | 最终结果的有界摘要，不保存完整回复 |
| `toolOutcomeSummary` | 工具类型、成功/失败、产物类型和生成迹象，不保存原始输出 |
| `routeObservation` | 本 Turn 或 Session 最近一次有效 provider/model 事实 |
| `completeness` | `COMPLETE` 或带 blocker 的 `INCOMPLETE` |
| `contentDigest` | 上述规范化事实的 digest |

同一 `observationId` 只允许 identical replay；不同内容写同一 ID 是 identity conflict，进入健康诊断，不能覆盖旧事实。普通 Turn 的该写入不调用 LLM，也不读取 Skill 正文。

`directUserEvidence` 对所有直接用户消息做确定性的脱敏和有界摘录，不以旧版关键词规则作为保留前提；否则没有固定措辞的经验无法进入每 5 Turn 的语义检测。持久证据保留用户引用和 fenced code，旧版会排除引用/code 的轻量规则只复用于判定 `explicitSaveRequested`，不会替代语义 Detector。无法安全表达的直接用户非文本块必须使 Observation 退化为 metadata-only `INCOMPLETE`。`toolOutcomeSummary` 只从同一 Turn 内持久化的 `tool/call` 与配对 `tool/result` 派生工具名、结果状态和内容 digest，绝不复制工具原始输出；配对不完整时同样退化为 `INCOMPLETE`。适配器只允许跳过 DSH 已知事件或 envelope 明确标记 `ignorable: true` 的扩展事件；未知 required event 必须拒绝投影，不能把有损重建标记为完整。

### 3.2 SessionCursor 与 BatchManifest

每个 Session lifecycle 在 global 中保存：

- `observedThroughTurnEndSeq`：已持久观察的连续前缀；
- `detectedThroughTurnEndSeq`：已提交 Detector 结果的连续前缀；
- `activeBatchId`：当前冻结批次；
- `lastActivityAt`：只由 durable TurnObservation 推进；
- `openExperienceCarry`：最多 3 个 DEFER 的有界摘要、行为签名草案和证据 digest；
- `batchManifestBaseline`：本批次第一次 Agent 执行前取得的 path-free、完整 root manifest 与 catalog digest。

Manifest 只在批次开启时建立一次。若插件在批次中途激活、baseline 写入失败、root composition 不完整或策略版本不一致，观察仍可继续，但 READY Intent 的所有权只能进入 `NEEDS_CONFIRMATION`。

### 3.3 SessionBatch

`batchId` 只由以下事实派生：

```text
sessionLifecycleKey + firstTurnEndSeq + lastTurnEndSeq + detectorPolicyVersion
```

阈值、idle、显式保存同时竞争同一范围时得到同一 ID。`triggerReasons` 是可合并集合，优先级只影响调度延迟：`EXPLICIT > THRESHOLD > IDLE`。

状态机：

```text
FROZEN
  -> DETECTION_CLAIMED
     -> COMMITTED_NONE
     -> COMMITTED_DEFER
     -> COMMITTED_READY
     -> NEEDS_ATTENTION
```

- `FROZEN`：Turn 范围、观察 digests、route、manifest end observation 和调用计划不可变。
- `DETECTION_CLAIMED`：Detector call slot 已 durable 预留。
- `COMMITTED_*`：Detector 结果及扫描水位在同一 authoritative mutation 中提交。
- `NEEDS_ATTENTION`：输入不完整、调用结果未知或结构化结果不可安全解释。

一个 batch 只有一个 Detector call slot。进程重启发现 `DETECTION_CLAIMED` 且没有 durable terminal call record 时，标记 `CALL_OUTCOME_UNKNOWN`，不得自动用相同输入再次调用模型。这样牺牲一次自动恢复，换取“崩溃不重复语义调用”的硬保证；用户可在 Action Queue 触发一个带新 authorization revision 的显式恢复。

### 3.4 ExperienceIntent

Detector 的 READY 结果最多产生 3 个 `ExperienceIntentV2`：

| 字段 | 语义 |
|---|---|
| `intentId` | lifecycle、behavior signature、evidence digest set、detector policy 的 hash |
| `behaviorSignature` | 类型、适用场景、关键行为/禁止项、scope intent 的规范化语义签名 |
| `evidenceRefs` | 原始 Session 坐标与脱敏 digest，不复制整段 Session |
| `completeness` | READY 的完整度和必要缺口 |
| `ownership` | Agent-first 裁决与证据 digest |
| `recall` | Catalog observation、summary classification、candidate capabilities |
| `coverage` | 独立覆盖结论和调用账本 |
| `generation` | CREATE/MERGE target、调用账本和唯一 Proposal identity |
| `lineageId` | scope + behavior signature 的唯一活动 lineage |

Intent 状态机：

```text
DETECTOR_STAGED
  -> WAITING_FOR_QUIESCENCE
     -> READY
  -> OWNERSHIP_ARBITRATING
     -> RESOLVED_BY_AGENT
     -> NEEDS_CONFIRMATION
     -> RUN2SKILL_OWNED
  -> RECALLING
     -> COVERAGE_READY
     -> NEEDS_ATTENTION
  -> COVERAGE_ANALYZING
     -> COVERED
     -> COVERED_NEEDS_CONFIRMATION
        -> DISCARDED
        -> COVERAGE_RETRY_AUTHORIZED
     -> CREATE_AUTHORIZED
     -> MERGE_AUTHORIZED
     -> NEEDS_ATTENTION
  -> GENERATING
     -> PROPOSAL_READY
     -> NEEDS_ATTENTION
```

每个阶段只允许单向提交。输入 observation digest、policy version 或 target digest 变化时，旧结果不能续用，必须新建明确 revision，不得就地偷换输入。

`GENERATING` 的权威子状态不是一组并列的失败状态，而是以下单向提交链：

```text
GENERATION_AUTHORIZED
  -> GENERATION_LEASED
  -> GENERATION_CALL_RESERVED
  -> GENERATION_CALL_TERMINAL
     -> RESULT_COMMITTED
     -> PROPOSAL_COMMIT_AUTHORIZED
     -> PROPOSAL_BODY_COMMITTED
     -> PROPOSAL_READY
  -> NEEDS_ATTENTION(reasonCode)

NEEDS_ATTENTION(retryable generation reason)
  -> GENERATION_AUTHORIZED(new revision, userRetryUsed=true)
  -> DISCARDED(user confirmed)

NEEDS_ATTENTION(STALE_RESULT)
  -> RECALLING(new revision, staleRefreshUsed=true)
  -> DISCARDED(user confirmed)
```

`GENERATION_KNOWN_FAILED`、`GENERATION_RESULT_LOST`、`GENERATION_OUTCOME_UNKNOWN` 和 `STALE_RESULT` 只是 `NEEDS_ATTENTION` 的 generation reason code，不是 Intent 平级状态。前三者的 `AUTHORIZE_GENERATION_RETRY` 只能新建 revision 回到 `GENERATION_AUTHORIZED`；`STALE_RESULT` 不允许直接回 generation，必须通过 `REFRESH_STALE_RESULT` 新建 revision 并重走完整 recall/coverage。`DISMISS_GENERATION` 只能在用户确认后提交 `DISCARDED`。`HANDLED_BY_USER` 仅属于 ownership 裁决，不能用于掩盖已经授权但失败的 generation。

## 4. 调度与恢复

### 4.1 5-Turn threshold

只有 `completeness=COMPLETE` 的 Turn 计入阈值。`detectedThrough` 之后累计第 5 个完整 Turn 时，冻结当前连续范围并只运行 Detector。READY 只提交 `ExperienceIntent + WAITING_FOR_QUIESCENCE`，不在检查点继续 recall、coverage 或 generation。INCOMPLETE 观察保留并阻止跨缺口 absence proof；它不被跳过拼成一个看似连续的 batch。

### 4.2 30-minute idle flush

idle deadline 是最后一个 durable TurnObservation 的 `observedAt + 30m`。计时器只负责唤醒，权威判断来自 Store：

1. 到期后读取 cursor、durable observed/detected tail 与 live Agent activity；
2. 只有水位相等、无 active batch、Agent 未运行且 activity revision 完整时，提交绑定这些事实的 Session quiescence fence；
3. 若等待期间出现新 Turn、Agent 恢复运行或 activity revision 变化，取消/延后本轮下游处理，并把新证据纳入后续 batch；
4. 启动恢复发现 durable 尾部已空闲超过 30 分钟时仍执行同一重校验，不能仅凭旧 deadline 继续 generation。

### 4.3 explicit save

显式“保存为 Skill/记住该流程”等由 TurnObservation 的 direct-user evidence 确定性标记。该标记不直接生成 Skill，只在当前 Turn 完成后立即冻结从 `detectedThrough + 1` 到当前 Turn 的范围。若此前有 DEFER carry，一并作为有界数据输入。显式保存不等待 5 Turn 或 30 分钟，但必须先确认没有新 Turn、Agent 未运行并取得同一 Session quiescence fence；否则延后，不能与 Agent 并发生成。之后仍必须经过 detector、所有权、完整 recall 和 coverage。

### 4.4 single-flight

- 每个 Session lifecycle 同时最多一个 active SessionBatch worker；
- 进程全局使用固定小并发上限；
- 每个 behavior signature + scope 同时最多一个 active lineage owner；
- authoritative queue 来自 Store，不维护不可恢复的内存任务副本。

## 5. Batch Detector

Detector 输入只包含冻结 batch 的有界 TurnObservation、最多 3 个 DEFER carry、来源标签和 route，不包含 Skill Catalog。

TurnObservation 不再对每条 direct-user message 只截取固定前缀。文本必须先完成 secret 与控制字符处理，再在整个观察窗口共享的严格 UTF-8 byte 预算内，确定性为显式保存、禁止项、验收/验证、顺序步骤、约束和真实最新尾部分别保留最低配额，再填充其余语义；任一类都有上限，不得吞掉其他强语义。显式保存分类必须复用 Cheap Trigger 的完整分句、请求上下文、否定和解释语义；否定、解释或引用的保存文字不得占用正向保存配额。Detector 随后对整个 batch 使用第二层严格 evidence 总预算，并以实际 system prompt 与序列化 user JSON 计算 route 输入总量。超限时先有界压缩 assistant/tool/carry 辅助字段，再按上述配额缩减 direct-user evidence；必须保留 observation/evidence 绑定，最小安全 envelope 仍无法容纳时才 fail closed。模型调用与 durable claim 共用同一投影，`inputDigest` 精确绑定实际发送数据；不发送完整 Session，不增加逐 Turn LLM。

输出：

- `NONE`：没有稳定、可复用且有真实执行证据的经验；
- `DEFER`：经验可能存在但尚未完成，输出有界 carry；
- `READY`：最多 3 个结构化 ExperienceIntent。

每个 batch 的正常预算是 1 次调用。无格式修复循环；非法结构、输出截断或调用终态不确定进入 `NEEDS_ATTENTION`。`NONE` 和 `DEFER` 的 recall、coverage、generation 调用数必须为 0。

DEFER carry 不保存原文，只保留最多 3 项、每项固定字节上限的语义摘要、签名草案和证据 digests；最多跨 2 个后续 batch。仍不完整则安全提交 NONE 或进入 Action Queue，不能无限扩大窗口。

## 6. 单一生成所有者

所有权以 ExperienceIntent 为单位，并在后续任何模型调用前完成。输入包括：

- batch 开始前的完整 EffectiveFilesystemRootSet manifest；
- batch 结束后的完整 manifest 与 complete Catalog；
- 变化候选的 `ctx.skills.get()` exact readback；
- Tool/Shell/Agent 生成迹象摘要；
- IntentBinding：显式 name/scope/target，或行为契约与候选正文的确定性绑定。

结论：

- `RESOLVED_BY_AGENT`：成功写入、完整 winner readback 与 IntentBinding 全部成立；后续模型调用 0。
- `RUN2SKILL_OWNED`：完整事实证明没有 Skill 生成行为且 manifest 无相关变化。
- `NEEDS_CONFIRMATION`：缺 baseline、root/catalog/get 不完整、变化不可归因、失败写入或正文已在 Agent 通道生成。后续模型调用 0。

“未观察到变化”“同回合唯一变化”或工具名称都不是充分证据。

## 7. Catalog 召回

### 7.1 complete snapshot

召回必须使用触发 Agent 的 exact view。Catalog `complete=false` 时只允许针对明确瞬态原因做有界重取；最终仍不完整则进入 `CATALOG_INCOMPLETE`，`CREATE=0`。

每个 summary 的持久投影只包含 name、description、whenToUse、source/provider、scope、writability 和稳定 candidate identity，不保存绝对路径。

### 7.2 全量摘要分类

1. exact name、稳定 alias 或确定性无关规则先分类；
2. 其余所有 summary 进入语义扫描；
3. 一次可容纳则整体扫描，超限则按稳定 candidate identity 分页；
4. 每页只返回 `RELEVANT | POSSIBLE | UNRELATED` 和 candidate identity；
5. 所有页完成且 Catalog digest 未变化，才提交完整 summary scan；
6. `RELEVANT` 和 `POSSIBLE` 都进入全文读取。

分页不是 Top N。计划调用数在开始前由 summary 数量和模型安全输入预算计算；若超过版本化 `MAX_CATALOG_SCAN_CALLS`，在调用前进入 `CATALOG_SCAN_BUDGET_EXHAUSTED`。未扫描项不能作为 absence proof。

### 7.3 去重身份

`candidateId` 由 provider、source、scope、winning name 和稳定 root identity 派生；summary digest 和 body digest 是 revision 事实，不参与稳定身份。Catalog 在扫描或读取期间变化时，本轮 observation stale，不能混合新旧候选。

## 8. 候选全文与总预算

候选正文先由 Host 完整读取、脱敏并计算 exact digest，再判断模型是否能完整接收。单候选没有固定 8 KiB 上限。

总预算顺序：

1. 从 `resolveModelInfo` 得到当前 route 的 context limit；
2. 预留 system/protocol、ExperienceIntent、来源标签、结构和 coverage output；
3. 先移除低信任辅助上下文和较旧非必要观察；
4. 按 summary classification 与稳定排序装入完整候选；
5. 必要时一个候选独占一次 coverage envelope；
6. 任何正文都不截断。

候选能力：

- `AVAILABLE`：身份稳定、正文完整、可参与 coverage，并满足潜在 merge 的 scope/writability 边界；
- `READABLE_NOT_MERGEABLE`：正文完整、可判断覆盖，但只读、跨 scope、并发风险或无法安全输出完整 merge；
- `UNAVAILABLE`：Catalog 不完整、候选消失、identity changed、读取失败、过滤后不可安全使用或完整正文超过单次安全输入预算。

每个不可用原因都持久化为枚举和非敏感事实。确定性大小、只读、scope mismatch 和 identity changed 不重试；明确瞬态 snapshot/read timeout 才允许有界重取。任何经 summary scan 分类为 `RELEVANT` 或 `POSSIBLE` 的候选，在完成 coverage 前变为 UNAVAILABLE 都阻止 CREATE；`POSSIBLE` 不是可忽略的低相关候选。

## 9. Coverage 与 Generation

### 9.1 coverage

coverage 是短输出、无正文生成的独立模型阶段。每个调用只接收完整候选，输出：

- `UNRELATED`
- `COVERED`
- `PARTIAL`
- `AMBIGUOUS`

全部候选可放入一个 envelope 时整体判断；否则按候选或安全分组调用，并由 Host 汇总。计划调用数超过版本化 `MAX_COVERAGE_CALLS` 时在调用前失败。任何候选只分析一次，Catalog/body digest 变化使整轮结果 stale。

Host 决策表：

| 完整事实 | 结果 |
|---|---|
| 任一 `COVERED`，且 Intent 来自普通自动批次 | 静默结束，不生成 Proposal |
| 任一 `COVERED`，且 Intent 来自显式保存 | `COVERED_NEEDS_CONFIRMATION`，展示目标和理由；用户确认后 DISCARDED |
| 全部相关候选 `UNRELATED`，Catalog/summary/body 完整 | CREATE |
| 唯一 `PARTIAL`，同 scope、可写、可安全完整输出 | MERGE |
| 多个 `PARTIAL`、任一 `AMBIGUOUS` | NEEDS_ATTENTION |
| 任一 `RELEVANT` / `POSSIBLE` 候选在 coverage 前 `UNAVAILABLE` | NEEDS_ATTENTION，CREATE=0 |
| 唯一 `PARTIAL` 只读、跨 scope或不可完整输出 | NEEDS_ATTENTION |

PROJECT Intent 可以被 USER Skill 覆盖，但无明确 USER intent 时不能修改 USER Skill。不可写候选不能通过另建同义 `.dsh/skills` Skill 绕过。

显式保存的 `COVERED_NEEDS_CONFIRMATION` 提供两种 revision-CAS 动作：

- `CONFIRM_DISCARD(intentId, expectedRevision, actionId)`：提交 `DISCARDED` 终态；
- `DISPUTE_COVERAGE(intentId, expectedRevision, actionId)`：提交 `COVERAGE_RETRY_AUTHORIZED`，把用户异议作为 HIGH evidence 创建一个新的 coverage revision。

异议只授权 1 次额外 coverage 调用，必须重新取得 Runtime/Pending Proposal Catalog 和 exact candidate bodies，不借用 generation 预算，也不复用旧 coverage digest。若重新判断仍为 COVERED、输出非法、事实不完整或预算耗尽，进入 `NEEDS_ATTENTION`；不得自动循环。两种 action 的 receipt 和终态均 durable，重复 action 返回同一 receipt，stale revision 拒绝，崩溃恢复不重新提交调用。

### 9.2 generation

generation 只接受 Host 已提交的 `CREATE_AUTHORIZED` 或 `MERGE_AUTHORIZED`：

- CREATE：生成一个紧凑、证据绑定的新 Skill；
- MERGE：输入 exact Base 完整正文和 digest，输出完整新正文；
- 输出中的 target/path/root/hash 不可信，Host 重新计算；
- 只允许 1 次主调用；仅格式非法或输出截断且输入/target 未变化时允许 1 次针对性恢复；
- 恢复调用不能扩大目标、加入新证据或重新做 coverage。
- 模型调用前和 Proposal body 提交前都必须验证 Session quiescence fence；调用期间 fence 失效时，调用结果只作为 sealed stale result 保留，不创建 Proposal。

大型 Skill 若可完整 coverage 但无法在安全输出预算内生成完整 merge，候选标记 `READABLE_NOT_MERGEABLE` 并进入 Action Queue。

## 10. 阶段调用账本

每个阶段有独立 `StageCallLedger`：

| 阶段 | 计划与上限 | 不得发生的调用 |
|---|---|---|
| DETECTION | 每 batch 1 次 | NONE/DEFER 后的后续调用 |
| CATALOG_SCAN | `ceil(unclassified summaries / safe page capacity)`，受硬上限约束 | 未完整 Catalog 上的扫描 |
| COVERAGE | 安全分组后的 planned calls，受硬上限约束 | 截断正文或任一 RELEVANT/POSSIBLE 候选 UNAVAILABLE 时继续 |
| GENERATION | 1 次主调用 + 最多 1 次格式/截断恢复 | 未授权 CREATE/MERGE、COVERED、歧义时生成 |

账本在调用前 durable reserve，记录 stage、callId、input digest、route、policy、ordinal、usage 和 outcome。阶段不能借用另一个阶段的预算；相同 input digest + policy 的确定性失败不能自动重试。timeout 等瞬态失败也必须有新的 call ordinal；崩溃后 outcome unknown 不自动重放。

具体 `MAX_*_CALLS`、byte reserve、timeout 和 output token 是版本化内部 policy constant，由实现 PR 的模型矩阵测试冻结，不作为用户配置。

## 11. 跨批次与跨 Session 去重

避免重复高于自动 CREATE：

1. `observationId` 去重重复 event；
2. 连续 Turn 范围的 `batchId` 去重 threshold/idle/explicit 竞争；
3. `intentId` 去重 batch replay 和 DEFER carry；
4. `(persistenceScope, behaviorSignature)` 的 `BehaviorSignatureIndex` 只允许一个 active lineage owner；
5. `PendingProposalCatalog` 每次从 `proposal_lineages` 的权威 active Proposal records、Intent 中已密封但尚未复制为 Proposal 的 `GenerationResult`，以及 unresolved generation barriers 派生 complete snapshot，并在新 Intent 的 summary scan/coverage 中作为不可写候选参与去重；它不是可独立漂移的缓存表；
6. 相同签名的后续 Intent 附加 evidence digest 到已有 lineage，而不是生成第二个 Proposal；签名未精确对齐但现有 Runtime/Pending Proposal 语义为 COVERED/PARTIAL/AMBIGUOUS 时同样不得 CREATE；
7. Proposal ID 由 lineage id、coverage observation digest、action 和 target/base digest 派生；
8. publication 继续按 canonical target path 串行和 CAS。

若签名碰撞或语义近似但不能确定相同，进入 `NEEDS_ATTENTION`，不得抢占或并行 CREATE。

`PendingProposalCatalog` 是按一次 Store consistent-read 序列从 `proposal_lineages`、Intent 中已密封但尚未复制为 Proposal 的 `GenerationResult`，以及 generation outcome unknown/failed 的去重屏障派生的 path-free snapshot，包含完整性、稳定排序和 catalog digest；它不在 global 中另存可漂移副本。Proposal/GenerationResult 提供完整正文；outcome unknown/failed 屏障只提供行为签名和 `UNAVAILABLE` capability，相关新 Intent 因此不能 CREATE。任一 authoritative record 无法解析、body/digest 不一致或扫描期间 revision 变化时 `complete=false`。CREATE absence proof 必须同时覆盖 Runtime Skill Catalog 和 complete PendingProposalCatalog。

Pending 的 `USER` records 在同一 DSH storage domain 内全局可见；`PROJECT` records 必须从 owner Intent 的 evidence observations 证明唯一 `scopeIdentityDigest`，只进入同一 project 的 effective view。缺 owner、缺 observation、scope unresolved/冲突或 legacy workspace identity 无法证明时，整个派生结果 `complete=false`，不能跨项目泄露摘要或误判覆盖。

唯一的 self-exclusion 是 `REFRESH_STALE_RESULT` 创建的新 recall revision：完整 snapshot 仍包含其 refresh barrier，但该 revision 的 effective recall/coverage view 按精确 `intentId + priorGenerationRevision + barrierReceipt` 排除且只排除自己的 refresh barrier。调用输入和 absence proof 同时绑定未删减 `catalogDigest` 与 `selfExclusionDigest`；其他 Intent、其他 barrier 或 identity/revision 不匹配时都不得排除。这样当前 Intent 不会被自己永久阻塞，而任何并发 Intent 始终看到 `UNAVAILABLE` barrier。

全部会改变 PendingProposalCatalog authoritative membership 的操作（Proposal create、GenerationResult/barrier create/resolve、Review/Publication 进入或离开 active、Purge hide/delete、用户关闭失败）通过同一个 `ProposalCatalogCoordinator` 单写序列，并使用 global `proposalCatalogMutationJournal + proposalCatalogEpoch + proposalCatalogLastMutation`：先 durable PREPARED journal，再改 authoritative row，最后在同一次 global update 中推进 epoch、写入该 epoch 的 mutation receipt anchor 并清 journal。派生 snapshot 必须在 journal 为空时读取 epoch/anchor-before，扫描全部 purge-visible active rows，再验证 epoch/anchor-after 相同；否则 `complete=false`。锚点让 generation 能证明唯一允许的 epoch 变化确由自己的 sealed result/Proposal receipt 引起，而不是根据散落记录猜测。崩溃恢复先按 authoritative body/status 完成或回滚 journal并推进 epoch，完成前所有 CREATE/MERGE 为 0。

Runtime Catalog adapter 只调用 DSH 公开的 `skills.snapshot/get`，并在同一个 exact Agent `{scope, cwd}` view 上做 snapshot-before/get/snapshot-after。DSH `complete=false`、前后 digest 漂移或 exact get 的 name/provider/source/root 变化都 fail closed；合法但无法由 composition-owned stock root contract 证明写入目标的 flat、runtime、bundled 或第三方 winner 仍以稳定 path-free identity 参与去重，但一律标记为只读。只有 exact `resourceBase == trustedRoot/name` 的 stock `project-dsh/user-dsh` directory bundle 才可写，不能用 basename 猜测目录形态。Catalog summary 仅保留 root identity digest，不持久化或发送本机 path。DSH 不需要暴露内部 revision、CAS 或共享锁。

### 11.1 Proposal generation/commit single-flight

BehaviorSignatureIndex 解决 exact signature 冲突；近义但签名不同或跨 scope 的 Proposal 由进程全局唯一的 durable `ProposalGenerationLease` 解决：

1. CREATE/MERGE generation 前，通过 global CAS 取得唯一 lease；全部 scope 的其他 generation 排队，Detector/recall/coverage 仍可并行；
2. lease 记录 owner intent/revision、action、input digest、acquiredAt 和 call slot，不靠内存锁；它与 ProposalCatalogCoordinator 共同阻止第二个 generation。lease 存续期间，Coordinator 排队其他 owner 的普通 membership mutation；Purge 先提交 visibility/quiesce fence，并在当前 owner 的 call outcome 收敛后再做物理删除。启动恢复中的 Publication Journal 是另一项受限例外：只允许按既有 journal/hash/Registry 事实完成或回滚在途 publication并立即提交 membership receipt，不得发起新的 Publication；
3. 持有 lease 后重新取得 Runtime Skill Catalog 与 PendingProposalCatalog 的 complete snapshot；其 digest 必须与 coverage 授权绑定值一致，否则释放 lease并重新 recall/coverage。lease 同时记录排除当前 owner Intent/GenerationResult/barrier 后的 `externalPendingDigest`；
4. 只有复核仍允许 CREATE/MERGE 才预留 generation call 并调用模型；call terminal、usage 和非敏感 failure 必须先进入 durable ledger；
5. call 返回或恢复流程从 durable ledger 判定调用事实后，lease owner 必须通过 Coordinator 提交且只提交一个互斥 outcome membership mutation：成功且 Guard 通过时密封完整 immutable `GenerationResult`（正文、digest、target/base binding、callId）；FAILED/ABORTED/TIMED_OUT、成功但结果无法 durable，或 outcome unknown 时提交 unresolved generation barrier。两者都产生绑定 `leaseId + intentId + generationRevision + callId` 的 mutation receipt；只有 sealed result 写入成功，call 才可进入 `RESULT_COMMITTED`，只有 barrier durable 才可释放失败路径的 lease；
6. 模型返回后、写 Proposal body 前再次验证 Session quiescence fence，并取得两个 complete catalogs。Runtime digest 必须不变，`externalPendingDigest` 必须不变，Pending epoch 的变化必须且只能由第 5 步当前 owner 的单个 sealed-result receipt 解释；任何其他 mutation、缺失/多余 receipt、会话恢复活动或 catalog 不完整都不提交 Proposal，并以 reason `STALE_RESULT` 进入 `NEEDS_ATTENTION`；
7. 复核通过后，把 GenerationResult 幂等复制为 `proposal_lineages` 的 immutable Proposal body，再把 BehaviorSignatureIndex reservation 从 `RESERVED` 提交为 `ACTIVE`，最后写入 lease completion receipt并释放。这里依靠插件自己的 journal/epoch/lease 保证唯一 body，不要求锁住 DSH Runtime Catalog；在最后快照后发生的外部 Catalog 变化允许使草稿变 stale，审核/发布桥必须重新读取 Catalog 并阻止其发布。若在 `RESULT_COMMITTED`、`PROPOSAL_COMMIT_AUTHORIZED` 或 body write 期间崩溃，恢复路径必须重新验证 fence 和当前 catalogs，旧授权不能直接复制 body；
8. GenerationResult 或 Proposal body 一旦 authoritative write 成功，后续 PendingProposalCatalog 立即能看见它，即使 global exact-signature index 尚未提交；全局 lease 阻止第二个 generation 在更早窗口运行；
9. 启动恢复先扫描 active Proposal bodies、sealed GenerationResults 和 unresolved generation barriers，先收敛唯一 outcome，再完成 active Purge，之后才补齐 body 已存在但 index 非 ACTIVE 的记录并按当前 Catalog 复核 lease；
10. 任一派生 Catalog 不完整、lease/index/body 对账失败或 revision stale 时，CREATE/MERGE 为 0。

该协议有意在单个 DSH Host 内串行全部 Proposal generation；模型并发收益低于跨 scope 重复 Proposal 风险。publication 继续按 target path 使用自己的文件 CAS，并在审核/发布前重新校验 Runtime/Pending Catalog。最后一次生成快照之后的外部变化最多让 Proposal 标记为 stale/covered，不允许发布重复 Skill。

### 11.2 Generation lease 恢复表

全局 lease 的恢复不能依赖超时偷锁。Host 先按 durable call ledger、GenerationResult、Proposal body 和 index 对账，再执行：

| 恢复事实 | 自动动作 | Intent / 去重结果 |
|---|---|---|
| `NOT_CALLED`：只有 lease/behavior reservation，没有 call slot | 保留 lease；Catalog 恢复后由同一 owner/revision 继续首次 generation | 不消费调用预算；全局 lease 和原 Intent 继续阻止其他 generation |
| `KNOWN_FAILED`：call 为 FAILED/ABORTED/TIMED_OUT，无 GenerationResult/body | 先提交 unresolved barrier receipt，再释放全局 lease；不自动重调 | `NEEDS_ATTENTION(GENERATION_KNOWN_FAILED)`；保留 behavior reservation 和 UNAVAILABLE 去重屏障 |
| `SUCCEEDED_RESULT_MISSING`：ledger SUCCEEDED，但 Guard 或 GenerationResult durable 写未完成 | 先提交 unresolved barrier receipt，再释放全局 lease；不自动重调 | `NEEDS_ATTENTION(GENERATION_RESULT_LOST)`；保留去重屏障 |
| `RESULT_COMMITTED`：sealed GenerationResult 存在，Proposal body 缺失 | 保留 lease；刷新 Runtime/Pending catalogs 后按排除 self 的规则重做写前复核，不调用模型 | 复核通过写新 `PROPOSAL_COMMIT_AUTHORIZED`；否则 `NEEDS_ATTENTION(STALE_RESULT)` |
| `PROPOSAL_COMMIT_AUTHORIZED`：写前复核曾通过，body 缺失 | 不信任停机前授权；保留 lease并对当前 catalogs 重新执行复核/CAS | 通过才幂等恢复 body copy；否则 `NEEDS_ATTENTION(STALE_RESULT)` |
| `OUTCOME_UNKNOWN`：call reserved/in-flight，无 terminal ledger | 先提交 unresolved barrier receipt，再释放全局 lease；不自动重调 | `NEEDS_ATTENTION(GENERATION_OUTCOME_UNKNOWN)`；保留去重屏障 |
| `BODY_COMMITTED_INDEX_PENDING` | 从 body 修复 BehaviorSignatureIndex、完成 mutation journal并释放 lease | body 已进入派生 Catalog；不调用模型 |
| `ACTIVE_COMPLETE` | 确认 completion receipt，释放残留 lease | active Proposal 正常参与查重 |

`KNOWN_FAILED`、`SUCCEEDED_RESULT_MISSING` 和 `OUTCOME_UNKNOWN` 都提供两个 revision-CAS 动作：

- `DISMISS_GENERATION`：用户确认后由 Coordinator 在同一 membership mutation 中提交 `DISCARDED`，并原子移除 unresolved barrier 与该 Intent 的 behavior reservation；不得留下指向无 active Proposal 终态的 index owner；
- `AUTHORIZE_GENERATION_RETRY`：仅当 failure policy 标记可恢复且该 Intent 从未使用过用户授权 retry revision 时，新建一次 generation revision并回到 `GENERATION_AUTHORIZED`。它最多允许 1 个主调用和 generation 自身的 1 次格式/截断恢复；确定性 Guard/size/scope/identity failure 不允许该动作。对 OUTCOME_UNKNOWN 必须明确提示此前调用可能已消耗 token。

`STALE_RESULT` 只提供：

- `REFRESH_STALE_RESULT`：以 revision-CAS 将旧 sealed result 原子替换为同一 behavior owner 的 unresolved refresh barrier，新建一次 recall revision，重新取得 complete Runtime/Pending catalogs、summary、exact bodies 和 coverage；该 revision 按上述 self-exclusion contract 排除自己的 refresh barrier，其他 Intent 在替换完成前始终看见旧 result 或新 barrier，因此没有重复窗口；
- `DISMISS_GENERATION`：用户确认后提交 `DISCARDED`，再由 Coordinator 原子移除 stale result/barrier 和 behavior reservation。

refresh 后若已被 Runtime/Pending candidate 覆盖则按 coverage 规则结束：普通自动 Intent 的 COVERED 由 Coordinator 原子提交终态并清理自身 barrier/result 与 behavior reservation；显式保存先进入 `COVERED_NEEDS_CONFIRMATION` 并继续保留 barrier/reservation，用户最终确认 `DISCARDED` 时再在同一 mutation 中清理，异议则遵守既有单次 coverage retry。若仍授权 CREATE/MERGE，新的 generation outcome 原子替换 refresh barrier。每个 Intent 最多一次 `staleRefreshUsed=true`，再次 stale 只允许用户丢弃或保留待处理，不能自动循环。

通用不变量：任何没有 active Proposal 的终态（自动 COVERED、用户确认 DISCARDED、generation dismiss）都必须通过 ProposalCatalogCoordinator 原子清理该 Intent 的 GenerationResult/barrier 和 BehaviorSignatureIndex reservation；Proposal active 时 reservation 才能提交为 ACTIVE。启动对账发现指向无 active Proposal、无未终态 owner 的 reservation 时 fail closed 并按 authoritative Intent 终态修复，不能把 dangling index 当作已覆盖。

自动恢复永不重新调用模型。无论用户是否操作，全局 lease 都在 unresolved barrier durable 后释放，因此单个 Intent 不能永久阻塞其他 Session/Scope；barrier 继续阻止相关重复 Proposal。

启动时先打开 v2 Store；未完成首次启用时只为既有 durable Session 建立尾部水位。COMMITTED 后依次恢复 active Purge、USER_ACTION、proposal catalog mutation、Review/Publication journal 和 ProposalGenerationLease，再重建 Runtime/Pending catalogs、修复 BehaviorSignatureIndex，最后启动 SessionBatch/Intent worker、gap scan 和实时事件处理。恢复阶段不调用模型；停机前的 Catalog 授权不能跨重启直接复用。

## 12. Storage 启用 ADR

### 12.1 决策：新 domain，不原地 bump

新主 domain 使用：

| 项目 | 值 |
|---|---|
| domain | `run2skill_v2` |
| domain version | `1` |
| global schema | `GlobalV2`：Session cursors、BehaviorSignatureIndex、ProposalGenerationLease、proposalCatalogEpoch/mutation journal、activation receipt、Purge journal |
| tables | `turn_observations`、`session_batches`、`experience_intents`、`proposal_lineages`、`legacy_items` |

原因：DSH Storage Domain 对 version mismatch fail loud，新 domain 可以直接启用 v2，同时完全隔离旧的派生缓存。`run2skill_v1`、已发布 Skill 和 DSH Session Log 均不删除、不改写；启用后所有新观察只写 v2。

### 12.2 首次启用

1. 打开空的 `run2skill_v2`，确认没有 v2 Observation、Batch、Intent 或 Proposal；
2. 注册 live Session listener，再读取全部 durable root Session 快照；
3. 只接受没有 open Turn 的稳定日志；`session/end-seed` 后的合法持久事件可作为 tail，仍在运行的 Session 延后重试，不能在半个 Turn 中间切水位；
4. 为每个非空 Session 保存当前 durable tail，令 observed/detected cursor 都从该水位开始；历史 Turn 不重新学习；
5. 原子提交 `COMMITTED`、activation digest 和 observer 起始水位；
6. COMMITTED 后启动 v2 gap scan、scheduler 和 worker，把 listener 注册后出现的新 Turn 纳入补扫。

首次启用不打开、解析或复制 `run2skill_v1` Proposal/WorkItem/Lineage。启用失败时 v2 保持 `NOT_STARTED`，后台稍后重试；不得把不完整 Session 当成空历史。

### 12.3 schema fixture

schema 测试必须为所有 v2 records 提供“除 `schemaVersion` 外全部必填字段有效”的最小夹具。版本失败用例只改变 literal 版本，证明拒绝原因确实是 schemaVersion，而不是其他字段缺失。

### 12.4 回退

- COMMITTED 前可直接停用新包；v1、已发布 Skill 和 Session Log 均未变化。
- COMMITTED 后旧版本不会理解 v2 新事实；回退到旧版本只意味着放弃 v2 中间缓存，不会删除已发布 Skill 或 Session Log。
- 当前无外部用户，不承诺保留 v1/v2 中间缓存；进入稳定版前再单独设计长期升级兼容策略。

## 13. Action Queue 与静默状态

静默状态：`NONE`、`DEFER`、`RESOLVED_BY_AGENT`、普通自动 Intent 的 `COVERED`、自动恢复成功。

只有下列情况进入统一 Action Queue：

- ownership baseline/root/catalog/get/tool/IntentBinding 不完整；
- Catalog 未完整扫描，或任一 `RELEVANT` / `POSSIBLE` 候选在 coverage 前 UNAVAILABLE；
- 显式保存 Intent 的 `COVERED_NEEDS_CONFIRMATION`：展示已覆盖目标与理由，确认后 DISCARDED；
- 多个 PARTIAL、AMBIGUOUS、只读/跨 scope/大型不可合并；
- 阶段预算耗尽、call outcome unknown 或不可恢复 Store failure。

Action Queue 只展示用户能采取的动作和必要原因，不在会话 Header 常驻中间计数。

## 14. 隐私、保留与 Purge

- 所有模型输入和 durable 文本先脱敏并保留来源标签；
- TurnObservation 不保存 Whole Session、原始 Tool output、文件全文或 secret；
- NONE batch 提交水位后可删除其 TurnObservation；
- DEFER 只保留有界 carry，旧观察在证据 digest 转移后可回收；
- READY 观察在 Intent/Proposal 已持久承接必要证据后可回收；
- Purge visibility 适用于 v2 全部表、BehaviorSignatureIndex 和 ProposalGenerationLease；派生 PendingProposalCatalog 必须只读取 purge-visible authoritative rows；
- active Purge 先 durable 应用 visibility/quiesce fence；若命中当前 generation owner，尚无 call slot 时可直接删除未消费 reservation/lease，已有 call slot 时只允许受限 outcome reconciliation 把调用收敛为 sealed result 或 unresolved barrier，随后才删除该 owner 的 result/barrier/index/lease。不得先删已发起调用的 lease/ledger，也不得等待普通 generation worker；
- Purge preview/confirm、崩溃恢复和最终“无正常可见残留”校验必须重建派生 Catalog，并证明已删除/隐藏 Proposal 不再出现、没有 dangling signature reservation 或 lease；
- 已发布 Skill 与 DSH Session Log 永不由 Run2Skill Purge 删除。

## 15. 实现切片

1. Design/ADR 与 PRD/Architecture/storage 文档同步。
2. `run2skill_v2` schema、最小有效夹具和 fresh activation。
3. TurnObservation、SessionBatch scheduler、5-Turn/30-minute/explicit 和恢复。
4. Detector、NONE/DEFER/READY、carry 与 ExperienceIntent 幂等。
5. batch-level Agent-first ownership。
6. complete Catalog 全量摘要扫描和 dynamic full-body budget。
7. coverage/generation 分离、BehaviorSignatureIndex、ProposalGenerationLease 和唯一 Proposal lineage。
8. Action Queue、Host v2 cutover、真实 DSH E2E 与发布说明。

#84 使用一个完整架构 PR 完成上述切片；在 v2 全链闭环和验收通过前不得合并半条新流水线。

## 16. 验收矩阵

| 风险 | 必须证明 |
|---|---|
| 调度 | 1～4 Turn 未 idle 为 0 调用；第 5 Turn、idle、explicit 各只 claim 一个确定性 batch |
| 竞争 | 重复 turn/end、idle 边界新 Turn、重启和并发 Session 不重复 Detector |
| 检测 | 长工作流尾部关键步骤、禁止项、验收条件和显式保存语义在观察/批次共享预算内可见；近似否定语义不误学；NONE/DEFER 后 recall、coverage、generation 全为 0 |
| 所有权 | Agent exact 保存后后续模型 0；证据不完整不把 absence 当 proof |
| 召回 | “保存刚才流程”使用 ExperienceIntent；全 Catalog 分页扫描，不以 Top N 证明不存在 |
| 大候选 | 8940-byte 与 14/20 KiB Skill 在 route 总预算允许时完整 coverage，不触发固定大小失败 |
| 不可用 | 任一 RELEVANT/POSSIBLE 候选消失/changed/read failure/超总预算时 CREATE=0，确定性失败不循环重试 |
| 覆盖 | coverage 与 generation schema/ledger 分离；自动 Intent 的 COVERED 无 Proposal，显式保存的 COVERED 要求可见确认；唯一安全 PARTIAL 才 MERGE |
| 去重 | 同一行为最多一个 owner、一个 active lineage、一个 Proposal；全局 generation lease、派生 PendingProposalCatalog 与 crash reconciliation 使跨 Session/Scope 竞争安全收敛 |
| Generation crash | NOT_CALLED、KNOWN_FAILED、SUCCEEDED_RESULT_MISSING、RESULT_COMMITTED、PROPOSAL_COMMIT_AUTHORIZED、OUTCOME_UNKNOWN、BODY_COMMITTED_INDEX_PENDING、ACTIVE_COMPLETE 各自不重复调用且最终释放全局 lease |
| 首次启用 | 现有完整 Turn 不重学；启用后的 Turn 不漏学；半个 Turn 不切水位；重启补扫不重复 |
| schema | 冻结 fixture 只改变 schemaVersion 即精确触发 literal 拒绝 |
| 安全 | 脱敏、来源标签、scope、CAS、exact readback、Purge 和 fail-open/fail-closed 边界保持 |

稳定 HEAD 最后运行 typecheck、lint、完整单元测试、fresh-activation/crash/concurrency/call-budget/duplicate probes，以及真实 DSH Web/learning E2E。

## 17. Roadmap 状态

- #48 stock root contract 迁移与运行探针已经完成。
- C7 publication 主切片仍未开始；#84 不提前启动或改变 C7 验收。
