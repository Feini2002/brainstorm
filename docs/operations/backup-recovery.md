# 备份、搬迁与损坏恢复

本文件是 **T073 的运维手册**：给出可复制执行的命令，以及每条命令为什么这样做。数据目录默认是仓库下的 `.data/`，可通过 `BRAIN_DATA_DIR` 指向其它位置。

> 本手册中的命令在 Windows / PowerShell 与 Node 24 下验证。凡是未在本机执行过的平台或步骤，都在文中明确标注「未验证」。

## 0. 先理解两种备份不是一回事

| | 逻辑导出（JSON） | 文件级备份（brain.db） |
| --- | --- | --- |
| 是什么 | 知识数据的交换格式 | SQLite 数据库的运维副本 |
| 含不含 Key | **不含**（白名单导出，见 `docs/03_contracts/10_backup_bundle.md`） | **可能含明文 Key** |
| 能否跨机器恢复 | 能，恢复后重新配置连接 | 能，但等于把原机器的秘密一起搬走 |
| 安全分享 | 可以（仍建议自己检查） | **不可以** |
| 适用场景 | 日常备份、迁移知识 | 整机克隆、排障 |

**推荐日常使用逻辑导出。** 它可读、可校验，且不会把你的模型凭据一起带走。

> **分享风险（T073-R06）**：`brain.db` 里的 `secrets` 表按设计保存明文 Key，因为它是本机单用户程序、需要把 Key 交给服务商使用。因此完整数据库文件**不是**可外发的诊断包。需要给别人看数据时，请用应用内的逻辑导出（**设置页「备份与恢复」→ 导出整库**，或直接调用 `GET /api/export`），不要直接发 `brain.db`。

## 1. 日常备份：逻辑导出

应用内导出（设置页「备份与恢复」区域，点「导出整库（JSON）」），或直接调用本机接口（需带本机会话令牌）：

```powershell
# 导出为 feini-brain-<UTC日期>.json
Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/export" -Headers @{ "X-Brain-Token" = $env:BRAIN_TOKEN } -OutFile ".\feini-brain-backup.json"
```

导出物**不含** API Key、设置与运行记录。恢复后需要重新配置模型连接，这是有意设计，不要期待备份帮你搬 Key。

## 2. 文件级备份：必须停服或使用 SQLite 一致接口

**不要**在服务运行时只复制 `brain.db`。WAL 模式下，最近提交可能仍在 `brain.db-wal`，主文件里并没有它们（T073-R02）。此时"备份成功"的其实是一份缺数据的旧副本。

### 2a. 先确认当前状态（只读）

```powershell
node scripts/inspect-data.mjs --data-dir .\.data
```

输出会明确告诉你 `brain.db-wal` 是否存在、是否含内容。看到

> 注意：-wal 文件包含尚未合并进主文件的提交。

就说明当前不能裸拷贝主文件。

### 2b. 方式一：停服后复制整个目录（推荐）

```powershell
# 1. 停止本地服务（Ctrl+C，或结束你启动的那个进程）
# 2. 复制整个数据目录，包含 brain.db / brain.db-wal / brain.db-shm
Copy-Item -Recurse -Force .\.data "$env:TEMP\feini-backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
# 3. 确认副本可读且完整
node scripts/inspect-data.mjs --data-dir "$env:TEMP\feini-backup-<时间戳>"
```

选择已停服时复制，是因为此时没有写入者，三个文件彼此一致。

### 2c. 方式二：停服后用 SQLite 官方一致备份接口

```powershell
# 仍然先停服；backup 命令在源库无写入时才能保证一致
sqlite3 .\.data\brain.db ".backup '$env:TEMP\feini-brain-consistent.db'"
node scripts/inspect-data.mjs --data-dir "$env:TEMP" --json
```

若本机没有 `sqlite3`，就退回方式一——复制整个目录同样安全，且不引入新依赖。**未验证**：本仓库的自动化测试覆盖的是脚本与文档约定，`sqlite3.exe` 本身未在 CI 中执行。

> **不要**用 `VACUUM INTO` 去覆盖你唯一的那份数据库：它是一次重写，如果中途失败，你失去的是原件（T073-R04）。

## 3. 搬迁数据目录（T073-R03）

顺序很重要：**先停服 → 复制整个目录 → 验证副本 → 再改配置 → 保留旧副本**。

```powershell
# 1. 停止服务

# 2. 复制到新位置（路径可以含空格与中文）
$target = "D:\我的 知识库数据\feini"
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Recurse -Force .\.data\* $target

# 3. 在新位置验证：能读、完整、计数与你预期一致
node scripts/inspect-data.mjs --data-dir $target

# 4. 改指向，再启动服务
$env:BRAIN_DATA_DIR = $target
npm run start:local
```

要点：

- **路径含空格与中文是支持的**，但如果旧的启动方式用了没加引号的命令行，会在这里出错。用引号包住路径。
- **旧副本先留着**，直到你在新位置确认数据与引用都正常。合并两台机器的知识属于后续能力，别在两个目录之间来回切换。
- 搬迁后 Key 不会跟随逻辑备份走；文件级搬迁则整个 `secrets` 表一起过来。

## 4. 数据库损坏怎么办

第一原则是**保留证据**（T073-R04）。

```powershell
# 1. 停止服务
# 2. 把整个数据目录复制到一个只读的安全位置（不要在原位置操作）
Copy-Item -Recurse -Force .\.data "$env:TEMP\feini-damaged-$(Get-Date -Format yyyyMMdd-HHmmss)"
# 3. 在副本上诊断
node scripts/inspect-data.mjs --data-dir "$env:TEMP\feini-damaged-<时间戳>"
```

诊断脚本会报告 `完整性检查：damaged` 或 `unreadable`，并以非零退出码结束。它**不会**修改原件，也不会尝试自动修复。

明确**禁止**的做法：

- ❌ **不要删除 `brain.db` 或整个 `.data` 目录**，然后期待"重新启动就好"。那是把唯一的数据副本丢掉。
- ❌ **不要删掉 `.data` 重新启动**作为默认排错建议。启动不会修复损坏，只会新建一个空库，让损坏的那份更难找。
- ❌ **不要在原文件上跑 `VACUUM`** 试图修复。它会重写文件，失败就同时失去数据与证据。
- ❌ **不要**用 `sqlite3 .\.data\brain.db ".recover"` 的输出直接覆盖原文件。要恢复到**新文件**，验证后再切换。

如果诊断显示损坏，先用逻辑导出恢复你能救回来的知识（若还能读），再考虑文件级修复。

## 5. 恢复后必须校验（T073-C06）

"能启动"不等于"恢复完整"。继续写入之前，先做三件事：

```powershell
# 1. 计数：条目 / 标签 / 关系 / 视图 是否符合备份时的预期
node scripts/inspect-data.mjs --data-dir .\.data

# 2. 抽样原文：打开几条含中文、emoji 与换行的笔记，逐字比对
#    （在应用里打开，或读逻辑备份 JSON 的 capturedText/rawText）

# 3. 引用：打开一张图，确认来源跳转指向真实原文；确认没有悬空关系
```

逻辑备份恢复走 `POST /api/import/validate` → `POST /api/import`，两步都要求目标是**空知识库**。校验阶段不写库；提交阶段整体在一个事务里，失败会完整回滚，已有设置与 Key 不变。

应用内路径：设置页「备份与恢复」→ 选择备份文件 → 校验这个文件 → 勾选"我确认当前知识库是空的" → 恢复到这个空知识库。
校验会把 counts、警告与逐条错误（带 JSON 路径）显示出来，并给出一份供提交时复核的文件哈希；
提交时服务端会重新校验该哈希与空库状态，所以"校验通过后又被改过的文件"会被拒绝。

## 6. 诊断脚本说明

`scripts/inspect-data.mjs` 的输出内容：

- 数据目录路径（**先**给出路径，因为"数据不见了"最常见的原因是 `BRAIN_DATA_DIR` 指错了地方）
- 主文件是否存在与大小
- `brain.db-wal` / `brain.db-shm` 是否存在与大小
- `PRAGMA integrity_check` 结果与 schema 版本
- 各表记录计数
- **是否**配置了模型 Key（只报告有无，永不打印值）
- 目录内的其它文件名

它**不会**：输出笔记原文、输出 Key 的值、创建文件、修改数据库、连接网络。

```powershell
# JSON 输出，便于脚本解析
node scripts/inspect-data.mjs --data-dir .\.data --json

# 退出码：0 = 正常或路径不存在；1 = 数据库损坏或无法读取
echo $LASTEXITCODE
```

## 7. 本手册未覆盖的部分

- **大型库分批备份**：当前上限是二十 MiB（`LIMITS.exportBytesMax`），超过会明确失败而不产生半截文件。分批导出属于后续能力。
- **非 Windows 平台**：命令以 PowerShell 写出。macOS/Linux 的等价步骤未在本机执行验证。
- **`sqlite3` CLI 的恢复命令**：需要用户自行安装，未纳入本仓库自动化测试。
