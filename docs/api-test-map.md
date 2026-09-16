# API 测试映射｜路由 → 实际测试入口 → 真实缺口

本文件是 **T077 的必交产物**，回答一个问题：**每个 HTTP 路由由哪些测试真正覆盖，
哪些只是"被提到过"，以及哪里没覆盖**。第 4 节列的是缺口。

映射由脚本从 App Router 目录树与测试源码**实测生成**（不是手写清单），
数字来自本机（2026-09-16）。可复现命令见 [evidence/G6.md](../../implementation/progress/evidence/G6.md)。

## 1. 如何决定"某路由被覆盖"

口径必须写清楚，否则数字会自我欺骗。本文件的判据是**测试源码里出现了该路由的路径字面量，
或直接 import 了它的 handler 模块**（集成套件普遍直接调用 App Router 导出的函数，
而不是起真实 server——`tests/integration/helpers/http.ts` 的注释说明了为什么：
保留守卫、schema 与事务路径，省掉端口与启动时间）。

**这个口径的弱点**：它证明"有测试**指向**这条路由"，不证明"每个方法/每个错误分支都被断言"。
所以第 4 节单列了方法级与分支级的缺口。

## 2. 路由 × 测试入口（实测）

| 路由 | 指向测试数 | 主要入口 |
| --- | --- | --- |
| `/api/diagnostics` | 5 | `integration/diagnostics`、`security/secret-full-chain` |
| `/api/export` | 3 | `security/cross-site-matrix`、`security/secret-full-chain`、`contracts/guard` |
| `/api/graph` | 6 | `security/cross-site-matrix`、`security/secret-full-chain` |
| `/api/health` | 1 | `e2e/offline-crud` |
| `/api/import` | 3 | `integration/import`、`integration/import-validation` |
| `/api/import/validate` | 2 | `integration/import-validation` |
| `/api/items` | 26 | `capture-http`、`capture-draft`、`delete-item` 等 |
| `/api/items/[id]` | 7 | `capture-draft`、`delete-item`、`edit-item` |
| `/api/items/[id]/organize` | 2 | `security/cross-site-matrix`、`security/local-request-guard` |
| `/api/relations` | 7 | `security/cross-site-matrix`、`e2e/gate1`、`e2e/gate2` |
| `/api/relations/[id]` | 1 | `security/cross-site-matrix` |
| `/api/runs/[id]` | 3 | `run-diagnostics`、`run-recovery`、`security/secret-full-chain` |
| `/api/runs/[id]/diagnostics` | 2 | `run-diagnostics`、`secret-full-chain` |
| `/api/runs/recover` | 2 | `run-recovery`、`cross-site-matrix` |
| `/api/selection` | 5 | `selection`、`prototype-key-errors`、`flow-material-confirm` |
| `/api/session` | 3 | `security/local-request-guard`、`e2e/gate1`、`e2e/gate3` |
| `/api/settings/llm` | 7 | `settings`、`connection-test`、`cross-site-matrix` |
| `/api/settings/llm/test` | 2 | `connection-test`、`cross-site-matrix` |
| `/api/tags` | 2 | `edit-item`、`cross-site-matrix` |
| `/api/views` | 13 | `export-query`、`graph-layout`、`selection` |
| `/api/views/[id]` | 4 | `export-query`、`graph-layout`、`cross-site-matrix` |
| `/api/views/[id]/export` | 2 | `export-query`、`secret-full-chain` |
| `/api/views/[id]/freshness` | **0 → 已补** | **本轮新增 `integration/freshness-route`** |
| `/api/views/[id]/layout` | 2 | `graph-layout`、`cross-site-matrix` |
| `/api/views/mermaid/generate` | 4 | `cross-site-matrix`、`e2e/flow-intent`、`e2e/flow-lifecycle` |
| `/api/views/mindmap/generate` | 3 | `selection`、`cross-site-matrix`、`e2e/mindmap-regeneration` |

`/api/views/[id]/layout` 与 `/api/relations/[id]` 没有导出的 `GET`（前者是 `PATCH`，
后者按安全矩阵只测写入路径），所以下表与上表的口径差异是正常的。

## 3. 六条规则 → 实际入口

### T077-R01 真实文件库与实际 Schema，至少部分用例关闭重开连接

- `tests/helpers/db.ts` 为每个套件 `mkdtempSync` 独立目录，`closeDb` 在删除目录前运行
  （释放 WAL）。**没有任何集成套件使用内存 Map**。
- 关连接再重开的实际位置：`database-runtime.test.ts`（**手写 SQL**）、
  `import.test.ts`（恢复后重开读回）、`views.test.ts`。
- 本轮补上了两种各自缺的那一半：
  - `edit-item.test.ts` 新增 **T077-C01**：经**真实仓储**写入 → `closeDb` → 重开 →
    手写 SQL 与仓储读回都断言，且版本与写入时的响应逐字段一致。
    （既有那条走手写 SQL，只证明磁盘路径正确；反过来内存替身不能证明磁盘路径正确，两者各证一半。）

### T077-R02 非法请求在写库前被阻止，合法请求提交后返回一致 DTO

- 非法请求：`tests/integration/prototype-key-errors.test.ts`（原型同名键 → 400 而非 500）、
  `edit-item.test.ts` 的 `T019-C05`（超长标题/非法重要性 → 400 且库未变）、
  `capture-http.test.ts`。
- 合法请求 DTO 一致：`edit-item.test.ts`、`capture-draft.test.ts`、
  `item-details.test.ts`。

### T077-R03 并发覆盖重复采集、重复 Run、两窗口编辑与导入空库竞态

| 竞态 | 入口 | 状态 |
| --- | --- | --- |
| 重复采集（同 `captureRequestId`） | `capture.test.ts`、`capture-http.test.ts` —— **全部是顺序重放** | **缺口**：`createCapture` 里 `UNIQUE constraint failed` 的竞态分支零驱动（T077-C02，见 evidence T077-6） |
| 重复 Run（同 `requestKey` 只注册一次） | `run-lock.test.ts`（`T035-C01`/`C02`） | 已覆盖 |
| 两窗口编辑（CAS 409） | `edit-item.test.ts`（`T019-C03`），同 Item 并发 organize 在 `run-lock.test.ts` | 已覆盖 |
| 导入空库竞态 | `import.test.ts` 的 `T072-C03`（校验成功后另一请求创建条目 → 提交时重新检查并拒绝） | 已覆盖（T077-C05 复用） |

### T077-R04 失败注入放在事务中间，确认无半成功

`import.test.ts` 的 `T072-C02` 一组：关系插入失败、视图插入失败、重复 ID。
断言都是"先写入的条目也被回滚"+"目标仍为空"，不是只看抛没抛错。
**变异证据**：早前把 `withTransaction` 的 `ROLLBACK` 去掉，这一组会红。

**具名差距（T077-C03 原句"元数据更新后关系写入抛错"）**：整理提交 `commitOrganize` 的顺序是
元数据 → `item_tags` → 关系 → `completeRun`。`organize-service.test.ts` `T036-C04` 的注入点在
`item_tags`（关系之**前**），它对"关系为 0"的断言因此是空洞的；`T072-C02` 注入在关系处但属于导入。
**整理提交里 `INSERT INTO relations` 这个切点没有用例**，待补（复用 `T036-C04` 的 `db.prepare` 拦截范式）。

### T077-R05 错误码、HTTP 状态与 envelope 三者一致，日志无秘密

- 三者一致：各集成套件的失败路径断言（`IMPORT_NONEMPTY`/409、`VALIDATION`/400、
  `RUN_BUSY`/409 等），以及 `tests/unit/api-envelope.test.ts`（16 例）。
- 日志无秘密：`tests/security/secret-full-chain.test.ts` 与
  `tests/unit/redaction.test.ts`。**注意**：这三件事由不同文件证明，不能相互替代。
- 本轮新增的 `freshness-route.test.ts` 断言了**跨路由一致性**（下节）。

### T077-R06 清理限定临时目录，不在测试脚本里执行项目根递归删除

- `tests/helpers/db.ts` 的清理目标是 `mkdtempSync(tmpdir())` 产物；T011 起就如此。
- 但**守卫本身此前没有测试**：`assertNotUserDataDir` 只在 `src/server/db/database.ts`
  被调用，`tests/helpers/db.ts` 的注释声称它"确认而不是相信调用方"——没有人验证过它会拒绝。
  本轮新增 `tests/integration/user-data-guard.test.ts`（7 例）：正向（`.data` 及其等价写法被拒）、
  反向（临时目录不被拒、非 TEST 模式不拦）、行为层（解析出的目录在临时区、清理目标含在 tmp 内）。
  **变异证据**：让守卫恒放行 → 红 2 例；把 `isUserDataDir` 改成前缀宽松匹配 → 红 1 例。

## 4. 未覆盖 / 覆盖不足（如实列出）

- **T077 本身尚未验收**（`implemented`）：C02 并发采集竞态分支零驱动、C03 整理提交的关系切点无注入用例、
  C01 新增用例无变异对照。逐条与恢复点见 `implementation/progress/evidence/G6.md` T077-6/T077-7。
- **`tests/helpers/database.ts` 未按任务 `targetFiles` 字面创建**：既有 `tests/helpers/db.ts`
  承担同一职责（隔离目录、`closeDb`、`newId`、`frozenClock`），为一个文件名再造一份会让装置有两个家。
  若验收坚持文件名，改为从 `database.ts` re-export，不复制实现。
- **`/api/views/[id]/freshness` 此前是唯一零直接引用路由**，本轮补了 6 例。
  但要用同一个口径复查其余路由的**方法级**分支：上表的计数是"有测试指向路径"，
  没区分 `GET`/`PATCH`/`DELETE` 是否各自被断言。
- **动态段 id 不做形状校验是实测结论，不是设计文档**。本轮测得
  `items/[id]`、`views/[id]`、`views/[id]/freshness`、`views/[id]/export`、`runs/[id]`
  对 `not-a-uuid` 一律 `404 NOT_FOUND`（与"不存在"同一响应，避免成为 id 存在性探测器）。
  这一点此前**没有测试钉住**，本轮把它写成跨路由断言；
  但 `relations/[id]`、`views/[id]/layout` 没有 `GET`，未纳入该断言。
- **`/api/health` 只有 1 条 e2e 指向**（`offline-crud.spec.ts`），没有集成层用例。
  它足够简单，但"简单"不是证据。
- **没有真实 server 的集成路径**。集成套件直接调用 handler 函数（见第 1 节），
  所以 **Next 的运行时装配**（`runtime = 'nodejs'`、`dynamic = 'force-dynamic'`、
  路由段解析）不在集成层覆盖范围内——那部分由 Playwright e2e 证明。
  这是有意的分层，不是遗漏；但"直接调 handler 全绿"不能推断"HTTP 上一定可用"。
- **`/api/items/[id]/organize` 只被安全矩阵指向**（2 处），其中一处是守卫用例。
  它的成功路径在 `organize-service.test.ts` 里以服务层形式覆盖，**不是** HTTP 层。
- **本文件的计数不包含 `tests/e2e/evidence/*.spec.ts`**（截图证据脚本），
  它们产出图片而不是断言，不应计入覆盖。

## 5. 维护约定

1. **新增路由后必须重新生成本文件的第 2 节**，否则新路由会以"无人指向"的形式静默存在。
   零引用路由是本文件最该报警的信号。
2. **不要用"某个服务层测试提到了同名函数"当作路由被覆盖**。本轮那条零引用路由
   正是因为服务层测得很透、UI 也有 e2e，才让人以为它已被覆盖。
3. **失败路径要分别断言错误码、状态码与 envelope**：三者由不同代码路径决定，
   只看状态码会漏掉"码对了但形状变了"。
4. **改 `src/server/db/database.ts` 或 `dataDir.ts` 前先跑 `user-data-guard` 的变异对照**——
   那道闸一旦失效，失败的测试会写到用户真实的知识库上，而其它用例仍然全绿。
