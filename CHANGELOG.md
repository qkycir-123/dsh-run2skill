# 版本变化

## 未发布 — `main`

下一个版本为 `0.4.0`，面向官方 DSH `0.1.2-rc.1`（`a66e4702047846cdaa10c66c9d3df3951f5ea70d`），尚未发布。

- 用两条严格的 DSH Remote/API Gateway 方法 `run2skill/query` 和 `run2skill/command`，替换上游已删除的私有 `ApiProxy` / `dsh-client-runtime` 通道。
- Host 与 Client 共享请求/响应 codec，查询与命令分路，并增加取消和 fail-closed 错误映射。
- 适配 RC1 的 Session 快照、JSONL Session 持久化、认证 Web 启动、Client 组合包、Settings、Storage/Profile 与 Skill Registry 契约。
- 将 stock Skill root baseline 提升到 RC1，并把内置 preset 支持收敛为 `standard`；上游已删除旧 `code` preset。
- `0.3.1` 继续作为 DSH `0.1.1-rc.2` 的维护线；本次兼容改造不增加数据迁移或新产品行为。

## 0.3.1 — 2026-08-28

`0.3.1` 把 `v0.3.0` 之后已经在真实 DSH Web 验证的整理、草稿修订和长证据能力发布为稳定包。

### 变化

- 修复真实 Skill 草稿生成、MERGE 与完整 Catalog/发布事实的绑定，并调整 CREATE 默认使用简体中文、MERGE 保持原 Skill 的主要语言（[#134](https://github.com/qkycir-123/dsh-run2skill/pull/134)、[#139](https://github.com/qkycir-123/dsh-run2skill/pull/139)）。
- 插件关闭时主动取消在途模型调用并限制等待，不让未响应的模型流拖住停机（[#140](https://github.com/qkycir-123/dsh-run2skill/pull/140)）。
- 在设置页增加低噪声的学习阶段说明和“立即整理本次经验”入口；它不会展示内部批次计数，且仍须经过会话静止、查重、审核与发布安全门（[#145](https://github.com/qkycir-123/dsh-run2skill/pull/145)）。
- 长工作流证据改用 TurnObservation 与 Detector batch 两层共享预算，优先保留显式保存、禁止项、验收条件、顺序步骤、约束和最新尾部；真实 system prompt 与序列化 user envelope 仍受严格总预算约束（[#146](https://github.com/qkycir-123/dsh-run2skill/pull/146)）。
- 待审核草稿可接收一条有界修改意见并生成新的不可变 revision；旧草稿和旧批准立即失效，新版本必须重新审核，不提供自由编辑或自动发布（[#147](https://github.com/qkycir-123/dsh-run2skill/pull/147)）。
- 修复长证据投影到旧版详情契约时超过单条 512-byte 上限、导致整个草稿详情不可用的问题；只压缩 UI 展示副本，不修改 durable evidence（[#150](https://github.com/qkycir-123/dsh-run2skill/pull/150)）。

### 兼容性与数据

- 继续只支持 DSH Web `0.1.1-rc.2`（`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`），没有扩大 provider、profile 或自定义 roots 范围。
- `run2skill_v2` 继续使用 Domain version `1`；`0.3.1` 新字段均为 additive/defaulted，升级会保留已有状态和已发布原生 Skill。
- 已验证 `0.1.1-alpha → 0.2.0 → 0.3.0 → 0.3.1` 升级链和候选版卸载保留边界。

发布说明：[`dsh-run2skill 0.3.1`](https://github.com/qkycir-123/dsh-run2skill/releases/tag/v0.3.1)。

## 0.3.0 — 2026-08-24

`0.3.0` 聚焦真实 DSH Web 草稿与审核流程、首次使用体验和 DSH `0.1.1-rc.2` 适配。

### 变化

- 修复真实 DSH Web 会话的草稿生成，以及 Proposal 审核与过期刷新生命周期。
- 优化首次使用文案、技能草稿说明、状态展示和“需要处理”面板布局。
- 重新录制完整流程 GIF 和三张关键界面截图。

### 兼容性与数据

- 只支持 DSH Web `0.1.1-rc.2`（`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`）；完整契约、原生 UI、存储、发布和真实安装生命周期已通过验证。
- 已验证 `0.1.1-alpha → 0.2.0 → 0.3.0` 升级、数据与已发布原生 Skill 保留，以及卸载流程。
- 从 `0.2.0` 升级不改变 `run2skill_v2` Storage Domain 或 schema version。

发布说明：[`dsh-run2skill 0.3.0`](https://github.com/qkycir-123/dsh-run2skill/releases/tag/v0.3.0)。本条目不包含 `v0.3.0` tag 之后的未发布修复。

## 0.2.0 — 2026-08-23

run2skill 结束 Alpha 版本标记，发布首个稳定版 `0.2.0`。

### 变化

- 用户可见文案统一使用“技能草稿”，不再把内部 `Proposal` 术语直接暴露给首次使用者。
- README 和设置页用“数据清理”、“当前功能受限”等直观说法解释内部操作与状态码。
- 新增英文 README、真实 DSH Web 流程 GIF 和关键截图。
- npm 包增加生态搜索关键词，并随包提供中英文 README。
- 从 Alpha 升级时不迁移旧 `run2skill_v1` 中间缓存；已经发布的原生 Skill 不受影响。
- npm 发布标签恢复为 `latest`。

## 0.1.1-alpha — 2026-08-21

第二个公开 Alpha，集中修复首次试用暴露的学习恢复和 Web 交互问题。

### 变化

- 区分模型截断、流中止、缺失 usage/finish、组装失败和异常终止，并补齐有界重试、崩溃恢复、人工重试与忽略闭环。
- 默认不再在 Session Header 常驻显示 run2skill 状态；只有需要人工处理时使用 DSH 原生 Toast，持久信息统一进入 **Settings → Plugins → run2skill**。
- 技能草稿、学习失败恢复、自动学习和数据清理改用 DSH 公共组件与主题，并补齐 Modal 焦点、键盘操作、HMR 和隐藏页面轮询管理。
- 技能草稿/学习队列改由 Host 权威授权和分页，拒绝跨 Workspace、过期 action/cursor 与越权 detail/mutation。
- 浏览器 DTO 不再发送绝对 Workspace、DSH Home、Skill root 或候选目标路径。
- 安装生命周期与 Web 探针强制使用 `headless + --no-open`，不再弹出系统浏览器。

### 兼容性与数据

- 继续支持 DSH `0.1.0-rc.7` 与 `0.1.0-rc.8`，两版完整合同和真实安装/Web 生命周期均已通过。
- 主 `run2skill_v1` Domain version 与 WorkItem schema 保持不变，现有 `0.1.0-alpha` 数据无需迁移。
- 新增独立 `run2skill_learning_diagnostics_v1` sidecar，只保存无正文、无路径的终止诊断；数据清理会同时清理主域和 sidecar，并在 sidecar 不可验证时安全停止。

## 0.1.0-alpha — 2026-08-21

首个公开 Alpha。

### 主要能力

- 从用户明确表达的纠正、长期约束、可复用工作流和“保存为 Skill”请求中发现学习信号。
- 只把过滤、截断和敏感信息清理后的有限上下文交给当前 DSH Session 的 provider/model 分析。
- 在 Web 的技能草稿列表中展示待审核的技能草稿、范围和差异，由用户确认保存、放弃或重试。
- 将批准结果安全发布为 DSH 原生 `PROJECT` 或 `USER` Skill，并在并发变化、观察不完整或目标不确定时停止写入。
- 提供自动学习设置，以及带预览、二次确认和崩溃恢复的 `PROJECT` / `USER` 数据清理。
- 禁用或卸载插件后，已经发布的原生 Skill 继续保留并可由 DSH 使用。

### 兼容性

- 已验证 DSH `0.1.0-rc.7`（`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`）。
- 已验证 DSH `0.1.0-rc.8`（`141eb6fef83422698aef7a981029e843e8161534`）。
- 当前只支持 `web` profile、内置 `standard` / `code` preset 和默认 filesystem Skill roots。

### Alpha 限制

- 这是测试版本，持久化格式变化仍可能需要明确的迁移步骤。
- 技能草稿列表是待处理队列，不是完整历史或通用知识库。
- 不支持自定义 Skill provider、关闭默认 roots 的组合或其他 DSH profile。
- 自动学习需要当前 Session 存在可用 provider/model；插件不会配置、保存或替换 Provider 凭据。
- 卸载默认保留 run2skill 数据；需要删除时应先在设置页中执行数据清理。

安装与使用方法见 [README](README.md)，详细兼容性见 [DSH 兼容性](docs/compatibility.md)。
