# Slice C 安全 Run → Skill 验收记录

日期：2026-08-20

DSH baseline：`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`

## 结论

Slice C 已在 stock、clean、未修改的固定 DSH baseline 上形成纯插件闭环。四个黄金场景均经过真实 DSH Web、真实 DeepSeek Provider、immutable Review、CAS/journal 写入和原生 Skill Registry exact readback；没有使用 DSH fork、patch、候选 roots API、自有 Skill provider 或重启伪装热回读。

本次 C7 只补齐真实验收暴露的接线缺口：Web Slot 的 factory contract、Learning 完成后的 durable curation、独立插件实例下的固定 stock preset 观察、跨重启 publication scope 恢复，以及原生 Registry 缓存失效后的有界 exact readback。产品需求、Architecture、root contract 和 v0.1 功能范围没有变化。

## 真实黄金场景

| 场景 | 真实结果 | 可核验事实 |
|---|---|---|
| A · CREATE PROJECT | PASS | Web 展示 PROJECT、Evidence、ABSENT root、exact target 和完整 Skill；新建 `use-pnpm-over-npm` 后形成 Lineage r1；原生 `filesystem/project-dsh` winner 与 `ctx.skills.get()` 首次回读即精确匹配；新相关任务调用该 Skill，无关任务不触发。 |
| B · MERGE | PASS | Web 同时展示 r1 Base 与精确 Diff；批准后同一 Lineage 形成 r2；新内容同时保留 pnpm 规则并增加 `pnpm --version`；原生 `filesystem/project-dsh` winner 与 exact `get()` 首次回读匹配。 |
| C · Base Conflict | PASS | Review 后人工修改目标，旧 Proposal `prop_3dc3…f57d1` 保留 `APPROVED` 并进入 `NEEDS_REFRESH`，人工字节未被覆盖；基于最新内容形成不同 Proposal `prop_f404…18f0`，重新以 `PENDING` 展示 Base/Diff 并要求新批准；最终 Lineage 明确记录 `MANUAL_BASE` r2 与 run2skill r3。 |
| D · CREATE USER | PASS | Web 展示环境解析的 DSH Home、USER target 和完整 Skill；发布后原生 `filesystem/user-dsh` winner 与 exact `get()` 首次回读匹配；全新项目的 stock DSH 注入 `skill-catalog` 并调用 `Skill read-project-collaboration-rules`；卸载 run2skill、确认 profile 不再 compose 插件后，第三个新项目仍调用同一 USER Skill。 |

A/B 的 Lineage 分别绑定 `prop_b3cd…3ebf` 和 `prop_cb76…d09e`，`currentRevision=2`；D 绑定 `prop_f005…6efd`，`currentRevision=1`。这些短标识只用于把 Review、Outcome 与 Lineage 事实对应起来，不替代 durable Store 和 exact Registry 断言。

## 真实模型与故障边界

- 主 DSH Agent 与 run2skill Learning 均使用 `deepseek-official/deepseek-v4-flash`；Web trajectory 和 durable `modelRoute` 一致，没有回退到其他 Provider 或模型。
- Provider 凭据只在隔离子进程环境中注入；未写入仓库、fixture、截图、Skill、日志或证据文档。
- 真实调用期间观察到过 output exhaustion、`MODEL_TERMINAL_FAILURE` 和 `LEARNING_GUARD_REJECTED`。这些调用均 fail closed 为 durable attention，未生成或发布不完整 Proposal，也未阻断 DSH 主 Agent；黄金结果只统计随后独立成功且可 exact readback 的会话。
- Proposal 跨 Web/Host 重启保持 durable；批准后的 publication 可在唯一 canonical-equivalent live Agent scope 与完全相同的已批准 root-contract digest 下恢复，零个、多个或 digest 漂移时继续 fail closed。

## 可复现操作面

真实 Web 路径使用候选包和隔离 profile，核心命令如下；`<dsh-source>` 必须处于本文 baseline 且 clean，运行目录必须是有自身 Git root 的独立 workspace：

```powershell
node <dsh-source>/apps/cli/lib/bin.js plugin --profile web add <candidate>
node <dsh-source>/apps/cli/lib/bin.js --profile web --dump-config
node <dsh-source>/apps/cli/lib/bin.js web --port <loopback-port>
node <dsh-source>/apps/cli/lib/bin.js plugin --profile web remove dsh-run2skill
node <dsh-source>/apps/cli/lib/bin.js --profile web --dump-config
```

操作者在 Web 中逐场景检查 Evidence、Scope、root/target、完整 Skill、MERGE Base/Diff、Decision/Outcome，并在 C 场景的 Review 与 Approve 之间修改目标文件。成功断言来自 durable Proposal/Lineage、磁盘 exact bytes、原生 complete snapshot winner、原生 `get()` 和新 session trajectory 的共同闭环；局部 fixture 或 UI 文案不能单独宣称 PASS。

## 发布候选门禁

| 门 | 命令 | 结果 |
|---|---|---|
| 类型、lint、全量单测、publication CAS | `pnpm run check` | 54 个测试文件、422 项单测与 8 项 publication CAS 测试通过。 |
| 冻结评测、崩溃矩阵与候选安全 | `pnpm run verify:candidate` | Observe 45 个样本、Learning 20 个场景全部达到冻结门槛；4 个 crash case、7 文件包 allowlist、secret scan 与 log redaction 通过。 |
| DSH 契约 | `powershell -File probes/run-dsh-contract-probes.ps1 -DshSource <dsh-source>` | 7 个测试文件、22 项测试通过；`DSH_SOURCE_AFTER=unchanged`、`CONTRACT_PROBES=PASS`。 |
| stock root contract | `powershell -File probes/run-dsh-root-contract-probe.ps1 -DshSource <dsh-source>` | 15 项 production-backed 测试通过；`DSH_SOURCE_AFTER=unchanged`、`CP_ROOT_003=PASS`。 |
| 跨平台 publication | `powershell -File probes/run-publication-contract-probe.ps1` | Windows 8 项、WSL/Linux 8 项通过；`CP_PUB_001=PASS`。 |
| 安装生命周期 | `powershell -File probes/run-install-lifecycle-probe.ps1 -DshSource <dsh-source>` | baseline fixture 与当前候选的 add/disable/upgrade/remove、Web composition 和卸载后 USER Skill 使用通过；上游前后不变。 |
| 生产依赖审计 | `pnpm audit --prod --audit-level high` | 无已知漏洞。 |

## 证据边界

- PASS 绑定本文件所在 dsh-run2skill commit、固定 DSH baseline、上述命令和 Windows/WSL 平台；任一变化都需要重跑相应门。
- `.probe-work/` 中的 clone、浏览器截图、完整模型输出与运行日志只用于本次诊断，不提交，也不是独立权威证据。
- synthetic secret、duplicate mutation、同 target race、Store/Web/Registry 故障、restart/crash 和路径安全由全量测试、冻结评测、CP-PUB-001、CP-ROOT-003、契约与安装生命周期共同覆盖；真实模型偶发失败只作为 fail-open 补充证据。
- C7 没有实现 Settings、Purge、History、Rollback、迁移、发布 UX、npm publish、tag 或 release；这些仍留给 Slice D 或发布阶段。
