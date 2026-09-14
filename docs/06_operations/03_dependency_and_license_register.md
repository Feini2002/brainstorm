# 依赖锁定、下载检查与许可证登记


## 1. 运行时清单

必需运行依赖：next、react、react-dom、zod、@xyflow/react、@dagrejs/dagre、markmap-lib、markmap-view、mermaid、dompurify、server-only。Node内置模块fs/path/crypto/sqlite不从npm安装同名替代。项目UI使用Tailwind配置和必要构建插件，不安装整套企业组件框架。

开发依赖：typescript、相关类型声明、eslint和Next兼容配置、vitest、@playwright/test、Tailwind构建工具。具体版本由Gate0记录。生产应用不需要启动Vitest服务或Playwright浏览器；端到端测试下载的Chromium也不是用户日常运行依赖。

## 2. 首次冻结报告

记录包名、直接/间接依赖、精确版本、来源registry、许可证声明、安装时间、Node engines、peer dependency、最小Spike结论。package-lock是版本树权威，说明文档的“建议版本范围”不能覆盖lock。供应商模型名称另由Settings记录，不混在npm依赖冻结里。

许可登记从安装包和官方仓库核对，不能因为GitHub公开就断言商用免费。ReactFlow/Dagre等来源中的许可声明见研究来源；生产发布前再核对实际锁定版本。当前tldraw不作为依赖，不在许可表里假装已经取得生产使用资格。

## 3. 安全与升级

npm audit输出是风险线索，不是全部安全证明。记录漏洞是否存在于实际运行路径、是否有修复版本和升级影响；不为清零计数盲目升级Next或渲染器主版本。动态图形库升级后必须回归特殊字符、净化、节点上限和React生命周期。

离线重装只有在npm缓存或镜像已有所有包时才可能完成，文档不承诺无网络首次安装。下载失败需要明确包与网络错误，不把不完整node_modules当安装完成。用户选择第三方registry时应自行信任，不能默认把Key配置或私有信息传给该registry。

## 4. 不安装清单

Prisma、PostgreSQL、Supabase、Firebase、Redis、Docker、登录认证框架、Redux、LangChain、LlamaIndex、向量数据库、Embedding模型、MCP、Agent框架、WebSocket协同、Yjs、BlockSuite、tldraw和微服务框架均非首版依赖。不是永远禁止，而是新增前必须提交真实需求、成本、接口影响与回归计划。

任何第三方库建议都先回答：它替代哪段现有职责？带来何种运行进程、数据格式或许可条件？失败时如何降级？删除时是否损坏原始资料？如果只能回答“流行、强大、以后会用到”，不纳入MVP。
