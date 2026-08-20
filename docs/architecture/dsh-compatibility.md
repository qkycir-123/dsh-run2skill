# DSH 兼容性基线

状态：Architecture 级源码核验、既有基线探针轮次、纯插件 stock-root 与 `0.1.0-alpha` schema/package freeze 已完成
核验日期：2026-08-21

## 1. 上游来源

- 仓库：`https://github.com/deepseek-ai/deepseek-harness.git`
- 本地观察到的默认分支：`master`
- Baseline commit：`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- DSH 版本：`0.1.0-rc.7`
- Commit 日期：`2026-08-17T19:03:17+08:00`
- Commit 主题：`Merge pull request #2620 from deepseek-harness/release/dsh-0.1.0-rc.7`

兼容性验证可在任意目录使用官方上游的干净 checkout；它必须位于该 baseline commit，且不得包含本地 patch。本项目不依赖特定工作区布局或 Git push 配置。

## 2. 已确认的需求层事实

| 能力面 | 当前 baseline 观察 | 对 run2skill 的约束 |
|---|---|---|
| Session 事件 | durable 执行事实通过 `session/event` 提供，包含 `turn/end`；`agent/*` 偏实时协调 | 观察执行事实，不侵入 Agent Loop |
| Observer 隔离 | `Session.append()` 先提交事件，并容纳 observer 的同步异常和异步拒绝 | run2skill observer 仍需自行 fail open |
| Session 身份 | `SessionHeader` 可包含 cwd、`createdAt`、`parentSession`、`origin: 'subagent'`、`delegationDepth` | 字段可选；不能仅凭 `parentSession` 判断 subagent；生命周期 key 需包含不可变 createdAt/cwd 事实，也不能猜 PROJECT root |
| Skill 类型 | `@deepseek-ai/dsh-skill` 定义 provider-facing `SkillCandidate` | 本项目使用 `Skill Proposal` |
| Skill Registry | `ctx.skills.list()`、`snapshot()`、`get()` 存在；snapshot 报告 `complete` | 不完整观察不能证明 absence 或 coverage |
| Skill roots | PROJECT DSH root 为 `<projectRoot>/.dsh/skills`；USER DSH root 为 `<DSH_HOME>/skills` | USER 目标不能硬编码为 `~/.dsh/skills` |
| DSH Home | 显式配置优先，其次 `$DSH_HOME`，最后默认 `~/.dsh` | 发布必须使用 mounted provider 的有效 Home |
| Skill 热刷新 | filesystem provider 使用 Chokidar，并在相关写入后使 catalog observation 失效/刷新 | 发布成功还必须经过完整 Registry 回读 |
| LLM | `ctx.llm.stream()` 支持明确 provider/model 配置，并报告 usage 和 terminal failure | 模型调用统一走 DSH，不自建 Provider |
| Settings | 支持 plugin namespace 注册、watch、serialized update 和 revision conflict | run2skill 不自建配置系统 |
| Web 扩展 | external `dsh.client` plugin 可加载；存在 `conversation.session.header.actions` slot | v0.1 可在 Session header 接入 Proposal Inbox |
| 插件安装 | CLI 支持 `dsh plugin --profile <name> add <package-or-git-spec>` | 可在不修改 DSH 源码的情况下安装 |

## 3. Architecture 级源码核验结论

以下结论绑定本文第 1 节的精确 baseline，不自动适用于更新后的上游：

| 架构面 | 源码证据 | 已确认结论 |
|---|---|---|
| Session 提交与 observer | packages/core/session/src/index.ts、types.ts | session/event 在 append 后发出；observer 同步异常和异步拒绝被容纳；历史 seed 不会重新发出实时 session/event，冷启动缺口需要持久日志补偿 |
| Root/child 身份 | packages/core/session/src/types.ts、packages/session/session-persistence-jsonl/src/format.ts | origin=subagent 和 delegationDepth>0 是 Child 强事实；仅有 parentSession 不能证明 subagent；live 中缺失的 delegationDepth 经 Web JSONL 重载后会规范化为 0，Root 判定必须把缺失/0 视为等价 |
| Session persistence | packages/session/session-persistence-jsonl、packages/session/session-persistence-sqlite | Web 主路径为 JSONL，支持 snapshot revision 与 readFrom；JSONL 顺序读取可能解析整个 artifact，插件只能约束返回后缀/处理批次，不能声称物理读取字节数严格有界 |
| Effective model route | packages/core/agent-loop/src/agent.ts、packages/core/session/src/request-header.ts | agent loop 在实际 dispatch 前记录 effective request/header；按日志前缀 last-wins 可重建 provider/model |
| 受限 LLM 调用 | packages/llm/llm/src/types.ts、index.ts | ctx.llm.stream 支持明确 provider/model、AbortSignal、usage 和 terminal finish；GenerateOptions 没有原生 JSON response-format，也没有任意 purpose 扩展 |
| Skill Registry | packages/skill/skill/src/index.ts | snapshot.complete 是完整性边界；winning candidate 按 scope layer/rank 解析；get 会重新读取完整 body；skills/change 用于失效通知 |
| Filesystem Skill provider | packages/skill/skill-filesystem/src/index.ts | project-dsh/user-dsh rank、root 和 source 已确认；provider 支持 bundle/flat Skill 和热 watcher；watcher 故障可返回 complete=false |
| Agent preset mounted-generation witness | packages/preset/agent-presets/src/mount.ts；vendor/cordis/src/fiber.ts、registry.ts；apps/cli/config/agent-presets/{standard,code}/agent.cordis.yml | `standingMountFor(agent.ctx)` 定位 exact joined generation；其 subtree 内唯一 active `skill-filesystem` fiber 保留 Schemastery 已解析 config，避免磁盘 composition 与旧 generation 竞态 |
| Skill frontmatter | packages/skill/skill-filesystem/src/index.ts | name/description 必填；模型/用户调用键是 disable-model-invocation 与 user-invocable，不接受 run2skill 自造 camelCase 字段 |
| Workspace identity | packages/workspace/workspace/src/types.ts、index.ts | ctx.workspaceRegistry 以 UUID 标识、用 fs.realpath 规范化路径，并可 resolveByPath/status；适合作为 PROJECT identity，不应由 run2skill 猜 Git root |
| Settings | packages/settings/settings/src/index.ts | namespace 注册、frozen resolved value、watch、serialized write 和 expectedRevision 冲突可复用 |
| Store | packages/storage/storage-domain、packages/storage/storage-json、packages/bundle/web-app/cordis.patch.yml | Domain 提供 schema、单 domain 写序列和原子单记录更新；Web profile 使用 JSON backend 的原子整文件发布；没有跨表事务或二级索引，不支持把同一介质交给多个 Host 并发写 |
| Web trust / RPC | packages/client/connection/src/rpc.ts、rpc-host.ts、index.ts | 独立 RPC channel 可声明 authority=loopback；Host/Origin/cross-site 检查发生在业务 handler 前；该 fence 是可达性边界，不是远程认证 |
| Client 插件与 slot | packages/client/modules、packages/client/ui-conversation/src/client/contract/slots.ts | 外部包可用 dsh.client + ./client 加载；conversation.session.header.actions 是 session-scoped list slot |
| 原子文件工具 | packages/util/atomic-write/src/index.ts | writeFileAtomic 保证同目录完整替换，withFileLock 只协调遵守该锁的 writer；两者都不提供内容 compare-and-exchange 或 crash fsync |
| DSH Home | packages/util/home-paths/src/index.ts；packages/skill/skill-filesystem/src/index.ts | resolveDshHome 顺序为显式配置、DSH_HOME、默认目录；filesystem provider 在构造时固定 effective Home，Host 因此保存启动环境 witness 并对运行时环境漂移 fail closed；ctx.skills 当前未直接暴露 effective writable root 查询 |

这些结论已转化为 docs/architecture/baseline.md 的模块边界、fail-open/fail-closed 规则和 Contract Probe 清单。

## 4. 重点源码与文档

Architecture Baseline 至少重新核验：

```text
docs/agent-lifecycle.md
docs/subsystems/skills.md
docs/subsystems/llm-streaming.md
docs/subsystems/settings.md

packages/skill/skill/src/index.ts
packages/skill/skill-filesystem/
packages/skill/tool-skill/

packages/llm/llm/
packages/settings/

packages/client/ui-conversation/
packages/client/*settings*
packages/session-query/session-log-export/
packages/subagent/
```

## 5. 运行 Contract Probe 状态

源码事实不等于生产兼容性已成立。当前 Windows 运行证据已确认：

- Session observer 故障隔离、Root/Child 强身份、Web JSONL 与 SQLite 重启恢复、snapshot revision 水位和 `readFrom` gap scan；同时确认 Web JSONL 会把缺失的 delegationDepth 规范化为 0；
- Storage Domain 同 key 写序列、durable close drain、结构化 missing-key 错误，以及 Web profile JSON 与对照 SQLite backend 的重启恢复；
- Session request/header last-wins route、无 Tools 的受限 LLM stream、usage、取消和一次 JSON 格式修复；
- Skill snapshot 完整性、PROJECT/USER rank、精确 get、skills/change 和热回读；
- 手工组合下的 Workspace/project-dsh 与 configured DSH Home/user-dsh root parity。
- loopback RPC 的 Host/Origin 拒绝顺序、外部 Client manifest 和 Session header action slot；
- Windows 与 WSL/Linux 上的 CREATE/MERGE hard-link no-replace、竞争、进程崩溃恢复、junction/symlink 防逃逸和 backup finalization。
- 外部双面包在真实 Web profile 的 add、Host/Client 激活、禁用、升级、卸载，以及卸载后的原生 Skill 保留。
- stock root contract 的 PROJECT/USER CREATE/MERGE、absent root、配置漂移 fail-closed、原生 filesystem winner 与 exact `get()` 回读。

完整输入、环境、结果和运行命令见 `docs/architecture/contract-probes.md`。基线探针轮次已完成；进入对应纵向切片时仍须遵守以下剩余边界：

- Session 取消、重复事件和 workspace identity 的精确解析；
- `ctx.skills` 的 scope layer 和并发失效边界；
- ADR-0001 的 stock configuration root contract 已由 CP-ROOT-003 取得运行证据；该结果不等同于 C7 最终黄金验收；
- `ctx.settings` namespace、默认值、冲突和 live update；
- 真实 dsh-run2skill 发布候选包必须重复 Host/Client、profile、安装、禁用、升级和卸载验收。

兼容性探针必须可丢弃，不得在 DSH 源码中留下 run2skill patch。生产能力不得依赖 DSH fork、未合并 roots API、本地 patch、自有 Skill provider 或 sentinel 探测。

## 6. 兼容性策略

- 项目开发和验收绑定明确 baseline commit，不绑定浮动分支。
- DSH 专有调用集中在薄 Adapter；Core 不直接依赖不稳定实现。
- 当前 baseline 运行完整兼容测试，最新 `origin/master` 只做预警验证。
- 当前仍固定 `0.1.0-rc.7` / `99f6f02`；本次不升级 baseline。`0.1.0-rc.8` 由后续独立兼容性验证决定，不能随本次文档修订自动采纳。
- 若上游更改默认分支，应在兼容性评审中更新名称，不得依赖永久存在的 `master`。
- 不兼容时安全停用受影响的学习或发布能力，不得影响 DSH 主 Agent。
- `0.1.0-alpha` 的 durable domain/record freeze、JSON/SQLite restart 与升级/降级规则见 [`storage-schema.md`](storage-schema.md)；mismatch 不得解释为空库或触发自动清理。

## 7. Baseline 更新协议

1. 只 fetch 上游，不移动 detached baseline。
2. 比较当前 baseline 与最新上游的相关契约变化。
3. 确定受影响的 Adapter、产品约束、测试和文档。
4. 在候选 commit 上重新执行源码核验、Contract Probe 和兼容测试。
5. 同一个已评审变更中更新 Architecture、测试和本文。
6. 全部证据通过后才能移动 baseline。

任何 baseline 移动都会使受影响的旧证据失效；不得仅因上游 main/master 有更新就自动跟随。
