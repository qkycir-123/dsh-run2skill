# 参与贡献

感谢你愿意帮助改进 dsh-run2skill。普通问题、使用反馈和功能建议可以直接提交到 [GitHub Issues](https://github.com/qkycir-123/dsh-run2skill/issues)。

## 本地开发

需要 Node.js `^22.19.0 || >=24.0.0`、Corepack 和 pnpm 11：

```bash
git clone https://github.com/qkycir-123/dsh-run2skill.git
cd dsh-run2skill
corepack enable
pnpm install --frozen-lockfile
pnpm run check
pnpm run verify:candidate
```

`pnpm run check` 运行 typecheck、lint、单元测试和 publication 测试。`pnpm run verify:candidate` 会构建真实候选包，并检查冻结评测、崩溃恢复、包内容、许可、敏感信息和本机路径。

## 提交改动

- 行为变化请先补充或更新测试。
- 保持改动聚焦；较大的产品行为、公开接口或持久化格式变化请先开 Issue 讨论。
- 不要修改或 fork DSH 来满足插件需求。兼容性验证应使用官方、干净、固定 commit 的临时 checkout。
- 不要提交密钥、Session 原文、私人路径、运行日志、构建产物或 `.probe-work/`。
- 如果改动触及 DSH 集成、发布或安装生命周期，请运行直接相关的 [兼容性探针](probes/README.md)。

Pull Request 请说明做了什么、用户可见影响以及运行过哪些验证。项目维护者可能会要求补充与当前改动直接相关的测试或兼容性证据。
