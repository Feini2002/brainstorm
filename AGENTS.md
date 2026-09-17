# 仓库维护协议

这个仓库是 Feini Brain：本地单用户 AI 知识碎片工具。当前工作是维护已有产品，不是从 T001 重新施工。

## 必读入口与优先级

先读 [00_ROUTER.md](00_ROUTER.md)。当前有效产品约定以本轮审查修改后的代码与契约为准；历史 84 项任务、Gate 报告和证据锚点是施工快照，日常修改不必重走。

规范优先级：产品范围约束 → 现行契约及机器限制 → 当前要修的具体行为 → 参考示例。本轮已明确调整的功能、流程和门禁，以审查方案为准，不要因为旧任务清单仍有要求就把精简掉的内容加回来。

## 日常修改

1. 只改当前问题相关的模块；先核验现状，已经正确的不要改坏。
2. 先实现真实最小路径，再补错误和边界；不创建假页面或固定数据冒充完成。
3. 跑与改动有关的测试，以及 `npm run check`（lint、类型、测试、生产构建）。
4. 历史台账审计用 `npm run audit:history`，不进入日常 check。

## 禁止行为

不要引入云数据库、登录、向量库、Agent 框架、独立 Python 后端、Docker 部署、微服务、CRDT 或自由白板。不要把 API Key 放前端持久存储、NEXT_PUBLIC 变量、日志或导出。不要把 LLM 请求散落在组件。不要在 SQL 事务里等待网络。不要用 eval 处理模型输出。不要在响应返回后用裸 Promise 承诺后台完成。

不要删除或重建用户 `.data`、`brain.db`、笔记、关系、视图和设置。数据库只做向前迁移，不修改已发布的 `001_initial.sql`。

## 必须保留的底线

原文先持久化；数据库事务与完整性；人工修改保护；避免重复创建和重复付费请求的幂等机制；服务端保存 Key；秘密不进入日志、客户端响应或导出；合理的本地访问保护；安全的模型输出校验和图形渲染；备份恢复能力。

本轮明确调整的政策：

- 「只保存」不是默认 AI 整理授权。
- 因果可视化不一律要求先建一条人工 accepted 关系，但必须区分材料、已有关系与模型推断。
- 正常启动不默认执行完整 doctor。
- 运行诊断不是收件箱或设置页的默认交付内容。

## 完成含义

文件存在不等于功能完成，TypeScript 通过不等于浏览器可用，脚本回放通过不等于真实模型通过。没有真实证据时不要把真实供应商验收写成已通过。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
