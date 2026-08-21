# SessionBatch 语义检测、完整召回与分阶段学习设计

状态：PROPOSED

对应 Issue：[#84](https://github.com/qkycir-123/dsh-run2skill/issues/84)

更新时间：2026-08-22

## 1. 范围审计

本设计只重构 Run2Skill 从会话观察到 Proposal 生成之前的核心流水线，并给出已发布 `run2skill_v1` 数据进入新流水线的迁移方案。

本设计包含：

- `TurnObservation -> SessionBatch -> ExperienceIntent` 的 durable 状态机；
- 5 个完整 Turn、空闲 30 分钟和显式保存三类调度；
- ExperienceIntent 级单一生成所有者；
- complete Catalog 的全量摘要筛选、候选全文读取与动态总预算；
- coverage 与 generation 分阶段调用和独立账本；
- 去重、崩溃恢复、迁移、回退、Action Queue 和验收矩阵。

本设计不包含：

- 大型 Skill 的自动 Markdown patch merge；
- 自动批准或发布 Proposal；
- 向量数据库、DSH 上游修改或第二套模型 Provider；
- 把内部窗口、预算或重试常数暴露为普通用户设置；
- 改写已发布 Skill 或 DSH Session Log。

现有发布、审核、CAS、exact readback 和 Purge 的安全边界继续有效。`single-owner-skill-save.md` 中 Agent-first、完整事实和 fail-closed 原则继续有效，但其“每个命中 Turn 建立 WorkItem/TurnBaseline”的机制由本设计取代。

## 2. 设计结论

1. 普通 durable root `turn/end` 只写最小 `TurnObservation`，不做语义判断。
2. 一个 Session lifecycle 内每 5 个完整 Turn 检测一次；剩余 1～4 Turn 在最后活动 30 分钟后检测；显式保存在当前 Turn 完成后立即检测。
3. 调度竞争通过同一连续 Turn 范围的确定性 `batchId` 和 durable CAS 收敛；触发原因不是身份的一部分。
4. Detector 只产出 `NONE | DEFER | READY`，不查 Skill、不生成正文。
5. 每个 READY Intent 在任何 recall、coverage 或 generation 调用前完成 Agent-first 所有权裁决。
6. Catalog 必须 `complete=true`，且每个 summary 都得到确定性或语义分类；未完整扫描时 `CREATE=0`。
7. 取消单候选 8 KiB 限制。候选正文必须完整读取并以总模型输入预算决定能否参与；不得静默截断。
8. coverage 只产出 `UNRELATED | COVERED | PARTIAL | AMBIGUOUS`；generation 只接受已证明安全的 CREATE 或唯一 MERGE target。
9. 以 behavior signature 的全局 single-flight 和唯一 active lineage 避免跨批次、跨 Session 重复 Proposal。
10. 使用新 `run2skill_v2` Domain；`run2skill_v1` 不原地改写，迁移后只作为 legacy source 和回退证据保留。

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
READY
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

只有 `completeness=COMPLETE` 的 Turn 计入阈值。`detectedThrough` 之后累计第 5 个完整 Turn 时，冻结当前连续范围。INCOMPLETE 观察保留并阻止跨缺口 absence proof；它不被跳过拼成一个看似连续的 batch。

### 4.2 30-minute idle flush

idle deadline 是最后一个 durable TurnObservation 的 `observedAt + 30m`。计时器只负责唤醒，权威判断来自 Store：

1. 到期后读取 cursor revision；
2. 若新 Turn 已推进 revision 且 batch 尚未 claim，取消旧 deadline 并按新活动时间重算；
3. 若 batch 已 claim，冻结范围继续，新 Turn 进入下一批；
4. 启动恢复发现 durable 尾部已空闲超过 30 分钟时立即执行同一 claim 路径。

### 4.3 explicit save

显式“保存为 Skill/记住该流程”等由 TurnObservation 的 direct-user evidence 确定性标记。该标记不直接生成 Skill，只在当前 Turn 完成后立即冻结从 `detectedThrough + 1` 到当前 Turn 的范围。若此前有 DEFER carry，一并作为有界数据输入。显式保存不等待 5 Turn 或 idle，但仍必须经过 detector、所有权、完整 recall 和 coverage。

### 4.4 single-flight

- 每个 Session lifecycle 同时最多一个 active SessionBatch worker；
- 进程全局使用固定小并发上限；
- 每个 behavior signature + scope 同时最多一个 active lineage owner；
- authoritative queue 来自 Store，不维护不可恢复的内存任务副本。

## 5. Batch Detector

Detector 输入只包含冻结 batch 的有界 TurnObservation、最多 3 个 DEFER carry、来源标签和 route，不包含 Skill Catalog。

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
5. `PendingProposalCatalog` 每次从 `proposal_lineages` 与 `legacy_items` 的权威 active Proposal records、Intent 中已密封但尚未复制为 Proposal 的 `GenerationResult`，以及 unresolved generation barriers 派生 complete snapshot，并在新 Intent 的 summary scan/coverage 中作为不可写候选参与去重；它不是可独立漂移的缓存表；
6. 相同签名的后续 Intent 附加 evidence digest 到已有 lineage，而不是生成第二个 Proposal；签名未精确对齐但 legacy Proposal 语义为 COVERED/PARTIAL/AMBIGUOUS 时同样不得 CREATE；
7. Proposal ID 由 lineage id、coverage observation digest、action 和 target/base digest 派生；
8. publication 继续按 canonical target path 串行和 CAS。

若签名碰撞或语义近似但不能确定相同，进入 `NEEDS_ATTENTION`，不得抢占或并行 CREATE。

`PendingProposalCatalog` 是按一次 Store consistent-read 序列从 `proposal_lineages`、`legacy_items`、Intent 中已密封但尚未复制为 Proposal 的 `GenerationResult`，以及 generation outcome unknown/failed 的去重屏障派生的 path-free snapshot，包含完整性、稳定排序和 catalog digest；它不在 global 中另存可漂移副本。Proposal/GenerationResult 提供完整正文；outcome unknown/failed 屏障只提供行为签名和 `UNAVAILABLE` capability，相关新 Intent 因此不能 CREATE。任一 authoritative record 无法解析、body/digest 不一致或扫描期间 revision 变化时 `complete=false`。CREATE absence proof 必须同时覆盖 Runtime Skill Catalog 和 complete PendingProposalCatalog。

全部会改变 PendingProposalCatalog authoritative membership 的操作（Proposal create、GenerationResult/barrier create/resolve、Review/Publication 进入或离开 active、legacy migration、Purge hide/delete）通过同一个 `ProposalCatalogCoordinator` 单写序列，并使用 global `proposalCatalogMutationJournal + proposalCatalogEpoch`：先 durable PREPARED journal，再改 authoritative row，最后在同一次 global update 中推进 epoch并清 journal。派生 snapshot 必须在 journal 为空时读取 epoch-before，扫描全部 purge-visible active rows，再验证 epoch-after 相同；否则 `complete=false`。崩溃恢复先按 authoritative body/status 完成或回滚 journal并推进 epoch，完成前所有 CREATE/MERGE 为 0。

### 11.1 Proposal generation/commit single-flight

BehaviorSignatureIndex 解决 exact signature 冲突；近义但签名不同或跨 scope 的 Proposal 由进程全局唯一的 durable `ProposalGenerationLease` 解决：

1. CREATE/MERGE generation 前，通过 global CAS 取得唯一 lease；全部 scope 的其他 generation 排队，Detector/recall/coverage 仍可并行；
2. lease 记录 owner intent/revision、action、input digest、acquiredAt 和 call slot，不靠内存锁；它与 ProposalCatalogCoordinator 共同阻止第二个 generation。lease 存续期间，Coordinator 排队其他 owner 的普通 membership mutation；Purge 先提交 visibility/quiesce fence，并在当前 owner 的 call outcome 收敛后再做物理删除；
3. 持有 lease 后重新取得 Runtime Skill Catalog 与 PendingProposalCatalog 的 complete snapshot；其 digest 必须与 coverage 授权绑定值一致，否则释放 lease并重新 recall/coverage。lease 同时记录排除当前 owner Intent/GenerationResult/barrier 后的 `externalPendingDigest`；
4. 只有复核仍允许 CREATE/MERGE 才预留 generation call 并调用模型；call terminal、usage 和非敏感 failure 必须先进入 durable ledger；
5. call 返回或恢复流程从 durable ledger 判定调用事实后，lease owner 必须通过 Coordinator 提交且只提交一个互斥 outcome membership mutation：成功且 Guard 通过时密封完整 immutable `GenerationResult`（正文、digest、target/base binding、callId）；FAILED/ABORTED/TIMED_OUT、成功但结果无法 durable，或 outcome unknown 时提交 unresolved generation barrier。两者都产生绑定 `leaseId + intentId + generationRevision + callId` 的 mutation receipt；只有 sealed result 写入成功，call 才可进入 `RESULT_COMMITTED`，只有 barrier durable 才可释放失败路径的 lease；
6. 模型返回后、写 Proposal body 前再次取得两个 complete catalogs。Runtime digest 必须不变，`externalPendingDigest` 必须不变，Pending epoch 的变化必须且只能由第 5 步当前 owner 的单个 sealed-result receipt 解释；任何其他 mutation、缺失/多余 receipt 或 catalog 不完整都不提交 Proposal，并以 reason `STALE_RESULT` 进入 `NEEDS_ATTENTION`；该 reason durable 且 sealed result 已进入 PendingProposalCatalog 后释放全局 lease。复核成功先 durable 提交绑定当前两个 digest/epoch/receipt 的 `PROPOSAL_COMMIT_AUTHORIZED`；Proposal body write 必须以这些值作 CAS；
7. commit CAS 通过后，把 GenerationResult 幂等复制为 `proposal_lineages` 的 immutable Proposal body，再把 BehaviorSignatureIndex reservation 从 `RESERVED` 提交为 `ACTIVE`，最后写入 lease completion receipt并释放；若在 `RESULT_COMMITTED`、`PROPOSAL_COMMIT_AUTHORIZED` 或 body write 期间崩溃，恢复路径必须重新取得当前 Runtime/Pending catalogs 并执行第 6 步，旧授权不能直接复制 body；
8. GenerationResult 或 Proposal body 一旦 authoritative write 成功，后续 PendingProposalCatalog 立即能看见它，即使 global exact-signature index 尚未提交；全局 lease 阻止第二个 generation 在更早窗口运行；
9. 启动恢复先扫描 active Proposal bodies、sealed GenerationResults 和 unresolved generation barriers，先收敛唯一 outcome，再完成 active Purge，之后才补齐 body 已存在但 index 非 ACTIVE 的记录并按当前 Catalog 复核 lease；
10. 任一派生 Catalog 不完整、lease/index/body 对账失败或 revision stale 时，CREATE/MERGE 为 0。

该协议有意在单个 DSH Host 内串行全部 Proposal generation；模型并发收益低于跨 scope 重复 Proposal 风险。publication 继续按 target path 使用自己的 CAS；若 publication 在 generation 期间改变 Runtime Catalog，写前第二次 revalidation 会阻止 stale Proposal commit。

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

- `DISMISS_GENERATION`：用户确认后提交 `DISCARDED`，再移除 unresolved barrier；
- `AUTHORIZE_GENERATION_RETRY`：仅当 failure policy 标记可恢复且该 Intent 从未使用过用户授权 retry revision 时，新建一次 generation revision并回到 `GENERATION_AUTHORIZED`。它最多允许 1 个主调用和 generation 自身的 1 次格式/截断恢复；确定性 Guard/size/scope/identity failure 不允许该动作。对 OUTCOME_UNKNOWN 必须明确提示此前调用可能已消耗 token。

`STALE_RESULT` 只提供：

- `REFRESH_STALE_RESULT`：以 revision-CAS 将旧 sealed result 原子替换为同一 behavior owner 的 unresolved refresh barrier，新建一次 recall revision，重新取得 complete Runtime/Pending catalogs、summary、exact bodies 和 coverage；当前 Intent 的 coverage 排除自己的旧结果，其他 Intent 在替换完成前始终看见旧 result 或新 barrier，因此没有重复窗口；
- `DISMISS_GENERATION`：用户确认后提交 `DISCARDED`，再由 Coordinator 原子移除 stale result/barrier 和 behavior reservation。

refresh 后若已被 Runtime/Pending candidate 覆盖则按 coverage 规则结束并清理自身 barrier；若仍授权 CREATE/MERGE，新的 generation outcome 原子替换 refresh barrier。每个 Intent 最多一次 `staleRefreshUsed=true`，再次 stale 只允许用户丢弃或保留待处理，不能自动循环。

自动恢复永不重新调用模型。无论用户是否操作，全局 lease 都在 unresolved barrier durable 后释放，因此单个 Intent 不能永久阻塞其他 Session/Scope；barrier 继续阻止相关重复 Proposal。

启动时 generation/publication worker 之前使用两阶段恢复：打开 v2/migration -> 应用 active Purge visibility/quiesce fence（此时不等待物理删除） -> 恢复 proposalCatalogMutationJournal并扫描 Proposal/GenerationResult/barrier -> 对当前 lease 只做 outcome reconciliation，按第 5 步补成 sealed result 或 barrier，不复制 Proposal body -> outcome durable 后完成 Purge 物理删除并清除被隐藏 owner -> 重扫 authoritative rows并修复 BehaviorSignatureIndex -> 恢复 Publication Journal并刷新 Runtime Catalog -> 重建 complete PendingProposalCatalog -> 对仍持有 lease 的 RESULT_COMMITTED/PROPOSAL_COMMIT_AUTHORIZED 按当前两个 Catalog 重做第 6 步并收敛 body/index/lease -> 最后恢复 SessionBatch/Intent worker。Purge fence 与 outcome reconciliation 因此不会互等，停机前的 Catalog 授权也不会跨重启复用。

## 12. Storage Migration ADR

### 12.1 决策：新 domain，不原地 bump

新主 domain 使用：

| 项目 | 值 |
|---|---|
| domain | `run2skill_v2` |
| domain version | `1` |
| global schema | `GlobalV2`：Session cursors、BehaviorSignatureIndex、ProposalGenerationLease、proposalCatalogEpoch/mutation journal、migration/Purge journal |
| tables | `turn_observations`、`session_batches`、`experience_intents`、`proposal_lineages`、`legacy_items` |

原因：DSH Storage Domain 对 version mismatch fail loud，当前没有已验证的原地 schema migration transaction。新 domain 允许先完成、校验和提交迁移，再启用 v2 observer；任何失败都不会把 v1 误认为空库或部分升级。

`run2skill_v1` 和诊断 sidecar 不删除、不改写。迁移完成后 v1 只读，所有新观察只写 v2。

### 12.2 migration journal

`GlobalV2.migration` 状态：

```text
NOT_STARTED -> COPYING -> VALIDATING -> COMMITTED
                    \-> FAILED
```

迁移顺序：

1. 打开并验证 v1；活动 Purge journal 未完成时先恢复 Purge，不启动迁移；
2. 创建 v2 migration journal，记录 v1 domain/schema contract 和不含正文的 source fingerprint；
3. 先复制 completed purge fences 和 scope identity facts；
4. 复制并校验 Lineage full snapshots，保留原 revision/body digest/publication outcome；
5. 把每个 schema-valid legacy WorkItem 按 12.3 的穷尽表导入 `legacy_items`；
6. 校验全部 active legacy Proposal 都能进入派生 PendingProposalCatalog；能从 Experience/Proposal 规范化出 behavior signature 时同时预占 `BehaviorSignatureIndex`，不能精确规范化时仍必须作为 legacy summary/full body 参与每次新 Intent 的去重；
7. 校验数量、identity、digest、派生 Catalog completeness、BehaviorSignatureIndex、ProposalGenerationLease 空闲状态和 purge visibility；任何 active legacy Proposal 未被派生 Catalog 覆盖都不允许 COMMITTED；
8. 原子提交 `COMMITTED`、v2 activation fence 和 observer 起始水位；
9. 只有第 8 步成功后启用 v2 ingress、scheduler 和 worker。

每一步按确定性 key 幂等 upsert。崩溃后从 journal phase 继续；partial v2 数据在 COMMITTED 前对 UI/worker 不可见。

### 12.3 legacy WorkItem 处置

| v1 `processingState` | schema-valid 子形态 | v2 处置 |
|---|---|---|
| `RESOLVED_NO_SIGNAL` | 无 learning/review/publication | 只保留审计引用，不进入队列或索引 |
| `CAPTURED` | 无 committed Proposal | `LEGACY_NEEDS_ATTENTION`；不自动重放，允许关闭或显式授权新策略恢复 |
| `ANALYZING` | 已 claim、无 Proposal，调用可能 in flight | `LEGACY_CALL_OUTCOME_UNKNOWN`；不自动重试，进入 Action Queue |
| `LEARNED` | 有 Learning Proposal、尚无 Review | 导入 active legacy envelope，进入 curation/review；确保被派生 PendingProposalCatalog 覆盖，不重新 Learning |
| `READY_FOR_REVIEW` | pending immutable Review Proposal | 导入 active legacy envelope，继续 Review；确保被派生 PendingProposalCatalog 覆盖 |
| `PUBLISHING` | approved + publication journal | 导入 active legacy envelope，先按 journal/exact filesystem readback 恢复；确保被派生 PendingProposalCatalog 覆盖，不盲目重写 |
| `NEEDS_ATTENTION` | 无 Review、无 Proposal的 structured learning failure | `LEGACY_NEEDS_ATTENTION`，保留 failure/usage，允许关闭或显式授权恢复 |
| `NEEDS_ATTENTION` | 有 Review Proposal，outcome 为 NEEDS_ATTENTION/NEEDS_REFRESH/PUBLISH_FAILED | 导入 active legacy envelope和原恢复动作；确保被派生 PendingProposalCatalog 覆盖 |
| `TERMINAL` | Review outcome 为 DISCARDED | 只保留审计引用，不占 active 去重索引 |
| `TERMINAL` | Review outcome 为 PUBLISHED | 复制并校验 Lineage，Runtime Catalog 继续提供主要去重；只保留 legacy 审计引用 |

任何 schema invalid、状态/子形态不在上表、身份冲突或无法解释的 publication saga 都使 migration fail closed，不允许把遗漏状态当作 terminal 或空记录。

显式恢复无 Proposal 的 legacy item 时创建带 `legacySourceDigest` 的新 Intent；BehaviorSignatureIndex、PendingProposalCatalog 和 Runtime Catalog coverage 仍先去重。active legacy Proposal 无论是否能派生相同 behavior signature，都必须在新 Intent 的 summary/full-body coverage 中出现，因此普通新 batch 也不能绕过它生成第二份 Proposal。

### 12.4 schema fixture

迁移测试必须为 `GlobalV1`、`CaptureWorkItemV1`、`LineageV1` 以及所有 v2 records 提供“除 `schemaVersion` 外全部必填字段有效”的最小夹具。版本失败用例只改变 literal 版本，证明拒绝原因确实是 schemaVersion，而不是其他字段缺失。

### 12.5 回退

- 迁移 COMMITTED 前：停用新包并回到旧版本，v1 未变；可删除尚不可见的未提交 v2 domain 副本，但默认保留以便诊断。
- 迁移 COMMITTED 后：禁止在同一 DSH Home 上启动不支持 v2 的旧插件。旧版本既不理解 v2 Purge fences，也无法保证不重放 v1；“先启动旧版再关闭自动学习”不是安全回退。
- COMMITTED 后只允许两条恢复路径：前向修复并继续使用支持 v2 的版本；或停止 DSH 后恢复迁移前的完整 DSH Home 备份，再安装旧版本。后者明确回到备份时点，不能声称保留迁移后的清理或新学习事实。
- 不通过删除 v1/v2 Storage 强行降级；发布说明必须明确该边界。

## 13. Action Queue 与静默状态

静默状态：`NONE`、`DEFER`、`RESOLVED_BY_AGENT`、普通自动 Intent 的 `COVERED`、自动恢复成功。

只有下列情况进入统一 Action Queue：

- ownership baseline/root/catalog/get/tool/IntentBinding 不完整；
- Catalog 未完整扫描，或任一 `RELEVANT` / `POSSIBLE` 候选在 coverage 前 UNAVAILABLE；
- 显式保存 Intent 的 `COVERED_NEEDS_CONFIRMATION`：展示已覆盖目标与理由，确认后 DISCARDED；
- 多个 PARTIAL、AMBIGUOUS、只读/跨 scope/大型不可合并；
- 阶段预算耗尽、call outcome unknown、迁移或不可恢复 Store failure；
- legacy item 需要关闭或显式恢复。

Action Queue 只展示用户能采取的动作和必要原因，不在会话 Header 常驻中间计数。

## 14. 隐私、保留与 Purge

- 所有模型输入和 durable 文本先脱敏并保留来源标签；
- TurnObservation 不保存 Whole Session、原始 Tool output、文件全文或 secret；
- NONE batch 提交水位后可删除其 TurnObservation；
- DEFER 只保留有界 carry，旧观察在证据 digest 转移后可回收；
- READY 观察在 Intent/Proposal 已持久承接必要证据后可回收；
- Purge visibility 适用于 v2 全部表、BehaviorSignatureIndex、ProposalGenerationLease、migration copy 和 legacy items；派生 PendingProposalCatalog 必须只读取 purge-visible authoritative rows；
- active Purge 先 durable 应用 visibility/quiesce fence；若命中当前 generation owner，尚无 call slot 时可直接删除未消费 reservation/lease，已有 call slot 时只允许受限 outcome reconciliation 把调用收敛为 sealed result 或 unresolved barrier，随后才删除该 owner 的 result/barrier/index/lease。不得先删已发起调用的 lease/ledger，也不得等待普通 generation worker；
- Purge preview/confirm、崩溃恢复和最终“无正常可见残留”校验必须重建派生 Catalog，并证明已删除/隐藏 Proposal 不再出现、没有 dangling signature reservation 或 lease；
- 已发布 Skill 与 DSH Session Log 永不由 Run2Skill Purge 删除。

## 15. 实现切片

1. Design/ADR 与 PRD/Architecture/storage 文档同步。
2. `run2skill_v2` schema、最小有效夹具、migration journal 和 legacy adapter。
3. TurnObservation、SessionBatch scheduler、5-Turn/30-minute/explicit 和恢复。
4. Detector、NONE/DEFER/READY、carry 与 ExperienceIntent 幂等。
5. batch-level Agent-first ownership。
6. complete Catalog 全量摘要扫描和 dynamic full-body budget。
7. coverage/generation 分离、BehaviorSignatureIndex、ProposalGenerationLease 和唯一 Proposal lineage。
8. Action Queue、旧 worker 移除、真实 DSH E2E 与发布迁移说明。

每个实现 PR 必须保持现有发布主链可测试；在 v2 全链闭环前不得默认启用半条新流水线。

## 16. 验收矩阵

| 风险 | 必须证明 |
|---|---|
| 调度 | 1～4 Turn 未 idle 为 0 调用；第 5 Turn、idle、explicit 各只 claim 一个确定性 batch |
| 竞争 | 重复 turn/end、idle 边界新 Turn、重启和并发 Session 不重复 Detector |
| 检测 | NONE/DEFER 后 recall、coverage、generation 全为 0 |
| 所有权 | Agent exact 保存后后续模型 0；证据不完整不把 absence 当 proof |
| 召回 | “保存刚才流程”使用 ExperienceIntent；全 Catalog 分页扫描，不以 Top N 证明不存在 |
| 大候选 | 8940-byte 与 14/20 KiB Skill 在 route 总预算允许时完整 coverage，不触发固定大小失败 |
| 不可用 | 任一 RELEVANT/POSSIBLE 候选消失/changed/read failure/超总预算时 CREATE=0，确定性失败不循环重试 |
| 覆盖 | coverage 与 generation schema/ledger 分离；自动 Intent 的 COVERED 无 Proposal，显式保存的 COVERED 要求可见确认；唯一安全 PARTIAL 才 MERGE |
| 去重 | 同一行为最多一个 owner、一个 active lineage、一个 Proposal；全局 generation lease、派生 PendingProposalCatalog 与 crash reconciliation 使跨 Session/Scope 竞争安全收敛 |
| Generation crash | NOT_CALLED、KNOWN_FAILED、SUCCEEDED_RESULT_MISSING、RESULT_COMMITTED、PROPOSAL_COMMIT_AUTHORIZED、OUTCOME_UNKNOWN、BODY_COMMITTED_INDEX_PENDING、ACTIVE_COMPLETE 各自不重复调用且最终释放全局 lease |
| 迁移 | v1 所有 processingState、pending、active Proposal、lineage、purge fence 分别迁移/保留；legacy Proposal 参与新 Intent 去重；崩溃恢复和禁止原地降级有测试 |
| schema | 冻结 fixture 只改变 schemaVersion 即精确触发 literal 拒绝 |
| 安全 | 脱敏、来源标签、scope、CAS、exact readback、Purge 和 fail-open/fail-closed 边界保持 |

稳定 HEAD 最后运行 typecheck、lint、完整单元测试、migration/crash/concurrency/call-budget/duplicate probes，以及真实 DSH Web/learning E2E。

## 17. Roadmap 状态

- #48 stock root contract 迁移与运行探针已经完成。
- C7 publication 主切片仍未开始；#84 不提前启动或改变 C7 验收。
