# 一次手动重试的官方 DSH 协议探针

使用未修改的官方 npm SDK `@deepseek-ai/dsh-llm`、`dsh-llm-deepseek@0.2.0-rc.2` 和 `cordis@4.0.4`，向本地受控 HTTP 服务注入 503。探针不读取凭据、不请求外部模型，也不代表真实模型内容质量验证。

在仓库外安装独立 SDK，再从 clean 的插件源码检出运行：

```sh
npm install --prefix ../dsh-native-retry-sdk @deepseek-ai/cordis@4.0.4 @deepseek-ai/dsh-llm@0.2.0-rc.2 @deepseek-ai/dsh-llm-deepseek@0.2.0-rc.2
pnpm install --frozen-lockfile
pnpm exec tsx probes/catalog-retry/probe.ts ../dsh-native-retry-sdk/node_modules .probe-work/catalog-retry
```

输出目录须为新目录。`NATIVE_DSH_CATALOG_RETRY=PASS` 表示：官方错误协议被识别为临时失败；一次人工授权后总计恰好两条请求；重复授权未增加调用；两次失败诊断与既有检测结果保留；第二次失败不提供重试。测试的 SessionBatch 检测结果由合成 fixture 提供。

HTTP 服务和 Cordis 组件由探针结束流程关闭。保存最小 JSON 结论后，删除生成的输出目录与独立 SDK 安装目录；保留此探针源码。
