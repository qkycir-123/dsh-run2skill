# 维护者兼容性探针

`probes/` 保留在公开仓库中，是因为它们可以复现项目对 DSH 兼容性、崩溃恢复、候选包内容和安装生命周期的关键声明。普通用户安装或使用插件时不需要运行这些命令。

探针不是生产代码。运行产生的 clone、构建产物和日志只会写入被 Git 忽略的 `.probe-work/`。

## 前置条件

- Windows PowerShell 5.1 或 PowerShell 7；
- Git、Node.js `^22.19.0 || >=24.0.0`、Corepack 和 pnpm 11；
- 可访问 npm registry；
- publication 跨平台探针需要带 Node.js 的 WSL2/Linux；
- 安装生命周期探针需要 Microsoft Edge、Google Chrome 或 DSH Playwright 可用的 Chromium。

准备一个官方、干净、固定 commit 的 DSH checkout。未发布的 `0.5.0-alpha.3` 源码候选验证 `0.2.0-rc.2`：

```powershell
git clone https://github.com/deepseek-ai/deepseek-harness.git <dsh-source>
git -C <dsh-source> checkout 639ed015397290b3745d163aafe02ffee4aa3f84
git -C <dsh-source> status --porcelain
```

最后一条命令应无输出。探针不要求特殊目录布局，也不会向 DSH checkout 写入补丁。

## 运行

在 dsh-run2skill 仓库根目录执行：

```powershell
powershell -File probes/run-dsh-contract-probes.ps1 -DshSource <dsh-source> -ExpectedDshHead 639ed015397290b3745d163aafe02ffee4aa3f84
powershell -File probes/run-dsh-rc2-profile-probe.ps1 -DshSource <dsh-source>
powershell -File probes/run-publication-contract-probe.ps1
```

维护旧兼容线时，使用对应插件版本的探针和精确 baseline，不能仅改变当前探针的 commit 参数。Windows 构建目录应足够短，避免上游 pnpm 的依赖路径超过系统限制。

## 官方 Windows Desktop

从官方 `win-x64/nightly.yml` feed 下载 `0.2.0-rc.2` 安装包，先核对 SHA-512 和 Authenticode 签名，再解包到隔离目录；不要运行系统安装器。使用单独的工具目录安装 Playwright，构建候选后执行：

```powershell
node probes/dsh-desktop/probe.mjs <official-extracted-exe> <candidate-root> <new-work-root> <playwright-module>
```

`new-work-root` 必须尚不存在，并置于 ignored 证据目录。探针在应用入口前核验并设置 Electron 数据路径，抑制系统 `dsh://` 注册，配置默认 Documents workspace 到测试目录，并建立独立 Git 工作区边界，核验协议关联始末一致。它使用官方包内 CLI 操作 `desktop` profile，经实际 `dsh-app://app` 认证页面验证插件、设置、query/command、重启、禁用、同候选内容的不同 probe 版本升级和卸载保留数据。预先完成的 onboarding 设置是生命周期 fixture；该探针不调用模型，不覆盖系统安装器或账号登录。

先退出同一官方 Desktop 程序的其他测试实例，避免内置 Host 端口冲突。探针也会实际进入“左侧栏 → 插件 → Run2Skill 卡片”，检查当前空会话能读取整理状态，并核验“设置 → 内置插件”不再有 Run2Skill 标签页；插件卡片出现或直接 HTTP 调用成功不能替代此项 UI 验收。当前 UI 路径探针使用中文界面。

真实模型验收另用隔离工作区，只从本地环境变量 `deepseek_key` 传入 Provider，工作区须有自己的 Git 边界，避免 DSH 选中上层项目。确认两轮对话、请求学习、草稿详情、人工批准和默认 PROJECT/USER Skill 回读。模型草稿受输入和模型响应影响，不把固定 fixture 数据冒充模型生成结果。实际证据范围见 [兼容性记录](../docs/compatibility.md)。

这些命令分别覆盖：

- Session、Storage、Learning、LLM/Skill Adapter、Remote/API Gateway、Settings 和 Purge 契约；
- 官方 `standard` 组合摘要、真实 Skill registry、默认 `PROJECT` / `USER` roots、Session、LLM、Settings 和 Remote 契约；
- rc.2 Profile 的真实候选包 add、disable、upgrade、uninstall、认证与未认证 Web 调用、Client 加载，以及设置的重启保留；
- Windows 与 Linux/WSL 上的原子发布和崩溃恢复；

旧版 `run-install-lifecycle-probe.ps1` 是 `0.3.1` / DSH `0.1.1-rc.2` 发布线的稳定候选升级探针。维护该版本时仍需显式传入旧 baseline 和精确候选 tarball：

发布稳定版时，把已经完成候选内容扫描、并将用于 npm 与 GitHub Release 的同一个 tarball 传给安装生命周期 runner：

```powershell
powershell -File probes/run-install-lifecycle-probe.ps1 `
  -DshSource <dsh-source> `
  -ExpectedDshHead b150a551b8d465e31e418e1b2eaf5e79bbb7d28e `
  -ReleaseCandidateTarball <dsh-run2skill-0.3.1.tgz> `
  -ReleaseCandidateSha256 <sha256>
```

该 runner 会从 npm 下载已发布的 `0.1.1-alpha`（固定 SHA-256 `c674dad6102426054d59a2843270ee86aecd36789e83604c02dd6efd345fbb26`）、`0.2.0` 和 `0.3.0`，再用传入的精确候选文件验证 `0.1.1-alpha → 0.2.0 → 0.3.0 → 0.3.1`。它会检查旧 v1 数据未被改写、v2 fresh activation 未迁移旧中间项、稳定版升级保留 v2 状态和原生 Skill，以及候选版卸载后数据仍保留。

此外：

```bash
pnpm run check
pnpm run verify:candidate
```

`verify:candidate` 会运行冻结评测和崩溃矩阵，精确检查候选包文件，并扫描许可、secret-like 内容、本机路径和日志脱敏。

## 证据边界

- PASS 只绑定当前 dsh-run2skill commit、指定 DSH commit、测试源码和运行平台；其中任何一项变化都可能需要重跑。
- runner 会在执行前后确认传入的 DSH checkout 保持同一 HEAD 且工作树干净。
- 不要把 `.probe-work/`、完整终端日志、凭据、私人路径或 Session 内容提交到仓库或 Issue。
