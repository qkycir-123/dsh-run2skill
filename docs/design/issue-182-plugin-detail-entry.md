# Run2Skill 插件详情入口

状态：负责人已确认入口方案；对应 [#182](https://github.com/qkycir-123/dsh-run2skill/issues/182)，实现 #174 的入口项。

## 范围与契约

用户从 **左侧栏 → 插件 → dsh-run2skill 卡片** 打开现有 Run2Skill 页面。页面注册在 DSH `0.2.0-rc.2` 的 `plugins.bundle.config` keyed slot，key 为 npm 组合包名 `dsh-run2skill`。官方插件管理器在组合包详情、组件列表之前渲染这一槽位；它负责卡片、标题、返回与启停控件。源码证据见固定基线的 [PluginManagerPage](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx) 与 [slot 契约](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-plugin-manager/src/client/slot-contract.ts)。

移除 `settings.plugins.tab` 中的 Run2Skill 注册，并把可操作事项提醒中的导航改为“插件 → Run2Skill”。浏览器模块声明插件管理器为加载依赖。现有当前会话/项目解析、审核、整理、自动学习、清理、默认展开与权限行为沿用原实现；不增加侧栏按钮、常驻 Header、通知按钮或数据迁移。插件禁用时页面按原有 Client 生命周期卸载。

## 验收

- 在真实官方 Desktop 中新建空会话，再从插件卡片详情看到 Run2Skill 页面和“暂无可整理的经验”。
- 旧“设置 → 内置插件”中不再出现 Run2Skill 标签页。
- 当前会话/项目切换、待审核草稿、保存、设置和缓存清理沿用现有单元回归；离开详情后组件卸载，停止页面轮询。
- 类型检查、lint、完整单元测试与必要 Desktop 入口探针通过；精确 HEAD 评审无阻塞 finding 后合入。

这是当前源码的未发布入口变更。已发布 `0.5.0-alpha.3` 及更早版本继续使用原设置入口；npm 发布独立处理。
