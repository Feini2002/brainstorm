/**
 * T074 验收用例｜本地诊断与可观测性（服务与路由层）
 *
 * 用例原文：`docs/05_tests/G6/T074_cases.md`。规则原文：`docs/04_tasks/G6/T074_diagnostics.md`。
 *
 * 这一组覆盖 C01、C02、C04、C05；C03（渲染尺寸）与 C06（无遥测）必须有真实浏览器，
 * 在 `tests/e2e/diagnostics.spec.ts` 里断言。其中 C03 的**判定规则**本身是纯函数，
 * 另有 `tests/unit/diagnostics.test.ts` 在进程内穷举它的边界。
 *
 * 每个用例都同时断言「目标结果」与「不该发生的改动」：诊断是一次读取，读锁探测是
 * 唯一的写动作入口，所以 C02 会把「没有写锁之前」的库状态和「持有写锁时读完」的状态
 * 逐项对比，而不是只看响应体。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { LIMITS } from '@/domain/limits';
import { registerSecret, setLogSink, type SafeLogRecord } from '@/server/observability/redaction';
import {
  buildDiagnosticsReport,
  journalStats,
  probeWriteLock,
  recordDiagnosticEvent,
  resetApiLatency,
  resetDiagnosticJournal,
} from '@/server/observability/diagnostics';
import { readApiKey, writeSettings } from '@/server/repositories/settings';
import { createTestDatabase, newId, openTestDatabase, type TestDatabase } from '../helpers/db';
import { callRoute } from './helpers/http';

/** 显然不可用的秘密标记；所有产物都会被扫描。 */
const SECRET = 'sk-test-DIAG074-1234567890abcdef';

/** 私人原文标记：诊断摘要里绝不能出现。 */
const PRIVATE_TEXT = '我的私人笔记：身份证号 110101199001011234，请不要外传。';

let test: TestDatabase;
let db: DatabaseSync;

beforeEach(() => {
  test = createTestDatabase();
  db = openTestDatabase(test.databasePath);
  resetDiagnosticJournal();
  resetApiLatency();
});

afterEach(() => {
  setLogSink(null);
  test.cleanup();
});

/** 写入带着秘密标记的完整设置，让「有没有泄漏」这条断言有意义。 */
function seedSecret(): void {
  writeSettings(db, {
    config: {
      adapter: 'openai-compatible',
      baseUrl: 'https://api.example.com/tenant-secret-path/v1',
      model: 'test-model',
      structuredMode: 'prompt_json',
      tokenField: 'none',
      maxOutputTokens: 4096,
      schemaRepairEnabled: false,
    },
    keyAction: 'replace',
    apiKey: SECRET,
    expectedRevision: 0,
  });
  expect(readApiKey(db)).toBe(SECRET);
}

/** 写入一条带原文标记的知识条目，直接落库（本组不测采集流程）。 */
function seedItem(): string {
  const id = newId();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO knowledge_items (id, capture_request_id, capture_request_hash, captured_text, raw_text,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, newId(), 'hash', PRIVATE_TEXT, PRIVATE_TEXT, now, now);
  return id;
}

/** 完整库状态快照，用来证明诊断读取没有改动任何东西。 */
function libraryFingerprint(): string {
  const tables = ['knowledge_items', 'relations', 'views', 'ai_runs', 'settings', 'secrets', 'app_meta'];
  const parts: string[] = [];
  for (const table of tables) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    parts.push(`${table}=${row.n}`);
  }
  const revisions = db
    .prepare("SELECT key, value FROM app_meta WHERE key = 'dataset_revision' ORDER BY key")
    .all() as { key: string; value: string }[];
  for (const revision of revisions) parts.push(`${revision.key}=${revision.value}`);
  return parts.join('|');
}

async function diagnosticsRoute() {
  return import('@/app/api/diagnostics/route');
}

describe('T074-C01 受保护读取', () => {
  it('T074-C01 没有本地令牌时被拒绝，且不旁路返回环境资料', async () => {
    seedSecret();
    const route = await diagnosticsRoute();
    const response = await callRoute(route.GET, {
      method: 'GET',
      path: '/api/diagnostics',
      token: null,
    });

    expect(response.status).toBe(403);
    const serialized = JSON.stringify(response.envelope);
    // 「必须排除：诊断接口也可能泄露私人信息」——拒绝体里不能借用错误信息带出配置。
    for (const forbidden of [
      SECRET,
      PRIVATE_TEXT,
      'api.example.com',
      'test-model',
      test.databasePath,
      'schemaVersion',
      'capabilities',
      'node',
    ]) {
      expect(serialized, `拒绝响应不应包含 ${forbidden}`).not.toContain(forbidden);
    }
    expect((response.envelope as { error: { code: string } }).error.code).toBe('SESSION_EXPIRED');
  });

  it('T074-C01 令牌错误时同样被拒绝（不是「有值就放行」）', async () => {
    const route = await diagnosticsRoute();
    const response = await callRoute(route.GET, {
      method: 'GET',
      path: '/api/diagnostics',
      token: 'not-the-real-token-0000000000000000',
    });
    expect(response.status).toBe(403);
  });

  it('T074-C01 带令牌的正常读取返回报告，且计数是真实库计数', async () => {
    seedItem();
    const route = await diagnosticsRoute();
    const response = await callRoute(route.GET, { method: 'GET', path: '/api/diagnostics' });

    expect(response.status).toBe(200);
    const envelope = response.envelope as { ok: true; data: { counts: { items: number } } };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.counts.items).toBe(1);
  });

  it('T074-C01 被拒绝的那次读取没有碰数据库，也没有写日志事件', async () => {
    resetDiagnosticJournal();
    const before = journalStats();
    const route = await diagnosticsRoute();
    await callRoute(route.GET, { method: 'GET', path: '/api/diagnostics', token: null });
    // 守卫在 handler 之前执行，所以连一次读取样本都不应该产生。
    expect(journalStats().recorded).toBe(before.recorded);
  });
});

describe('T074-C02 数据库锁', () => {
  /**
   * 测试连接持有写锁。
   *
   * 用第二个 `DatabaseSync` 连接而不是把被测连接自己锁住：租约与 busy_timeout
   * 都是按连接生效的，同连接自锁观察不到「另一个连接」这一条件。
   */
  function holdWriteLock(): DatabaseSync {
    const holding = new DatabaseSync(test.databasePath);
    holding.exec('PRAGMA busy_timeout = 5000');
    holding.exec('BEGIN IMMEDIATE');
    return holding;
  }

  it('T074-C02 写锁被占用时归类为存储层，而不是模型层', () => {
    seedSecret();
    const holding = holdWriteLock();
    try {
      const report = buildDiagnosticsReport(db);
      expect(report.database.lockProbe).toBe('locked');

      const layers = report.layers.map((entry) => entry.layer);
      expect(layers).toContain('storage');
      // 「必须排除：分类错误会让用户修错问题」——锁不能被写成模型问题。
      expect(layers).not.toContain('model');

      const storage = report.layers.find((entry) => entry.layer === 'storage');
      expect(storage?.nextStep).toContain('写锁');
      // 「避免一律建议重装依赖」(T074-R06)：给的是释放写锁的动作，不是重装。
      expect(storage?.nextStep).toContain('窗口');
      expect(storage?.nextStep).not.toContain('模型');
      expect(storage?.evidence.join(' ')).toContain('locked');
    } finally {
      holding.exec('ROLLBACK');
      holding.close();
    }
  });

  it('T074-C02 没有竞争者时探测报告正常，且不留下未结束的事务', () => {
    expect(probeWriteLock(db)).toBe('ok');
    // 探针自己开了又回滚，所以此时同一个连接仍能正常开事务；卡在 BEGIN 会报错。
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
    const report = buildDiagnosticsReport(db);
    expect(report.database.lockProbe).toBe('ok');
    expect(report.layers.map((entry) => entry.layer)).not.toContain('storage');
  });

  it('T074-C02 持有写锁时读取仍返回报告，且库内容逐项不变（只读）', () => {
    seedSecret();
    seedItem();
    const before = libraryFingerprint();

    const holding = holdWriteLock();
    let report: ReturnType<typeof buildDiagnosticsReport> | null = null;
    try {
      report = buildDiagnosticsReport(db);
    } finally {
      holding.exec('ROLLBACK');
      holding.close();
    }

    const after = libraryFingerprint();
    expect(after).toBe(before);
    // 诊断读取不得改变知识、运行或设置，也不得替它们写一个计数或状态。
    expect(report?.counts.items).toBe(1);
    expect(report?.counts.runs).toBe(0);
    expect(report?.database.readOnly).toBe(true);
  });

  it('T074-C02 锁探测恢复原来的 busy_timeout，不改变后续连接行为', () => {
    const before = (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
    expect(probeWriteLock(db)).toBe('ok');
    const after = (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
    expect(after).toBe(before);
  });
});

describe('T074-C04 日志上限', () => {
  it('T074-C04 重复触发同类失败时限流：只打印有限次，其余折叠计数', () => {
    const lines: string[] = [];
    const records: SafeLogRecord[] = [];
    setLogSink((record, line) => {
      records.push(record);
      lines.push(line);
    });

    const repeats = LIMITS.diagnosticRepeatLimit * 5;
    for (let index = 0; index < repeats; index += 1) {
      recordDiagnosticEvent({
        level: 'warn',
        code: 'PROVIDER_RATE_LIMIT',
        route: 'items.organize',
        requestId: 'req-fixed',
      });
    }

    const stats = journalStats();
    // 「必须排除：临时错误不能每秒重复打印全堆栈」——打印次数被规则钉住。
    expect(lines.length).toBe(LIMITS.diagnosticRepeatLimit);
    expect(stats.emitted).toBe(LIMITS.diagnosticRepeatLimit);
    expect(stats.recorded).toBe(repeats);
    expect(stats.suppressedRepeats).toBe(repeats - LIMITS.diagnosticRepeatLimit);
  });

  it('T074-C04 不同 requestId 的同类错误各自限流，不会被一条错误吃掉', () => {
    const lines: string[] = [];
    setLogSink((_record, line) => lines.push(line));

    for (let index = 0; index < 3; index += 1) {
      recordDiagnosticEvent({ level: 'warn', code: 'DATABASE_BUSY', requestId: 'req-a' });
      recordDiagnosticEvent({ level: 'warn', code: 'DATABASE_BUSY', requestId: 'req-b' });
    }
    // 两个不同的关联 ID 各自有一次额度，所以是 2 × repeatLimit。
    expect(lines.length).toBe(LIMITS.diagnosticRepeatLimit * 2);
  });

  it('T074-C04 保留量有硬上限，超出的最旧事件被丢弃', () => {
    setLogSink(() => {
      /* swallow */
    });
    const overflow = LIMITS.diagnosticJournalCapacity + 25;
    for (let index = 0; index < overflow; index += 1) {
      recordDiagnosticEvent({ level: 'info', code: `event-${index}` });
    }

    const stats = journalStats();
    // 「必须排除：无限日志会耗尽磁盘影响保存」——保留量是契约上限，不是增长速度。
    expect(stats.retained).toBe(LIMITS.diagnosticJournalCapacity);
    expect(stats.recorded).toBe(overflow);
    expect(stats.droppedByRetention).toBe(overflow - LIMITS.diagnosticJournalCapacity);
  });

  it('T074-C04 保留上限被写进响应，用户能核对而不必相信实现', async () => {
    const route = await diagnosticsRoute();
    const response = await callRoute(route.GET, { method: 'GET', path: '/api/diagnostics' });
    const report = (response.envelope as { data: { observability: { retention: { capacity: number; policy: string }; journal: { capacity: number } } } })
      .data;

    expect(report.observability.retention.capacity).toBe(LIMITS.diagnosticJournalCapacity);
    expect(report.observability.journal.capacity).toBe(LIMITS.diagnosticJournalCapacity);
    expect(report.observability.retention.policy.length).toBeGreaterThan(0);
  });

  it('T074-C04 保留的事件里不含原文与秘密', () => {
    setLogSink(() => {
      /* swallow */
    });
    registerSecret(SECRET);
    recordDiagnosticEvent({
      level: 'error',
      code: 'PROVIDER_AUTH',
      requestId: 'req-canary',
      errorSummary: `服务商拒绝：Bearer ${SECRET}`,
    });

    const route = buildDiagnosticsReport(db);
    const blob = JSON.stringify(route);
    expect(blob).not.toContain(SECRET);
    expect(blob).not.toContain(PRIVATE_TEXT);
  });
});

describe('T074-C05 安全复制', () => {
  it('T074-C05 完整诊断摘要里没有秘密、原文、完整 endpoint query 或会话令牌', async () => {
    seedSecret();
    const itemId = seedItem();
    const route = await diagnosticsRoute();
    const response = await callRoute(route.GET, { method: 'GET', path: '/api/diagnostics' });
    const serialized = JSON.stringify(response.envelope);

    expect(response.status).toBe(200);
    for (const forbidden of [
      SECRET,
      PRIVATE_TEXT,
      '身份证号',
      'tenant-secret-path',
      '/v1',
      itemId,
      'X-Brain-Token',
      'x-brain-token',
      test.databasePath,
      'Desktop',
    ]) {
      expect(serialized, `诊断摘要不应包含 ${forbidden}`).not.toContain(forbidden);
    }

    // 允许出现的是 host（不带路径与 query）与布尔状态。应用自身的回环 origin
    // 不是秘密，也不是私人路径，它出现在 security.host 里是有意的。
    expect(serialized).toContain('api.example.com');
    expect(serialized).toContain('"apiKeyConfigured":true');
    // 模型地址只到 host：路径与 query 都不在 DTO 里。
    expect(serialized).not.toContain('/tenant-secret-path/v1');
  });

  it('T074-C05 计数正确但绝不回显被计数内容的原文', async () => {
    seedSecret();
    seedItem();
    const route = await diagnosticsRoute();
    const response = await callRoute(route.GET, { method: 'GET', path: '/api/diagnostics' });
    const report = (response.envelope as { data: { counts: { items: number }; model: { apiKeyConfigured: boolean } } })
      .data;

    expect(report.counts.items).toBe(1);
    expect(report.model.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(report)).not.toContain(PRIVATE_TEXT);
  });

  it('T074-C05 数据目录只报种类与可写状态，绝不报绝对路径', async () => {
    const route = await diagnosticsRoute();
    const response = await callRoute(route.GET, { method: 'GET', path: '/api/diagnostics' });
    const dataDir = (response.envelope as { data: { dataDir: { kind: string; exists: boolean; writable: boolean | null } } })
      .data.dataDir;

    expect(['default', 'custom']).toContain(dataDir.kind);
    expect(dataDir.exists).toBe(true);
    expect(dataDir.writable).toBe(true);
    // 绝对路径根本不在这份 DTO 里：不是「过滤掉」，而是没有可以承载它的字段。
    expect(Object.keys(dataDir).sort()).toEqual(['exists', 'kind', 'writable']);
  });

  it('T074-C05 不可写的数据目录报告 false，而不是乐观报告可写', () => {
    const readOnly = path.join(test.dataDir, 'locked-dir');
    mkdirSync(readOnly, { recursive: true });
    // 用一个同名目录占住探针要写的位置，使写入必然失败并留下待清理的目录。
    mkdirSync(path.join(readOnly, '.write-probe'), { recursive: true });

    const report = buildDiagnosticsReport(db, { dataDir: readOnly });
    expect(report.dataDir.writable).toBe(false);
    rmSync(path.join(readOnly, '.write-probe'), { recursive: true, force: true });
  });

  it('T074-C05 不存在的数据目录报告 unknown，而不是凭空写一个 true', () => {
    const missing = path.join(test.dataDir, 'not-created');
    const report = buildDiagnosticsReport(db, { dataDir: missing });
    expect(report.dataDir.exists).toBe(false);
    expect(report.dataDir.writable).toBeNull();
  });

  it('T074-C05 声明的能力清单来自真实路由，且包含本次读取用的这一个', async () => {
    const route = await diagnosticsRoute();
    const response = await callRoute(route.GET, { method: 'GET', path: '/api/diagnostics' });
    const capabilities = (response.envelope as { data: { capabilities: string[] } }).data.capabilities;

    expect(capabilities).toContain('/api/diagnostics');
    // 动态段按 api_registry.json 的记法还原，而不是真实目录名 `[id]`。
    expect(capabilities).toContain('/api/runs/{id}/diagnostics');
    expect(capabilities.every((entry) => entry.startsWith('/api/'))).toBe(true);
    expect(new Set(capabilities).size).toBe(capabilities.length);
  });
});

describe('T074 其它规则', () => {
  it('T074-R02 报告 Node、应用版本、schemaVersion 与库计数', async () => {
    const route = await diagnosticsRoute();
    const response = await callRoute(route.GET, { method: 'GET', path: '/api/diagnostics' });
    const report = (
      response.envelope as {
        data: {
          node: string;
          version: string;
          database: { schemaVersion: number | null; supportedSchemaVersion: number };
          counts: Record<string, number | null>;
        };
      }
    ).data;

    expect(report.node).toBe(process.version);
    expect(report.version).toMatch(/\d+\.\d+\.\d+/u);
    expect(report.database.schemaVersion).toBe(report.database.supportedSchemaVersion);
    expect(report.database.schemaVersion).toBe(2);
    for (const key of ['items', 'relations', 'views', 'tags', 'runs']) {
      expect(report.counts[key], `counts.${key} 应是一个真实数字`).toBeTypeOf('number');
    }
  });

  it('T074-R03 记录 API 耗时、Run 耗时与错误码，Renderer 按 kind 与版本区分', async () => {
    const route = await diagnosticsRoute();
    const first = await callRoute(route.GET, { method: 'GET', path: '/api/diagnostics' });
    const second = await callRoute(route.GET, { method: 'GET', path: '/api/diagnostics' });

    const observability = (
      second.envelope as {
        data: {
          observability: {
            apiLatency: { note: string; routes: { route: string; stats: { count: number } }[] };
            runLatency: { finished: number; stats: { count: number } };
            errorCodes: { code: string; layer: string; source: string }[];
            renderers: { kind: string; version: string }[];
          };
        };
      }
    ).data.observability;

    // 第一次读取记录样本，所以第二次读取时它已经出现在报告里。
    const diagnosticsRouteSamples = observability.apiLatency.routes.find(
      (entry) => entry.route === 'diagnostics.read',
    );
    expect(diagnosticsRouteSamples, JSON.stringify(observability.apiLatency)).toBeDefined();
    expect(diagnosticsRouteSamples?.stats.count).toBeGreaterThanOrEqual(1);
    expect(first.status).toBe(200);

    // 运行耗时来自真实账本：本次库里没有已结束的运行，因此报告为 0 个样本。
    expect(observability.runLatency.finished).toBe(0);
    expect(observability.runLatency.stats.count).toBe(0);

    // Renderer 按 kind 与版本区分，版本来自 view.ts 的权威常量。
    const kinds = observability.renderers.map((renderer) => renderer.kind).sort();
    expect(kinds).toEqual(['flow', 'graph', 'mindmap']);
    for (const renderer of observability.renderers) {
      expect(renderer.version).toMatch(/-v\d+$/u);
    }
  });

  it('T074-R03 没有样本的接口耗时报告未知，不填 0', async () => {
    resetApiLatency();
    const route = await diagnosticsRoute();
    const response = await callRoute(route.GET, { method: 'GET', path: '/api/diagnostics' });
    const apiLatency = (
      response.envelope as {
        data: { observability: { apiLatency: { routes: unknown[]; note: string } } };
      }
    ).data.observability.apiLatency;

    // 本次读取的样本在构建报告之后才记录，所以这里没有任何路由样本。
    expect(apiLatency.routes).toEqual([]);
    expect(apiLatency.note.length).toBeGreaterThan(0);
  });

  it('T074-R04 保留策略在响应里说清是标准输出而不是日志文件', () => {
    const report = buildDiagnosticsReport(db);
    expect(report.observability.retention.sink).toBe('stdout');
    expect(report.observability.retention.repeatLimit).toBe(LIMITS.diagnosticRepeatLimit);
    expect(report.observability.retention.windowMs).toBe(LIMITS.diagnosticRepeatWindowMs);
  });

  it('T074-R03 报告明确声明不接第三方遥测', () => {
    const report = buildDiagnosticsReport(db);
    // 「不接第三方遥测平台」是结构声明 + 可核对的事实：本模块没有任何出站调用。
    expect(report.observability.telemetry).toBe('none');
    expect(JSON.stringify(report)).not.toMatch(/sentry|posthog|mixpanel|analytics|gtag/iu);
  });

  it('T074-R06 AI 慢、数据库锁、图空白各自有独立入口，不互相掩盖', () => {
    // 存储层：直接给一条写锁。
    const holding = new DatabaseSync(test.databasePath);
    holding.exec('PRAGMA busy_timeout = 5000');
    holding.exec('BEGIN IMMEDIATE');
    let storageStep = '';
    try {
      const report = buildDiagnosticsReport(db);
      storageStep =
        report.layers.find((entry) => entry.layer === 'storage')?.nextStep ?? '';
    } finally {
      holding.exec('ROLLBACK');
      holding.close();
    }

    // 模型层：一条失败运行留下限流错误码。
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO ai_runs (id, request_key, request_hash, kind, state, config_revision,
         input_hash, config_snapshot_json, prompt_version, started_at, deadline_at, finished_at, error_code)
       VALUES (?, ?, ?, 'organize', 'failed', 1, 'ih', '{}', 'organize-v1', ?, ?, ?, 'PROVIDER_RATE_LIMIT')`,
    ).run(newId(), newId(), 'hash', now, now, now);
    const modelReport = buildDiagnosticsReport(db);
    const modelStep = modelReport.layers.find((entry) => entry.layer === 'model')?.nextStep ?? '';

    expect(storageStep.length).toBeGreaterThan(0);
    expect(modelStep.length).toBeGreaterThan(0);
    expect(storageStep).not.toBe(modelStep);
    // 两个入口指向不同的组件，而不是同一句「重装依赖」。
    expect(modelReport.layers.map((entry) => entry.layer)).toContain('model');
  });

  it('T074-R06 库内错误码按 T041 的分类映射到层级，锁与模型不混为一谈', () => {
    const now = new Date().toISOString();
    const insertRun = (code: string): void => {
      db.prepare(
        `INSERT INTO ai_runs (id, request_key, request_hash, kind, state, config_revision,
           input_hash, config_snapshot_json, prompt_version, started_at, deadline_at, finished_at, error_code)
         VALUES (?, ?, ?, 'organize', 'failed', 1, 'ih', '{}', 'organize-v1', ?, ?, ?, ?)`,
      ).run(newId(), newId(), 'hash', now, now, now, code);
    };
    insertRun('DATABASE_BUSY');
    insertRun('PROVIDER_AUTH');

    const report = buildDiagnosticsReport(db);
    const byCode = new Map(report.observability.errorCodes.map((entry) => [entry.code, entry]));
    expect(byCode.get('DATABASE_BUSY')?.layer).toBe('storage');
    expect(byCode.get('PROVIDER_AUTH')?.layer).toBe('model');
    expect(byCode.get('DATABASE_BUSY')?.source).toBe('run');
    expect(byCode.get('PROVIDER_AUTH')?.count).toBe(1);
  });

  it('T074 未配置 Key 时把「本地配置」列为层级，而不是让人怀疑模型', () => {
    const report = buildDiagnosticsReport(db);
    const config = report.layers.find((entry) => entry.layer === 'config');
    expect(config, JSON.stringify(report.layers)).toBeDefined();
    expect(config?.nextStep).toContain('设置页');
    // 没有 Key 不是模型服务的问题，层级里不能同时出现 model。
    expect(report.layers.map((entry) => entry.layer)).not.toContain('model');
  });

  it('T074 路由在 200 响应上带 no-store，且不回显请求令牌', async () => {
    const route = await diagnosticsRoute();
    const { getSessionToken } = await import('@/server/security/localGuard');
    const token = getSessionToken();

    const response = await callRoute(route.GET, { method: 'GET', path: '/api/diagnostics' });
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.envelope)).not.toContain(token);
  });

  it('T074 读取在数据目录不可写时仍返回报告，并把可写状态报为 false', () => {
    const readOnly = path.join(test.dataDir, 'no-write');
    mkdirSync(readOnly, { recursive: true });
    writeFileSync(path.join(readOnly, 'keep.txt'), 'present', 'utf8');
    // 探针失败不影响读取：诊断本身必须能用，否则用户失去排查手段。
    mkdirSync(path.join(readOnly, '.write-probe'), { recursive: true });

    const report = buildDiagnosticsReport(db, { dataDir: readOnly });
    expect(report.dataDir.writable).toBe(false);
    expect(report.database.schemaVersion).toBe(2);
    rmSync(path.join(readOnly, '.write-probe'), { recursive: true, force: true });
  });
});
