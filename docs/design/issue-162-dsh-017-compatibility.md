# DSH 0.1.7-rc.2 兼容层设计

状态：待评审。目标上游为官方 `dsh-v0.1.7-rc.2`，commit `477b4f420553e8a52c2fbccc464d7561b239c443`。对应 [Issue #162](https://github.com/qkycir-123/dsh-run2skill/issues/162)。

## 目标与边界

在不改变学习、审核、发布、权限、DTO 和 run2skill Storage Domain 语义的前提下，使候选包在这一精确 DSH tag 的 `web` profile、内置 `standard` preset、默认 filesystem Skill provider 与默认 `PROJECT` / `USER` roots 上运行。沿用 Remote/API Gateway 的认证边界；所有审核、清理、发布命令继续经过 run2skill 的业务权限与 revision/digest 校验。新版本未验证前不进入支持表，也不扩大到其他 profile、自定义 preset/root 或移动的 `master`。

复用 [#159 / PR #160](https://github.com/qkycir-123/dsh-run2skill/pull/160) 已通过 alpha.2 探针的 SessionHandle、`assistant/attempt` 和 streamed `assistant/message` 适配；仅对 rc.2 的差异补充测试与变更。PR #160 尚未合入，实施 PR 必须明确包含或依赖其精确提交，不得把它当作 `main` 已有能力。

## 上游契约与适配决策

| 契约 | rc.2 事实 | run2skill 决策 |
|---|---|---|
| 版本门 | DSH 在安装和启动时核对 `@deepseek-ai/dsh-*` peer 版本 | 候选包的 peer/dev 依赖固定到 `0.1.7-rc.2`；移除已不存在的包名。不得用版本豁免掩盖不兼容。 |
| Session | `SessionPersistence.list/open` 和 read handle 仍在；日志格式为 V4；同步 `snapshotEvents()` 已弃用但尚未删除 | 保留 alpha.2 的 detached read/close 适配与未知必需事件拒绝逻辑；新增 V4 和恢复探针。live 读取在迁移到上游推荐接口前不得宣称更广的版本范围。 |
| 预设与 Skill root | `dsh-agent-presets` 已删除；`agent-preset-registry` 暴露 `standingMountFor`、`acquireScope` 和 live mount；内置 `standard` 由 bundle 声明 | live Agent 从确切 mounted generation 和其中唯一 filesystem Skill fiber 读取配置。冷会话先取得 `acquireScope('standard')` lease，再仅从 `lease.key` 对应的同代 live mount 读取组合与唯一 filesystem fiber；不能证明同代身份、官方组合或当前 root 解析时停止学习或发布。作用域 lease 必须在读取与决策结束后释放。 |
| 设置 | `settings.register` 和浏览器 `settingsScope` 已移除；插件 `Config` 的 `.volatile()` 字段由 Profile 保存，浏览器通过 `configForms.get` 读取和写入；`loader/volatile-update` 通知运行时 | 将 `automaticLearning` 声明在 run2skill 插件 Config，保留默认 `true`；Host 读取 volatile 快照并仅在 `false → true` 时唤醒调度。浏览器使用 `configForms.get('run2skill')`，写入失败后回读，保留只读/不可用显示。验证旧 `settings.yaml` 的同名 section 一次性导入及重启保留。 |
| Web 与热刷新 | Remote/API Gateway 仍是认证传输；设置页 slot、插件启停、Client module 装载和热刷新行为变化 | 保持共享 Typert descriptor 与 query/command 分离；验证未认证请求被拒、认证后读写、禁用/重启/升级/卸载和热刷新。不得自建认证通道。 |
| 其余宿主服务 | Skill、LLM、Storage/Profile 与工具/预设组合有改动 | 按真实源码契约与运行探针逐项核验；仅修复 run2skill 实际消费的接口。未知组合 fail closed，不为上游未消费功能扩展产品范围。 |

预设的冷会话核验不能仅依靠名称 `standard`：该名称可由 Profile 覆盖。`readDocument` 读取当前 definition，可能与已取得的 lease 属于不同 generation，因此只供展示，不作为冷会话的安全证据。设计要求从 rc.2 官方 bundle 得到可复现的组合摘要，并在持有 lease 期间从 `lease.key` 指向的 mount 计算、核对该代组合及启用配置；找不到唯一同代 mount 或发现替换竞态时 fail closed。摘要和来源证据写入探针，不能把手工猜出的字符串当作安全证明。live Agent 必须从其实际绑定的 generation 读取，而非当前默认 preset。

## 实施顺序与验收

1. 针对上述断点先写行为测试：版本门、设置读写/启用唤醒、live 与冷会话 preset 绑定、修改过的 `standard`、取得 lease 前后的 generation replacement 竞态、handle 关闭、V4 事件、远端未认证请求。然后做最小宿主适配。
2. 在官方干净、固定 commit 的 DSH 上验证 Session、Skill、LLM、Settings、Remote/Web、Storage/Profile、插件加载与热刷新；root contract、Remote registry round trip、认证 Web 调用均须通过。
3. 用实际候选包验证 add、disable、upgrade、uninstall；检查旧 run2skill 数据和已发布原生 Skill 仍在。运行 typecheck、lint、完整单元测试及候选包验证。
4. 只在以上证据和精确 HEAD 评审、CI 均无阻塞问题后更新兼容性支持表。npm 与 GitHub Release 属后续独立发布动作。

`0.1.7-rc.2` 是候选版，后续 DSH tag 必须重新核验；本设计不以版本号区间代替逐版验证。
