# 设计文档

这里收录尚未实现或需要跨模块约束的公开设计。实现状态以对应 GitHub Issue 和 Pull Request 为准。

| 文档 | 状态 | 对应 Issue |
|---|---|---|
| [无感提醒与插件设置页](issue-72-unobtrusive-ui.md) | 待评审 | [#72](https://github.com/qkycir-123/dsh-run2skill/issues/72) |
| [SessionBatch 语义检测、完整召回与分阶段学习](issue-84-session-batch-learning.md) | 待评审 | [#84](https://github.com/qkycir-123/dsh-run2skill/issues/84) |

`single-owner-skill-save.md` 的 Agent-first 和 fail-closed 原则继续有效；其中逐 Turn WorkItem/TurnBaseline 机制已由 #84 的批次设计取代。
