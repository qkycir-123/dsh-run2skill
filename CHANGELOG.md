# 版本变化

## 0.1.0-alpha — 2026-08-21

首个公开 Alpha。

### 主要能力

- 从用户明确表达的纠正、长期约束、可复用工作流和“保存为 Skill”请求中发现学习信号。
- 只把过滤、截断和敏感信息清理后的有限上下文交给当前 DSH Session 的 provider/model 分析。
- 在 Web 的 Skill Proposal Inbox 中展示待审核提案、范围和差异，由用户批准、拒绝或重试。
- 将批准结果安全发布为 DSH 原生 `PROJECT` 或 `USER` Skill，并在并发变化、观察不完整或目标不确定时停止写入。
- 提供 Automatic Learning 设置，以及带预览、二次确认和崩溃恢复的 `PROJECT` / `USER` Purge。
- 禁用或卸载插件后，已经发布的原生 Skill 继续保留并可由 DSH 使用。

### 兼容性

- 已验证 DSH `0.1.0-rc.7`（`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`）。
- 已验证 DSH `0.1.0-rc.8`（`141eb6fef83422698aef7a981029e843e8161534`）。
- 当前只支持 `web` profile、内置 `standard` / `code` preset 和默认 filesystem Skill roots。

### Alpha 限制

- 这是测试版本，持久化格式变化仍可能需要明确的迁移步骤。
- Proposal Inbox 是待处理队列，不是完整历史或通用知识库。
- 不支持自定义 Skill provider、关闭默认 roots 的组合或其他 DSH profile。
- 自动学习需要当前 Session 存在可用 provider/model；插件不会配置、保存或替换 Provider 凭据。
- 卸载默认保留 run2skill 数据；需要删除时应先在 Settings 中执行 Purge。

安装与使用方法见 [README](README.md)，详细兼容性见 [DSH 兼容性](docs/compatibility.md)。
