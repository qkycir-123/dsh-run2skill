# 同一 Skill 保存意图的单一生成所有者设计

状态：`PROPOSED`

对应 Issue：[#71](https://github.com/qkycir-123/dsh-run2skill/issues/71)

适用范围：受支持的 stock DSH `web` profile、默认 filesystem Skill roots、内置 `standard` / `code` preset

## 1. 范围审计

本设计只解决同一回合、同一学习来源在 Agent 与 run2skill 之间重复生成 Skill 的问题。

目标：

- 正常路径保持无感，不要求用户选择“由谁保存”；
- 在 run2skill 调用学习模型前确定唯一生成所有者；
- Agent 已实际创建或更新有效 Skill 时，run2skill 不再启动学习任务；
- 只有确认 Agent 未保存时，run2skill 才取得所有权；
- 证据缺失、catalog 不完整或变化归属不清时安全停止，不以猜测换取自动化；
- 保留现有 Review、Approval、发布重校验与 filesystem CAS。

非目标：

- 不解决没有共同回合来源的全局语义去重；
- 不在本设计中实现跨回合经验聚类或多 Skill 拆分；
- 不阻止 Agent 正常修改项目文件；
- 不依赖修改 DSH 源码；
- 不把按钮、命令或人工选通道变成正常流程；
- 不提前实现本设计或拆分尚未评审的实现 Issue。

## 2. 问题与不变量

当前 run2skill 在 `turn/end` 后捕获信号，再由 `LearningWorker` 读取 Session、召回现有 Skill 并调用学习模型。Agent 在同一回合中已经可能通过文件工具或 Shell 创建 `SKILL.md`。现有召回、同名检查和发布 CAS 都发生在两边可能已经生成内容之后，因此只能防重复落盘，不能防重复消耗模型 token。

本设计建立以下不变量：

1. 一个 `SaveIntentId` 同时只能处于一种所有权裁决状态：`ARBITRATING`、`RESOLVED_BY_AGENT`、`RUN2SKILL_OWNED`、`NEEDS_CONFIRMATION` 或 `HANDLED_BY_USER`；其中 `NEEDS_CONFIRMATION` 是可恢复等待态，不是终态。
2. `RUN2SKILL_OWNED` 只能从尚未决定所有者的状态通过一次持久化 CAS 获得。
3. 只有 `RUN2SKILL_OWNED` WorkItem 才可进入 run2skill Learning Scheduler。
4. `RESOLVED_BY_AGENT` 和 `NEEDS_CONFIRMATION` 的 run2skill 学习任务启动数必须为 `0`。
5. `RUN2SKILL_OWNED` 的学习任务启动数最多为 `1`；任务内部针对模型失败的有界 provider 请求恢复由 #70 负责，不得被误算成第二个生成通道。
6. catalog、任一有效 filesystem root、生成行为或 SaveIntent 关联任一不完整时，不得判定“Agent 没保存”。
7. `RESOLVED_BY_AGENT` 必须同时证明：Agent 已成功写入、写入结果是当前 Effective Catalog 的有效 winner，且其目标或行为契约与当前 SaveIntent 相关；“同一回合只有一个 Skill 变化”本身不是相关性证明。
8. 失败写入、工具参数中已经出现完整 Skill、同内容 Shell 重写或其他无法归因的 Skill 生成/写入迹象都进入 `NEEDS_CONFIRMATION`，不得继续调用 run2skill 学习模型。
9. 发布前 Review、重校验与 CAS 仍是最终安全网，但不承担所有权选择。

## 3. 已有证据

### 3.1 run2skill 当前事实

- WorkItem ID 已由 Session 生命周期、cwd 摘要、turn、`turnEndSeq`、turn instance 摘要和 Trigger Policy 版本确定性派生，可直接作为同一来源幂等基础：[`signal-key.ts`](../../src/domain/observe/signal-key.ts)、[`identity.ts`](../../src/domain/observe/identity.ts)。
- `TurnCaptureProcessor` 在完整 `turn/end` 观察后才创建 `CHEAP_TRIGGER` WorkItem：[`turn-capture-processor.ts`](../../src/application/capture/turn-capture-processor.ts)。
- 当前 `LearningWorker` 先 claim WorkItem，之后才召回 catalog 并调用学习模型；这里是增加所有权门的正确位置：[`learning-worker.ts`](../../src/application/learn/learning-worker.ts)。
- 当前 host 已监听 `agent/pre-step`、`session/event` 和 `agent/disposed`，并能持有精确 Agent scope：[`host/index.ts`](../../src/host/index.ts)。

### 3.2 stock DSH 契约

以下契约最初在历史 rc.7 baseline `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` 中确认；当前受支持的 rc.2 `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` 仍保留相关契约。

| 能力 | 源码证据 | 可用于本设计 | 不能证明什么 |
|---|---|---|---|
| 模型请求前观察 | [`agent/pre-step`](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/core/agent/src/runtime-types.ts#L231) 带 `agent/turn/step/messages/signal`，发生在 step 打开与模型请求之前 | 首个 step 保存回合前基线 | 不能阻止模型经任意 Shell 写 Skill |
| 持久 Session 事件 | [`session/event`](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/core/session/src/index.ts#L65-L76) 是 post-commit feed | 关联 `tool/call`、`tool/result` 与 `turn/end` | 单凭工具成功不能证明文件最终内容 |
| 工具结果观察 | [`tools/result`](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/core/tools/src/index.ts#L191-L197) 给出冻结的调用身份与结果 | 辅助确认直接文件写入或 Shell 调用 | 任意 Shell 参数不是可靠的文件事务日志 |
| 工具前置策略 | [`tools/pre-execute`](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/core/tools/src/index.ts#L142-L175) 可 allow/deny/ask | 可做诊断或防御性保护 | 无法在不误伤正常工作的情况下理解所有 Shell 副作用 |
| catalog 完整性 | [`skills.snapshot()`](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/skill/skill/src/index.ts#L475-L489) 返回 `complete` | 完整观察后确认有效 winning Skill | 不提供“是谁写的”归属信息 |
| 完整 Skill 定义 | [`skills.get()`](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/skill/skill/src/index.ts#L492-L517) 返回 content/path/provider/source | 校验变化后的 Skill 是否有效且进入当前有效视图 | catalog 不完整时，`undefined` 不是不存在证明 |
| filesystem 热刷新 | filesystem provider 监听第一方 [`fs/observed`](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/skill/skill-filesystem/src/index.ts#L129-L142) 和根目录 watcher | 缩短写入到 catalog 可见之间的时间 | watcher 事件可能延迟或失败，不能作为唯一证据 |
| filesystem 有效 roots | stock provider 从同一 cwd 解析 [`project-dsh`、`project-agents`、custom、`user-dsh`、`user-agents` 与 bundled](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/skill/skill-filesystem/src/index.ts#L150-L259)，rank 为 100..600 | 构造 ownership 专用的完整 root set 与优先级 | provider 不公开 roots API；无法从 exact mounted 配置重建时只能 `UNKNOWN` |

结论：stock DSH 有足够的“回合前基线 + 回合后对账”扩展点，但没有一个事务式 claim 能可靠地把“保存 Skill”从 Agent 的任意文件/Shell 能力中剥离。仅靠提示词、拦截 `skill-creator` 或解析 Shell 命令都不能形成保证。

## 4. 选定方案：Agent-first，回合后短路

### 4.1 总体时序

```text
agent/pre-step(step=1)
  └─ 持久化回合前 SkillObservationBaseline
      ├─ Effective Catalog 全部有效 filesystem roots 的 manifest 摘要
      ├─ 完整有效 catalog 摘要
      └─ 仅摘要，不保存 Skill 正文或工具参数

Agent 正常工作
  └─ run2skill 只观察本回合工具事件，不干预项目文件写入

turn/end
  └─ Cheap Trigger 未命中：清理基线，无 WorkItem
  └─ Cheap Trigger 命中：创建/合并唯一 WorkItem，进入 ARBITRATING
      └─ 所有权对账
          ├─ 确认 Agent 已保存有效 Skill
          │   └─ RESOLVED_BY_AGENT，Learning 启动数 0
          ├─ 完整证明本回合未发生 Skill 生成行为且 manifest 无变化
          │   └─ CAS → RUN2SKILL_OWNED，启动一个 Learning Job
          └─ 证据不完整或归属不清
              └─ NEEDS_CONFIRMATION，Learning 启动数 0
```

正常路径没有新增按钮、命令、弹窗或用户选择。恢复入口只服务于 `NEEDS_CONFIRMATION`。

### 4.2 来源与幂等

继续使用当前 `workItemId = hash(SignalKey)` 作为 `SaveIntentId`。同一 turn 的多个 Trigger Hit 属于同一来源，不重复创建所有权记录。

因为回合前还没有 `turnEndSeq` 和 turn instance 摘要，新增一个临时 `TurnBaselineId`：

```text
TurnBaselineId = "tb_" + sha256Utf8(JSON.stringify({
  rootSessionId,
  sessionCreatedAt,
  sessionCwdDigest,
  turn,
  step: 1,
  baselinePolicyVersion
}))
```

对象字段顺序固定如上，使用与现有 `SignalKey` 相同的 UTF-8 canonical `JSON.stringify` + SHA-256 约定；`step` 是字面量 `1`，不接受其他值。`baselinePolicyVersion` 是执行 prefilter/建立基线时的版本，不从进程当前默认值补写。

首个 `agent/pre-step` 只允许用该 ID `put-if-absent` 写一次基线。同一 session lifecycle/turn 的同版本 pre-step 重放必须精确复用已持久 baseline，不能刷新 manifest、重算 ID 或覆盖原事实；同一 turn 已有 baseline 时，策略热变更也不能另建并行 baseline。`turn/end` 后，WorkItem 通过完整 ID 关联基线，再使用完整 `SignalKey` 形成最终 `SaveIntentId`。若持久 baseline 的 `baselinePolicyVersion` 与最终 `SignalKey.triggerPolicyVersion` 不一致，或重放时 exact baseline 缺失/冲突，必须进入 `NEEDS_CONFIRMATION`，不能以新策略静默重建、取得 run2skill 所有权或补判 `RESOLVED_BY_AGENT`。策略热变更只对变更后开始的新 turn 使用新 `baselinePolicyVersion`。

重复 `session/event`、gap replay 或进程重启只能合并同一记录；同版本 exact baseline 是唯一权威回合前事实。

没有触发信号的基线在该 turn 的完整扫描及 checkpoint 提交后清理。清理也要受 Purge fence 和可见性规则约束，避免重启复活。

### 4.3 不保存正文的 Skill 观察

每次观察由两个互相校验的视图组成：

1. **Root Manifest**：扫描当前 Agent 的 stock filesystem provider 实际挂载、且能够完整解析的全部有效 roots，覆盖 root 直属 `*.md` 和一层目录下的 `SKILL.md`。对每个候选计算内容摘要、相对身份摘要和文件类型；不持久化正文、绝对路径、mtime 或目录列表。
2. **Effective Catalog**：调用同一 Agent scope、同一 cwd 下的 `skills.snapshot()`；只有 `complete=true` 才继续。对 filesystem winning entries 调用 `skills.get()`，验证 name/provider/source/path/content，并计算定义摘要。

Root Manifest 的来源不是只包含 `project-dsh` / `user-dsh` 的 Publication RootBinding。所有权观察必须从 exact mounted stock filesystem fiber 的已解析配置、固定 baseline 的 roots 解析顺序和同一 cwd/project-root 语义独立构造 `EffectiveFilesystemRootSet`：

| source | rank | root 来源 | 所有权观察要求 |
|---|---:|---|---|
| `project-dsh` | 100 | stock project root 下 `.dsh/skills` | 必须观察 |
| `project-agents` | 200 | stock project root 下 `.agents/skills` | 必须观察；这是 Agent/skill-creator 常用路径 |
| `custom` | 300 | exact mounted provider 的全部 `customSkillDirs` | 每个实际挂载 root 都必须观察；任一遗漏或无法完整解析时整体 `UNKNOWN` |
| `user-dsh` | 400 | effective DSH Home 下 `skills` | 必须观察 |
| `user-agents` | 500 | effective Agents Home 下 `skills` | 必须观察 |
| `bundled` | 600 | resolved bundled Skill root（若存在） | 必须纳入只读 manifest；无法解析时整体 `UNKNOWN` |

`EffectiveFilesystemRootSet` 必须记录 source/rank/root identity digest/configuration digest 和 `complete`，但不记录绝对路径。`project-dsh` / `project-agents` 只在 `includeDefaultRoots=true` 且 cwd 存在时挂载，并按 stock `findProjectRoot(cwd)` 解析；`customSkillDirs` 无论 default roots 是否开启都逐项挂载；`user-dsh` / `user-agents` 只在 `includeDefaultRoots=true` 时挂载。`dshHome` 按 stock `resolveDshHome` 语义，`agentsHome` 按显式配置、启动环境 witness `DSH_AGENTS_HOME`、默认 user home 下 `.agents` 的顺序解析；bundled root 按显式配置优先，否则只在 include-default 时读取 `DSH_BUNDLED_SKILL_DIR`。不能用 Publication 的 Workspace root 或仅有的 DSH Home contract 猜代这些 roots。

前后观察的 readback 必须满足：`skills.snapshot().complete=true`；每个 filesystem winner 的 `skills.get()` 都成功；其 path、source 与 rank 能唯一映射回同一 `EffectiveFilesystemRootSet`；manifest 与 definition digest 一致。任何 filesystem winner 无法映射、任何声明 root 未扫描、root/configuration digest 漂移、source/rank 不一致，都使整个观察为 `UNKNOWN`。

两种视图均设文件数、总字节数和时间上限。越界、I/O 失败、软链接逃逸、自定义 provider/root、配置漂移或 catalog 不完整都产生 `complete=false/UNKNOWN`，不能降级成空集合。

Root Manifest 用来及时发现 Shell 间接写入，不依赖 watcher 是否已刷新；Effective Catalog 用来证明变化后的文件已经成为当前 Agent 真正可用的有效 Skill。

### 4.4 工具证据

本回合从持久 Session 中读取 assistant output、`tool/call` 与配对的 `tool/result`，只在内存中检查参数和结果。先形成 `GenerationEvidence`，再判断文件结果：

- 直接文件工具：若规范化目标精确落在支持的 Skill root 中，可与 manifest 变化路径关联；
- Shell/PowerShell：只标记“可能生成或修改 Skill”。只有 manifest 有真实内容变化、命令目标可安全规范化、post catalog exact readback 成功且 IntentBinding 完整时，才可作为候选写入证据；同内容重写或路径/副作用无法归因时进入 `NEEDS_CONFIRMATION`；
- 工具参数或 assistant output 已包含完整 frontmatter + Skill body，即使工具失败或磁盘未变化，也证明 Agent 已消耗生成通道，必须进入 `NEEDS_CONFIRMATION`；
- 任何针对 Skill root 的失败 write/edit、未配对调用或“可能写入但无法证明结果”的调用都进入 `NEEDS_CONFIRMATION`；
- 未知或间接工具：不能仅凭成功结果证明写入；
- 工具事件缺失、call/result 不配对或参数无法安全规范化：证据不完整。

持久化时只保留 tool name 分类、callId 摘要、成功/失败、目标 root identity 摘要和判定码，不保存命令、参数、输出或绝对路径。

`RESOLVED_BY_AGENT` 还需要确定性的 `IntentBinding`：

- 显式名称、scope 或目标路径存在时，readback winner 必须精确匹配这些目标；
- 没有显式名称时，从 HIGH trigger evidence 提取版本化的行为锚点（约束对象、动作、顺序步骤和禁止项），post `skills.get()` 的 description/whenToUse/content 必须覆盖必要锚点；
- 若工具参数包含完整 Skill，计算其临时摘要并要求与 post exact readback 一致；原文不持久化；
- 只要名称、scope、目标或行为锚点有歧义，就不能因为“只有一个变化”推定相关，必须进入 `NEEDS_CONFIRMATION`。

### 4.5 对账判定表

| 回合前/后事实 | 判定 | 所有权结果 | run2skill Learning Job |
|---|---|---|---:|
| 全部有效 filesystem roots 的前后观察完整且相同；没有完整 Skill 输出、失败写入、目标 root 工具调用或其他生成迹象 | 可证明没有 Agent Skill 生成行为 | `RUN2SKILL_OWNED` | 1 |
| manifest 有新增/内容更新；post catalog 与 `get()` exact readback 完整；工具结果成功；`IntentBinding` 精确匹配 | 确认 Agent 已保存当前 SaveIntent | `RESOLVED_BY_AGENT` | 0 |
| 只有一个有效 Skill 变化，但名称/目标/行为契约无法与 trigger evidence 绑定 | 不能证明属于当前 SaveIntent | `NEEDS_CONFIRMATION` | 0 |
| 工具失败，但参数/assistant output 已形成完整 Skill；或成功调用指向 Skill root 但结果不可证明 | 已可能发生一次生成 | `NEEDS_CONFIRMATION` | 0 |
| Shell 同内容重写、动态路径或不可归因副作用 | 已可能生成/写入，但无法 exact readback 归因 | `NEEDS_CONFIRMATION` | 0 |
| Skill root 有删除、无效文件、被遮蔽候选或多个无法归属的变化 | 不能确认同一保存意图 | `NEEDS_CONFIRMATION` | 0 |
| 外部进程改变了 Skill，但没有本回合工具关联 | 不能归因给 Agent | `NEEDS_CONFIRMATION` | 0 |
| baseline 缺失、任一观察不完整、catalog 未刷新、root contract 改变或工具日志损坏 | 缺少不存在证明 | `NEEDS_CONFIRMATION` | 0 |
| baselinePolicyVersion 与最终 triggerPolicyVersion 不一致，或重放无法取得 exact TurnBaselineId | 策略/回合前事实不可比 | `NEEDS_CONFIRMATION` | 0 |
| Agent 只调用 `skill` 读取已有 Skill，全部 roots manifest 无变化且无生成迹象 | 可证明没有 Agent Skill 生成行为 | `RUN2SKILL_OWNED` | 1 |

不同名称不影响判断：只要该 Skill 变化与同一回合来源确认关联，就直接 `RESOLVED_BY_AGENT`，不会因为名字不同再生成一份。

## 5. 所有权裁决与 WorkItem 生命周期

所有权裁决是 WorkItem 的持久子状态，不替代完整的 Capture/Learning/Review/Publication 生命周期：

```text
WorkItem.processingState = CAPTURED
  └─ ownershipState = ARBITRATING
  ├─ complete proof: no Agent write
  │    └─ RUN2SKILL_OWNED
  │         └─ processingState: CAPTURED → ANALYZING → LEARNED → REVIEW/PUBLICATION
  ├─ complete proof: Agent wrote effective Skill
  │    └─ RESOLVED_BY_AGENT (ownership terminal; WorkItem terminal)
  └─ incomplete or ambiguous
       └─ NEEDS_CONFIRMATION
            ├─ fresh evidence becomes conclusive → RESOLVED_BY_AGENT
            ├─ user confirms not saved → CAS → RUN2SKILL_OWNED
            └─ user marks handled/dismisses → HANDLED_BY_USER
```

规则：

- `RESOLVED_BY_AGENT` 与 `RUN2SKILL_OWNED` 均不可互转；
- `NEEDS_CONFIRMATION` 不能由后台猜测自动转为 `RUN2SKILL_OWNED`，只能靠新的完整机器证据或用户显式确认；
- Learning Store 的 eligible predicate 必须同时要求 `ownership=RUN2SKILL_OWNED`；
- CAS 失败时重新读取，不重复启动 Learning Job；
- `RESOLVED_BY_AGENT` 不生成 Proposal，也不把 Agent 写入的 Skill 归为 run2skill 发布物；
- `RESOLVED_BY_AGENT` 的唯一用户可见结果由本回合已有 Agent 回复/工具结果满足；run2skill 不额外显示 Toast 或 Proposal；
- `NEEDS_CONFIRMATION` 是可恢复等待态：它保留 baseline、GenerationEvidence 摘要、原因码和 revision，进程重启后仍可处理；
- “确认未保存，继续生成”必须携带 `workItemId + expectedRevision + actionId`，Host CAS 成功后才转 `RUN2SKILL_OWNED`；重复 actionId 返回同一 receipt，revision 冲突要求刷新，不重复启动 Learning；
- “已处理/不再沉淀”同样使用 expectedRevision CAS，转为 `HANDLED_BY_USER` 终态；它只表示用户关闭本次沉淀，不声称 Agent 已成功保存，也不生成 Proposal；崩溃恢复不得重新打开或学习该 WorkItem。

## 6. 崩溃与重启恢复

| 崩溃点 | 恢复行为 |
|---|---|
| 基线尚未持久化，Agent 已开始 | 不可重建“回合前”事实；若后续命中 Trigger，进入 `NEEDS_CONFIRMATION`，不调用学习模型 |
| 基线已持久化、尚无 `turn/end` | 保留基线；Session gap recovery 看到最终 `turn/end` 后继续对账 |
| `turn/end` 已提交、尚未选择所有者 | 重启后重跑确定性对账；同一 `SaveIntentId` 合并 |
| 已 CAS 为 `RESOLVED_BY_AGENT` / `HANDLED_BY_USER` | 保持终态，不生成 Proposal |
| 已 CAS 为 `RUN2SKILL_OWNED`、Learning 尚未启动 | Scheduler 恢复并只启动同一 Learning Job |
| Learning provider 请求发出后崩溃 | 沿用现有 durable request ledger；请求恢复策略由 #70 负责，所有者仍只有 run2skill |
| 对账时 catalog/watcher 暂时不完整 | 有界重试 fresh snapshot；仍不完整则 `NEEDS_CONFIRMATION`，不继续学习 |

基线写入位于首个 `agent/pre-step` 且必须在调用 `next()` 前完成或明确失败。插件异常不得阻断主 Agent：写入超时/失败时放行 Agent，并将本回合所有权证据标为不完整；代价是该回合不能自动学习，而不是让主任务失败。

## 7. 隐私与安全边界

- 不新增完整 Session 副本；所有权对账仍从 DSH Session Persistence 按坐标读取。
- Skill 正文与工具参数只用于进程内摘要计算，不写入 run2skill Storage、日志、notice、RPC 或 UI。
- 不持久化 Shell 命令、工具输出、绝对 Skill 路径、用户名或 home 路径。
- 持久化内容限于有界摘要、枚举判定码、计数、时间、callId 摘要、root identity 摘要和 DSH lifecycle 坐标。
- 不读取受支持 Skill roots 之外的文件；链接逃逸或无法规范化时 fail closed。
- 对账结果不改变 Agent 创建文件的所有权，不自动删除、合并或改写 Agent 的 Skill。
- Purge 必须覆盖新增 baseline/ownership 派生记录，但继续不得删除 DSH Session Log 或 Agent 已写的原生 Skill。

## 8. 性能与无感要求

- 实现前必须增加共享的 Cheap Trigger prefilter：在每个 turn 的 `step=1`、执行任何昂贵 manifest/catalog 读取前，仅对 direct-user messages 运行与最终 capture 相同版本的无副作用规则；明确 miss 时不建基线，hit/UNKNOWN 才进入基线观察。
- prefilter 与 turn-end policy 必须共享版本和 fixture；若 prefilter miss、最终 turn-end 却 hit，因缺少基线只能进入 `NEEDS_CONFIRMATION`，不得补猜 `RUN2SKILL_OWNED`。该性能工作是后续实现前置风险，本 PR 不实现运行时代码。
- `agent/pre-step` 对 prefilter hit/UNKNOWN 的 turn 只在 `step=1` 建一次基线，后续 step 不重复扫描。
- 观察有明确的文件数、字节数和墙钟时间预算；超预算放行 Agent 并标为不完整。
- manifest 使用流式摘要，不把所有 Skill 正文同时留在内存。
- 用户正常工作时不显示所有权状态；`RESOLVED_BY_AGENT` 复用已有 Agent 回复/工具结果并静默结束，`RUN2SKILL_OWNED` 沿用自动技能草稿流程。
- 只有 `NEEDS_CONFIRMATION` 才进入 #72 定义的按需提醒与插件设置恢复入口。
- 性能预算数值必须在实现 Issue 中通过受支持 rc.2 的冷/热 catalog probe 后确定，不能在设计阶段拍常量。

## 9. stock DSH 不满足时的降级

若未来 DSH 缺少 `agent/pre-step`、完整 catalog snapshot、精确 Agent scope 或受支持默认 root contract：

1. 主 Agent 继续正常运行；
2. affected turn 不调用 run2skill 学习模型；
3. WorkItem 进入 `NEEDS_CONFIRMATION` 并记录非敏感兼容性原因；
4. 用户可在设置页确认“Agent 未保存，继续生成”或“已处理”；
5. 不退化为 post-only 猜测、提示词避让、只拦截 `skill-creator`，也不允许双通道都生成后再丢弃。

这是可用性降级，不是数据安全降级。按钮/命令只在这里作为恢复入口。

## 10. 迁移边界

本设计需要新增 ownership/baseline 持久字段，不能把旧 schema 中“字段缺失”解释成 `RUN2SKILL_OWNED`：

- 已进入 Learning、Review 或 Publication 的旧 WorkItem 可迁移为 `LEGACY_RUN2SKILL_OWNED`，保持既有结果，不重新学习；
- 尚处于 `CAPTURED` 且没有回合前基线的旧 WorkItem 迁移为 `NEEDS_CONFIRMATION`；旧记录不得直接补成 `RESOLVED_BY_AGENT`；
- 已终止或 `RESOLVED_NO_SIGNAL` 的旧 WorkItem 保持原终态；
- 新旧记录均须遵守现有 Purge fence、revision CAS 和不可见数据不复活规则；
- 具体 Domain version、迁移/回退步骤必须由后续实现 Design/Issue 明确，不能静默重建 Storage。

## 11. 后续实现验收矩阵

后续实现至少测试：

- 直接文件工具新增/更新有效 `SKILL.md`：`RESOLVED_BY_AGENT`，Learning Job `0`；
- Shell/PowerShell 间接新增不同名称 Skill：`RESOLVED_BY_AGENT`，Learning Job `0`；
- 直接文件工具成功重写相同内容且 exact target/readback/IntentBinding 全部可证明：`RESOLVED_BY_AGENT`；Shell 同内容重写：`NEEDS_CONFIRMATION`；
- 同回合仅一个 Skill 变化但与 trigger evidence 的目标/行为契约不相关：`NEEDS_CONFIRMATION`；
- 工具失败但参数已包含完整 Skill：`NEEDS_CONFIRMATION`；
- Agent 没有写 Skill：`RUN2SKILL_OWNED`，Learning Job `1`；
- Agent 只调用 `skill` 读取已有 Skill：不误判写入；
- 无效 Skill、删除、shadowed candidate、多文件变化、外部并发变化：`NEEDS_CONFIRMATION`，Learning Job `0`；
- project-dsh、project-agents、每个 mounted custom、user-dsh、user-agents、bundled（如存在）、root scan、catalog、`get()`、工具日志或 IntentBinding 任一不完整：`NEEDS_CONFIRMATION`，Learning Job `0`；
- 重复 `turn/end`、gap replay、重复 scheduler wake：不重复选 owner 或启动任务；
- 同版本 pre-step/session 重放复用 exact `TurnBaselineId` 与原 manifest；baseline/trigger policy 版本不一致时 `NEEDS_CONFIRMATION`；策略热变更后的新 turn 使用新版本；
- 在每个状态转换点崩溃并重启：保持单一所有者；
- rc.2 stock DSH 上验证首 step 基线、filesystem watcher 延迟和 catalog complete 行为；
- 持久化快照、日志、RPC 与 UI 不包含 Skill 正文、Shell 命令、工具参数、绝对路径或凭据。

在这份 Design 获批前，不进入实现，也不据此提前拆分实现 Issue。
