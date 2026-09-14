# 研究来源、时间边界与事实登记


本方案核验日期：2026-09-14。本文是来源索引，不是第三方文档的镜像。涉及第三方产品事实的短结论均指向下列一手资料；本方案中的接口、数据模型、状态机、限制和验收标准是针对本项目作出的设计决策，不是第三方官方承诺。

没有使用 GitHub 星数作为工程可行性证明。没有把“仓库存在”写成“所有集成已经安装测试通过”。版本、许可、模型参数和安全公告可能变化，初始化任务必须记录当时实际锁定的版本与安装结果。开发者不得从示例版本号推导整个依赖树已经被验证。

本交付包含规格、参考契约、样例与文档校验工具，不包含已经完成验收的业务应用。研究时能核验的文档能力与项目落地后必须实测的能力分别列出，避免产生不真实的完成感。

## S01｜Next.js CLI

来源：<https://nextjs.org/docs/app/api-reference/cli/next>

核验摘要：CLI 明确记录 dev 与 start 的 hostname 默认值为 0.0.0.0；本方案显式绑定回环地址。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S02｜Next.js Route Handlers

来源：<https://nextjs.org/docs/app/api-reference/file-conventions/route>

核验摘要：文件路由、HTTP 方法和请求响应边界的官方依据。具体缓存与参数行为以锁定版本测试为准。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S03｜Next.js ESLint

来源：<https://nextjs.org/docs/app/api-reference/config/eslint>

核验摘要：采用 ESLint CLI 配置，不把生产 build 当成已经执行 lint 的证据。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S04｜Node 24 SQLite

来源：<https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html>

核验摘要：核验页面为 v24.21.0；v24.15.0 起模块状态为 Release candidate；DatabaseSync 同步执行。不是成熟度无条件保证。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S05｜SQLite WAL

来源：<https://sqlite.org/wal.html>

核验摘要：WAL 会涉及数据库旁的日志文件；活跃数据库不能仅复制主文件就宣称备份完整。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S06｜SQLite Backup

来源：<https://sqlite.org/backup.html>

核验摘要：在线备份接口是获得一致数据库副本的官方路径之一。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S07｜SQLite Foreign Keys

来源：<https://sqlite.org/foreignkeys.html>

核验摘要：外键及删除传播行为需按连接启用并测试。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S08｜React Flow Repository

来源：<https://github.com/xyflow/xyflow>

核验摘要：React 节点交互库，支持自定义节点；仓库声明 MIT。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S09｜React Flow Layout

来源：<https://reactflow.dev/learn/layouting/layouting>

核验摘要：布局不是 React Flow 自动替业务完成的能力；Dagre 等布局器需要单独整合。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S10｜React Flow Troubleshooting

来源：<https://reactflow.dev/learn/troubleshooting/common-errors>

核验摘要：尺寸、Provider、节点类型稳定引用等问题有官方排错说明。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S11｜Dagre Repository

来源：<https://github.com/dagrejs/dagre>

核验摘要：有向图布局算法库；不是画布、数据存储或语义理解器。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S12｜Markmap Repository

来源：<https://github.com/markmap/markmap>

核验摘要：将文本层级转换为脑图的开源项目。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S13｜Markmap Transformer

来源：<https://markmap.js.org/docs/packages--markmap-lib>

核验摘要：markmap-lib 提供文本转换能力。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S14｜Markmap View

来源：<https://markmap.js.org/docs/packages--markmap-view>

核验摘要：markmap-view 提供 SVG 视图；生命周期需要宿主组件管理。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S15｜Mermaid Usage

来源：<https://mermaid.js.org/config/usage.html>

核验摘要：Mermaid 提供声明式图表渲染及安全配置；本方案进一步限制输入语法。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S16｜DOMPurify Repository

来源：<https://github.com/cure53/DOMPurify>

核验摘要：用于 HTML、SVG 等内容净化；净化不代替内容来源和业务语义校验。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S17｜Zod Basics

来源：<https://zod.dev/basics>

核验摘要：safeParse / parse 与类型推导是运行时契约校验的基础。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S18｜Tailwind Next.js Setup

来源：<https://tailwindcss.com/docs/installation/framework-guides/nextjs>

核验摘要：当前框架集成文档采用相应 PostCSS 插件；避免混用不同代的配置教程。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S19｜Vitest Guide

来源：<https://vitest.dev/guide/>

核验摘要：单元和集成测试工具；运行环境与 Node 版本兼容性须在初始化时验证。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S20｜Playwright Installation

来源：<https://playwright.dev/docs/intro>

核验摘要：浏览器端到端测试需要相应浏览器二进制；npm 包安装不等于浏览器已下载。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S21｜npm ci

来源：<https://docs.npmjs.com/cli/v11/commands/npm-ci/>

核验摘要：已有一致锁文件的重复安装使用 npm ci；首次解析与锁定是另一动作。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S22｜npm Lockfile

来源：<https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/>

核验摘要：锁文件记录解析依赖树；必须提交并跟踪变化。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S23｜React useEffect

来源：<https://react.dev/reference/react/useEffect>

核验摘要：外部系统同步需清理副作用；开发模式的额外检查要求挂载与清理对称。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S24｜OpenAI Structured Outputs

来源：<https://developers.openai.com/api/docs/guides/structured-outputs>

核验摘要：结构化输出与 JSON 模式不同，模型和接口支持条件需分别确认。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S25｜DeepSeek API Introduction

来源：<https://api-docs.deepseek.com/>

核验摘要：提供兼容接口调用说明；本系统不据此推断所有兼容服务参数完全一致。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S26｜OWASP CSRF Prevention

来源：<https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html>

核验摘要：来源校验、请求令牌与浏览器请求元数据是纵深防护要素。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S27｜AFFiNE Repository

来源：<https://github.com/toeverything/AFFiNE>

核验摘要：完整产品融合文档与画布；本方案仅借鉴信息组织，不整体嵌入。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S28｜BlockSuite Repository

来源：<https://github.com/toeverything/blocksuite>

核验摘要：内容编辑及协同工具栈；当前 MVP 不引入完整编辑器数据模型。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S29｜Memos Repository

来源：<https://github.com/usememos/memos>

核验摘要：面向快速记录的完整应用；这里借鉴低摩擦收集交互，而非并行运行另一笔记数据库。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S30｜Excalidraw Repository

来源：<https://github.com/excalidraw/excalidraw>

核验摘要：手绘白板及可嵌入组件的候选；自由画布列为后续扩展。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S31｜Sigma.js Repository

来源：<https://github.com/jacomyal/sigma.js>

核验摘要：用于图网络可视化的候选；是否迁移取决于真实数据规模与交互预算。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。

## S32｜tldraw License

来源：<https://github.com/tldraw/tldraw/blob/main/LICENSE.md>

核验摘要：生产使用许可不能按传统宽松开源许可想当然处理；本 MVP 排除该依赖。

使用范围：证明上游组件的公开接口方向或已公开约束；具体装配步骤与本产品行为仍由契约和任务验收控制。
