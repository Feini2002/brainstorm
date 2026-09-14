# 代码目录、导入方向和公共接口地图


## 1. 目标仓库布局

规格文件与业务代码共存于同一仓库。根目录保留00_ROUTER.md、AGENTS.md、README.md、docs/、reference/、implementation/、tools/。业务代码创建src/、public/、tests/以及应用构建配置，不能为了脚手架便利删除文档包。reference是参考契约与示例，不是自动参与应用打包的代码。

```text
src/
  app/
    layout.tsx  page.tsx  globals.css
    inbox/page.tsx  library/page.tsx  graph/page.tsx
    mindmap/page.tsx  flow/page.tsx  settings/page.tsx
    api/                       # 路由登记中的各HTTP入口
  domain/
    knowledge.ts  relation.ts  view.ts  run.ts
    schemas/                   # HTTP、LLM、Backup分别建schema
    limits.ts  errors.ts  canonicalJson.ts
    graph.ts  mindmap.ts  flow.ts  sourceSnapshot.ts
  server/
    db/                        # 惰性连接、迁移、Repositories
    http/                      # 令牌、Origin、限长、响应封装
    llm/                       # 配置、transport、解析、提示词、adapter
    services/                  # 捕获、编辑、整理、视图、导入导出
    observability/             # 脱敏、requestId、用量与安全诊断
  features/
    inbox/ library/ knowledge/ settings/
    graph/ mindmap/ flow/ views/
  components/
    ui/ layout/                # 纯UI，不接数据库
  lib/
    apiClient.ts               # 浏览器同源客户端与session
```

测试放tests/unit、tests/integration、tests/e2e。SQL迁移从reference移入src/server/db/migrations后由版本化migration runner管理。tests/fixtures只含可公开的合成资料。scripts放doctor、启动包装、诊断工具，不生成秘密到仓库。

## 2. 依赖方向

domain不依赖React、Next、SQLite或具体模型SDK。server可以依赖domain，但不能依赖features。features可以依赖domain的纯类型/验证器和components，但不能依赖server。app/api可以依赖server；app的客户端页面经features调用浏览器apiClient。

禁止src/index.ts把domain、server、client全部export到同一barrel，让tree-shaking替你保证秘密不会被打包。server目录入口加server-only，关键导入规则用ESLint或简单脚本检查。Node数据库模块不能通过类型导入混淆成运行时依赖；纯类型使用import type。

## 3. 关键公开接口

CaptureService.create(input,context)返回{item,replayed}；ItemService.patch(id,expectedRevision,patch)返回ItemDTO；RelationService.createManual/review/reconfirm/delete遵守统一审核；RunService.register/complete/fail/recover控制状态；CandidateSelector.select(item,budget)只返回候选，不写关系。

OrganizeService.execute(id,requestKey,expectedRevision)串联快照、适配器和事务；MindmapService.generate与FlowService.generate共享CaptureSources和ViewRepository；GraphService.query提供有界子图。LLMAdapter.complete只负责协议，不知道SQLite结构。

MindmapCompiler.compile(ast)与FlowCompiler.compile(ast)为纯函数，不能从浏览器当前selection偷读隐藏状态。GraphAdapter.toReactFlow(data,layout)为纯映射，不能顺手推断新关系。所有组件接收数据和回调，不通过window全局变量共享选中知识。

## 4. 文件的创建顺序

G0先建立domain/errors、limits、server/http与db骨架，G1再建立Item和Relation服务，G2加入LLM和Run，G3加入GraphAdapter，G4/G5加入受限AST与View服务，G6补恢复和完整交付。这样没有AI时应用仍先成为一个可靠笔记工具。

跨Gate共享View能力需先实现公共最小片段，再在对应Gate扩大字段；不得复制graph_views和mindmap_views两套仓库。任务文件列出的路径是目标职责位置，若实际Next约定要求不同文件名，在不改变职责的前提下记录调整，不随手重命名整个目录使路由索引失效。
