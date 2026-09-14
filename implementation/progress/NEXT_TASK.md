# 当前实施位置

当前：**G1 进行中**。T013–T023 已实现并通过局部验收；下一步 T024（无 Key 与断网可用路径）→ T025 → T026 收尾 G1。

## 已完成

### G0（T001–T012）

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

### G1（T013–T023）

| 任务 | 内容 | 实现位置 | 证据 |
| --- | --- | --- | --- |
| T013 | 极简输入框与中文输入体验 | `src/features/inbox/CaptureBox.tsx`、`useCapture.ts` | 见下 |
| T014 | 保存接口与采集幂等 | `src/app/api/items/route.ts`、`src/server/services/items.ts` | `tests/integration/capture.test.ts`、`capture-http.test.ts` |
| T015 | 收件箱时间线与知识卡片 | `src/features/inbox/RecentItems.tsx`、`shared/KnowledgeCard.tsx` | 见下 |
| T016 | 资料库搜索、过滤与分页 | `src/features/library/LibraryPage.tsx`、`src/server/services/queryItems.ts` | 见下 |
| T017 | 标签规范化与关联维护 | `src/features/shared/TagInput.tsx`、`src/server/repositories/tags.ts` | 见下 |
| T018 | 详情抽屉、原文和来源回溯 | `src/features/shared/KnowledgeDrawer.tsx`、`SourceReference.tsx` | 见下 |
| T019 | 人工编辑、版本冲突与字段保护 | `src/features/library/EditItemForm.tsx`、`src/server/services/editItem.ts` | 见下 |
| T020 | 删除确认与引用失效 | `src/features/shared/DeleteItemDialog.tsx`、`src/server/services/deleteItem.ts` | 见下 |
| T021 | 跨视图材料选择与数量预算 | `src/domain/selection.ts`、`src/features/shared/useSelection.ts`、`SelectionTray.tsx`、`src/server/services/selection.ts`、`src/app/api/selection/route.ts` | 见下 |
| T022 | 人工关系创建与方向语义 | `src/domain/relations.ts`、`src/server/services/createRelation.ts`、`src/features/shared/RelationEditor.tsx`、`src/app/api/relations/route.ts` | `tests/integration/relations.test.ts`（T022 段，12 例） |
| T023 | 关系审核、拒绝记忆与人工优先 | `src/server/services/reviewRelation.ts`、`src/features/shared/RelationReviewPanel.tsx`、`src/app/api/relations/[id]/route.ts` | `tests/integration/relations.test.ts`（T023 段，8 例） |
| T025 | 保存反馈、草稿与未知完成状态 | `src/features/shared/MutationStatus.tsx`、`src/features/inbox/useCapture.ts`（部分完成，待 e2e） | 见下 |

## T013–T021/T025 的规则落点（逐条）

- **T013-R03** IME：`CaptureBox.onSubmitShortcut` 检查 `nativeEvent.isComposing || keyCode === 229`，Enter 只换行。
- **T013-R05 / T025-R05** 只在提交快照未被改动时清空草稿：`useCapture` 记录 `draftRevision`，
  回包后比较 `draftRevisionRef.current === revision && draftSnapshot.text === text`。
- **T021-R01** 选择状态只存 ID；`src/server/services/selection.ts` 在生成前重新读取条目与版本。
- **T021-R03/R05** 标签选择在预览时解析为显式 ID 快照（`resolveSelection.fromTagId`），
  后续新增同标签记录不会改变已解析结果。
- **T021-R04** 删除的已选条目：`prune()` 移除并置 `removedIds`，托盘显示已移除数量。
- **T021-R06** 标签快照解析在服务端，URL 只携带 ID；切换页面不发任何模型请求。
- **T022-R01** `normalizeEndpoints` 对 `similar_to/contradicts/related_to` 按 UUID 排序，有向类型保留语义。
- **T022-R03** 人工关系 `score = null`，不使用 1.0。
- **T022-R04** 同规范键的 AI 建议被 `promoteToManual` 就地升级，不插平行边。
- **T022-R06** 端点 `rawVersion` 变化后 `isStale = true`；`reconfirm` 才更新依据版本。
- **T023-R01/R02** `suggested / accepted / rejected` 三态都留在库中；`rejected` 默认不进查询但保留去重键。
- **T023-R03** `origin=manual` 的行拒绝 AI 审核动作（返回 422/VALIDATION），删除走 DELETE。
- **T023-R04** 审核使用 `expectedRevision` CAS；旧 revision 返回 409 且不覆盖先前决定。
- **T023-R06** `RelationReviewPanel` 显示来源（AI/人工）、理由、依据版本、评分含义与过期提示。
- **T025-R01/R02/R04** `MutationStatus` 区分 `saving / saved / unknown / failed`；
  整理失败单独提示，不改写“已保存”。
- **T025-R03** 草稿放模块级内存 store（`useSyncExternalStore`），不写 localStorage；
  有未提交内容时注册 `beforeunload` 提示。
- **T024-R01** 已移除 `next/font/google`；字体栈改为纯本地（`globals.css` 的 `--font-sans-stack`）。

## G1 验证结果（本机实测）

```
npm run contracts   exit 0   （32 条路由：8 已实现 / 15 登记待办；53 项 limits；27 个错误码）
npm run lint        exit 0
npm run typecheck   exit 0
npm test            exit 0   （58 个用例通过：unit 12 + integration 47 + contracts 6，按文件计 6 个套件）
npm run build       exit 0   （16 条路由，Turbopack；1 条已知警告见下）
```

`tests/integration/relations.test.ts` 覆盖 T022 的 12 个场景（自环、对称重放、有向语义、
人工升级、端点缺失、版本冲突、过期与重新确认、理由长度）与 T023 的 8 个场景
（拒绝墓碑、接受保留评分、人工边拒绝 AI 审核、revision 冲突、幂等审核、撤销拒绝、
重新确认丢弃失效引文、删除不影响其他关系）。

## 已知阻塞

- **BLOCKED_BY_EXTERNAL_CREDENTIAL**：真实 LLM Provider 连通性验证需要用户自己的 API Key。
  不影响本地实现与离线功能，G2 起用替身完成结构断言、真实语义验收留给用户。
- **待补 e2e**：`tests/e2e/` 尚未建立（`@playwright/test` 已安装但无配置与浏览器）。
  T013/T021/T024/T025/T026 的浏览器级用例列入 T026 收尾。

## 遇到的真实缺陷与修复

- `@next/swc-win32-x64-msvc` 原生二进制因网络中断被下载截断（实际约 8 MB，
  正确 34863832 字节），导致 production build 报 “native bindings are not available”。
  已用 `scripts/fetch-verified.mjs`（断点续传 + SHA-512 校验）重新取得并替换。
- `RELATION_COLUMNS` 未加 `r.` 前缀，而关系查询 JOIN 了 `knowledge_items` 两次，
  导致 `ambiguous column name: id`。已限定为 `r.*` 修复（T022 集成测试发现）。
- `decodeEvidence` 按 `item_id` 读取，与 DTO/存储约定的 `itemId` 不一致，读到 `undefined`。
  已改为接受 `itemId`（兼容旧 `item_id`）。
- `decodeItemRow` 依赖 `capture_request_id`，但列表查询没有选择该列，详情读取才会失败。
  属于潜伏缺陷，后续加入列表路径回归测试时一并验证。

## 下一步

T024（无 Key 与断网可用路径）→ T025 收尾（e2e 用例）→ T026（Gate1 闭环验收、种子 fixture、
`docs/progress/G1.md`）。之后进入 G2（LLM 设置、密钥、传输、连接测试、提示词、候选检索、整理流水线）。
