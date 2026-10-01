# DSH 兼容性

| run2skill | 状态 | DSH 版本 | 官方 commit | 验证边界 |
|---|---|---|---|---|
| `0.5.0-alpha.4` | npm `latest` / `next` 预发布 | `0.2.0-rc.2` | `639ed015397290b3745d163aafe02ffee4aa3f84` | Windows x64 官方 Desktop 和同版本 Web；证据见下文，CI 与精确 HEAD 评审作为合入门 |
| `0.5.0-alpha.2` | 已发布的旧版兼容线 | `0.1.7-rc.2` | `477b4f420553e8a52c2fbccc464d7561b239c443` | CI、精确 HEAD 评审与真实 DSH Web 安装生命周期已通过 |
| `0.5.0-alpha.1` | 未发布 alpha.2 候选 | `0.1.3-alpha.2` | `82a5fd61a7cf5c293cec4bdff68f455398d685e9` | SessionHandle/v2 适配和 alpha.2 探针；未进入 npm 稳定版 |
| `0.4.0` | npm 稳定版 | `0.1.2-rc.1` | `a66e4702047846cdaa10c66c9d3df3951f5ea70d` | 已发布的 Web、Session、Skill、LLM、Settings、Storage/Profile 兼容线 |
| `0.3.1` | 已发布稳定版 | `0.1.1-rc.2` | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | 旧版兼容线 |

核验日期：2026-10-01。各插件版本只针对表中对应的精确 DSH tag；不要跨版本混装。npm 默认 `latest` 与 `next` 均指向 `0.5.0-alpha.4`；DSH `0.1.7-rc.2` 须明确安装 `0.5.0-alpha.2`，DSH `0.1.2-rc.1` 须明确安装 `0.4.0`。

2026-10-01 的实际页面自测发现，会话列表的旧 `current` 读取和动态 Remote namespace 的依赖声明使候选审核页面不可用；此前 HTTP API 验收没有覆盖这两个 Client 边界。候选修正为读取唯一的 `retainedBy.mainView` 会话，并在挂载后注入 `remote.run2skill`。单元回归覆盖真实 Cordis 作用域、项目切换及无唯一会话；Desktop probe 增加实际打开设置页和空会话状态读取。

修正后的实际 Desktop 自测完成：真实 DeepSeek 对话自动生成 PROJECT 草稿，界面修改意见生成精简新版本，人工确认保存后 `SKILL.md` 与新版本审核字节一致。全新同项目会话自主调用原生 `skill` 工具加载该 Skill，并遵守其中的汇报格式；另一个全新数学问答会话直接回答，未调用 Skill。这是一组真实用例，不代表总体复用率或误触发率。

## 0.2.0-rc.2 Desktop / Web 候选

候选精确使用 DSH `0.2.0-rc.2` peers，内部 Web root contract 对应 Desktop 复用的 Web 模板，不代表安装 profile 必须为 `web`。实际安装位置是 `desktop` profile。共享 `standard` 组合摘要未变化，额外 Office provider 只读，Skill 写入仍限定默认 PROJECT/USER filesystem roots。

桌面证据绑定官方 [Windows feed](https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml) 的 `0.2.0-rc.2` 签名产物：

- 安装包大小 `289313640` 字节；SHA-512（base64）`raIlxMQd9ESXgktmViW7QwVLcjBR5JIsrNOu+SpelY8kskdSr2H51/f+ey1EqFI/eIIrKQCuRANMeb5SptRZcg==`。
- Authenticode 有效，签名方 Hangzhou DeepSeek Artificial Intelligence Co., Ltd.；包内 runtime descriptor 为 `0.2.0-rc.2`、Host protocol 4、Node `24.18.1`、pnpm `11.7.0`，`12411` 个 runtime 文件的字节数和 SHA-256 均匹配 descriptor。
- 包内 `dshBuildCommit` 为 `04f392c9ddd144fa426da2045178797da6db6c11`，与公开 tag 不同且未能从公开仓库取到。源码契约和实际签名产物分别固定，不声明安装包由公开 tag 原样构建。

本地通过同版本 Web 完整构建、46 项上游契约测试，以及实际 Desktop 的认证 renderer、设置和 query/command、安装、重启、禁用、候选 probe 版本升级、卸载后保留 Storage 和 Skill。生命周期 probe 的保留 Skill 是 fixture，不代表模型学习或发布验收。真实 DeepSeek Provider 的两轮对话、请求学习、草稿详情和人工批准也已完成：PROJECT 与 USER 均返回 `PUBLISHED`，实际 `SKILL.md` 字节与审核草稿一致。PROJECT 按 DSH 最近 Git 项目边界定位，USER 使用独立 DSH home；测试工作区独立初始化 Git，防止定位上层项目。

实际对话发现系统消息、日志上传回执及模型选择记录会阻断原有投影和 Agent 写入归属检查。候选只增加这三个已知事件的识别；系统内容不成为直接用户证据，模型选择记录不代替 `request/header`，上传回执不成为文件写入证据。未知必需事件继续拒绝。

测试只解包官方程序，独立设置 DSH、Electron 数据和 Documents 工作区，入口前抑制系统协议注册并检查关联始末一致。系统安装器、默认协议关联、自动更新、账号登录，以及 macOS/Linux Desktop 未验收。本次不修改 Storage Domain 格式。旧 npm `0.5.0-alpha.2` 无法安装到新 Desktop；DSH `0.2.0-rc.2` 使用 `0.5.0-alpha.4`。

## 历史版本 0.5.0-alpha.2：DSH 0.1.7-rc.2 范围

- 官方、未修改、精确固定在 `dsh-v0.1.7-rc.2` 的 DSH `web` profile；
- 内置 `standard` agent preset 的官方组合，以及唯一的 filesystem Skill provider 和默认 `PROJECT` / `USER` roots；
- Web profile 的 JSON Storage 主路径；不改变 run2skill 的 Storage Domain 版本或数据格式；
- Windows 的插件 Host、认证 Web Client、设置、草稿审核、清理和 Skill 发布。

其他 DSH profile、自定义 preset/Skill provider/roots、修改过的上游源码及后续 DSH tag 尚无兼容承诺。无法证明 preset 代际、官方组合或安全写入位置时，run2skill 停止相应学习和发布，不影响 DSH 主 Agent。

## 历史迁移：DSH 0.1.3-alpha.2 到 0.1.7-rc.2

Session 持久化继续使用 `list` / `open` 和 read-only `SessionHandle`；rc.2 日志格式为 V4。插件复制只读事件并关闭 handle，保留对已知 `assistant/attempt` 的过滤和未知必需事件的拒绝。live Session 的同步 `snapshotEvents()` 在上游已弃用，因此本候选只承诺该精确 tag。

rc.2 移除了 `dsh-agent-presets`：插件改用 `agent-preset-registry` 的 live mount 和 `acquireScope('standard')` lease。冷会话绑定同代 mount，核对官方组合摘要，再读取其中唯一 filesystem Skill fiber。设置从旧 `settings.register` 改为插件 `Config` 的 volatile 字段；浏览器经 `configForms` 读写，并由 DSH Profile 持久化。

本地已通过固定上游的完整构建、候选包 add/disable/upgrade/uninstall、认证与未认证 Web RPC、浏览器加载、设置读写与跨重启保留。最终兼容结论以本分支完整契约探针、CI 和精确 HEAD 评审为准。复现方法见 [维护者兼容性探针](../probes/README.md)。
