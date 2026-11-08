# DSH 0.2.2-rc.1 兼容设计

适配 npm 默认版 `0.2.2-rc.1`，官方 commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。插件候选为 `0.5.0-alpha.6`，目标为标准 Web profile。

- 使用新宿主的 Cordis 4.1.0、Loader 1.1.0 和 DSH SDK，兼容性测试使用 Node 24.18.0。作用域模块仍由宿主提供，通过真实预设挂载验证作用域身份和代际隔离。
- 官方标准预设调整了文件工具、子代理和插件管理配置。以新版本的官方预设计算摘要，继续校验 filesystem provider、当前代际和 PROJECT／USER 根目录。
- Session 契约验证覆盖事件观察、会话恢复、目录切换和历史记录。Skill 保存继续经过人工审核，并用官方契约探针验证 CREATE／MERGE 及回读。
- Web 验收覆盖插件安装、设置读写、禁用和重新启用、更新及卸载后的存储保留。签名 Desktop 产物走独立验收。
