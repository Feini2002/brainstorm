# 权威契约索引与冲突消解


这是整个仓库的实施接口中心。任务文档解释局部工作，但不得重新定义这里的字段、状态和边界。研究文档说明第三方库能力，不能覆盖项目自己的协议。参考示例用于测试，不是另一套领域模型。

- [表、身份与领域责任](01_data_contract.md)

- [状态机与事务切点](02_state_machines.md)

- [精确DTO、版本、状态优先级和哈希](03_dto_and_version_rules.md)

- [HTTP路由与请求响应](04_api_contract.md)

- [Key、本地请求和出站边界](05_settings_and_security.md)

- [模型操作全过程](06_llm_pipeline.md)

- [无Embedding召回与证据片段](07_candidate_retrieval.md)

- [关系词典、审核和因果门槛](08_relations_and_evidence.md)

- [图AST、编译与生命周期](09_view_schemas_and_compilers.md)

- [无秘密备份与恢复](10_backup_bundle.md)

- [SQLite服务实现配方](11_sql_service_recipes.md)

- [跨模块请求时序](12_replay_timelines.md)

## 机器可读材料

[TypeScript DTO参考](../../reference/contracts/dtos.ts)、[限制常量](../../reference/contracts/limits.json)、[HTTP登记](../../reference/contracts/api_registry.json)、[错误码](../../reference/contracts/error_codes.json)、[任务依赖与场景ID](../../reference/contracts/tasks.json)、[初始SQL](../../reference/sql/001_initial.sql)、[Organize Schema](../../reference/schemas/organize.schema.json)、[Mindmap Schema](../../reference/schemas/mindmap.schema.json)、[Flow Schema](../../reference/schemas/flow.schema.json)。

## 版本不是一个数字

规格版本2.0指本文档升级；数据库user_version首次迁移为1；备份schemaVersion为1；LLM提示词organize-v1/mindmap-v1/flow-v1；rendererVersion是各编译器的显式版本。它们各自演进，不能把规格升级2.0误读为需要跳过首次数据库迁移或拒绝合法schemaVersion1备份。

## 精化的明确规则

生成API中的流程路径为/api/views/mermaid/generate，而领域kind叫flow；设置更新使用PUT；复杂图查询使用POST /api/graph但不修改数据。Run.deadlineAt表示180秒租约，不是45秒单次请求或120秒操作总期限。API Key默认本机明文，只在secrets表，GET不回显。格式修复默认关闭，用户启用后最多一次。Item状态的精确推导以DTO版本文档为准。

普通View创建接口只接受graph布局，mindmap/flow必须由受限生成服务创建；模型结果永远不能更新capturedText或rawText。关系causal在Flow里需要已确认、未过期的causes依据；不符合时必须hypothesis而非猜测。空库恢复还检查tags/itemTags，无声合并不属于MVP。

## 变更同步

新增字段必须说明所属真值、是否导出、是否含秘密、如何校验、如何迁移、哪个版本计数变化、哪些UI与测试受影响。删除字段要先确认所有Renderer与Backup不再依赖。未知字段默认拒绝，不用随意索引签名any吞掉契约漂移。
