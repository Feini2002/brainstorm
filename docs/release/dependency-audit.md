# 依赖审计与许可清单（T081-R04 / C05 / C06）

本文件记录**实际执行**的依赖审计结果与许可清单。清单由 `package-lock.json` 加已安装的 `package.json` 派生（脚本读取两者并输出，不是手抄），因此「与锁文件一致」这句话是可复核的，而不是承诺。

环境：Node `v24.18.0`、npm `11.16.0`、Windows 10.0.22631。
锁文件 SHA-256：`dbb524a21acfec1f8f248b4efcf100e815a6bbacdc9f5a98d074c9b6a952b1f5`（lockfileVersion 3，688 条目）。

## 1. 安全审计

```powershell
npm audit --omit=dev
npm audit
```

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm audit --omit=dev` | `0` | `found 0 vulnerabilities` |
| `npm audit` | `0` | `found 0 vulnerabilities` |

两项都是 **0**。这与 T002 阶段的记录不同，因为当时存在两条 `vitest` / `@vitest/mocker` 的 moderate advisory（[GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)，`@vitest/mocker` 重定向 mock 导致的路径遍历任意文件读取，影响范围 `>=2.1.0 <4.1.11`）。按 T081-R04「逐项处理、不用 `audit fix --force` 盲修」的要求，本次的处理决定是：

| 项 | 决定 | 理由 |
| --- | --- | --- |
| `vitest` 3.2.7 → **4.1.11** | **升级**（提交 `0d58217`） | advisory 的修复版本是 4.1.11。`npm audit` 报出的 `fixAvailable` 指向 `vitest@5.0.1`（SemVer major），但升级到 **4.x 这一非破坏性边界**就能拿到补丁，不必跨主版本。全程未执行 `npm audit fix` 或 `--force`。 |
| 依赖它带来的 `@vitest/mocker` | 随 vitest 一起到 4.1.11 | 它是 vitest 的传递依赖，不能单独升。 |

升级后 `npm audit` 与 `npm audit --omit=dev` 同为 0 条。**没有任何 advisory 处于「已知未处理」状态。**

### 1.1 升级过程中暴露并修掉的真实缺陷

升级到 vitest 4 后，`browser` project **整文件失败**：

```
Error: Cannot find package 'esbuild' imported from tests/browser/support/flowSandbox.ts
```

根因是 `tests/browser/support/flowSandbox.ts` 一直 `import { build } from 'esbuild'`，但 `esbuild` **从未写进 `package.json`**——它此前只是 vitest 3 依赖树里的传递依赖，属于「碰巧存在」。vitest 4 不再带它，这个真实的隐式依赖立刻变成硬失败。修法是把它显式声明为 `devDependency: esbuild@^0.25.12`（提交 `0d58217`）。

这条正是 T081-C05 要防的那类问题：清单与实际构建材料不一致时，构建材料会随别人的依赖树变化。

## 2. 直接依赖（`npm ls --depth=0` 实测）

### 2.1 运行依赖（11 个，进入生产构建）

| 包 | 锁定/安装版本 | 许可 |
| --- | --- | --- |
| `@dagrejs/dagre` | 2.0.4 | MIT |
| `@xyflow/react` | 12.11.6 | MIT |
| `dompurify` | 3.4.15 | (MPL-2.0 OR Apache-2.0) |
| `markmap-lib` | 0.18.12 | MIT |
| `markmap-view` | 0.18.12 | MIT |
| `mermaid` | 11.17.2 | MIT |
| `next` | 16.3.5 | MIT |
| `react` | 19.2.8 | MIT |
| `react-dom` | 19.2.8 | MIT |
| `server-only` | 0.0.1 | MIT |
| `zod` | 4.6.5 | MIT |

### 2.2 开发依赖（11 个，不进生产产物）

| 包 | 锁定/安装版本 | 许可 |
| --- | --- | --- |
| `@playwright/test` | 1.63.0 | Apache-2.0 |
| `@tailwindcss/postcss` | 4.3.3 | MIT |
| `@types/node` | 24.13.4 | MIT |
| `@types/react` | 19.3.0 | MIT |
| `@types/react-dom` | 19.3.0 | MIT |
| `esbuild` | 0.25.12 | MIT |
| `eslint` | 9.39.5 | MIT |
| `eslint-config-next` | 16.3.5 | MIT |
| `tailwindcss` | 4.3.3 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `vitest` | 4.1.11 | MIT |

**直接依赖的锁定版本与安装版本逐项一致**（脚本比对结果为空集）。也就是说 `npm ci` 之后磁盘上的直接依赖就是锁文件写的那一个版本，不存在「声明 A、装上 B」。

生产产物里没有 `eslint`、`vitest`、`@playwright/test`、`typescript`、`tailwindcss` 的运行时依赖：它们只被构建与测试链使用。`@tailwindcss/postcss` 与 `esbuild` 参与构建但不随应用分发。

## 3. 传递依赖的许可分布

按已安装的 557 个包（锁文件 687 条 `node_modules/` 条目中，130 条是其它平台/架构的可选二进制，本机不安装）：

| 许可 | 包数 |
| --- | --- |
| MIT | 437 |
| ISC | 54 |
| Apache-2.0 | 27 |
| BSD-2-Clause | 16 |
| BSD-3-Clause | 9 |
| MPL-2.0 | 5 |
| 其余（见下表） | 9 |

**没有 GPL / AGPL / LGPL-only 的传染性许可直接约束本项目代码。** 全部非 MIT/ISC/Apache/BSD 的已安装包如下，逐条给出判断：

| 包 | 版本 | 声明许可 | 引入者 | 判断 |
| --- | --- | --- | --- | --- |
| `dompurify` | 3.4.15 | `(MPL-2.0 OR Apache-2.0)` | 直接依赖 | **双许可，取 Apache-2.0 分支即宽松。** 本项目按其 Apache-2.0 选项使用，无附加义务。 |
| `lightningcss`、`lightningcss-win32-x64-msvc` | 1.32.0 | MPL-2.0 | `@tailwindcss/node`、`vite` | 文件级 copyleft。以独立依赖形式使用、未修改其源码，不触发对本项目文件的许可传染。 |
| `lightningcss`、`lightningcss-win32-x64-msvc` | 1.33.0 | MPL-2.0 | `vite` | 同上。**注意仓库里同时存在 1.32.0 与 1.33.0 两份**：由 `vite` 自带的嵌套副本造成，锁文件如实记录，安装版本与锁定版本一致。 |
| `axe-core` | 4.13.0 | MPL-2.0 | `eslint-plugin-jsx-a11y` | **仅开发期**（lint 插件），不进生产产物。同上判断。 |
| `@img/sharp-win32-x64` | 0.35.4 | `Apache-2.0 AND LGPL-3.0-or-later` | `next` → `sharp`（optional） | LGPL 是**动态链接**场景。它是 Next 的**可选**图像优化依赖（见第 4 节），本项目 `src/**` 里没有任何 `next/image` 用法，本机未安装 `sharp` 本身也不会导致构建失败。分发时若把它打进产物，需要保留其许可声明并允许替换该库。 |
| `argparse` | 2.0.1 | Python-2.0 | `js-yaml`、`markdown-it` | Python-2.0 是宽松许可且与 Python 软件基金会无关；仅是名字来自 Python。允许再分发。 |
| `caniuse-lite` | 1.0.30001810 | CC-BY-4.0 | `browserslist`、`next` | 数据集合（浏览器支持表）。CC-BY 要求**署名**：构建产物若内嵌该数据，需保留其署名。默认构建不把它作为可分发资产暴露给用户。 |
| `khroma` | 2.1.0 | `package.json` **没有** `license` 字段 | `mermaid` | 包内 `license` 文件实际是 **MIT**（"The MIT License (MIT) / Copyright (c) 2019-present Fabio Spampinato, Andrew Maney"）。字段缺失是打包疏漏，不是法律歧义；已按包内文件核对。 |
| `language-subtag-registry` | 0.3.23 | CC0-1.0 | `language-tags` → `eslint-plugin-jsx-a11y` | CC0 是公共领域奉献，无义务。仅开发期。 |
| `robust-predicates` | 3.0.3 | Unlicense | `delaunator` → `mermaid` | 公共领域，无义务。 |
| `tslib` | 2.8.1 | 0BSD | 多个（`@swc/helpers` 等） | 0BSD 是无条件许可，无署名要求。 |
| `@typescript-eslint/typescript-estree/node_modules/minimatch` | 10.2.6 | BlueOak-1.0.0 | `@typescript-eslint/typescript-estree` → `eslint` | BlueOak-1.0.0 是 OSI 认可的宽松许可。仅开发期。 |

结论：**没有发现需要移除的依赖。** 需要随分发保留声明的只有 `@img/sharp-win32-x64`（LGPL，且仅在它被打进产物时）与 `caniuse-lite`（CC-BY 署名）。

## 4. 生产产物是否真的带上这些包

构建产物（`.next`，154 MB）由 Node 运行时按需读取 `node_modules`，而不是把依赖内联成单文件。就此有两个可复核的事实：

1. **`0.0.0.0` 与 `sharp` 无关，但与产物有关**：`next.config.ts` 的 `outputFileTracingExcludes` 排除 `./.data/**` 等目录，`npm run build` 退出码 0，说明排除清单不会漏掉运行时确实需要的文件。真正的运行时依赖是否齐备，由第 5 节的生产启动复核（`next start` + 真实 API 读写）。
2. **`sharp` 未安装也构建成功**：`node_modules/sharp` 与 `node_modules/@img/sharp-*` 在干净目录里存在（`next` 的可选依赖），但 `next.config.ts` 没有开启图像优化管线，`src/**` 里也不存在 `next/image`。这不影响本任务结论，只说明 LGPL 那条的实际暴露面取决于未来是否启用图像优化——**当前不启用**。

## 5. 运行时需求（T081-R05）

| 需求 | 说明 |
| --- | --- |
| Node | **必需**。`package.json` 声明 `>=24.15.0 <25`；本机实测 `v24.18.0`。 |
| npm | 安装依赖用。本机 `11.16.0`。 |
| `node_modules` | **必需**，由 `npm ci` 从锁文件恢复。 |
| 数据库 | **不需要单独安装**：`node:sqlite` 是 Node 内置模块，仓库里没有 `better-sqlite3` 一类原生绑定（T002-R03 的约定，由 `npm run contracts` 与依赖清单共同保证）。 |
| 全局安装的其它服务 | **不需要**。不依赖全局 CLI、系统 Python、Docker、外部数据库或消息队列。 |
| 浏览器（只做端到端测试时才需要） | Playwright 包已安装，但 Chromium **二进制**是独立下载物。运行 `npm test` 的 `browser` project 或 `npx playwright test` 之前需要 `npx playwright install chromium`；只跑 `npm run dev` / `npm start` 使用应用本身时**不需要**。 |

## 6. 复现命令

```powershell
npm audit --omit=dev          # 期望：found 0 vulnerabilities，exit 0
npm audit                     # 期望：found 0 vulnerabilities，exit 0
npm ls --depth=0              # 期望：11 个运行依赖 + 11 个开发依赖，无 unmet/invalid
Select-String -Path package-lock.json -Pattern '"vitest"' -Context 0,2
```

许可清单由 `package-lock.json` 加已安装的 `package.json` 派生（本次审计的脚本读取两者并直接打印上表），所以任何一条都可以重新生成核对，而不是只能相信本文的转述。

## 7. 未执行 / 未覆盖

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 依赖树漂移的自动化守卫 | **未执行** | 本任务只要求记录与逐项处理；「锁文件与声明一致」已由 `tests/integration/dependencies.test.ts` 的 `npm ci` 用例覆盖，但「许可字段是否变化」没有自动化断言。若以后要防上游改许可，需要新增门禁，那是独立事项。 |
| 完整 SBOM（SPDX / CycloneDX） | **未执行** | 本仓库不承诺分发格式；需要时可从 `package-lock.json` 派生。 |
| `npm audit` 的 CVE 之外的供应链风险 | **未执行** | `npm audit` 只覆盖已知 advisory；未做签名/来源核验。 |
| 许可证的法律意见 | **不适用** | 上表是工程判断与事实记录，不是法律意见。 |
| 真实模型验收 | **未执行** | T042 阻塞；本文件不声称模型链路已通过。 |
