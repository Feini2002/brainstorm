# G0/G1/G2 状态升级审计（T001–T042）

审计日期：2026-09-15（Tuesday）
审计对象：`implementation/progress/tasks.current.json` 中 gate 0/1/2 的 42 个任务（T001–T042）
审计性质：**只读审计**。除本文件外未修改任何文件；未 commit / push；未新增或升级依赖；未运行 Playwright。

---

## 0. 审计范围、方法与判据

### 0.1 判据（本文档统一使用，先声明再执行）

| 归类 | 判据 |
| --- | --- |
| **A（可升级 verified）** | (1) `docs/progress/Gx.md` 指认的实现文件全部存在；(2) 该任务至少有 1 条**带自身 id 标签**（如 `T028-…`）的 vitest 用例，且本次真实通过；(3) `docs/progress/Gx.md` 与实测在文件位置/用例数上不矛盾 |
| **B（保持 implemented）** | 实现存在，但 (1)(2)(3) 有不满足项；或实现类 targetFile 缺失；或只有间接/同构断言 |
| **C（needs_e2e）** | 实现存在，但**只有 e2e 证据**，或没有任何可复跑的自动化证据指向该任务 |

补充约定（避免把规格期候选文件名当成实现缺陷）：

- **实现类 targetFile 缺失** → 计入判据，可能导致 B。
- **测试类 targetFile 缺失 / 文件名与契约漂移**（如契约写 `candidates-search.test.ts`、实现落在 `candidate-search.test.ts`）→ **不作为 A/B/C 判据**，统一列在「第 6 节 文档与事实不一致」中，因为实现文档已给出实际落点。

### 0.2 本次实际执行的命令（全部在仓库根目录）

| # | 命令 | 退出码 | 结果摘要 |
| --- | --- | --- | --- |
| 1 | `npx vitest run` | **0** | 37 个测试文件 / **450 用例全部通过**，0 失败 |
| 2 | `npx vitest run --reporter=json --outputFile=.tmp-vitest.json` | **0** | 用于取得 case 级标题，供任务↔用例映射 |
| 3 | `npm run test:unit` | **0** | 16 文件 / 183 用例通过 |
| 4 | `npm run test:integration` | **0** | 20 文件 / 260 用例通过 |
| 5 | `npm run test:contracts` | **0** | 1 文件 / 7 用例通过 |
| 6 | `node scripts/doctor.mjs` | **0** | `ok: true`，node 24.18.0，win32 x64，`projectPathHasNonAscii: true`，sqlite ok，`network: not-checked` |
| 7 | `npm run contracts` | **0** | 23 路径 / 32 端点：**18 已实现、5 待办**；53 limits；**28 错误码**；3 条本地扩展路由 |
| 8 | `npm run lint` | **0** | 0 error，**1 warning**（`tests/e2e/gate4.spec.ts:5` 未使用导入） |
| 9 | `npm run typecheck` | **1** | **18 个 TS 错误，全部在 `tests/e2e/gate4.spec.ts`** |
| 10 | `npm ls --depth=0` | **0** | 依赖树完整 |
| 11 | `git check-ignore -v tests/e2e/.data-restart/` | **0** | 命中 `.gitignore:46`（G2 声称的修复成立） |
| 12 | targetFiles 存在性扫描（脚本，见第 6 节） | — | 见下 |

### 0.3 未执行（按指令）

- **未运行 Playwright**（另一个 worker 占用 3100 端口）。因此所有依赖 `tests/e2e/**` 的任务一律给 **C**，不臆测其通过。
- **未运行 `npm run build`**（避免与并发 worker 抢 `.next` 与端口）。`npm run check` 因此未执行。
- **未验证真实 LLM Provider**（BLOCKED_BY_EXTERNAL_CREDENTIAL，无 Key）。

---

## 1. 总表

「本次重跑」列说明：整库 `npx vitest run` 退出码 **0**，450/450 通过。表中「N 例」指**带该任务 id 标签**且本次通过的用例数（用 JSON reporter 逐条匹配标题中的 `T0xx` 得到）。

### Gate 0（T001–T012）

| task | 标题 | 当前 status | 实现文件存在 | 证据/测试文件 | 本次重跑 | 建议 | 依据（一句话） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T001 | 运行时预检与系统边界 | implemented | 3/3 存在 | `tests/unit/doctor.test.ts` | 5 例通过（2 例带 T001 标签）；`node scripts/doctor.mjs` exit 0 | **A** | 门禁命令可复现、C01/C06 有真实断言、C02 由 `projectPathHasNonAscii:true` 佐证；C03/C04/C05 未执行但已在报告第四节披露 |
| T002 | 依赖解析、锁定与下载 | implemented | 4/4 存在 | 无 | 无 vitest 用例；`npm ls --depth=0` exit 0 | **B** | `package.json`/`package-lock.json`/`.npmrc`/`docs/dependency-report.md` 齐全，但六条用例零自动化断言，`npm ci` 干净重装自述留待 G6 |
| T003 | 工程目录与服务端隔离 | implemented | 6/6 存在 | 无（仅 lint） | 无 vitest 用例；`npm run lint` exit 0 | **B** | ESLint 分层规则真实存在且本次通过，但 C01–C06 全是行为用例，lint 只证明当前导入图合法，不构成六条用例的证据 |
| T004 | 启动脚本、回环监听与退出 | implemented | 4/4 存在 | `tests/e2e/gate1.spec.ts#T026-C02` | 无 vitest 用例 | **C** | 唯一自动化证据是 Playwright 重启用例；G0 evidence 的启动实测是一次性手工观察（外部超时 kill），不可复跑 |
| T005 | 六页应用骨架与导航状态 | implemented | 4/4 存在 | `tests/e2e/gate1.spec.ts#T026-C05` | 无 vitest 用例 | **C** | 六路由可达性只由 e2e 断言（且 T026-C05 只验证导航可见，未覆盖 C03 窄窗口/C04 键盘/C05 局部失败） |
| T006 | 统一响应、错误与前端请求器 | implemented | 3/3 存在 | 无直接证据 | 无 vitest 用例 | **B** | HTTP 层信封行为被 `capture-http.test.ts` 间接覆盖（但标签归属 T014），`src/domain/api.ts` 与 `apiClient.ts` 无任何测试导入，C04 断网/C05 缓存回放无断言 |
| T007 | 本地请求令牌与来源防护 | implemented | **2/3**（`src/features/shared/session.ts` 不存在） | `tests/e2e/gate1.spec.ts#T026-C02` | 无 T007 标签用例；`settings.test.ts:340`（T029-R03）间接断言 403 + 无写入 | **B** | 契约点名的**实现文件缺失**，且无带 T007 id 的断言；C02 Host 伪装/C04 重启恢复/C05 端口不一致均无自动化证据 |
| T008 | 数据路径、连接与文件生命周期 | implemented | 3/3 存在 | `tests/integration/database-runtime.test.ts` | 文件 7 例通过，其中 4 例带 T008 | **A** | 真实 SQLite 文件 + WAL/外键/连接复用断言本次全通过，文档记 7 例与实测一致 |
| T009 | 初始迁移与数据库约束 | implemented | 2/2 存在 | `tests/integration/database-runtime.test.ts` | 文件 7 例通过，其中 4 例带 T009 | **A** | 迁移与约束有真实断言（九张表、CHECK 枚举、高版本库拒绝）；契约点名的 `migrations.test.ts` 不存在，但已在 G1 evidence §4 如实披露 |
| T010 | Repository 与 DTO 解码 | implemented | 目录/文件存在 | `tests/integration/repositories.test.ts` | 15 例通过（15 例均带 T010） | **A** | C01–C06 与 R01–R06 均有直接断言（DTO 一致性、游标分页、LIKE 字面转义），文档记 15 例与实测一致 |
| T011 | 隔离测试环境与模型替身 | implemented | 5/5 存在 | `tests/integration/database-runtime.test.ts`（T011-R01） | 1 例带 T011；三 project 均 exit 0 | **A** | 测试装置真实可运行（450 例全过），"不触碰真实 `.data`"有直接断言；C02/C03/C04/C06 无独立断言，属未覆盖而非造假 |
| T012 | 契约一致性与第一阶段验收 | implemented | 3/3 存在 | `tests/contracts/guard.test.ts` | 7 例通过；`npm run contracts` exit 0 | **A** | 限制漂移/枚举漂移/`.gitignore`/待办路由登记均有断言，`docs/progress/G0.md` 记 7 例与实测一致（`evidence/G0.md` 记 6 例系笔误，见第 6 节） |

### Gate 1（T013–T026）

| task | 标题 | 当前 status | 实现文件存在 | 证据/测试文件 | 本次重跑 | 建议 | 依据（一句话） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T013 | 极简输入框与中文输入体验 | implemented | 2/2 存在 | `tests/e2e/offline-crud.spec.ts`、`save-races.spec.ts` | 无 vitest 用例 | **C** | IME/草稿快照等规则只在 e2e 与组件代码里，无 vitest 断言；契约点名的 `tests/e2e/capture.spec.ts` 不存在（亦未被文档认领） |
| T014 | 保存接口与采集幂等 | implemented | 2/2 存在 | `capture.test.ts` + `capture-http.test.ts` | **20 例通过**（10+10） | **A** | 幂等键、同键异内容 409、事务回滚、令牌拒绝均有直接断言；文档记 10+10 与实测一致 |
| T015 | 收件箱时间线与知识卡片 | implemented | 3/3 存在 | `tests/e2e/gate1.spec.ts#T026-C01/C02` | 无 vitest 用例 | **C** | `RecentItems.tsx`/`KnowledgeCard.tsx`/`formatTime.ts` 无测试导入，证据仅 e2e |
| T016 | 资料库搜索、过滤与分页 | implemented | 3/3 存在 | `tests/integration/repositories.test.ts` | 无 T016 标签用例（同文件 15 例均带 T010） | **B** | 文档指认的测试存在且通过，但用例自带 T010 归属、覆盖的是仓储层；`queryItems.ts` 与 `LibraryPage.tsx` 无防回归入口 |
| T017 | 标签规范化与关联维护 | implemented | 3/3 存在 | `tests/e2e/gate1.spec.ts#T026-C02` | 无 vitest 用例 | **C** | `normalizeTag` 只被其它测试当 helper 使用，没有任何针对 T017 规则的断言；证据仅 e2e |
| T018 | 详情抽屉、原文和来源回溯 | implemented | 3/3 存在 | `tests/e2e/gate1.spec.ts#T026-C01` | 无 vitest 用例 | **C** | `KnowledgeDrawer.tsx`/`SourceReference.tsx` 无测试导入；契约点名的 `src/app/api/items/[id]/route.ts` 实际存在，但无 HTTP 层测试指向它 |
| T019 | 人工编辑、版本冲突与字段保护 | implemented | 3/3 存在 | `tests/e2e/gate1.spec.ts#T026-C03` | 无 T019 标签用例 | **B** | `editItem.ts` 无直接测试；文档自述的"同构断言"实为 `relations.test.ts`/`metadata-apply.test.ts` 的 409 用例（归属 T022/T038）；C02 标题人工锁与 C06 字段重置无断言 |
| T020 | 删除确认与引用失效 | implemented | 2/2 存在 | `tests/e2e/gate1.spec.ts#T026-C04` | 无 vitest 用例 | **C** | `deleteItem.ts` 无测试导入；契约点名的 `tests/integration/delete.test.ts` 不存在（文档已披露）；证据仅 e2e |
| T021 | 跨视图材料选择与数量预算 | implemented | 3/3（+`services/selection.ts`）存在 | `tests/e2e/gate1.spec.ts#T026-C04` | 无 vitest 用例 | **C** | 选择/预算规则（R01 只存 ID、R04 删除即清理）无服务端断言，证据仅 e2e 托盘文案 |
| T022 | 人工关系创建与方向语义 | implemented | 3/3 存在 | `tests/integration/relations.test.ts` | **12 例通过** | **A** | 自关联拒绝、对称规范化、方向语义、score=null、端点失效均有直接断言；文档记 12 例与实测一致 |
| T023 | 关系审核、拒绝记忆与人工优先 | implemented | 2/2 存在 | `tests/integration/relations.test.ts` | **8 例通过** | **A** | 拒绝墓碑、接受不改 origin、旧 revision 409、撤销拒绝均有断言；文档记 8 例与实测一致；`review.test.ts` 缺位已披露 |
| T024 | 无 Key 与断网可用路径 | implemented | 3/3 存在 | `tests/e2e/offline-crud.spec.ts`（6 例） | 无 vitest 用例（e2e 未跑） | **C** | 实现与 spec 文件均在，但零 vitest 证据；按指令未跑 Playwright，无法复核"6 例通过" |
| T025 | 保存反馈、草稿与未知完成状态 | implemented | 3/3 存在 | `tests/e2e/save-races.spec.ts`（6 例） | 无 vitest 用例（e2e 未跑） | **C** | `MutationStatus.tsx` 状态机无单测；证据仅 e2e |
| T026 | 离线知识库闭环验收 | implemented | 3/3 存在 | `tests/e2e/gate1.spec.ts`（6 例） | 无 vitest 用例（e2e 未跑） | **C** | 验收载体只有 e2e + `docs/progress/G1.md`；按指令未跑 Playwright，其"6 例通过"本次**未复核** |

### Gate 2（T027–T042）

| task | 标题 | 当前 status | 实现文件存在 | 证据/测试文件 | 本次重跑 | 建议 | 依据（一句话） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T027 | 模型设置表单与 Key 输入口 | implemented | 3/3 存在 | `tests/unit/llm-config.test.ts` | **12 例通过** | **A** | keyAction 三态、转移确认、校验先于确认均有断言；`docs/progress/G2.md` 该行把证据指向 `settings.test.ts`（不含 T027 用例）系指认错误，见第 6 节 |
| T028 | Base URL 规范化与出站信任边界 | implemented | 3/3 存在 | `tests/unit/endpoint-policy.test.ts` | **16 例通过** | **A** | https 强制、凭据/query/fragment 拒绝、私网字面量拒绝、redirect/重试边界均有断言；文档记 16 例一致 |
| T029 | 设置事务、秘密隔离与读取白名单 | implemented | 3/3 存在 | `tests/integration/settings.test.ts` | **12 例带 T029 通过**（文件共 14） | **A** | 同事务写入、CAS 拒绝旧 revision、写失败回滚、GET 无 Key 痕迹、跨站 403 且无写入均有断言 |
| T030 | 模型错误脱敏与安全日志 | implemented | 1/1 存在（`observability/redaction.ts`） | `tests/unit/redaction.test.ts` | **14 例通过** | **A** | 白名单字段 + 值脱敏双层、Key 回显在错误信息中的场景、绝对路径占位均有断言；契约点名的 `redact.ts`/`logger.ts` 实际未按该名落盘 |
| T031 | OpenAI 兼容 HTTP 适配器 | implemented | 3/3 存在（`adapter.ts`/`transport.ts`/`protocol.ts`） | `tests/unit/llm-transport.test.ts` | **17 例通过** | **A** | 不带 temperature、token 字段互斥、失败不自动重试、字节上限、Key 不出现在 body 均有断言 |
| T032 | 连接测试与能力验证 | implemented | 3/3 存在 | `tests/integration/connection-test.test.ts` | **16 例通过** | **A** | 401 归类鉴权失败、连点同 requestKey 只调用一次等有断言；契约点名的 `tests/unit/candidate-search.test.ts` 隶属 T034，与此任务无关 |
| T033 | 整理提示词与不可信材料隔离 | implemented | 3/3 存在 | `tests/unit/organize-prompt.test.ts` | **10 例通过** | **A** | 围栏提前闭合、prompt 注入样本、不发送整库原文、版本常量化均有断言；`tests/fixtures/prompt-injection.json` 存在 |
| T034 | 中文候选召回与上下文预算 | implemented | 2/2 存在（`findCandidates.ts`/`domain/candidates.ts`） | `tests/integration/candidate-search.test.ts` | **11 例通过** | **A** | LIKE 通配符字面转义、候选预算与计数有断言；契约点名的 `tests/unit/candidate-search.test.ts` 与 `domain/searchRanking.ts` 文件名/落点漂移，见第 6 节 |
| T035 | 运行注册、幂等和并发占用 | implemented | 2/2 存在 | `tests/integration/run-lock.test.ts` | **14 例通过** | **A** | 同键并发只产一个 Run、RUN_BUSY 不隐形排队、失败重发不二次扣费、Run 行无 Key 均有断言；含计数型替身证明外部调用为 0 |
| T036 | 整理主流程与事务切点 | implemented | 2/2 存在 | `tests/integration/organize-service.test.ts` | **18 例通过** | **A** | 未配置不产 Run、请求期间不持事务、元数据/标签/关系/Run 一起提交与回滚均有断言 |
| T037 | 结构化解析、限长与一次修复 | implemented | 2/2 存在 | `tests/unit/structured-output.test.ts` | **17 例通过** | **A** | 只剥一层围栏、多 JSON 片段不猜、`JSON.parse` 是唯一求值路径（无 eval）、修复只对完整非法答案开放均有断言 |
| T038 | 整理字段应用与人工保护 | implemented | 2/2 存在 | `tests/integration/metadata-apply.test.ts` | **12 例通过** | **A** | 人工锁定不被覆盖、rawVersion 变化整次拒绝、锁定字段计数有断言 |
| T039 | AI 关系证据、去重与拒绝保护 | implemented | 2/2 存在 | `tests/integration/relation-apply.test.ts` | **13 例通过** | **A** | 候选外 UUID 拒绝、quote 必须是原文子串、重复 (targetId,type) 只写一条、已拒绝不复活均有断言；契约点名的 `ai-relations.test.ts` 未按该名落盘 |
| T040 | 运行恢复、迟到响应与局部轮询 | implemented | 3/3 存在 | `tests/integration/run-recovery.test.ts` | **15 例通过** | **A** | 只恢复超租约行、终态单向不复活、恢复不调模型不删行、读取不写库均有断言 |
| T041 | 模型用量、输入范围与错误诊断 | implemented | 3/3 存在 | `tests/unit/run-diagnostics.test.ts` + `tests/integration/run-diagnostics.test.ts` | **28 例通过**（14+14） | **A** | 用量缺失报"未记录"、不出现金额、导出白名单、origin 只到主机、读取不触发模型均有断言；路由层含缺令牌 403 |
| T042 | AI 闭环与真实连接验收 | implemented | 1/3（`docs/progress/G2.md` 存在；`tests/e2e/gate2.spec.ts`、`tests/fixtures/semantic-cases.json` 均不存在） | 无 | 无 T042 标签用例 | **C** | 契约点名的 e2e spec 与 fixture 不存在；G2 evidence 的"18 例 3 spec"全是 G1 的 spec（gate1/offline-crud/save-races），不含 gate2；真实 Provider 连通性 BLOCKED_BY_EXTERNAL_CREDENTIAL |

---

## 2. 可升级为 `verified` 的任务清单（24 个）

**G0（6）**：T001、T008、T009、T010、T011、T012
**G1（2）**：T014、T022、T023
**G2（16）**：T027、T028、T029、T030、T031、T032、T033、T034、T035、T036、T037、T038、T039、T040、T041

> 注：上列 G1 实为 3 个（T014、T022、T023）。合计 6 + 3 + 15 = 24。

逐个的可核对依据（「独立用例」指该任务至少有一条自带 id 标签且本次通过的 vitest 用例）：

| task | 独立用例数 | 测试文件 | 备注（升级时应一并记录） |
| --- | --- | --- | --- |
| T001 | 2（+doctor 门禁） | `tests/unit/doctor.test.ts` | C03/C04/C05 未执行，勿写成"六例全过" |
| T008 | 4 | `tests/integration/database-runtime.test.ts` | — |
| T009 | 4 | `tests/integration/database-runtime.test.ts` | 契约点名的 `migrations.test.ts` 缺位 |
| T010 | 15 | `tests/integration/repositories.test.ts` | 契约点名的 `src/domain/dto.ts` 缺位（DTO 实际在 `src/domain/knowledge.ts`） |
| T011 | 1 | `tests/integration/database-runtime.test.ts` | C02/C03/C04/C06 无独立断言 |
| T012 | 7 | `tests/contracts/guard.test.ts` | `evidence/G0.md` 记 6 例系笔误 |
| T014 | 20 | `capture.test.ts` + `capture-http.test.ts` | 契约点名的 `services/captureItem.ts` 缺位（实际 `services/items.ts`） |
| T022 | 12 | `tests/integration/relations.test.ts` | — |
| T023 | 8 | `tests/integration/relations.test.ts` | 契约点名的 `review.test.ts` 缺位 |
| T027 | 12 | `tests/unit/llm-config.test.ts` | `docs/progress/G2.md` 该行指错了文件 |
| T028 | 16 | `tests/unit/endpoint-policy.test.ts` | — |
| T029 | 12（文件 14） | `tests/integration/settings.test.ts` | — |
| T030 | 14 | `tests/unit/redaction.test.ts` | 契约点名的 `redact.ts`/`logger.ts` 缺位 |
| T031 | 17 | `tests/unit/llm-transport.test.ts` | 契约点名的 `adapters/openaiCompatible.ts` 缺位 |
| T032 | 16 | `tests/integration/connection-test.test.ts` | — |
| T033 | 10 | `tests/unit/organize-prompt.test.ts` | — |
| T034 | 11 | `tests/integration/candidate-search.test.ts` | 契约点名的 `domain/searchRanking.ts` 与 unit 入口缺位 |
| T035 | 14 | `tests/integration/run-lock.test.ts` | — |
| T036 | 18 | `tests/integration/organize-service.test.ts` | — |
| T037 | 17 | `tests/unit/structured-output.test.ts` | — |
| T038 | 12 | `tests/integration/metadata-apply.test.ts` | — |
| T039 | 13 | `tests/integration/relation-apply.test.ts` | 契约点名的 `ai-relations.test.ts` 缺位 |
| T040 | 15 | `tests/integration/run-recovery.test.ts` | — |
| T041 | 28 | `tests/unit/run-diagnostics.test.ts` + `tests/integration/run-diagnostics.test.ts` | — |

---

## 3. 不能升级的清单 + 原因（18 个）

### 3.1 B：保持 `implemented`（6 个）——实现存在，但缺可归属的自动化证据

| task | 原因 | 缺少什么才可升级 |
| --- | --- | --- |
| T002 | 六条用例零自动化断言；证据主体是原样 JSON 转述（无法判断是否本次取得）；`npm ci` 干净重装自述留待 G6 | 至少一条可跑的依赖/锁文件断言，或把 `npm ci` 结果落到本次可复现命令 |
| T003 | `npm run lint` exit 0 可复现，但 C01–C06 是行为用例（错误客户端导入、路由变薄、目录漂移…），lint 只证明当前导入图合法 | 针对错误导入/目录漂移的负向 fixture 用例（如 T012 的守卫那样可断言） |
| T006 | `src/domain/api.ts`、`src/features/shared/apiClient.ts` 无任何测试导入；HTTP 层信封仅被 `capture-http.test.ts` 间接覆盖（标签属 T014）；C04 断网、C05 缓存回放无断言 | 直接针对 apiClient 的用例（非 JSON、服务端异常、断网、缓存回放） |
| T007 | **契约点名的 `src/features/shared/session.ts` 不存在**（实现不全）；无带 T007 id 的断言；C02 Host 伪装 / C04 重启恢复 / C05 端口不一致均无自动化证据 | 补齐 session 模块；把 host/origin/token 的拒绝矩阵写成直接断言（可复用 `settings.test.ts:340` 的做法） |
| T016 | 文档指认的 `repositories.test.ts` 存在且通过，但 15 条用例自带 T010 标签、覆盖仓储层；`queryItems.ts`/`LibraryPage.tsx` 无防回归入口 | 至少一条带 T016 标签的搜索/过滤/分页断言（服务层或 HTTP 层） |
| T019 | `editItem.ts` 无直接测试；文档自述的"同构断言"实为 `relations.test.ts` / `metadata-apply.test.ts` 的 409 用例（归属 T022/T038）；C02 标题人工锁、C06 字段重置无断言 | 针对 `editItem` 的 CAS 冲突与人工字段保护直接断言 |

### 3.2 C：标记 `needs_e2e`（12 个）——只有 e2e 证据或无可复跑证据

| task | 唯一的证据载体 | 说明 |
| --- | --- | --- |
| T004 | `tests/e2e/gate1.spec.ts#T026-C02` | 本地启动/端口/退出无 vitest 入口；G0 的启动实测是一次性手工观察 |
| T005 | `tests/e2e/gate1.spec.ts#T026-C05` | 六页骨架只有导航可见性被覆盖 |
| T013 | `offline-crud.spec.ts`、`save-races.spec.ts` | IME 与草稿快照逻辑无单测 |
| T015 | `tests/e2e/gate1.spec.ts#T026-C01/C02` | 时间线与卡片渲染无单测 |
| T017 | `tests/e2e/gate1.spec.ts#T026-C02` | 标签规范化只被当 helper 使用 |
| T018 | `tests/e2e/gate1.spec.ts#T026-C01` | 抽屉与来源回溯无单测；`/api/items/[id]` 无 HTTP 层测试指向 |
| T020 | `tests/e2e/gate1.spec.ts#T026-C04` | `deleteItem.ts` 无测试导入；`delete.test.ts` 不存在 |
| T021 | `tests/e2e/gate1.spec.ts#T026-C04` | 选择/预算规则无服务端断言 |
| T024 | `tests/e2e/offline-crud.spec.ts`（6 例） | 实现与 spec 均在，但零 vitest 证据；本次未跑 Playwright |
| T025 | `tests/e2e/save-races.spec.ts`（6 例） | 同上 |
| T026 | `tests/e2e/gate1.spec.ts`（6 例） | 同上；本次**未复核**其"6 例通过" |
| T042 | 无（契约的 `tests/e2e/gate2.spec.ts` 与 `semantic-cases.json` 都不存在） | G2 evidence 的 18 例 3 spec 全是 G1 的 spec；真实 Provider 仍 BLOCKED_BY_EXTERNAL_CREDENTIAL |

> **给 T024/T025/T026 的额外提醒**：这三个任务的 e2e spec 文件**确实存在**，`docs/progress/G1.md` 与 `evidence/G2.md` 都声称其通过（分别记 18 例 / 42.3s 与 18 例 / 85.0s）。本次因端口冲突未复跑，因此结论是"**未复核**"，既不是通过也不是失败。待端口空出后单跑
> `npx playwright test tests/e2e/gate1.spec.ts tests/e2e/offline-crud.spec.ts tests/e2e/save-races.spec.ts`（需先 `npm run build`，且注意 `typecheck` 当前失败，见 4.3）即可补齐。

---

## 4. 本次执行命令的原始输出摘要

### 4.1 `npx vitest run`（退出码 0）

```
 Test Files  37 passed (37)
      Tests  450 passed (450)
   Duration  5.69s
```

按 project 拆分（各自退出码 0）：

| 命令 | 文件 | 用例 |
| --- | --- | --- |
| `npm run test:unit` | 16 passed | 183 passed |
| `npm run test:integration` | 20 passed | 260 passed |
| `npm run test:contracts` | 1 passed | 7 passed |

**失败项：0。** 因此本审计中没有任何任务因"本次跑失败"落入 B/C。

### 4.2 门禁命令

```
node scripts/doctor.mjs   exit 0
  ok: true, node 24.18.0, win32 x64, projectPathHasNonAscii: true,
  sqlite.ok: true, writableDirectory.ok: true, projectFiles.ok: true,
  network: "not-checked"

npm run contracts         exit 0
  routes: { implemented: 18, pending: 5, paths: 23, endpointMethods: 32 }
  limitsChecked: 53, errorCodesChecked: 28, failures: []
  notes: 3 条本地扩展路由（/api/runs/{id}/diagnostics、/api/views/{id}/layout、
         /api/views/{id}/freshness）

npm run lint              exit 0   （1 warning, 0 error）
  tests/e2e/gate4.spec.ts:5  warning  'seedItemViaApi' is defined but never used

npm ls --depth=0          exit 0

git check-ignore -v tests/e2e/.data-restart/   exit 0
  .gitignore:46:/tests/e2e/.data-restart/   tests/e2e/.data-restart/
```

### 4.3 `npm run typecheck`（**退出码 1**，18 个错误）

```
tests/e2e/gate4.spec.ts(7,29):  error TS2307: Cannot find module './support/gomindmap'
tests/e2e/gate4.spec.ts(164,30): error TS2304: Cannot find name 'scriptedGeneration'
tests/e2e/gate4.spec.ts(245,29): error TS2552: Cannot find name 'headersAt'
tests/e2e/gate4.spec.ts(246,26): error TS2304: Cannot find name 'seedItemAt'
tests/e2e/gate4.spec.ts(247,27): error TS2304: Cannot find name 'seedItemAt'
tests/e2e/gate4.spec.ts(267,27): error TS2552: Cannot find name 'headersAt'
tests/e2e/gate4.spec.ts(303,13): error TS2304: Cannot find name 'zoomWheel'
tests/e2e/gate4.spec.ts(331,19): error TS2304: Cannot find name 'mindmapCases'
tests/e2e/gate4.spec.ts(332,26): error TS2304: Cannot find name 'listViewIds'
tests/e2e/gate4.spec.ts(339,29): error TS2304: Cannot find name 'scriptedGeneration'
tests/e2e/gate4.spec.ts(341,15): error TS2304: Cannot find name 'invalidAnswerBody'
tests/e2e/gate4.spec.ts(354,25): error TS2304: Cannot find name 'readRun'
tests/e2e/gate4.spec.ts(366,25): error TS2304: Cannot find name 'listViewIds'
tests/e2e/gate4.spec.ts(412,31): error TS2304: Cannot find name 'scriptedGeneration'
tests/e2e/gate4.spec.ts(480,28): error TS2304: Cannot find name 'fetchExport'
tests/e2e/gate4.spec.ts(494,36): error TS2304: Cannot find name 'fetchExport'
tests/e2e/gate4.spec.ts(521,47): error TS2304: Cannot find name 'fetchExport'
tests/e2e/gate4.spec.ts(572,28): error TS2304: Cannot find name 'fetchExport'
```

**影响声明**：18 个错误**全部**在 `tests/e2e/gate4.spec.ts`（T061，属 G4，不属于本次审计范围）；`tsc` 输出中没有任何 `src/**` 或 `tests/unit|integration|contracts/**` 的错误。

但这有一个直接后果：**当前工作区无法复现 `docs/progress/G0.md`、`G1.md`、`G2.md` 里"`npm run typecheck` exit 0"这句**，因此 `npm run check` 也必然失败。这不构成 G0–G2 任务本身的证据缺陷（G2 记录时 `gate4.spec.ts` 尚未写入），但它意味着**现在无法用一条命令对 G0–G2 做端到端复验**。是否把该错误归因到 T061 需要另行核对 G4 的工作状态——本审计不做判断。

---

## 5. 任务 ↔ 测试文件的逐条对应关系（本次重跑）

带 id 标签的独立用例数（同一用例同时带两个 id 时两边各计一次，导致列和大于 450）：

```
T001=2   T008=4   T009=4   T010=15  T011=1   T012=7
T014=20  T022=12  T023=8
T027=12  T028=16  T029=12  T030=14  T031=17  T032=16  T033=11
T034=11  T035=14  T036=18  T037=17  T038=13  T039=15  T040=15  T041=28
（0 条：T002 T003 T004 T005 T006 T007 T013 T015 T016 T017 T018 T019 T020 T021
        T024 T025 T026 T042）
```

测试文件 ↔ 任务映射（仅列带标签的）：

| 测试文件 | project | 本次通过 | 承载任务 |
| --- | --- | --- | --- |
| `tests/unit/doctor.test.ts` | unit | 5 | T001 |
| `tests/unit/endpoint-policy.test.ts` | unit | 16 | T028 |
| `tests/unit/llm-config.test.ts` | unit | 12 | T027 |
| `tests/unit/llm-transport.test.ts` | unit | 17 | T031 |
| `tests/unit/organize-prompt.test.ts` | unit | 10 | T033 |
| `tests/unit/structured-output.test.ts` | unit | 17 | T037（+T038/T039 各 1 条交叉提及） |
| `tests/unit/redaction.test.ts` | unit | 14 | T030 |
| `tests/unit/run-diagnostics.test.ts` | unit | 14 | T041 |
| `tests/unit/build-freshness.test.ts` | unit | 4 | 无任务标签（G2 基础设施缺陷的回归） |
| `tests/unit/hash.test.ts` | unit | 5 | 无 T0xx 标签（属 T054 附近） |
| `tests/unit/dagre-layout.test.ts` | unit | 11 | T046 |
| `tests/unit/graph-adapter.test.ts` | unit | 12 | T044/T048 |
| `tests/unit/source-hash.test.ts` | unit | 9 | T054 |
| `tests/unit/mindmap-compiler.test.ts` | unit | 16 | T056/T057 |
| `tests/unit/view-export.test.ts` | unit | 13 | T060 |
| `tests/unit/scripted-provider.test.ts` | unit | 8 | T061 |
| `tests/integration/database-runtime.test.ts` | integration | 7 | T008、T009、T011 |
| `tests/integration/capture.test.ts` | integration | 10 | T014 |
| `tests/integration/capture-http.test.ts` | integration | 10 | T014 |
| `tests/integration/repositories.test.ts` | integration | 15 | T010 |
| `tests/integration/relations.test.ts` | integration | 20 | T022、T023 |
| `tests/integration/settings.test.ts` | integration | 14 | T029（+2 条涉及 T027 逻辑） |
| `tests/integration/connection-test.test.ts` | integration | 16 | T032 |
| `tests/integration/candidate-search.test.ts` | integration | 11 | T034 |
| `tests/integration/run-lock.test.ts` | integration | 14 | T035 |
| `tests/integration/organize-service.test.ts` | integration | 18 | T036 |
| `tests/integration/metadata-apply.test.ts` | integration | 12 | T038 |
| `tests/integration/relation-apply.test.ts` | integration | 13 | T039 |
| `tests/integration/run-recovery.test.ts` | integration | 15 | T040 |
| `tests/integration/run-diagnostics.test.ts` | integration | 14 | T041 |
| `tests/contracts/guard.test.ts` | contracts | 7 | T012 |

---

## 6. 文档与事实不一致之处（逐条）

### 6.1 声称的测试文件不存在 / 文件名漂移

| # | 文档或契约的声称 | 事实 | 严重度 |
| --- | --- | --- | --- |
| 1 | 契约 `tasks.json` T009 `targetFiles` 含 `tests/integration/migrations.test.ts` | 文件**不存在** | 低（`evidence/G1.md` §4 已如实披露） |
| 2 | 契约 T010 `targetFiles` 含 `src/domain/dto.ts` | 文件**不存在**；DTO 实际在 `src/domain/knowledge.ts` | 低（实现文档未声称该文件） |
| 3 | 契约 T018 `targetFiles` 含 `src/app/api/items/[id]/route.ts` | 文件**存在**（首次批量扫描因 `Test-Path` 把 `[id]` 当通配符误报 MISS；用 `-LiteralPath` 复核为存在） | — （此处记录以免读本报告时误判） |
| 4 | 契约 T014 `targetFiles` 含 `src/server/services/captureItem.ts` | 不存在；实际实现为 `src/server/services/items.ts` | 低（G1.md 已给实际路径） |
| 5 | 契约 T020 `targetFiles` 含 `tests/integration/delete.test.ts` | **不存在** | 中（该任务完全无 vitest 证据） |
| 6 | 契约 T023 `targetFiles` 含 `tests/integration/review.test.ts` | **不存在**（覆盖在 `relations.test.ts`） | 低（`evidence/G1.md` §4 已披露） |
| 7 | 契约 T030 `targetFiles` 含 `src/server/observability/redact.ts`、`logger.ts` | 两个都**不存在**；实际为 `redaction.ts` | 低 |
| 8 | 契约 T031 `targetFiles` 含 `src/server/llm/adapters/openaiCompatible.ts` | **不存在**；实际为 `adapter.ts` + `protocol.ts` | 低 |
| 9 | 契约 T034 `targetFiles` 含 `tests/unit/candidate-search.test.ts`、`src/domain/searchRanking.ts` | 两个都**不存在**；实际为 `tests/integration/candidate-search.test.ts`、`src/domain/candidates.ts` | 低 |
| 10 | 契约 T039 `targetFiles` 含 `tests/integration/ai-relations.test.ts` | **不存在**；实际为 `relation-apply.test.ts` | 低 |
| 11 | 契约 T042 `targetFiles` 含 `tests/e2e/gate2.spec.ts`、`tests/fixtures/semantic-cases.json` | 两个都**不存在** | **高**（T042 因此不可升级） |
| 12 | 契约 T013 `targetFiles` 含 `tests/e2e/capture.spec.ts` | **不存在** | 中 |
| 13 | 契约 T007 `targetFiles` 含 `src/features/shared/session.ts` | **不存在**（唯一缺失的"实现类"文件） | **高**（T007 因此不可升级） |

### 6.2 声称的用例数 / 命令结果与实测不符

| # | 位置 | 声称 | 实测 | 说明 |
| --- | --- | --- | --- | --- |
| 14 | `implementation/progress/evidence/G0.md` 第 1 节表 | `tests/unit/doctor.test.ts` **12 例** | **5 例** | 同一张表；与 `docs/progress/G0.md`（写 5 例）互相矛盾 |
| 15 | `implementation/progress/evidence/G0.md` 第 1 节表 | `tests/contracts/guard.test.ts` **6 例** | **7 例** | 与 `docs/progress/G0.md`（写 7 例）互相矛盾 |
| 16 | `implementation/progress/evidence/G0.md` 第 1 节表 | `tests/integration/database-runtime.test.ts` **"—"** | **7 例** | 该行为空 |
| 17 | `implementation/progress/evidence/G0.md` 第 1 节表 | 把 `tests/integration/relations.test.ts`（20 例）列为 **G0** 的套件 | 该套件属 **G1**（T022/T023） | 套件归属错误 |
| 18 | `implementation/progress/evidence/G0.md` §1 | `npm test exit 0 **6 个套件 / 58 个用例**` | 当时无法复核；本次为 **37 文件 / 450 例** | 与 `docs/progress/G0.md` §二（7 套件 74 例）**同一天两处数字矛盾** |
| 19 | `implementation/progress/evidence/G0.md` §1 | `npm run contracts … **32 条路由**（8 已实现 / 15 登记待办）` | 23 条**路径** / 32 个 **method 端点**；当前 18 已实现 / 5 待办 | 把"端点"写成"路由"；`docs/progress/G0.md` 的写法正确 |
| 20 | `implementation/progress/evidence/G2.md` §3 | `npm run build exit 0（**21 条路由，含 15 条 API**）` | 紧随其后的清单只列出 **14 条 API**，全清单合计 **22 项** | 同一段内部数字自相矛盾（`build` 本次未跑，无法给出当前真值） |
| 21 | `docs/progress/G0.md` §二、`G1.md` §三、`G2.md` §三 | `npm run typecheck exit 0` | **exit 1**（18 个 TS 错误，全在 `tests/e2e/gate4.spec.ts`） | G2 记录时该文件尚未写入；现在无法复现 |
| 22 | `docs/progress/G2.md` T027 行 | 证据指向 `tests/integration/settings.test.ts` | T027 的 12 条用例全在 `tests/unit/llm-config.test.ts`；`settings.test.ts` 中 0 条带 T027 标签 | 指认错误（`evidence/G2.md` §2 的清单是对的） |
| 23 | `docs/progress/G2.md` 状态行 | `verified（真实 Provider 语义验收除外）` | T042 无 vitest、无 gate2 spec、无真实连接 | 与证据不匹配；不应标 verified |

### 6.3 命令可复现性核对（结论：**全部可复现**）

`package.json` 中实际存在且本次跑通的脚本：`doctor`、`contracts`、`dev`、`build`、`start`、`lint`、`typecheck`、`test:unit`、`test:integration`、`test:contracts`、`test:e2e`、`test`、`check` —— 文档提到的命令名**全部真实存在**，没有发现"文档写了不存在的脚本"的情况。

文档提到的脚本文件：

| 脚本 | 存在 |
| --- | --- |
| `scripts/doctor.mjs` | 是 |
| `scripts/check-contracts.mjs` | 是 |
| `scripts/start-local.mjs` | 是 |
| `scripts/fetch-verified.mjs` | 是 |
| `scripts/prepare-e2e.mjs`（G2 §5.4 称"该文件不存在，注释指向错误"） | **否** | ← 原文承认了这一点，即该不一致**已被 G2 自己修复**（`playwright.config.ts` 注释现指向 `tests/e2e/support/resetData.ts`）。核对属实：`resetData.ts` 存在且含 `maxRetries: 20, retryDelay: 250`。

G2 声称的 3 项修复，本次逐条核实**成立**：
1. `tests/e2e/support/buildFreshness.ts` 存在；`playwright.config.ts` 在配置加载阶段调用它；
2. `tests/e2e/support/resetData.ts:50,78` 含 `rmSync(..., { maxRetries: 20, retryDelay: 250 })`；
3. `git check-ignore -v tests/e2e/.data-restart/` exit 0，命中 `.gitignore:46`。

### 6.4 `tasks.current.json` 的字段观察（非错误，仅记录）

- g0/1/2 的 42 个任务**字段完全相同**：只有 `id`、`status`、`evidence[]`、`blockedBy[]`。
- **没有** `notes`、**没有** `verifiedAt`、`evidence` 里也**没有**测试文件路径（只有 `docs/progress/Gx.md` 与 `evidence/Gx.md` 两个文档路径）。
  → 这一点直接影响升级操作：升级 `verified` 时若要留痕，需要先补 `verifiedAt` 与测试文件路径字段（本审计不修改该文件）。
- 全部 84 个任务的 `blockedBy` 都是 `[]`，而 `reference/contracts/tasks.json` 里 `dependsOn` 是有内容的（如 T042 依赖 15 个上游）。`blockedBy` 目前未被用来表达依赖关系。

---

## 7. 未验证 / 不确定的部分（明确声明）

1. **所有 e2e 结论均未复核**。按指令未运行 Playwright，因此 T004/T005/T013/T015/T017/T018/T020/T021/T024/T025/T026/T042 的 e2e 通过性**未验证**，不含"通过"或"失败"的判断。
2. **`npm run build` 未执行**，因此 `docs/progress/G2.md` 的"21 条路由 / 0 警告"与 `evidence/G2.md` 的路由清单**未验证**。第 6.2 条 #20 的数字矛盾仅来自文档原文自身的算术。
3. **历史数字无法回溯**。`evidence/G0.md`（6 套件 58 例）与 `docs/progress/G0.md`（7 套件 74 例）的矛盾，本次只能确认"两者中至少一个错、且与当前 450 例都对不上"，**无法判定 G0 当时真实的用例数**。
4. **`implementation/progress/evidence/G0.md` 的启动实测**（98 秒后被外部 kill）无法复跑：没有可执行的脚本或超时契约，只有散文描述，因此 T004 的这条证据本次**未验证**。
5. **真实 LLM Provider 的语义质量**（标题/摘要/关键词/关系是否恰当）未验证，且**本机无法验证**（无 Key）。T042 的该部分永远是 `BLOCKED_BY_EXTERNAL_CREDENTIAL`，不应被任何审计升级为 verified。
6. **T016/T019 的"同构断言"是否算证据**属判断题。我按"用例自带 T010/T022/T038 标签、非本任务"处理，记为 B；若项目认为跨任务重叠证据可接受，这两个可以重新评估为 A。
7. **T001 归 A 是我的判断**：其 6 条用例中 C03（只读目录）、C04（断网）、C05（重复运行）确实未执行，只是已在 `docs/progress/G0.md` 第四节如实披露。若项目要求"六例全部有证据"才可 verified，应降为 B。
8. **`tests/e2e/gate4.spec.ts` 的 18 个类型错误归属未确认**（属 G4/T061，本次未审计 G4 的状态），因此不判断它是"未完成的进行中工作"还是"遗漏的编译错误"。

---

## 8. 复现本审计的命令

```powershell
# 1) 全量 vitest（本次：37 文件 / 450 例 / exit 0）
npx vitest run

# 2) 按 project 拆分（本次：183 / 260 / 7，均 exit 0）
npm run test:unit
npm run test:integration
npm run test:contracts

# 3) 门禁（本次：doctor 0 / contracts 0 / lint 0 / typecheck **1**）
node scripts/doctor.mjs
npm run contracts
npm run lint
npm run typecheck

# 4) 取得 case 级标题以复核"任务 ↔ 用例"映射
npx vitest run --reporter=json --outputFile=.tmp-vitest.json
#   然后按标题里的 T0xx 分组统计

# 5) 依赖与忽略项
npm ls --depth=0
git check-ignore -v tests/e2e/.data-restart/

# 6) 待端口空出后补跑 e2e（本次未执行）
npm run build
npx playwright test tests/e2e/gate1.spec.ts tests/e2e/offline-crud.spec.ts tests/e2e/save-races.spec.ts
```

---

## 9. 一句话结论

G0–G2 的 `implemented` 全部属实（实现文件基本齐全，`src/features/shared/session.ts` 是唯一确证的实现缺件），其中 **24 个任务**有带自身 id 的真实通过用例、可以升级为 `verified`；**6 个**因缺少可归属的自动化证据或实现缺件应保持 `implemented`；**12 个**（含 T042）只有 e2e 或无 gate2 spec，应标 `needs_e2e` 而非升级。文档层面的主要问题是 `evidence/G0.md` 的用例数汇总表、`docs/progress/G2.md` 的 T027 指认、以及契约 `tasks.json` 中 12 处已漂移的文件名——这些都不影响上面 24 个任务的升级结论，但会让"照文档核对"的人得出错误结论。
