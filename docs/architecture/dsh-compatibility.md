# DSH 兼容层

状态：`0.5.0-alpha.1` 未发布兼容候选
更新时间：2026-09-08
上游基线：DeepSeek Harness `0.1.3-alpha.2`，commit `82a5fd61a7cf5c293cec4bdff68f455398d685e9`

## 目的

DSH `0.1.3-alpha.2` 保留 Remote/API Gateway 与浏览器认证，同时把 Session 持久化改为 `list` / `open` 和生命周期所有的 `SessionHandle`，并使用 v2 会话事件结算。`0.5.0-alpha.1` 只替换这一宿主兼容层，不改变 SessionBatch、学习、审核、发布、Storage Domain 或公开产品行为。

## 固定边界

- Host 与 Client 共享同一份 Zod codec 和两条 Typert descriptor：`run2skill/query`、`run2skill/command`。
- query 只接受只读 endpoint；command 只接受会改变 run2skill 状态的 endpoint。路由不匹配、未知字段、非法 payload 和取消一律 fail closed。
- Host 使用 DSH `TypertRemoteService` 挂载；Client 使用 `remote.$mount()`，不自行建立 HTTP、WebSocket 或认证层。
- DSH API Gateway 负责请求传输、一次性启动令牌换取 Cookie 和浏览器会话认证；run2skill 继续负责 DTO、业务权限、revision/digest 和发布安全门。
- Typert Host manifest 与运行时 descriptor 直接复用同一对象，避免手写声明与真实 codec 漂移。
- `./typert` 与 `./remote` 继续是共享 codec 的最小桥；真实 registry round trip 探针必须证明它与 alpha.2 Host/Client 图一致。

## alpha.2 Session 读取边界

- Host 只接收 alpha.2 的 `ctx.sessionPersistence.list()` 与 `open(id, 'read')` 服务面。
- 每次日志读取使用独立 read handle；`handle.read(fromSeq)` 成功、验证失败或抛错后都必须执行一次 `handle.close()`。
- run2skill 内部流水线继续消费 detached `listSnapshots` / `readFrom` 端口，兼容适配器负责复制 header/events、隔离 backend 错误和维护 handle 生命周期。
- `assistant/attempt` 是 alpha.2 已知结算记录，不进入 direct-user、assistant outcome 或工具证据；未知且非 `ignorable` 的记录仍拒绝投影。

## 兼容线适配点

| 承重契约 | `0.4.0` | `0.5.0-alpha.1` |
|---|---|---|
| Web 请求 | DSH Remote/API Gateway | 不变 |
| 浏览器信任 | DSH 一次性令牌与认证 Cookie | 不变 |
| Session live 读取 | `snapshotEvents()` | 不变 |
| Session 持久化 | service-level `listSnapshots` / `readFrom` | `list` / read-only `SessionHandle` |
| Session 事件 | pre-v2 settlement vocabulary | v2 `assistant/attempt` 与 streamed `assistant/message` |
| Client 加载 | RC1 client module 组合地址与 revision | alpha.2 client module 组合地址与 revision |
| Skill preset | `standard` | `standard` |
| DSH baseline | `0.1.2-rc.1` / `a66e4702...` | `0.1.3-alpha.2` / `82a5fd61...` |

## 版本与数据

`0.3.1` 与 `0.4.0` 继续分别维护 DSH `0.1.1-rc.2` 和 `0.1.2-rc.1`；`0.5.0-alpha.1` 只面向精确 alpha.2 标签，三者不宣称跨 DSH 主线混装。此次变更不提升 `run2skill_v2` Domain version，不迁移或删除既有 run2skill 数据，卸载仍保留 Storage Domain 和已发布原生 Skill。

## 验收

进入支持表前必须同时满足：

1. Session、Skill、LLM、Settings、Web、Storage/Profile、插件加载和热刷新源码/运行探针通过；
2. Remote registry 对共享 descriptor 做真实 encode/decode round trip；
3. 候选包在未修改 alpha.2 上完成 add、disable、upgrade、uninstall 与认证 Web 调用；
4. typecheck、lint、完整单元测试、候选包验证和精确 HEAD 评审无阻塞问题。
