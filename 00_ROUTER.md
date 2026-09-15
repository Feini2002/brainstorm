# Feini Brain 路由总纲：从这里开始实施


## 0. 一句话任务

实现一个本地单用户知识碎片工具：先可靠保存一句话、一个词或一段资料，再通过用户设置的LLM连接整理元数据与建议关系，用同一套知识数据生成卡片、关系图、层级脑图和流程投影。不是Notion复刻，不是Agent平台，不是把多个完整笔记应用拼成iframe。

## 1. 第一次打开仓库

先读 [仓库实施协议](AGENTS.md) 和 [产品契约](docs/00_product/01_product_contract.md)，再读 [系统蓝图](docs/02_architecture/01_system_blueprint.md)、[组件装配矩阵](docs/02_architecture/02_component_assembly.md)、[契约索引](docs/03_contracts/00_contract_index.md)。实际安装步骤在 [安装与首次启动](docs/06_operations/01_install_and_bootstrap.md)。

本包是规格和参考材料，不是已完成应用。首次进度从T001开始。不要在非空文档仓库里粗暴重新生成整个脚手架；安装文档给出临时脚手架再受控复制方法。

## 2. 执行路线

[G0 基础环境与安全存储](docs/07_gates/G0.md) → [G1 离线知识库](docs/07_gates/G1.md) → [G2 模型整理](docs/07_gates/G2.md) → [G3 关系图](docs/07_gates/G3.md) → [G4 脑图](docs/07_gates/G4.md) → [G5 流程图](docs/07_gates/G5.md) → [G6 恢复与交付](docs/07_gates/G6.md)。

每个Gate再拆为 [84个小任务](docs/04_tasks/00_task_index.md)。一次只读取当前任务、它引用的契约和六个用例；必要时查前置任务的公开输出。不要把整套长文档一次塞进上下文，然后凭记忆实现所有功能。

## 3. 按问题路由

想知道每个车轮的优势和替代选择：读docs/01_research的对应库研究与 [装配矩阵](docs/02_architecture/02_component_assembly.md)。想知道文件放哪里：读 [目录与导入方向](docs/02_architecture/04_repository_layout.md)。想知道系统应该长什么样：读 [六页面交互设计](docs/02_architecture/03_ui_information_design.md)。

字段、状态、HTTP、Key和LLM不确定：以 [契约索引](docs/03_contracts/00_contract_index.md) 路由，不让页面或模型自行发明。图不安全、来源失效和因果乱连：读视图编译与关系证据契约。需要备份恢复：读Backup Bundle和运维恢复。验收规则与证据分级见 [测试总策略](docs/05_tests/00_test_strategy.md)。

## 4. 最终技术组合

Node24受支持范围 + Next16/React/TypeScript/Tailwind；Node内置SQLite；Zod；ReactFlow + Dagre；Markmap；Mermaid；DOMPurify；Vitest和Playwright用于验收。精确patch在Gate0实际安装后锁定，不宣称任意版本组合已经兼容。

只有一个Node服务进程和一个本地数据库，不增加云端后台、Python服务、登录账户、向量库、消息队列或协同框架。所有模型请求经本地服务端适配器，Key由设置页输入、秘密表保存，默认本地明文风险明确告知。

## 5. 不能破坏的主干

原文先保存；初始原文可追溯；人工字段不被静默覆盖；建议关系可拒绝且不复活；模型只引用允许来源；图是视图不是另一份笔记；过期和缺失来源显式提示；请求重试有身份与费用边界；备份能恢复且无秘密。任何漂亮演示都不能替代这些能力。

## 6. 文档与代码的权威级别

范围约束以本总纲和产品契约为准；字段与精确行为以编号契约及limits为准；任务说明给局部实现顺序；参考示例不能扩大字段或忽略校验。出现矛盾，先做最小契约修正并同步受影响测试，不能在不同层私自“兼容”出多套模型。

详细来源核验见 [一手研究登记](docs/01_research/00_sources.md)。研究事实只说明库的已文档化能力，项目内的性能预算、数据库方案和流程设计是本方案决策。规格包审计结果见 [交付审计](DELIVERY_AUDIT.md)，它不等于应用运行验收。

## 7. 当前起点

[当前任务](implementation/progress/NEXT_TASK.md)；[初始进度](implementation/progress/tasks.initial.json)；[当前状态](implementation/progress/tasks.current.json)；[任务机器清单](reference/contracts/tasks.json)。开始T001后按AGENTS协议逐项推进，不跳到最后的“生成所有页面”。

实施现状：G0（T001–T012）与 G1（T013–T026）已验收并有运行证据，报告见 [docs/progress](docs/progress/)。G2 起仍在推进。`tasks.initial.json` 是实施前的起跑状态，不随实施修改；实际完成情况查 `tasks.current.json`。
