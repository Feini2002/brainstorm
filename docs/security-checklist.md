# 安全清单｜实际措施、验证方式与明确未覆盖的威胁

本文件记录**已经实现并验证过**的安全措施，以及**没有**覆盖的威胁。它是实现说明，不是承诺书；
每一条都指向可复现的验证入口。规则来源：[T075 密钥、跨站与渲染安全回归](04_tasks/G6/T075_security_regression.md)、
[Key、本地请求和出站边界](03_contracts/05_settings_and_security.md)。

文档与实现由测试同时钉住：`tests/security/threat-model-honesty.test.ts` 会读本文件，断言
下面「不覆盖」一节真的存在，并断言本文没有出现超出实现的措辞。所以本文既不能少写，也不能拔高。

## 一、威胁模型

Feini Brain 是**本机单用户工具**。它在设计上要防的对手是：**用户自己浏览器里的一个恶意网页**，
它试图访问 `http://127.0.0.1:3000`、读取用户的知识库或借用用户的模型 Key。

它不是多用户服务，也没有针对「本机已运行恶意程序」的防线。以下措施都是围绕上面这一个对手设计的。

## 二、已实现的措施

### 2.1 本机请求保护

| 措施 | 实现位置 | 验证入口 |
| --- | --- | --- |
| 仅绑定回环地址（`127.0.0.1`），默认不监听其它网卡 | `src/server/runtime/config.ts`、`scripts/start-local.mjs` | `tests/security/threat-model-honesty.test.ts`（R05 一组） |
| `Host` 精确匹配，`X-Forwarded-Host` 被忽略 | `src/server/security/localGuard.ts` | `tests/security/cross-site-matrix.test.ts` |
| `Origin` 精确匹配；读取允许缺失 `Origin`（非浏览器调用），**写入必须显式同源** | 同上 | 同上 |
| `Sec-Fetch-Site` 存在时必须是 `same-origin` 或 `none` | 同上 | 同上 |
| 进程级随机令牌（`LIMITS.tokenBytes` 字节，常量时间比较），只有同源页面读得到 | 同上 | `tests/security/local-request-guard.test.ts` |
| 写入要求 `application/json`，避免表单式简单请求 | 同上 | `tests/security/cross-site-matrix.test.ts` |
| 两种运行模式共用同一套检查，没有 `NODE_ENV` 分支 | 同上（源码里没有 `NODE_ENV`） | `tests/security/threat-model-honesty.test.ts` |

被拒绝的请求不写数据库、不产生付费副作用：这一点由 `tests/security/cross-site-matrix.test.ts`
对全部读写路由逐条断言（含「没有新增条目、没有新增 Run、没有出站调用」）。

**令牌守卫不是本机进程认证。** 它挡住的是浏览器里别的页面，不是同机上已经能读写用户文件的程序——
那种程序可以直接打开数据库文件，绕开 HTTP 层。见第四节。

### 2.2 Key 的处理

| 措施 | 实现位置 | 验证入口 |
| --- | --- | --- |
| Key 以**明文**保存在本机 SQLite 的 `secrets` 表；`.data/` 与密钥文件在 `.gitignore` 内 | `src/server/repositories/settings.ts`、`.gitignore` | `tests/contracts/guard.test.ts` |
| `GET /api/settings/llm` 的公开投影只有 `apiKeyConfigured`，**没有** Key、没有长度字段 | `src/server/repositories/settings.ts` | `tests/security/secret-full-chain.test.ts` |
| 安全摘要里的 `keyLength` 恒为 `null`（长度是秘密的指纹） | `src/server/observability/redaction.ts` | 同上 |
| 字面值脱敏层对已保存的 Key 逐字移除，覆盖 Google / Azure hex / 网关等**非 `sk-` 形态** | 同上 | `tests/security/secret-redaction-chain.test.ts` |
| 路由写入、适配器调用帧、落库三处都完成登记（接线存在，不只是函数存在） | 同上 | 同上 |
| 全部主要产出面（GET settings、Run、Run 诊断、`/api/diagnostics`、图数据、整库导出、单视图导出、日志、数据库）不含 Key | 多处 | `tests/security/secret-full-chain.test.ts` |
| 整库导出按列名显式读取，`settings` 与 `secrets` 表不可达 | `src/server/services/exportKnowledge.ts` | 同上 |
| 浏览器持久存储（`localStorage`/`sessionStorage`/`IndexedDB`/`Cookie`）不含 Key | 前端不持有 Key | `tests/e2e/security.spec.ts` |
| 日志接口是白名单结构体，没有 `body`/`headers`/`data` 字段可放秘密 | `src/server/observability/redaction.ts` | `tests/unit/redaction.test.ts` |

### 2.3 出站边界

| 措施 | 实现位置 | 验证入口 |
| --- | --- | --- |
| 出站目标来自设置里的 Base URL，经 `endpointPolicy` 规范化（要求 HTTPS 公网主机等） | `src/server/llm/endpointPolicy.ts` | `tests/unit/endpoint-policy.test.ts` |
| `fetch` 使用 `redirect: 'error'`，**不跟随**重定向；被拒绝的 302 不会把凭据带给 `Location` 目标 | `src/server/llm/transport.ts` | `tests/security/outbound-redirect.test.ts`（真实回环 302 服务） |
| 重定向失败归类为 `PROVIDER_ENDPOINT`，与「网络连不上」区分，且不声称可能已计费 | `src/server/llm/providerErrors.ts` | 同上 |
| 全仓库只有一个生产出站点（适配器传输层），浏览器侧只调本站 `/api/*` | 见下方 | `tests/security/source-url-no-fetch.test.ts`（源码扫描） |
| 笔记正文与 `sourceRef` 里的 URL **永不被自动抓取**：保存、浏览、搜索、整理、生成、导出全程无相关出站 | 无抓取实现；由出站账本证实 | 同上 |
| 响应体读取有硬字节上限，失败响应同样受限 | `src/server/llm/transport.ts` | `tests/unit/llm-transport.test.ts` |

### 2.4 不可信内容的呈现

| 措施 | 实现位置 | 验证入口 |
| --- | --- | --- |
| Mermaid 以 `securityLevel: 'strict'` 渲染，HTML 标签关闭，配置不含任何视图字段 | `src/features/flow/useMermaidRender.ts` | `tests/unit/flow-sanitize.test.ts` |
| Mermaid 输出经 SVG 白名单净化，`script`/`foreignObject`/`iframe`/`object`/`embed` 与 `on*` 一律移除 | `src/features/flow/sanitizeSvg.ts` | `tests/browser/flow-render-security.test.ts`（真 Chromium） |
| 导出前用只读谓词 `findUnsafeSvgMarkup` 复核，发现问题 fail-closed | 同上 | `tests/unit/flow-sanitize.test.ts` |
| Markmap 节点内容按**允许清单**净化后才交给库（标签白名单 + `class` 属性 + `on*` 前缀禁止） | `src/features/mindmap/sanitizeContent.ts` | `tests/security/graph-label-attack.test.ts` |
| 净化发生在 `setData` 之前，库拿不到原始 HTML | `src/features/mindmap/MindmapRenderer.tsx` | 同上 |
| 脑图渲染器拒绝 transformer 声明的待加载资源；已保存视图离线可读、零外部请求 | 同上 | `tests/e2e/markmap.spec.ts` |
| 渲染出的内容不产生真实外部请求（逐条把攻击面放进活页面后数请求） | 多处 | `tests/browser/flow-render-security.test.ts`、`tests/e2e/flow-security.spec.ts` |

### 2.5 其它已启用的响应头

每个 API 响应带 `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`；
下载类响应另外显式设置 `Content-Disposition` 与 `Content-Length`，下载失败返回 JSON 错误信封
而不是把错误正文另存为看起来正常的备份。见 `src/server/security/localGuard.ts`、
`src/app/api/export/route.ts`。

## 三、Content Security Policy：未启用

**当前没有设置 `Content-Security-Policy`，也没有 middleware。** 这是实际状态，不是「计划中」的委婉说法。

R05 的要求是「CSP 按实际图库需要测试后启用」——先测后启。没有直接启用的具体原因是：

- Mermaid 的配色依赖它自己注入的 `<style>` 元素。`tests/browser/flow-render-security.test.ts`
  与 `tests/unit/flow-sanitize.test.ts` 的实测记录把 `<style>` 列为**必须保留**的元素：
  清空它图会失去配色（合同规定净化前后都必须保住 `#a{fill:#fff}` 这类惰性样式表）。
- 因此一个不给 `style-src` 留空间的严格 CSP 会直接破坏图形视图。要启用必须先设计
  Mermaid/Markmap 的样式策略（例如 nonce 化的样式注入，或把配色移到允许的属性上），
  那是一项独立工作，不在本任务范围内。

在此之前，不假装已经有了 CSP 加固。`tests/security/threat-model-honesty.test.ts`
断言代码里不存在任何声称已启用 CSP 的痕迹，并断言本文如实写着「未启用」。

## 四、明确不覆盖的威胁

以下三类**不在**本工具的防护范围内。列在这里是为了让使用者不要对上面的措施产生错误期待。

1. **操作系统已被入侵。** 如果攻击者已经能在本机执行代码或读写用户的文件，他可以直接打开
   `.data/brain.db` 读走知识库与 Key，也可以改程序本身。本工具的任何一层——令牌、来源检查、
   脱敏、净化——都不改变这个结论。这些措施防的是浏览器里的恶意网页，不是本机已执行的代码。

2. **恶意的同源脚本。** 令牌守卫的前提是「只有本站页面读得到令牌」。如果攻击者能让代码在
   本站源下执行（例如通过一个我们没拦住的注入点，或一个被篡改的依赖），他就能拿到令牌并以
   合法身份调用全部 API——来源检查对同源请求按设计放行。净化与白名单是为了尽量不给他这个
   立足点（见 2.4），但这是「减少入口」，不是「同源代码可信」的保证。

3. **用户主动把 Key 交给不可信服务。** 出站边界保证请求只发往设置里的地址。用户如果把
   Base URL 配成第三方的中转服务，那把 Key 交给对方就是配置的必然结果，本工具无从判断该
   服务是否可信，也无法在对方留存凭据后收回。同理，导出与备份文件是用户自己分享的，
   一旦分享出去就不在工具的控制范围内。

另外两点边界也一并说明：

- **Key 是本地明文存储。** 它受文件系统权限与磁盘加密保护（如果用户启用了后者），
  本工具自己不额外加密。这里没有任何「硬件级」的保证。
- **本机其它进程。** 令牌与来源检查都在 HTTP 层。同机上一个能读用户目录的进程不受它们约束。

## 五、验证入口与命令

```bash
npm run test:security   # 安全项目：跨站矩阵、秘密全链、出站重定向、原文 URL、图标签、威胁说明
npm test                # 全量：unit + integration + security + contracts + browser
npx playwright test     # 端到端，含 tests/e2e/security.spec.ts
npm run contracts       # 契约一致性（含 .gitignore 覆盖数据目录与密钥文件）
npm run lint            # 0 problems 是基线
```

截图、数据库断言与外部请求计数分别证明不同的事情，不能相互替代：截图证明渲染结果，
数据库断言证明没有落库副作用，「零外部请求」证明没有出站。本清单里每一条措施的
「验证入口」列出的就是它实际依赖的那一种证据。
