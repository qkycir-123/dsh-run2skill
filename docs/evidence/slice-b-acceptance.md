# Slice B Learn 验收记录

日期：2026-08-20

DSH baseline：`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`

## 结论

Slice B 已形成最小 Learning 闭环：完整的 durable WorkItem 可以在有界 Session Window 内形成带证据的 Experience 和 Learning Proposal；模型路由、只读 Skill recall、结构化输出、Core Guard、请求预算、并发、重试与恢复均有固定边界。学习失败不会阻断 Session Observe，且插件仍不写入任何 Skill，也不声称 Proposal 已进入审核或发布。

## 可复现门

| 门 | 命令 | 结果 |
|---|---|---|
| 类型、lint、全量单测 | `pnpm run check` | 38 个文件、335 项测试通过 |
| Observe + Learning 冻结评测 | `pnpm run evaluate` | Observe 45 个样本全部通过；Learning 20 个语义/边界场景全部通过，Type、Scope、Curation、安全阻断均为 1.0；错误常量预测的负向控制按预期未达到 90% 门槛 |
| 构建、崩溃矩阵与候选包安全门 | `pnpm run verify:candidate` | 构建通过；4 个崩溃边界通过；精确 7 文件 allowlist、仓库/包敏感材料扫描和合成日志脱敏通过 |
| DSH 契约探针 | `powershell -File probes/run-dsh-contract-probes.ps1 -DshSource <clean-baseline>` | 7 个文件、20 项测试通过；上游前后不变 |
| 安装生命周期 | `powershell -File probes/run-install-lifecycle-probe.ps1 -DshSource <clean-baseline>` | 基线 fixture 与当前候选包的安装、禁用、升级、卸载通过；上游仍为 fixed/clean |
| 生产依赖审计 | `pnpm audit --prod --audit-level high` | 无已知漏洞 |

## 已冻结行为

- 只有完整、可学习的 `CAPTURED` WorkItem 才能进入 Learning；failed/cancelled Turn 只允许学习其中明确的直接用户教学证据，不根据 Agent 行为推导成功 Workflow；缺失有效模型 route 时 fail closed 并进入结构化 attention 路径。
- Window、Envelope、模型输出、候选数、每项请求预算、单 Session 与全局并发都有硬上限。
- 模型只接收 canonical Envelope 和固定 schema；原 Agent system、tools、路径与凭据不透传。
- Skill catalog 必须是完整只读快照；候选消失、只读、跨 scope 或内容不安全时由 Core Guard 拒绝。
- durable Proposal 记录精确 provider/model 与调用事实；重放 `LEARNED` 项不会再次调用模型。
- 运行时恢复最多形成一个 durable Proposal；stale 输入达到终止条件后进入可见的 `NEEDS_ATTENTION`，不会形成热循环。

## 证据边界

- CP-LLM/Skill 使用固定 fake Adapter，验证真实 DSH 接口契约但不调用外部模型。
- Learning 金标与版本化预测记录分开保存；预测必须经过真实 Restricted Client、Worker、Core Guard 和 durable Store 后才能计分。该门验证冻结离线结果与产品管线，不把 fake Adapter 宣称为实时模型质量。
- 本次没有执行真实 provider smoke；Slice B 的确定性验收不依赖外部服务或环境中的 key。
- PASS 只绑定当前插件 commit、上述 DSH baseline、测试源码与运行平台；任一变化都必须重跑。
- 临时 clone、构建产物和完整终端日志位于被忽略的探针目录，不作为提交证据。

## 未解除约束

- Learning Proposal 仍只是内部草案，不是 `PENDING_REVIEW`，更不是已发布 Skill。
- CP-ROOT-001 仍禁止 PROJECT/USER publication；只有 Slice C 的授权与提交边界可以解除。
- Slice C 尚未设计和冻结；本切片没有提前实现 Review、Approval、Publication 或 Skill 写入。
