# 设计文档

这里收录已落地且仍约束当前行为的公开设计，以及它们的历史交付边界。当前稳定版为 [`0.3.1`](https://github.com/qkycir-123/dsh-run2skill/releases/tag/v0.3.1)；`main` 中尚未发布的实现必须明确标记，不能反写成已发布能力。未来计划只在文档明确标记“后续”时成立。

| 文档 | 当前状态 | 适用版本 | 对应 Issue |
|---|---|---|---|
| [无感提醒与插件设置页](issue-72-unobtrusive-ui.md) | 已发布核心 + `0.3.1` 状态/立即整理增量 | `0.1.1-alpha`–`0.3.1` | [#72](https://github.com/qkycir-123/dsh-run2skill/issues/72)、[#141](https://github.com/qkycir-123/dsh-run2skill/issues/141) |
| [同一 Skill 保存意图的单一生成所有者](single-owner-skill-save.md) | 原则已落地；逐 Turn 机制已被 #84 取代 | `0.2.0`–`0.3.1`；`main` 继续适用 | [#71](https://github.com/qkycir-123/dsh-run2skill/issues/71) |
| [SessionBatch 语义检测、完整召回与分阶段学习](issue-84-session-batch-learning.md) | 已发布核心 + `0.3.1` 调度/证据增量 | `0.2.0`–`0.3.1` | [#84](https://github.com/qkycir-123/dsh-run2skill/issues/84)、[#141](https://github.com/qkycir-123/dsh-run2skill/issues/141)、[#143](https://github.com/qkycir-123/dsh-run2skill/issues/143) |

当前事实以代码、[PRD](../product/prd.md)、[架构基线](../architecture/baseline.md)和[兼容性声明](../compatibility.md)为准，稳定包边界以 [CHANGELOG](../../CHANGELOG.md) 和 Release 为准。`single-owner-skill-save.md` 的 Agent-first 和 fail-closed 原则继续有效；其中逐 Turn WorkItem/TurnBaseline 机制已由 #84 的批次设计取代。按修改意见生成新 Proposal revision 的 `0.3.1` 需求记录在 PRD `REQ-REV-012`，没有单独扩大为自由编辑设计。
