# DSH 兼容性

`dsh-run2skill@0.1.0-alpha` 当前支持以下官方、未修改的 DeepSeek Harness 版本：

| DSH 版本 | 官方 commit | 结果 |
|---|---|---|
| `0.1.0-rc.8` | `141eb6fef83422698aef7a981029e843e8161534` | 完整契约、原生 UI 槽位/公共组件、存储、发布和真实安装生命周期通过 |
| `0.1.0-rc.7` | `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` | 完整候选验收和原生 UI 槽位/公共组件兼容探针通过 |

核验日期：2026-08-21。

## 当前支持范围

- DSH `web` profile；
- 内置 `standard` 和 `code` agent preset；
- DSH 默认 filesystem Skill provider 和默认 `PROJECT` / `USER` roots；
- Web profile 的 JSON Storage 主路径，以及 SQLite Storage 的兼容对照路径；
- Windows 上的插件 Host、Web Client、Settings、Proposal Inbox、Purge 和 Skill 发布；
- Windows 与 Linux/WSL 上的原子 Skill 发布协议。

以下情况尚未作为 `0.1.0-alpha` 的兼容承诺：

- DSH 的其他 profile；
- 自定义 Skill provider、自定义 Skill roots 或 `includeDefaultRoots=false`；
- 修改过源码或带本地补丁的 DSH；
- 比表中更新、但尚未完成验证的 DSH 版本。

遇到不受支持或无法证明安全的组合时，run2skill 会停止相应的学习、审核变更或发布操作，不会猜测 Skill 写入位置，也不会阻断 DSH 主 Agent。

## 如何验证新 DSH 版本

项目的 `probes/` 目录保留了可复现的兼容性与发布候选探针。维护者可以针对官方、干净、固定 commit 的 DSH checkout 运行它们；探针在临时 clone 中工作，不要求修改 DSH 源码。命令见 [维护者兼容性探针](../probes/README.md)。

新的 DSH 版本只有在相关源码契约、自动化测试、真实候选包安装/禁用/升级/卸载和 Web 行为全部通过后，才会加入上表。仅看到上游发布新版本不等于已经兼容。
