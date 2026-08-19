# dsh-run2skill

`dsh-run2skill` 是一个规划中的 DSH-native、local-first 插件。它从真实 DeepSeek Harness 工作中识别用户明确教出的可复用行为，形成有证据的 Skill Proposal，经人工审核和安全校验后发布为原生 DSH Skill。

当前状态：**v0.1 需求、Architecture Baseline 和切片 A Observe Design 已批准，基线 Contract Probe 轮次已完成**。下一步拆分切片 A Issues 并开始实现；Scope publication 仍受 CP-ROOT-001 发布锁约束。

## 项目边界

- 不修改或复制 DSH Runtime；
- 不创建新的 Agent、Session、Skill Runtime、Memory 或云服务；
- v0.1 只正式支持 DSH `web` profile；
- LLM 只提出 Proposal，用户审核和 Core Guards 控制持久发布；
- 已发布结果是普通 DSH Skill，卸载 run2skill 后仍可使用。

## 项目文档

- [项目路线](docs/roadmap.md)
- [产品需求文档](docs/product/prd.md)
- [需求评审与决策记录](docs/product/requirements-review.md)
- [DSH 兼容性基线](docs/architecture/dsh-compatibility.md)
- [架构设计输入](docs/architecture/architecture-input.md)
- [v0.1 架构基线](docs/architecture/baseline.md)
- [Contract Probe 证据台账](docs/architecture/contract-probes.md)
- [Contract Probe 复现指南](probes/README.md)
- [切片 A：Observe 设计](docs/design/slice-a-observe.md)

## 开源许可

采用 MIT License，详见 [LICENSE](LICENSE)。
