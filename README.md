# Feini Brain MVP v2｜研究与实施规格包


本包交付的是可分步执行的Markdown方案、接口和数据契约、参考SQL/JSON/提示词、84项实施任务以及504个具名验收场景。它不是已经开发完成的应用，也不含真实API Key或用户知识数据。

**开始阅读：** [00_ROUTER.md](00_ROUTER.md)。

**交给实施工具的入口：** [AGENTS.md](AGENTS.md) 与 [START_IMPLEMENTATION.txt](START_IMPLEMENTATION.txt)。

**先看装配逻辑：** [车轮组件装配矩阵](docs/02_architecture/02_component_assembly.md)。

**查看交付体量与真实校验：** [DELIVERY_AUDIT.md](DELIVERY_AUDIT.md)。字数按Unicode汉字统计，并另列剔除代码块的Markdown正文汉字数；不是用UTF-8字节数冒充字数。

## 目录

| 目录 | 用途 |
| --- | --- |
| docs/00_product | 产品范围与用户结果 |
| docs/01_research | 车轮优势、限制、替代方案与一手来源 |
| docs/02_architecture | 系统装配、UI、文件目录、架构决策 |
| docs/03_contracts | DTO、API、数据库、状态、Key、LLM、关系、图AST、备份 |
| docs/04_tasks | 84个小任务的实现规格和最小上下文路由 |
| docs/05_tests | 504个具名场景及测试策略 |
| docs/06_operations | 安装、依赖下载、备份、排错、交付 |
| docs/07_gates | 七阶段顺序和验收门槛 |
| reference | 限制常量、Schema、SQL、样例、提示词、预检脚本 |
| implementation/progress | 应用实施进度起点与证据目录 |
| tools / audit | 文档包审计工具和本次实际审计结果 |

## 相对最初方案的关键升级

不仅列依赖，还定义每个库的输入输出、所有权、生命周期和失败边界；不仅生成图，还验证图节点来源、保存版本和过期状态；不仅保存Key，还区分保留/替换/删除、跨域转移确认和本地请求保护；不仅调用模型，还记录幂等运行、超时、格式修复和迟到结果；不仅导出，还给出空库恢复与回滚契约。

## 实施现状

本仓库同时承载规格包与实施代码。当前进度以 [当前实施位置](implementation/progress/NEXT_TASK.md) 与
[机器可读状态](implementation/progress/tasks.current.json) 为准，完成情况按 Gate 分别记录在
[docs/progress/G0.md](docs/progress/G0.md)、[docs/progress/G1.md](docs/progress/G1.md)，运行证据在
[implementation/progress/evidence](implementation/progress/evidence/README.md)。

已验收：**G0（T001–T012）** 与 **G1（T013–T026，离线知识库闭环）**。G2 起仍在实施中，
未标注证据的任务保持未完成状态；没有真实执行的用例一律记为未执行或环境阻塞。

规格包自身的检查（链接、任务依赖、参考数据与SQL约束）针对文档，不证明应用已经运行。
`implementation/progress/tasks.initial.json` 保留实施前的全 not_started 起点，不被覆盖。
