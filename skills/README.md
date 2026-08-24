# 第一阶段 Skills

Skill 使用 `wynai.skill/v1` 结构化配置，作为可审核的业务规则和指标口径层。

建议目录：

```text
skills/<domain>/skill.json
skills/<domain>/metrics.json
skills/<domain>/workflows.json
```

优先级：系统规则 > Wyn 数据集语义 > 数据集/组织 Skill > 用户 Skill > 当前对话补充。

第一阶段只支持本地结构化 Skill，不包含向量数据库或自动化非结构化知识抽取。

服务启动时会递归加载所有 `skill.json`，并在会话请求中按数据集和触发词解析。存在同名指标冲突时返回 `needs_clarification`，不会静默覆盖口径。
