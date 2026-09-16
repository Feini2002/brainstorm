# 常见故障排查

本文件是 **T080 的排错手册**，与 [windows-setup.md](windows-setup.md) 配对：那边讲怎么装和怎么每天用，
这边讲坏掉时按什么顺序查。所有命令在本机 Windows + PowerShell 7.6.3 下实际执行过，
记录见 [`implementation/progress/evidence/G6.md`](../../implementation/progress/evidence/G6.md) 的 T080 一节。

> **开始之前，先记住一条**：排错的第一动作是**保留证据**，不是"清干净重来"。
> 具体来说：先跑一次备份或至少**复制**整个数据目录，再动手。原因见第 1 节。

## 1. 铁律：不要把「删掉重来」当修复（T080-C06）

启动失败时最容易做的动作是删掉 `.data` 或 `brain.db` 再启动。

> **不要删除 `.data`，不要删除 `brain.db`，也不要清空数据目录。**

理由有三条：
- 那是**唯一的一份资料**。删掉之后你既没修好问题，也没了数据。
- 启动失败的原因绝大多数**与数据库内容无关**：端口被占、Node 版本不对、路径不对、
  依赖没装完、构建产物不存在。删库对这些一条都不解决。
- 就算真的是数据库损坏，删掉也是**最坏的解法**：损坏的文件正是唯一可能被抢救的对象。

**正确的第一步**，在任何删除动作之前：

```powershell
# 1) 先确认你看的是哪个目录（"数据不见了"最常见的原因是 BRAIN_DATA_DIR 指错了地方）
node scripts/inspect-data.mjs --data-dir .\.data

# 2) 保留证据：把整个数据目录复制到一个安全位置
Copy-Item -Recurse -Force .\.data "$env:TEMP\feini-keep-$(Get-Date -Format yyyyMMdd-HHmmss)"
```

完整备份与损坏处理见 [backup-recovery.md](backup-recovery.md)。

**另外**：不要为了"修复"而改变全局状态。具体禁止：

- ❌ 关掉 TLS 证书校验（把 `NODE_TLS_` 开头的那个"拒绝未授权"变量设成 `0`，
  或执行 `npm config set strict-ssl false`）。
  这不是修复，是把"验证失败"变成"看不见验证失败"，而且它会成为留在机器上的调试残留。
  预检会**专门报出**这个变量被设置过（报告里的 `networkEnvironment.tlsVerificationDisabled`）。
- ❌ 以管理员身份运行整个项目。本应用监听回环地址、把数据写在自己的目录里，**不需要管理员权限**；
  用管理员跑只会让文件属主变成管理员，之后普通用户反而写不进去。
- ❌ 执行来路不明的"一键修复"脚本。我们不知道它做了什么，而你的资料就在这台机器上。

## 2. 下载失败：先分清是哪条通道（T080-R05 / C03）

「装不上」是一个笼统的说法。先分清你卡在哪一条通道，因为原因和处理方式完全不同：

| 现象里的关键字 | 通道 | 大概率原因 |
| --- | --- | --- |
| `ETIMEDOUT`、`EAI_AGAIN`、`ECONNREFUSED`、`UNABLE_TO_VERIFY_LEAF_SIGNATURE`、`SELF_SIGNED_CERT_IN_CHAIN` | npm registry（`registry.npmjs.org`） | 代理未配置 / 企业 CA 未信任 |
| `ENOTCACHED`、`no cached response is available` | npm 缓存 | 离线且缓存里没有下载材料 |
| `Executable doesn't exist`、`npx playwright install` 的提示 | Playwright CDN（`cdn.playwright.dev`） | 浏览器二进制没下（**与 npm 无关**） |
| `EUSAGE`、`in sync` | 锁文件 | `package.json` 与 `package-lock.json` 不一致（**不要**删锁文件） |

### 2.1 先看现在有什么设置（只读）

```powershell
npm config get registry
npm config get proxy
npm config get https-proxy
npm config get cafile
npm config get strict-ssl
```

本机实测（无代理环境）：registry 是 `https://registry.npmjs.org/`，其余为 `null`，`strict-ssl` 为 `true`。
`strict-ssl = true` **是正确状态**，不要为了绕过证书错误把它关掉。

再看应用层诊断（只报变量名，**不打印值**，因为代理 URL 里可能带账号密码）：

```powershell
npm run doctor
```

报告里的 `networkEnvironment` 会告诉你三件事：哪些代理变量被设置了、是否有自签 CA 被指定、
以及是否有人关掉了 TLS 校验。本机干净环境实测：

```json
"networkEnvironment": {
  "proxyConfigured": [],
  "caConfigured": [],
  "tlsVerificationDisabled": false,
  "npmEscapeHatch": []
}
```

### 2.2 企业代理 / 自签 CA 的正确处理

**代理**：让 npm 知道代理地址（下面两行是示例，把地址换成你们公司的）：

```powershell
npm config set proxy "http://proxy.example.com:8080"
npm config set https-proxy "http://proxy.example.com:8080"
```

**自签 CA**：正确做法是**信任那张证书**，而不是关掉校验。把企业的根证书放进系统的"受信任的根证书
颁发机构"，或给当前会话指定 PEM 文件：

```powershell
$env:NODE_EXTRA_CA_CERTS = "C:\certs\corp-root.pem"
npm ci
```

注意 `NODE_EXTRA_CA_CERTS` 只对**当前这个窗口**有效；长期使用应当在系统证书库里安装根证书，
而不是把它写进脚本或提交进仓库。

### 2.3 浏览器下载失败

浏览器来自 Playwright 自己的 CDN，**不受 npm 代理设置影响**（npm 的 proxy 配置只作用于 npm）。
先确认它会去哪、去哪拿：

```powershell
npx playwright install --dry-run chromium
```

本机实测输出包含安装位置与下载地址：

```text
Chrome for Testing 153.0.8010.12 (playwright chromium v1243)
  Install location:    C:\Users\123235\AppData\Local\ms-playwright\chromium-1243
  Download url:        https://cdn.playwright.dev/builds/cft/153.0.8010.12/win64/chrome-win64.zip
```

- 如果公司网络只放行了 npm registry，`cdn.playwright.dev` 会被拦——这是**真实阻塞**，
  如实记录，而不是"依赖坏了"。
- 安装位置在 `%LOCALAPPDATA%`，**不需要管理员权限**；不需要把任何东西写进 `Program Files`。
- 浏览器缺失时的正确报错里会出现 `npx playwright install`。本仓库有 T002-C03 盯着这一点：
  空浏览器目录下启动必须失败，且报错必须给出安装命令。

### 2.4 锁文件不一致（`EUSAGE`）

报错长这样：

```text
npm error `npm ci` can only install packages when your package.json and package-lock.json
npm error ... lock file's vitest@3.2.7 does not satisfy vitest@3.0.0
```

这是**守卫在工作**，不是故障。处理方式取决于你是谁：

- 你是使用者，没有改过任何文件：说明工作区被外部改过。用 `git status` / `git diff` 看
  `package.json` 是否被人动过，改回去（`git checkout -- package.json package-lock.json`）再 `npm ci`。
- 你是开发者，刚刚**有意**改了 `package.json`：在提交前的开发流程里跑一次 `npm install`
  更新锁文件，然后一起提交。

**无论哪种情况都不要删掉 `package-lock.json`。** 删了之后 `npm install` 会装出一套当天
registry 上的新版本，你的构建从此不可复现。

## 3. 排错顺序：版本 → 端口 → 路径 → 权限 → 依赖 → 应用（T080-R06）

按这个顺序查。跳步的代价是你会花时间在"重装依赖"上，而问题出在别的终端里那个还在跑的进程。

### 3.1 版本

```powershell
node -v
where.exe node
```

`node -v` 必须是 24.15 及以上、主版本 24。`where.exe node` 列出多行说明 PATH 里有两个 Node。

### 3.2 端口

`STARTUP_FAILED: 127.0.0.1:3000 已被占用。请关闭已有实例，或同时修改 APP_PORT 与 APP_ORIGIN 后重试。`

这是**应用自己在启动前**探测出来的，退出码非 0，且**不会静默换到 3001**——换了端口会让书签
与来源校验一起失效，所以宁可明确失败。确认是谁占着（**只关那一个**）：

```powershell
# 应用预检直接给 pid（推荐）
npm run doctor
```

报告里的 `report.port` 会包含占用者 pid 与 `netstat` 的原始那一行。也可以自己查：

```powershell
netstat -ano | findstr ":3000"
```

本机实测输出（占座进程 pid `39972`）：

```text
  TCP    127.0.0.1:3457         0.0.0.0:0              LISTENING       39972
```

拿到 pid 之后**只结束那一个进程树**：

```powershell
taskkill /pid 39972 /T /F
```

本机实测：

```text
SUCCESS: The process with PID 42368 (child process of PID 39972) has been terminated.
SUCCESS: The process with PID 39972 (child process of PID 17160) has been terminated.
```

> **不要 `taskkill /IM node.exe /F`，也不要"结束所有 Node 进程"。**
> 那会一并杀掉其它项目的构建、编辑器里的 Node 插件、别的开发服务——它们的失败和你现在
> 排查的问题毫无关系，而且会让现场更难还原。永远先定位到 pid，再只关那一个。
>
> `/T` 是必要的：启动器会派生 `next start` 子进程，只关父进程会留下子进程继续占端口。

### 3.3 路径

- **含空格或中文的路径必须加引号**，否则 PowerShell 会把路径劈成多个参数。对照实测见
  [windows-setup.md](windows-setup.md) 第 2.1 节。
- **`BRAIN_DATA_DIR` 指向哪**：这是"我的数据不见了"最常见的真正原因。先让诊断脚本告诉你它读的是哪个目录：

```powershell
node scripts/inspect-data.mjs --data-dir .\.data
```

输出**第一行就是数据目录**（先给路径再给计数，因为计数的意义完全取决于读的是哪个目录）。
路径不存在时它也会明说，且**不会**创建一个空库来掩盖问题。

### 3.4 权限

```powershell
npm run doctor
```

报告里的 `writableDirectory` 是这一项：它会在工程目录里**真的写一个探针文件再删掉**，
而不是只看目录属性。失败时的提示包含具体错误原因。

数据目录不可写时，应用会**明确报错**（`无法创建数据目录 …` / `数据目录不可写 …`），
不会悄悄换到某个临时目录去存你的资料。

### 3.5 依赖

```powershell
npm ls --depth=0
```

有缺口才考虑重装，且用 `npm ci`（第 3.3 节 / T080-R02）。看到 `--force` 之类的建议时先停一下，
读那条 peer 约束，不要直接照做（第 5 节）。

### 3.6 应用

到这里才是应用自身的问题。看两处：

1. **服务窗口的输出**：`PREFLIGHT_FAILED: …` 是预检失败（附带 JSON 报告），
   `STARTUP_FAILED: …` 是启动器失败（端口、地址不一致）。
2. **设置页的诊断面板**：它报告数据目录、schema 版本、渲染尺寸、已启用能力，
   且有一条可以整段复制的摘要（**已做字段白名单，不含 Key 与原文**）。
   另外 `GET /api/diagnostics` 是只读的，唯一写动作是一次 `BEGIN IMMEDIATE` + `ROLLBACK` 的
   写锁探测。

`node scripts/doctor.mjs` 的完整报告也会写一份到 `implementation/progress/runtime-report.json`
（已被 `.gitignore` 覆盖）。想关掉写盘用 `$env:FEINI_DOCTOR_RECORD = "off"`。

## 4. 端口 / 进程类症状速查（T080-C04）

| 现象 | 含义 | 做什么 |
| --- | --- | --- |
| `已被占用`（退出码 1） | 已有实例在监听该端口 | `npm run doctor` 拿 pid → `taskkill /pid <pid> /T /F` |
| `APP_ORIGIN … 与监听地址 … 不一致`（退出码 2） | 只改了一个变量 | 同时设置 `APP_PORT` 与 `APP_ORIGIN` |
| 按了 `Ctrl+C` 但端口仍被占 | 有残留子进程 | 用上面的 pid 流程处理；启动器本身会转发中断，正常不会留下 |
| 浏览器打开后请求被拒（403 / 跨站） | 地址漂移：浏览器访问的 origin 与服务端认为的不一致 | 检查 `APP_ORIGIN` 与地址栏是否一致 |

## 4b. 排错第一动作是保留证据，不是清空重来

这条是本节的核心，单独再写一遍，因为它与上面每一条症状都有关：

**在删除、覆盖或"重建"任何文件之前，先把现场固定下来。**

```powershell
# 1) 确认读的是哪个目录
node scripts/inspect-data.mjs --data-dir .\.data

# 2) 整目录复制到安全位置（含 -wal / -shm）
Copy-Item -Recurse -Force .\.data "$env:TEMP\feini-keep-$(Get-Date -Format yyyyMMdd-HHmmss)"
```

「重建」「清一下」「恢复默认」这些说法，落到磁盘上就是**删除唯一的一份数据副本**。
在确认问题与数据无关之前不要做，做之前必须先有副本。

## 5. 不要为了"让它过去"做的事

这一节的每一条都对应一个本仓库里真实的守卫用例，不是风格偏好：

| 不要做 | 为什么 | 谁在盯 |
| --- | --- | --- |
| 删 `package-lock.json` 重装 | 换掉整棵依赖树，构建不可复现 | T002-C02 |
| `--force` / `--legacy-peer-deps` | 把不兼容藏起来 | T002-C06 |
| 关 TLS 校验 / `strict-ssl false` | 把证书验证失败变成看不见 | T080-R05（预检会报出） |
| 用管理员跑整个项目 | 不必要的提权，且会把文件属主改掉 | T080-R05 |
| 执行网上找的"一键修复"脚本 | 来源不明，而资料在这台机器上 | T080-R05 |
| 删 `.data` / `brain.db` | 丢掉唯一数据副本，且通常解决不了问题 | T080-C06、T073 |
| 在服务运行时裸拷贝 `brain.db` | WAL 里最近的提交不在主文件里 | T073-R02 |
| `taskkill` 所有 node | 殃及其它项目 | T080-C04 |
| 在 `VACUUM INTO` / `.recover` 输出上直接覆盖原库 | 重写失败就同时失去数据与证据 | T073-R04 |

## 6. 数据相关症状

| 现象 | 先做这个 |
| --- | --- |
| 打开后是空库 | `node scripts/inspect-data.mjs --data-dir .\.data` 看**路径与计数**；多半是 `BRAIN_DATA_DIR` 指错 |
| 计数比记忆里少 | 同上，并检查是否有残留的 `brain.db-wal`（诊断会报告它是否含内容） |
| 诊断报 `damaged` / `unreadable` | **保留证据**：停服 → 整目录复制到只读位置 → 在副本上诊断。不要删原件 |
| 恢复备份时被拒 | 恢复只允许目标是**空知识库**；非空库会返回 `IMPORT_NONEMPTY`（409），校验阶段也会给出 `valid: false` |

导出与恢复的完整步骤、以及"恢复后必须校验什么"，见 [backup-recovery.md](backup-recovery.md) 第 5 节。

## 7. 排查完请交回现场

如果你要找人帮忙（或贴给 AI 助手），请提供：

1. `node -v`、`npm -v`、`where.exe node` 的输出；
2. `npm run doctor` 的完整 JSON（它**不含** Key、原文与完整敏感路径）；
3. `node scripts/inspect-data.mjs --data-dir .\.data` 的完整输出（它**不含**原文与 Key 值）；
4. 报错原文（整段复制，不要只截一句）。

设置页诊断面板里的可粘贴摘要是为这一步准备的：它逐字段白名单化，**不会**带出 Key、笔记原文
或完整 URL。

## 8. 本手册未覆盖

- **真实坏盘 / 物理损坏的人工恢复演练**：未执行（需要真实故障介质）。
- **企业代理后的完整安装**：未在本机复现，只验证了代理/CA/TLS 状态能被诊断出来。
- **非 Windows 平台**：命令以 PowerShell 写出，未在 macOS/Linux 上验证。
- **日志文件轮转**：当前没有实现（属具名缺口），因此也没有"日志撑满磁盘"的排查步骤。
