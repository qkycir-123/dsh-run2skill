# 无感提醒与插件设置页 Design

状态：待评审

对应 Issue：[“仅在需要人工处理时提示，并将 run2skill 持久信息迁入设置” #72](https://github.com/qkycir-123/dsh-run2skill/issues/72)

设计日期：2026-08-21

DSH 源码基线：`deepseek-ai/deepseek-harness@99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`（`0.1.0-rc.7`）

## 1. 结论

run2skill 的正常自动学习过程不占用会话 Header，也不以成功、进度或空闲状态打扰用户。Web 端只在 Host 明确给出“现在存在用户可执行动作”时显示一次 DSH `Toast`；唯一例外是 Store 不可用时用于避免显式保存静默丢失的有界 `UNSAVED_SIGNAL` RuntimeNotice。持久详情和所有操作集中到 **设置 → 插件 → run2skill** 独立标签页。

```text
Host Attention Projection
  -> durable current PROJECT + USER Action Queue
  -> bounded RuntimeNotice warning（仅 Store 不可用例外）
     -> Settings 展示与操作
     -> Toast 短时提醒和浏览器侧去重
```

关键不变量：

1. 正常状态下，会话 Header 中没有 run2skill 可见元素。
2. Toast 和设置页不得各自推导“需要处理”；二者只消费同一份 Host Attention Projection。
3. 没有可执行动作就不提示；唯一例外是显式保存尚未写入 Store 的数据丢失风险警告。未知、加载中或观察不完整不得被当成空队列。
4. 浏览器本地状态只抑制重复 Toast，不能处理、关闭或隐藏 Host 事项。
5. Proposal 仍须人工审核；本设计不增加自动批准或自动发布。

## 2. 范围审计

### 2.1 本设计负责

- 删除两个会话 Header 常驻信息框后的信息架构；
- 定义统一的 Action Queue 与可操作性真值；
- 定义一次性 Toast 的触发、合并、去重和重启行为；
- 定义 run2skill 设置标签页的内容分区和作用域；
- 定义 Client slot 生命周期、权限和隐私约束；
- 给 #70 和 #73 提供呈现契约。

### 2.2 本设计不负责

- 不修复学习模型连续失败；失败分类、重试和关闭能力属于 #70；
- 不改变 Agent 与 run2skill 的单一生成所有者；该状态机属于 #71；
- 不实现 DSH 公共组件、CSS、主题和视觉重构；实现属于 #73；
- 不改变 Cheap Trigger、Learning prompt、Review、Publication、Purge 或 Storage schema；本设计不新增字段、Action Queue 表或通知表；
- 不增加完整 History、搜索、批量批准、通知中心或遥测；
- 不修改或 fork DSH。

## 3. stock DSH 契约证据

以下证据来自上面的固定 DSH commit；实现时还要对当时支持的全部 DSH 版本运行兼容性探针。

| 契约 | 源码证据 | 设计含义 |
|---|---|---|
| 插件独立设置页 | [`slots.ts` 声明根作用域列表槽 `settings.plugins.tab`](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/client/ui-settings/src/client/contract/slots.ts#L52-L62)；[`ui-settings-plugins` 通过 `ctx.slots.inject` 注册标签页](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/client/ui-settings-plugins/src/client/index.ts#L133-L153) | run2skill 使用正式扩展槽，不深层导入 DSH 私有设置卡片 |
| 标签页生命周期 | [`PluginsSettingsSection` 只在首次选中时挂载标签页，之后用 `hidden` 保持挂载](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/client/ui-settings-plugins/src/client/PluginsSettingsSection.tsx#L33-L109) | 页面切走后本地草稿可保留，但轮询必须自行暂停或降频，不能把“仍挂载”当成“仍可见” |
| Session 提醒挂载点 | [`conversation.session.header.actions` 是 session-scope list slot](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/client/ui-conversation/src/client/contract/slots.ts#L48-L63)，并由 [`ConversationSession` 在标题旁渲染](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx#L94-L106) | run2skill 只借此 session 生命周期挂载 portal Toast；组件本身始终不渲染常驻 Header DOM |
| 当前作用域输入 | [runtime 为每个 slot 注入 `useSessions` / `useWorkspaces`，并为 session slot 注入 `sessionId`](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/client/runtime/src/client/index.ts#L124-L150) | root-scope Settings 与 session-scope Toast 可以从同一 live facts 解析 CurrentScope，无需跨项目扫描 |
| Toast 行为 | [`Toast.tsx` 的 `HOLD_MS=3000`、`FADE_MS=1000`、`role="alert"` 和 `onDone`](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/client/ui-primitives/src/Toast.tsx#L8-L54) | Toast 总计约 4 秒、不可交互，只承载短文案，不能放审核或恢复按钮 |
| slot 装配与释放 | [`register` disposer 会移除贡献并递归折叠子槽](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/client/ui-slots/src/index.ts#L707-L736)；`ctx.slots.inject` 等待声明存在 | run2skill 的注册、订阅、轮询、AbortController 和 Toast timer 必须随 plugin fiber 一起释放，不能留下幽灵提醒 |

`settings.plugins.tab` 的 owner props 为空，不提供“打开指定标签页”或“当前是否选中”的公共动作。第一版 Toast 因此只写清导航路径，不伪造点击或深链能力。

## 4. 唯一可操作性真值

### 4.1 Action Queue

Host 从当前可见的 durable state 投影一个裁剪后的 Action Queue。它严格只包含当前 PROJECT 与 USER；Toast、设置页待处理数量和设置页列表都通过同一个 Attention Projection 消费它。

每项至少包含：

```text
actionKey       稳定的提醒/幂等键
subjectId       WorkItem 的非敏感身份
kind            REVIEW_PROPOSAL | RETRY_LEARNING | DISMISS_LEARNING |
                REFRESH_PROPOSAL | RETRY_PUBLICATION | DISMISS_FAILURE |
reasonCode      稳定、非敏感的原因码
scope           USER | PROJECT
workspaceRef?   不含路径的项目显示引用
availableActions[]
createdAt / updatedAt
```

`actionKey` 由 Host 生成，Client 不得自造或推进。其 canonical 输入为 `run2skill-action-v1 + subjectId + kind + reasonCode + durableGeneration`；不得直接使用频繁变化的 WorkItem revision。

Action Queue 响应还必须分别携带 `userCompleteness` 与 `projectCompleteness: KNOWN | UNKNOWN | UNAVAILABLE`。Host storage、兼容性或作用域证据不完整时返回 `UNKNOWN`；没有当前 Workspace 时 PROJECT 为 `UNAVAILABLE`，不等于已证明为空。只有 USER 与当前 PROJECT 均为 `KNOWN` 且数量为零时才显示完整空态；USER-only view 只能显示带“未选择当前项目”限定的 USER 空态。

### 4.2 durableGeneration

`durableGeneration` 的权威 owner 是 Host Store 的 WorkItem/Review/Publication 聚合；Action projector 是纯投影，不能单独持久化、猜测或推进代际。它优先从已经由状态转换事务提交的 identity 派生：

| Action | durableGeneration |
|---|---|
| `REVIEW_PROPOSAL` | immutable `ProposalRef(proposalId, revision, digest)` |
| DISCARD coverage 恢复/刷新 | `ProposalRef + coverageRetryCount + review.failure.occurredAt + review.failure.code` |
| `RETRY_PUBLICATION` | `PublicationStateV1.activeAttemptId + journal tail digest + review.failure.occurredAt + review.failure.code` |
| `REFRESH_PROPOSAL` | 当前 `ProposalRef + review.publicationOutcome + review.failure.occurredAt + review.failure.code`；生成新 Proposal 后自然换成新 `ProposalRef` |
| `RETRY_LEARNING` / `DISMISS_LEARNING` | `learning.failure.occurredAt + learning.failure.code + learning.attempt + learning.requestBudgetUsed + callsSummary` |

推进规则：

1. `callsSummary` 是现有 `LearningCallV1[]` 按 `requestOrdinal` 排序后的 canonical 数组；每项只能使用 schema 中真实存在的 `{ requestOrdinal, kind, inputTokens ?? null, outputTokens ?? null, outcome }`，其中 `outcome` 为 `SUCCEEDED | FAILED | ABORTED | TIMED_OUT`。不存在也不得推导 `status` 字段。
2. 负责状态转换的 Store 提交新的 `ProposalRef`、publication attempt/journal 或 structured failure event 后，Action projector 才能据此产生 key；崩溃重放复用同一 durable event identity，不产生新 Toast。
3. 轮询、claim lease、`updatedAt`、进度、同一事务重放和无关 WorkItem revision 不推进 generation。
4. 用户触发学习恢复后，旧 failure action 在恢复开始时离开 Queue；如果恢复再次失败，现有 Store 写入新的 `LearningFailureV1.occurredAt`，并绑定该轮已有的 `attempt`、`requestBudgetUsed` 与 `LearningCallV1.outcome` 快照，因此即使 failure code 相同也得到新 key，不会被旧 `seenAttentionKeys` 压住。
5. 如果后续发现某种 action 无法从现有 durable `ProposalRef`、failure `occurredAt`、attempt/call outcome 或 publication journal 身份唯一表达，本设计对该 action 保持阻塞，必须单独创建 Migration ADR/domain version bump Issue 并完成升级/回退证据；#72 和 #70 都不得用同版本 optional 字段偷渡身份。

Host 对上述输入做 canonical hash 得到 `actionKey`。同一 durable 事实跨重启得到同一个 key；新的真实恢复事务一定得到新 key。

### 4.3 真值表

| Host 情况 | 是否进入 Action Queue | 原因 |
|---|---:|---|
| `CAPTURED`、`ANALYZING`、自动重试、`RECOVERING` | 否 | 后台仍能自行前进 |
| 学习成功但尚在自动策展 | 否 | 无用户动作 |
| `READY_FOR_REVIEW` 且 Proposal 可审核 | 是 | 用户必须批准、拒绝或确认 DISCARD 覆盖 |
| 学习失败但仍有自动恢复预算 | 否 | 先让系统自动恢复 |
| 学习失败且 #70 提供了有效的重试或关闭动作 | 是 | 用户现在可以解除阻塞 |
| `PUBLISHING` | 否 | 只是进度，不要求用户介入 |
| `NEEDS_REFRESH` 且可生成/刷新 Proposal | 是 | 用户必须选择恢复路径 |
| `PUBLISH_FAILED` 且存在安全重试或关闭动作 | 是 | 用户可以恢复或结束事项 |
| `DEGRADED` / `INCOMPATIBLE`，但没有明确用户补救动作 | 否 | 健康状态本身不等于可操作事项 |
| 兼容性或完整性故障，且设置页能给出明确补救步骤 | Runtime warning | 它是健康补救提示，不伪装成其他 PROJECT 的 WorkItem |
| `DISCARDED`、`PUBLISHED`、已关闭失败 | 否 | 已终结 |

因此，`processingState === NEEDS_ATTENTION`、`learning.needsAttention > 0` 或一个健康码都不能单独触发 Toast。只有 Host 同时证明事项属于当前 PROJECT 或 USER、可见、未终结并给出至少一个当前有效动作，才算 actionable。

### 4.4 Store 不可用的 RuntimeNotice 例外

durable Queue 不能形成时，系统仍须避免把用户的明确保存请求静默吞掉。现有进程内 `RuntimeNotices` 是唯一允许的非持久提醒来源：

现有实现边界保持不变：`src/application/capture/runtime-notices.ts` 默认最多保留 256 项并在 30 秒内按 identity 聚合；`src/application/capture/bounded-signal-retry.ts` 使用 `250 / 1000 / 4000 ms` 三个 delay，即一次初始尝试加三次有界重试。#73 只在最终 `EXHAUSTED` 结果上设置进程内 `requiresAttention`，不得另起无限 retry。

- 只把 `UNSAVED_SIGNAL` 投影为数据丢失风险警告；普通 `HEALTH` 只有在带有明确补救说明时才可进入 runtime warnings；
- RuntimeNotice 在进程内携带裁剪后的 `signalClass: EXPLICIT_SAVE | OTHER_HIGH`，它来自已经完成的 Cheap Trigger，不包含用户正文；显式保存使用“保存请求尚未持久化”文案，其他信号使用一般“学习信号尚未持久化”文案；
- signal 写入失败后仍先执行既有有界 retry；retry 进行中不弹 Toast，耗尽后才把该 notice 标成 `requiresAttention`；
- runtime notice identity 使用 `healthCode + rootSessionId + turnEndSeq + firstObservedAt`。同一次 bounded retry 聚合在一个 occurrence；成功持久化时 `clearSignal` 立即移除；清除后再次发生是新的 occurrence；
- 继续遵守现有上限、30 秒聚合和 completeness 下降语义；达到上限淘汰过 UNSAVED notice 后，设置页显示“尚未保存数量未知”，不得显示假空态；
- RuntimeNotice 不授权 Review/Publication mutation；文案按 `signalClass` 提示“保存请求”或“学习信号”尚未持久化，并给出安全的重试/保持 DSH 运行等恢复说明；
- Session Toast 只接收与 slot `sessionId` 相同的 notice；Settings 有当前 Workspace 时只显示其 `sessionIds` 内的 notice，有当前但未绑定 Workspace 的 Session 时只显示该 Session notice，无当前 Session 时不跨项目聚合 UNSAVED notice；`sessionId=global` 的安全兼容性警告可独立显示；
- 进程崩溃会丢失 notice，重启后的唯一可靠补偿是 DSH durable Session Log gap scan。在 gap scan 证明完成前，Attention Projection 的 durable completeness 保持 `UNKNOWN`；若重新写入仍失败，会形成新的有界 notice。

Attention Projection 因此包含 `{ durableQueue, runtimeWarnings }`。Toast 与设置页仍消费同一投影，不能另读 Host 日志或自行猜测；这是一条明确定义的 Store-failure 例外，不是第二套普通事项队列。

## 5. Toast 行为

### 5.1 触发

Client 每次取得 Attention Projection 后，比较当前 durable `actionKey` 或 runtime `noticeKey` 与本运行周期已提醒集合：

1. 没有新 key：不渲染 Toast；
2. 有一个新 key：显示“run2skill 有 1 项需要处理，请前往设置 → 插件 → run2skill”；
3. 同批出现多个新 key：合并为一次数量提醒，并在调度显示时原子地把该批 key 标记为已提醒；
4. Toast 尚未结束时又出现新 key：排队合并成下一次提醒，不叠放；
5. 原事项被处理后从投影消失；若以后以新的 durable generation 或 RuntimeNotice occurrence 重新变得可处理，可再提醒一次。

Toast 只包含非敏感数量和导航路径，不包含 Proposal 内容、失败堆栈、Provider 标识、项目路径或会话摘录。它不可点击，不承担确认、审核、重试或关闭操作。

### 5.2 去重与重启

- 轮询去重：当前浏览器运行周期保存 `seenAttentionKeys`；同一个 key 无论轮询多少次只提醒一次。
- 并发去重：先登记 key，再挂载 Toast，避免两个完成顺序相反的请求重复显示。
- 重连与标签切换：不清空本周期集合。
- 应用重启或页面完整重建：允许仍未处理的 key 再提醒一次，但新的运行周期内仍只一次。
- 本地集合可以使用内存或会话级浏览器存储；不能写入 Host 事项的处理状态，也不能跨设备宣称事项已处理。

如果 durable Queue 为 `UNKNOWN`、请求失败或数据过期，Client 不根据它弹“有 N 项”或“没有事项”的 Toast；设置页显示安全的暂不可用状态并允许重新读取。已经由同一响应安全带回的 bounded RuntimeNotice warning 仍可单独提醒，避免 Store 故障把明确保存静默吞掉。

### 5.3 挂载点

第一版继续使用 stock DSH 的 session-scope `conversation.session.header.actions` 作为当前会话生命周期内的挂载点。贡献组件在无 Toast 时返回 `null`；有提醒时也只挂载 DSH `Toast` 的 body portal，组件自身不产生任何 Header DOM、占位宽度、Pill、Button 或 badge。

没有当前会话时不显示全局 Toast；设置页仍可显示 USER Action 与 RuntimeNotice 状态。若未来 DSH 提供正式全局通知 slot，应另开兼容性变更，不在本设计中猜用内部 shell 节点。

## 6. 设置 → 插件 → run2skill

run2skill 通过 `ctx.slots.inject('settings.plugins.tab', ...)` 注册：

```text
id: run2skill
scope: root
label: run2skill
```

页面按以下顺序组织：

1. **需要处理**：Action Queue 的完整列表、数量、原因和允许动作；Proposal 审核、学习失败恢复、发布失败恢复均从这里进入。
2. **最近活动**：有界展示当前仍保留的 run2skill 记录，只用于理解自动沉淀结果；它不是完整 History，也不承诺跨 Purge/迁移保留。
3. **自动学习**：现有 Automatic Learning 设置及生效语义。
4. **数据管理**：现有 PROJECT/USER Purge、进行中状态、失败恢复和安全说明。

### 6.1 当前作用域解析

设置标签页虽然是 root-scope，DSH slot 标准 props 仍提供 `useSessions` 与 `useWorkspaces`。Client 用这两份 live snapshot 建立唯一 `CurrentScope`：

```text
currentSessionId = SessionListState.current
currentWorkspace = Workspaces snapshot 中 sessionIds 包含 currentSessionId 的唯一项
request scope = currentWorkspace?.workspaceId + USER
```

- Session Toast 组件直接使用 session-scope slot 提供的 `sessionId`，再从同一 `useWorkspaces` snapshot 解析该 Session 的 workspaceId；它只请求该 PROJECT + USER。
- Settings 页面使用 `SessionListState.current`，因此不要求回到产生事项的原 Session；只要当前选中的 Session 属于同一个 Workspace，就能处理该 PROJECT 事项。
- 当前 Session 没有已注册 Workspace，或根本没有当前 Session 时，页面只请求 USER；PROJECT 标为 `UNAVAILABLE`，并提示先选择一个已绑定 Workspace 的 Session。
- 当前 Session/Workspace 改变时，Client 立即 abort 旧请求、清空旧 PROJECT 列表和数量，再以新 workspaceId 读取；旧 PROJECT 结果即使晚到也必须因 scope generation 不匹配而丢弃。
- USER actionKey 在所有 scope view 中相同，共享本运行周期去重集合，不因切换 Workspace 重复 Toast。
- Host 的 Action Queue RPC 接收可选的精确 `workspaceId`：有值时只返回该 PROJECT + USER；无值时只返回 USER。Host 重新验证 workspace identity，不能信任 Client 提交的显示名称或路径。

跨 PROJECT 聚合、全局项目 Inbox、后台轮询其他 Workspace，以及在无当前 Workspace 时猜测最近项目，均为明确非目标。

页面必须做到：

- 只展示 CurrentScope 的当前 PROJECT 与 USER，不得混入其他项目；
- 项目只显示 DSH 提供的安全名称或不透明引用，不显示绝对路径；
- 当前工作区暂不可验证时，把 PROJECT 标为 `UNKNOWN` 并显示“暂不可执行”，不能回退到其他项目或把它解释为空；
- 列表、详情和 mutation 完成后都重新读取 Host Action Queue；
- 重复点击由现有 revision/CAS/single-flight 边界拒绝或收敛，不产生第二次动作；
- USER 与当前 PROJECT 均为 `KNOWN` 且数量为零时才显示完整空态；USER-only 模式必须明确写“未选择当前项目”，不能声称所有 PROJECT 都为空。

## 7. 生命周期与刷新

- 注册必须使用 `ctx.slots.inject`，不能假定 `settings.plugins.tab` 在 run2skill apply 时已声明。
- Settings 标签页首次访问前不创建详情轮询；首次访问后虽然 DSH 保持组件挂载，隐藏时仍需暂停高频详情轮询，只保留满足提醒所需的低频 Action Queue 读取。
- 当前会话提醒和设置页共享同一个 Client attention source 与 `seenAttentionKeys`，但各自按上述 session/workspace 规则提供 CurrentScope；不能各启一套互不协调的计数器。
- scope generation 是纯 Client 请求竞态栅栏，不进入 actionKey；Session/Workspace 切换时推进它并拒绝旧响应。
- 请求必须支持取消；plugin fiber dispose、连接 reset 和组件卸载时取消请求、订阅和 timer。
- HMR/reload 可以视为新的 Client 运行周期，最多重新提醒一次；不得因旧 fiber 的 timer 或订阅存活而重复提醒。
- mutation 后立即刷新，后台轮询只是兜底，不承担事实提交。

具体轮询间隔、React 组件与 CSS 属于 #73；本设计只冻结生命周期和一致性要求。

## 8. 权限与隐私

- Attention Projection、详情和 mutation 沿用 `/run2skill` 的 Host loopback authority；远程或不可信页面不可读取或执行。
- 远程 Client 无权限时显示“请在本机 DSH 中管理”，不得把拒绝解释为空队列。
- Host DTO 只返回渲染和执行所需的裁剪事实；不得返回 API Key、凭据引用值、原始 Session 正文、未过滤 Evidence、绝对路径、模型原始输出或异常堆栈。
- Proposal 正文和 Diff 仍只在 loopback 详情请求中按现有安全/raw 规则展示；Toast 永不携带正文。
- 最近活动不新增会话副本，不扩大 run2skill 现有数据保留范围；Purge visibility predicate 必须同样作用于 durable Action Queue、详情、数量和活动记录。
- RuntimeNotice DTO 只返回 warning kind、非敏感 health code、数量、是否完整和安全恢复文案；不得返回原消息、cwd、Session 正文或异常对象。
- 任一适用 completeness 为 `UNKNOWN` 时 fail closed：不推断不存在事项，不允许基于不完整列表做批量处理。RuntimeNotice 例外只负责警告，不放宽 mutation。

## 9. 冻结产品与架构契约同步

本设计保持并细化现有冻结契约：

- Web Action Queue 是当前 PROJECT + USER，不是 History；不得用其他项目 Proposal 干扰当前工作区。
- PROJECT 必须来自当前 Session 对应的可验证 Workspace identity；无 Workspace 时不猜路径、不猜最近项目，只保留 USER view。
- Store 不可用不阻断 DSH 主 Agent：产生有界 RuntimeNotice、执行同 SignalKey retry、不启动 Learning；进程崩溃后由 durable Session Log gap scan 补偿。
- Web 入口使用 stock `conversation.session.header.actions` 与 `/run2skill` loopback RPC；远程页面仍无权读取或 mutation。
- Action key 只投影现有 durable `ProposalRef`、structured failure event、attempt/call outcome 与 publication journal；本设计不改变 `run2skill_v1` schema。若现有事件身份不足，必须另立 Migration ADR/domain version bump Issue，不能由 #72/#70 添加同版本 optional 字段。

这些条款取代旧 Header 具体文案和常驻控件形式，但不改变 PROJECT/USER scope、durable-before-learning、fail-open/fail-closed、Review 与 Publication 权威边界。

## 10. 与 #70、#71、#73 的边界

- **#70** 提供准确学习失败原因、有限重试/关闭动作及安全 DTO；#72 只使用 #70 持久化的现有 `LearningFailureV1.occurredAt/code`、attempt/request budget 与 `LearningCallV1` facts 决定这些动作何时进入 Action Queue、在哪里呈现和何时提醒。
- **#71** 决定保存意图的唯一生成所有者；其 `NEEDS_CONFIRMATION` 只有在定义了真实用户选择动作后才进入同一 Action Queue。
- **#73** 实现本设计：删除常驻 Header UI，复用 DSH `Toast`，注册设置标签页，提供 Attention Projection/RPC adapter，并迁移现有 Inbox/Settings/Purge UI；RuntimeNotice 的 `requiresAttention` 和 `signalClass` 只是有界进程内投影，不改变 durable WorkItem 状态机。

#73 可以在 #70 的动作 DTO 尚未完成时先支持 Proposal 和现有发布失败，但不能把暂时不可操作的学习失败伪装成可操作提醒。

## 11. 验收与实现门

后续实现至少覆盖：

1. 正常捕获、分析、成功、自动恢复、空闲和 `PUBLISHING` 时 Header 无 run2skill DOM、无 Toast；
2. Proposal、可恢复学习失败、`NEEDS_REFRESH`、可重试发布失败各产生正确 Action；
3. 同一 actionKey 连续轮询、重连和标签切换不重复；批量新事项只显示一个合并 Toast；
4. ProposalRef、learning failure occurredAt + attempt/call outcome 摘要和 publication activeAttemptId/journal 各自稳定派生 generation；同类重试再次失败会产生新 key，崩溃重放和无关 revision 不产生新 key；
5. 完整重启后未处理事项最多再提醒一次，旧 fiber 不留下 timer/订阅；
6. 当前 Workspace A 只显示 A PROJECT + USER；切到 B 时立即清除 A 并只显示 B + USER；无当前 Session/Workspace 时只显示 USER 且 PROJECT 为 `UNAVAILABLE`；
7. Store 写入失败时 bounded retry 期间不提示，耗尽后同一 UNSAVED occurrence 只提醒一次；成功后清除；notice 淘汰或重启 gap scan 未完成时不显示假空态；
8. `UNKNOWN`、RPC 失败和不可信远程浏览器不显示假空态，也不能 mutation；
9. 设置页无需原会话即可查看当前 PROJECT + USER，并能完成现有审核、恢复和 Purge；跨项目聚合测试必须证明不会发生；
10. Action Queue、列表、详情和 mutation 全部应用相同 Purge visibility、CurrentScope 和 Host 权限；
11. Toast、RPC、设置页和日志不泄露密钥、正文、路径或原始模型输出；
12. stock DSH rc.2 的 `conversation.session.header.actions`、settings slot、Toast 和生命周期兼容性探针通过。

本 Design 获批前不进入 #73 实现；实现不得为了视觉便利修改 #70/#71 的状态机或放宽现有 Review/Publication 安全边界。
