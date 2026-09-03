# DSH 兼容层

状态：`0.4.0` npm 稳定兼容层
更新时间：2026-09-04
上游基线：DeepSeek Harness `0.1.2-rc.1`，commit `a66e4702047846cdaa10c66c9d3df3951f5ea70d`

## 目的

DSH `0.1.2-rc.1` 删除了 run2skill `0.3.1` 使用的私有 `ApiProxy` / `dsh-client-runtime` 通道，并把 Web 调用统一到 Remote/API Gateway 与浏览器认证。`0.4.0` 只替换这一宿主兼容层，不改变 SessionBatch、学习、审核、发布、Storage Domain 或公开产品行为。

## 固定边界

- Host 与 Client 共享同一份 Zod codec 和两条 Typert descriptor：`run2skill/query`、`run2skill/command`。
- query 只接受只读 endpoint；command 只接受会改变 run2skill 状态的 endpoint。路由不匹配、未知字段、非法 payload 和取消一律 fail closed。
- Host 使用 DSH `TypertRemoteService` 挂载；Client 使用 `remote.$mount()`，不自行建立 HTTP、WebSocket 或认证层。
- DSH API Gateway 负责请求传输、一次性启动令牌换取 Cookie 和浏览器会话认证；run2skill 继续负责 DTO、业务权限、revision/digest 和发布安全门。
- Typert Host manifest 与运行时 descriptor 直接复用同一对象，避免手写声明与真实 codec 漂移。
- 外部包当前没有可用的官方自动生成产物，因此 `./typert` 与 `./remote` 是最小手写桥；真实 registry round trip 探针必须证明它与 RC1 Host/Client 图一致。

## RC1 适配点

| 承重契约 | `0.3.1` | `0.4.0` |
|---|---|---|
| Web 请求 | 私有 `/run2skill` loopback RPC | DSH Remote/API Gateway |
| 浏览器信任 | loopback Host/Origin fence | DSH 一次性令牌与认证 Cookie |
| Session 读取 | 公开 events 视图 | `snapshotEvents()` |
| Session 持久化 | 旧 Session 存储组合 | RC1 JSONL Session 日志 |
| Client 加载 | 单插件 bundle 地址 | RC1 client module 组合地址与 revision |
| Skill preset | `standard`、`code` | `standard`；上游已删除 `code` |
| DSH baseline | `0.1.1-rc.2` / `b150a551...` | `0.1.2-rc.1` / `a66e4702...` |

## 版本与数据

`0.3.1` 继续作为 DSH `0.1.1-rc.2` 的维护线；`0.4.0` 面向 DSH `0.1.2-rc.1`，两者不宣称跨 DSH 主线混装。此次变更不提升 `run2skill_v2` Domain version，不迁移或删除既有 run2skill 数据，卸载仍保留 Storage Domain 和已发布原生 Skill。

## 验收

进入支持表前必须同时满足：

1. Session、Skill、LLM、Settings、Web、Storage/Profile、插件加载和热刷新源码/运行探针通过；
2. Remote registry 对共享 descriptor 做真实 encode/decode round trip；
3. 候选包在未修改 RC1 上完成 add、disable、upgrade、uninstall 与认证 Web 调用；
4. typecheck、lint、完整单元测试、候选包验证和精确 HEAD 评审无阻塞问题。
