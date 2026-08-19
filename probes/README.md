# Contract Probe 复现指南

本目录包含可丢弃的架构与发布候选探针，不是 dsh-run2skill 生产实现。探针用于验证固定 DSH baseline 上的集成契约和构建后候选包；运行时创建的 clone、构建产物和日志都位于被 Git 忽略的 `.probe-work/`，不得提交为项目证据。

## 前置条件

- Windows PowerShell 5.1 或 PowerShell 7；
- Git；
- Node.js `^22.19.0 || >=24.0.0`；
- Corepack 与 pnpm 11（DSH baseline 声明 `pnpm@11.7.0`）；
- 可访问 npm registry；首次运行会安装 DSH 依赖；
- Publication CAS 探针还需要 WSL2/Linux，且该环境中有兼容版本的 Node.js；
- Install Lifecycle 探针需要系统已安装的 Microsoft Edge、Google Chrome，或可被 DSH Playwright 找到的 Chromium。

先准备独立、干净、没有本地 patch 的 DSH checkout：

```powershell
git clone https://github.com/deepseek-ai/deepseek-harness.git <dsh-source>
git -C <dsh-source> checkout 99f6f02fecdb7dff40c3fbc9470f5907c29f74ca
git -C <dsh-source> status --porcelain
corepack enable
pnpm --version
```

最后一条 Git 命令应无输出。DSH checkout 可以位于任意目录；探针只要求精确 HEAD 与 clean 状态，不要求 detached branch 或特殊 push 配置。

## 运行

在 dsh-run2skill 仓库根目录执行：

```powershell
powershell -File probes/run-dsh-contract-probes.ps1 -DshSource <dsh-source>
powershell -File probes/run-publication-contract-probe.ps1
powershell -File probes/run-install-lifecycle-probe.ps1 -DshSource <dsh-source>
```

若默认 WSL distribution 不具备 Node.js，显式指定另一个：

```powershell
powershell -File probes/run-publication-contract-probe.ps1 -WslDistribution <distribution-name>
```

第一条命令应结束于 `DSH_SOURCE_AFTER=unchanged` 和 `CONTRACT_PROBES=PASS`，当前全量结果为 6 个文件、17 个测试。第二条应结束于 `CP_PUB_001=PASS`，Windows 与 Linux 各通过 5 个测试。第三条会在一次完整 DSH build 后依次验证基线 fixture 和当前候选包，并结束于 `CP_INS_001=PASS`、`CP_INS_A6=PASS` 和 `INSTALL_LIFECYCLE_PROBE=PASS`。

`pnpm run verify:candidate` 还会精确锁定候选包的 7 个文件，并对仓库、包内容和合成运行日志执行敏感信息门。

## 证据边界

- PASS 只绑定当前 dsh-run2skill commit、文档记录的 DSH commit、测试源码和运行平台；任何一项变化都要重新运行。
- runner 会在执行前后确认传入的 DSH checkout 没有变化。
- 终端输出可以用于 PR 摘要，但不得粘贴绝对路径、完整日志、凭据或私密内容。
- `.probe-work/` 只用于本次运行诊断；它不是可提交的权威证据，也不能替代可复现的源码与命令。
