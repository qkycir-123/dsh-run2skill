# dsh-run2skill

把你在 DeepSeek Harness（DSH）里反复教给 Agent 的做法，整理成可以审核、可以继续复用的原生 Skill。

run2skill 会留意你明确说出的纠正、长期约束和可复用流程，生成一份 Skill 提案。你可以先查看内容，再决定批准或丢弃；只有批准后的提案才会写入 DSH 的原生 Skill 目录。

> `0.1.0-alpha` 是首个公开测试版。目前支持 DSH `web` profile 的 `0.1.0-rc.7` 和 `0.1.0-rc.8`。Alpha 版本适合试用和反馈，不建议把它当作无人值守的关键生产组件。

## 安装

先确认你已经安装 DSH、Node.js `^22.19.0 || >=24.0.0`，并能在终端运行 `dsh` 和 `pnpm`。然后执行：

```bash
dsh plugin --profile web add dsh-run2skill@0.1.0-alpha
```

重启 DSH Web。打开 **Settings → Plugins**，看到 **run2skill** 卡片就说明插件已加载。

run2skill 不需要单独填写模型密钥。需要分析提案时，它沿用当前 DSH Session 实际使用的 provider 和 model；如果当前 Session 没有可用模型，学习会停止并显示状态，不会偷偷换用其他 Provider。

## 怎么用

平时照常和 DSH 对话即可。例如：

```text
把这个流程保存成 Skill，以后可以复用。
```

你也可以在正常工作中明确纠正做法、说明长期约束，或给出有顺序的可复用流程。run2skill 会在一轮对话完成后做轻量检查；不是每轮都会调用模型，只有命中明确学习信号后才会进入后续分析。

当提案准备好后：

1. 在 Session 顶部点击显示待处理数量的 **Skill 提案** 按钮。
2. 在 **Skill Proposal Inbox** 查看提案、适用范围和内容差异。
3. 选择批准、拒绝，或在失败后重试。
4. 批准成功后，结果就是普通的 DSH 原生 Skill；即使以后卸载 run2skill，它仍然可以被 DSH 使用。

提案可以保存到当前项目（`PROJECT`）或当前用户（`USER`）范围。插件只支持 DSH 默认的 filesystem Skill roots；自定义 Skill provider 或关闭默认 roots 时会安全停用发布。

## 设置与数据

在 **Settings → Plugins → run2skill** 中可以关闭 **Automatic Learning**：

- 开启：明确的纠正、长期约束和工作流可以生成提案。
- 关闭：暂停普通自动学习；你明确说“保存为 Skill”时仍然可以生成提案。

run2skill 是本地优先插件。它不会保存 Provider 密钥，也不会复制完整 Session；送去模型分析的是经过过滤、截断和敏感信息清理的有限上下文。提案发布前始终需要人工批准。

Settings 中也提供 `PROJECT` 和 `USER` 两种 Purge。Purge 会删除对应范围内 run2skill 自己保存的派生数据，但不会删除：

- DSH Session Log；
- 已发布的原生 Skill；
- 无法证明属于所选范围的数据。

更详细的保留与升级规则见 [数据存储与升级](https://github.com/qkycir-123/dsh-run2skill/blob/v0.1.0-alpha/docs/storage-and-upgrades.md)。

## 更新与卸载

更新到另一个明确版本：

```bash
dsh plugin --profile web add dsh-run2skill@<version>
```

卸载：

```bash
dsh plugin --profile web remove dsh-run2skill
```

两种操作后都请重启 DSH Web。卸载不会删除已经发布的 Skill，也默认保留 run2skill 的数据；如果你希望清除派生数据，请在卸载前先使用 Settings 中的 Purge。

## 遇到问题

- **看不到 run2skill 卡片**：确认使用的是 DSH `web` profile，并在安装后重启了 DSH Web。
- **状态是 `DEGRADED` 或 `INCOMPATIBLE`**：不要手工删除 storage；先确认 DSH 是否为受支持版本，再恢复兼容的插件版本。
- **没有生成提案**：确认 Session 有可用的 provider/model；也可以直接说“把这个流程保存成 Skill”。
- **无法发布 `PROJECT` Skill**：当前 Session 必须属于 DSH 能识别的 Workspace。
- **自定义了 Skill roots/provider**：首个 Alpha 只支持 DSH 默认 filesystem roots，会选择安全停止而不是猜写入位置。

欢迎在 [GitHub Issues](https://github.com/qkycir-123/dsh-run2skill/issues) 报告问题。请不要附上密钥、完整 Session、私人路径或包含敏感信息的日志。

## 进一步了解

- [版本变化](https://github.com/qkycir-123/dsh-run2skill/blob/v0.1.0-alpha/CHANGELOG.md)
- [DSH 兼容性](https://github.com/qkycir-123/dsh-run2skill/blob/v0.1.0-alpha/docs/compatibility.md)
- [数据存储与升级](https://github.com/qkycir-123/dsh-run2skill/blob/v0.1.0-alpha/docs/storage-and-upgrades.md)
- [贡献指南](https://github.com/qkycir-123/dsh-run2skill/blob/v0.1.0-alpha/CONTRIBUTING.md)
- [维护者兼容性探针](https://github.com/qkycir-123/dsh-run2skill/blob/v0.1.0-alpha/probes/README.md)

本项目采用 [MIT License](LICENSE)。Client bundle 内嵌依赖的许可声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
