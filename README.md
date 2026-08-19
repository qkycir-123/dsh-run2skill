# dsh-run2skill

`dsh-run2skill` 是一个正在开发的 DSH-native、local-first 插件。它从真实 DeepSeek Harness 工作中识别用户明确教出的可复用行为，形成有证据的 Skill Proposal，经人工审核和安全校验后发布为原生 DSH Skill。

当前状态：**切片 A Observe 与切片 B Learn 已完成实现和固定 DSH baseline 的集成验收**。插件可以安装到 Web profile，观察 Root Turn，并把完整 WorkItem 转换为有界、带证据且经过 Core Guard 的内部 Learning Proposal；它尚不提供人工审核，也不发布 Skill。下一步是切片 C 的独立 Design。Scope publication 仍受 CP-ROOT-001 发布锁约束。

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
- [切片 A 验收记录](docs/evidence/slice-a-acceptance.md)
- [切片 B：Learn 设计](docs/design/slice-b-learn.md)
- [切片 B 验收记录](docs/evidence/slice-b-acceptance.md)

## 切片 A 实现记录

- [#2 — A1 Domain contracts](https://github.com/qkycir-123/dsh-run2skill/issues/2)
- [#3 — A2 Session adapter](https://github.com/qkycir-123/dsh-run2skill/issues/3)
- [#4 — A3 Durable capture](https://github.com/qkycir-123/dsh-run2skill/issues/4)
- [#5 — A4 Recovery lifecycle](https://github.com/qkycir-123/dsh-run2skill/issues/5)
- [#6 — A5 Observe summary](https://github.com/qkycir-123/dsh-run2skill/issues/6)
- [#7 — A6 Package/E2E](https://github.com/qkycir-123/dsh-run2skill/issues/7)

切片 A 按 A1 → A2 → A3 → A4/A5 → A6 收口；复现证据见 [Slice A 验收记录](docs/evidence/slice-a-acceptance.md)。

## 切片 B 实现记录

- [#19 — B1 Learning durable schema 与 Store 状态机](https://github.com/qkycir-123/dsh-run2skill/issues/19)
- [#20 — B2 Bounded Window、Envelope、redaction 与 route](https://github.com/qkycir-123/dsh-run2skill/issues/20)
- [#21 — B3 Agent scope、只读 Skill recall 与 Core Guards](https://github.com/qkycir-123/dsh-run2skill/issues/21)
- [#22 — B4 Restricted LLM client](https://github.com/qkycir-123/dsh-run2skill/issues/22)
- [#23 — B5 Learning scheduler 与 Host 集成](https://github.com/qkycir-123/dsh-run2skill/issues/23)
- [#24 — B6 固定评测与真实 DSH 集成验收](https://github.com/qkycir-123/dsh-run2skill/issues/24)

切片 B 按 B1 → B2 → B3 → B4 → B5 → B6 收口；复现证据见 [Slice B 验收记录](docs/evidence/slice-b-acceptance.md)。切片 C 会先独立设计和冻结，再拆分实现 Issue。

## 开源许可

采用 MIT License，详见 [LICENSE](LICENSE)。
