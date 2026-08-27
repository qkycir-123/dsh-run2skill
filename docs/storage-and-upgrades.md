# 数据存储与升级

这份文档说明当前 [`dsh-run2skill@0.3.1`](https://github.com/qkycir-123/dsh-run2skill/releases/tag/v0.3.1) 稳定版中由 #84 落地的批次学习流程会保存什么，以及升级、降级和卸载时应该注意什么。

## 保存的数据

run2skill 使用 DSH 自带的 Storage Domain，不创建旁路数据库，也不直接操作 DSH 的 JSON 或 SQLite 文件。

它会保存：

- 经过筛选和敏感信息清理的有限学习材料；
- 等待分析、审核或恢复的工作状态；
- 技能草稿、审核结果和保存结果；
- 已发布 Skill 的版本关联信息；
- 最近 7 天成功创建或更新 Skill 所需的最小活动元数据；
- 数据清理的恢复进度和已完成边界。

它不会把完整 Session 复制进自己的 Storage，也不会保存 Provider 密钥。已经发布的 `SKILL.md` 属于 DSH 原生 Skill，不是 run2skill Storage 的一部分。

## 当前格式

从 `0.2.0` 起，run2skill 使用独立的 `run2skill_v2` Domain version `1`：

| v2 单元 | 内容 |
|---|---|
| global | schema/policy、Session cursor、行为签名 single-flight、全局 Proposal generation lease、Proposal catalog epoch/mutation journal、启用收据和 Purge journal |
| turn_observations | 脱敏、限长的最小 Turn 观察 |
| session_batches | 冻结范围、检测结果和阶段调用账本 |
| experience_intents | 行为签名、证据 digests、所有权、召回、coverage 和 generation 状态 |
| proposal_lineages | 唯一活动 lineage、Proposal、审核/发布关联 |
| legacy_items | 当前首次启用和正常流程均不写入的保留表 |

完整决策和状态机见 [SessionBatch 批次学习设计](design/issue-84-session-batch-learning.md)。Host 只打开 v2 Domain；旧 v1 中间缓存不参与正常读取、学习、展示或清理。

### `0.3.1` 的增量

`0.3.1` 仍使用 `run2skill_v2` Domain version `1`，没有增加 table。相对 `0.3.0` 新增的 additive/defaulted 字段包括：

- Session cursor 的可选 `manualSynthesisRequest`，只保存一次“立即整理”请求所绑定的未处理 durable 尾部；请求消费、重启恢复和新 observation 扩展均由同一 batch coordinator 对账。
- `proposal_lineages` 的 `revisionActions` 和完整 child Proposal snapshots，用于绑定修改意见 action、父/子 immutable ref、模型调用结果与 Catalog mutation recovery；旧记录缺少 action log 时按空数组读取。
- TurnObservation 与 SessionBatch 仍只保存有界、脱敏证据，但 `0.3.1` 使用共享预算选择关键片段并让 excerpt digest 绑定回完整 Observation evidence digest；它不复制完整 Session。

这些字段已随 `0.3.1` 发布；它们兼容缺少新增字段的旧 v2 记录，不会把旧数据误认为空库。

如果存储格式不匹配，插件会显示“当前功能受限”或“当前版本不兼容”（内部状态码：`DEGRADED` / `INCOMPATIBLE`）并停止写入，而不是把旧数据误认为空库。DSH 主 Agent 仍可继续工作，原数据不会被自动删除或重建。

## 更新或降级

后续版本仍可能出现需要明确升级步骤的格式变化。升级前建议：

1. 停止 DSH Web。
2. 备份当前有效的 DSH Home。
3. 安装一个明确版本，而不是依赖未知的未来版本。
4. 重启后确认 run2skill 没有显示“当前功能受限”或“当前版本不兼容”。

如果新版本的发布说明没有给出对应迁移与回退办法，请不要用删除 Storage 的方式强行升级。恢复到原插件版本，并在 GitHub Issue 中报告情况。

从 Alpha 升级到 `0.2.0` 时，v2 首次启用采用 fresh activation：不迁移 `run2skill_v1` 的 Proposal、WorkItem、Lineage 或其他中间缓存。插件只为现有 durable root Session 保存当前完整 Turn 的末尾水位，历史 Turn 不重新学习；启用后新观察只写 v2。已发布的原生 Skill 和 DSH Session Log 不属于这些中间缓存，不会被删除或改写。

从 `0.2.0` 升级到 `0.3.0`，以及从 `0.3.0` 升级到 `0.3.1`，都不改变 Storage Domain 或 schema version；已有 v2 状态和已发布 Skill 会原样保留。

`0.3.1` 可以读取缺少新增可选/defaulted 字段的 `0.3.0` v2 记录。反向降级到 `0.3.0` 不承诺理解 `0.3.1` 已写入的新字段；降级前应恢复升级前备份。无法识别格式时插件会停止写入，已发布 Skill 和 DSH Session Log 不会被删除。

从 `0.3.1` 降级到 Alpha 会放弃 v2 的新中间缓存。已发布 Skill 和 DSH Session Log 仍会保留。

## 数据清理与卸载

设置页中的“清理所有缓存”只删除 `run2skill_v2` 中由 Run2Skill 产生的 Observation、Batch、Intent、Proposal lineage、行为签名索引和 generation lease。清理过程使用持久 journal，完成前必须证明没有可见 Proposal 或悬空 index/lease。它不打开或删除 v1 数据，也不会删除 DSH Session Log、已发布的原生 Skill、Provider/Agent 设置或其他 DSH 设置。

卸载插件默认保留 `run2skill_v1`、已启用时的 `run2skill_v2`、`run2skill_learning_diagnostics_v1` 数据和所有已发布 Skill。如果你希望删除 Run2Skill 派生数据，请在插件仍然安装时先执行数据清理，再卸载：

```bash
dsh plugin --profile web remove dsh-run2skill
```

不要直接手工删除 DSH 存储文件来代替设置页中的数据清理。
