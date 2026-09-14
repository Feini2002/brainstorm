# 运行时预检报告（T001）

本文件记录 `scripts/doctor.mjs` 的实际行为与一次本机执行结果。它是运行证据，不代表应用功能已经验收。

## 1. 预检做什么

| 规则 | 检查内容 | 失败行为 |
| --- | --- | --- |
| T001-R01 | `process.versions.node` 必须为 24.x 且 minor ≥ 15，不接受 25 及未来主版本 | 退出码 `2`，说明实际主版本 |
| T001-R02 | 在系统临时目录建立小型 SQLite 文件，写入中文与 emoji 后关闭重开，比对读回值，随后删除探针目录 | 退出码 `1` |
| T001-R03 | 用 `path.resolve` 解析工程根，实际写入并删除一个探针文件 | 退出码 `1`，报告目录不可写 |
| T001-R04 | 读取 `package.json`（只读，不修改 registry、代理或证书） | 退出码 `1` |
| T001-R05 | 网络能力不参与通过/失败判定，报告中固定为 `network: "not-checked"` | 不因此失败 |
| T001-R06 | 不触碰真实 `.data`，不产生模型请求；每次运行只删除自己创建的临时目录 | — |

退出码约定：`0` 通过、`1` 本机能力失败、`2` Node 版本不受支持、`3` 用法错误。

## 2. 本机执行结果

- 命令：`node scripts/doctor.mjs`
- Node：`v24.18.0`（`C:\Program Files\nodejs\node.exe`）
- npm：`11.16.0`
- 平台：`win32 x64`
- 工程路径含中文、不含空格
- 退出码：`0`

```json
{
  "application": "feini-brain",
  "node": "24.18.0",
  "nodeSupported": true,
  "network": "not-checked",
  "sqlite": { "ok": true },
  "writableDirectory": { "ok": true },
  "projectFiles": { "ok": true, "npmProject": "feini-brain" }
}
```

机器可读副本同时写入 `implementation/progress/runtime-report.json`（可用 `FEINI_DOCTOR_RECORD=off` 关闭）。

## 3. 分支验证

版本门限以纯函数 `checkNodeVersion` 暴露，便于用例直接断言，无需安装旧 Node：

| 输入 | 结果 |
| --- | --- |
| `22.14.0` | 拒绝，提示需要 Node 24.15，并报告实际主版本 |
| `24.14.0` | 拒绝，提示 `>= 24.15.0` |
| `25.0.0` | 拒绝，不接受未来主版本 |
| `24.15.0` | 通过 |

## 4. 未执行项

| 用例 | 状态 | 原因 |
| --- | --- | --- |
| T001-C01 旧运行时 | 部分执行 | 本机仅有一个受支持 Node，版本分支由 `checkNodeVersion` 断言；未安装 Node 22 做整机验证 |
| T001-C03 目录只读 | 未执行 | Windows 下移除写权限需要管理员与 ACL 操作，未在本机安全复现 |
| T001-C04 无互联网 | 部分执行 | 网络未参与判定（`network: not-checked`）；未断网整机复跑 |
| T001-C06 双版本一致性 | 部分执行 | 本机只有单一 Node 安装；脚本输出实际解释器版本 |

其余用例（中文路径 SQLite 探针、重复运行只清理自身文件）由上述执行覆盖。
