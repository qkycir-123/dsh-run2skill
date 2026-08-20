# v0.1 Storage Schema 与升级兼容性

状态：`0.1.0-alpha` 冻结契约
冻结日期：2026-08-21
DSH baseline：`0.1.0-rc.7` / `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`

## 1. 冻结值

首个公开 Alpha 的 durable storage identity 固定为：

| 契约 | 冻结值 |
|---|---|
| npm package version | `0.1.0-alpha` |
| Storage Domain name | `run2skill_v1` |
| Storage Domain version | `2` |
| Global record schema | `GlobalV1`, `schemaVersion: 1` |
| WorkItem record schema | `CaptureWorkItemV1`, `schemaVersion: 1` |
| Lineage record schema | `LineageV1`, `schemaVersion: 1` |
| 业务表 | `work_items`, `lineages` |
| global record | 单个 GlobalV1；不新增第二个 domain |

运行时权威常量是 `RUN2SKILL_ALPHA_SCHEMA_CONTRACT`，位于 `src/adapters/dsh-storage/domain.ts`。`run2skillDomainSpec` 必须从该常量取得 domain name/version；测试锁定上述值以及三类记录对错误 `schemaVersion` 的拒绝行为。

Domain version 为 `2` 是公开 Alpha 前一次明确的开发数据断点：旧的 candidate-root approval 数据不会在 stock root-contract schema 下打开。它不是第二代公开格式，也不表示存在 v1→v2 通用迁移器。`0.1.0-alpha` 是公开兼容承诺的起点。

## 2. Durable 数据面

`global` 保存 schema/policy version、Session lifecycle checkpoint、recovery cursor、健康计数，以及可选的 active Purge journal 和 completed Purge fences。

`work_items` 保存过滤后的 capture evidence、Learning、immutable Proposal、Review Decision、Publication Outcome、usage 和 Publication Journal。它是 Proposal/Review/Publication saga 的权威聚合，不复制 Whole Session。

`lineages` 保存当前 managed target 的完整 Revision snapshots。磁盘上被 DSH 发现的 `SKILL.md` 始终优先于 Lineage；Purge Lineage 或卸载插件不会删除已发布 Skill。

Global、WorkItem 和 Lineage 均使用 strict、版本化 schema。未知字段、错误类型、非法枚举、坏 digest、越界数组或不满足状态不变量的数据不得被解释为空记录。

## 3. Open、restart 与 backend

run2skill 只通过 DSH `ctx.storage.domain.open(run2skillDomainSpec)` 打开数据，不直接读写 JSON/SQLite 文件，也不创建旁路数据库。

- DSH `web` profile 的 JSON Storage 是主路径；
- SQLite 是 backend 可移植性对照路径；
- 两条路径使用相同 domain/version 和记录 schema；
- clean close/restart 后必须恢复 exact durable Global、WorkItem 和 Lineage；
- backend unavailable、domain version mismatch 或 record schema mismatch 都是兼容性失败，不是“空库”。

Host 打不开或解析不了 durable domain 时，run2skill 进入 `DEGRADED` / `INCOMPATIBLE`，停止学习、审核 mutation 和发布，不注册会写数据的运行时能力；DSH 主 Agent 保持 fail open。原 storage 保留，不自动删除、不自动重建，也不把 mismatch 伪装成首次启动。

## 4. `0.1.x` 兼容规则

同一 domain version 只允许旧 reader 已经能接受并能在 read-modify-write 后安全保留的变化。当前 Alpha reader 已声明的 optional 字段可以缺省或出现，例如 `purgeJournal` 与 `completedPurgeFences`；这类记录仍由同一 schema 解释。

当前顶层记录使用 strict schema，因此“新增一个旧 reader 不认识的可选字段”并不会自动兼容。除非先证明已发布旧 reader 能接受并无损保留该字段，否则它属于破坏性变化，不能在 domain version `2` 下静默落盘。

以下变化均视为破坏性：

- 删除、重命名或改变既有字段语义/类型；
- 改变枚举、digest、identity、排序、状态机或 required/optional 语义，使旧 reader 拒绝或误解数据；
- 改变 domain name/version、table key 或把现有记录移动到另一介质；
- 让旧 reader 在 read-modify-write 时丢失新事实；
- 把 mismatch 当空库、自动清理或自动重建。

破坏性变化必须先有独立 Migration ADR 和 Issue，并同时提供：

1. 源格式与目标格式的精确版本矩阵；
2. 迁移前备份和可验证回退；
3. 中断/崩溃恢复与幂等重试设计；
4. JSON 主路径和 SQLite 对照路径的跨版本安装测试；
5. downgrade 行为与旧 reader 的 fail-closed 证据；
6. 用户可读升级说明。

v0.1 不建立通用 migration framework，也不提供自动清库、导出 UI 或 rollback UI。

## 5. 升级、降级与卸载

- **兼容升级**：停止 Web profile，备份有效 DSH Home，安装新 tarball，重启并确认 run2skill 不处于 DEGRADED/INCOMPATIBLE；数据和已发布 Skill 必须保留。
- **不兼容升级**：没有对应 Migration ADR/Issue、备份和回退说明时不得继续；恢复旧插件版本。
- **降级**：旧 reader 若不能证明接受当前 durable facts，必须 fail closed；不得通过删除 storage 强行启动。
- **卸载**：默认保留 `run2skill_v1` 数据与所有已发布 Skill。要删除 run2skill 派生数据，先在仍安装插件时执行 PROJECT/USER Purge。

公开前的历史开发数据可按当时明确记录执行一次导出后重建；该例外不适用于 `0.1.0-alpha` 及之后的用户数据。
