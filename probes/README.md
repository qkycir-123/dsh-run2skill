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
powershell -File probes/run-dsh-root-contract-probe.ps1 -DshSource <dsh-source>
powershell -File probes/run-publication-contract-probe.ps1
powershell -File probes/run-install-lifecycle-probe.ps1 -DshSource <dsh-source>
```

若默认 WSL distribution 不具备 Node.js，显式指定另一个：

```powershell
powershell -File probes/run-publication-contract-probe.ps1 -WslDistribution <distribution-name>
```

第一条命令应结束于 `DSH_SOURCE_AFTER=unchanged` 和 `CONTRACT_PROBES=PASS`，当前固定 baseline 全量结果为 7 个文件、24 个测试，其中 CP-LLM/Skill 使用固定 fake Adapter，不调用外部模型。第二条是 production-backed CP-ROOT-003，应以 15 个测试通过并结束于 `DSH_SOURCE_AFTER=unchanged`、`CP_ROOT_003=PASS`。第三条直接执行生产 CAS/journal 源码，应结束于 `CP_PUB_001=PASS`，Windows 与 Linux 各通过 8 个测试。第四条会在一次完整 DSH build 后依次验证基线 fixture 和从当前源码实际 pack、再解包得到的候选包，并结束于 `CP_INS_001=PASS`、`CP_INS_A6=PASS` 和 `INSTALL_LIFECYCLE_PROBE=PASS`。

## stock DSH 纯插件 root probe

CP-ROOT-003 是默认生产门禁。production-backed runner 使用本页固定的 clean、未修改 baseline，不要求 DSH fork、未合并 roots API 或本地 patch，覆盖：

- PROJECT/USER 的标准默认 roots、existing/absent root、CREATE/MERGE；
- Workspace/DSH Home identity、版本化 contract digest、文件 identity/expected-absence；
- CAS/journal 后由原生 filesystem provider/source/path winner 和 exact `get()` content 回读确认；
- incomplete snapshot、配置漂移、custom roots、`includeDefaultRoots=false`、重命名 provider/自定义 preset、mounted USER provider 的 `$DSH_HOME` 漂移均 fail closed；
- 卸载插件后已发布 USER Skill 仍由 stock DSH 使用。

固定 baseline 的当前结果为 1 个测试文件、15 个测试通过，并输出 `CP_ROOT_003=PASS`。production Host 通过 stock `standingMountFor(agent.ctx)` 定位 exact Agent 当前 joined generation，并从其 subtree 内真实 `skill-filesystem` fiber 读取唯一 composition witness；探针以同一真实 mount 和启动环境 witness 驱动 provider 与 production resolver。四种 composition 漂移、mounted USER provider 的 `$DSH_HOME` 环境漂移及两条 approved-ancestor identity 漂移恢复分支都经 production root-contract revalidator/saga 在 journal recover、root prepare、write、finalize 和 readback 前进入 `NEEDS_ATTENTION`。切换到新的 stock standing generation 后 USER Skill 仍由原生 filesystem provider 使用；实际包 add/remove 边界仍由 CP-INS-001 独立验证。

## 已放弃的历史实验

历史候选 commit `0fdc7a42a03693c41290d10af1725775af6598ca` 曾验证候选 `snapshot.roots` API；对应测试与 runner 路线已移除，只在证据台账保留历史结论，不是兼容性门禁、生产依赖或 CP-ROOT-003 的替代证据。

`pnpm run evaluate` 会同时运行 Observe 与 Learning 的版本化冻结评测；Learning 评测只输出 case id 和聚合指标，不输出样本正文。`pnpm run verify:candidate` 还会精确锁定候选包的 8 个文件，核对 package/manifest/bundle metadata 与内嵌依赖的第三方许可 notice，并对真实 tarball、仓库和合成运行日志执行 secret、本机路径与 redaction 门。

## 证据边界

- PASS 只绑定当前 dsh-run2skill commit、文档记录的 DSH commit、测试源码和运行平台；任何一项变化都要重新运行。
- runner 会在执行前后确认传入的 DSH checkout 没有变化。
- 终端输出可以用于 PR 摘要，但不得粘贴绝对路径、完整日志、凭据或私密内容。
- `.probe-work/` 只用于本次运行诊断；它不是可提交的权威证据，也不能替代可复现的源码与命令。
