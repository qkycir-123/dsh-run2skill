# DSH 0.2.0-rc.2 桌面兼容设计

目标上游：官方 `dsh-v0.2.0-rc.2`，commit `639ed015397290b3745d163aafe02ffee4aa3f84`。设计覆盖 Windows x64 官方 Desktop 和相同版本的 Web；运行证据完成前均为候选。

## 范围

沿用现有学习、草稿审核、人工发布、Storage Domain 和默认 Skill roots。目标是候选包能在官方 Desktop 的 `desktop` profile 安装、加载设置、读取会话、学习、审核和保存 Skill，并在重启、禁用、升级及卸载后保持正确数据边界。macOS、Linux、自定义预设或 roots、移动的 master 和自动发布不进入本次 MVP。

## 源码证据与决策

- `apps/desktop-host/src/index.ts` 调用共享 `runProfile`，profile 名为 `desktop`；`apps/desktop/src/paths.ts` 将其插件安装放在 `$DSH_HOME/profiles/desktop`。桌面安装指引使用桌面版自带 dsh，先启动初始化并完全退出，再执行 `dsh plugin --profile desktop add <package>`。
- `apps/desktop/README.md` 的 Installation ownership / Runtime and plugin activation 说明 Desktop 使用 Web 模板的内置 bundles，插件界面和管理通过现有认证 HTTP API；Electron 只向所属 `dsh-app://app` 页面附加宿主认证。插件继续使用 DSH Remote，不另建认证或 Electron IPC 通道。
- 官方 `packages/bundle/web-app/presets/standard.patch.yml` 相比 `0.1.7-rc.2` 未改变。精确 mounted generation 和唯一 filesystem fiber 的核验保持有效；内部 `profile: web` 标识这一共享模板的 root contract，不替代真实安装目录的判断。Desktop 额外 Office provider 由宿主提供，只作为现有 Catalog 的只读输入，不扩大写入根目录。
- 所消费的 Session、SessionPersistence、Skill filesystem、agent-preset-registry 和 Typert 源接口相比旧基线未变。Remote client 新增宿主贡献；插件沿用 query/command descriptor 和 configForms 设置契约。peer/dev 依赖精确提升到 `0.2.0-rc.2`，不能用宽版本范围绕过宿主版本门。
- 官方 Windows feed 的版本是 `0.2.0-rc.2`；下载产物须核对 feed 的 SHA-512、签名和包内 runtime descriptor。公开 tag 是源码契约基线；官方签名产物的构建标识另行记录，不能把二者说成同一个 commit。支持声明须绑定实际验收的产物摘要和 runtime 版本。
- 只解包官方 Windows 产物，不运行系统安装器。启动使用独立 `DSH_HOME`、agents、工作区和随机调试端口。在应用入口执行前，通过主进程调试器核验 `--user-data-dir` 的实际 `app.getPath('userData')`，显式将 `sessionData`、logs 和 crashDumps 指向测试目录，并抑制 `app.setAsDefaultProtocolClient('dsh')` 的系统注册。这是测试环境隔离，不修改官方包文件，也不替换插件、认证或发布逻辑。开始前和结束后检查系统协议关联未改变，退出时确认所属进程已结束。该验收不覆盖系统安装器、默认协议注册和自动更新。

## 实施与验收

1. 先更新版本门和源码契约测试，使旧基线或错误 preset 继续失败；候选版本为 `0.5.0-alpha.3`，未来默认发布标签使用用户要求的 `latest`。已发布 `0.5.0-alpha.2` 仍留给 DSH `0.1.7-rc.2`。
2. 核验新基线源码和真实 runtime 的 Session、Skill、LLM、Settings、Remote、Storage/Profile、加载和刷新；运行 typecheck、lint、完整单元测试及候选包检查。
3. 在实际官方 Windows Desktop 中验证安装、认证页面上的 Run2Skill 设置、query/command、草稿审核与 PROJECT/USER 写入回读；验证重启、禁用、候选升级及卸载保留宿主数据和已保存 Skill。同一版本的 Web 运行必要回归。
4. 模型联调只读取环境变量 `deepseek_key`，不记录其值；缺失时明确停止模型调用验收。任何上游本地补丁不能作为兼容证据。
5. 只在运行证据、CI 和当前提交的 `gpt-6-sol / high` 评审无阻塞问题后填写支持表。npm 发布作为单独动作处理；未发布候选不替换当前 npm 安装指引。

若官方桌面产物的 feed 摘要、签名、runtime 文件完整性或所消费的接口无法核验，先记录精确 artifact 证据并停止支持声明。若出现需要改变发布权限、数据格式或 preset 所有权的断点，返回主会话决策。
