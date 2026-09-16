# Windows 安装与启动手册

本文件是 **T080 的安装与运行手册**：从一台只有 Windows 的机器开始，到能每天使用本应用。
每条命令都在本机 Windows + PowerShell 7.6.3 下**实际执行过**，执行记录（含退出码与原始输出）
在 [`implementation/progress/evidence/G6.md`](../../implementation/progress/evidence/G6.md) 的 T080 一节。

> **适用范围（先说到这里）**：本手册只覆盖 **Windows**。macOS/Linux 的等价步骤未在本机执行，
> 因此不作兼容性声明。命令用 PowerShell 写出，`cmd.exe` 下的差异见第 9 节。
>
> 本文写的是**怎么用**；为什么这样设计见 [安装与引导（规格）](../06_operations/01_install_and_bootstrap.md)。
> 备份、搬迁与损坏恢复见 [backup-recovery.md](backup-recovery.md)。出问题先看 [common-failures.md](common-failures.md)。

## 1. 你需要什么

| 项目 | 要求 | 怎么确认 |
| --- | --- | --- |
| Windows | 10 或 11（本机 10.0.22631 实测） | `[System.Environment]::OSVersion.Version` |
| Node.js | **24 LTS，且 ≥ 24.15、< 25** | `node -v` |
| npm | 随 Node 一起安装（本机 11.16.0） | `npm -v` |
| 磁盘 | 记录库本身很小（一万条约 10.9 MiB，见 [性能报告](../performance-report.md)）；`node_modules` 与浏览器二进制占主要空间 | — |
| 浏览器 | 只有**跑端到端测试**才需要，见第 4 节 | — |

**不需要**（装上也不会被用到）：Docker、数据库服务器、Redis、Python、独立后端服务。
本应用是单机单进程 + 一个 SQLite 文件。

> 本规格包里带了两个 Python 审计工具（`tools/audit_spec.py`、`audit/`）。
> 它们是**文档包的自检工具**，不是应用的运行依赖：日常安装、启动、备份都不需要 Python。

## 2. 第一步：先确认版本，再进目录（T080-R01）

**不要先 cd 再查版本。** 先把当前会话的解释器版本与路径打印出来，因为最常见的失败是
「我以为我装的 Node 生效了，实际当前终端用的是另一个」。

```powershell
node -v
npm -v
where.exe node
```

本机实测输出：

```text
v24.18.0
11.16.0
C:\Program Files\nodejs\node.exe
```

判定标准：

- `node -v` 必须是 `v24.15.0` 及以上、且主版本正好是 **24**（`v25` 会被预检拒绝）。
- `where.exe node` 可能列出**多行**。如果第一行不是你想用的那个 Node，说明 PATH 里有两个版本，
  先解决它再往下走（第 10 节 C2）。
- 三条命令的输出要能互相解释：`where.exe` 的第一行应该就是刚运行 `node -v` 的那个解释器。

### 2.1 目录含空格或中文：必须加引号（T080-C01）

本仓库所在的目录名含中文（`个人知识库`），这**完全支持**，但路径含空格时**不加引号会直接失败**。
这不是应用的毛病，是 PowerShell 的词法：未加引号的路径会被当成多个参数。

```powershell
# 正确：整个路径加双引号
Set-Location "C:\Users\你的名字\Desktop\个人知识库"
node -v
```

本机实测的对照（在一个 `feini 安装 演练` 目录上）：

```text
== 不加引号 ==
Set-Location: A positional parameter cannot be found that accepts argument '安装'.

== 加引号 ==
quoted_cwd=C:\Users\123235\AppData\Local\Temp\feini 安装 演练
```

同一个坑在调用脚本时也一样：

```text
node C:\...\Temp\feini 安装 演练\probe.mjs
  → Error: Cannot find module 'C:\...\Temp\feini'

node "C:\...\Temp\feini 安装 演练\probe.mjs"
  → probe ok
```

**规则**：凡是路径里可能出现空格（用户目录、桌面同步目录、中文目录都很可能），一律加引号。
本手册后面所有命令都按这个写法给出。

### 2.2 预检：一次跑完，先看结论（T080-R01）

进入仓库后先跑预检。它只读不写、不碰你的资料、不连模型：

```powershell
npm run doctor
```

它会检查并报告：

| 检查 | 失败时说明什么 |
| --- | --- |
| Node 版本在 24.15–24.999 | 退出码 `2`，并报出实际主版本 |
| 系统临时目录能读写 SQLite（含中文与 emoji 往返） | 退出码 `1` |
| 当前工程目录可写 | 退出码 `1` |
| `package.json` 可读 | 退出码 `1` |
| **应用端口是否被占用，以及占用者的 pid** | 不改变退出码（见 T080-C04） |
| **PATH 里的 node 是否就是正在运行的那个** | 不改变退出码（见 T080-C02） |
| **代理/CA/TLS 变量是否被设置**（只报名字，不报值） | 不改变退出码 |

最后三项是 T080 加的，它们**不参与**通过/失败判定：端口被占、PATH 里两个 Node、公司代理开着，
都是「配置事实」而不是「运行时坏了」，混进退出码会让提示说错话。

## 3. 第二步：安装依赖（T080-R02）

先判断你手上是哪种情况，**不要靠反复删文件碰运气**：

```powershell
if (Test-Path .\package-lock.json) { "有锁文件：用 npm ci" } else { "没有锁文件：用 npm install" }
```

### 3.1 有 `package-lock.json`（本仓库的常态）

```powershell
npm ci
```

`npm ci` 会**按锁文件**装出与开发时完全一致的依赖树，并且不会改写 `package-lock.json`。
它还会先删掉现有的 `node_modules` 再重装——所以别在别的终端正跑着应用时执行。

### 3.2 没有锁文件（首次从 `package.json` 解析）

```powershell
npm install
```

`npm install` 会解析版本并把结果写进 `package-lock.json`。**这个文件要提交**，之后所有人（包括你
自己重装）都改用 `npm ci`。

### 3.3 不要做的事

- ❌ **不要删掉 `package-lock.json` 再 `npm install`**。那不是"修复依赖"，那是把依赖树换成
  今天 registry 上的另一个版本，之后没人能复现你的构建。本仓库有 T002-C02 在盯着这件事：
  `package.json` 与锁文件不一致时，`npm ci` 必须**失败**而不是悄悄换版本。
- ❌ **不要用 `--force` / `--legacy-peer-deps` 让警告消失**。它们只是把不兼容藏起来
  （T002-C06 会检查仓库里没有这些开关）。真冲突时读那条 peer 约束再决定。

装完之后核对一下：

```powershell
npm ls --depth=0
```

本机实测（末尾几行）：`react@19.2.8`、`typescript@5.9.3`、`vitest@3.2.7`、`zod@4.6.5`，
退出码 `0`。`npm ls` 非零退出码通常意味着依赖树里有缺口，这时先解决它，别继续往下走。

## 4. 可选：下载测试用的浏览器（T080-R03）

**只有你要跑端到端测试才需要这一步。** 业务功能本身不需要 Playwright，也不需要 Chromium。

```powershell
npx playwright install chromium
```

这里必须分清**两条完全不同的下载通道**，它们的失败原因和处理方式都不一样：

| 下载通道 | 从哪来 | 装到哪 | 失败典型表现 |
| --- | --- | --- | --- |
| npm 包（`next`、`react`、`vitest`…） | npm registry | `node_modules/` | `ETIMEDOUT` / `EAI_AGAIN` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE`（证书） |
| 浏览器二进制（Chromium） | Playwright 自己的 CDN | `%LOCALAPPDATA%\ms-playwright\` | `Executable doesn't exist` / CDN 域名被拦 |

浏览器二进制**不在 npm registry 上**，所以「npm 包装成功了」不代表浏览器装好了。反过来也一样。
想看它到底会下什么、下到哪里（只打印，不下载）：

```powershell
npx playwright install --dry-run chromium
```

本机实测输出（节选）：

```text
Chrome for Testing 153.0.8010.12 (playwright chromium v1243)
  Install location:    C:\Users\123235\AppData\Local\ms-playwright\chromium-1243
  Download url:        https://cdn.playwright.dev/builds/cft/153.0.8010.12/win64/chrome-win64.zip
```

注意这是**用户级目录**（`%LOCALAPPDATA%`），不写 `Program Files`，也不需要管理员权限。

> 缺浏览器时的报错应当**指名安装命令**而不是让你加 `sleep`。本仓库有 T002-C03 盯着这一点：
> 在一个空浏览器目录下启动必须失败，且报错里必须出现 `npx playwright install`。

## 5. 第三步：构建与启动（T080-R04）

### 5.1 `dev` 与 `start` 的区别

| | `npm run dev` | `npm run start` |
| --- | --- | --- |
| 用途 | 改代码时调试 | **日常使用** |
| 前置 | 无 | **必须先 `npm run build`** |
| 产物 | 现场编译 + 热更新（HMR） | 跑 `.next/` 里的生产构建 |
| 速度 | 改一行立刻生效 | 启动即可用，不重新编译 |
| 结论 | 开发用 | **日常固定版本用这个** |

日常使用不要跑 `dev`：它会开热更新、现场编译，慢且与交付的产物不是同一份东西。

### 5.2 首次与升级后

```powershell
npm run build
```

构建只写 `.next/`，**不会**动你的知识库。构建过程中的迁移不在 build 阶段跑。

### 5.3 每天启动

```powershell
npm run start
```

`start` 之前会自动跑一次预检。因为它只读，所以「日常使用」的完整流程就是这一条命令，
**不需要重新 `npm ci`，也不需要重新填 Key**：Key 存在本机数据库里（见 5.5）。

打开浏览器访问：

```text
http://127.0.0.1:3000
```

### 5.4 本机地址、绑定与退出

- 服务**只绑定回环地址** `127.0.0.1`，默认端口 `3000`。它不是"局域网上的一台服务器"，
  同一网段的其它机器访问不到，这是设计如此，不要改成 `0.0.0.0`。
- 想换端口要**同时**改端口与来源，否则服务端守卫会拒绝浏览器请求（这是有意的，防止地址漂移）：

```powershell
$env:APP_PORT = "3100"
$env:APP_ORIGIN = "http://127.0.0.1:3100"
npm run start
```

  两者不一致时启动器会**直接拒绝启动**并说明原因，不会静默换端口。

- **退出：在运行服务的那个窗口按 `Ctrl+C`。** 启动器会把中断信号转发给子进程，所以不会留下
  一个还在占着 3000 端口的孤儿进程。按了 `Ctrl+C` 后如果端口仍然被占，用第 10 节 C4 的方法查。

### 5.5 数据放在哪、Key 怎么存（重要）

| | 位置 | 说明 |
| --- | --- | --- |
| 知识数据 | 仓库下的 `.data\brain.db`（含 `brain.db-wal` / `brain.db-shm`） | 已在 `.gitignore` 里，**不会被提交** |
| 换位置 | 环境变量 `BRAIN_DATA_DIR`（绝对路径） | 见 [backup-recovery.md](backup-recovery.md) 第 3 节 |
| 模型 Key | 同一个数据库的 `secrets` 表，**明文** | 见下 |

关于 Key 的实话：

- 它按设计以**明文**存在本机数据库里。本应用是本机单用户工具，需要把 Key 交给服务商才能调用模型，
  没有可用的操作系统级密钥库抽象，所以这里不做加密承诺。
- **因此完整数据库文件不是可以外发的诊断包。** 要给数据给别人看，用应用内的**逻辑导出**
  （设置页「备份与恢复」→「导出整库」，或 `GET /api/export`）——它**不含** Key、设置与运行记录。
- 不要把 Key 粘进聊天、工单、截图；不要在 `NEXT_PUBLIC_*` 里放它。

### 5.6 没有 Key 也能用

采集、编辑、检索、标签、关系、图/脑图/流程的浏览与导出都不需要 Key。只有「整理」和
「用模型生成视图」需要。设置页会明确区分「已保存一个 Key」与「刚才测试通了」两种状态，
不会用一个绿灯糊过去。

## 6. 每天怎么用（T080-C05）

```
启动服务  →  npm run start
打开      →  http://127.0.0.1:3000
记东西    →  Inbox 输入框，Ctrl+Enter 提交
停止      →  在服务窗口按 Ctrl+C
```

就这四步。日常流程里**没有** `npm ci`、`npm install`、`npm run build`、`npx playwright install`，
也不需要在设置页重新输入 Key。当你发现自己每天要跑上面任何一条时，那说明出了问题，
应该去看第 7 节而不是把它当成常规步骤。

升级代码（拉取新版本）时才需要：

```
npm ci  →  npm run build  →  npm run start
```

## 7. 备份（用之前先会这个）

日常备份走应用内的**逻辑导出**：设置页「备份与恢复」→「导出整库（JSON）」。
它可读、可校验，而且**不会把你的 Key 一起带走**。

文件级备份（复制 `brain.db`）**必须先停服**，否则 WAL 里最近的提交不在主文件里，
你备份到的是一份缺数据的旧副本。完整步骤（含一致性检查与损坏处理）见
[backup-recovery.md](backup-recovery.md)。

排错前先做一次备份，是这本手册里优先级最高的纪律，理由见下一节。

## 8. 出问题的排错顺序（T080-R06）

按顺序看，**不要跳步**，也不要一上来就重装：

1. **版本**：`node -v` 是否 24.15–24.x？见第 2 节。
2. **端口**：3000 是否被占用？`npm run doctor` 会报出占用者的 pid，见第 10 节 C4。
3. **路径**：命令里的路径含空格/中文时加引号了吗？`BRAIN_DATA_DIR` 指向的是你以为的那个目录吗？
   `node scripts/inspect-data.mjs --data-dir .\.data` 会先打印它读的**是哪个目录**。
4. **权限**：工程目录与数据目录是否可写？预检的 `writableDirectory` 就是这一项。
5. **依赖**：`npm ls --depth=0` 是否有缺口？只有到这一步才考虑重装依赖，且用 `npm ci`。
6. **应用错误**：看服务窗口的输出与设置页的**诊断面板**（它会报告数据目录、schema 版本、
   渲染尺寸等）。

详细的分症状排查见 [common-failures.md](common-failures.md)。

> **绝对不要**为了让它启动，删除 `.data` 或 `brain.db`。那是把唯一的一份资料丢掉，
> 而且**启动失败通常根本不是数据库引起的**——删掉之后你既没修好问题，也没了数据。
> 本仓库有 T080-C06 在盯着这条纪律（手册文案与 `doctor.mjs` 两侧同时断言）。

## 9. 与 `cmd.exe` 的差异

本手册用 PowerShell。若你偏好 `cmd.exe`：

| 事项 | PowerShell | cmd.exe |
| --- | --- | --- |
| 设临时环境变量 | `$env:APP_PORT = "3100"` | `set APP_PORT=3100` |
| 多条命令串联 | `npm ci ; npm run build` | `npm ci && npm run build` |
| 中断服务 | `Ctrl+C` | `Ctrl+C` |

`npm run …` 这类脚本本身跨平台，两种 shell 都能用；**只有设置环境变量的语法不同**。
本仓库的 `package.json` 里没有任何 `FOO=bar command` 形式的脚本（T004-C03 在检查这一点），
所以不存在"只有某个 shell 能跑"的脚本。

## 10. 具体症状速查

详细的排查手册在 [common-failures.md](common-failures.md)，这里是几个高频的：

| 编号 | 症状 | 先做这个 |
| --- | --- | --- |
| C2 | `node -v` 显示旧版本 / 与 `where.exe node` 不一致 | 关掉这个终端，**重开一个**再试；PATH 变更只对新终端生效 |
| C3 | `npm ci` 或浏览器下载失败 | 先分清是 registry（npm）还是 CDN（Chromium），见第 4 节与 common-failures 第 2 节 |
| C4 | `STARTUP_FAILED: 127.0.0.1:3000 已被占用` | `npm run doctor` 看占用者 pid，只关那一个，**不要 `taskkill` 所有 node** |
| C6 | 启动失败，想"清一下重来" | **先备份**（第 7 节），再看 [common-failures.md](common-failures.md) 第 1 节 |

## 11. 本手册未验证的部分

- **macOS / Linux**：未在本机执行，不作兼容性声明。
- **`cmd.exe`**：第 9 节是命令等价性说明，未逐条实跑。
- **真实模型连接**：需要你自己的 Key，属 `blocked`（T042），不在本手册范围内。
- **`sqlite3.exe` 命令行工具**：可选路径，未纳入自动化测试（见 backup-recovery 第 7 节）。
- **企业代理下的完整安装演练**：本机没有代理环境，只验证了"代理/CA/TLS 变量会被诊断出来"
  这一层（`probeNetworkEnv`），没有在真实代理后跑通整条安装。
