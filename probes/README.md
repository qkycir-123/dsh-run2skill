# 维护者兼容性探针

`probes/` 保留在公开仓库中，是因为它们可以复现项目对 DSH 兼容性、崩溃恢复、候选包内容和安装生命周期的关键声明。普通用户安装或使用插件时不需要运行这些命令。

探针不是生产代码。运行产生的 clone、构建产物和日志只会写入被 Git 忽略的 `.probe-work/`。

## 前置条件

- Windows PowerShell 5.1 或 PowerShell 7；
- Git、Node.js `^22.19.0 || >=24.0.0`、Corepack 和 pnpm 11；
- 可访问 npm registry；
- publication 跨平台探针需要带 Node.js 的 WSL2/Linux；
- 安装生命周期探针需要 Microsoft Edge、Google Chrome 或 DSH Playwright 可用的 Chromium。

准备一个官方、干净、固定 commit 的 DSH checkout。当前默认验证 `0.1.0-rc.8`：

```powershell
git clone https://github.com/deepseek-ai/deepseek-harness.git <dsh-source>
git -C <dsh-source> checkout 141eb6fef83422698aef7a981029e843e8161534
git -C <dsh-source> status --porcelain
```

最后一条命令应无输出。探针不要求特殊目录布局，也不会向 DSH checkout 写入补丁。

## 运行

在 dsh-run2skill 仓库根目录执行：

```powershell
powershell -File probes/run-dsh-contract-probes.ps1 -DshSource <dsh-source>
powershell -File probes/run-dsh-root-contract-probe.ps1 -DshSource <dsh-source>
powershell -File probes/run-publication-contract-probe.ps1
powershell -File probes/run-install-lifecycle-probe.ps1 -DshSource <dsh-source>
```

验证另一个已支持 commit 时，给 DSH 相关 runner 传入 `-ExpectedDshHead <commit>`。

这些命令分别覆盖：

- Session、Storage、Learning、LLM/Skill Adapter、Web RPC、Settings 和 Purge 契约；
- 默认 `PROJECT` / `USER` Skill roots、CREATE/MERGE、并发保护和 Registry 回读；
- Windows 与 Linux/WSL 上的原子发布和崩溃恢复；
- 真实候选 tarball 的 add、disable、upgrade、uninstall 和 Web Client 生命周期。

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
