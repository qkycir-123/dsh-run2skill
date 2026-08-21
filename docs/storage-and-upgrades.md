# 数据存储与升级

这份文档说明 `dsh-run2skill@0.1.0-alpha` 会保存什么，以及升级、降级和卸载时应该注意什么。

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

首个公开 Alpha 固定使用：

| 项目 | 值 |
|---|---|
| npm 版本 | `0.1.0-alpha` |
| Storage Domain | `run2skill_v1` |
| Domain version | `2` |
| Global / WorkItem / Lineage schema | `schemaVersion: 1` |

如果 Storage Domain 或记录格式不匹配，插件会进入 `DEGRADED` / `INCOMPATIBLE` 并停止写入，而不是把旧数据误认为空库。DSH 主 Agent 仍可继续工作，原数据不会被自动删除或重建。

## 更新或降级

Alpha 阶段仍可能出现需要明确迁移步骤的格式变化。更新前建议：

1. 停止 DSH Web。
2. 备份当前有效的 DSH Home。
3. 安装一个明确版本，而不是依赖未知的未来版本。
4. 重启后确认 run2skill 没有显示 `DEGRADED` 或 `INCOMPATIBLE`。

如果新版本的发布说明没有给出对应迁移与回退办法，请不要用删除 Storage 的方式强行升级。恢复到原插件版本，并在 GitHub Issue 中报告情况。

降级同样可能遇到新数据无法被旧版本理解的情况。旧版本应安全停止，不应清理或改写未知数据。

## Purge 与卸载

Settings 中的 `PROJECT` / `USER` Purge 会删除对应范围内 run2skill 的派生数据。它不会删除 DSH Session Log、已发布的原生 Skill，或无法证明属于所选范围的数据。

卸载插件默认保留 `run2skill_v1` 数据和所有已发布 Skill。如果你希望删除 run2skill 派生数据，请在插件仍然安装时先执行 Purge，再卸载：

```bash
dsh plugin --profile web remove dsh-run2skill
```

不要直接手工删除 DSH Storage 文件来代替 Purge。
