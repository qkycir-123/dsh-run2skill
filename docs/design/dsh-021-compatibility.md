# DSH 0.2.1-rc.2 兼容设计

目标：用户授权适配的 npm 默认版 `0.2.1-rc.2`，官方 commit `687f282e8625c6b8d11ff58211a90524be2e4317`。候选插件 `0.5.0-alpha.5`。

## 范围和源码依据

保留现有人工审核、Skill 发布和 Storage Domain 格式；适配标准 Web profile。官方 Desktop 的旧版签名产物证据属于 `0.5.0-alpha.4`，本次不据此声明新版 Desktop 已验收。npm 发布独立进行。

- `packages/core/session/src/types.ts` 仍为 Session v4；SessionPersistence list/open/read/close 契约沿用。新增 plugin records 只作为可忽略的宿主记录，不转成直接用户证据。
- `packages/bundle/web-app/presets/standard.patch.yml` 改变标准组合，更新精确 digest 和依赖版本；自定义预设继续拒绝。
- `packages/session/working-directory/src/index.ts` 明确 header.cwd 为不可变原始项目，当前执行目录另存。跨项目切换会话在本次继续停止学习与发布，不把记录迁入另一个项目。自动跨目录迁移留给后续产品设计。
- `packages/jobs/jobs/src/types.ts` 的 job/registered、job/settled 是后台任务日志；它们不提供直接用户证据，不替代工具结果或 Skill 写入事实。
- `packages/llm/llm/src/index.ts` 的 prepareCall 前两个参数保持兼容；Settings、Typert query/command 和 plugins.bundle.config 继续使用原入口，实际装载由契约与 Web 生命周期验证。
- 原 livePresetMounts/standingMountFor 导出已移除。使用公开 Loader entry 定位 filesystem provider 的树，再以短生命周期子作用域调用 registry.composedPreset，取得同一 scope key 的预设身份；子作用域立即释放。禁止读取 registry 私有 generations/bindings。
- `dsh-scope` 必须由宿主提供，作为精确 peer 并在打包时 externalize，避免复制内部 Symbol 造成作用域身份断裂。
- 上游移除运行时 invariants；移除不再使用的开发依赖，保留我们自己的校验。

## 可测试验收

先写版本、job 记录和目录切换回归测试，再更新实现。完整 check、候选包和 crash 检查通过；官方精确源码上的 Session/Skill/LLM/Settings/Web 合约通过；隔离 Web 完成插件页面/query/command、重启、禁用、更新、热刷新和卸载保留测试。真实模型调用仅使用授权环境变量，若缺失则如实保留未验收项。

升级时旧版根目录摘要可能失效，既有草稿需重新校验；保留已有数据和已保存的原生 Skill。当前版本只在验证通过后填写兼容结论。
