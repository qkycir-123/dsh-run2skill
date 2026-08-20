# 切片 D Design：产品化与首个公开 Alpha

状态：已接受；维护者于 2026-08-20 批准本 Design，可拆分 D1–D5 Issues
设计日期：2026-08-20
前置契约：已接受的 PRD、Architecture Baseline、切片 A/B/C，以及切片 C 验收证据
DSH baseline：`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`（`0.1.0-rc.7`）

## 1. 结论

切片 D 不再增加新的学习、策展或发布能力，而是把切片 A/B/C 已证明的闭环收成一个普通用户可以安装、配置、清除数据、升级和卸载的公开插件：

```text
现有安全闭环
  -> 原生 Automatic Learning 设置
  -> 可恢复的数据 Purge
  -> Action Queue 与可访问性收口
  -> 首个公开 schema 冻结
  -> 可复现安装与发布候选验收
```

本切片坚持纯插件方案：只使用固定 DSH baseline 已公开的 Settings、Storage Domain、Connection、Client Slot、Skill Registry 和 Loader 接口，不修改 DSH 源码，不要求 DSH fork，也不向 DSH 提交上游 PR。

## 2. 范围

### 2.1 本切片交付

- 在 DSH 原生 Settings 中注册 `run2skill` namespace，暴露唯一用户设置 `automaticLearning: boolean = true`；
- 关闭 Automatic Learning 后暂停普通自动学习，同时保持用户显式“保存为 Skill”请求可用；
- 在 DSH Web 的插件设置区域提供开关、运行策略说明和 PROJECT/USER 数据清除入口；
- 实现 PROJECT/USER Purge preview、二次确认、持久 journal、立即隐藏、失败恢复和完成校验；
- 完善 Proposal Inbox 的状态文案、键盘操作、焦点、屏幕阅读器状态和错误恢复；
- 冻结首个公开 Alpha 的 Storage Domain 数据格式，明确未来迁移门；
- 收口包元数据、公开文档、安装/升级/禁用/卸载与 release-candidate 验收。

### 2.2 明确非目标

- 不增加完整 History、Rollback、Retention 策略或数据导出 UI；
- 不增加 Learning Model selector；模型继续 `inherit-session`；
- 不改变 Cheap Trigger、Learning prompt、Proposal 策展或发布文件协议；
- 不自动发布 Proposal，不增加 Approve All、CLI/TUI 审批或远程审批；
- 不增加自定义 Skill root、额外 Storage backend、Cloud Sync、Telemetry 或多 Host 并发；
- 不删除 DSH Session Log，也不删除已经发布的原生 Skill；
- 不修改 DSH、不依赖 DSH 本地 patch、不创建 DSH 上游 PR；
- 不在未经单独授权时执行 npm publish、GitHub Release、tag 或修改远程 release 状态。

### 2.3 进入实现的阶段门

本 Design 获批后再创建 Slice D Issues。每个 Issue 使用工作区 `AGENTS.md` 规定的轻量流程；需求或架构变化返回主会话决策，不由实现会话自行扩大。

## 3. 关键决策

1. **配置直接复用 DSH Settings。** run2skill 不自建配置文件或配置表；DSH 负责 namespace、默认值、持久化、热更新和 `expectedRevision`。
2. **关闭开关不是卸载插件。** OFF 只暂停普通自动学习；显式保存、已有 Proposal 的查看/审核、发布恢复和 Purge 仍工作。完全停用仍由 DSH 禁用或卸载插件完成。
3. **已经开始的 Analysis 不被中途改写。** worker 启动时取得一次设置快照；切换开关只影响下一次 Analysis。
4. **Purge 是点时间操作。** preview 固定 `hideBefore` 和作用域；确认后只清除该边界之前匹配的数据，之后产生的新数据不被误删。
5. **先隐藏，再删除。** durable purge journal 写成功后，命中数据立即退出正常查询和调度；后端删除失败不能让半清除数据重新出现在 UI。
6. **Purge 不碰用户发布成果。** WorkItem、Evidence、Experience、Proposal、usage 和 Lineage metadata 可删，DSH Session Log 与磁盘上的 `SKILL.md` 永远不删。
7. **忙碌发布不能被 Purge 截断。** 若匹配数据正在 `PUBLISHING`，confirm 返回可重试的 `PURGE_BUSY`；先让已开始的文件事务恢复到安全结果，再重新确认，避免删除恢复 journal 后留下不确定文件状态。
8. **首个 Alpha 才是公开迁移起点。** 公开前的开发数据允许显式重建；公开 Alpha 后不允许静默清库，任何破坏性 domain version 变化必须先有独立 Migration ADR、备份/回退和升级测试。
9. **产品设置进入 DSH 原生插件设置页。** 不在 Proposal Inbox 内再造第二套设置导航；Inbox 继续只做当前工作区的 Action Queue。
10. **发布候选不等于外部发布。** Slice D 可以生成和验收 tarball、安装说明和版本候选，但真正 tag、Release 或 npm publish 仍需单独授权。
11. **完成边界必须跨重启持续。** active journal 完成时原子转成 path-free 的 durable completed fence；内存缓存不是真相。旧 Session gap 或晚到 Learning 不得在 journal 清除、runtime 重开或进程重启后重新形成已清除作用域的数据。

## 4. Automatic Learning

### 4.1 Settings 契约

Host 注册：

```text
namespace: run2skill
applies: live
schema:
  automaticLearning: boolean = true
```

DSH Settings 是唯一权威来源。Web 写入携带最近读取的 `expectedRevision`；stale revision 明确提示“设置已变化，请刷新”，不得覆盖较新的值。

v0.1 不提供模型选择器。界面只说明 Learning 使用发起该 Session 的模型路由；模型 route 仍来自 Session request/header。

### 4.2 ON/OFF 行为

Trigger 分成两类：

- 显式：WorkItem 的 `triggerHits` 至少含一个 `EXPLICIT_SAVE`；
- 普通：只含 `CORRECTION`、`CONSTRAINT` 或 `WORKFLOW`。

设置为 OFF 时：

- 新 Turn 仍执行 Cheap Trigger，因为系统必须识别显式保存；
- 仅普通 Trigger 不创建新的可学习 WorkItem；
- 显式保存继续立即形成 durable WorkItem；
- 无法完成扫描的 metadata-only WorkItem 仍可持久化并重试，以免漏掉显式保存；扫描完成后若只有普通 Trigger，则收口为无信号；
- 设置关闭前已经排队、但尚未开始的普通 WorkItem 保持 durable `CAPTURED`，不 claim、不丢弃；重新开启后恢复；
- 已经开始的 Analysis 使用启动快照继续完成；
- 已经生成的 Proposal、Review、Publication recovery 和 Purge 不受开关影响。

设置变化不重扫 activation fence 之前的 Session 历史，也不创建新的历史 WorkItem。

### 4.3 Settings 可用性

正式支持的 DSH `web` profile 必须提供 Settings service；run2skill Host 将 `settings` 作为必要注入。Settings 暂不可用时 run2skill 自身保持 pending，不把缺失配置偷偷解释为 ON；DSH 主 Agent 继续 fail open。

## 5. Purge 作用域

### 5.1 PROJECT

PROJECT preview 必须绑定当前 DSH workspace 的 `workspaceId`、canonical path、观察时间和 root-contract 事实。

PROJECT 匹配规则：

- 已学习 WorkItem：`persistenceScope=PROJECT` 且其 workspace binding 与当前 workspace 一致；
- 尚未形成 Learning Proposal 的 WorkItem：其 capture workspace binding 与当前 workspace 一致，视为该项目的 provisional 数据；
- `persistenceScope=USER` 的 WorkItem 即使源于当前项目也不由 PROJECT Purge 删除；
- PROJECT Lineage：`scope=PROJECT`，且 target 由当前 workspace 的版本化 stock project root 精确证明；不得只做字符串前缀判断。

workspace 无法重验证、记录未绑定或 root facts 不完整时，preview 把它列为“无法证明、将保留”，不得扩大删除范围。

### 5.2 USER

USER preview 匹配：

- 已形成 `persistenceScope=USER` 的 WorkItem；
- `scope=USER` 的 Lineage；
- 与这些 WorkItem 一起保存的 Evidence、Experience、Proposal、Review、Publication journal、model usage 和审计事实。

尚未产生 Learning Proposal 的 WorkItem 没有 USER 归属证明，因此不由 USER Purge 删除；preview 显示保留数量。用户可按所在 PROJECT 清除这些 provisional 数据。

### 5.3 明确保留

两种 Purge 均保留：

- DSH Session Log；
- 已发布的 `SKILL.md`、bundle 目录及其普通 DSH 可用性；
- 不匹配作用域或无法证明作用域的 run2skill 数据；
- `hideBefore` 之后产生的新数据；
- 不含用户 Evidence 的全局运行健康计数和 activation/checkpoint 水位。

删除 Lineage 后，磁盘上的 Skill 仍是 unmanaged 普通 DSH Skill；未来若用户再次批准 MERGE，run2skill 按现有内容重新收养，不假装拥有已删除的 revision history。

## 6. Purge 协议

### 6.1 Preview

`purge/preview` 是只读操作，返回：

```text
previewId, digest, expiresAt
scopeBinding, hideBefore
workItemCount, lineageCount
blockedOrUnprovenCount
willDelete[], willKeep[]
busyPublicationCount
```

Host 对作用域、边界和有序候选 ID 计算 digest，并只在内存中保存最多 5 分钟的有界 preview。Preview 不产生删除 journal；过期、workspace 改变、候选集合改变或 digest 不匹配时，confirm 返回 `PURGE_PREVIEW_STALE`，要求重新 preview。

### 6.2 Confirm 与二次确认

Client 的确认文案必须明确：

- 将删除 run2skill 的过滤 Evidence、Experience、pending、Proposal、Revision metadata、usage 和相关审计事实；
- 不会删除 DSH Session Log；
- 不会删除任何已发布原生 Skill；
- 删除 Lineage 后，保留的 Skill 将被视作普通现有 Skill。

确认框采用 `alertdialog`、focus trap、初始焦点、Escape 取消和关闭后焦点恢复。确认请求只携带 `previewId + digest`，不携带 Client 自选 ID 列表。

若存在匹配的 `PUBLISHING` WorkItem，confirm 不写 purge journal，返回 `PURGE_BUSY` 和数量。其他新 publication claim 在 preview 后仍可能发生，因此 Host 必须在写 journal 前再次串行检查。

### 6.3 Durable saga

global 增加可选的单个 active `PurgeJournalV1` 和可选、版本化的 `CompletedPurgeFencesV1`；v0.1 单 Host、一次只运行一个 active Purge：

```text
purgeId
scopeBinding
hideBefore
candidateDigest
startedAt
phase: HIDING | DELETING_LINEAGES | DELETING_WORK_ITEMS | VERIFYING
deletedWorkItems
deletedLineages
lastError?
```

completed fences 只保存：

```text
schemaVersion
USER: purgeId, completedAt, hideBefore
PROJECT[scopeIdentityDigest]: purgeId, completedAt, hideBefore, scopeIdentityDigest
```

PROJECT 的确定性 `scopeIdentityDigest` 对 canonical workspace path 的平台规范化身份求 hash；不保存 workspace path、root path、Evidence、候选 ID 或删除审计内容。USER 只有一个 fence。相同 scope 只保留 `hideBefore` 最大的记录。

执行顺序：

1. 串行重验 preview、workspace/root 和不存在匹配 `PUBLISHING`；
2. durable 写入 journal；从此正常查询、queue count、review mutation、scheduler claim 和详情读取统一应用 Purge visibility predicate；
3. 中止匹配且可中断的 Learning；禁止命中旧 WorkItem 产生新的 claim 或 publication；
4. 先删 Lineage，再删 WorkItem；每次删除幂等，并按有界批次更新 phase/count；
5. 重新扫描确认 `hideBefore` 之前无正常可见匹配记录；
6. 在同一次 authoritative global update 中 upsert completed fence 并清除 active journal；不得出现“journal 已清、fence 尚未 durable”的中间状态；
7. UI 重新读取队列和设置状态，并通过 `aria-live` 宣布结果。

进程崩溃后从同一 journal 继续，不创建第二个 purgeId。删除失败时 journal 保留、命中数据继续隐藏、设置页显示可重试错误；不得返回成功或重新显示部分数据。

### 6.4 点时间与竞态

- WorkItem 以 `createdAt <= hideBefore` 判断旧数据；后续 revision 更新不改变其归属；
- Lineage 以第一条 revision 的 `committedAt <= hideBefore` 判断旧数据；
- confirm 写 journal 后，所有 WorkItem Store 查询与 scheduler claim 必须共用同一 visibility predicate，不能只在 Web DTO 过滤；
- 已开始的非发布 Analysis 若晚于 hide fence 提交，只能写回原 WorkItem，随后仍被 saga 删除；删除后的 update 必须失败，不能重建记录；
- journal 完成后，create/update/claim/query 必须从 durable completed fences 重建相同 predicate；缓存可有，但不得成为权威；
- USER Purge 仍在 preview 中保留旧 provisional WorkItem；若它在完成后才被判定为 USER，durable USER fence 拒绝该提交；若被判定为 PROJECT，则继续允许；
- PROJECT Purge 后，旧 Session gap 重放产生且 `createdAt <= hideBefore` 的匹配 WorkItem 必须被 durable PROJECT fence 拒绝；
- 新创建且 `createdAt > hideBefore` 的匹配数据可正常存在，不属于本次 Purge。

## 7. Storage 与迁移

### 7.1 Alpha schema 冻结

Purge 只在现有 `run2skill_v1` domain 的 global 增加可选 active journal 和可选 completed fences，不新建数据库、文件、表或第二个 domain。completed fences 是向后兼容的可选字段扩展，因此 domain version 保持不变；现有 `work_items` 和 `lineages` 仍是业务数据真相。

Slice D 验收时记录并冻结：

- domain 名与 domain version；
- Global、WorkItem、Lineage 的 schema version；
- 当前 DSH baseline；
- JSON 主路径与 SQLite 对照路径的 open/restart 行为。

首个公开 Alpha 之后：

- 同一 domain version 只允许旧 reader 可接受的可选字段扩展；
- 不兼容数据必须 fail loud，并停用 run2skill 功能，不影响 DSH 主 Agent；
- 禁止自动删除、自动重建或把 schema mismatch 当作空库；
- domain version bump 必须先有独立 Migration ADR、备份、回退和跨版本安装测试。

### 7.2 公开前开发数据

当前尚未公开的开发数据不承诺兼容。若实现需要不兼容变更，只允许在发布前明确记录一次“导出后重建”，并通过 candidate fixture 验证；该做法不得进入已发布用户升级路径。

### 7.3 Known limitation：PROJECT fence 容量与未来 retention

PROJECT completed fences 固定最多 1024 个。达到上限后，已有 scope 仍可把 fence upsert 到更大的 `hideBefore`；新的不同 PROJECT 在 preview 和 confirm 写 journal 前均 fail closed，返回非破坏性的 `PURGE_FENCE_LIMIT`。v0.1 不淘汰旧 fence，因为淘汰会让旧派生数据在 Session gap、迟到写或重启后复活。

任何未来 retention/compaction 都必须先证明对应 Session gap 与迟到 mutation 已不可重放，并以独立 Design/迁移门交付；D2 不实现自动淘汰、History、Retention 或 migration framework。

## 8. Web 产品收口

### 8.1 原生设置页

Client 在 DSH 的 Plugins Settings 区域为 namespace `run2skill` 注册一个插件卡片，包含：

- Automatic Learning 开关与 ON/OFF 语义；
- `inherit-session` 只读说明，不提供模型选择器；
- 当前 PROJECT Purge；
- USER scope Purge；
- 当前 purge phase、失败和重试状态。

开关直接使用 DSH Settings scope；Purge 使用 run2skill 自有严格 RPC。两者不复制到 Proposal Inbox。

### 8.2 Proposal Inbox

Inbox 继续只显示当前 PROJECT Proposal 与 USER Proposal，继续是 Action Queue 而非 History。Slice D 只做以下收口：

- 统一 Header、列表和详情的状态文案，解决同一事实不同称呼；
- UNKNOWN、RECOVERING、DEGRADED、INCOMPATIBLE、PUBLISHING 和失败重试均有明确文案；
- 保留安全视图/原始视图、完整 bytes、Evidence、Diff 和绑定事实；
- 后台 summary 与关闭 Inbox 使用 10 秒轮询，打开 Inbox 使用 2 秒轮询；页面隐藏时暂停非必要轮询，恢复可见时立即刷新；
- 所有 mutation single-flight，重复点击无第二次效果；
- 键盘、可见 focus、focus trap、Escape、关闭后焦点恢复、accessible name、`aria-live` 全部由浏览器集成测试覆盖。

不增加搜索、筛选、分页历史、批量操作或视觉设计系统重构。

## 9. RPC

沿用 `/run2skill` loopback、Host/Origin fence 和 v1 envelope。新增：

| 方法 | 请求 | 成功响应 |
|---|---|---|
| `purge/preview` | `scope: PROJECT \| USER` + 当前 workspace identity | immutable preview |
| `purge/confirm` | `previewId + digest` | completed / in-progress receipt |
| `purge/status` | 无 | active journal 的裁剪状态或 idle |
| `purge/retry` | `purgeId` | in-progress receipt |

Automatic Learning 不增加 run2skill 私有 settings RPC；Client 复用 DSH 原生 `settings.describe/update/mutate` 及 `expectedRevision`。所有 run2skill RPC 请求、响应和错误仍由 Host/Client 两端严格 schema 解析。

新增稳定错误至少包括：

```text
PURGE_PREVIEW_STALE
PURGE_BUSY
PURGE_ALREADY_RUNNING
PURGE_SCOPE_UNAVAILABLE
PURGE_STORAGE_UNAVAILABLE
PURGE_INCOMPATIBLE
PURGE_FENCE_LIMIT
```

错误 DTO 不返回本机绝对路径、Evidence 内容或后端异常堆栈。

## 10. 生命周期与打包

### 10.1 公开包

仍保持一个 package、两个入口：Host 根导出与 `./client`。发布候选必须验证：

- `dsh.bundle.patch` 与 `dsh.client` metadata 正确；
- tarball 只包含运行必需文件、LICENSE 和公开文档，不含开发期临时产物、机器相关路径、凭据、私有材料或 DSH 源码；
- peer/runtime 依赖和兼容 DSH baseline 明确；
- README 提供从 GitHub clone/build/install 的最短路径，以及 disable/upgrade/uninstall；
- 卸载后已发布 Skill 继续被 stock DSH 发现和使用；run2skill 自有数据默认保留，用户若要删除须卸载前主动 Purge；
- upgrade 不静默迁移或清除不兼容数据。

### 10.2 发布授权边界

实现 Issue 可以准备候选版本号、包元数据、tarball、校验和安装证据。创建 tag、GitHub Release 或 npm publish 属于最终外部发布步骤，在执行前取得单独授权。

## 11. 验证

### 11.1 必要自动化

- Settings default、热更新、stale revision、OFF 普通 trigger、OFF 显式保存、queued pause/resume、in-flight snapshot；
- PROJECT/USER scope truth table、无法证明作用域、hideBefore 边界；
- preview stale、双 confirm、并发 confirm、PUBLISHING busy；
- purge crash 在每个 durable phase 的恢复、删除失败后保持隐藏、restart 后继续、最终 journal 清除；
- completed fence 与 journal 清除的原子转换、restart/old gap、USER provisional 晚分类、same-scope upsert、`hideBefore` 后新数据；
- PROJECT fence 1024 exact limit、已有 scope 更新与新 scope `PURGE_FENCE_LIMIT` fail-closed；
- scheduler/query/detail/summary 均应用同一 visibility predicate；
- DSH Session Log 与已发布 Skill 在 Purge 前后 exact bytes 不变；
- Settings 卡片与 Purge 对话框的键盘、focus、screen reader status；
- package allowlist、secret scan、clone/build/add/disable/upgrade/uninstall；
- JSON 主路径、SQLite 对照、schema mismatch fail-loud。

### 11.2 稳定 HEAD 真实 DSH 探针

只在相关实现稳定后运行：

1. stock web profile 中出现 run2skill 原生设置卡片；
2. OFF 时普通对话不产生学习，显式“保存为 Skill”仍进入 Inbox；
3. PROJECT Purge 后对应 Inbox/数据消失，但 Session Log 与已发布 Skill 保留；
4. USER Purge 不误删 PROJECT 数据；
5. restart 中断的 Purge 可恢复；
6. add/disable/upgrade/uninstall 后 stock DSH 仍可启动；
7. 切片 C 四个黄金场景回归不变。

真实模型仅用于最终补充探针，并只使用运行环境显式配置的 Provider 凭据；凭据不得进入源码、fixture、日志或发布产物。主要验收必须由 keyless fixture 和可复现 DSH 组合探针完成。

## 12. Issue 切分建议

Design 获批后按以下五个 Issue 顺序执行；不一次性并行修改同一 Host/Client 装配面：

1. **D1 Settings 与 activation policy**：namespace、设置卡片、OFF/ON 调度语义和冲突处理；不做 Purge。
2. **D2 Purge durable core**：scope matcher、preview、journal、visibility、saga、crash recovery 和 Host RPC；先完成 keyless/Storage 验证，不做视觉扩展。
3. **D3 Purge UI 与 Inbox/a11y 收口**：向 D1 的设置卡片加入二次确认和 Purge 状态/重试，同时收口 Inbox 状态文案与浏览器可访问性；不改学习或发布状态机。
4. **D4 Schema freeze 与安装产品化**：freeze 记录、公开 README、package allowlist、clone/build/add/disable/upgrade/uninstall；不执行外部 release。
5. **D5 v0.1 Alpha release candidate 验收**：完整单元门、必要 crash/compatibility matrix、真实 DSH 组合、四黄金场景回归和公开内容审计；输出发布建议，不自动 tag/publish。

每个 Issue 完成后再开启下一个。D1–D4 只跑直接相关的真实 DSH probe；重型全矩阵集中在 D5，避免为每次小修重复消耗。

## 13. Slice D 完成条件

只有同时满足以下条件，Slice D 才可验收：

1. Automatic Learning 的 ON/OFF、显式保存例外和 analysis snapshot 有自动化与真实 DSH 证据；
2. PROJECT/USER Purge 在成功、失败、崩溃和 restart 后都满足“正常界面不可见，Session/Skill 不删除”；
3. Inbox 与 Purge 的关键键盘和 screen-reader 行为通过；
4. schema freeze 与未来 migration 门写入公开文档，incompatible 数据不会静默清除；
5. source clone、build、pack、add、disable、upgrade、uninstall 通过；
6. 切片 C 四个黄金场景未回归；
7. 公开仓库内容审计无本机路径、凭据、私有材料或 DSH 源码；
8. D5 的 CI、必要探针和 exact-HEAD 审查无阻塞 finding。

完成 Slice D 只表示代码达到 `v0.1.0-alpha` 发布候选标准。真正创建外部 Release 或发布包仍是单独、显式授权的动作。
