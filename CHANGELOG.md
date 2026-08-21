# 版本变化

## 0.1.1-alpha — 2026-08-21

第二个公开 Alpha，集中修复首次试用暴露的学习恢复和 Web 交互问题。

### 变化

- 区分模型截断、流中止、缺失 usage/finish、组装失败和异常终止，并补齐有界重试、崩溃恢复、人工重试与忽略闭环。
- 默认不再在 Session Header 常驻显示 run2skill 状态；只有需要人工处理时使用 DSH 原生 Toast，持久信息统一进入 **Settings → Plugins → run2skill**。
- Proposal、学习失败恢复、Automatic Learning 和 Purge 改用 DSH 公共组件与主题，并补齐 Modal 焦点、键盘操作、HMR 和隐藏页面轮询管理。
- Proposal/Learning 队列改由 Host 权威授权和分页，拒绝跨 Workspace、过期 action/cursor 与越权 detail/mutation。
- 浏览器 DTO 不再发送绝对 Workspace、DSH Home、Skill root 或候选目标路径。
- 安装生命周期与 Web 探针强制使用 `headless + --no-open`，不再弹出系统浏览器。

### 兼容性与数据

- 继续支持 DSH `0.1.0-rc.7` 与 `0.1.0-rc.8`，两版完整合同和真实安装/Web 生命周期均已通过。
- 主 `run2skill_v1` Domain version 与 WorkItem schema 保持不变，现有 `0.1.0-alpha` 数据无需迁移。
- 新增独立 `run2skill_learning_diagnostics_v1` sidecar，只保存无正文、无路径的终止诊断；Purge 会同时清理主域和 sidecar，并在 sidecar 不可验证时安全停止。

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
