# dsh-run2skill v0.1 Contract Probe 证据台账

状态：既有基线探针轮次已完成；stock-DSH 纯插件 root probe 为 NOT_RUN
更新时间：2026-08-20
DSH baseline：99f6f02fecdb7dff40c3fbc9470f5907c29f74ca（0.1.0-rc.7）

## 1. 目的与边界

本文记录 Architecture Baseline 第 22 节所列承重契约的运行证据。Probe 只能验证或推翻架构假设，不得变成生产实现捷径。

固定规则：

- DSH 核验 checkout 位于精确 baseline commit、状态 clean，且没有本地 patch；
- Probe 代码位于 dsh-run2skill 仓库的 probes/，不得 patch DSH；
- 每个 Probe 必须有明确输入、预期、实际结果、证据命令和清理边界；
- PASS 只对本文记录的精确 DSH commit、操作系统和运行组合有效；
- SOURCE-CONFIRMED 不是 PASS；仍需运行证据的项目不能据此解除阶段门；
- FAIL 必须回写 Architecture，不得用未评审 workaround 隐藏；
- Probe 不执行 git add、commit、push 或 PR。

## 2. 状态词汇

| 状态 | 含义 |
|---|---|
| NOT_RUN | 尚未执行 |
| RUNNING | 正在取得运行证据 |
| PASS | 预期行为在固定环境中得到可复核证据 |
| PARTIAL | 只证明了部分平台、路径或故障分支 |
| FAIL | 承重假设被推翻 |
| BLOCKED | 缺少当前环境无法安全取得的外部条件 |
| HISTORICAL | 只保留已放弃路线的历史结果，不解除当前阶段门 |

## 3. 总表

| ID | 契约 | 当前状态 | 解除的阶段门 |
|---|---|---|---|
| CP-SES-001 | turn/end、observer 隔离、Root identity、持久日志 gap scan、释放 | PASS（Windows） | Slice A 的 Session 门已解除 |
| CP-STO-001 | Storage Domain、durable pending、重启、写序列和错误 | PASS（Windows） | Slice A 的 Storage 门已解除 |
| CP-LLM-001 | inherit-session one-shot stream、usage、cancel、结构化修复、无 Tools | PASS（Windows） | Slice B 的 LLM 门已解除 |
| CP-SKL-001 | snapshot complete、cwd/scope、rank、get、skills/change、热回读 | PASS（Windows） | Slice C 的 catalog 门已解除 |
| CP-ROOT-001 | Workspace/project-dsh 与 effective DSH Home/user-dsh 组合 parity | PARTIAL（Windows；历史） | 证明默认组合算法；不再等待 provider roots API |
| CP-ROOT-002 | 候选 DSH roots API 实验 | HISTORICAL（曾在 Windows PASS） | 已放弃的历史实验；不是默认门禁或生产证据 |
| CP-ROOT-003 | stock DSH 纯插件 root contract、PROJECT/USER 写入与原生 exact readback | NOT_RUN | Issue #48/C7 前必须取得运行证据 |
| CP-PUB-001 | Windows/Linux CREATE/MERGE CAS、race、crash、路径逃逸与恢复 | PASS（Windows + WSL/Linux） | Slice C 的文件 CAS 门已解除 |
| CP-WEB-001 | 外部双面插件、header slot、loopback RPC、远程/cross-origin 拒绝 | PASS（Windows） | Slice C 的 Web seam 门已解除 |
| CP-INS-001 | add、web profile、disable、upgrade、uninstall及 Skill 保留 | PASS（Windows probe package） | 包形态契约通过；Alpha 候选必须复跑 |

## 4. 通用环境证据

执行前后都要记录：

```text
DSH HEAD
DSH git status --porcelain
Node/pnpm/DSH launcher version
Windows 或 Linux/WSL 版本
Probe run ID
```

环境输出不得包含 token、API key、Authorization header 或用户私密内容。

## 5. Probe 记录模板

每个 CP 使用以下格式追加证据：

```text
状态：
环境：
输入：
预期：
步骤：
实际：
失败注入：
证据命令：
清理：
结论：
架构影响：
```

## 6. 当前执行顺序

1. CP-SES-001 与 CP-STO-001：先证明 durable signal 基础；
2. CP-LLM-001：证明受限 Learning 调用；
3. CP-SKL-001 与 CP-ROOT-001：保留 lookup、scope 和默认组合历史证据；
4. CP-WEB-001：证明 Human Review 的本机信任边界；
5. CP-PUB-001：在前述身份事实成立后验证发布 CAS；
6. CP-INS-001：验证完整安装生命周期；
7. CP-ROOT-003：Issue #48 实现后，在固定 stock DSH baseline 验证纯插件发布 root contract，再进入 C7。

## 7. 运行记录

### CP-SES-001

状态：PASS（Windows）  
环境：DSH 99f6f02；Windows NT 10.0.26200.0 x64；Node v24.18.0；pnpm 11.19.0。  
输入：一个无 `origin/delegationDepth` 的 Root Session、一个带 `origin=subagent` 和 `delegationDepth=1` 的 Child Session、两个完整 turn、一个故意抛错的同步 observer；同一用例分别运行 Web profile JSONL 与 SQLite Session Persistence。  
预期：observer 故障不影响 append；Root/Child 由强事实区分；snapshot revision 随追加变化；重启后可 list/load，并能从已保存 seq 水位读取缺口；owner 释放后两个 live session 均消失。  
步骤：分别挂载 JSONL 目录与 SQLite 文件；创建并 flush 第一 turn，保存 `checkpoint=2` 和 snapshot revision；追加并 flush 第二 turn；创建 Child；释放 owner 和 persistence；在新 Context 中重新挂载同一介质，执行 `list/load/readFrom(checkpoint)`。  
实际：两个 backend 均容纳故障 observer，revision 均随追加变化；重启后 Root 事件 seq 为 0..3，`readFrom(2)` 精确返回 seq 2..3，Child lineage 元数据保留。另确认 live Root 的 `delegationDepth` 可缺失，而 Web JSONL 会在重载时将其规范化为 `0`；Root 规则必须把缺失与 0 视为等价。DSH 生命周期按栈释放，产品不得依赖多个 Session 的释放通知顺序。  
失败注入：同步 `session/event` observer 抛错。  
证据命令：`powershell -File probes/run-dsh-contract-probes.ps1 -DshSource <path-to-clean-dsh-checkout>`；最终全量结果为 3 个文件、9 个测试全部通过，并输出 `DSH_SOURCE_AFTER=unchanged`、`CONTRACT_PROBES=PASS`。  
清理：测试自己的临时 JSONL/SQLite 目录由 afterEach 删除；可丢弃 clone 位于 Git 忽略的探针工作目录，不属于发布内容。  
结论：实时观察、Root/Child 强事实、revision 水位和 `readFrom` 可组成 v0.1 的冷启动 gap scan；异步工作仍必须进入插件自有队列。Web JSONL 的顺序读取可能解析整个 artifact，产品只能约束返回后缀和处理批次，不能承诺单次物理读取字节严格有界。  
架构影响：确认 Baseline 8.2、8.4 和 16.1；补充“不依赖跨 Session dispose 顺序”的实现约束。

### CP-STO-001

状态：PASS（Windows）  
环境：DSH 99f6f02；Windows NT 10.0.26200.0 x64；Node v24.18.0；pnpm 11.19.0。Web profile 源码明确装配 Storage Hub + Storage Domain + `storage-json`；同一测试另跑 SQLite 作为可移植性对照。  
输入：`run2skillprobe` domain、`workitems` table、一个计数记录、40 个并发 update、两个在 close 前已入队的 put，以及 missing-key update；分别使用 JSON 目录和 SQLite 文件。  
预期：两种 backend 都应保证同 key 更新无丢失；非法 missing-key 以结构化错误失败；close 排空已入队写；完全重挂后全部记录可恢复。  
步骤：对 JSON 主路径和 SQLite 对照路径分别写入 count=0，并发执行 40 次 `update`；验证 missing-key；提交 alpha/beta 后立即 close；完全卸载并在新 Context 重挂同一介质。  
实际：两个 backend 的 count 都最终为 40；missing-key 都返回 `DomainError/missing-key`；close 后 alpha/beta 均已落盘；重启后 counter、alpha、beta 的值和 key 集合完全一致。JSON backend 还由上游源码与自带测试证明采用原子整文件发布，并在发布失败时回滚内存快照。  
失败注入：missing-key；并发同 key 更新；写入与 close 排空竞争。  
证据命令：`powershell -File probes/run-dsh-contract-probes.ps1`；最新全量结果为 3 个文件、9 个测试全部通过，并输出 `DSH_SOURCE_AFTER=unchanged`、`CONTRACT_PROBES=PASS`。  
清理：同 CP-SES-001。  
结论：v0.1 可以用一个 DSH Storage Domain 承载 durable pending 和恢复 saga，并服从 Web profile 当前的 JSON backend；不得硬编码 SQLite，也不需要自建第二套存储。仍不声明多 Host/多进程写者支持。CP-INS-001 另以真实 Web profile 启动声明 `inject: [storageDomain]` 的外部 Host 插件并成功激活，补齐目标 profile 组合证据。  
架构影响：确认 Baseline 9.1、9.3 和 9.6；Slice A 的 Storage 阶段门解除。

### CP-LLM-001

状态：PASS（Windows）  
环境：DSH 99f6f02；Windows NT 10.0.26200.0 x64；Node v24.18.0；pnpm 11.19.0。  
输入：Session 内先后两个完整 `request/header`，最后一个 route 为 `session-provider/session-model` 且带原 Agent system/tools；一个记录实际 GenerateOptions 的假 Adapter；首轮非法 JSON、第二轮合法 JSON；独立 AbortSignal。  
预期：按 Session 日志 last-wins 继承 provider/model；Learning 不继承原 system/tools；最多一次主调用加一次格式修复；修复不换 route；usage 可取；取消形成 terminal aborted。  
步骤：用 `foldRequestHeader` 重建 effective route；直接调用 `ctx.llm.stream` 并用 `BlockAssembler` 收集；首轮本地 JSON parse 失败后只发起一次 repair；另一路调用在 Adapter 等待时 abort。  
实际：两次 GenerateOptions 均为 `session-provider/session-model`，`tools` 和任意 `purpose` 均未设置；usage 分别为 6/2 和 7/2；第二次得到合法对象；取消调用以 `finish.reason.kind=aborted` 结束。  
失败注入：非法 JSON；运行中 AbortSignal。  
证据命令：`powershell -File probes/run-dsh-contract-probes.ps1 -DshSource <path-to-clean-dsh-checkout>`；当前全量 runner 为 3 个文件、9 个测试，全部通过；保护的 DSH 源码后置核验仍为 fixed HEAD、clean、unchanged。  
清理：同 CP-SES-001。  
结论：v0.1 的“严格 JSON 文本 + 本地 schema 校验 + 最多一次格式修复”可行；Learning route 只继承 Session 的 provider/model，原 Agent 的 tools/system 不会透传。DSH 没有 run2skill 专用 `purpose`，v0.1 保持该字段未设置。  
架构影响：确认 Baseline 10.1～10.5；Slice B 的 LLM 阶段门解除。

### CP-SKL-001

状态：PASS（Windows）  
环境：同 CP-LLM-001；filesystem provider 使用 polling watcher，稳定阈值 20ms。  
输入：同名 PROJECT/USER Skill、USER-only Skill、被排除的 `.system` Skill、一个显式返回 `complete=false` 的临时 provider，以及一次 PROJECT Skill 正文/描述更新。  
预期：完整观察为 complete=true；PROJECT rank 覆盖 USER；`.system` 不进入 user catalog；不完整 provider 使 snapshot fail closed；`get` 返回精确正文和路径；watcher 触发 skills/change 并回读新内容。  
实际：初始 catalog 只有 same-skill/user-only；same-skill winner 为 project-dsh；`.system` 被排除；临时 provider 存在时 complete=false，释放后恢复 true；更新后收到变更，summary 与完整 body 都刷新到 v2。  
失败注入：显式 incomplete observation。  
证据命令：与 CP-LLM-001 同一 5-test 运行。  
清理：同 CP-SES-001。  
结论：完整 Catalog Lookup、rank、精确 get 和热回读可作为发布前 Guard；`complete=false` 绝不能用来证明 absence。  
架构影响：确认 Baseline 11.1～11.3；Slice C 的 catalog 阶段门解除。

### CP-ROOT-001

状态：PARTIAL（Windows；手工组合子路径 PASS）  
环境：同 CP-LLM-001；真实 Workspace Registry、Storage Domain、Session Persistence 和 filesystem Skill provider 的手工组合。  
输入：一个含 `.git` 的已注册 Workspace、显式 `dshHome`、PROJECT/USER Skill roots。  
预期：Workspace 保存 realpath canonical path；PROJECT root 精确为 `workspace.path/.dsh/skills`；USER root 精确为 `resolveDshHome(configuredDshHome)/skills`；Registry 读回路径与两者一致。  
实际：Workspace create/resolve/status 全部成立；project-dsh 与 user-dsh 定义路径分别与两个候选 root 精确一致；`ctx.skills` 仍没有可查询 writable roots 的公开接口。  
失败注入：无；这是身份/组合一致性探针。  
证据命令：与 CP-LLM-001 同一 5-test 运行。  
清理：同 CP-SES-001。  
结论：由同一官方 Web profile 组合持有 configured dshHome，并同时用于默认 filesystem provider 与 run2skill 版本化 resolver 的方案可行。该历史探针没有证明 PUBLISHED；写后仍必须由 stock DSH 的 complete snapshot、原生 filesystem winner 和 exact `get()` 回读确认。
架构影响：确认 Baseline 12.1/12.2 的标准解析输入。`ctx.skills` 缺少 roots 查询不再是承重缺口；生产迁移与端到端证明转交 CP-ROOT-003。

### CP-ROOT-002（已放弃的历史实验）

状态：HISTORICAL（曾在 Windows PASS）。

环境：DSH 候选 commit `0fdc7a42a03693c41290d10af1725775af6598ca`；该 checkout 独立、clean，未替换固定 baseline。

输入：一个 `.git` project、尚不存在的 `.dsh/skills`、真实 filesystem Skill provider，以及经 immutable Approval 建立的 CREATE publication。

预期：同一次 complete snapshot 明确给出 `filesystem/project-dsh` root；生产 C5 CAS 写入后，DSH watcher/catalog 选中同 provider/source/path，exact `get()` 返回一致 metadata、invocation 与正文；只有随后 Lineage durable commit 才能形成 `PUBLISHED`。

实际：候选 snapshot 给出精确 project root；生产 `ApprovalPublicationSaga` 完成 CAS、bounded Registry exact readback、Lineage r1 和最终 outcome；1 个真实候选组合测试通过，候选源前后 HEAD/status 不变。

失败注入：root 初始缺失，由 C5 安全创建；固定 baseline 的 CP-ROOT-001 同时记录 `roots` 不可用。

证据命令：`powershell -File probes/run-dsh-root-contract-probe.ps1 -DshSource <path-to-clean-candidate-checkout>`。

清理：runner 只操作 Git 忽略的 disposable clone 和测试临时目录。

结论：该候选 API 曾证明一种接口形状可以闭环，但项目已拒绝把 DSH fork、未合并 roots API 或本地 patch 作为 v0.1 生产前提。

架构影响：仅保留为历史实验记录；不再解除任何阶段门，也不属于默认复现路径。

### CP-ROOT-003

状态：NOT_RUN
环境：固定、clean、未修改的 DSH `99f6f02`（`0.1.0-rc.7`）；官方 `web` profile；不得使用 fork、未合并 API 或本地 patch。
输入：默认 filesystem provider；`includeDefaultRoots=true`；已注册 Workspace；显式 effective DSH Home；PROJECT/USER 的 existing 与 absent root；CREATE/MERGE Approval；另含 custom root、`includeDefaultRoots=false`、重命名 provider/自定义 preset 的不支持配置。
预期：版本化 contract 精确解析 PROJECT `<workspace>/.dsh/skills` 和 USER `<DSH_HOME>/skills`；MERGE 绑定现有 `get().path`，CREATE 绑定标准目标与双重 absence；CAS/journal 后 complete snapshot 的原生 filesystem winner 精确匹配 provider/source/path，exact `get()` 返回审核内容；不支持配置只能 lookup 并进入 `NEEDS_ATTENTION`；卸载插件后 USER Skill 仍可用。
步骤：由 Issue #48 提供 production-backed runner，在独立 DSH Home/Workspace 中覆盖 PROJECT/USER CREATE、MERGE、absent root、配置漂移、readback mismatch 和卸载后原生加载。
实际：尚未运行。
失败注入：incomplete snapshot、Base/absence race、Workspace/DSH Home identity 变化、link/reparse escape、unsupported config、provider/source/path/content mismatch。
证据命令：由 Issue #48 添加并在实现 PR 固定；当前不得引用历史 candidate runner 代替。
清理：只删除探针自己的临时 Workspace、DSH Home 和构建产物；不修改 DSH checkout。
结论：NOT_RUN；不得写为 PASS。
架构影响：#48 与 C7 的前置运行门。

### CP-WEB-001

状态：PASS（Windows）  
环境：DSH 99f6f02；Windows NT 10.0.26200.0 x64；Node v24.18.0；pnpm 11.19.0。  
输入：真实 `@deepseek-ai/dsh-client-connection` 插件、`/run2skill` 独立 RPC channel（`authority=loopback`）、loopback Host 请求、trusted-host 远程请求、cross-site Origin 请求，以及 DSH UI Conversation 的 Client manifest/slot contract。  
预期：本机请求进入 handler；远程同源与跨站请求均在业务 handler 前拒绝；外部 Client 包具备 `./client` export 和 `dsh.client.platform=web`；`conversation.session.header.actions` 是可挂载的 session-scoped list slot。  
步骤：在可丢弃 DSH clone 内挂载真实 Connection 插件和最小 WebServer double；注册 loopback RPC；分别发送三种 Host/Origin 请求；卸载后核对 route/upgrade 清理；解析外部 Client package manifest 和精确 slot 声明。  
实际：loopback 请求返回 200 且 handler 仅调用一次；trusted-host 远程请求返回 403；伪造 loopback Host 但携带恶意 Origin 的请求返回 403，handler 仍只调用一次；卸载后 route/upgrade 均清空；Client export、web platform 和 header action slot 均存在。当前全量 runner 与 Session/Storage/LLM/Skill probes 合计 3 个文件、9 个测试全部通过。  
失败注入：远程 Host；cross-site Origin；插件卸载。  
证据命令：`powershell -File probes/run-dsh-contract-probes.ps1 -DshSource <path-to-clean-dsh-checkout>`；输出 `Test Files 3 passed`、`Tests 9 passed`、`DSH_SOURCE_AFTER=unchanged`、`CONTRACT_PROBES=PASS`。  
清理：同 CP-SES-001。  
结论：v0.1 的浏览器审批可以建立在 DSH loopback unary RPC 和 Session header slot 上，不能扩展为 trusted-host/LAN 审批。CP-INS-001 随后将一个具有 Host export、`./client`、`dsh.bundle` 和 `dsh.client` 的外部包装入真实 Web profile；Host 激活、启动图注入、bundle HTTP 提供和 headless Chromium 实际执行全部通过，补齐了双面外部插件加载证据。  
架构影响：确认 Baseline 14.1～14.2 的信任边界和接入面；Slice C 的 Web seam 阶段门解除。

### CP-PUB-001

状态：PASS（Windows + WSL/Linux）  
环境：Windows 10.0.26200、Node v24.18.0；WSL2/Linux 6.18.33.2 x86_64、Node v22.23.2。两个平台都在各自原生临时目录执行文件系统动作。  
输入：两个竞争 CREATE、stale MERGE Base、两处外部编辑竞争、五个真实子进程崩溃窗口、路径遍历、Windows junction/Linux symlink，以及 Registry 回读前的 backup finalization。
预期：CREATE 最多一个成功；stale/unseen change 不被覆盖；进程崩溃后按 stage/backup/target 哈希恢复；逃逸路径 fail closed；backup 只在 exact readback 后清理。  
步骤：CREATE 以 bundle directory 独占 claim；stage 文件 fsync 后以同文件系统 hard-link no-replace 安装；MERGE 将当前 target 移到唯一 backup 并复核 approved Base，再以同一 no-replace 原语安装；每个状态写 append-only journal；子进程分别在 CREATE staged、MERGE backup moved、MERGE installed-before-journal 时直接 exit(86)，父进程只依据有效 journal 和文件哈希恢复。  
实际：Windows 8/8、Linux 8/8。竞争 CREATE 恰好一个 written、一个 conflict；缺失 root 在逐层创建中崩溃后可安全续跑且不删除并发用户文件；Base 或 target 在切换窗口改变时用户 bytes 原样保留；bundle identity 被替换时 CREATE/MERGE/recovery/finalize 全部停止；backup 缺失观察后的竞争者 bytes 原样保留；进程崩溃窗口恢复到 exact approved bytes 或安全 conflict，MERGE backup 保留；相对 root、`../`、journal/target junction 和 symlink 全部在写入外部目录前拒绝；unknown hash 停止且保留原物；hash-chain journal 有固定上限并忽略 torn newest record；target 在模拟 Registry readback 前改变时 finalize 拒绝且 backup/journal 均保留。
失败注入：并发 CREATE；错误 Base；rename 前用户修改；backup move 后外部 target 出现；bundle directory swap；backup absence 后竞争；真实 `process.exit(86)`；junction/symlink；readback 前 target 变化。
证据命令：`powershell -File probes/run-publication-contract-probe.ps1`；如需指定非默认 WSL，再传入 `-WslDistribution <name>`。两端均输出 8 tests passed，最后输出 `CP_PUB_001=PASS`。该探针直接执行 `src/adapters/dsh-publication` 的生产原语，不读取或修改 DSH checkout。
清理：每个测试只删除带固定随机前缀的 OS 临时目录；探针不写 DSH 源码，也不写真实 Skill root。  
结论：候选 CAS 协议在 Node 的 Windows 与 Linux 文件系统原语上成立。最终安装必须使用 hard-link no-replace 或等价且经同等验证的原语，普通 rename/atomic replace 不能替代；MERGE backup 必须保留到 Registry exact readback。证据覆盖进程崩溃，不声称抵抗掉电或存储设备失效。  
架构影响：Baseline 13.4 从候选方案收敛为已验证的 no-replace + append-only journal 协议；Slice C 的文件 CAS 探针门解除。完整纯插件发布仍需 CP-ROOT-003 与 C7 证据。

### CP-INS-001

状态：PASS（Windows probe package）  
环境：DSH 99f6f02；Windows 10.0.26200；Node v24.18.0；pnpm 11.19.0；headless Microsoft Edge。  
输入：同名 `0.0.1`/`0.0.2` 两个最小外部包，均包含 Host export、`./client` bundle、`dsh.bundle.patch` 和 `dsh.client.platform=web`；全新 DSH_HOME/Web profile；一份预先存在于 `<DSH_HOME>/skills` 的原生 Skill。  
预期：`dsh plugin --profile web add` 自动加入 bundle 层；Host 和 Client 都真实激活；profile patch 禁用后两端都不可达；升级切到 v2；remove 同时移除 dependency/bundle；Skill 不随插件卸载。  
步骤：从受保护 baseline 新建无测试包注入的 local clone，执行 frozen install 和完整 DSH Host/Client/Web build；在全新 DSH_HOME 添加 v1；启动真实 Web server，并从 index 启动图、`/plugins` route、Host marker 和 Chromium global marker 四处核对；写 profile disable patch 后复跑；恢复 patch 并 add v2；remove 包后再次启动；最后逐字比较保留的 SKILL.md。  
实际：add 后 profile dependency 与 bundle list 都包含探针包；Host 只有在真实 `storageDomain/workspaceRegistry/skills` 注入全部满足后才写出 v1 marker，启动图和 Client route 包含 v1，Chromium 实际执行 v1；disabled 时 Host marker 不生成、启动图无该包、route 404；升级后四处均为 v2；remove 后 dependency、bundle、config、Host 和 Client 全部消失，而 SKILL.md 字节不变。  
失败注入：profile disable；同名包升级；卸载；每个阶段独立重启 Web profile。  
证据命令：`powershell -File probes/run-install-lifecycle-probe.ps1 -DshSource <path-to-clean-dsh-checkout>`；输出 `CP_INS_001=PASS`、`INSTALL_LIFECYCLE_PROBE=PASS`，并在前后确认 DSH fixed HEAD、clean、unchanged。fixture 的 Host/Client 源码纳入版本控制，干净 clone 不依赖 ignored 文件。  
清理：所有 profile、storage、browser state 和 build artifact 仅位于可丢弃的独立工作目录；真实用户 DSH_HOME 未使用。  
结论：v0.1 的单包形态必须同时声明 Host export、`./client`、`dsh.client` 和一个很薄的 `dsh.bundle` patch，才能由 `dsh plugin add` 自动进入 Web profile。禁用属于 profile patch 行为，卸载包不得删除 `<DSH_HOME>/skills`。  
架构影响：确认 Baseline 18～19 的单包/生命周期方向，并补上 `dsh.bundle` 为必需 manifest 面。当前 PASS 验证 DSH 安装契约；Alpha 前仍必须以真实 dsh-run2skill 发布候选包复跑，不能用 probe package 结果替代发布验收。

### 运行器校准记录

DSH Contract Probe 首次校准曾误触发 DSH 全项目 Windows 测试，第二次校准被 DSH “正式 package 必须有 invariant companion”规则在测试正文前拦截；两次均不作为 Contract Probe 结果。最终运行器使用只包含 `packages/run2skill/contract-probes/tests/` 的专用 Vitest 配置，并从新的可丢弃 clone 完整复跑通过。

Publication Probe 首次双平台运行因 PowerShell 反斜杠传给 `wslpath` 时被吞掉而停在 Linux 测试之前；Windows 用例已通过，但该次不作为跨平台结论。修正为正斜杠路径后，从头执行 Windows 与 WSL/Linux 全套并通过。

Install Lifecycle Probe 的首次构建副本曾包含前序 Contract Probe 注入的 synthetic workspace package，随后过滤安装又污染了全仓 build 解析；该副本被放弃，不作为安装证据。全新 clone 的完整构建成功。后续两次浏览器校准分别发现 Playwright 默认 headless-shell 未安装、缓存中的 Chromium 路径过期；最终探针只读探测系统已安装的 Edge/Chrome，并在不下载浏览器的情况下完整通过。正式结论来自最后的全新 clone + DSH_HOME 复跑。
