# 最终验收（T084：最终用户旅程与 MVP 完成定义）

本文件是**实测记录与范围声明**，不是规格的预期句。它回答两个问题：从一个空目录开始，
这个产品是否真的满足「碎片记录、多视图整理、本机 Key 设置、可恢复使用」这四个目标；
以及**MVP 完成到底包含什么、不包含什么**。四张清单在第 3 节，逐条给出证据指针。

- 状态来源：`implementation/progress/tasks.current.json`，由 `npm run status` 机器校验。
- 旅程证据：`tests/e2e/final-journey.spec.ts`（T084-C01…C06，串行，一段旅程六个阶段）。
- 结论口径：`已执行` / `失败` / `阻塞` / `未执行` 四态分开；替身不写成真实外部服务已通过。
- 环境：Windows 10.0.22631 · Node 24.18.0 · Next.js 16.3.5 · 桌面 Chromium（Playwright）。
  **所有数字只代表这个环境**，未测平台不宣称兼容。

## 1. 结论

**MVP 完成定义成立（本机 Windows 桌面 Chromium 环境）**，边界如下：

1. 84 个任务中 **83 个 `verified`**，**1 个 `blocked`（T042 真实模型语义验收）**。
   T042 需要用户自己的 API Key，执行者不接触 Key 值；它阻塞的是「模型整理得好不好」这一
   语义结论，**不阻塞产品可用性**——T070–T075 与本旅程的 C01 都断言「没有模型配置也能记录、
   导出、恢复、不发起外部请求」。
2. 六个旅程场景 **全部已执行并通过**（第 2 节），其中模型回答由脚本文件回放：请求走真实路由、
   守卫、schema、事务与入库，只有向供应商出网那一步被替代（`docs/03_contracts/06_llm_pipeline.md` §1
   允许的唯一替身）。因此本文件证明的是**系统按契约处理了模型输出**，不是**模型输出本身的质量**。
3. MVP 完成**不等于**未来所有功能都具备。第 3.2 节「未实现」与第 3.4 节「未验证」是范围声明的
   一部分，不是待办清单；其中云同步、多用户、登录、向量检索、Agent 框架等**从未在批准范围内**。

## 2. 旅程实测记录

命令与退出码（本机，2026-09-17）：

```
npx playwright test tests/e2e/final-journey.spec.ts --project=chromium
  6 passed（约 60 s，含 3 次真实进程启停）        exit 0
```

旅程在 **自己的进程**（端口 3101，`scripts/start-local.mjs start`，与用户同一条启动路径）与
**自己的空目录**（`tests/e2e/.data-restart`，开头整个删掉）上运行，不触碰用户 `.data` 与共享套件库。
六个阶段串行，后一段依赖前一段明确创建的记录、关系与视图。

| 用例 | 覆盖规则 | 结论 | 实际动作与断言（摘） |
| --- | --- | --- | --- |
| **T084-C01** 新仓库启动 | R01 | **已执行，通过** | 目录不存在 → 启动 → 打开 `/inbox` → `/api/items` 为空 → 首次数据访问后 `brain.db` 存在。从输入框保存 3 条不同内容，资料库 3 张卡各带服务端 id。**停掉进程再起一个**（pid 不同、会话令牌不同）：3 条按 id 逐字读回，卡片仍在 3 张 |
| **T084-C02** Key 前端配置 | R01 | **已执行，通过** | 仓库无 `.env*`；设置页表单填 Base URL / 模型 / Key → 点保存：`PUT /api/settings/llm` 200，响应体不含 Key 与 `apiKey` 字段；保存瞬间输入框清空，`key-status` 只说「有 Key」；**整页 DOM 不含 Key 明文**；服务端 `apiKeyConfigured=true`。写入 `{"ok":true}` 脚本后点「测试」：`连接：通过 / 结构校验：通过`，测试响应不含 Key。刷新后仍不回显 |
| **T084-C03** 多视图同源 | R02 · R03 | **已执行，通过** | **从抽屉按钮整理甲**（此前没有任何 e2e 把这条按钮走到成功）：标题/摘要/标签落库，`manualFields=[]`；模型给的关系 甲→乙（引文为乙原文逐字片段）落成 1 行 `ai/suggested`。**整理丙、零关系**：成功，`rawText`/`capturedText`/`rawVersion` 一字未动，关系 0 行。乙不整理，以原始状态进入三张图。三条进选择条 → 脑图页点生成 → `已经生成脑图`；叶节点来源列表里是甲的 **同一个 id** 与模型标题，`source-open` 回跳到同一条记录。选择条 → 流程图页 → 写观察问题 → 点生成 → `已经生成流程视图`；边 n2→n3 声称 `causal` 却无依据，被**降级为推测**并在结果里说明，画面上有「推测：」，来源面板 n1 的来源是甲的 id、n3 下列出 1 条推测。两张视图的 `selection.itemIds` 与 `sourceSnapshot.items` 都是这 3 个 id；`content` 不内嵌原文；刚生成时 `isStale=false`；条目仍 3 行、关系仍 1 行、推测边没有变成关系 |
| **T084-C04** 人工控制 | R02 · R04 | **已执行，通过** | 抽屉编辑摘要 → `manualFields` 含 `summary`；点「拒绝」→ 该行变 `rejected`，按钮变「重新允许这条建议」。**第二次整理**（模型想覆盖摘要、想恢复同一条关系）：`state=succeeded`，标题按模型更新（非手工字段照常写），**摘要一字未动**，甲—乙之间仍只有那一行墓碑、没有新 `suggested` 行、没有「确认」按钮；资料库卡片显示手动摘要 + 第二次标题。随后改乙原文（`rawVersion` +1），旧脑图 `isStale=true`、横幅写明「条笔记已修改」；点「重新生成」→ 确认框写明「新旧两张会同时保留」→ `已经生成新的脑图`：脑图变 2 张，新图 `isStale=false` 且快照记录乙的新 `rawVersion`；旧图 `content`/`contentHash`/`generatedAt`/`revision` 全部不变、仍可打开、仍诚实标着过期 |
| **T084-C05** 恢复证明 | R05 | **已执行，通过** | 恢复前从 API 读完整快照（3 条、1 关系、3 视图）。设置页「导出整库」真实下载：`schemaVersion=1`，3 条 id 一致，拒绝墓碑 `reviewStatus=rejected` 在内，3 张视图 id 一致；字节不含 Key、不含 `sk-` 形态、不含 `apiKey`/`baseUrl`。**停进程 → 删目录 → 重启**（目标库读出为空、`apiKeyConfigured=false`）→ 设置页选文件 → 校验（`data-valid=true`，条目 3 · 关系 1 · 视图 3）→ 勾选 → 恢复 → `已恢复到空知识库`。逐字段对比：每条 `rawText`/`capturedText`/`title`/`summary`/`manualFields`/`tags`/`rawVersion` 相同；关系同 id、仍 `rejected`、引文相同；三张视图 `content`/`selection`/`sourceSnapshot`/`contentHash`/`generatedAt` 相同，**过期判断也相同**（旧脑图仍 stale、新脑图仍 fresh）。界面：抽屉能打开原文并显示「重新允许这条建议」，卡片显示手动摘要，脑图与流程图都能从列表打开并画出。**Key 与连接配置都不在恢复结果里**：`apiKeyConfigured=false`、`baseUrl=''`，设置页两个输入框为空 |
| **T084-C06** 完成边界 | R06 | **已执行，通过** | `tasks.current.json` 84 条、状态只在四种词表内、非 `verified` 的 id 全部出现在本文件；本文件有四张清单标题且明确写出云同步 / 多用户 / 向量检索不在范围；README 指向本文件与 `known-issues.md`。产品侧：主导航恰好是六个已交付路由，`/login`、`/sync`、`/api/auth`、`/api/sync` 均 404 |

### 2.1 旅程里观察到的三个行为（不是缺陷，记下来免得下一个人当缺陷修）

| 观察 | 说明 |
| --- | --- |
| `brain.db` 在**第一次真正的数据读写**时才建出，`/api/health` 不碰库 | 健康检查只回答「进程活着」；迁移在首次 `getDb()` 执行。C01 的断言因此放在首次 `/api/items` 之后 |
| 抽屉的**只读态不显示摘要与标签** | 摘要显示在资料库卡片与编辑表单里；抽屉只读态是原文、来源、关系、整理入口。属于既有信息架构（T020/T025），不是丢数据；若要改属 UX 决策，不在 T084 授权内 |
| 视图过期以**每条材料的 `revision`** 为准，不只看 `rawVersion` | 手动改摘要、模型改标题都会让引用它的视图 `isStale=true`。这是 T059 的定义（「视图是某一刻的记录」），C04 的注释写明了这一点 |

## 3. 四张清单

### 已实现

按 Gate 列出**代码存在、接线完成、有对应用例**的能力；每项的验证状态见第 3.3 节。

| Gate | 能力 | 实现位置（入口） |
| --- | --- | --- |
| G0 | 运行时预检、锁定依赖、启动脚本、六页外壳、统一 API 信封与 28 个错误码、本地请求令牌与来源防护、健康检查、SQLite 运行时与迁移、仓储/DTO、测试装置、契约守卫 | `scripts/doctor.mjs`、`scripts/start-local.mjs`、`src/components/AppShell.tsx`、`src/server/http/*`、`src/server/db/*`、`vitest.config.mjs`、`scripts/check-contracts.mjs` |
| G1 | 收件箱采集（幂等 `captureRequestId`、IME、快捷键）、资料库列表/搜索/筛选/排序/分页、条目编辑（手工字段保护、乐观并发）、标签、人工关系、删除确认、详情抽屉、重启持久化 | `src/app/(workspace)/inbox`、`/library`、`src/features/inbox`、`src/features/library`、`src/features/shared/KnowledgeDrawer.tsx` |
| G2 | 设置页 LLM 连接（Key 只存本机、不回显、替换/保留/删除三态、换主机需确认）、连接测试、组织提示词与严格 JSON schema、一次格式修复、候选召回、证据核对（逐字引文 + 分数下限）、关系建议审核（确认/拒绝/恢复、墓碑不复活）、运行台账与诊断 | `src/features/settings`、`src/server/llm/*`、`src/server/services/organizeItem.ts`、`applyRelationSuggestions.ts`、`src/features/shared/RelationReviewPanel.tsx` |
| G3 | 关系图（真实节点、布局保存、过滤、检视器、过期标记、无障碍） | `src/app/(workspace)/graph`、`src/features/graph` |
| G4 | 脑图生成（选择条 → 生成）、大纲与来源列表、来源回跳、过期横幅、重新生成另存（旧图保留）、导出 | `src/app/(workspace)/mindmap`、`src/features/mindmap`、`src/features/shared/SourceList.tsx` |
| G5 | 流程图生成（材料核对 → 观察问题 → 生成）、五种边语义、无依据因果降级为推测、来源与推测面板、Mermaid 净化渲染与回退、导出（SVG/Mermaid/JSON）、删除视图 | `src/app/(workspace)/flow`、`src/features/flow`、`src/server/services/flow*` |
| G6 | 整库逻辑导出（秘密白名单）、恢复校验与空库策略、恢复事务与回滚、WAL 备份与损坏恢复说明、本地诊断、安全回归、性能预算、Windows 安装与故障手册、生产构建与依赖审计、中文文案与无障碍、任务证据与交付守卫、**最终用户旅程** | `src/app/api/export`、`/import`、`src/server/services/exportKnowledge.ts`、`importKnowledge.ts`、`src/features/backup`、`scripts/check-delivery.mjs`、`tests/e2e/final-journey.spec.ts` |

### 未实现

这些**不在批准范围内**，代码里没有、也不会以「实验开关」形态存在。列出来是为了让「MVP 完成」
不会被读成「这些也快了」。

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 云同步 / 云数据库 / 远程备份 | **范围外，未实现** | 单用户、单机、SQLite 文件；备份是用户自己保管的 JSON |
| 多用户 / 登录 / 协同 / CRDT | **范围外，未实现** | 请求防护是「本机进程签发的令牌 + 来源校验」，不是账号系统 |
| 向量检索 / 嵌入 / 语义搜索 | **范围外，未实现** | 候选召回是最近记录 + 词面匹配（`findCandidates.ts` 注释写明只做字面召回） |
| Agent 框架 / 多步自动整理 / 后台队列 | **范围外，未实现** | 每次整理是一次用户点击、一次付费请求、一个同步返回的 run |
| 独立 Python 后端 / Docker / 微服务 | **范围外，未实现** | 单一 Next.js 进程 + Node 内置 SQLite |
| 自由白板 / 触屏画布 / 移动端布局 | **范围外，未实现** | 桌面专用；窄窗口只验证到 1280×720 |
| 内容安全策略（CSP） | **有意未启用** | 原因与解除条件见 `docs/release/known-issues.md` §2.2（Mermaid 内联样式） |
| 日志落盘与轮转 | **有意未实现** | 诊断日志只写进程标准输出，内存有界；见 `known-issues.md` §2.4 |
| 发布 zip 的签名 / 分发渠道 | **范围外** | 只证明 zip 内容无个人数据 |
| 抽屉只读态显示摘要/标签 | **未做（UX 决策未下）** | 见第 2.1 节；摘要在卡片与编辑表单可见 |

### 已验证

「已验证」指**有自动化用例逐条执行并留下退出码**，或**有人工实测记录**。全量数字见第 4 节。

| 层 | 证据 | 数量 |
| --- | --- | --- |
| 单元 / 集成 / 安全 / 契约 / 浏览器（vitest） | `npm test` | 84 文件 · **1095** 例 · exit 0（T083 收尾实测；本轮 T084 未增 vitest 用例） |
| 浏览器端到端（Playwright，生产构建） | `npx playwright test` | 140 例通过 / 1 条件跳过（T083 收尾）+ **本轮新增 6 例旅程**；全量复跑结果见第 4 节 |
| 性能预算 | `npm run test:perf` | 12 例（`docs/performance-report.md`） |
| 生产构建 / 依赖审计 | `npm run build`、`npm audit` | exit 0；0 条（`docs/release/build-report.md`、`dependency-audit.md`） |
| 干净目录复现 | `git archive` → `npm ci` → 全链 | exit 0（T081-C01） |
| 四条硬性不变量（原文不丢 / 无秘密泄露 / 无静默覆盖 / 可恢复） | `docs/release/acceptance-report.md` §10 | 通过；本旅程 C03–C05 再各自加了一次端到端证据 |
| 真实供应商 API（结构层） | T081-C02 生产启动实测 11 项断言 | 通过（只证明请求/响应结构，不证明语义） |

### 未验证

| 项 | 状态 | 原因 / 解除条件 |
| --- | --- | --- |
| **T042 真实模型语义验收**（整理得好不好、关系提得准不准） | **阻塞** | `BLOCKED_BY_EXTERNAL_CREDENTIAL`：需要用户自己的 Key。用户在设置页配置后运行 `npx playwright test tests/e2e/gate2.spec.ts`。T069-C01 语义一半、T078-R04 真实供应商浏览器场景同此 |
| 脚本替身之外的模型行为（格式修复是否真能修好、超时/限流的真实表现） | 未验证 | 替身只回放固定答案；超时与错误分类有单测，但没有真实供应商的现场记录 |
| Firefox / WebKit / 真机 / macOS / Linux | 未测平台 | 本版只面向 Windows 桌面 Chromium |
| 真机断网、全新容器 `npm ci`、系统级 150% DPI | 未执行 | 见 `acceptance-report.md` §8.2 |
| 屏幕阅读器人工听读、真实输入法候选窗、对比度逐项计算 | 未执行 | 全部无障碍结论来自 DOM 属性与自动化断言 |
| 坏盘上的人工作业 | 未演练 | 文档已校验，无法在 CI 模拟坏盘 |
| 数万节点规模 | 未执行 | 契约预算 `graphNodes = 200`，实测覆盖到预算 |
| Playwright trace 脱敏 | 未实现 | trace 会归档已提交请求体；`test-results/` 被 gitignore 且由交付扫描拦下 |
| T001-C03 只读目录 | 未执行 | Windows 下需管理员 ACL 操作 |

## 4. 本轮全量门禁（T084 交付时实测）

```
npm run typecheck                                       exit 0
npm run lint                                            exit 0
npm run contracts                                       exit 0
npm run status                                          exit 0   verified 83 / blocked 1（T042）/ not_started 0 / in_progress 0
npm test                                                exit 0   84 文件 / 1095 例
npm run build                                           exit 0
npx playwright test                                     exit 0   146 passed / 1 skipped
npx playwright test tests/e2e/final-journey.spec.ts     exit 0   6 passed
```

（数字以 `implementation/progress/evidence/G6.md` T084-1 段为准；本节与之同步。）

## 5. 复现命令

```powershell
# 只跑最终旅程（需先 npm run build；改了 src/** 后 E2E_STALE_BUILD 会拒绝，属守卫正常工作）
npx playwright test tests/e2e/final-journey.spec.ts --project=chromium

# 完整检查链
npm run check          # contracts → status → lint → typecheck → test → build
npx playwright test    # 全部浏览器用例（含旅程）

# 用户自己解除 T042：在设置页配置真实 Key 后
npx playwright test tests/e2e/gate2.spec.ts
```

## 6. 本文件自身的边界

1. 旅程里所有模型回答都是**脚本文件**；凡写「通过」处指的是「按契约处理了这份回答」。
2. 截图不作数据库验收；本文件的每一条结论来自命令退出码、测试 ID 与 API/数据库读回。
3. `.data-restart` 与 `test-results/` 是测试产物，被 `.gitignore` 排除并由交付扫描拦下；旅程从未打开用户 `.data`。
4. 本文件替代不了 `docs/release/known-issues.md`：已知问题的复现条件、影响、临时处理与是否阻塞发布仍以该文件为准。
