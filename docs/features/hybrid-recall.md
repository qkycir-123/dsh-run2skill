# Pending Window 与可选混合召回

标准模式保持原有完整目录摘要扫描。高级召回默认关闭，通过插件设置页的「Skill 召回」启用。

## 经验检测

检测器使用同一 Session 内的有界 Pending Window。短批次保留原有上下文；长批次最多选择 32 条观察，优先保留待判断经验的原始证据、纠正与长期约束线索及相邻行动结果，并保留最近反馈。关键词仅用于分配输入预算，不直接决定沉淀。模型仍输出 NONE / DEFER / READY。

DEFER 沿用最多 3 条、有限批次寿命的持久化 carry；后续批次回读同一 Session 的原始观察，READY 必须引用当前批次实际提供的、非空且可唯一绑定的证据；旧 carry 的空或重复摘要不能替代当前反馈。没有反馈不等于接受，已完成的显式保存请求不强制等待下一轮。窗口筛选可能遗漏无明显线索的早期经验，需用长会话标注集评测。

## 高级召回

1. 从当前可见 Catalog 取得已发布 Skill 与待处理候选，沿用作用域、自身排除与稳定身份规则。
2. 摘要文本为名称、适用条件和描述。BM25 对三个字段使用 2/3/1 权重，保留中文分词、命令标识符和词频；向量编码使用独立 embedding 服务。
3. 两路各取前 20，等权 RRF（k=60）融合到最多 30 条。
4. 摘要重排默认使用当前 Session 模型；可切换专用 reranker，首批取前 10。所有待处理候选额外进入检查，不因 Top K 被隐藏。
5. Coverage 读取完整正文，接收候选的词法、语义与重排信号作为辅助依据。分数不是覆盖概率，缺少新规则的同类工作流应判 PARTIAL。
6. 明确 COVERED 可以结束首批检查；其他结果必须返回全目录摘要扫描，再进行完整正文覆盖汇总，才允许 CREATE / MERGE。保留显式保存确认、多目标歧义、正文版本绑定和发布审核。

`recall.complete` 表示本次扫描计划完成，`summaryScanComplete` 仅表示完整 Catalog 已扫描。HYBRID / SHORTLIST 状态不能授权变更。完整复核时保留同一快照与检索评分，重新绑定调用计划，不能将旧调用结果冒充新计划结果。首批正文已确认 PARTIAL / AMBIGUOUS 的候选必须进入完整正文复核，不能被后续摘要判断排除。

## 服务配置

| 字段 | 含义 / 默认值 |
| --- | --- |
| advancedRecall | false |
| embeddingEndpoint | 完整 embeddings POST 地址，例如 `https://service.example/v1/embeddings` |
| embeddingModel | `Qwen/Qwen3-Embedding-0.6B` |
| embeddingApiKeyEnv | DSH Host 上的密钥环境变量名；本机无鉴权服务可以留空 |
| rerankerMode | SESSION 或 SERVICE，默认 SESSION |
| rerankerEndpoint | 完整 rerank POST 地址 |
| rerankerModel | `Qwen/Qwen3-Reranker-0.6B` |
| rerankerApiKeyEnv | 专用服务的密钥环境变量名 |

embedding 协议使用 `{model,input,encoding_format:"float"}`，接收 `{data:[{index,embedding}]}`；专用重排协议使用 `{model,query,documents,top_n}`，接收 `{results:[{index,relevance_score}]}`。模型名由所用服务的部署名称决定，可修改默认值。Qwen embedding 查询采用任务指令前缀，文档不加查询前缀。返回向量进行归一化并精确计算余弦相似度，维度在一次查询中必须一致。

插件不下载或运行模型。需要用户配置兼容服务；远程使用 HTTPS，本机可用 loopback HTTP。拒绝重定向和 URL 内凭据；密钥值不会进入 Client、索引、诊断或任务记录。

## 持久化与恢复

`run2skill_retrieval_v1` 是独立派生数据域，通过 DSH storageDomain 保存向量、摘要哈希、候选身份和模型指纹，不保存原始摘要或查询向量。每次检索只使用当前 Catalog 的成员，变化摘要增量编码；缓存最多 4096 条，跨重启复用。更换 endpoint、模型或文本版本会切换指纹。关闭高级模式保留缓存，清除学习数据同时清除向量缓存；清理先隔离旧 epoch，再等待已接纳的写入完成，最后删除，旧快照不能重新填充缓存。

设置在单次检索开始时固定，选中候选与评分持久化到 Intent；恢复不重新选择候选。embedding 或索引失败回退 STANDARD，重排失败使用 RRF。运行记录保存实际模式、回退原因、检索耗时、重算条目数和各路分数。

## 验证口径

初始参数不是效果结论。使用按来源 Session / Skill 家族隔离的训练、验证、测试集：比较逐轮提炼与 Pending Window，比较 BM25 / 向量 / RRF / Reranker，固定候选与 Coverage 模型比较有无评分辅助。记录 Macro-F1、Recall@10、错误 MERGE / CREATE / COVERED、完整复核率、总模型成本及 P50/P95 延迟。CREATE/MERGE 的完整复核可能增加成本，不能仅统计首批路径。仓库测试使用合成数据和受控模型返回，不声称实测模型准确率提升。
