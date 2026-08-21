# 数据存储与升级

这份文档说明 `dsh-run2skill@0.1.1-alpha` 会保存什么，以及升级、降级和卸载时应该注意什么。

## 保存的数据

run2skill 使用 DSH 自带的 Storage Domain，不创建旁路数据库，也不直接操作 DSH 的 JSON 或 SQLite 文件。

它会保存：

- 经过过滤和敏感信息清理的有限 Evidence；
- 等待分析、审核或恢复的工作状态；
- Skill Proposal、审核结果和发布结果；
- 已发布 Skill 的版本关联信息；
- Purge 的恢复进度和已完成边界。

它不会把完整 Session 复制进自己的 Storage，也不会保存 Provider 密钥。已经发布的 `SKILL.md` 属于 DSH 原生 Skill，不是 run2skill Storage 的一部分。

## Alpha 格式

当前公开 Alpha 固定使用：

| 项目 | 值 |
|---|---|
| npm 版本 | `0.1.1-alpha` |
| 主 Storage Domain | `run2skill_v1` |
| 主 Domain version | `2` |
| Global / WorkItem / Lineage schema | `schemaVersion: 1` |
| 终止诊断 sidecar | `run2skill_learning_diagnostics_v1`，Domain version `1` |

从 `0.1.0-alpha` 更新到 `0.1.1-alpha` 不修改主 Domain 或 WorkItem schema，现有数据无需迁移。新增 sidecar 只保存与 WorkItem revision/attempt/call 绑定的非敏感终止分类，不保存 Session 正文、绝对路径、Provider 凭据或模型输出。

如果 Storage Domain 或记录格式不匹配，插件会进入 `DEGRADED` / `INCOMPATIBLE` 并停止写入，而不是把旧数据误认为空库。DSH 主 Agent 仍可继续工作，原数据不会被自动删除或重建。

## 更新或降级

Alpha 阶段仍可能出现需要明确迁移步骤的格式变化。更新前建议：

1. 停止 DSH Web。
2. 备份当前有效的 DSH Home。
3. 安装一个明确版本，而不是依赖未知的未来版本。
4. 重启后确认 run2skill 没有显示 `DEGRADED` 或 `INCOMPATIBLE`。

如果新版本的发布说明没有给出对应迁移与回退办法，请不要用删除 Storage 的方式强行升级。恢复到原插件版本，并在 GitHub Issue 中报告情况。

降级同样可能遇到新数据无法被旧版本理解的情况。`0.1.0-alpha` 会忽略 `0.1.1-alpha` 新增的独立诊断 sidecar，不会改写它；但旧版本的 Purge 也不会清理该 sidecar。需要完全清除派生数据时，请先在 `0.1.1-alpha` 中完成 Purge，再降级或卸载。

## Purge 与卸载

Settings 中的 `PROJECT` / `USER` Purge 会删除对应范围内 run2skill 的派生数据。它不会删除 DSH Session Log、已发布的原生 Skill，或无法证明属于所选范围的数据。

卸载插件默认保留 `run2skill_v1`、`run2skill_learning_diagnostics_v1` 数据和所有已发布 Skill。如果你希望删除 run2skill 派生数据，请在插件仍然安装时先执行 Purge，再卸载：

```bash
dsh plugin --profile web remove dsh-run2skill
```

不要直接手工删除 DSH Storage 文件来代替 Purge。
