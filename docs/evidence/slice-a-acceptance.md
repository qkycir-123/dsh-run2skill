# Slice A Observe 验收记录

日期：2026-08-20

DSH baseline：`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`

## 结论

Slice A 已形成最小可运行闭环：单个双面包可安装到 DSH Web profile；Host 只观察 Root Turn 的直接用户文本，Cheap Trigger 命中后立即写入已脱敏 WorkItem；普通无信号 Turn 不建立 WorkItem；Client 只显示 Observe 摘要。本切片没有模型调用，也不查询、生成或写入 Skill。

## 可复现门

| 门 | 命令 | 结果 |
|---|---|---|
| 类型、lint、全量单测 | `pnpm run check` | 27 个文件、258 项测试通过 |
| 发布构建 | `pnpm run build` | Host `lib/index.js`、Client `lib/client.js` 和 Host 类型产物生成 |
| 包内容 | `pnpm pack --pack-destination .probe-work/package` | 仅包含 manifest、许可、README、薄 patch 和 `lib` 产物 |
| 冻结评测 | `pnpm run evaluate` | 45 个样本；显式保存召回、precision、recall、普通无信号率均为 1.0 |
| 硬崩溃矩阵 | `pnpm run probe:crash` | 4 个提交边界及 seq 复用场景通过 |
| 候选包安全门 | `pnpm run verify:candidate` | 精确 7 文件 allowlist、仓库与包敏感材料扫描、合成运行日志脱敏通过 |
| DSH 契约探针 | `powershell -File probes/run-dsh-contract-probes.ps1 -DshSource <clean-baseline>` | 6 个文件、17 项测试通过；上游前后不变 |
| 安装生命周期 | `powershell -File probes/run-install-lifecycle-probe.ps1 -DshSource <clean-baseline>` | 基线 fixture 与当前候选包的安装、禁用、升级、卸载通过 |
| 生产依赖审计 | `pnpm audit --prod --audit-level high` | 无已知漏洞 |

## 已冻结行为

- Host 只声明 `sessions`、`sessionPersistence`、`storageDomain`、`workspaceRegistry`、`connection`；不声明 `llm`、`skills`、`settings`。
- 首次激活以 durable Session tail 建 fence，不自动学习旧历史；实时 ingress 先于 gap scan 注册。
- WorkItem 的时间与 ID 均来自持久 Turn 事实，实时、补扫、重启和重复投递收敛为同一记录。
- 普通无信号 Turn 不查询 Workspace、不建立 WorkItem；水位按 32 Turn 或 30 秒批量提交。
- 日志边界不足以构造稳定 Turn-instance ID 时只记健康状态并重扫，不伪造 blocked WorkItem。
- Header 与 RPC 只暴露有界计数、恢复状态和健康码，不暴露 Session 正文、证据摘录、路径或秘密。

## 未解除约束

- Slice A 的 `CAPTURED` 只是内部已记录状态，不是 Proposal，也不是“已保存为 Skill”。
- CP-ROOT-001 仍限制 PROJECT/USER publication；Slice C 解除前不得发布 Skill。
- v0.1 Alpha 尚未发布；下一步是 Slice B 独立 Design，而不是提前实现切片 C/D。
