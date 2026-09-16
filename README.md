# Feini Brain｜本地单用户 AI 知识碎片工具

把散落的知识碎片先**原文保存**下来，再用你自己的模型连接去整理、关联、生成视图。
数据放在本机的 SQLite 文件里，服务只绑定回环地址，没有登录、没有云数据库、没有遥测。

本仓库同时承载**规格包**与**实施代码**。规格部分仍可独立阅读：
从 [00_ROUTER.md](00_ROUTER.md) 进入，或看 [车轮组件装配矩阵](docs/02_architecture/02_component_assembly.md)
与 [交付体量审计](DELIVERY_AUDIT.md)。

## 当前交付状态（先读这一段）

**这是本机 Windows 上验证过的版本，不是通用发行版。** 具体地：

| 项 | 状态 |
| --- | --- |
| Windows 10.0.22631 + Node 24.18.0 + npm 11.16.0 | **已实测**（安装、构建、启动、真实读写、端到端测试） |
| macOS / Linux | **未验证**。命令与脚本只用了 Node 内置模块，理论上可移植，但没有在这些平台上执行过 |
| 真实模型端到端验收 | **未执行**。需要用户自己在设置页配置 Key（T042 保持 blocked），无 Key 时整理/生成会返回 `MODEL_NOT_CONFIGURED` |
| CSP（`Content-Security-Policy`） | **未启用**，原因与前置条件见 [docs/security-checklist.md](docs/security-checklist.md) 第三节 |
| 日志文件轮转 | **未实现**（日志走标准输出） |
| 多浏览器 / 真机 | **未测试**，端到端只跑 Playwright 的 Chromium |

已知缺口的完整清单见 [docs/release/known-issues.md](docs/release/known-issues.md)（T083 交付）。

## 安装与运行

### 1. 前置

- **Windows**（本版本验证平台），PowerShell 7 或 Windows PowerShell 5.1
- **Node 24**：`>=24.15.0 <25`（`package.json` 的 `engines` 已声明）。仓库根的 `.node-version` 写的是 `24.15.0`
- **npm**（随 Node 提供）
- 不需要 Docker、不需要 Python、不需要单独安装数据库、不需要全局 CLI
- 只有跑端到端测试时才需要额外下载 Chromium（见第 4 节）

确认版本：

```powershell
node -v
npm -v
```

### 2. 安装依赖

```powershell
npm ci
```

**用 `npm ci` 而不是 `npm install`**：前者严格按 `package-lock.json` 恢复依赖树，装完不重写锁文件；后者会在声明与锁文件不一致时**顺手改掉锁文件**，让你拿到一个没人验证过的依赖树。只有当你有意要升级依赖时才用 `npm install`。

### 3. 启动

首次使用先跑预检（只读，不改任何东西）：

```powershell
npm run doctor
```

它会报告 Node/npm 版本、工程路径形状、数据目录位置、目标端口是否被占用（被占用时给出占用进程 PID）、`PATH` 里解析到的 Node 是否就是当前解释器、以及代理/证书/TLS 相关的环境变量是否存在。**它不会启动服务、不会写文件、不会改环境变量。** 详细的逐项解读见 [docs/operations/windows-setup.md](docs/operations/windows-setup.md)。

日常使用有两种模式：

```powershell
# 开发模式：改代码自动重载，适合自己折腾
npm run dev

# 生产模式：先构建，再以生产构建启动，日常使用推荐这个
npm run build
npm start
```

两者都由 `scripts/start-local.mjs` 拉起，默认绑定 `127.0.0.1:3000`。**它刻意不监听 `0.0.0.0`**：这是一份本机单用户数据，暴露到局域网会让「只有同源页面读得到会话令牌」这条保护失效。

然后在浏览器打开 <http://127.0.0.1:3000/>。

端口被占用时不要让它随便换端口——那会同时改变同源检查的口径。正确做法是把两个变量一起改：

```powershell
$env:APP_PORT = '3457'
$env:APP_ORIGIN = 'http://127.0.0.1:3457'
npm start
```

`APP_ORIGIN` 与 `APP_HOST`/`APP_PORT` 不一致时，启动器会直接拒绝启动，而不是带病运行。

### 4. 端到端测试（可选）

应用本身不需要浏览器二进制。只有跑测试才需要：

```powershell
npx playwright install chromium
npx playwright test
```

这套测试在**另一个端口（3100）**和**另一个数据目录（`tests/e2e/.data`）**上启动它自己的实例，不会碰你的 `.data`。它会先跑 `npm run build` 的结果，所以改了 `src/**` 之后要先重新构建，否则会以 `E2E_STALE_BUILD` 拒绝运行——那是守卫在正常工作，不要绕过。

完整检查链：

```powershell
npm run contracts   # 契约一致性（枚举、限制、错误码、路由、.gitignore）
npm run lint
npm run typecheck
npm test            # unit + integration + security + contracts + browser
npm run build
npm run test:perf   # 性能预算，需要先 build
npm run check       # 上面大部分串起来
```

## 你的数据放在哪

| 内容 | 位置 | 说明 |
| --- | --- | --- |
| 知识库 | `<仓库根>\.data\brain.db`（SQLite） | 连同 `brain.db-wal`、`brain.db-shm` 一起构成完整状态 |
| 数据目录指向 | 环境变量 `BRAIN_DATA_DIR` | 想放到别处（例如数据盘）时设置它；**服务运行时不要切换** |
| 模型连接与 Key | 同一个 `brain.db` 的 `secrets` 表 | **明文保存**。这是本机单用户程序有意为之：它需要把 Key 交给服务商使用。因此 `brain.db` **不是**可外发的诊断包 |
| 逻辑导出 | 你指定的 `.json` 文件 | **不含** Key、不含设置、不含运行记录 |

`.data/`、`tests/e2e/.data*/`、`.env*`、`node_modules` 都在 `.gitignore` 内，并由 `tests/contracts/guard.test.ts` 断言覆盖，不会被 `git add -A` 顺手提交。

**备份**：日常用应用内的逻辑导出（设置页「备份与恢复」→ 导出整库，或 `GET /api/export`）。
文件级复制 `brain.db` 必须先停服，否则 WAL 里最近的提交不在主文件中，你复制到的是缺数据的旧副本。
完整步骤与「损坏了怎么办」见 [docs/operations/backup-recovery.md](docs/operations/backup-recovery.md)。

## 排障

先跑 `npm run doctor`，再按「版本 → 端口 → 路径 → 权限 → 依赖 → 应用」的顺序定位。
常见症状（依赖下载失败、`EUSAGE`、端口被占、路径含空格/中文、数据看起来是空的）逐条写在
[docs/operations/common-failures.md](docs/operations/common-failures.md)。

**最重要的一条：数据出问题时不要删 `.data` 或 `brain.db` 然后重启。** 启动不会修复损坏，只会新建一个空库，让损坏的那份更难找。先复制整个数据目录保留证据，再用 `node scripts/inspect-data.mjs --data-dir .\.data` 诊断。

## 文档索引

| 目录 | 用途 |
| --- | --- |
| [docs/00_product](docs/00_product) | 产品范围与用户结果 |
| [docs/01_research](docs/01_research) | 车轮优势、限制、替代方案与一手来源 |
| [docs/02_architecture](docs/02_architecture) | 系统装配、UI、文件目录、架构决策 |
| [docs/03_contracts](docs/03_contracts) | DTO、API、数据库、状态、Key、LLM、关系、图AST、备份 |
| [docs/04_tasks](docs/04_tasks) | 84 个小任务的实现规格和最小上下文路由 |
| [docs/05_tests](docs/05_tests) | 具名验收场景及测试策略 |
| [docs/06_operations](docs/06_operations) | 安装、依赖下载、备份、排错、交付 |
| [docs/07_gates](docs/07_gates) | 七阶段顺序和验收门槛 |
| [docs/operations](docs/operations) | 运行手册：Windows 安装启动、常见故障、备份恢复 |
| [docs/release](docs/release) | 交付材料：构建报告、依赖审计、已知问题、验收报告 |
| [reference](reference) | 限制常量、Schema、SQL、样例、提示词、预检脚本 |
| [implementation/progress](implementation/progress) | 实施进度、任务状态与证据目录 |

## 实施进度与验收

当前进度以 [implementation/progress/NEXT_TASK.md](implementation/progress/NEXT_TASK.md)（人读）与
[implementation/progress/tasks.current.json](implementation/progress/tasks.current.json)（机器可读）为准；
逐 Gate 完成情况在 [docs/progress](docs/progress)，运行证据在
[implementation/progress/evidence](implementation/progress/evidence/README.md)。

规格包自身的检查（链接、任务依赖、参考数据与 SQL 约束）针对**文档**，不证明应用已经运行。
`implementation/progress/tasks.initial.json` 保留实施前的全 `not_started` 起点，不被覆盖。

**没有标注证据的任务保持未完成状态；没有真实执行的用例一律记为未执行或环境阻塞。**
