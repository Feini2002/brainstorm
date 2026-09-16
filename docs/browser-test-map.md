# 浏览器端到端测试映射（T078）

本文件是 T078 的交付产物之一：把「八个关键旅程」映射到**实际跑在真实浏览器里的用例**，
并如实标出哪些是自动断言、哪些只能人工检查、哪些**没有做**。
它是索引而不是结果报告；每次执行的实际数字见 `implementation/progress/evidence/G6.md`。

## 一、装置（决定这些用例能证明什么）

| 装置 | 位置 | 它保证了什么 |
| --- | --- | --- |
| 隔离数据目录 | `playwright.config.ts` 在加载时调用 `resetE2eDataDir()`；服务以 `BRAIN_DATA_DIR=tests/e2e/.data` 启动 | 用例从不打开用户的 `./.data/brain.db`（T026「测试不触碰用户数据库」） |
| 单一 worker | `workers: 1` | 每条断言关于「这一个本地进程 + 这一个 SQLite 文件」的事实才可观察（租约、幂等、零外部请求） |
| 生产构建 | `webServer` 跑 `scripts/start-local.mjs start`（`next start`） | 离线与零请求的结论是关于**构建产物**的；dev 模式的 HMR 会让网络审计失去意义 |
| 构建新鲜度守卫 | `tests/e2e/support/buildFreshness.ts`，配置加载阶段比对 mtime | 改了 `src/**` 却没 `npm run build` 会得到 `E2E_STALE_BUILD` 而不是「测到上一次构建」。**这是守卫在正常工作，不要绕过** |
| 网络记账 + 出站阻断 | `tests/e2e/support/harness.ts` 的 `observeTraffic`（`traffic` fixture，每个用例都有） | 非回环请求被 `route.abort`，并记录在案；「零外部请求」有证据而非声称 |
| 控制台与未捕获异常 | `tests/e2e/support/consoleWatch.ts` + `fixtures.ts`（**`auto: true`**） | 每个用例都监听 `console.error` 与 `pageerror`，teardown 断言为空。豁免只有三条**写明理由**的规则，没有 `page.on('pageerror', ()=>{})` 这种全局屏蔽（T078-R03） |
| 窄屏 project | `playwright.config.ts` 的 `chromium-narrow`（1280×720，`grep: /@narrow/`） | 常规桌面 + 窄屏两个窗口。**是窄桌面不是手机**：本项目桌面专用，`isMobile` 故意不设 |
| 测试替身 | `BRAIN_SCRIPTED_PROVIDER` 指向 `test-results/scripted-provider/` | 真实路由、适配器、事务、入库全跑，只替换出站 HTTP 一步；真实模型验收另计（T042 单列） |

豁免规则（`consoleWatch.ts` 的 `EXCUSE_RULES`，共三条，每条都要求用例另行断言那件事）：

1. 装置主动阻断外部主机产生的 `net::ERR_INTERNET_DISCONNECTED` 等——用例断言的是「没有任何外部请求成功」。
2. `T025-C02` 用 `route.abort('connectionreset')` 丢掉自己的第一次 POST，制造「响应丢失」；用例随后断言重试成功且两次请求键相同。
3. 用例故意触发的非 2xx（409 冲突、`MODEL_NOT_CONFIGURED` 等）——用例自己断言了状态码与错误码。

## 二、八个关键旅程 → 用例映射（T078-R01）

| # | 旅程 | 主要 spec | 断言的是「真的做了」而不只是「按钮在」 |
| --- | --- | --- | --- |
| 1 | 第一次启动 | `gate1.spec.ts`（空库无 Key 首屏）、`offline-crud.spec.ts` | 空态可见；无 Key 也能采集 |
| 2 | 设置连接 | `gate2.spec.ts`、`offline-crud.spec.ts`、`security.spec.ts`（T075-C02） | 保存后 `apiKeyConfigured` 由服务端回报；浏览器持久存储里没有 Key |
| 3 | 保存整理 | `gate1.spec.ts`、`gate2.spec.ts`、`save-races.spec.ts` | 「已保存」只由创建响应渲染；未知完成状态可重试且复用同一请求键 |
| 4 | 搜索编辑 | `gate1.spec.ts`（搜索/编辑/409 冲突/删除）、`save-races.spec.ts` | 编辑落到服务端；冲突被报告且用户输入不被覆盖 |
| 5 | 图谱审核 | `gate3.spec.ts`、`graph-inspector.spec.ts`、`graph-filters.spec.ts`、`graph-staleness.spec.ts`、`graph-accessibility.spec.ts` | 关系接受/拒绝落到存储；图位置重启后仍在 |
| 6 | 脑图生成 | `gate4.spec.ts`、`mindmap-generation-entry.spec.ts`、`markmap.spec.ts`、`mindmap-sources.spec.ts`、`mindmap-regeneration.spec.ts`、`mindmap-export.spec.ts` | 生成经真实路由落库（`contentHash` 非空）、按 id 读回；入口回归见 `evidence/G6.md` T078-1 |
| 7 | 流程生成 | `gate5.spec.ts`、`flow-intent.spec.ts`、`flow-lifecycle.spec.ts`、`flow-security.spec.ts` | 意图校验、生命周期、导出 SVG 的字节级净化 |
| 8 | **导出恢复** | **`backup-restore.spec.ts`**（本轮新增，4 例） | 导出走真实 `download` 事件；恢复写进**另一个进程的空库**并按 id 读回；非空库 409 `IMPORT_NONEMPTY`；哈希不符 422 `IMPORT_INVALID` |

「变更后读取或重启确认」（T078-R02）由 `tests/e2e/support/restartServer.ts` 提供：停掉 Node、
确认端口释放、起新进程、令牌变化本身就是「不是同一个进程在回答」的证据。使用处：
`gate1.spec.ts`（T026-C02）、`gate3.spec.ts`（T052-C05）、`gate4.spec.ts`（T061-C02）、
`backup-restore.spec.ts`（T078-C01）。

## 三、T078-C05 窄屏与中文输入

| 检查项 | 方式 | 位置 | 结果 |
| --- | --- | --- | --- |
| 窄屏下保存并可打开详情 | 自动（`@narrow`，两个 project 都跑） | `narrow-and-ime.spec.ts` | 通过；断言保存按钮**完整落在视口内**再点击，避免「按钮在 DOM 里但点不到」 |
| 六个页面在窄屏下可导航、无横向溢出 | 自动（`@narrow`） | `narrow-and-ime.spec.ts` | 通过；`scrollWidth - clientWidth <= 1` |
| IME 组合期间按 Ctrl+Enter 不提交 | 自动 | `narrow-and-ime.spec.ts` | 通过；派发带 `isComposing: true` 的真实 `KeyboardEvent`，并断言**草稿一个字都没少** |
| IME 组合结束后 Ctrl+Enter 提交一次 | 自动 | `narrow-and-ime.spec.ts` | 通过；与上一条构成对照，否则「不提交」可能只是提交路径坏了 |
| 真实输入法：候选窗、拼音上屏、全角标点 | **人工** | 见下 | **未执行**（无头浏览器无法替代，需人工） |

### 人工检查记录（T078-R05「辅以人工检查记录」）

**状态：未执行。** 如实记录，不写成已通过。

原因：真实输入法的候选窗、拼音上屏与全角标点行为**无法**在无头 Chromium 里复现——CDP 的
`Input.*` 被本仓库的浏览器装置禁用，`fill()` 直接设值不经过 IME，因此不存在「自动化的等价替代」。
要完成这一项，需要人在有系统输入法的桌面上对着 `npm run dev` 亲手操作并留下记录（Windows 中文
输入法至少一项；macOS/日文 IME 不在本项目支持范围）。

下表是**待执行**的步骤清单（尚未产生任何结果），留给下一次由人完成的检查：

| 步骤 | 结果 |
| --- | --- |
| 在收件箱里用系统中文输入法输入一段话，观察候选窗 | 未执行 |
| 候选未上屏时按 Enter | 未执行 |
| 候选未上屏时按 Ctrl+Enter | 未执行 |
| 上屏后按 Ctrl+Enter | 未执行 |
| 输入全角标点「，」「。」与整段中文，比对码点计数 | 未执行 |
| 把窗口收窄到约 1280 宽，重复保存与打开详情 | 未执行 |

**未执行（其余）**：Windows 之外的输入法（macOS 拼音、日文 IME）、
触屏与移动端布局（本项目桌面专用，不在范围内）。

自动化那两条（组合期间 Ctrl+Enter 不提交 / 组合结束后提交一次）**已经**证明了产品自己的
`captureShortcuts` 规则在这个事件序列下成立；它们**不能**替代上表，因为「事件序列正确」不等于
「真实输入法与这个组合能配合工作」。

## 四、故意**没有**做的事（避免读成已覆盖）

- **没有**给全部 130 例打 `@narrow`：窄屏只覆盖依赖布局的核心路径，否则套件会翻倍而信息量不增。
- **没有**把 `page.request` 直打 API 当成用户旅程：凡是标「旅程」的都用界面控件。少数用例
  （如 `backup-restore.spec.ts` 的非空库第二层）**另外**直打接口，那是在证明「前端禁用按钮不是唯一守卫」，不是替代界面路径。
- **没有**用真实 LLM Provider 出任何结论：全部经 `BRAIN_SCRIPTED_PROVIDER`。真实语义验收由 T042 单列，仍为 `blocked`。
- **没有**做多浏览器（Firefox/WebKit）与真机。
- **没有**做视觉回归基线比对：只做行为断言与失败截图留存。

## 四点五、T078-R06 留痕不泄密：实测结论与残留缺口

用一次性探针（把哨兵 Key 填进设置页并真的提交 `PUT /api/settings/llm`，再故意让用例失败以
触发 `retain-on-failure`），逐字节扫描了留下的一切产物：

| 产物 | 是否含哨兵明文 | 说明 |
| --- | --- | --- |
| `test-results/**` 整体（`error-context.md`、`test.trace`、`1-trace.trace`、`resources/*.json`） | **含** | trace 会归档 Playwright 的调用参数与请求体：`resources/<hash>.json` 里是原始请求体 `{"apiKey":"sk-…"}`；`test.trace`/`1-trace.trace` 里是 `fill` 的 `value` |
| `test-failed-1.png` | 不含 | Key 输入框是 `type="password"`，截图里只有掩码点 |
| `docs/**`、`implementation/**`、git 历史 | 不含 | `test-results/` 已在 `.gitignore` 第 54 行被忽略，且**本仓库从未把产物作为证据提交** |

**结论**：这是 Playwright 对**已提交到网络的请求体**做归档带来的、装置层的已知行为，不是产品缺陷
——产品侧 `type="password"`、`GET /api/settings/llm` 只回 `apiKeyConfigured`（探针里已实测到响应体
不含 Key 明文）、导出字节不含 `apiKey`/`baseUrl`（`T078-C01` 第 144 行断言）都成立。

**残留缺口（具名，不消失）**：本仓库当前**没有**产物脱敏步骤，因此「用例里填过真 Key」时
`test-results/` 会落盘明文。处置：`test-results/` 保持忽略、不提交、不进证据目录；要外发失败
trace 之前必须先删。真 Key 只由人在设置页手输（见 T042），E2E 只用一次性哨兵值。

## 五、复现命令

```
npm run build                      # 必须先构建：e2e 跑的是生产产物
npx playwright test                # 全量（含 chromium-narrow 的 @narrow 子集）
npx playwright test --project=chromium-narrow   # 只跑窄屏
npx playwright test tests/e2e/backup-restore.spec.ts
npx playwright test tests/e2e/narrow-and-ime.spec.ts
```

失败产物（截图与 trace）写在 `test-results/`，已被 git 忽略；trace 用
`npx playwright show-trace <file>` 打开。
