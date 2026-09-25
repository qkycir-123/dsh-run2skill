# DSH 兼容层

状态：`0.5.0-alpha.2` 未发布兼容候选

更新时间：2026-09-25

上游基线：DeepSeek Harness `dsh-v0.1.7-rc.2`，commit `477b4f420553e8a52c2fbccc464d7561b239c443`

## 固定边界

- Host 与 Client 共享 Zod codec 和 `run2skill/query`、`run2skill/command` 两条 Typert descriptor。读写路由、严格 DTO、revision/digest 和发布权限继续由插件验证。
- DSH Remote/API Gateway 承担浏览器传输和一次性启动令牌换取 Cookie 的认证；插件不建立旁路服务。
- 精确支持 DSH Web、官方 `standard` preset、默认 filesystem Skill provider 与默认 Skill roots。自定义组合无法通过代际和摘要核验时停止学习和发布。

## rc.2 适配

| 契约 | 插件做法 |
|---|---|
| Session 持久化 | `list()` 与 `open(id, 'read')`；每次 detached 读取都关闭 handle；V4 的已知 `assistant/attempt` 不进入用户证据，未知必需事件拒绝投影。 |
| live Session | 在本精确 tag 上读取尚存但已弃用的同步 `snapshotEvents()`；新 tag 必须重新验证。 |
| live preset | 从 Agent 实际绑定的 `standingMountFor` 取得 mount；不从当前默认 preset 推断其组合。 |
| 冷会话 preset | `acquireScope('standard')` 保留 generation，查找相同 `lease.key` 的唯一 live mount，核对从官方 bundle 固定的组合摘要，从该代唯一 filesystem Skill fiber 取根目录；结束或失效时释放 lease。 |
| 设置 | 插件 `Config` 声明 volatile `automaticLearning`；Host 响应 `loader/volatile-update`，Client 用 `configForms.get('run2skill')`，DSH Profile 负责持久化及旧 `settings.yaml` 导入。 |
| Web 与热刷新 | Host Typert Remote 和 Client module 经 DSH 加载；认证与未认证请求、禁用、升级、卸载和浏览器资源均由真实 DSH profile 探针验证。 |

run2skill 的 SessionBatch、学习、审核、发布、Storage Domain 与产品权限不变。`0.5.0-alpha.1` 的 alpha.2 适配包含在本分支，rc.2 候选另修 preset 和设置接口；旧 `0.4.0` 与 `0.3.1` 仍按各自 DSH 基线使用。

## 验收

本候选进入[支持表](../compatibility.md)前，须有固定上游 commit 的 Session、Skill、LLM、Settings、Web、Storage/Profile、插件装载和热刷新探针，真实候选包安装生命周期，typecheck、lint、完整测试、CI，以及精确 HEAD 的无阻塞评审。npm 发布另行处理。
