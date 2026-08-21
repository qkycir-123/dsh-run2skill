# 无感提醒与插件设置页 Design

状态：待评审

对应 Issue：[“仅在需要人工处理时提示，并将 run2skill 持久信息迁入设置” #72](https://github.com/qkycir-123/dsh-run2skill/issues/72)

设计日期：2026-08-21

DSH 源码基线：`deepseek-ai/deepseek-harness@99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`（`0.1.0-rc.7`）

## 1. 结论

run2skill 的正常自动学习过程不占用会话 Header，也不以成功、进度或空闲状态打扰用户。Web 端只在 Host 明确给出“现在存在用户可执行动作”时显示一次 DSH `Toast`；持久详情和所有操作集中到 **设置 → 插件 → run2skill** 独立标签页。

```text
Host durable state
  -> 唯一 Action Queue 投影
     -> Settings 持久展示与操作
     -> Toast 短时提醒和浏览器侧去重
```

关键不变量：

1. 正常状态下，会话 Header 中没有 run2skill 可见元素。
2. Toast 和设置页不得各自推导“需要处理”；二者只消费同一份 Host Action Queue。
3. 没有可执行动作就不提示；未知、加载中或观察不完整不得被当成空队列。
4. 浏览器本地状态只抑制重复 Toast，不能处理、关闭或隐藏 Host 事项。
5. Proposal 仍须人工审核；本设计不增加自动批准或自动发布。

## 2. 范围审计

### 2.1 本设计负责

- 删除两个会话 Header 常驻信息框后的信息架构；
- 定义统一的 Action Queue 与可操作性真值；
- 定义一次性 Toast 的触发、合并、去重和重启行为；
- 定义 run2skill 设置标签页的内容分区和作用域；
- 定义 Client slot 生命周期、权限和隐私约束；
- 给 #70 和 #73 提供呈现契约。

### 2.2 本设计不负责

- 不修复学习模型连续失败；失败分类、重试和关闭能力属于 #70；
- 不改变 Agent 与 run2skill 的单一生成所有者；该状态机属于 #71；
- 不实现 DSH 公共组件、CSS、主题和视觉重构；实现属于 #73；
- 不改变 Cheap Trigger、Learning prompt、Review、Publication、Purge 或存储格式；
- 不增加完整 History、搜索、批量批准、通知中心或遥测；
- 不修改或 fork DSH。

## 3. stock DSH 契约证据

以下证据来自上面的固定 DSH commit；实现时还要对当时支持的全部 DSH 版本运行兼容性探针。

| 契约 | 源码证据 | 设计含义 |
|---|---|---|
| 插件独立设置页 | [`slots.ts` 声明根作用域列表槽 `settings.plugins.tab`](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/client/ui-settings/src/client/contract/slots.ts#L52-L62)；[`ui-settings-plugins` 通过 `ctx.slots.inject` 注册标签页](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/client/ui-settings-plugins/src/client/index.ts#L133-L153) | run2skill 使用正式扩展槽，不深层导入 DSH 私有设置卡片 |
| 标签页生命周期 | [`PluginsSettingsSection` 只在首次选中时挂载标签页，之后用 `hidden` 保持挂载](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/client/ui-settings-plugins/src/client/PluginsSettingsSection.tsx#L33-L109) | 页面切走后本地草稿可保留，但轮询必须自行暂停或降频，不能把“仍挂载”当成“仍可见” |
| Toast 行为 | [`Toast.tsx` 的 `HOLD_MS=3000`、`FADE_MS=1000`、`role="alert"` 和 `onDone`](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/client/ui-primitives/src/Toast.tsx#L8-L54) | Toast 总计约 4 秒、不可交互，只承载短文案，不能放审核或恢复按钮 |
| slot 装配与释放 | [`register` disposer 会移除贡献并递归折叠子槽](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/client/ui-slots/src/index.ts#L707-L736)；`ctx.slots.inject` 等待声明存在 | run2skill 的注册、订阅、轮询、AbortController 和 Toast timer 必须随 plugin fiber 一起释放，不能留下幽灵提醒 |

`settings.plugins.tab` 的 owner props 为空，不提供“打开指定标签页”或“当前是否选中”的公共动作。第一版 Toast 因此只写清导航路径，不伪造点击或深链能力。

## 4. 唯一可操作性真值

### 4.1 Action Queue

Host 从当前可见的 durable state 投影一个裁剪后的 Action Queue。它是 Toast、设置页待处理数量和设置页列表的唯一数据源。

每项至少包含：

```text
actionKey       稳定的提醒/幂等键
subjectId       WorkItem 或全局故障的非敏感身份
kind            REVIEW_PROPOSAL | RETRY_LEARNING | DISMISS_LEARNING |
                REFRESH_PROPOSAL | RETRY_PUBLICATION | DISMISS_FAILURE |
                REPAIR_COMPATIBILITY
reasonCode      稳定、非敏感的原因码
scope           USER | PROJECT | GLOBAL
workspaceRef?   不含路径的项目显示引用
availableActions[]
createdAt / updatedAt
```

`actionKey` 不能直接等于频繁变化的 WorkItem revision。它应由 `subjectId + kind + reasonCode + actionEpoch` 构成或计算摘要；只有可用动作或用户需要理解的原因发生实质变化时才推进 `actionEpoch`。轮询、lease、自动恢复进度和无关 revision 变化不得制造新提醒。

Action Queue 响应还必须显式携带 `completeness: KNOWN | UNKNOWN`。Host storage、兼容性或作用域证据不完整时返回 `UNKNOWN`，Client 不得显示“没有待处理事项”。

### 4.2 真值表

| durable 情况 | 是否进入 Action Queue | 原因 |
|---|---:|---|
| `CAPTURED`、`ANALYZING`、自动重试、`RECOVERING` | 否 | 后台仍能自行前进 |
| 学习成功但尚在自动策展 | 否 | 无用户动作 |
| `READY_FOR_REVIEW` 且 Proposal 可审核 | 是 | 用户必须批准、拒绝或确认 DISCARD 覆盖 |
| 学习失败但仍有自动恢复预算 | 否 | 先让系统自动恢复 |
| 学习失败且 #70 提供了有效的重试或关闭动作 | 是 | 用户现在可以解除阻塞 |
| `PUBLISHING` | 否 | 只是进度，不要求用户介入 |
| `NEEDS_REFRESH` 且可生成/刷新 Proposal | 是 | 用户必须选择恢复路径 |
| `PUBLISH_FAILED` 且存在安全重试或关闭动作 | 是 | 用户可以恢复或结束事项 |
| `DEGRADED` / `INCOMPATIBLE`，但没有明确用户补救动作 | 否 | 健康状态本身不等于可操作事项 |
| 兼容性或完整性故障，且设置页能给出明确补救步骤 | 是 | 用户有真实可执行动作 |
| `DISCARDED`、`PUBLISHED`、已关闭失败 | 否 | 已终结 |

因此，`processingState === NEEDS_ATTENTION`、`learning.needsAttention > 0` 或一个健康码都不能单独触发 Toast。只有 Host 同时证明事项可见、未终结并给出至少一个当前有效动作，才算 actionable。

## 5. Toast 行为

### 5.1 触发

Client 每次取得 `completeness=KNOWN` 的 Action Queue 后，比较当前 `actionKey` 与本运行周期已提醒集合：

1. 没有新 key：不渲染 Toast；
2. 有一个新 key：显示“run2skill 有 1 项需要处理，请前往设置 → 插件 → run2skill”；
3. 同批出现多个新 key：合并为一次数量提醒，并在调度显示时原子地把该批 key 标记为已提醒；
4. Toast 尚未结束时又出现新 key：排队合并成下一次提醒，不叠放；
5. 原事项被处理后从队列消失；若以后以新 `actionEpoch` 重新变得可操作，可再提醒一次。

Toast 只包含非敏感数量和导航路径，不包含 Proposal 内容、失败堆栈、Provider 标识、项目路径或会话摘录。它不可点击，不承担确认、审核、重试或关闭操作。

### 5.2 去重与重启

- 轮询去重：当前浏览器运行周期保存 `seenActionKeys`；同一个 key 无论轮询多少次只提醒一次。
- 并发去重：先登记 key，再挂载 Toast，避免两个完成顺序相反的请求重复显示。
- 重连与标签切换：不清空本周期集合。
- 应用重启或页面完整重建：允许仍未处理的 key 再提醒一次，但新的运行周期内仍只一次。
- 本地集合可以使用内存或会话级浏览器存储；不能写入 Host 事项的处理状态，也不能跨设备宣称事项已处理。

如果 Action Queue 为 `UNKNOWN`、请求失败或数据过期，Client 不弹“有 N 项”或“没有事项”的 Toast；设置页显示安全的暂不可用状态并允许重新读取。

### 5.3 挂载点

第一版可继续把 `session.header.action` 作为当前会话生命周期内的无可见 DOM 挂载点，但贡献组件在无 Toast 时必须返回 `null`，有提醒时只通过 DSH `Toast` 的 body portal 渲染气泡。不得重新引入 Pill、Button、badge 或占位宽度。

没有当前会话时不强求全局 Toast；持久 Action Queue 仍可在设置页查看。若未来 DSH 提供正式全局通知 slot，应另开兼容性变更，不在本设计中猜用内部 shell 节点。

## 6. 设置 → 插件 → run2skill

run2skill 通过 `ctx.slots.inject('settings.plugins.tab', ...)` 注册：

```text
id: run2skill
scope: root
label: run2skill
```

页面按以下顺序组织：

1. **需要处理**：Action Queue 的完整列表、数量、原因和允许动作；Proposal 审核、学习失败恢复、发布失败恢复均从这里进入。
2. **最近活动**：有界展示当前仍保留的 run2skill 记录，只用于理解自动沉淀结果；它不是完整 History，也不承诺跨 Purge/迁移保留。
3. **自动学习**：现有 Automatic Learning 设置及生效语义。
4. **数据管理**：现有 PROJECT/USER Purge、进行中状态、失败恢复和安全说明。

页面必须做到：

- 不要求用户回到产生事项的原会话；
- USER 事项与当前已知 PROJECT 事项可统一发现，但项目只显示 DSH 提供的安全名称或不透明引用，不显示绝对路径；
- 原工作区暂不可用时显示“暂不可执行”及原因，不把它从列表静默移除；
- 列表、详情和 mutation 完成后都重新读取 Host Action Queue；
- 重复点击由现有 revision/CAS/single-flight 边界拒绝或收敛，不产生第二次动作；
- 空态只在 `completeness=KNOWN` 且数量为零时显示。

## 7. 生命周期与刷新

- 注册必须使用 `ctx.slots.inject`，不能假定 `settings.plugins.tab` 在 run2skill apply 时已声明。
- Settings 标签页首次访问前不创建详情轮询；首次访问后虽然 DSH 保持组件挂载，隐藏时仍需暂停高频详情轮询，只保留满足提醒所需的低频 Action Queue 读取。
- 当前会话提醒和设置页共享同一个 Client action source，不能各启一套互不协调的计数器。
- 请求必须支持取消；plugin fiber dispose、连接 reset 和组件卸载时取消请求、订阅和 timer。
- HMR/reload 可以视为新的 Client 运行周期，最多重新提醒一次；不得因旧 fiber 的 timer 或订阅存活而重复提醒。
- mutation 后立即刷新，后台轮询只是兜底，不承担事实提交。

具体轮询间隔、React 组件与 CSS 属于 #73；本设计只冻结生命周期和一致性要求。

## 8. 权限与隐私

- Action Queue、详情和 mutation 沿用 `/run2skill` 的 Host loopback authority；远程或不可信页面不可读取或执行。
- 远程 Client 无权限时显示“请在本机 DSH 中管理”，不得把拒绝解释为空队列。
- Host DTO 只返回渲染和执行所需的裁剪事实；不得返回 API Key、凭据引用值、原始 Session 正文、未过滤 Evidence、绝对路径、模型原始输出或异常堆栈。
- Proposal 正文和 Diff 仍只在 loopback 详情请求中按现有安全/raw 规则展示；Toast 永不携带正文。
- 最近活动不新增会话副本，不扩大 run2skill 现有数据保留范围；Purge visibility predicate 必须同样作用于 Action Queue、详情、数量和活动记录。
- `completeness=UNKNOWN` 时 fail closed：不推断不存在事项，不允许基于不完整列表做批量处理。

## 9. 与 #70、#71、#73 的边界

- **#70** 提供准确学习失败原因、有限重试/关闭动作及安全 DTO；#72 规定这些动作何时进入 Action Queue、在哪里呈现和何时提醒。
- **#71** 决定保存意图的唯一生成所有者；其 `NEEDS_CONFIRMATION` 只有在定义了真实用户选择动作后才进入同一 Action Queue。
- **#73** 实现本设计：删除常驻 Header UI，复用 DSH `Toast`，注册设置标签页并迁移现有 Inbox/Settings/Purge UI；不得修改这里冻结的 Host 行为语义。

#73 可以在 #70 的动作 DTO 尚未完成时先支持 Proposal 和现有发布失败，但不能把暂时不可操作的学习失败伪装成可操作提醒。

## 10. 验收与实现门

后续实现至少覆盖：

1. 正常捕获、分析、成功、自动恢复、空闲和 `PUBLISHING` 时 Header 无 run2skill DOM、无 Toast；
2. Proposal、可恢复学习失败、`NEEDS_REFRESH`、可重试发布失败各产生正确 Action；
3. 同一 actionKey 连续轮询、重连和标签切换不重复；批量新事项只显示一个合并 Toast；
4. actionEpoch 实质变化后可再次提醒；事项终结后不再提醒；
5. 完整重启后未处理事项最多再提醒一次，旧 fiber 不留下 timer/订阅；
6. `UNKNOWN`、RPC 失败和不可信远程浏览器不显示假空态，也不能 mutation；
7. 设置页无需原会话即可查看全部允许范围的事项，并能完成现有审核、恢复和 Purge；
8. Action Queue、列表、详情和 mutation 全部应用相同 Purge visibility、作用域和 Host 权限；
9. Toast、RPC、设置页和日志不泄露密钥、正文、路径或原始模型输出；
10. stock DSH rc.7/rc.8 的 slot、Toast 和生命周期兼容性探针通过。

本 Design 获批前不进入 #73 实现；实现不得为了视觉便利修改 #70/#71 的状态机或放宽现有 Review/Publication 安全边界。
