# dsh-run2skill 架构设计输入

状态：Architecture Baseline 已于 2026-08-19 获批；本文作为历史输入保留  
更新时间：2026-08-19

## 1. 文档目的

本文是 `Architecture Baseline` 的历史任务边界和核验清单，汇总 PRD 评审中分离出的架构问题。

本文不是架构结论，也不得提前决定 SQLite、包结构、RPC 技术或具体代码接口。正式结论写入 `docs/architecture/baseline.md`，重要且窄的取舍写入 `docs/adr/`。

## 2. 开始条件

只有以下条件同时满足，才能开始 Architecture Baseline：

- 维护者已接受 `docs/product/prd.md` 的需求冻结（Requirements Freeze）；
- `docs/product/requirements-review.md` 没有未解决的阻塞产品问题；
- `docs/architecture/dsh-compatibility.md` 的 baseline commit 可复现；
- DSH 核验使用固定 baseline commit 的干净上游 checkout，且不依赖本地 patch。

## 3. 固定输入

架构不得改变以下产品结论：

- DSH-native、Run-first、Evidence-first、Human-controlled、local-first、fail-open；
- v0.1 只学习 `CORRECTION`、`CONSTRAINT`、`WORKFLOW` 和显式保存请求；
- v0.1 只正式支持 `web` profile；
- Human Review 是发布前硬边界；
- 作用域只有 `PROJECT` 和 `USER`；
- 策展动作只有 `CREATE`、`MERGE`、`DISCARD`；
- Review Decision 与 Publication Outcome 分离；
- v0.1 模型策略固定为 `inherit-session`，不得静默跨 Provider；
- 不完整 Skill 观察不能证明 absence 或 coverage；
- Approval 绑定 immutable Proposal、工作区、root、path、Base/expected-absence；
- 发布必须通过秘密、路径、作用域、Base 和格式 Guards；
- `PUBLISHED` 必须由 DSH 完整 Registry 回读确认；
- run2skill 故障不得阻断 DSH Agent；
- 不修改 DSH 源码，不自动 Git 发布。

若技术方案无法满足这些条件，应回到需求评审，而不是在实现中弱化。

## 4. Architecture Baseline 必须包含的内容

正式架构文档至少包含：

1. 系统上下文（System Context）；
2. 构建与复用边界（Build-vs-Borrow Boundary）；
3. 领域模型（Domain Model）；
4. Host/Client 边界；
5. 模块职责；
6. 核心数据流；
7. 事件、并发与幂等模型；
8. 持久化策略；
9. LLM/Learning Pipeline；
10. Existing Skill Lookup 与 Curation；
11. Publication/Revision 事务；
12. Web RPC/UI 契约；
13. Settings 与 Model Policy；
14. 隐私与安全；
15. 故障语义与 fail-open；
16. 测试策略；
17. 候选包边界；
18. v0.1 纵向切片映射；
19. 被否决的替代方案；
20. 开放架构问题。

## 5. 构建与复用边界（Build vs Borrow）

必须画清 DSH owns 与 run2skill owns，至少覆盖：

| 能力 | 首要问题 |
|---|---|
| Session Event observation | 哪些事件和身份事实直接复用 DSH |
| LLM Runtime | 如何只通过 `ctx.llm` 调用 |
| Skill Registry/filesystem provider | 如何查询、确认完整性、写入和回读 |
| Settings | 哪些配置注册到 `ctx.settings` |
| Web extension | Client plugin、slot 和信任边界如何复用 |
| Project identity | DSH 提供什么，run2skill 还需验证什么 |
| Store | 哪些 Experience、Proposal、Revision 和审计事实由 run2skill 持有 |
| Learning Pipeline | Envelope、filter、structured result 的职责 |
| Curation | Recall、full load、语义判断和确定性校验的边界 |
| Publication | Approval、Guard、write、readback 的事务边界 |

不得复制 DSH Runtime 来获得更方便的内部状态。

## 6. Core 模块边界问题

架构必须明确回答：

- 谁订阅 `turn/end`，怎样释放订阅并处理重复通知？
- 谁判定 Root、child 和 subagent Session？
- Cheap Trigger 哪些部分完全确定性？
- 谁持久化 pending signal，怎样去重、合并和恢复？
- 谁构建 Learning Window 和 Learning Envelope？
- Sensitive Filter 在模型传输和 Store 写入前分别位于哪里？
- Learning Engine 依赖什么最小抽象？
- Existing Skill Lookup 是否为独立模块，怎样表达 `complete: false`？
- Recall、Curation Decision 和 Core Guard 分别由谁负责？
- Store 的稳定 contract、事务和 migration 边界是什么？
- Proposal Inbox 的 Host API 和 Web Client contract 是什么？
- Publication、Revision、Audit 和回读结果的原子边界是什么？
- 任何模块失败时，怎样证明 DSH Agent 仍 fail open？

模块不能只按代码目录命名，必须说明输入、输出、所有权、错误和不可变约束。

## 7. Persistence 设计问题

产品只规定 local-first、durable、cross-restart 和数据可清除。架构需要比较并决定：

- SQLite、文件或混合方案；
- active metadata 和 history 的存放位置；
- canonical project identity 怎样作为 key；
- Revision 使用 full snapshot 还是 delta；
- schema migration 和版本回退；
- atomic write、fsync、journal 和 crash consistency；
- pending、Approval、write、readback 中断后的恢复；
- retention、garbage collection 和 audit 最小化；
- PROJECT/USER Purge 的物理删除、失败恢复和备份边界。

候选方向可以是：

```text
Active Skill
→ 原生 .dsh/skills

run2skill metadata/history
→ 有效 DSH Home 下的 run2skill 专用目录
```

这只是候选，不是结论。最终路径必须避免硬编码默认 Home。

## 8. Event、并发与幂等

架构必须给出至少以下状态变化的时序或状态机：

- `turn/end` 到 durable pending；
- 同一 Root Session 的单飞 Learning Analysis；
- 新 Trigger 在分析期间的 coalesce/queue；
- DSH 重启后的 pending 恢复；
- 同一事件重复投递的去重；
- 显式保存请求只形成一个可见终态；
- 多 Session 同时针对同一 Skill 的 Proposal；
- Approve 重复点击和发布重试；
- Manual Edit、CREATE race 和 catalog concurrent change。

所有 retry 必须有界，并说明何时进入 `NEEDS_ATTENTION`、`NEEDS_REFRESH` 或 `PUBLISH_FAILED`。

## 9. LLM Pipeline

架构需要决定并给出取舍证据：

- 一次调用还是多阶段调用；
- structured output schema 和 validation；
- Experience extraction 与 Proposal generation 是否合并；
- recall shortlist 如何构建和设限；
- semantic curation 是否需要独立调用；
- input/output 上限；
- cancellation、timeout、retry 和 usage 记录；
- no-model-request Session 的 Needs Attention 路径。

必须保持：

```text
bounded
non-blocking
source-labeled
no silent provider fallback
```

不得把 Learning Model 变成带 Tool 的 Agent。

## 10. Publication 与 Revision

架构必须明确：

- immutable Proposal snapshot 和 digest 的生成与验证；
- CREATE expected-absence 与 MERGE Base 的读取时点；
- canonical workspace、effective root 和 resolved path 的绑定；
- symlink/junction、权限、name collision 和 secret scan 的顺序；
- Skill format 校验；
- 临时文件、原子替换和跨平台文件系统行为；
- write 后 DSH hot refresh、`complete: true` 和 `ctx.skills.get()` 回读；
- write 已成功但 readback 失败时怎样记录磁盘事实；
- Review Decision、Publication Outcome、Revision 和 audit 的提交边界；
- unmanaged Skill 首次 MERGE 时如何建立 `r1`。

任何方案都不能把 Approval 直接等价为 `PUBLISHED`。

## 11. Web 与信任边界

架构必须回答：

- Host 与 Client 是否拆包；
- Proposal list/detail、Review、Retry、Reject、Purge 和 Settings 的 RPC contract；
- 如何复用 DSH loopback/browser-trust/reachability fence；
- 怎样在业务 dispatch 前拒绝 cross-origin、非可信 Host 和远程请求；
- Session header badge 如何更新；
- 当前 workspace scope 如何计算；
- stale Proposal 和 publishing 状态怎样推送；
- Evidence/Diff/Skill 如何按惰性文本安全展示；
- 键盘、焦点和辅助技术语义如何测试。

v0.1 不得扩展为远程审批或远程发布。

## 12. DSH 源码与运行核验

必须按 `docs/architecture/dsh-compatibility.md` 重新检查并留证：

- `session/event` 生命周期和 observer 隔离；
- Root/child/subagent identity；
- `ctx.skills` API、provider rank、root、完整性和热刷新；
- `ctx.llm` 的 effective provider/model、structured output、usage、取消和失败；
- `ctx.settings` plugin namespace；
- Web client slot、plugin extension 和 browser trust；
- plugin bundle、profile、安装、升级、禁用和卸载。

承重假设应优先由精确源码位置支撑；源码不足时再做有界 Contract Probe。探针必须可丢弃，不得成为生产实现捷径。

## 13. 测试策略输入

Architecture Baseline 必须把以下风险映射到测试层级：

- 纯领域状态机和 schema validation；
- DSH Adapter contract；
- Store migration、crash consistency 和 purge；
- concurrency、dedupe、retry 和 restart；
- incomplete catalog、stale Base 和 CREATE race；
- path traversal、symlink/junction 和权限；
- secret、prompt-injection-like 内容和安全渲染；
- Web accessibility 和 browser trust；
- 安装、升级、禁用、卸载；
- 三个黄金场景和冻结评测集；
- 当前 baseline 与最新上游预警兼容性。

必须区分 unit、integration、contract probe 和 end-to-end 证据，不能只依赖黄金场景。

## 14. 架构验收标准

`docs/architecture/baseline.md` 只有在以下条件满足时才能提交维护者评审：

- 每个 PRD requirement group 都有明确责任模块和验证方式；
- DSH Borrow 与 run2skill Own 没有重叠 Runtime；
- 关键流程有状态机或时序图；
- 每个跨模块 contract 有输入、输出、错误和版本边界；
- fail-open 与 publish fail-closed 可以被测试；
- Store、Approval、Publication 和 readback 的崩溃边界明确；
- 隐私、路径、作用域和浏览器信任有确定性 Guard；
- 上游升级只影响集中 Adapter；
- 切片 A-D 都能从架构中自然切出；
- 替代方案和暂缓决定被明确记录；
- 没有为了实现方便扩大 v0.1 范围。

以上阶段门已于 2026-08-19 满足。当前有效架构结论以 `docs/architecture/baseline.md` 为准；后续修改仍须由维护者评审和接受后，才能约束新的纵向切片 Design。
