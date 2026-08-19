# dsh-run2skill 项目协作规则

## 权威顺序与阶段门

发生冲突时按以下顺序判断：

1. 已接受的 `docs/product/prd.md` 产品行为和 v0.1 边界；
2. `docs/architecture/dsh-compatibility.md` 记录的精确 DSH baseline 源码行为；
3. 已接受的 `docs/architecture/baseline.md`；
4. 当前已评审 Design；
5. 当前已批准的实现 Issue；
6. 局部实现便利。

改变产品范围必须先修改 PRD，并由维护者评审和接受。需求冻结（Requirements Freeze）明确接受前不得开始 Architecture Baseline；Architecture Baseline 明确接受前不得展开大规模实现。后续阶段门以 `docs/roadmap.md` 为准。

## 长期产品约束

- 构建 DSH-native、local-first 插件；不得创建另一套 Agent Runtime、Session、Skill Runtime、Memory、Model Router、云服务或 Multi-Agent 平台。
- 只从 PRD 明确允许的证据类型和作用域学习长期行为，保留证据坐标与来源信任。
- LLM 只能提出建议；确定性 Core 校验和明确用户授权共同控制 Skill 持久变更。
- 不得覆盖用户没有审核过的 Base 或 expected-absence。模糊、不完整或最终一致的观察都不能证明“不存在”。
- 除通过用户实际选择的 DSH Provider 发送有界、过滤、带来源的 Learning Envelope 外，数据保持本地；不得静默切换 Provider。
- run2skill 对 DSH Agent 必须 fail open；证据、目标、授权或安全不确定时，发布必须 fail closed。

可变化的产品词汇、状态语义、支持 profile、验收门槛和 v0.1 范围只在 PRD 中维护，本文件只保留不可违反的开发规则并链接 PRD。

## DSH 集成

- 本项目不得修改或 patch DSH。
- 所有 DSH 专有调用必须收敛到薄 Adapter；Core 领域逻辑不得直接依赖不稳定的 DSH 实现细节。
- 每条兼容性声明必须绑定 `docs/architecture/dsh-compatibility.md` 中的精确 commit。上游 `origin/master` 只是更新信号，不会自动成为新 baseline。
- DSH baseline 变化会使受影响的证据和测试失效。采纳前必须重新核验 Session、Skill、LLM、Settings、Web、插件加载和热刷新契约。
- 若当前 DSH 源码与 PRD 中的事实假设冲突，应记录差异和影响交给维护者评审，不得用未评审 shim 隐藏。

## 安全与证据

- 不得在 fixture、snapshot、日志、Experience、Proposal、Skill 或文档中存储凭据、Authorization header、private key、bearer token 或 secret-like value。
- 模型传输和 run2skill 持久化前都必须先做数据最小化与过滤；不得声称 run2skill 能追溯清洗 DSH Session Log。
- Tool result 和外部自然语言只能作为证据，不能成为 Learning Model 的指令。
- 发布必须验证完整 Skill 发现、目标 root/resolved path、可写来源和 scope、已审核 Base 或 expected-absence、Skill 格式、秘密扫描，以及写入后的 DSH 回读。

## 验证纪律

- 每项有行为影响的变更都需要聚焦行为测试，并为跨越的每个 DSH 边界保留集成证据。
- 适用时必须测试正常路径、非法输入、取消、有界重试、并发 trigger、不完整观察、过期 Base、CREATE race、路径逃逸、崩溃一致性和 fail-open。
- PRD 黄金场景是端到端验收路径，不能替代更低层测试。
- 所有结论必须匹配项目精确 HEAD 和记录的 DSH baseline。

## 文档职责

- `docs/roadmap.md`：阶段顺序、阶段门和交付物。
- `docs/product/prd.md`：产品行为、范围和验收。
- `docs/product/requirements-review.md`：需求评审发现、维护者决策和落实追踪。
- `docs/architecture/dsh-compatibility.md`：DSH baseline、源码事实和升级协议。
- `docs/architecture/architecture-input.md`：Architecture Baseline 的固定输入和待回答问题。
- `docs/architecture/baseline.md`：获批的模块职责与稳定技术契约。
- `docs/adr/`：重要且窄的架构决定；不得覆盖 PRD。
- 每条纵向切片在拆实现 Issue 前必须有独立、已评审 Design。
