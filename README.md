# dsh-run2skill

`dsh-run2skill` 是一个正在开发的 DSH-native、local-first 插件。它从真实 DeepSeek Harness 工作中识别用户明确教出的可复用行为，形成有证据的 Skill Proposal，经人工审核和安全校验后发布为原生 DSH Skill。

当前状态：**切片 A Observe 已完成实现与固定 DSH baseline 的集成验收**。插件可以安装到 Web profile，观察 Root Turn、持久记录明确 Trigger，并在 Header 提供只读状态；它尚不生成 Proposal 或发布 Skill。下一步是切片 B 的独立 Design。Scope publication 仍受 CP-ROOT-001 发布锁约束。

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

## 切片 A 实现记录

- [#2 — A1 Domain contracts](https://github.com/qkycir-123/dsh-run2skill/issues/2)
- [#3 — A2 Session adapter](https://github.com/qkycir-123/dsh-run2skill/issues/3)
- [#4 — A3 Durable capture](https://github.com/qkycir-123/dsh-run2skill/issues/4)
- [#5 — A4 Recovery lifecycle](https://github.com/qkycir-123/dsh-run2skill/issues/5)
- [#6 — A5 Observe summary](https://github.com/qkycir-123/dsh-run2skill/issues/6)
- [#7 — A6 Package/E2E](https://github.com/qkycir-123/dsh-run2skill/issues/7)

切片 A 按 A1 → A2 → A3 → A4/A5 → A6 收口；复现证据见 [Slice A 验收记录](docs/evidence/slice-a-acceptance.md)。切片 B 不会与未冻结的 Slice A 并行实现。

## 开源许可

采用 MIT License，详见 [LICENSE](LICENSE)。
