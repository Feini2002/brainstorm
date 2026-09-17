# Feini Brain 路由总纲


## 0. 一句话任务

维护一个本地单用户知识碎片工具：先可靠保存一句话、一个词或一段资料，再通过用户设置的 LLM 连接整理元数据与建议关系，用同一套知识数据生成卡片、关系图、层级脑图和流程投影。不是 Notion 复刻，不是 Agent 平台，不是把多个完整笔记应用拼成 iframe。

## 1. 第一次打开仓库

先读 [仓库维护协议](AGENTS.md) 和 [产品契约](docs/00_product/01_product_contract.md)。实际安装步骤在 [安装与首次启动](docs/06_operations/01_install_and_bootstrap.md)。

本仓库已经是可运行的应用，同时保留规格与参考材料。历史 84 项任务、Gate 文档和 `implementation/progress` 是首版施工快照，不是每次维护的必经门。新修改以现行代码、契约和本轮审查方案为准。

## 2. 日常入口

- 启动：`npm run dev` 或 `npm run build && npm start`（绑定 `127.0.0.1`）
- 软件检查：`npm run check`
- 主动诊断：`npm run doctor`
- 历史台账审计：`npm run audit:history`

## 3. 按问题路由

想知道每个车轮的优势和替代选择：读 docs/01_research 的对应库研究与 [装配矩阵](docs/02_architecture/02_component_assembly.md)。想知道文件放哪里：读 [目录与导入方向](docs/02_architecture/04_repository_layout.md)。想知道六个页面应怎样交互：读 [六页面交互设计](docs/02_architecture/03_ui_information_design.md)，其中与本轮冲突的政策（只保存即整理、因果必须先 accepted、启动必跑 doctor）以现行代码为准。

字段、状态、HTTP、Key 和 LLM 不确定：以 [契约索引](docs/03_contracts/00_contract_index.md) 路由。备份恢复：读 Backup Bundle 和运维恢复。

## 4. 最终技术组合

Node 24 受支持范围 + Next 16 / React / TypeScript / Tailwind；Node 内置 SQLite；Zod；React Flow + Dagre；Markmap；Mermaid；DOMPurify；Vitest 和 Playwright 用于验收。

只有一个 Node 服务进程和一个本地数据库，不增加云端后台、Python 服务、登录账户、向量库、消息队列或协同框架。所有模型请求经本地服务端适配器，Key 由设置页输入、秘密表保存。

## 5. 不能破坏的主干

原文先保存；初始原文可追溯；人工字段不被静默覆盖；建议关系可拒绝且不复活；模型只引用允许来源；图是视图不是另一份笔记；过期和缺失来源显式提示；请求重试有身份与费用边界；备份能恢复且无秘密。只保存不得触发模型调用。

## 6. 文档与代码的权威级别

范围约束以本总纲和产品契约为准；字段与精确行为以编号契约及 limits 为准。本轮审查明确修改的政策替代旧施工说明中的冲突要求。参考示例不能扩大字段或忽略校验。

历史规格索引仍可从 [docs/04_tasks/00_task_index.md](docs/04_tasks/00_task_index.md) 查阅，但那是施工快照。规格包审计结果见 [交付审计](DELIVERY_AUDIT.md)，它不等于当前运行验收。
