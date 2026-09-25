# DSH 兼容性

| run2skill | 状态 | DSH 版本 | 官方 commit | 验证边界 |
|---|---|---|---|---|
| `0.5.0-alpha.2` | npm `latest` / `next` 预发布 | `0.1.7-rc.2` | `477b4f420553e8a52c2fbccc464d7561b239c443` | CI、精确 HEAD 评审与真实 DSH Web 安装生命周期已通过 |
| `0.5.0-alpha.1` | 未发布 alpha.2 候选 | `0.1.3-alpha.2` | `82a5fd61a7cf5c293cec4bdff68f455398d685e9` | SessionHandle/v2 适配和 alpha.2 探针；未进入 npm 稳定版 |
| `0.4.0` | npm 稳定版 | `0.1.2-rc.1` | `a66e4702047846cdaa10c66c9d3df3951f5ea70d` | 已发布的 Web、Session、Skill、LLM、Settings、Storage/Profile 兼容线 |
| `0.3.1` | 已发布稳定版 | `0.1.1-rc.2` | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | 旧版兼容线 |

核验日期：2026-09-25。各插件版本只针对表中对应的精确 DSH tag；不要跨版本混装。npm 默认 `latest` 与 `next` 均指向 `0.5.0-alpha.2`；使用旧 DSH `0.1.2-rc.1` 时须明确安装 `0.4.0`。

## rc.2 候选范围

- 官方、未修改、精确固定在 `dsh-v0.1.7-rc.2` 的 DSH `web` profile；
- 内置 `standard` agent preset 的官方组合，以及唯一的 filesystem Skill provider 和默认 `PROJECT` / `USER` roots；
- Web profile 的 JSON Storage 主路径；不改变 run2skill 的 Storage Domain 版本或数据格式；
- Windows 的插件 Host、认证 Web Client、设置、草稿审核、清理和 Skill 发布。

其他 DSH profile、自定义 preset/Skill provider/roots、修改过的上游源码及后续 DSH tag 尚无兼容承诺。无法证明 preset 代际、官方组合或安全写入位置时，run2skill 停止相应学习和发布，不影响 DSH 主 Agent。

## 从 alpha.2 到 rc.2

Session 持久化继续使用 `list` / `open` 和 read-only `SessionHandle`；rc.2 日志格式为 V4。插件复制只读事件并关闭 handle，保留对已知 `assistant/attempt` 的过滤和未知必需事件的拒绝。live Session 的同步 `snapshotEvents()` 在上游已弃用，因此本候选只承诺该精确 tag。

rc.2 移除了 `dsh-agent-presets`：插件改用 `agent-preset-registry` 的 live mount 和 `acquireScope('standard')` lease。冷会话绑定同代 mount，核对官方组合摘要，再读取其中唯一 filesystem Skill fiber。设置从旧 `settings.register` 改为插件 `Config` 的 volatile 字段；浏览器经 `configForms` 读写，并由 DSH Profile 持久化。

本地已通过固定上游的完整构建、候选包 add/disable/upgrade/uninstall、认证与未认证 Web RPC、浏览器加载、设置读写与跨重启保留。最终兼容结论以本分支完整契约探针、CI 和精确 HEAD 评审为准。复现方法见 [维护者兼容性探针](../probes/README.md)。
