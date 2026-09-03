# DSH 兼容性

run2skill 按 DSH 主线分成两条明确的兼容线：

| run2skill | 状态 | DSH 版本 | 官方 commit | 结果 |
|---|---|---|---|---|
| `0.4.0` | npm 稳定版 | `0.1.2-rc.1` | `a66e4702047846cdaa10c66c9d3df3951f5ea70d` | Remote/API Gateway、认证 Web、Session、Skill、LLM、Settings、Storage/Profile 与根目录契约通过 |
| `0.3.1` | 已发布稳定版 | `0.1.1-rc.2` | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | 完整契约、原生 UI、存储、发布和真实安装生命周期通过 |

核验日期：2026-09-04。

`0.4.0` 是 DSH `0.1.2-rc.1` 的当前 npm 稳定版。`0.3.1` 继续只支持 DSH `0.1.1-rc.2`；不要跨两条 DSH 主线混装。

## `0.4.0` 当前支持范围

- 官方、未修改的 DSH `0.1.2-rc.1` `web` profile；
- RC1 保留的内置 `standard` agent preset；
- DSH 默认 filesystem Skill provider 和默认 `PROJECT` / `USER` roots；
- Web profile 的 JSON Storage 主路径，以及 SQLite Storage 的兼容对照路径；
- Windows 上的插件 Host、认证 Web Client、Settings、技能草稿审核、数据清理和 Skill 发布；
- Windows 与 Linux/WSL 上的原子 Skill 发布协议。

DSH RC1 已删除旧 `code` preset，因此它不属于 `0.4.0` 的支持范围。`0.3.1` 在旧 DSH baseline 上的 `standard` / `code` 支持不受影响。

以下情况尚未作为 `0.4.0` 的兼容承诺：

- DSH 的其他 profile；
- 自定义 Skill provider、自定义 Skill roots 或 `includeDefaultRoots=false`；
- 修改过源码或带本地补丁的 DSH；
- 比表中更新、但尚未完成验证的 DSH 版本。

遇到不受支持或无法证明安全的组合时，run2skill 会停止相应的学习、审核变更或发布操作，不会猜测 Skill 写入位置，也不会阻断 DSH 主 Agent。

## RC1 的重大变化

DSH `0.1.2-rc.1` 删除了 `0.3.1` 依赖的私有 `ApiProxy` / `dsh-client-runtime` 通道，改为 Remote/API Gateway、一次性浏览器启动令牌与认证 Cookie；Session 查询、持久化、Client bundle/Profile 和 stock preset 契约也发生变化。因此必须使用新的 `0.4.0` 兼容层，不能只修改依赖版本。架构证据见 [`docs/architecture/dsh-compatibility.md`](architecture/dsh-compatibility.md)。

## 如何验证新 DSH 版本

项目的 `probes/` 目录保留了可复现的兼容性与发布候选探针。维护者可以针对官方、干净、固定 commit 的 DSH checkout 运行它们；探针在临时 clone 中工作，不要求修改 DSH 源码。命令见 [维护者兼容性探针](../probes/README.md)。

新的 DSH 版本只有在相关源码契约、自动化测试、真实候选包安装/禁用/升级/卸载和 Web 行为全部通过后，才会加入对应版本的支持表。仅看到上游发布新版本不等于已经兼容。
