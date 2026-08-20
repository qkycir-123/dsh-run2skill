# ADR-0001：stock DSH 纯插件发布 root contract

状态：已接受
日期：2026-08-20
适用范围：dsh-run2skill v0.1 PROJECT/USER Skill publication

## 决策

v0.1 生产发布只支持固定兼容性 baseline 的官方 `web` profile 和默认 filesystem Skill roots：

- PROJECT：经 DSH Workspace Registry 解析并重新验证的 canonical Workspace 下 `.dsh/skills`；
- USER：与目标 DSH 组合相同的有效 DSH Home 下 `skills`。

写入前，Host 必须把版本化 root contract、解析算法版本、Workspace/DSH Home identity、canonical root、文件身份或 expected-absence、exact target 和 Proposal 内容纳入 immutable digest，并由用户批准。`customSkillDirs`、`includeDefaultRoots=false`、重命名 provider 或自定义 preset 可参与查重，但 v0.1 不承诺向其发布；无法证明官方默认目标契约时进入 `NEEDS_ATTENTION`。

写入继续使用既有 compare-and-exchange、target single-flight 和 append-only journal/crash recovery 协议。MERGE 可由完整 Catalog winner 的现有 `ctx.skills.get().path` 绑定 Base 和目标；CREATE 使用经批准的标准目标，并同时证明 Catalog 与文件 expected-absence。

写入后，只有未修改 DSH 返回 `complete: true` snapshot，winning candidate 精确匹配原生 filesystem provider、预期 `project-dsh`/`user-dsh` source 和 target path，且 `ctx.skills.get()` 返回审核的结构化字段与 content，才能记为 `PUBLISHED`。

## 拒绝的方案

- 等待或依赖未合并的 provider roots API、DSH fork 或本地 patch；
- 由 run2skill 注册自有 Skill provider，再用自身 provider 自证写入；
- 创建 sentinel Skill/目录来探测 root；
- 只凭磁盘写入、默认目录猜测或 run2skill 自有观察声明发布成功。

这些方案分别引入未发布上游前置、自证循环、额外可见副作用或不充分证据，不能作为 v0.1 生产契约。

## 验证与后果

独立实现 Issue [#48](https://github.com/qkycir-123/dsh-run2skill/issues/48) 必须在 C7 前把当前候选 `snapshot.roots`/`observationDigest` 绑定迁移到该版本化 contract。验收使用固定、clean、未修改的 DSH baseline，覆盖 PROJECT/USER 的 CREATE、MERGE、absent root、配置不匹配、完整 Registry winner 和 exact `get()` 回读。该 stock-DSH 探针尚未运行，不得记录为 PASS。

该决定不改变 C5/C6 的 CAS、crash recovery、immutable Approval、Review/Publication 分离或 exact readback，也不新增 rollback、自有 provider、sentinel 或其他子系统。
