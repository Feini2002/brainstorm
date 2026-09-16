# 当前实施位置

当前：**G6 进行中**。T070–T076 已实施并验收（整库逻辑导出、恢复校验、恢复事务、
备份与损坏恢复手册、本地诊断与可观测性、密钥与跨站安全回归、领域单元测试与边界矩阵），
在 `tasks.current.json` 中均为 `verified`。**T077–T084 尚未开始**。
G5（T062–T069）已完成并验收；G0–G4 已完成。真实 Provider 语义验收仍阻塞，见「已知阻塞」。

最新验证（本机实测，2026-09-16，T076 交付后的全量一轮）：

```
npm run lint        exit 0   （0 problems，全仓库）
npm run typecheck   exit 0
npm run contracts   exit 0   （23 已实现 / 0 待办；failures 空）
npm test            exit 0   （81 文件 1054 例，含 browser 与 security 两个 project）
npm run build       exit 0
npx playwright test exit 0   （119 passed / 1 skipped）
```

`npx playwright test` 的 1 条 skip 是 `gate2.spec.ts` 里**既有**的条件跳过
（要求「未配置模型」这一前置），不是本轮引入。

用例数轨迹（只增不减）：G5 时 548 → G6 前四项 896 → T074 后 944 → T075 后 1023 →
**T076 后 1054**。五个 project 相加正好等于整跑（392+517+103+32+10），
**总和一旦不等就说明某个 glob 收集不到文件了**（静默不跑，不报错）。

G6 门禁报告：`docs/progress/G6.md`（**进行中**，覆盖 T070–T076，不是通过报告）。
证据：`implementation/progress/evidence/G6.md`（T074/T075/T076 各节是主执行者独立复核）。
覆盖映射：`docs/test-coverage-map.md`（T076 必交产物，含变异证据与未覆盖清单）。
G5 门禁报告：`docs/progress/G5.md`（T062–T069 全部 verified）。

## G6 进度（T070–T084）

| 任务 | 内容 | 实现位置 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| T070 | 整库逻辑导出与秘密白名单 | `src/domain/exportBundle.ts`、`src/server/services/exportKnowledge.ts`、`src/app/api/export/route.ts` | `tests/integration/export.test.ts` 23 例 | verified |
| T071 | 恢复文件校验与空库策略 | `src/domain/importBundle.ts`、`src/server/services/validateImport.ts`、`src/app/api/import/validate/route.ts` | `tests/integration/import-validation.test.ts` 26 例 | verified |
| T072 | 恢复事务、引用重建与回滚 | `src/server/services/importKnowledge.ts`、`src/app/api/import/route.ts` | `tests/integration/import.test.ts` 26 例 | verified |
| T073 | WAL备份、数据搬迁与损坏恢复说明 | `scripts/inspect-data.mjs`、`docs/operations/backup-recovery.md` | `tests/integration/recovery.test.ts` 20 例 | verified |
| T074 | 本地诊断与可观测性 | `src/app/api/diagnostics/route.ts`、`src/server/observability/diagnostics.ts`、`src/features/settings/DiagnosticsPanel.tsx` | `tests/integration/diagnostics.test.ts` 29 例 + `tests/unit/diagnostics.test.ts` 19 例 + `tests/e2e/diagnostics.spec.ts` 6 例 | verified |
| T075 | 密钥、跨站与渲染安全回归 | `docs/security-checklist.md`、`vitest.config.ts`（security project） | `tests/security/` 8 文件 103 例 + `tests/e2e/security.spec.ts` 9 例 | verified（CSP 未启用，具名缺口） |
| T076 | 领域单元测试与边界矩阵 | `tests/unit/evidence-contract.test.ts`、`text-boundaries.test.ts`、`networkIsolation.test.ts`、`unit/support/networkGuard.ts`、`docs/test-coverage-map.md` | 新增 28 例 + 四组变异对照 | verified |
| T077–T084 | 集成套件 / 六页 e2e / 性能 / 手册 / 审计 / UX / 发布证据 / 最终验收 | — | — | 未开始 |

T076 可直接复用的既有能力与下游注意点：

- **T077 要复用而不是另起一套**。`tests/integration/` 已有 38 文件 517 例，
  覆盖真 SQLite 的事务、外键、CHECK 约束、迁移与真实 HTTP 路由。写新集成测试前先查
  `docs/test-coverage-map.md` 第 3 节 —— 那里逐条列了每个结构反例与边界**已经**由哪个文件守住，
  重复只会让一条规则有两份实现、其中一份必然漂移。
- **`unit` project 现在挂着网络守卫**（`setupFiles: tests/unit/support/networkGuard.ts`）：
  非回环 `fetch` 与 `net.Socket.connect` 直接抛错，回环放行。**不要**把这套装置复制到
  `integration`/`security`——那些 project 需要真实 HTTP。也不要指望它拦子进程。
- **改 project 的 `include` glob 或加新 project 后，核对五者之和是否仍等于整跑**
  （392+517+103+32+10 = 1054）。移到没人收集的目录会**静默不跑**，不报错。
- **偶发守卫要当缺陷修，不是加 retry**。T076 实测出一个真实例子：原「哈希不含随机字段」
  在 `Date.now()` 污染下放行 5/12，换成假时钟后 0/12。若下游看到"有时绿有时红"，
  先问"它到底断言了什么"。
- **`src/domain/evidence.ts` 与 `src/domain/text.ts` 现在有覆盖**（此前 `evidence.ts`
  四个公共函数零引用）。改这两个文件前先跑 `docs/test-coverage-map.md` 第 5 节列出的变异对照。

T074 可直接复用的既有能力与下游注意点：

- **失败层级词表在域层**：`FAILURE_LAYERS` / `FAILURE_LAYER_LABELS` / `FailureLayerEntry`
  在 `src/domain/api.ts`。服务端分类它能观察的层（config/model/storage/local_runtime），
  设置面板补上只有浏览器能观察的 `render`；无法诚实归类的一律落 `unknown`，
  不塞进邻近的桶——「让用户修错东西」比「说未分类」更糟。
- **诊断日志的落点是 stdout**，没有写日志文件：有界靠「内存保留上限 200 条 FIFO」+
  「同键 3 次/分钟限流」两条界，并把 `retention.sink` 如实报成 `'stdout'`。
  **「轮转」在字面上没有被满足**，这是具名缺口，后续任务不要当成已实现。
- **`/api/diagnostics` 是私有路由**，走与其它私有 API 同一道本地守卫。它虽然形似"健康检查"，
  却会报 schemaVersion、库计数、模型 host 与是否配置了 Key，因此**不能**当成公开 health 用。
- **面板把「被测量的绘制面」与「控件」分成两个盒子**（`diagnostics-surface` 只是内容面）。
  若把「重新检查渲染尺寸」按钮移回被测量的盒子里，容器一塌陷按钮就点不到，
  唯一能解释白屏的入口会被它要报告的那个条件藏起来。`e2e/diagnostics.spec.ts` 用
  「先塌陷、后点击」的顺序，正是这条的回归守卫。

T070–T073 可直接复用的既有能力与下游注意点（详见 `docs/progress/G6.md` 第 11 节）：

- `BACKUP_SCHEMA_VERSION = 1`（`src/domain/exportBundle.ts:51`）：恢复侧对未来版本**明确拒绝**，
  改它必须同步改 `importBundle.ts` 的版本分支与 T071-C01 用例。
- `exportBytesMax`（20 MiB）**双登记**在 `reference/contracts/limits.json` 与 `src/domain/limits.ts`，
  `npm run contracts` 会比对两者，只改一处即失败。
- 恢复的大体积请求体走 `bodyLimit: 'import'`（`src/server/http/respond.ts` 的 `ROUTE_BODY_LIMITS`
  按路由族区分），不是全局默认值。
- `inspect-data.mjs` 故意是 `.mjs` 而非 `.ts`：必须在没有构建、没有 TypeScript 的机器上直接跑，
  否则「数据库坏了且服务起不来」时就没用了。它不参与 `tsc`，改动后用 `recovery.test.ts` 兜底。
- 导出用**显式白名单列**（`BACKUP_*_COLUMNS`）而非 `SELECT *`：新知识字段要进备份必须同时进白名单，
  否则静默丢失；反之若字段是秘密，加进去会让 T070-C02 立刻红——这个张力是有意的。

## G4 进度（T053–T061）

| 任务 | 内容 | 实现位置 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| T053 | 保存视图的公共 API 与类型契约 | `src/app/api/views/*`、`src/server/repositories/views.ts` | `tests/integration/views.test.ts` 13 例 | verified |
| T054 | 来源选择快照、版本与哈希 | `src/domain/sourceSnapshot.ts` | `tests/unit/source-hash.test.ts` 9 例 | verified |
| T055 | 脑图生成任务与树结构提示词 | `src/server/services/generateMindmap.ts`、`app/api/views/mindmap/generate/route.ts` | `tests/integration/mindmap-generation.test.ts` 13 例 | verified |
| T056 | 树校验与安全 Markdown 编译 | `src/domain/compileMindmap.ts` | `tests/unit/mindmap-compiler.test.ts` 16 例 | verified |
| T057 | Markmap 挂载、净化与本地资源 | `src/features/mindmap/MindmapRenderer.tsx`、`sanitizeContent.ts` | `tests/e2e/markmap.spec.ts` 6 例 | verified |
| T058 | 脑图大纲、来源映射与回跳 | `src/features/mindmap/MindmapOutline.tsx`、`src/features/shared/SourceList.tsx` | `tests/e2e/mindmap-sources.spec.ts` 6 例 | verified |
| T059 | 视图过期、再生成与历史保留 | `src/server/services/views/getFreshness.ts`、`src/app/api/views/[id]/freshness/route.ts`、`src/features/shared/ViewFreshnessBanner.tsx`、`src/features/mindmap/RegenerateAction.tsx` | `tests/integration/view-regeneration.test.ts` 15 例 + `tests/e2e/mindmap-regeneration.spec.ts` 6 例 | verified |
| T060 | 脑图 Markdown 与 JSON 导出 | `src/domain/viewExport.ts`、`server/services/views/exportView.ts`、`app/api/views/[id]/export/route.ts`、`features/mindmap/ExportMindmap.tsx` | `tests/unit/view-export.test.ts` 14 例 + `tests/integration/view-export.test.ts` 6 例 + `tests/e2e/mindmap-export.spec.ts` 6 例 | verified |
| T061 | 脑图从材料到导出的闭环验收 | `tests/e2e/gate4.spec.ts`、`tests/e2e/support/gomindmap.ts` | `tests/e2e/gate4.spec.ts` 6 例（T061-C01…C06 全 ok） | verified |

可直接复用的既有能力（避免重写）：

- `src/domain/view.ts` 的 `computeStaleness` / `describeSourceDrift` / `describeStaleness` 按
  `rawVersion` + `revision` 比较，并给出逐条 before/after 明细；`ViewFreshness`（读模型类型）也在
  该文件，客户端与服务端共用一个名字。
- `src/domain/compileMindmap.ts` 的 `compileMindmap()` 已产出受限 Markdown（只有 `# ` 标题与
  缩进 `- ` 列表，特殊字符经 `escapeMarkdownLabel` 转义），T060 的 Markdown 导出应直接复用它而
  不是再写一套渲染；`mindmapCompileInput()` 是 contentHash 的固定输入。
- `src/server/services/views/getFreshness.ts` 已把过期原因写成可读句子，导出文件抬头可直接引用，
  不必重算。
- `src/features/shared/apiClient.ts` 已有 `apiDownload()`（带 token 的同源下载）与
  `saveBlobAs()`（对象 URL 点击保存），不要让导出自己拼 fetch。
- `tests/e2e/support/seedData.ts` 的 `seedView()` 支持显式与 `filter` 两种 selection，
  以及独立的 `selectionItems`（快照与选择可不同）；`tagItems()` 可造过滤型选择。

## 已完成

### G3（T043–T052）｜verified

| 任务 | 内容 | 实现位置 | 证据 |
| --- | --- | --- | --- |
| T043 | 图谱读取接口与子图范围 | `src/app/api/graph/route.ts`、`server/services/getGraphData.ts`、`domain/graph.ts` | `tests/integration/graph-read.test.ts` 14 例 |
| T044 | 领域图到 React Flow 适配 | `src/features/graph/graphAdapter.ts`、`types.ts` | `tests/unit/graph-adapter.test.ts` 12 例 |
| T045 | 关系画布、自定义节点与容器 | `src/features/graph/KnowledgeGraph.tsx`、`KnowledgeNode.tsx`、`app/(workspace)/graph/page.tsx` | `tests/e2e/gate3.spec.ts` `T052-C01/C04` |
| T046 | Dagre 布局、尺寸与坐标转换 | `src/features/graph/layoutGraph.ts`、`LayoutControls.tsx` | `tests/unit/dagre-layout.test.ts` 11 例 |
| T047 | 图位置保存与布局版本冲突 | `server/services/saveGraphLayout.ts`、`app/api/views/[id]/layout/route.ts`、`features/graph/useLayoutPersistence.ts` | `tests/integration/graph-layout.test.ts`、`gate3.spec.ts` `T052-C03` |
| T048 | 图筛选、关系阈值与选择稳定性 | `src/features/graph/GraphFilters.tsx`、`useGraphQuery.ts` | `tests/e2e/graph-filters.spec.ts` 6 例 |
| T049 | 节点详情与关系审核交互 | `src/features/graph/GraphInspector.tsx`、`RelationEdge.tsx` | `tests/e2e/graph-inspector.spec.ts` 6 例 |
| T050 | 大图降级、无障碍与可读性 | `src/features/graph/GraphSummary.tsx`、`GraphEmptyState.tsx` | `tests/e2e/graph-accessibility.spec.ts` 6 例 |
| T051 | 关系依据失效与图视图一致性 | `src/domain/staleness.ts`、`server/services/deriveGraphFreshness.ts` | `tests/integration/graph-read.test.ts`、`tests/e2e/graph-staleness.spec.ts` 6 例 |
| T052 | 关系图集成验收与组件替换边界 | `tests/e2e/gate3.spec.ts`、`docs/progress/G3.md`、`tests/fixtures/graph-cases.json` | `gate3.spec.ts` 7 例 |

门禁报告：`docs/progress/G0.md`、`G1.md`、`G2.md`、`G3.md`。
运行证据：`implementation/progress/evidence/G0.md`、`G1.md`、`G2.md`、`G3.md`。

### G0（T001–T012）｜verified

| 任务 | 内容 | 证据 |
| --- | --- | --- |
| T001 | 运行时预检（doctor） | `docs/runtime-report.md`、`tests/unit/doctor.test.ts` |
| T002 | 依赖解析与锁文件 | `docs/dependency-report.md`、`package-lock.json` |
| T003 | 仓库边界与 ESLint 架构规则 | `eslint.config.mjs` |
| T004 | 本地启动脚本（端口探测、信号转发、production build） | `scripts/start-local.mjs` |
| T005 | 应用外壳与六个页面路由 | `src/components/AppShell.tsx`、`src/app/(workspace)/*` |
| T006 | API 统一信封 | `src/domain/api.ts`、`src/server/http/respond.ts` |
| T007 | 本地安全（token、origin、host） | `src/server/security/localGuard.ts`、`src/app/api/session/route.ts` |
| T008 | 健康检查 | `src/app/api/health/route.ts` |
| T009 | SQLite 运行时与迁移 | `src/server/db/*`、`tests/integration/database-runtime.test.ts` |
| T010 | 仓储与 DTO 映射 | `src/server/repositories/*` |
| T011 | 测试装置（unit / integration / contracts） | `vitest.config.ts`、`tests/helpers/*` |
| T012 | 契约一致性守卫 | `scripts/check-contracts.mjs`、`tests/contracts/guard.test.ts` |

### G1（T013–T026）｜verified

| 任务 | 内容 | 实现位置 | 证据 |
| --- | --- | --- | --- |
| T013 | 极简输入框与中文输入体验 | `src/features/inbox/CaptureBox.tsx`、`useCapture.ts` | `tests/e2e/save-races.spec.ts` |
| T014 | 保存接口与采集幂等 | `src/app/api/items/route.ts`、`src/server/services/items.ts` | `tests/integration/capture*.test.ts` 20 例 |
| T015 | 收件箱时间线与知识卡片 | `src/features/inbox/RecentItems.tsx`、`shared/KnowledgeCard.tsx` | `tests/e2e/gate1.spec.ts` |
| T016 | 资料库搜索、过滤与分页 | `src/features/library/LibraryPage.tsx`、`src/server/services/queryItems.ts` | `tests/integration/repositories.test.ts` |
| T017 | 标签规范化与关联维护 | `src/features/shared/TagInput.tsx`、`src/server/repositories/tags.ts` | `gate1.spec.ts`（重启后标签仍在） |
| T018 | 详情抽屉、原文和来源回溯 | `src/features/shared/KnowledgeDrawer.tsx`、`SourceReference.tsx` | `gate1.spec.ts`（原文历史） |
| T019 | 人工编辑、版本冲突与字段保护 | `src/features/library/EditItemForm.tsx`、`src/server/services/editItem.ts` | `gate1.spec.ts`（409 冲突） |
| T020 | 删除确认与引用失效 | `src/features/shared/DeleteItemDialog.tsx`、`src/server/services/deleteItem.ts` | `gate1.spec.ts`（T026-C04） |
| T021 | 跨视图材料选择与数量预算 | `src/domain/selection.ts`、`features/shared/useSelection.ts`、`SelectionTray.tsx`、`server/services/selection.ts` | `gate1.spec.ts`（选择同步清理） |
| T022 | 人工关系创建与方向语义 | `src/domain/relations.ts`、`server/services/createRelation.ts`、`relations/route.ts` | `tests/integration/relations.test.ts`（12 例） |
| T023 | 关系审核、拒绝记忆与人工优先 | `server/services/reviewRelation.ts`、`RelationReviewPanel.tsx`、`relations/[id]/route.ts` | `relations.test.ts`（8 例） |
| T024 | 无 Key 与断网可用路径 | （由上述实现共同满足） | `tests/e2e/offline-crud.spec.ts` 6 例、`docs/offline-capabilities.md` |
| T025 | 保存反馈、草稿与未知完成状态 | `features/shared/MutationStatus.tsx`、`inbox/useCapture.ts` | `tests/e2e/save-races.spec.ts` 6 例 |
| T026 | 离线知识库闭环验收 | `tests/e2e/gate1.spec.ts`、`tests/fixtures/crud-seed.json` | `tests/e2e/gate1.spec.ts` 6 例 |

### G2（T027–T042）｜verified（真实语义验收除外）

| 任务 | 内容 | 实现位置 | 证据 |
| --- | --- | --- | --- |
| T027 | 模型设置表单与 Key 输入口 | `src/features/settings/LlmSettingsForm.tsx`、`KeyField.tsx` | `tests/integration/settings.test.ts` |
| T028 | Base URL 规范化与出站信任边界 | `src/server/llm/endpointPolicy.ts` | `tests/unit/endpoint-policy.test.ts` 16 例 |
| T029 | 设置事务、秘密隔离与读取白名单 | `src/server/repositories/secrets.ts`、`settings.ts` | `tests/integration/settings.test.ts` 14 例 |
| T030 | 模型错误脱敏与安全日志 | `src/server/observability/redaction.ts` | `tests/unit/redaction.test.ts` 14 例 |
| T031 | OpenAI 兼容 HTTP 适配器 | `src/server/llm/adapter.ts`、`transport.ts`、`protocol.ts` | `tests/unit/llm-transport.test.ts` 17 例 |
| T032 | 连接测试与能力验证 | `src/server/services/testConnection.ts` | `tests/integration/connection-test.test.ts` 16 例 |
| T033 | 整理提示词与不可信材料隔离 | `src/server/llm/prompts/organize.ts`、`shared.ts` | `tests/unit/organize-prompt.test.ts` 10 例 |
| T034 | 中文候选召回与上下文预算 | `src/server/services/findCandidates.ts`、`src/domain/candidates.ts` | `tests/integration/candidate-search.test.ts` 11 例 |
| T035 | 运行注册、幂等和并发占用 | `src/server/services/runs/registerRun.ts` | `tests/integration/run-lock.test.ts` 14 例 |
| T036 | 整理主流程与事务切点 | `src/server/services/organizeItem.ts` | `tests/integration/organize-service.test.ts` 18 例 |
| T037 | 结构化解析、限长与一次修复 | `src/server/llm/parseStructured.ts`、`src/domain/schemas/organize.ts` | `tests/unit/structured-output.test.ts` 17 例 |
| T038 | 整理字段应用与人工保护 | `src/server/services/applyOrganizeMetadata.ts` | `tests/integration/metadata-apply.test.ts` 12 例 |
| T039 | AI 关系证据、去重与拒绝保护 | `src/server/services/applyRelationSuggestions.ts` | `tests/integration/relation-apply.test.ts` 13 例 |
| T040 | 运行恢复、迟到响应与局部轮询 | `src/server/services/runs/recoverExpiredRuns.ts`、`features/shared/useRunStatus.ts` | `tests/integration/run-recovery.test.ts` 15 例 |
| T041 | 模型用量、输入范围与错误诊断 | `src/domain/runDto.ts`、`runDiagnosticsExport.ts`、`server/services/getRunDiagnostics.ts`、`features/settings/RunDiagnostics.tsx` | `tests/unit/run-diagnostics.test.ts` 14 例 + `tests/integration/run-diagnostics.test.ts` 14 例 |
| T042 | AI 闭环与真实连接验收 | 见 `docs/progress/G2.md` | 本文件下方验证结果；真实连接标 blocked |

## 验证结果（本机实测，2026-09-15）

```
node scripts/doctor.mjs     exit 0
npm run contracts           exit 0   （23 条路由路径 / 32 个 method 端点：13 已实现、7 登记待办；53 limits；28 错误码）
npm run lint                exit 0
npm run typecheck           exit 0
npm run test                exit 0   （29 套件 363 例）
npm run build               exit 0   （26 条路由，Turbopack，0 警告）
npx playwright test         exit 0   （49 例，8 个 spec，110.9s）
```

规模实测（T050-C01，60 节点）：打开 530ms、自动布局 105ms、拖动 536ms。

门禁报告：`docs/progress/G0.md`、`G1.md`、`G2.md`、`G3.md`。
运行证据：`implementation/progress/evidence/G0.md`、`G1.md`、`G2.md`、`G3.md`。

## 本轮 review 修复的真实缺陷（G1 之后累计）

G2 收尾时做了一轮深度 review，发现的每一条都有可复现现象，不是风格偏好。
完整复现入口见 `evidence/G2.md` 第 5 节。

| 缺陷 | 后果 | 修复 |
| --- | --- | --- |
| e2e 运行的是**过期生产构建**（`.next/BUILD_ID` 比最后一次源码修改早 36 秒） | `T024-C01` 假报「创建触发了模型调用」，把真实回归淹没在误报里 | `tests/e2e/support/buildFreshness.ts` 在配置加载阶段比对 mtime，过期即 `E2E_STALE_BUILD` 并给出处置；4 个单元用例 |
| `resetE2eDataDir` 被上一进程残留的文件锁打断（Windows `EPERM`） | 整个套件在配置加载阶段死掉，9 个用例 not run，错误只有一行 EPERM | `rmSync` 加 `maxRetries: 20, retryDelay: 250`，最终失败时报告具体目录与原因 |
| `.gitignore` 只忽略 `tests/e2e/.data/`，漏掉 `.data-restart/` | 跑完 e2e 后 `git add -A` 可能把测试数据库提交进仓库 | 两个目录都列入；本地核验用的 `.tmp-*.log`、`.tmp-*-data/` 一并忽略 |
| `playwright.config.ts` 注释指向不存在的 `scripts/prepare-e2e.mjs` | 文档与实现不一致，误导排查 | 改指真实的 `tests/e2e/support/resetData.ts` |

G1 期间的修复（分页游标 SQL、join 列名二义、`decodeEvidence` 字段名、Turbopack 警告、
选择同步清理、缺配置提示被清掉、Ctrl+Enter 重复提交、契约守卫忽略项匹配）见
`docs/progress/G1.md` 第五节。

## 规则落点（G2 新增，逐条）

- **T028-R01/R02** HTTPS-only、禁止用户名/密码/查询/片段与自带 `/chat/completions`；
  `localhost`、回环与内网字面量被拒。声明边界：公网域名仍可能解析到内网地址，如实记录而非谎称已拦截。
- **T029-R01/R02** 配置与秘密同一事务写入；`revision` CAS 保护。
- **T030-R01/R02/R04** 日志为白名单结构（无 `data`/`body`/`headers`），字符串再过值脱敏：
  先替换活跃秘密字面量，再匹配凭证形状；`keyLength` 恒为 `null`；用户可见消息剥离绝对路径。
- **T031-R01/R02/R03/R04** 不发 `temperature`；两种 token 字段至多一个；`json_object` 只按显式选择；
  超时是**操作的绝对截止时刻**而非每次重新计时；响应按字节上限读取。
- **T033-R01** 用户材料包在 `<<<UNTRUSTED MATERIAL>>>` 中，系统消息声明其中内容不得当指令
  （样本：`tests/fixtures/prompt-injection.json`）。
- **T034-R02/C06** `LIKE` 通配符按字面转义；只做字面召回，词不同就用 `notes` 承认局限。
- **T035-R02/R03/R04** 同键重放不执行；全局槽位由 `idx_one_global_running` 唯一索引占用
  （非进程变量，两个标签页也无法各发一次）；事务在网络请求**之前**提交。
- **T036-R02/R04** 模型调用期间不持事务；元数据、标签、关系、条目状态、dataset revision 与
  Run 终态在同一事务提交，任一失败整体回滚。
- **T037-R02/R05** 只用 `JSON.parse`；修复仅对「完整但格式不对」的答案开放且限操作预算内。
- **T038-R03** 整理期间 `rawVersion` 变化则整次拒绝，不做逐字段合并。
- **T039-R01/R03/R05** 未发送的条目按未知拒绝；证据 quote 必须是当前原文子串；同批重复
  `(targetId, type)` 只写一条；`suggested` 同键就地刷新，不插平行边。
- **T040-R01/R03/R05** 只恢复超租约的行；终态单向不可复活；恢复不调用模型、不删 Run。
- **T041-R01/R02/R05** 诊断读取只读（不触发模型、不占槽位、不写库）；用量缺失报「未记录」，
  不用字数换算伪装；摘要不出现金额或推算费用。

## 测试基础设施（G2 期间新增）

- `tests/e2e/support/buildFreshness.ts`：生产构建 freshness 守卫，`playwright.config.ts` 在
  加载时调用，避免「测到上一次构建」被当成产品回归。
- `tests/e2e/support/resetData.ts`：隔离数据目录清理加 Windows 文件锁重试与可诊断错误。
- 证据规则：替身与真实调用分开标注；`BLOCKED_BY_EXTERNAL_CREDENTIAL` 不得写成「真实服务已通过」。

## 已知阻塞

- **BLOCKED_BY_EXTERNAL_CREDENTIAL**：真实 LLM Provider 连通性与整理语义质量需要用户自己的
  API Key。连接测试、整理、修复、限流与超时分支均以替身覆盖**结构**断言；不影响本机实现与离线功能。
- **未执行**：多浏览器（Firefox/WebKit）与真机测试。
- **未执行**：CSP 生产配置实测（需先分别验证 Mermaid/Markmap 所需样式，前置到 G6 前）。
- **未执行**：性能预算（属 T079）。

## 下一步：G6 续做（T077–T084）

**T077** API 与 SQLite 集成测试（依赖 T070/T071/T072/T076——均已 verified）
→ **T078** 六页浏览器端到端验收（依赖 T077）
→ **T079** 加载/查询/图形性能预算（依赖 T050/T057/T066/T078）
→ **T080** Windows 安装与故障手册（依赖 T001/T002/T004/T073/T079）
→ **T081** 生产构建、依赖审计与发布材料（依赖 T075/T078/T079/T080）
→ **T082** 中文文案与无障碍终审（依赖 T078/T081）
→ **T083** 任务证据与缺陷清单（依赖 T076–T082）
→ **T084** 最终用户旅程与 MVP 完成定义（依赖 T083）。

T077–T084 主要是**收敛既有成果**（集成套件、六页 e2e、性能预算、发布材料、终审），
不再是新建功能，所以应直接复用各 Gate 已有证据而不是另起一套——
入口是 `docs/test-coverage-map.md`。**T083/T084 是 G6 的出口条件本身**——
T084 的「MVP 完成定义」就是「全部做完」的判定标准，不能提前宣布。

T077 起**依次串行**。串行不是保守：T078 与 T079 都要跑 Playwright / 生产构建，
并行会抢同一个端口与 `.next`。

G6 可直接复用的既有能力：

- **导出/恢复**：`src/domain/exportBundle.ts`、`importBundle.ts`、`src/server/services/exportKnowledge.ts`、
  `validateImport.ts`、`importKnowledge.ts`；整库快照与事务切点的既有范式，T081 的发布材料应引用它们。
- **诊断**：`src/server/observability/diagnostics.ts`（T074，本轮交付）的失败层级分类与有界日志，
  以及 `src/server/services/getRunDiagnostics.ts` + `src/domain/runDiagnosticsExport.ts`（T041）
  的运行诊断投影；T081 的发布材料与 T082 的文案终审都要读这两处而不是另造字段。
- **安全层**：`src/server/security/localGuard.ts`（token/origin/host/sec-fetch-site）、
  `src/server/observability/redaction.ts`（`registerSecret` / `redactSecrets`）；
  安全回归的单一入口是 `tests/security/`（T075），`docs/security-checklist.md` 是权威清单。
  `registerSecret` 曾在两处关键接线缺失导致非 `sk-` 形态 Key 明文落库，回归时优先查这两处。
- **契约守卫**：`scripts/check-contracts.mjs` + `tests/contracts/guard.test.ts`。
  `PENDING_ROUTES` 现已为**空**，所以 T012-C06 走的是"往 registry 注入幽灵端点 + 反向样本
  （登记进待办表后必须被接受）"这条分支；将来若有新任务登记待办端点，它会自动切回删登记那条。


G5 可直接复用的既有能力（仍有效）：

- 视图层：`src/app/api/views/*`、`src/server/repositories/views.ts`、`src/domain/view.ts`
  （`computeStaleness` / `describeSourceDrift` / `describeStaleness` / `ViewFreshness`）——T067
  的保存、来源与新鲜度应与脑图视图同构，不要另写一套。
- 快照与哈希：`src/domain/sourceSnapshot.ts` 的 `captureSources`（T063/T067 的材料快照直接复用）。
- 生成路径：`src/server/services/generateMindmap.ts` 的事务切点、Run 注册与结构校验模式；
  `src/domain/compileMindmap.ts` 是「受限编译 + 转义」的既有范式，T064 的 Mermaid 编译器应对齐它。
- 渲染与净化：`src/features/mindmap/MindmapRenderer.tsx` 与 `sanitizeContent.ts` 已解决
  「第三方渲染器实例生命周期 + 白名单净化 + 本地资源」三个问题（含 `destroy()` NaN 几何那个真实缺陷），
  T065/T066 必须复用同一套结论而不是重新踩一遍。
- 导出：`src/domain/viewExport.ts`、`src/server/services/views/exportView.ts`、
  `src/app/api/views/[id]/export/route.ts`（文件名不采信用户输入、只读、错误走信封成功走裸 Response）。
- E2E 装置：`tests/e2e/support/`（`harness.ts` 的 capture/auth/navigate、`seedData.ts` 的 `seedView`、
  `restartServer.ts` 真重启、`traffic` fixture 记账、`gomindmap.ts` 的生成与画布探针）。
- 生成测试替身：`BRAIN_SCRIPTED_PROVIDER`（`src/server/llm/transport.ts`）。指向脚本目录即可让
  真实路由/适配器/事务全跑、只替换出站 HTTP 一步；**只允许非用户数据目录**。T069 会用到。

## T061 收口时修掉的用例缺陷

T061 本身**没有产品缺陷**；查出来的是四条用例自身的问题（细节见 `evidence/G4.md` 第 8 节末表）：

| 问题 | 后果 | 修复 |
| --- | --- | --- |
| C02 把视图种进 `.data`，却在 `.data-restart` 的服务上打开 | 与环境无关地必挂，且会被误读成「重启丢数据」 | 新增只服务该用例的 `seedMindmapViewIn(restartDataDir(), …)`，不改其它用例共用的 `seedMindmapView` |
| C02 用 `pages().length` 当断言（没有断言） | 「重启后不再请求模型」这条契约**没有证据**，读起来却是绿的 | 改为对 `traffic` fixture 记账断言：`/mindmap/generate` 为 0，`blockedRequests()` 为 0 |
| C04 直调生成 API 后没刷新视图下拉 | 新视图 id 不在 `<option>` 里，用例必挂且失败原因与「再生成另存」无关 | 生成后重新 `goto('/mindmap')`，先等 `option[value=newViewId]` 出现，再断言两个 id 都在 |
| C01 断言 5 个节点、产品默认「两层」只画 4 个（62 次稳定复现） | 用例必挂，但根因是**产品行为正确**（三层树的深节点被设计性折叠）；依用例改产品等于删掉展开控制 | 加 `expandAll(page)`，经产品自己的 `mindmap-expand-level` 选「全部展开」再断言全树节点数；叶节点 id 归属、根重算、来源面板断言原样保留 |

## T060 已修复的缺陷

没有产品缺陷。唯一一次失败是**测试写得比契约更严**：T060-C05 原本要求同一视图两次导出逐字节相同，
而同日连导两次时「导出时间」差了几毫秒。契约允许且明确允许这一行不同，因此改为先归一化「导出时间」
一行再比对全文，而不是放宽产品实现。

## T059 已修复的真实缺陷

每一条都有可复现现象，不是风格偏好；完整复现方式见 `evidence/G4.md` 第 6 节。

| 缺陷 | 后果 | 修复 |
| --- | --- | --- |
| `computeStaleness` 把**已删除的关系 id 塞进 `missingSources`** | 该字段契约是「已不存在的**条目** ID 数组」，调用方按条目 id 解析标题——关系 id 混进去会解析失败，界面只能显示成「找不到的笔记」，而真实原因（这条关系没了）丢失 | `missingSources` 只收条目 id；关系缺失照常计入 `changedRelationIds` 并在新增的 `drift` 明细里带 `kind: 'relation'`；`describeStaleness` 对已删关系单独成句「N 条关系已删除」 |
| 生成接口只接受 `selection.mode='explicit'`，而按标签保存的视图存的是 `filter` | 这类视图过期后**无法重新生成**：界面拿不到「当前选择解析成哪些 id」，只能报错或发出一个不含材料的请求 | `getViewFreshness` 用与生成路径**同一个** `captureSources` 重新解析并存 `resolvedIds` 交给确认框；确认后由界面按既有契约发 `{mode:'explicit', itemIds}`，服务端不接受筛选体这一点没有放宽（`04_api_contract.md` §38） |
| 客户端组件从 `@/server/services/...` 取 `ViewFreshness` 类型 | 违反 T003-R02，lint 直接报错；即使绕过去，客户端 bundle 也会拖进服务端模块 | 读模型类型移到 `src/domain/view.ts`（与 `RunDiagnostics` 放域层的既有做法一致），服务层 `export type { ViewFreshness }` 转出 |

## G4 已修复的真实缺陷

每一条都有可复现现象，不是风格偏好；完整复现方式见 `evidence/G4.md` 第 5 节。

| 缺陷 | 后果 | 修复 |
| --- | --- | --- |
| `MindmapRenderer` 把 Markmap 实例挂在一个**内含子节点**的 `<svg>` 上 | `destroy()` 清不掉 React 渲染的内层节点，`fit()` 量到 `0×0` 几何并写出 `translate(NaN,NaN) scale(NaN)`：节点全在 DOM 里但零面积不可见。表现为「图看起来画完了却什么都没有」，E2E 间歇失败 | 交给 Markmap 的那个 `<svg>` 本身即为画布，React 不在其中渲染任何子节点；挂载期间也不再把画布包进 `hidden` 容器（`display:none` 会让 `fit()` 量到零几何） |
| `annotateTree` 只接受「渲染节点数 === id 数」 | 根节点与标题**同名**时 Markmap 的根就是 AST 根，而旧实现漏掉位置 0，于是点一个节点会打开**另一个节点**的来源，且每张正常脑图都被判为结构不一致而拒绝绘制 | 用节点数区分两种形态：同名逐位置对齐；不同名时 Markmap 的根是标题合成的、不对应任何 AST 节点（恰好多 1 个），保持无 id 以免 `byId` 出现两个同 id |
| 大纲在结构异常时沿用正常遍历、只补「走不到的」节点 | 重复 id 会被遍历永久跳过，3 节点的坏图只显示 2 行，恰好丢掉「哪一行是重复的」这个信息 | 结构检查不合格时整体改用扁平列表，逐行列出存储中的每个节点 |

## G3 收尾 review 修复的真实缺陷

每一条都有可复现现象，不是风格偏好；完整复现方式见 `evidence/G3.md` 第 7 节。

| 缺陷 | 后果 | 修复 |
| --- | --- | --- |
| `getGraphData` 在**全库关系**上派生新鲜度 | 端点不在本次读取范围内的关系被判为 `missing`，页面显示「端点已删除」——而那条记录只是没被读进来 | 只在 `coveredRelations`（两端版本都在读取窗口内）上派生，`staleCount` / `missingCount` 只反映当前图范围 |
| `GraphEdge` 缺少 `evidence` 字段 | 检查面板要求用户接受或拒绝模型判断，却看不到判断依据的原文（T049-R02/C02） | 领域 DTO 增加 `evidence`，由 `buildGraph` 投影已校验过的引文，面板逐条显示出处 |
| E2E 把节点拖到**视口外** | `boundingBox()` 对折叠线以下的节点照样返回坐标，但瞄准 `y > innerHeight` 的鼠标事件谁也收不到，拖动静默失效 | 新增 `dragNode()`：先滚进视口、断言完整可见，再按下/移动/松开并比较 `transform` |
| 用 `boundingBox()` 断言节点尺寸 | 该值在**屏幕空间**，被 `fitView` 缩放：208px 读成 216px，看起来像被长标题撑大 | 新增 `nodeLayoutSize()` 读 `offsetWidth/offsetHeight`（变换前布局尺寸），严格等于 `NODE_WIDTH`/`NODE_HEIGHT` |
| 与防抖计时器竞态 | 拖动后立刻读存储行作基线，断言可能读晚 | 拖动**前**读基线，拖动后轮询到 revision 前进且坐标变化 |
