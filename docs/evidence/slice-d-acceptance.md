# Slice D / D5 v0.1 Alpha 发布候选验收记录

日期：2026-08-21

结论：**READY**。`dsh-run2skill v0.1.0-alpha` 已达到代码发布候选标准；本结论不表示已经创建 tag、GitHub Release 或 npm publish。

## 1. 绑定范围

| 事实 | 固定值 |
|---|---|
| 最终产品代码候选 HEAD | `f9c1e2627a7680a31afaf69f5830b3ea44693dad` |
| 候选版本 | `0.1.0-alpha` |
| DSH baseline | `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` / `0.1.0-rc.7` |
| Windows | Microsoft Windows 10.0.26200 x64 |
| Windows Node / pnpm | Node `v24.18.0` / pnpm `11.19.0` |
| Linux 对照 | WSL2 Linux 6.18.33.2 x86_64；Node `v22.23.2` |

本记录验收的是 D1–D4 合并后的最终产品代码候选。D5 PR 只增加本证据文档，不改变运行时代码、测试、package、schema 或 DSH baseline。PR 的 exact-HEAD CI 与本地审查仍是第 8 节的独立最终门。

受保护 DSH checkout 在所有相关 runner 前后均满足：精确 baseline、detached、clean、无本地 patch；runner 只在被忽略的 disposable clone 和临时目录中写入。最终后置检查仍为 `DSH_SOURCE_AFTER=unchanged`。

## 2. 结论摘要

| 验收面 | 结果 | 证据类型 |
|---|---|---|
| clean GitHub source clone / frozen install / check / build / pack | PASS | 远端源码新 clone；自动化 |
| package allowlist、许可、metadata、secret、本机路径、日志脱敏 | PASS | 真实 tarball；自动化 |
| typecheck、lint、全量 unit/integration、冻结 evaluation、crash matrix | PASS | 自动化 |
| JSON 主路径、SQLite 对照、schema/restart/recovery | PASS | 固定 DSH production-backed 契约 + 自动化 |
| Settings、Purge、Inbox/Header、Learning/Publication | PASS | 固定 DSH 组合、真实 Web/Chromium、自动化 |
| PROJECT/USER、CREATE/MERGE、conflict、readback、卸载保留 | PASS | stock DSH root contract + Windows/WSL CAS + 生命周期 |
| add / disable / upgrade / uninstall | PASS | 当前候选 tarball；真实 DSH Web/Chromium |
| D3 UI/a11y 与 polling | PASS | 确定性浏览器 DOM 集成 + 真实 Chromium spot check |
| 公开仓库内容 | PASS | tracked source / tarball 扫描与人工边界复核 |
| 真实 Provider 补充 smoke | 未执行 | 非 D5 主门；不影响 READY |

没有发现需要在 Issue #60 内修改产品行为、安全或 durable 数据契约的缺陷。

## 3. clean GitHub source clone 与候选安全

从公开 GitHub 仓库新 clone，detached 到本记录的产品候选 HEAD，并在该 clone 中执行：

```powershell
git clone https://github.com/qkycir-123/dsh-run2skill.git <clean-source>
git -C <clean-source> checkout --detach f9c1e2627a7680a31afaf69f5830b3ea44693dad
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
pnpm pack --pack-destination .probe-work/manual-pack
pnpm run verify:candidate
pnpm audit --prod --audit-level high
git status --porcelain
```

结果：

- frozen install 成功，未改 lockfile；clone 最终仍 clean；
- `pnpm run check`：63 个测试文件、480 项测试通过；另有 8 项 publication CAS 测试通过；
- Host、Client 与类型产物构建成功；
- tarball 精确包含 8 个文件：`package.json`、`cordis.patch.yml`、`LICENSE`、`README.md`、`THIRD_PARTY_NOTICES.md`、`lib/index.js`、`lib/index.d.ts`、`lib/client.js`；
- package version、Host/Client exports、`dsh.bundle.patch`、`dsh.client`、DSH peer baseline 和 Node engine metadata 一致；
- 第三方许可 notice 完整；候选 tarball 和 tracked source 的 secret、私有材料、本机路径与 synthetic runtime log redaction 门通过；
- 生产依赖审计结果为 `No known vulnerabilities found`。

`verify:candidate` 只认可上述 allowlist。构建目录、测试、probe、私有材料、DSH 源码、ignored 诊断和本机路径均未进入 tarball。

## 4. 自动化、冻结评测与 crash/recovery

主命令：

```powershell
pnpm run check
pnpm run verify:candidate
```

结果：

- typecheck 通过；oxlint 以 `--deny-warnings` 通过；
- 63 个 unit/integration 测试文件、480 项测试通过；
- publication CAS 8 项通过；
- Observe 冻结集：45 个样本，precision、recall、显式保存 recall、普通无信号率均为 `1.0`；
- Learning 冻结集：20 个场景，Experience Type、Scope、Curation、安全阻断均为 `1.0`；
- Observe durable crash matrix：4 个提交/恢复边界通过；
- Purge 的成功、失败、每个 durable phase、restart、completed fence、old gap、迟到 classification、1024 PROJECT fence、visibility 和新数据边界由全量测试覆盖；
- Publication 的 CREATE/MERGE race、stale Base、崩溃、unknown hash、torn journal、路径逃逸和 readback 前 backup 由全量测试与 CP-PUB-001 共同覆盖。

schema mismatch 证据分两层：运行时 strict schema 测试证明 Global、WorkItem、Lineage 非法版本/字段不被当成空记录；固定 DSH Storage Domain 探针证明 backend/domain/open/restart 失败保持结构化失败。当前已知的测试精度增强见 #66，不改变运行时 fail-closed 契约，也不阻塞本候选。

## 5. 固定、未修改 DSH baseline

### 5.1 完整组合契约

```powershell
& .\probes\run-dsh-contract-probes.ps1 `
  -DshSource <clean-dsh-source> `
  -TestFiles @(
    'session-storage.spec.ts',
    'a3-storage.spec.ts',
    'a4-recovery.spec.ts',
    'a5-observe-summary.spec.ts',
    'b2-learning-window.spec.ts',
    'llm-skills.spec.ts',
    'web.spec.ts',
    'd2-purge-storage.spec.ts'
  )
```

结果：8 个文件、26 项测试通过，`CONTRACT_PROBES=PASS`，`DSH_SOURCE_AFTER=unchanged`。

该矩阵使用 DSH 的真实 Session Persistence、Storage Domain、Settings/Connection/Skill/LLM/Web 契约和 production run2skill 源码，覆盖：

- Web JSON/JSONL 主路径与 SQLite 对照路径的 open、write、close、restart 和 recovery；
- Session gap/restart、Settings namespace 与 live mutation 边界；
- PROJECT/USER Purge 的 production Store/visibility、completed fence 与 backend 对照；
- Inbox/Header RPC、loopback fence、Learning route、完整 Skill observation 和 publication readback seam；
- incompatible/missing backend 不被解释为空数据，DSH 主 Agent 保持 fail open。

### 5.2 stock DSH root contract 与四条黄金回归

```powershell
powershell -File probes/run-dsh-root-contract-probe.ps1 -DshSource <clean-dsh-source>
powershell -File probes/run-publication-contract-probe.ps1
```

结果：

- CP-ROOT-003：1 个文件、15 项 production-backed 测试通过，`CP_ROOT_003=PASS`；
- CP-PUB-001：Windows 8 项、WSL/Linux 8 项通过，`CP_PUB_001=PASS`；
- 受保护 DSH checkout 前后不变。

四条已批准黄金路径的回归对应如下：

1. **CREATE · PROJECT**：stock filesystem `project-dsh` root、expected-absence、CREATE CAS、complete snapshot 与 exact `get()` readback 通过；
2. **MERGE**：同 Scope Base、MERGE CAS、Lineage/readback 关键路径通过；
3. **Base Conflict**：stale Base 与 cutover race 保留用户 bytes，并 fail closed 为 conflict/refresh 路径；
4. **CREATE · USER**：stock filesystem `user-dsh` root、exact readback、新 standing generation 可用及卸载后原生 Skill 保留通过。

这是 keyless、可复现的 production-backed 回归，不把 fake LLM 输出冒充真实模型质量。Slice C 已记录的真实 Provider 四场景证据仍见 `docs/evidence/slice-c-acceptance.md`；本轮未再次消费外部模型。

## 6. 当前候选 tarball 生命周期与真实 Web

```powershell
powershell -File probes/run-install-lifecycle-probe.ps1 -DshSource <clean-dsh-source>
```

结果：`CP_INS_001=PASS`、`CP_INS_A6=PASS`、`INSTALL_LIFECYCLE_PROBE=PASS`。

runner 先完成 DSH frozen install 和完整 Host/Client/Web build，再分别验证基线 fixture 与从当前源码 pack、解包得到的真实候选：

- add 后 profile dependency、bundle、Host RPC、Client route 和浏览器执行均存在；
- 真实 DSH Web 的 Settings → Plugins 出现 run2skill 卡片；原生 `automaticLearning` mutation 成功，升级后保持先前值；
- 真实 Chromium 打开 USER Purge `alertdialog`，确认保留 DSH Session Log 与所有已发布原生 Skill，Escape 关闭后焦点恢复；
- disable 后 Host、Client、RPC 与启动组合均不可达；
- upgrade 到候选 v2 fixture 后 Host/Client 重新可用，run2skill Storage Domain 仍存在；
- uninstall 后 package dependency、bundle、Host 与 Client 全部移除；run2skill storage 保留；预置的原生 `SKILL.md` exact bytes 不变；
- 最终 DSH source 仍为精确 baseline 且 clean。

## 7. D3 Web UI / a11y

确定性本地数据矩阵：

```powershell
pnpm exec vitest run `
  tests/proposal-inbox-browser.spec.ts `
  tests/proposal-inbox.spec.ts `
  tests/purge-settings-ui.spec.ts `
  --reporter=verbose
```

结果：3 个文件、25 项测试通过，覆盖：

- Inbox 与 Purge `alertdialog` 的 accessible name、初始焦点、Tab/Shift+Tab focus trap；
- Escape 取消、嵌套对话框边界、关闭后焦点恢复和外部 focus recapture；
- publishing、失败与完成状态的 `aria-live`；
- immutable preview/ref、single-flight、busy/stale/retry 和重复 mutation 抑制；
- Inbox 与 Purge idle 10 秒、active 2 秒 polling；hidden 时停止，恢复可见、focus、reconnect 后立即刷新；
- safe/raw、Diff、UNKNOWN/RECOVERING/DEGRADED/INCOMPATIBLE 文案。

这些是 jsdom 浏览器 DOM 集成测试；第 6 节另用真实 Chromium 验证 DSH Web 装载、Settings、Purge alertdialog、Escape 和焦点恢复。未把 jsdom 结果描述成完整像素或多浏览器视觉验收。

## 8. 公开仓库审计、已知 backlog 与最终门

公开边界审计结果：

- tracked 文件不含本机绝对路径、个人邮箱、发布 token 环境变量、私有工作区/服务器名称或转交材料；
- tracked 文件不包含 sibling DSH checkout、`.probe-work`、`node_modules` 或 vendored DSH 源码；
- package/README 的 clone、frozen install、build、pack、disable、upgrade、uninstall、baseline、Purge 保留和 schema mismatch 限制与实际 runner 一致；
- README 没有声称 npm 已发布，也没有把 READY 描述为已创建外部 Release；
- synthetic secret fixture 和凭据变量名只用于 redaction/安全契约；候选 scanner 验证其值不会进入公开包或日志。

已知非阻塞 backlog：

- #66：用“其余字段均有效”的最小 fixture 更精确地单独锁定三类 `schemaVersion: 1` 失败原因；
- #67：把候选路径 scanner 从当前已知路径扩展到更通用的 Windows drive、UNC、`/tmp`、`/workspace` 与 `/usr/local` 模式。

两项均不改变当前运行时 schema、安全行为或已实际复核的候选包内容，按既有 Issue 独立处理；D5 不提前实现。

本记录写入后，Slice D 仍需对 D5 PR 的精确当前 HEAD 满足：

1. GitHub CI 全部通过；
2. 本地只读 `gpt-5.6-sol` / `high` exact-HEAD 审查无符合项目阻塞标准的 finding；
3. 若因阻塞 finding 修改并 push，必须在新 exact HEAD 重跑受影响门和同规格审查。

满足后可将 Issue #60 / Slice D 判为完成并 squash merge。仍未授权、也未执行：tag、GitHub Release、npm publish、DSH baseline 升级、DSH 源码修改或任何外部发布动作。

## 9. 未执行项与证据边界

- **真实 Provider smoke：未执行。** 环境是否具备凭据不改变本轮决定；D5 主门被设计为 keyless、可复现，真实模型只作补充。没有读取凭据值，也没有打印、持久化或切换任何 Provider 凭据。
- **外部发布：未执行。** READY 只表示代码候选通过，不表示用户已经获得 registry 包或 Release artifact。
- **多 Host、非 web profile、自定义 root、远程审批、migration framework、History/Retention/Rollback：未执行且不在 v0.1 支持范围。**
- `.probe-work` 中的 clone、构建日志与浏览器状态只用于本次诊断，不提交，也不作为独立权威证据；可复核证据是本记录绑定的源码、命令、测试和固定 DSH commit。
