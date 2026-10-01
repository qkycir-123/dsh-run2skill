# Run2Skill 品牌视觉

对应 [#184](https://github.com/qkycir-123/dsh-run2skill/issues/184)。负责人要求设计 logo 并美化 README；本切片仅调整视觉素材、README 首屏和插件展示元信息。

## 视觉方案

以“对话气泡与折页技能卡”为统一图形：气泡表达来自真实对话的经验，折页和正文行表达原生 Skill，琥珀色强调提炼出的内容。透明 logo 使用深青色、青绿色、暖白色与琥珀色；README 头图采用纸张纹理和水彩质感，配文 `Run2Skill` 与 `Teach once. Reuse the skill.`。中英文 README 共享同一头图，并提供版本、兼容性、CI、许可证徽章及快捷导航。

保留透明 PNG 原图；插件通过 `package.json.icon` 引用 `assets/run2skill-logo.webp`，无损 WebP 保留图像及透明度，并满足 DSH 的 256 KiB 上限。npm 增加这个 logo 和展示标题语言文件，README 头图保留在仓库文档素材中。DSH 官方元信息契约见固定基线的[插件展示说明](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/cookbook/adding-a-package.zh.md#plugin-display-metadata)。

展示名称统一为 **Run2Skill**；通过 DSH 的 `locale/en.json` 与 `locale/zh.json` 中 `meta.title` 提供卡片和详情页标题，并导出、打包这些语言文件。包名、安装命令、插件 key 和已保存数据标识继续使用 `dsh-run2skill`。

不改变学习、审核、发布、设置、入口或存储行为，不新增运行依赖。品牌素材先作为当前源码变更；npm 发布独立处理。

## 验收

- 头图文字准确、首屏可读，透明 logo 在深浅背景中可辨认。
- 图像与链接使用仓库相对路径，不包含本机信息。
- npm 实际打包包含 logo，文件类型和尺寸受契约测试约束。
- 真实 Desktop 的组合包卡片展示打包后的 logo，卡片和详情页标题显示 Run2Skill。
- 类型检查、lint、完整单元测试、候选包检查和精确 HEAD 评审通过。
