# dsh-run2skill 需求评审与决策记录

状态：评审完成，v0.1 需求已冻结  
评审日期：2026-08-19  
当前产品文档：`docs/product/prd.md`  
评审输入：v0.1 需求草案  
DSH 证据基线：`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`（`0.1.0-rc.7`）

## 1. 评审结论

初始需求草案的产品方向、v0.1 边界和三个端到端场景成立，但草案同时混入了执行指令、架构任务书、开发流程和源码核验清单，因此不适合作为正式 PRD。

当前处理结果：

- `docs/product/prd.md` 已重写为真正的产品需求文档，只规定问题、用户、目标、范围、行为、状态和验收；
- DSH 源码事实迁入 `docs/architecture/dsh-compatibility.md`；
- 架构问题清单迁入 `docs/architecture/architecture-input.md`；
- 开发顺序和阶段门由 `docs/roadmap.md` 管理；
- 可移植的产品、架构、安全和验证规则由项目 `AGENTS.md` 管理；
- 环境专属的机器目录、凭据、身份和远程操作规则只属于维护者工作区，不进入公开项目仓库。

没有发现会否定 Run-to-Skill 核心方向或要求修改 DSH 源码的证据。

维护者已于 2026-08-19 接受当前需求设计，v0.1 Requirements Freeze 正式生效。后续新增产品能力进入 v0.2/v0.3；v0.1 只在发现歧义、安全缺口或不可实现要求时按变更记录重新评审。

## 2. 第一轮必改项

| 编号 | 已接受结论 | PRD 落实位置 |
|---|---|---|
| R1 | USER Skill 使用有效 `<DSH_HOME>/skills`，不得硬编码用户目录 | 8.6、10.6 |
| R2 | 不完整 Skill 观察不能证明不存在或完整覆盖 | REQ-CUR-003 |
| R3 | `inherit-session` 使用实际 provider/model；没有可继承事实时进入 Needs Attention | REQ-LRN-005 |
| R4 | PROJECT 发布必须有可用 workspace identity，不能猜 project root | REQ-SCP-002、REQ-SCP-003 |
| R5 | Review Decision 与 Publication Outcome 分离 | 11.1、11.2 |
| R6 | CREATE 也绑定 expected-absence，并校验 resolved target | REQ-PUB-002、REQ-PUB-004 |
| R7 | 只能过滤 run2skill 派生数据，不能声称追溯清洗 DSH Session Log | 12.1、12.2 |
| R8 | 发布成功必须经过完整 DSH Registry 观察和 `ctx.skills.get()` 精确回读 | REQ-PUB-006、REQ-PUB-007 |

### R1：有效 DSH Home

USER 目标是：

```text
<DSH_HOME>/skills
```

`DSH_HOME` 按 DSH 当前解析规则确定：显式配置，其次 `$DSH_HOME`，最后默认 `~/.dsh`。`~/.dsh/skills` 只能作为默认示例。

### R2：不完整观察不是缺失证明

`ctx.skills.snapshot()` 可能在 provider 失败或并发目录变化后返回 `complete: false`。该结果可提供候选，但不得支持 CREATE、MERGE、DISCARD 或发布。系统只能有界重试，仍不完整则进入 `NEEDS_ATTENTION`。

### R3：没有模型调用的 Turn

选择顺序固定为：

1. 触发 Turn 最后一次实际 effective provider/model；
2. 同一 Root Session 最近一次实际 effective provider/model；
3. 若都没有，保留 pending 并进入 `NEEDS_ATTENTION`，不得静默选择其他 Provider。

### R4：缺少 PROJECT 身份

若 Session 没有可用 workspace identity，不得猜测 PROJECT root。只有明确且 HIGH 的跨项目意图可以继续形成 USER Proposal，其他情况进入 `NEEDS_ATTENTION`。

### R5：审批不等于发布

产品必须保存两个独立事实：

```text
Review Decision
PENDING | APPROVED | REJECTED

Publication Outcome
PENDING_REVIEW | DISCARDED | NEEDS_ATTENTION |
NEEDS_REFRESH | PUBLISHED | PUBLISH_FAILED
```

### R6：CREATE 与文件系统保护

CREATE Approval 必须绑定 reviewed expected-absence；若后来出现同名 Skill、文件或目录，旧 Proposal 进入 `NEEDS_REFRESH`。路径校验必须基于 resolved target，并阻止 traversal、symlink/junction escape 和未审核 existing target。

### R7：Redaction 的真实边界

DSH Session Log 仍由 DSH 管理。run2skill 只能控制自己的 Store 和 Learning Envelope，且疑似 secret 的 Skill 即使来自 HIGH 用户证据也必须阻止发布。

### R8：DSH 回读

文件写入不是成功证明。必须在同一 cwd/scope 获得 `complete: true` 观察、精确 Skill name 和 `ctx.skills.get()` 审核内容，才可记为 `PUBLISHED`。

## 3. 完整性修正

| 编号 | 已接受结论 | PRD 落实位置 |
|---|---|---|
| F1 | Approval 绑定 immutable Proposal 和精确发布目标 | REQ-REV-007 |
| F2 | Evidence、Diff、Skill 字节按惰性转义文本展示 | REQ-REV-005 |
| F3 | Approve 后显示发布中，并分别展示 Decision、Outcome 和错误 | REQ-REV-008 |
| F4 | Web 审批必须支持键盘和辅助技术 | REQ-REV-006 |
| F5 | MERGE 与 CREATE 一样展示证据来源和坐标 | REQ-REV-003、REQ-REV-004 |

F1 的授权绑定至少包含 Proposal revision/digest、reviewed content、canonical workspace identity、effective root、exact path，以及 MERGE Base 或 CREATE expected-absence。浏览器不能重新提交一份新内容冒充用户审核对象。

## 4. 已接受的产品决定

| 编号 | 已确认决定 | PRD 落实位置 |
|---|---|---|
| D1 | v0.1 只正式支持 `web` profile | 6.1、REQ-REV-001 |
| D2 | 生成 Skill 默认 `modelInvocable=true`、`userInvocable=false` | REQ-PUB-005 |
| D3 | Review Decision 与 Publication Outcome 语义分离 | 11.1 |
| D4 | 采用 MIT License | 15 |
| D5 | Review/Publication RPC 仅限 loopback trusted browser | REQ-PUB-009 |
| D6 | Needs states、Publish Failed 和 Reject 都有明确恢复或确认路径 | 11.2、REQ-REV-009 |
| D7 | 支持按 PROJECT/USER 清除 run2skill 自有数据 | REQ-CFG-003、REQ-CFG-004 |
| D8 | Alpha 使用冻结评测集和明确质量门槛 | 5.2、16 |
| D9 | 显式保存和 HIGH 证据先形成 durable pending，并有可见终态 | REQ-OBS-004、REQ-OBS-005 |
| D10 | 第三条纵向切片必须形成最小安全 Web 审核端到端闭环 | `docs/roadmap.md` 阶段 4 |
| D11 | Dedicated Learning Model 延后到 v0.2+；v0.1 只用 `inherit-session` | REQ-LRN-005、REQ-CFG-002 |

## 5. 已核验的 DSH 前提

需求评审期间确认了以下源码事实：

- durable 执行事实位于 `session/event`，`agent/*` 用于实时协调；
- `Session.append()` 先提交事件，并隔离 observer 的同步异常和异步拒绝；
- `SessionHeader` 可提供 cwd、`parentSession`、subagent origin 和 delegation depth 等身份信息，但字段可能是可选的；
- DSH 原生存在 `SkillCandidate`，run2skill 必须使用 `Skill Proposal` 避免冲突；
- `ctx.skills.list()/snapshot()/get()` 存在，且 snapshot 暴露完整性；
- DSH Skill root、`ctx.llm`、`ctx.settings`、Web client plugin 和 out-of-tree plugin 安装能力存在；
- filesystem Skill provider 具有热刷新能力。

精确版本、来源和更新协议统一由 `docs/architecture/dsh-compatibility.md` 管理，不在 PRD 重复维护。

## 6. 留给 Architecture Baseline 的决定

下列问题不是产品需求，不在本轮冻结：

- SQLite、文件或混合 Store；
- full snapshot 或 delta；
- queue/coalescing 和 retry scheduler 的具体实现；
- package、Adapter 和 RPC 的精确接口；
- structured-output library 和一阶段/多阶段 Learning Pipeline；
- exact atomic write、fsync、journal 和 crash recovery；
- similarity recall 实现与 shortlist 上限；
- browser store、推送和 UI 内部状态管理；
- retention 与 garbage collection 机制。

这些问题必须满足 PRD 的外部行为和安全边界。详细输入见 `docs/architecture/architecture-input.md`。

## 7. 公开协作规则评审

公开项目只携带项目级 `AGENTS.md`，用于约束可共享的产品边界、阶段门、安全、验证和文档职责。机器目录、计算资源、凭据、维护身份和远程操作方式属于维护者环境，不是项目契约，也不得出现在公开仓库中。

可变化的产品状态和阈值不在 AGENTS 重复维护，只链接到 PRD，避免未来产生双重事实来源。

## 8. 后续状态

需求、Architecture Baseline 与切片 A Observe Design 均已接受，基线 Contract Probe 轮次已经完成。下一步按切片 A Design 创建实现 Issues，在 feature branch 上逐项实现并通过 PR 验证；切片 A 集成验收和契约冻结前不开始切片 B 的生产实现。
