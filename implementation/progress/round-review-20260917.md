# 本轮执行记录（审查 7fd52c9）

基线提交 `7fd52c96a8dde5b3f248cc49ff80e3ab8af99a65`。未 reset，未触碰用户 `.data` / `brain.db`，未读取真实 Key。

这是修复与精简，不是重跑 T001–T084。历史 Gate 证据未回写。

## 1. 缺陷与核验

| 编号 | 结论 |
| --- | --- |
| R01 只保存误触发 AI | 已修复：`CaptureMode` 显式分流，已有 Key 时只保存也不整理 |
| R02 设置草稿回退 | 已修复：`mergeDraftUpdate(existing ?? draftFromSettings)` |
| R03 冲突显示整理成功 | 已修复：整理终态按业务结果，冲突用独立文案 |
| R04 保存重试快照 | 已修复：冻结来源/模式/requestKey，模块级 pending 跨路由 |
| R05 请求身份混入可变状态 | 已修复：`request_intent_hash` 与执行快照分离；旧 NULL 身份只回放不付费 |
| R06 候选版本盖戳 | 已修复：整理冻结候选 id/revision/rawVersion |
| R07 因果方向与材料依据 | 已修复：A→B 不能认证 B→A；无关 depends_on 不能认证当前边；原文可标材料表述 |
| R08 脑图失败当空库 | 已修复：加载失败与空列表分开 |
| R09 启动与诊断重复 | 已修复：正常启动不做完整 doctor；诊断按需 |

## 2. 精简

- `npm run check` = lint + typecheck + test + build；历史台账改为 `npm run audit:history`
- 启动只检查 Node 版本与端口，绑定 `127.0.0.1`
- 诊断、脑图大纲/来源按需展开；流程图材料预览不再作为生成门禁
- 脚本回放从生产 `FetchTransport` 拆到 `src/server/llm/testing/scriptedTransport.ts`

未做（方案标明可选/后续）：抽出 `executeOperation`、淘汰 `check-contracts` 正则、CSP、向量检索、框架大版本升级。

## 3. 保留的底线

原文先落库；SQLite 事务与外键；人工字段保护；同请求不重复付费；Key 只存服务端；秘密不进日志/客户端/导出；本地请求保护；模型输出校验与 SVG 净化；备份恢复。九张表未压缩。

## 4. 本轮实测

| 命令 | 结果 |
| --- | --- |
| `npx vitest run --project unit --project integration --project security --project contracts` | 85 文件 / 1099 passed |
| `npx vitest run --project browser` | 10 passed |
| `npm run lint` | 通过 |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过（Next 16.3.5） |
| `node scripts/check-contracts.mjs` | ok |
| Playwright chromium（全量一次 + 最终旅程复跑） | 除已改断言的 T084-C03 外均通过；复跑 `final-journey` 6 passed |
| Playwright chromium-narrow | 4 passed |
| 真实模型出网 | **未执行**（无用户 Key / 未授权） |

破坏性测试均使用临时库。

## 5. 数据与备份

- 新增向前迁移 `002_request_intent.sql`（`user_version` 1→2）。未改 `001_initial.sql`
- 旧行 `request_intent_hash` 保持 NULL
- 备份仍是 V1（`BACKUP_SCHEMA_VERSION = 1`）。隔离库 round-trip 通过，Key/设置不导出、不覆盖
- 流程图 `basis` 是视图内容可选字段；旧图可打开，不自动付费重生成

## 6. 最短启动

```powershell
npm ci
npm run dev
```

浏览器打开 http://127.0.0.1:3000/ 。排障用 `npm run doctor`。软件检查用 `npm run check`。
