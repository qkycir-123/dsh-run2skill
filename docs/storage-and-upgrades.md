# 数据存储与升级

这份文档说明 `dsh-run2skill@0.2.0` 会保存什么，以及升级、降级和卸载时应该注意什么。

## 保存的数据

run2skill 使用 DSH 自带的 Storage Domain，不创建旁路数据库，也不直接操作 DSH 的 JSON 或 SQLite 文件。

它会保存：

- 经过筛选和敏感信息清理的有限学习材料；
- 等待分析、审核或恢复的工作状态；
- 技能草稿、审核结果和保存结果；
- 已发布 Skill 的版本关联信息；
- 数据清理的恢复进度和已完成边界。

它不会把完整 Session 复制进自己的 Storage，也不会保存 Provider 密钥。已经发布的 `SKILL.md` 属于 DSH 原生 Skill，不是 run2skill Storage 的一部分。

## 当前格式

当前 `0.2.0` 开发线使用：

| 项目 | 值 |
|---|---|
| npm 版本 | `0.2.0`（待发布） |
| 主 Storage Domain | `run2skill_v1` |
| 主 Domain version | `2` |
| Global / WorkItem / Lineage schema | `schemaVersion: 1` |
| 终止诊断 sidecar | `run2skill_learning_diagnostics_v1`，Domain version `1` |

从已发布的 `0.1.1-alpha` 进入 `0.2.0` 不修改主 Domain、WorkItem schema 或诊断 sidecar，现有数据无需迁移。

如果存储格式不匹配，插件会显示“当前功能受限”或“当前版本不兼容”（内部状态码：`DEGRADED` / `INCOMPATIBLE`）并停止写入，而不是把旧数据误认为空库。DSH 主 Agent 仍可继续工作，原数据不会被自动删除或重建。

## 更新或降级

后续版本仍可能出现需要明确迁移步骤的格式变化。更新前建议：

1. 停止 DSH Web。
2. 备份当前有效的 DSH Home。
3. 安装一个明确版本，而不是依赖未知的未来版本。
4. 重启后确认 run2skill 没有显示“当前功能受限”或“当前版本不兼容”。

如果新版本的发布说明没有给出对应迁移与回退办法，请不要用删除 Storage 的方式强行升级。恢复到原插件版本，并在 GitHub Issue 中报告情况。

降级同样可能遇到新数据无法被旧版本理解的情况。`0.1.0-alpha` 会忽略 `0.1.1-alpha` 新增的独立诊断 sidecar，不会改写它；但旧版本的数据清理也不会清理该 sidecar。需要完全清除派生数据时，请先在当前版本中完成数据清理，再降级或卸载。

## 数据清理与卸载

设置页中的当前项目（`PROJECT`）/当前用户（`USER`）数据清理会删除对应范围内 run2skill 的派生数据。它不会删除 DSH 的原始会话记录、已发布的原生 Skill，或无法证明属于所选范围的数据。

卸载插件默认保留 `run2skill_v1`、`run2skill_learning_diagnostics_v1` 数据和所有已发布 Skill。如果你希望删除 run2skill 派生数据，请在插件仍然安装时先执行数据清理，再卸载：

```bash
dsh plugin --profile web remove dsh-run2skill
```

不要直接手工删除 DSH 存储文件来代替设置页中的数据清理。
