# 未完成事项与实施方案（截至 `397697a`，2026-09-16）

本文件回答两个问题：**还剩什么**，**按什么顺序、改哪些文件、用什么证据把它做完**。
它是方案，不是进度报告；进度以 `tasks.current.json` 与 `NEXT_TASK.md` 为准，
任何一项做完后按第 5 节的节奏更新那两处，再回来把本文件对应行划掉。

状态基线：verified 75 / implemented 2（T042、T077）/ not_started 7（T078–T084），共 84。
门禁基线：typecheck / lint / contracts / build exit 0；`npm test` 83 文件 1068 例 exit 0；
gate5+gate4 冒烟 13 passed（全量 e2e 上次 T076 时 119 passed / 1 skipped）。

**进度更新（2026-09-16）**：T077–T083 已完成并 `verified`；`npm test` 现在 84 文件 **1095 例**
（unit 406 / integration 534 / security 103 / contracts 42 / browser 10）；e2e **140 passed / 1 skipped**；
另有独立性能通道 `npm run test:perf` 12 例，以及 `npm run status` 交付守卫。
当前 verified 82 / implemented 0 / blocked 1（T042）/ not_started 1（T084）。
本文件下面各节的"当前数字"写的是制定方案时的基线，按节内标注执行。

**收口（2026-09-17）**：T084 已完成并 `verified`，**本方案全部执行完毕**：verified 83 / blocked 1（T042）/
not_started 0。最终结论与四张清单见 `docs/release/final-acceptance.md`；本文件转为历史记录，不再更新。

## 1. 未完成清单

### 1.1 进行中

**T078** 六页浏览器端到端验收。装置（G-4）与 P0 备份入口已落地；本轮修掉 G-5（脑图没有
「第一次生成」入口）并补 2 例回归。**仍缺**：`chromium-narrow` 无 `@narrow` 用例、
`backup-restore.spec.ts` 未写、八场景与 `docs/browser-test-map.md` 未整理。
细节见 `implementation/progress/evidence/G6.md` T078-1 与本文件 3.2。

### 1.2 未开始（T078–T084，全部 `targetFiles` 目前**均不存在**，只有 `scripts/doctor.mjs`、`README.md`、`docs/operations/backup-recovery.md` 已有）

| 任务 | 一句话目标 | 依赖 | 必交文件 |
| --- | --- | --- | --- |
| T078 | 六页浏览器端到端验收：八个场景真行为、console/pageerror 分类、桌面+窄屏 | T077 | `tests/e2e/`、`playwright.config.ts`、`docs/browser-test-map.md` | ✅ 已完成（`evidence/G6.md` T078-1/2） |
| T079 | 加载/查询/图形性能预算：五种场景分开测，中位数+尾部，生产/HMR 分开 | T050, T057, T066, T078 | `scripts/seed-benchmark.mjs`、`tests/performance/`、`docs/performance-report.md` | ✅ 已完成（`evidence/G6.md` T079-1） |
| T080 | Windows 安装、启动与故障手册 | T001, T002, T004, T073, T079 | `docs/operations/windows-setup.md`、`docs/operations/common-failures.md`、`scripts/doctor.mjs` | ✅ 已完成（`evidence/G6.md` T080-1） |
| T081 | 生产构建、依赖审计与发布材料 | T075, T078, T079, T080 | `docs/release/build-report.md`、`docs/release/dependency-audit.md`、`package.json`、`README.md` | ✅ 已完成（`evidence/G6.md` T081-1） |
| T082 | 中文文案、状态与无障碍终审 | T078, T081 | `docs/ux/copybook.md`、`docs/ux/accessibility.md`、`src/features/shared/StatusLabel.tsx` | ✅ 已完成（`evidence/G6.md` T082-1；e2e 132 → 140，查出并修掉抽屉模态缺陷） |
| T083 | 任务证据、缺陷清单与交付状态 | T076–T082 | `docs/progress/`、`docs/release/acceptance-report.md`、`docs/release/known-issues.md` | ✅ 已完成（`evidence/G6.md` T083-1；新增 `npm run status` 守卫，首次运行即查出 3 处真实问题） |
| T084 | 最终用户旅程与 MVP 完成定义 | T083 | `tests/e2e/final-journey.spec.ts`、`docs/release/final-acceptance.md`、`README.md` |

### 1.3 阻塞

| 项 | 原因 | 解除条件 |
| --- | --- | --- |
| **T042** 真实模型语义验收 | `BLOCKED_BY_EXTERNAL_CREDENTIAL`：需要用户自己的 API Key；确定性三组已通过并提交（`0b34c4b`），语义组诚实 `skip` | 用户在设置页配置 Key 后跑 `npx playwright test tests/e2e/gate2.spec.ts`；结果只能由那次真实运行写入 `evidence/G2.md`，不得用替身补 |

### 1.4 契约矛盾与无主缺口（做 T078 之前必须先定，否则会在中途撞上）

| 编号 | 事实 | 后果 | 建议处理 |
| --- | --- | --- | --- |
| **G-1 备份/恢复没有页面入口** | `src/app/(workspace)/settings/page.tsx:60` 原文："导出、导入与备份属于交付阶段的任务，本页暂不提供按钮"。T070–T084 没有任何任务的 `targetFiles` 认领这个 UI。但 T078-R01 八场景含"导出恢复"，T084-R05 要求"导出整库，停止应用，在独立空库恢复"作为**用户旅程**；契约 `05_settings_and_security.md` §6 写"设置页允许删除 Key 后继续离线记录和**导出**"，`10_backup_bundle.md` §1 标题是"明确恢复格式，而**不只**提供下载按钮"（预设有按钮）。`docs/operations/backup-recovery.md:19` 已经在告诉用户"用应用内的逻辑导出（设置页或 `GET /api/export`）"——**设置页那半句现在是假的** | T078/T084 的导出恢复场景要么只能用 `page.request` 直打 API（那不是用户旅程），要么被卡住 | 按 AGENTS.md"清单外共享模块：先指出缺陷与受影响任务，再做最小扩展并补回归"，在 T078 之前加一个**前置 P0**：设置页备份区（导出下载 + 选文件→校验→确认空库→恢复），只接既有 `/api/export`、`/api/import/validate`、`/api/import`，不新增服务层。**这是补契约已要求的入口，不是范围扩张**；但因为它改了任务外文件，第 2 节列为需要用户确认的决定 |
| **G-2 状态词表** | T083-R01：任务状态限定 `not_started / in_progress / blocked / verified`。仓库从 G0 起用 `implemented`（`tasks.initial.json` 的 note 定义了它），当前 T042、T077 就是这个值 | T083 做逐任务证据表时会撞词表 | T077 收尾升 `verified` 时顺手把 T042 改成 `blocked`（真实原因写在 G2.md，`blockedBy` 字段是任务 ID 列表，不放自由文本）；此后不再产生 `implemented`。`tasks.initial.json` 不动 |
| **G-3 README 过期** | `README.md` "实施现状"段仍写"已验收 G0 与 G1，G2 起仍在实施中" | T081/T084 把 README 列入 `targetFiles`，会在那时重写；此前它对读者是误导 | **已关闭（T081）**：README「安装与运行」重写，并在开头加「当前交付状态」表列出未验证项 |
| **G-4 e2e 装置缺两项 T078 硬性要求** | `playwright.config.ts` 只有一个 `Desktop Chrome` project（R05 要求常规桌面 + 窄屏）；`pageerror` 监听只在 `flow-lifecycle.spec.ts` 一处（R03 要求全局监听并**区分**预期错误提示与未处理异常，且不允许全局屏蔽） | 属 T078 本体，不是矛盾；列在这里是因为要改 `playwright.config.ts` 与 `tests/e2e/support/harness.ts` 这两个所有 spec 共用的文件，改坏会让 120 例一起红 | T078 第一步先做装置、跑全量确认 119/1 不变，再加场景（**已做**：`consoleWatch` fixture + `chromium-narrow` project，全量仍 119/1）。**遗留**：`chromium-narrow` 至今收集不到用例，因为还没有任何用例打 `@narrow` 标记——这是 T078 尚未完成的部分 |
| **G-5 脑图没有「第一次生成」入口** | 选择条承诺「生成思维导图」，`/mindmap` 空态也写着「从选择条进入这里生成」，但该页只有读的一半 + T059 的 `RegenerateAction`（`view === null` 时不渲染）。`docs/02_architecture/03_ui_information_design.md:36` 已写明两页**共享** `GenerateAction`，Flow 有、Mindmap 没有 | 全新库**造不出第一张脑图**：T078-R01 的「脑图生成」场景无法以用户旅程完成，T078-R02/C03 又要求按钮有真实行为 | **已修**（`evidence/G6.md` T078-1）：新增 `GenerateMindmapAction`，只接既有 `/api/views/mindmap/generate`，不新增服务层；补 2 例 e2e + 变异对照（删渲染块 → 2 failed）。**连带查出** `zoomIn`/`zoomWheel` 直接对画布中心下手、不校验落点在视口内，画布一被内容推下去缩放就静默失效；已改为先滚入视口并硬断言 |

## 2. 需要用户拍板的决定（不拍板就按"建议"执行，并在提交信息里注明）

| 决定 | 建议 | 不采纳的替代 |
| --- | --- | --- |
| **D1** 备份/恢复页面入口（G-1） | 作为 P0 加在设置页，独立提交，e2e 归 T078（**用户已采纳**） | 不加 UI：T078/T084 导出恢复场景改为 `page.request` 直打 API + 手册指引，并把"设置页无入口"写进 `known-issues.md` 与 `backup-recovery.md` |
| **D2** 状态词表（G-2） | T077 收尾时 T042 → `blocked`，此后禁用 `implemented`（**已执行**：T042 → `blocked`，T077 → `verified`） | 保持现状到 T083 再统一改 |
| **D3** T081 依赖审计需要 registry 网络 | 有网就跑 `npm audit --omit=dev` 与 `npm ls --all`，逐项处理、**不用 `audit fix --force`**；无网记 `blocked` 并写明 | **已执行（有网）**：两项审计均 0 条；2 条 moderate 升 vitest 至 4.1.11 后清零，未用 `audit fix` |
| **D4** T042 真实 Key | 始终由用户提供并自己在设置页配置；执行者不接触 Key 值 | 无 Key 则 T042 在最终交付里单列"未执行" |
| **D5** T079 大样本（一万条）种子 | 用 `scripts/seed-benchmark.mjs` 写进**独立临时数据目录**（`BRAIN_DATA_DIR`），跑完删除；永不写 `.data` | — |

## 3. 执行顺序与逐项方案

串行，不并发：T078/T079/T084 都要占 3100 端口与 `.next`。每项的固定动作见 AGENTS.md「执行流程」，
这里只写**本项特有**的输入、文件、产物、验证与风险。

### 3.0 T077 收尾（**已完成，2026-09-16**）

- **C02**：`capture.test.ts` 新增 2 例（第二个连接 + `db.prepare` 拦截造确定性交错）。
  **过程中查出一个真实产品缺陷**：`withTransaction` 已把 `UNIQUE constraint failed` 改写为
  `数据唯一性冲突`，而 `createCapture` 只匹配原始 sqlite 文本，分支永远进不去，
  并发输家会得到 500 而不是"重放赢家"。已修 `src/server/services/items.ts` 的
  `isCaptureKeyViolation`；两处变异对照（去掉重放分支、退回只看原始文本）各红 2 例。
- **C03**：`organize-service.test.ts` 新增 1 例，注入点 `INSERT INTO relations`，
  元数据与标签**先真实写入**再断言一起回滚；去掉 `ROLLBACK` 的变异红 2 例。
- **C01**：补齐 13 字段逐字段比对；变异 `decodeItemRow` 的 `revision` 改读 `raw_version` → 红 7 例。
- **文档**：`docs/api-test-map.md` 第 3/4 节、`evidence/G6.md` T077-8、`G6.md` 表行与第 10/10c 节、
  `NEXT_TASK.md` 指针、`tasks.current.json` T077 → `verified`、T042 → `blocked`（D2，已执行）。
- **验证**：`npm test` 1071 例 exit 0；五个 project 之和 = 整跑；gate5+gate4 冒烟 13 passed。

### 3.1 P0 备份/恢复页面入口（**已完成**，D1 采纳时执行；独立提交）

- **提交**：`9b5bb24`。**遗留**：归 T078 的 `backup-restore.spec.ts` 尚未写。

- **允许文件**：`src/app/(workspace)/settings/page.tsx`（替换那段"暂不提供按钮"）、新增 `src/features/settings/BackupPanel.tsx`、
  `docs/operations/backup-recovery.md:19`（让"设置页"那半句变真）。**不改**服务层与路由。
- **行为**：导出 = `apiDownload('/api/export')`（`src/features/shared/apiClient.ts` 已有）→ `saveBlobAs`；
  恢复 = 选文件 → 前端读 JSON → `POST /api/import/validate` 显示 counts/warnings → 勾选"我确认目标是空库"→ `POST /api/import`（带 `expectedBundleHash` 与 `confirmEmptyRestore: true`）→ 成功后提示"重新载入"。
  非空库返回 `IMPORT_NONEMPTY`（409）时**原样显示**契约文案，不做"合并"。
- **文案**（T082-R05 提前遵守）：说明"逻辑备份不含 Key""恢复只允许空库""恢复不触发整理"。
- **验证**：`tests/e2e/backup-restore.spec.ts`（归 T078 计数）：导出文件可被 `importBundle` 校验；在 `restartDataDir()` 的空库上恢复后原文/标签/关系/视图 id 一致、Key 未被覆盖；非空库 409。
  组件层不写单测复述实现，靠 e2e。

### 3.2 T078 六页浏览器端到端验收（**已完成，2026-09-16**）

- **先做装置（G-4），跑全量确认不变，再加场景**（**装置已完成**，当时全量 121/1）：
  - `playwright.config.ts` 增加第二个 project `chromium-narrow`（桌面窄屏，1280×720；**不是手机**，本项目桌面专用），
    只挑 `@narrow` 标记的用例跑，避免 120 例翻倍。**现已收集 4 例并全部通过**
    （T078-C05 窄屏 2 例 + `gate1` T026-C01 核心采集/编辑/详情 + `backup-restore` T078-C01 设置页备份控件），
    与配置注释承诺的"核心路径 + 六页外壳 + 设置页备份控件"一致。
  - `tests/e2e/support/consoleWatch.ts` + `fixtures.ts` 新增 `consoleWatch` fixture：收集 `console.error` 与 `pageerror`。
    **实测后豁免从两条增到三条**：全量打开后 `save-races` 的 `T025-C02` 红了——它自己 `route.abort('connectionreset')`
    制造"响应丢失"，属预期错误，故第三条规则要求该用例另行断言"重试成功且两次请求键相同"。其余在 `afterEach` 断言为空，
    没有 `page.on('pageerror', () => {})` 这类全局屏蔽。
  - **装置缺陷已修**（G-5 连带）：`zoomIn`/`zoomWheel` 曾直接对 `boundingBox()` 中心下手、不校验落点在视口内，
    画布被上方内容推下去后滚轮手势落在视口外、缩放**静默失效**（且 T057-C05 只比较 transform 与自身，是空过的）。
    现两个 helper 都先 `scrollIntoViewIfNeeded()` 并硬断言落点在视口内；T057-C05 补 `scale > 1`。
- **八场景映射到既有 spec**：表已写入 `docs/browser-test-map.md`；导出恢复 → 新 `backup-restore.spec.ts`（4 例）。
  每个场景至少一例满足 R02"变更后读取或重启确认"（`backup-restore` 的 T078-C01 用 `restartServer.ts` 起了**另一个进程的空库**）。
- **R04（真实模型场景）**：**未执行**，保持与 T042 同一口径。当前套件**没有** `BRAIN_E2E_REAL_MODEL` 开关，
  不新增一段只跳过不产出的代码充当"已实现"；真实语义验收仍由 T042 单列 `blocked`。
- **R06（留痕不泄密）**：已用一次性探针实测，结论与残留缺口写在 `docs/browser-test-map.md` 第 4.5 节：
  `type=password`、`GET /api/settings/llm` 响应、导出字节三处**都不含**明文；但 Playwright 的 trace 会归档
  **已提交的请求体**（`resources/<hash>.json` 里的 `{"apiKey":"sk-…"}`）与 `fill` 参数，因此"用例里填真 Key"
  时 `test-results/` 会落盘明文。`test-results/` 已被 `.gitignore` 忽略且从不提交，缺的是"外发前删/脱敏"这一步
  ——记为**残留缺口**，不声称已解决。
- **验证（实测）**：`npm run build && npx playwright test` → **132 passed / 1 skipped**（exit 0），
  `--project=chromium-narrow` → **4 passed**（此前 exit 1「No tests found」）。

### 3.3 T079 加载、查询与图形性能预算

- **种子**：`scripts/seed-benchmark.mjs`（`.mjs`，不参与 `tsc`，理由同 `inspect-data.mjs`）：写入指定临时目录，参数 `--items 100|1000|10000 --graph 200 --mindmap 120 --flow 40`。
  用 `node:sqlite` 直写并复用 `001_initial.sql` 的约束；**拒绝**目标目录等于用户 `.data`（复用 `isUserDataDir`）。
- **测量**：`tests/performance/*.perf.ts` 用 Playwright 在**生产构建**上测五个场景（R01 分开），各取 ≥7 次样本，报中位数与 p95/max（R05）；
  冷启动（`start-local.mjs start` 到 `/api/health` 200）与暖请求分开；模型网络耗时用脚本替身固定为 0 并单列"未测真实网络"。
  开发 HMR 只记一次手工观察值并标注环境。
- **R04 审计**：用 T074 的 `apiLatency` 与 SQLite `EXPLAIN QUERY PLAN` 查 N+1；`useRunStatus` 轮询频率；`MindmapRenderer` 实例数（`destroy()` 那条历史缺陷）；
  `useLayoutPersistence` 防抖是否每帧写。发现问题**局部修**并补回归（R06）。
- **产物**：`docs/performance-report.md`：预算（目标）与实测分列；环境（CPU/内存/Node/Windows 版本）；失败样本原样保留。
- **风险**：一万条种子跑全量 e2e 会拖慢——性能项用独立数据目录且不进 `npm test`；`package.json` 加 `test:perf` 脚本，不并入 `check`。

### 3.4 T080 Windows 安装、启动与故障手册 ✅ 已完成

- **文件**：`docs/operations/windows-setup.md`（R01–R04：先 `node -v`/`npm -v`，`npm ci` 与 `npm install` 的区别，Playwright 浏览器下载单列，
  `build` 与 `start` 区别，Ctrl+C，数据目录与 Key 风险）；`docs/operations/common-failures.md`（R05/R06：TLS/代理诊断不建议关校验、排错顺序版本→端口→路径→权限→依赖→应用）；
  `scripts/doctor.mjs` 若需补检查项（如代理变量提示），只加只读探测。
- **验证**：命令块在本机 PowerShell **逐条实跑**并把输出粘进 `evidence/G6.md`；命令块不用反斜杠续行（R01）。
  复用 `docs/runtime-report.md`、`docs/dependency-report.md`（T001/T002 产物）与 `backup-recovery.md`（T073），不复制内容，链接过去。
- **不做**：不宣称 macOS/Linux 兼容；不演练真坏盘。

### 3.5 T081 生产构建、依赖审计与发布材料 ✅ 已完成

- **R01 干净目录**：`git worktree add` 或复制到临时目录 → `npm ci` → `lint`/`typecheck`/`test`/`build`/`start`，每条退出码进 `docs/release/build-report.md`。
- **R02/R03**：`start-local.mjs` 绑定回环、数据目录受控（既有）；确认 `.next` 与发布 zip 不含 `.data`、`tests/e2e/.data*`（`rg`/`Get-ChildItem` 实扫）。
- **R04**：`npm audit --omit=dev`（D3）、`npm ls --all --depth=0`，许可清单用 `package-lock.json` 派生；每条 advisory 写处理决定。
- **R05/R06**：README 重写"安装与运行"（修 G-3），并**明确写**：真实模型验收未执行（T042 blocked）、只在本机 Windows 验证。
- **验证**：报告里每条命令可复现；`npm run check` 通过。

### 3.6 T082 中文文案、状态与无障碍终审

- **R01/R02/R03**：`rg` 全量扫 `src/features`、`src/app` 的用户可见字串，按"保存/整理/生成/审核"四词、"关联评分/依据已变化"、
  "loading 只用于等待"三条规则列出违例；新建 `src/features/shared/StatusLabel.tsx` 承载状态词表，各处改为引用（不改行为）。
  `docs/ux/copybook.md` 记录词表与每条改动前后。
- **R04/R06**：`tests/e2e/a11y.spec.ts`：纯键盘完成录入→导航→详情→审核→导出；图有文本替代（`GraphSummary` 已有）；
  `page.emulateMedia`/放大字号 150% 下关键按钮仍在视口且可点。`docs/ux/accessibility.md` 写实测与未覆盖（屏幕阅读器人工检查未做则如实写）。
- **R05**：核对三处危险动作文案（删 View 不删知识、删 Key 不删笔记、恢复只允许空库）——P0 已按此写。
- **验证**：全量 e2e；文案改动不改逻辑，不为它写复述实现的单测。

### 3.7 T083 任务证据、缺陷清单与交付状态

- **R01**：`scripts/check-delivery.mjs` 从 `tasks.current.json` 生成逐状态计数（状态、evidence 路径存在性实检），词表按 G-2；`verified` 无证据文件即报错。**已用 `npm run status` 机器校验取代人工回看**——它首次运行就查出 2 条已标 verified 的任务证据指针断掉、2 条锚点指不到地方。
- **R02**：`docs/release/acceptance-report.md` 逐 Gate 引用任务与用例 ID 和证据节；截图只作辅助不作数据库验收。
- **R03/R04**：`docs/release/known-issues.md`：CSP 未启用、日志文件轮转未实现、T042 未执行、`0.0.0.0` 守卫宽限、组合字符只断言计数、
  多浏览器与真机未测、坏盘人工作业未演练——每条写复现条件、影响、临时处理、是否阻塞发布。**阻塞发布项实测为 0 条**。
- **R05/R06**：交付目录扫描（无 `.data`/Key/`node_modules`）；发布结论按四条硬性不变量（原文不丢、无秘密泄露、无静默覆盖、可恢复）逐条给证据指针，写在 `acceptance-report.md` 第 10 节。

### 3.8 T084 最终用户旅程与 MVP 完成定义

- `tests/e2e/final-journey.spec.ts`：R01–R05 一条长旅程，用 `restartServer.ts` 做"停止应用"，恢复到 `restartDataDir()` 的空库；
  模型步骤用脚本替身，真实模型段按 R04 规则 skip 并单列。
- `docs/release/final-acceptance.md`：R06 四清单——已实现 / 未实现 / 真实验证 / 未验证；不新增登录、协同、向量库。
- README 收尾。**这是 G6 出口条件本身**：T084 通过前不得宣布 MVP 完成。

## 4. 每项固定验证与提交节奏

```
每项开始：读 docs/04_tasks/G6/T0xx_*.md + docs/05_tests/G6/T0xx_cases.md（六个用例逐条列到 evidence）
每项结束：npm run typecheck && npm run lint && npm run contracts && npm test
          npm run build && npx playwright test          （T078 起全量；此前至少 gate5+gate4 冒烟）
          变异对照 ≥1 处（先打印注入落地，再还原，git status 干净）
          tasks.current.json / docs/progress/G6.md / evidence/G6.md / NEXT_TASK.md
          一项一提交，中文提交信息写明"做了什么 / 没做什么 / 实测数字"
永不：写 .data、把 Key 值放进任何文件或日志、用替身冒充真实模型通过、删既有验收、推送/开 PR/部署
```

用例数守恒检查：五个 vitest project 之和必须等于整跑（当前 392+531+103+32+10 = 1068）；e2e 只增不减（当前 120）。

## 5. 风险登记

| 风险 | 触发 | 缓解 |
| --- | --- | --- |
| 改 `harness.ts` / `playwright.config.ts` 让 120 例一起红 | T078 第一步 | 先只加装置不加场景，全量绿再继续；新红一律按真实异常处理 |
| `E2E_STALE_BUILD` 守卫拦住 | 改任何 `src/` 后直接跑 e2e | 这是守卫正常工作；`npm run build` 后再跑，不要绕过 |
| 一万条种子写错目录 | T079 | `seed-benchmark.mjs` 复用 `isUserDataDir` 拒绝 `.data`；`user-data-guard.test.ts` 是它的回归 |
| `npm audit` 无网 | T081 | 记 `blocked`，不伪造结果 |
| 变异脚本路径没落地却"全绿" | 任何变异对照 | 先 `rg` 打印注入行号再跑（T077-3 记录过一次险情） |
| 子代理/并行"假成功" | 若再派发 | 本方案默认主执行者串行；派发需用户明确授权，且结果以磁盘差异与实跑为准 |

## 6. 完成定义（何时可以说"做完了"）

1. T077–T084 全部 `verified`，每项六用例在 `evidence/G6.md` 有命令、退出码与结论；T042 `blocked` 单列。
2. `docs/progress/G6.md` 改为通过报告，G6 出口四条（实现位置与测试记录、成功/失败分支、无 Key 可回归、无未登记依赖与秘密泄露）逐条有证据。
3. `docs/release/final-acceptance.md` 的四清单成立，README 与实际一致。
4. 最终交付：逐 Gate 结论表、本地复现命令清单、未执行/阻塞项、真实缺陷清单、每 Gate 提交 hash。
