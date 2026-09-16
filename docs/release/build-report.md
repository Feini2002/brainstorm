# 生产构建报告（T081-C01 / C02 / C04）

本文件记录**实际执行**的结果。命令、退出码与路径均为本机真实输出；未执行的项目在第 6 节单独列出。

## 1. 环境

| 项 | 值 |
| --- | --- |
| 系统 | Windows 10.0.22631（x64） |
| Shell | PowerShell 7.6.3 |
| Node | `v24.18.0`（`C:\Program Files\nodejs\node.exe`） |
| npm | `11.16.0` |
| Next.js | 16.3.5（`next build` + `next start`） |
| 工程路径 | `C:\Users\123235\Desktop\个人知识库`（**含中文、不含空格**） |
| 干净构建目录 | `%LOCALAPPDATA%\Temp\feini-t081-clean`（用 `git archive HEAD` 解包，无 `node_modules`、无 `.next`、无 `.data`） |

干净目录由提交内容单独解出，不是复制工作树：

```powershell
$dst = "$env:LOCALAPPDATA\Temp\feini-t081-clean"
New-Item -ItemType Directory -Path $dst -Force | Out-Null
git archive HEAD -o "$dst\tree.tar"
tar -xf "$dst\tree.tar" -C $dst
Remove-Item "$dst\tree.tar"
```

解出后实测：**653 个文件**，无 `node_modules` / `.next` / `.data`。据此可判定 C01 的「不依赖旧 node_modules 或隐藏环境文件」成立——那些东西根本不在解出的树里。

## 2. 干净目录的完整检查链（T081-C01）

锁文件 SHA-256 为 `dbb524a21acfec1f8f248b4efcf100e815a6bbacdc9f5a98d074c9b6a952b1f5`（252944 字节，lockfileVersion 3，688 条目）。

| # | 命令 | 退出码 | 耗时 |
| --- | --- | --- | --- |
| 1 | `npm ci --no-audit --no-fund` | `0`（557 包） | 19.0s |
| 2 | `npm run contracts` | `0` | 0.6s |
| 3 | `npm run lint` | `0` | 8.7s |
| 4 | `npm run typecheck` | `0` | 7.4s |
| 5 | `npm test` | `0`（83 文件 / **1085 例**） | 53.4s |
| 6 | `npm run build` | `0` | 18.8s |
| 7 | `npm start` + 真实 API 读写 | `0`（见第 3 节） | — |

`npm ci` 在本机首次干净安装时退出码 0、输出 557 包，未使用 `--force`、未使用 `--legacy-peer-deps`、未关闭 TLS 校验。

`npm run build` 的路由清单（节选）：`ƒ /api/*` 全部为 Dynamic（Node 运行时），`○ /inbox` `/library` `/graph` `/mindmap` `/flow` `/settings` 为预渲染外壳。**没有任何静态导出**（`next.config.ts` 里没有 `output: 'export'`），因此 C02 要求的「不是只有静态页面」由路由类型本身即可判定，并由第 3 节的真实读写复核。

### 2.1 本次干净构建暴露并修掉的缺陷

干净目录第一次跑时 `npm test` **exit 1**，两个文件红、3 例失败，而同一提交在开发者的工作树里是绿的：

| 失败用例 | 现象 | 根因 |
| --- | --- | --- |
| `tests/contracts/guard.test.ts` T012-C02 ×2 | 在 `.gitignore` 里找不到独立的 `/.data/` 条目 | 仓库没有 `.gitattributes`，本机 `core.autocrlf=true`：index 里的 blob 是 LF，`git archive`/重新 checkout 却写成 CRLF，而这两条断言是按文本内容精确匹配（`original.replace('/.data/\n','')`） |
| `tests/unit/doctor.test.ts` T080-R01 | `docs/operations/windows-setup.md` 里匹配不到任何 ```powershell 代码块 | 同一原因：正则里的 ```powershell\n``` 在 CRLF 文本上不匹配 |

修法是新增 `.gitattributes`（`* text=auto eol=lf`），把检出字节钉死等于提交字节；随后 `git add --renormalize .` 是空操作，说明仓库里既有的 blob 本来都是 LF。**没有**改测试去迁就 CRLF，也**没有**依赖只对本机生效的 `core.autocrlf=false`。

修复后重新解包，`.gitignore` / `windows-setup.md` / `common-failures.md` / `package.json` 的 CR 计数全部为 0，检查链全绿（即上表）。

## 3. 生产启动与真实 API（T081-C02）

启动方式与默认口径一致：`scripts/start-local.mjs` 先做预检，再用 `next start --hostname 127.0.0.1 --port <APP_PORT>` 拉起。

```powershell
$env:APP_HOST='127.0.0.1'; $env:APP_PORT='3100'; $env:APP_ORIGIN='http://127.0.0.1:3100'
$env:BRAIN_DATA_DIR="$env:LOCALAPPDATA\Temp\t081-acceptance-data"
npm start
```

启动日志：`▲ Next.js 16.3.5` / `✓ Ready in 147ms`。实测监听状态只有一条回环地址：

```
TCP    127.0.0.1:3100    0.0.0.0:0    LISTENING    51872
```

`netstat` 里 `0.0.0.0:3100` 的条目数为 **0**，即没有对外网卡开放（T081-R02）。

### 3.1 真实读写（不是静态页面）

驱动程序走应用自己的 HTTP 面，并用一条独立的只读 SQLite 连接复核落盘，共 11 项断言全 PASS：

| 断言 | 实测 |
| --- | --- |
| `GET /api/session` 200 并返回进程内 token 与回环 origin | `origin=http://127.0.0.1:3100` |
| 伪造 token 被拒 | `403 SESSION_EXPIRED` |
| `POST /api/items` 写入 | `201`，返回 `id=647d33d1-90d7-4024-b6dc-0d3abd6de4cd` |
| `GET /api/items?q=…` 读回 | `200`，`count=1`，命中同一 id |
| 独立只读连接查 SQLite | `row={"id":"647d…","raw_text":"T081-C02 生产构建写入 …","status":"raw"}` |
| `POST /api/items/{id}/organize` 无 Key 时的应答 | `422 MODEL_NOT_CONFIGURED`（**确定的领域错误，不是 500 页面**） |
| `GET /inbox` | `200`，HTML 14492 字节 |
| 页面是构建产物 | 无 `__nextjs_original-stack-frame` / `webpack-hmr` / `react-refresh`，且含 `/_next/static/` 引用 |

第 5 行是关键的一条：它证明数据真的进了 Node 进程写的 SQLite 文件，而不是服务端内存或假响应。

### 3.2 重启后数据抽样

停掉服务（只结束已核对的 PID 树），再用同样参数重启，然后重新走 HTTP 读回：

```
sessionId after restart = 5c9dfdc862cd923f（token 换新是预期的：进程内随机）
条目数 = 1
  647d33d1-… | T081-C02 生产构建写入 … | raw
```

重启过程中数据目录始终保留 `brain.db` / `brain.db-wal` / `brain.db-shm`，条目跨重启存活。

### 3.3 启动器拒绝被占用的端口

在 3100 被占用时执行 `node scripts/start-local.mjs start`：

```
STARTUP_FAILED: 127.0.0.1:3100 已被占用。请关闭已有实例，或同时修改 APP_PORT 与 APP_ORIGIN 后重试。
```

退出码非 0，且**没有**让 Next 自行挑选随机端口（那会破坏同源检查）。

## 4. 检查职责独立（T081-C04）

用例要求「引入 lint 错误再 build，lint 失败必须被记录，不因 build 成功被忽略」。第一次尝试用未使用变量，`@typescript-eslint/no-unused-vars` 在本仓库是 **warning**，`eslint` 退出码 0 —— 这条路径不成立，故改用项目自有的边界规则注入。

在 `src/domain/t081LintProbe.ts` 里写入 `import { useState } from 'react'`（`src/domain` 是纯层，`eslint.config.mjs` 的 `feini/domain-purity` 将其列为 **error**）。先 `Select-String` 打印落地行号：

```
> src\domain\t081LintProbe.ts:9:import { useState } from 'react';
```

同一棵树上：

| 命令 | 退出码 | 输出 |
| --- | --- | --- |
| `npm run lint` | **1** | `error  'react' import is restricted from being used by a pattern. src/domain 只能是纯类型、schema 与无副作用函数（T003-R01）。  no-restricted-imports` |
| `npm run build` | **0** | 构建照常成功 |
| `npm run typecheck` | **0** | 类型检查照常成功 |

即：**build 成功并不能替代 lint**，检查链的每一环各自独立地有牙齿。探针文件随即删除，未提交。

## 5. 干净目录不依赖前一次 `.next`（T081-C01 加强）

把干净目录里的 `.next` 改名后直接跑检查链：

| 命令 | 退出码 |
| --- | --- |
| `npm run typecheck`（`next typegen && tsc --noEmit`） | `0` |
| `npm run build`（重建 `.next`） | `0`，`.next\BUILD_ID` 重新出现 |

即类型生成与构建都不需要上一轮构建的残留输出。

## 6. 数据排除（T081-C03）

| 检查 | 实测 |
| --- | --- |
| `.next` 下是否有 `brain.db` / `.data` / `.write-probe` | **0 个** |
| `.next` 体积 | 154 MB |
| `.next` 的 js/json 文件里出现 `brain.db` 字面量的次数 | **0** |
| 发布 zip（`git archive HEAD`）条目数 / 体积 | 776 条 / 3,304,390 字节 |
| zip 里匹配 `brain.db` / `.data` / `.env` / `secret` / `api_key` / `node_modules` / `.next` 的条目 | 只有三份**源码与文档**（`src/server/repositories/secrets.ts`、`docs/04_tasks/G2/T029_secret_storage.md`、`tests/security/secret-*.test.ts`）与一份 `docs/04_tasks/G6/T075_*`；**没有**数据库文件、没有 `.env`、没有 `node_modules`、没有 `.next` |

数据库文件不在发布材料里，是因为 `git archive` 只导出提交内容，而 `.data/`、`tests/e2e/.data*/`、`node_modules`、`.next` 都在 `.gitignore` 内（该覆盖由 `tests/contracts/guard.test.ts` 与 `npm run contracts` 双重断言）。

## 7. 依赖锁定与离线行为（T002-C02 / C05 复跑）

### 7.1 `package.json` 与锁文件不一致时必须明确失败

在临时目录里把 `devDependencies.vitest` 改成 `3.0.0`（registry 上真实存在、但锁文件没解析过的版本），再 `npm ci`：

```
npm error code EUSAGE
npm error `npm ci` can only install packages when your package.json and package-lock.json or
npm error npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.
npm error Invalid: lock file's vitest@4.1.11 does not satisfy vitest@3.0.0
```

退出码非 0，锁文件逐字节未变，`node_modules/vitest` 未被创建。

> 本次顺带修掉了这条用例的脆弱写法：它原本把 `lock file's vitest@3.2.7` 写死在断言里，于是升级一个依赖就会变成「先改测试」。现改为从 lockfile 读实际锁定版本再拼正则，断言强度不变。

### 7.2 `npm ci` 缺少下载材料时保留锁文件

在一个不含 `node_modules` 的临时目录里，用**空缓存**加 `--offline` 执行（等价于「依赖缓存不完整且网络不可用」，不需要拔网线或破坏本机安装）：

| 断言 | 实测 |
| --- | --- |
| 退出码非 0 | `exit=1`，`npm error code ENOTCACHED` |
| 锁文件逐字节未变 | `true` |
| 未生成真实依赖 | `true`（无 `node_modules/next`） |
| 报错提到缺少下载材料 | `true`（`request to https://registry.npmjs.org/zustand failed: cache mode is 'only-if-cached' but no cached response is available.`） |

失败路径**没有**顺手改写锁文件，也没有为了绕过下载错误改掉已锁定架构。

## 8. 复现命令清单

```powershell
# 干净目录（T081-C01）
$dst = "$env:LOCALAPPDATA\Temp\feini-t081-clean"
if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
New-Item -ItemType Directory -Path $dst | Out-Null
git archive HEAD -o "$dst\tree.tar"; tar -xf "$dst\tree.tar" -C $dst; Remove-Item "$dst\tree.tar"
Set-Location $dst
npm ci --no-audit --no-fund
npm run contracts; npm run lint; npm run typecheck; npm test; npm run build

# 生产启动与真实读写（T081-C02）
$env:APP_HOST='127.0.0.1'; $env:APP_PORT='3100'; $env:APP_ORIGIN='http://127.0.0.1:3100'
$env:BRAIN_DATA_DIR="$env:LOCALAPPDATA\Temp\t081-acceptance-data"
npm start            # 另开一个终端
netstat -ano | Select-String ':3100\s+.*LISTENING'   # 期望只有 127.0.0.1

# 数据排除（T081-C03）
git archive HEAD -o "$env:LOCALAPPDATA\Temp\t081-release.zip"

# 依赖锁定与离线（T002-C02 / C05）
npm ci --ignore-scripts --no-audit        # 在与 package.json 不一致的临时目录里必须 EUSAGE
npm ci --offline --cache=<空目录>          # 必须 ENOTCACHED，锁文件不变
```

## 9. 未执行 / 未覆盖

| 项 | 状态 | 原因 |
| --- | --- | --- |
| macOS / Linux 上的同一条链 | **未执行** | 本机只有 Windows；本报告的全部数字仅代表该环境 |
| 真实模型端到端验收 | **未执行** | T042 阻塞（无 Key）；`organize` 的实测结果是 `422 MODEL_NOT_CONFIGURED` |
| 真机断网（拔网线 / 关 Wi-Fi） | **未执行** | 用 `--offline` + 空缓存复现同一条件，未动本机网络设置 |
| `npm ci` 在一次全新容器里 | **未执行** | 干净目录是本机用户账号下的临时目录，仍与本机共享 npm 缓存路径 |
| Playwright 浏览器二进制下载 | 已满足 | 本机已有 Chromium，`npm test` 的 `browser` project 通过；下载失败路径见 `docs/operations/common-failures.md` |
| 发布 zip 的签名 / 校验和发布 | **未执行** | 本任务不承诺分发渠道；本报告只证明 zip 内容里没有个人数据 |
