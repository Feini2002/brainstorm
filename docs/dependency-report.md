# 依赖解析、锁定与下载报告（T002）

本文件记录实际安装结果。命令与环境为本机真实执行，未执行事项单独标明。

## 1. 环境与锁文件

| 项 | 值 |
| --- | --- |
| Node | `v24.18.0`（`C:\Program Files\nodejs\node.exe`，满足 24.15 ≤ v < 25） |
| npm | `11.16.0` |
| 平台 | `win32 x64` |
| 工程路径 | 含中文、不含空格 |
| `package-lock.json` | lockfileVersion 3，235761 字节，695 个条目 |
| 锁文件 SHA-256 | `18953226a5a658881afc28adb947ef183762b9429a56a54bcfefb8e85ea4ff11` |
| `.npmrc` | `save-exact=false`、`fund=false`、`audit=true` |

安装命令：`npm install`（首次解析并生成锁文件）。

首次安装过程出现多次 registry 连接停滞（大体积 metadata 请求长时间无进展），未使用 `--force` 或 `--legacy-peer-deps`，也未关闭 TLS 校验；重试时降低并发（`maxsockets`）并保持默认安全设置，最终以退出码 0 完成。

## 2. 精确版本与许可（`npm ls --depth=0` 实测）

### 运行依赖

| 包 | 版本 | 许可 | 声明 engines | peerDependencies |
| --- | --- | --- | --- | --- |
| `next` | 16.3.5 | MIT | `>=20.9.0` | `react`/`react-dom` `^18.2.0 \|\| ^19.0.0`） |
| `react` | 19.2.8 | MIT | `>=0.10.0` | — |
| `react-dom` | 19.2.8 | MIT | — | `react ^19.2.8` |
| `zod` | 4.6.5 | MIT | — | — |
| `@xyflow/react` | 12.11.6 | MIT | — | `react`/`react-dom` `>=17`；`@types/react`/`@types/react-dom` 可选 |
| `@dagrejs/dagre` | 2.0.4 | MIT | — | — |
| `markmap-lib` | 0.18.12 | MIT | — | `markmap-common *` |
| `markmap-view` | 0.18.12 | MIT | — | `markmap-common *` |
| `mermaid` | 11.17.2 | MIT | — | — |
| `dompurify` | 3.4.15 | MPL-2.0 OR Apache-2.0 | — | — |
| `server-only` | 0.0.1 | MIT | — | — |

### 开发依赖

| 包 | 版本 | 许可 | 声明 engines | peerDependencies |
| --- | --- | --- | --- | --- |
| `typescript` | 5.9.3 | Apache-2.0 | `>=14.17` | — |
| `eslint` | 9.39.5 | MIT | `^18.18.0 \|\| ^20.9.0 \|\| >=21.1.0` | `jiti`（可选） |
| `eslint-config-next` | 16.3.5 | MIT | — | `eslint >=9`、`typescript >=3.3.1`（可选） |
| `tailwindcss` | 4.3.3 | MIT | — | — |
| `@tailwindcss/postcss` | 4.3.3 | MIT | — | — |
| `vitest` | 3.2.7 | MIT | `^18 \|\| ^20 \|\| >=22` | 多项均可选 |
| `@playwright/test` | 1.63.0 | Apache-2.0 | `>=20` | — |
| `@types/node` | 24.13.4 | MIT | — | — |
| `@types/react` | 19.3.0 | MIT | — | — |
| `@types/react-dom` | 19.3.0 | MIT | — | `@types/react ^19.3.0` |

未安装任何第三方替代品来顶替 Node 内置模块（`crypto`、`fs`、`path`、`sqlite` 均使用 `node:` 前缀，T002-R03）。

`@xyflow/react` 自带类型，未重复安装 `@types` 包；`@dagrejs/dagre` 2.0.4 自带声明文件，无需额外类型包。

## 3. 网络与本地资源

运行期不从 CDN 动态拉取脚本或字体（T002-R05）：`next/font` 的 `Geist` 在构建时下载并自托管；ReactFlow、Dagre、Markmap、Mermaid、DOMPurify 全部来自 `node_modules`。

Playwright Chromium 二进制与 npm 包分离下载，作为独立步骤执行：

```sh
npx playwright install chromium
```

该步骤状态见文末“未执行项”。

## 4. 许可证登记

全部直接依赖许可为 MIT，例外为 `dompurify`（MPL-2.0 或 Apache-2.0 双许可）、`typescript` 与 `@playwright/test`（Apache-2.0）。无 GPL/AGPL 类传染性许可，允许闭源分发。

## 5. 安全审计（`npm audit`）

```
vulnerabilities: {"info":0,"low":0,"moderate":2,"high":0,"critical":0,"total":2}
@vitest/mocker  moderate  2.1.0 - 4.1.10  fixAvailable: vitest 5.0.0 (SemVer major)
vitest          moderate  2.1.0-beta.1 - 4.1.10  fixAvailable: vitest 5.0.0 (SemVer major)
```

| 受影响包 | 严重度 | 影响范围 | 处置 |
| --- | --- | --- | --- |
| `vitest` / `@vitest/mocker` | moderate | 仅开发测试工具，不进入生产构建产物，也不随应用分发 | 不执行 `npm audit fix --force`；等待 Vitest 5 稳定后单独评估并回归 |

依据 T002-R06，未使用 `npm audit fix --force` 自动跨主版本升级。升级 Vitest 主版本会改变测试运行器行为，需要在测试套件就绪后单独处理。

## 6. 复现（干净环境）

```sh
npm ci
```

`npm ci` 依赖锁文件与 `package.json` 完全同步，用于验证原依赖树可复现；不得通过删除 `package-lock.json` 再 `npm install` 来“修复”安装问题（T002-R04）。

## 7. 未执行项

| 项目 | 状态 | 原因 |
| --- | --- | --- |
| `npm ci` 干净重装验证 | 未执行 | 首次 `npm install` 已耗时较长，本机 registry 访问不稳定；锁文件与 `package.json` 由同一次解析产生。将在 G6 生产审计阶段安排重装验证 |
| `npx playwright install chromium` | 未执行 | 浏览器二进制下载体积大，留待 T011/T078 测试环境搭建时执行 |
| `npm ls --depth=0` 与锁文件哈希 | 已执行 | 见第 1、2 节实测表 |
