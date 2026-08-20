# dsh-run2skill

`dsh-run2skill` 是一个 DSH-native、local-first 插件。它从真实 DeepSeek Harness 工作中识别用户明确教出的可复用行为，形成有证据的 Skill Proposal，经人工审核和安全校验后发布为原生 DSH Skill。

当前版本是首个公开 Alpha 候选 `0.1.0-alpha`。它只正式支持未修改的 DSH `web` profile，兼容 baseline 固定为 DSH `0.1.0-rc.7` / `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`。本仓库尚未发布 npm 包；下面的安装流程从 GitHub 源码构建本地 tarball。

## 产品边界

- 不修改、fork 或复制 DSH Runtime；
- 不创建新的 Agent、Session、Skill Runtime、Memory、Model Router 或云服务；
- LLM 只提出 Proposal，用户审核和确定性 Core Guards 控制持久发布；
- run2skill 故障不阻断 DSH 主 Agent，发布事实不完整时 fail closed；
- 已发布结果是普通 DSH Skill，禁用或卸载 run2skill 后仍可使用；
- v0.1 只支持 `PROJECT` 和 `USER` scope，以及 DSH 默认 filesystem Skill roots。

## 前置条件

- Git；
- Node.js `^22.19.0 || >=24.0.0`；
- Corepack 与 pnpm 11；
- 一个 clean、未修改且位于上述精确 baseline 的 DeepSeek Harness 安装；
- DSH `web` profile。

先确认 DSH 版本。不要用浮动的 `master` 代替固定 commit，也不要给 DSH 打本地补丁：

```bash
git -C <dsh-source> rev-parse HEAD
git -C <dsh-source> status --porcelain
```

第一条命令必须输出 `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`，第二条命令必须无输出。

## 从 GitHub 源码构建与安装

```bash
git clone https://github.com/qkycir-123/dsh-run2skill.git
cd dsh-run2skill
corepack enable
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
pnpm run verify:candidate
mkdir artifacts
pnpm pack --pack-destination artifacts
dsh plugin --profile web add ./artifacts/dsh-run2skill-0.1.0-alpha.tgz
```

`verify:candidate` 会重建候选包，锁定 tarball allowlist，并扫描候选包和 Git tracked 源码中的 secret-like 内容。安装后重启 DSH `web` profile；DSH 的插件列表中应出现 `dsh-run2skill`，Settings → Plugins 中应出现 run2skill 卡片。

如需在安装前复核完整生命周期，可在仓库根目录执行：

```powershell
powershell -File probes/run-install-lifecycle-probe.ps1 -DshSource <dsh-source>
```

该探针使用一次构建出的真实 tarball，在 disposable DSH clone 中验证 add、disable、upgrade 和 uninstall，不修改传入的 DSH checkout。

## 配置与使用

run2skill 直接复用 DSH 原生 Settings，不创建第二套配置文件。v0.1 只暴露：

```text
automaticLearning: boolean = true
```

在 Settings → Plugins → run2skill 中切换 Automatic Learning：

- ON：普通明确纠正、约束和工作流可以进入学习；
- OFF：暂停新的普通自动学习，但用户显式“保存为 Skill”仍可进入 Proposal Inbox；
- 已开始的 Analysis 使用启动时快照继续完成；
- Proposal 审核、发布恢复和 Purge 不受该开关影响。

Learning 始终继承触发 Session 最后一次实际使用的 provider/model。插件不会保存 Provider key，也不会静默切换 Provider。

Proposal Inbox 是 Action Queue，不是完整历史。批准操作绑定不可变 Proposal、scope、root、target、Base 或 expected-absence；只有 DSH Registry 完整观察和 exact `get()` 回读成功后才会显示 `PUBLISHED`。

## Purge 与数据保留

Settings 卡片提供当前 PROJECT 和整个 USER scope 的 Purge。执行前会展示 preview 和二次确认。

Purge 会删除相应 scope 的 run2skill 派生数据，包括过滤后的 Evidence、Experience、pending WorkItem、Proposal、Review、usage 和 Lineage metadata。它不会删除：

- DSH Session Log；
- 已发布的原生 `SKILL.md`；
- 无法证明属于目标 scope 的数据；
- preview 时间边界之后产生的新数据。

卸载默认保留 `run2skill_v1` Storage Domain 数据。若希望删除 run2skill 自有数据，必须在卸载前先完成 PROJECT/USER Purge。不要通过手工删除 storage 文件代替 Purge。

## 禁用、升级与卸载

完全禁用插件时，在有效 `<DSH_HOME>/profiles/web/cordis.patch.yml` 中为 `run2skill` Host 行设置 `disabled: true`，然后重启 Web profile。重新启用时只移除该行的 `disabled: true`，不要覆盖同一文件中的其他用户配置。

升级前停止 Web profile，备份有效 DSH Home，然后从要安装的 Git commit 重复“构建与安装”步骤。对已安装 package 再执行 `dsh plugin --profile web add <new-tarball>` 会替换插件包；重启后确认 Settings 卡片、Proposal Inbox 和原生 Skill 仍可用。

`0.1.0-alpha` 不提供通用 migration framework。升级遇到不兼容 schema 时，run2skill 会保持停用/降级且不清库，DSH 主 Agent 继续运行。此时恢复原兼容插件版本，或只执行对应版本明确提供、带备份与回退的迁移说明。完整规则见 [v0.1 Storage Schema 与升级兼容性](docs/architecture/storage-schema.md)。

卸载：

```bash
dsh plugin --profile web remove dsh-run2skill
```

卸载后重启 Web profile。已发布 Skill 继续由 stock DSH filesystem provider 发现；run2skill 自有数据仍保留，除非卸载前已 Purge。

## 故障排查

- **插件没有出现在 Web profile**：确认安装的是 tarball，而不是只把仓库作为普通依赖加入；检查包内同时存在 `cordis.patch.yml`、Host `lib/index.js` 和 Client `lib/client.js`。
- **插件显示 pending**：确认固定 DSH baseline 的 `sessions`、`sessionPersistence`、`storageDomain`、`workspaceRegistry`、`connection`、`llm`、`skills`、`settings` 和 `agentPresets` 均已装配。
- **出现 DEGRADED / INCOMPATIBLE**：保留 storage，不要删除或重建；检查精确 DSH baseline 和 schema 版本，再恢复兼容版本或按受评审迁移说明处理。
- **PROJECT 发布不可用**：确认当前 Session cwd 能由 DSH Workspace Registry 解析，且使用默认 `project-dsh` root contract。
- **USER 发布不可用**：确认有效 DSH Home 与 mounted filesystem provider 一致，且未关闭默认 roots 或改用自定义 preset/provider。
- **候选验证失败**：根据失败的 allowlist、metadata、secret 或 redaction gate 修复源码；不要在公开包中加入本机日志、凭据、DSH 源码或临时构建目录。

## 文档

- [产品需求文档](docs/product/prd.md)
- [v0.1 架构基线](docs/architecture/baseline.md)
- [DSH 兼容性基线](docs/architecture/dsh-compatibility.md)
- [v0.1 Storage Schema 与升级兼容性](docs/architecture/storage-schema.md)
- [Slice D 产品化 Design](docs/design/slice-d-productize.md)
- [Contract Probe 复现指南](probes/README.md)
- [项目路线](docs/roadmap.md)

## 开源许可

采用 MIT License，详见 [LICENSE](LICENSE)。Client bundle 内嵌依赖的许可声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
