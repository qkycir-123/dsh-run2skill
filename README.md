# dsh-run2skill

中文 | [English](README.en.md)

你是否遇到过这些场景？

- 同一套工作流，今天教 Agent 一遍，明天换个 Session 又教一遍；
- Agent 每走一步都需要你纠正：“别改那个文件”“先跑测试”“这个步骤不能省”；
- 终于把 Agent 教会了，对话一结束，经验也跟着下班了。

如果你已经受够了在对话框里重复当师傅，`dsh-run2skill` 就是来做这件事的：

> 把你在 DeepSeek Harness（DSH）里明确教给 Agent 的纠正、约束和工作流，整理成可审核、可复用的原生 Skill。

一句话说：**你负责在真实工作里教一次，run2skill 负责把值得复用的部分整理成技能草稿；你点头，它才落盘。**

它不会让 Agent 偷偷给自己立规矩。每份技能草稿都可以先看来源、适用范围和完整内容，然后由你决定确认保存还是放弃草稿。只有确认后，它才会写入 DSH 的原生 Skill 目录。

> 当前稳定版为 [`0.4.0`](https://www.npmjs.com/package/dsh-run2skill/v/0.4.0)。目前仅支持 DSH Web `0.1.2-rc.1`。

`0.4.0` 改用 DSH `0.1.2-rc.1` 的 Remote/API Gateway 与浏览器认证契约，并适配 Session、Storage/Profile、Settings 和插件生命周期变化。它只支持 RC1 保留的内置 `standard` preset；使用旧 DSH `0.1.1-rc.2` 时请继续安装 `dsh-run2skill@0.3.1`。

低噪声整理状态、“立即整理本次经验”、按意见生成新版草稿，以及长工作流关键证据保留继续保留。“立即整理”仍会等待 Agent 停止运行和事实完整，并继续经过查重、审核与发布安全门；设置页不会展示内部批次计数。

## 看一遍完整流程

![Run2Skill 从待审核技能草稿、人工核对到成功沉淀的真实 DSH Web 流程](docs/assets/run2skill-demo.gif)

1. **发现技能草稿**：Run2Skill 只在有事项需要处理时提醒你，并把草稿放在 **设置 → 插件 → Run2Skill**。
2. **核对来源与范围**：查看生成理由、经过过滤的对话证据、保存范围以及将要写入的完整 `SKILL.md`。
3. **不满意就要求修改**：写一条简短意见，Run2Skill 会生成新的完整草稿；旧版本不会直接发布，新版本仍需你审核。
4. **确认后才保存**：成功结果会进入“最近活动”；保存下来的内容是普通的 DSH 原生 Skill。

<details>
<summary>查看三张关键界面截图</summary>

![Run2Skill 设置页中的待审核技能草稿](docs/assets/01-proposal-inbox.png)

![Run2Skill 技能草稿的来源、保存范围与审核内容](docs/assets/02-review-details.png)

![Run2Skill 最近活动中显示已经成功创建的原生 Skill](docs/assets/03-saved-activity.png)

</details>

## 安装

先确认你使用 DSH Web `0.1.2-rc.1`，已经安装 Node.js `^22.19.0 || >=24.0.0`，并能在终端运行 `dsh` 和 `pnpm`。然后执行：

```bash
dsh plugin --profile web add dsh-run2skill@0.4.0
```

重启 DSH Web。打开 **Settings → Plugins**，看到 **run2skill** 卡片就说明插件已加载。

run2skill 不需要单独填写模型密钥。需要分析技能草稿时，它沿用当前 DSH 会话已经选择的模型；如果当前会话没有可用模型，学习会停止并显示原因，不会偷偷换用其他模型。

## 用法：你继续干活，它负责记笔记

平时照常和 DSH 对话即可。例如：

```text
把这个流程保存成 Skill，以后可以复用。
```

你也可以在正常工作中明确纠正做法、说明长期约束，或给出有顺序的可复用流程。不用为了“教它”停下当前任务，也不用自己打开 `SKILL.md` 边回忆边编辑。

run2skill 会在每轮对话完成后只做低成本记录，不会每轮调用模型复盘。到达有界批次边界、会话进入空闲，或你明确请求保存/立即整理时，才会触发一次批次检测；只有检测到可复用经验，才继续查重和技能草稿生成。

当有需要你处理的事项时，DSH 会显示一条原生通知；平时页面顶部不会常驻 run2skill 状态框。处理技能草稿时：

1. 打开 **Settings → Plugins → run2skill**。
2. 在待处理列表中查看技能草稿、适用范围和内容差异。
3. 选择确认并保存、要求修改、放弃草稿，或在保存失败后重试。
4. 保存成功后，结果就是普通的 DSH 原生 Skill；即使以后卸载 run2skill，它仍然可以被 DSH 使用。

如果草稿不合适，可以先写一条不超过 2048 UTF-8 字节的修改意见。Host 会基于当前完整草稿生成新的不可变版本，保留父子版本关系并让旧批准失效；你必须重新查看并确认新版本。这个入口不是自由编辑器，也不会绕过查重、人工审核或安全发布。

技能草稿可以保存到当前项目（`PROJECT`）或当前用户（`USER`）范围。当前版本只会写入 DSH 默认的 Skill 存储目录；如果你改过 Skill 的存储方式或关闭了默认目录，run2skill 会停止保存，不会猜测写入位置。

## 它会学什么

run2skill 目前专注于你**明确表达**的可复用经验：

- **纠正**：“不要直接修实现，先写失败测试。”
- **长期约束**：“这个项目的所有 GitHub 文案都使用中文。”
- **工作流**：“先核对上游版本，再跑兼容性探针，最后更新证据。”
- **显式保存请求**：“把这个流程保存成 Skill。”

它不会因为 Agent 偶尔成功一次，就自作主张地把所有操作写成永久规则。它学的是你明确教过的东西，不是猜你的心思。

## 你仍然握着方向盘

在 **Settings → Plugins → run2skill** 中可以关闭**自动学习**：

- 开启：明确的纠正、长期约束和工作流可以生成技能草稿。
- 关闭：暂停普通自动学习；你明确说“保存为 Skill”时仍然可以生成技能草稿。

run2skill 是本地优先插件。它不会保存模型密钥，也不会复制完整会话；送去模型分析的只是经过筛选、截断和敏感信息清理的必要内容。技能草稿保存前始终需要你确认。

换句话说：run2skill 可以帮你整理经验，但不会替你签字。

设置页也提供**清理所有缓存**功能。它会删除 Run2Skill 自己产生的中间缓存、待处理技能草稿、失败与非敏感诊断记录，但不会删除：

- DSH 的原始会话记录；
- 已发布的原生 Skill；
- Provider、Agent 或其他 DSH 设置。

更详细的保留与升级规则见 [数据存储与升级](docs/storage-and-upgrades.md)。

## 更新与卸载

更新到另一个明确版本：

```bash
dsh plugin --profile web add dsh-run2skill@<version>
```

卸载：

```bash
dsh plugin --profile web remove dsh-run2skill
```

两种操作后都请重启 DSH Web。卸载不会删除已经发布的 Skill，也默认保留 run2skill 的数据；如果你希望清除这些数据，请在卸载前先使用设置页中的**清理所有缓存**。

## 遇到问题

- **看不到 run2skill 卡片**：确认使用的是 DSH `web` profile，并在安装后重启了 DSH Web。
- **提示“run2skill 当前功能受限”**（内部状态码：`DEGRADED`）：不要手工删除存储文件；重试后仍无法恢复时，可在 GitHub Issues 报告。
- **提示“run2skill 当前版本不兼容”**（内部状态码：`INCOMPATIBLE`）：确认 DSH 是否为受支持版本，再恢复与它兼容的 run2skill 版本。
- **没有生成技能草稿**：确认当前会话有可用模型；也可以直接说“把这个流程保存成 Skill”。
- **无法保存到当前项目**（`PROJECT`）：当前会话必须位于 DSH 能识别的项目工作区。
- **改过 Skill 的存储目录或存储方式**：当前版本只支持 DSH 默认设置，会选择安全停止，不会猜测写入位置。

欢迎在 [GitHub Issues](https://github.com/qkycir-123/dsh-run2skill/issues) 报告问题。请不要附上密钥、完整 Session、私人路径或包含敏感信息的日志。

## 进一步了解

- [版本变化](CHANGELOG.md)
- [DSH 兼容性](docs/compatibility.md)
- [数据存储与升级](docs/storage-and-upgrades.md)
- [产品需求](docs/product/prd.md)
- [架构基线](docs/architecture/baseline.md)
- [设计文档索引](docs/design/README.md)
- [同一 Skill 保存意图的单一生成所有者设计](docs/design/single-owner-skill-save.md)
- [贡献指南](CONTRIBUTING.md)
- [维护者兼容性探针](probes/README.md)

本项目采用 [MIT License](LICENSE)。Client bundle 内嵌依赖的许可声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
