<p align="center">
  <img src="docs/assets/run2skill-hero.png" alt="Run2Skill — Teach once. Reuse the skill." width="1000" />
</p>

<p align="center"><strong>把对话经验，变成下次可用的 Skill。</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-run2skill"><img src="https://img.shields.io/npm/v/dsh-run2skill?color=247C78&amp;label=npm" alt="npm 版本" /></a>
  <a href="docs/compatibility.md"><img src="https://img.shields.io/badge/DSH-0.2.0--rc.2-153B3C" alt="支持 DSH 0.2.0-rc.2" /></a>
  <a href="https://github.com/qkycir-123/dsh-run2skill/actions/workflows/ci.yml"><img src="https://github.com/qkycir-123/dsh-run2skill/actions/workflows/ci.yml/badge.svg" alt="CI 状态" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-EAB45C" alt="MIT 许可证" /></a>
</p>

<p align="center">
  <a href="#安装">安装</a> · <a href="#看一遍完整流程">完整流程</a> · <a href="docs/compatibility.md">兼容性</a> · <a href="CHANGELOG.md">更新记录</a> · <a href="README.en.md">English</a>
</p>

Run2Skill 把你在 DeepSeek Harness（DSH）里教给 Agent 的纠正、约束和工作流，整理成可复用的 Skill。你查看草稿、提出修改意见，确认后保存。

## 看一遍完整流程

![Run2Skill：打开插件、审核草稿、确认保存](docs/assets/run2skill-demo.gif)

*main 分支界面 · 示例草稿演示*

1. 打开 **左侧栏 → 插件 → Run2Skill**。
2. 查看草稿的用途、适用范围、对话来源和完整内容。
3. 按需提出修改意见，或直接**确认并保存**。
4. 在**最近活动**中查看结果，下次相关任务即可使用这个 Skill。

<details>
<summary>查看关键界面</summary>

![待审核草稿](docs/assets/01-proposal-inbox.png)

![草稿来源与内容](docs/assets/02-review-details.png)

![保存结果与最近活动](docs/assets/03-saved-activity.png)

</details>

## 安装

适用于 DSH **0.2.0-rc.2** 的 Windows Desktop 和 Web。

**Desktop**：在应用中通过 **Manage dsh Command…** 配置命令，完成首次启动后退出应用，再运行：

```bash
dsh plugin --profile desktop add dsh-run2skill
```

**Web**：准备好 Node.js `^22.19.0 || >=24.0.0`、`pnpm` 和 `dsh` 命令，再运行：

```bash
dsh plugin --profile web add dsh-run2skill
```

安装后重启 DSH。Run2Skill 使用当前会话选择的模型。版本信息见 [兼容性](docs/compatibility.md)。

## 使用

照常与 Agent 工作，把值得复用的做法说清楚：

- **纠正**：“先写失败测试，再修实现。”
- **约束**：“这个项目的 GitHub 文案统一用中文。”
- **工作流**：“先核对上游版本，再运行兼容性检查。”
- **保存请求**：“把这个流程保存成 Skill，以后复用。”

Run2Skill 在会话空闲或收到保存请求时整理经验。有草稿需要审核时，DSH 会通知你。也可以打开插件页，点击**立即整理本次经验**。

每份草稿都附有对话来源。你可以确认保存、要求修改，或放弃草稿。Skill 支持保存到**当前项目**或**所有项目**，使用 DSH 默认的 Skill 目录。

## 设置

- **自动学习**：自动从对话中整理经验；关闭后仍可明确请求“保存为 Skill”。
- **最近活动**：查看最近 7 天新建或更新的 Skill。
- **清理所有缓存**：预览并清理待处理草稿与中间缓存，保留已保存的 Skill、会话记录和 DSH 设置。

Run2Skill 在本地管理草稿，并将经过筛选和脱敏的必要对话片段交给当前模型分析。详见 [数据存储与升级](docs/storage-and-upgrades.md)。

## 更新与卸载

更新后重启 DSH：

```bash
dsh plugin --profile desktop add dsh-run2skill
```

卸载：

```bash
dsh plugin --profile desktop remove dsh-run2skill
```

Web 用户将 `desktop` 换成 `web`。卸载后已保存的 Skill 和插件数据继续保留；需要清理缓存时，可在卸载前使用插件页的清理功能。

## 帮助与贡献

- [报告问题](https://github.com/qkycir-123/dsh-run2skill/issues)
- [兼容性](docs/compatibility.md) · [更新记录](CHANGELOG.md)
- [贡献指南](CONTRIBUTING.md) · [维护者探针](probes/README.md)
- [产品需求](docs/product/prd.md) · [架构与设计](docs/architecture/baseline.md)

[MIT License](LICENSE) · [第三方许可](THIRD_PARTY_NOTICES.md)
