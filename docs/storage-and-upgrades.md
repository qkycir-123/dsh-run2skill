# 数据存储与升级

这份文档说明当前 `dsh-run2skill@0.2.0` 开发线及 #84 批次学习重构会保存什么，以及升级、降级和卸载时应该注意什么。

## 保存的数据

run2skill 使用 DSH 自带的 Storage Domain，不创建旁路数据库，也不直接操作 DSH 的 JSON 或 SQLite 文件。

它会保存：

- 经过筛选和敏感信息清理的有限学习材料；
- 等待分析、审核或恢复的工作状态；
- 技能草稿、审核结果和保存结果；
- 已发布 Skill 的版本关联信息；
- 数据清理的恢复进度和已完成边界。

它不会把完整 Session 复制进自己的 Storage，也不会保存 Provider 密钥。已经发布的 `SKILL.md` 属于 DSH 原生 Skill，不是 run2skill Storage 的一部分。

## 当前格式与 #84 目标格式

当前 `0.2.0` 开发线使用：

| 项目 | 值 |
|---|---|
| npm 版本 | `0.2.0`（待发布） |
| 主 Storage Domain | `run2skill_v1` |
| 主 Domain version | `2` |
| Global / WorkItem / Lineage schema | `schemaVersion: 1` |
| 终止诊断 sidecar | `run2skill_learning_diagnostics_v1`，Domain version `1` |

从已发布的 `0.1.1-alpha` 进入 `0.2.0` 不修改主 Domain、WorkItem schema 或诊断 sidecar，现有数据无需迁移。

#84 完成后，新的 SessionBatch 学习主链改用独立 `run2skill_v2` Domain version `1`，而不是原地修改 `run2skill_v1`：

| v2 单元 | 内容 |
|---|---|
| global | schema/policy、Session cursor、行为签名 single-flight、全局 Proposal generation lease、Proposal catalog epoch/mutation journal、migration journal、Purge fences |
| turn_observations | 脱敏、限长的最小 Turn 观察 |
| session_batches | 冻结范围、检测结果和阶段调用账本 |
| experience_intents | 行为签名、证据 digests、所有权、召回、coverage 和 generation 状态 |
| proposal_lineages | 唯一活动 lineage、Proposal、审核/发布关联 |
| legacy_items | v1 pending/Proposal 的兼容处置，不重新自动学习 |

完整决策和状态机见 [`docs/design/issue-84-session-batch-learning.md`](design/issue-84-session-batch-learning.md)。在该 Design 的实现 PR 合并并通过迁移测试前，以上 v2 格式只是目标契约，不是当前发布包已经启用的事实。

如果存储格式不匹配，插件会显示“当前功能受限”或“当前版本不兼容”（内部状态码：`DEGRADED` / `INCOMPATIBLE`）并停止写入，而不是把旧数据误认为空库。DSH 主 Agent 仍可继续工作，原数据不会被自动删除或重建。

## 更新或降级

后续版本仍可能出现需要明确迁移步骤的格式变化。进入 `run2skill_v2` 前建议：

1. 停止 DSH Web。
2. 备份当前有效的 DSH Home。
3. 安装一个明确版本，而不是依赖未知的未来版本。
4. 重启后确认 run2skill 没有显示“当前功能受限”或“当前版本不兼容”。

如果新版本的发布说明没有给出对应迁移与回退办法，请不要用删除 Storage 的方式强行升级。恢复到原插件版本，并在 GitHub Issue 中报告情况。

v2 迁移采用 copy/validate/commit journal：迁移提交前只读 v1，v2 部分数据不可见；提交后新观察只写 v2，v1 保留为只读 legacy source。v1 的 Lineage、Purge fences 和所有 active Proposal 必须经 digest/identity 校验后导入；`PendingProposalCatalog` 每次从 v2/legacy authoritative active Proposal rows、已密封但尚未复制为 Proposal 的 GenerationResult 和 unresolved generation barriers 派生 complete snapshot，不另存可漂移缓存，active legacy Proposal 作为不可写候选参与每个新 Intent 的查重。v1 每个 schema-valid processingState 都有穷尽映射；尚未形成 Proposal 的旧项进入可见的 legacy 待处理状态，不按新策略静默重放。

降级同样可能遇到新数据无法被旧版本理解的情况。`0.1.0-alpha` 会忽略 `0.1.1-alpha` 新增的独立诊断 sidecar，不会改写它；但旧版本的数据清理也不会清理该 sidecar。需要完全清除派生数据时，请先在当前版本中完成数据清理，再降级或卸载。

v2 migration journal 提交前可直接回到旧版本，因为 v1 未被改写。提交后禁止在同一 DSH Home 上启动不支持 v2 的旧插件：旧版不理解 v2 Purge fences，也可能重新处理 v1，“启动后再关闭自动学习”仍不安全。COMMITTED 后只能前向修复继续使用支持 v2 的版本，或先停止 DSH、恢复迁移前的完整 DSH Home 备份，再安装旧版本；后者明确回到备份时点，不保留迁移后的清理或新学习事实。

## 数据清理与卸载

设置页中的“清理所有缓存”会删除本机全部 Run2Skill 派生中间数据。Purge visibility 同时覆盖 v1 legacy 视图、独立诊断 sidecar、v2 所有派生表、行为签名索引、全局 Proposal generation lease 和 migration copy；完成前必须证明已清 Proposal 不再出现且没有 dangling index/lease。它不会删除 DSH 的原始会话记录、已发布的原生 Skill、Provider/Agent 设置或其他 DSH 设置。

卸载插件默认保留 `run2skill_v1`、已启用时的 `run2skill_v2`、`run2skill_learning_diagnostics_v1` 数据和所有已发布 Skill。如果你希望删除 Run2Skill 派生数据，请在插件仍然安装时先执行数据清理，再卸载：

```bash
dsh plugin --profile web remove dsh-run2skill
```

不要直接手工删除 DSH 存储文件来代替设置页中的数据清理。
