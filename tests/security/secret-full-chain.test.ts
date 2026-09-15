/**
 * T075-C02｜秘密全链：可搜索但不可用的测试 Key 不出现在任何产物里。
 *
 * 用例规格：`docs/05_tests/G6/T075_cases.md`；规则 T075-R03。契约依据
 * `docs/03_contracts/05_settings_and_security.md`。
 *
 * ## 与已移动的 T030 套件的关系（不重复第二条实现）
 *
 * `tests/security/secret-redaction-chain.test.ts`（原 T030 交付证据）已经证明了
 * 「路由写入 / 适配器调用帧 / 落库」这三段的字面值登记接线。本文件**不重写**那段；
 * 它补的是 T075-C02 那句「完成全部主要路径」里**没有归属**的产出面：
 *
 *   - `GET /api/settings/llm`（HTTP 形态，不是 repository）
 *   - `GET /api/diagnostics`（T074 新增）
 *   - `GET /api/runs/{id}` 与 `GET /api/runs/{id}/diagnostics`
 *   - `POST /api/graph` 的图数据
 *   - `GET /api/export` 的整库备份
 *   - `GET /api/views/{id}/export` 的视图导出
 *   - 日志 sink 的每一条记录
 *
 * ## 为什么用 `containsSecret` 而不是 `not.toContain(key)`
 *
 * 两者都做，但 `containsSecret` 才是主判据：它既比对已登记的字面值，也跑一遍
 * 模式表，所以一个**被截断、被 URL 编码或被 JSON 转义**的 Key 也会被认出来——而
 * 裸 `toContain` 会漏掉那些形态。这就是 T075-C02 说的「新增功能容易绕过早期脱敏
 * 策略」：新产出面往往不是原样回显，而是套了一层编码。
 *
 * ## 测试 Key 的形态
 *
 * `AIza...`（Google）、32 位 hex（Azure）、`gw_live_...`（自建网关）三种都**不匹配**
 * `SECRET_PATTERNS`，所以它们只能靠字面值层消失。用 `sk-` canary 写这组用例会永远
 * 绿，也证明不了接线存在。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { DEFAULT_LLM_CONFIG, type LlmConfig } from '@/domain/knowledge';
import { OpenAICompatibleAdapter } from '@/server/llm/adapter';
import type { Transport, TransportRequest, TransportResponse } from '@/server/llm/transport';
import { containsSecret, setLogSink, type SafeLogRecord } from '@/server/observability/redaction';
import { clearRegisteredSecrets } from '@/server/observability/redaction';
import { createCapture } from '@/server/services/items';
import { runConnectionTest } from '@/server/services/testConnection';
import { createTestDatabase, newId, openTestDatabase, type TestDatabase } from '../helpers/db';
import { callRoute } from '../integration/helpers/http';

/** Google 形态：没有任何 `sk-` 前缀。 */
const GOOGLE_KEY = 'AIzaSyD4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ12';
/** Azure 形态：32 位 hex。 */
const AZURE_KEY = '0123456789abcdef0123456789abcdef';
/** 自建网关形态。 */
const GATEWAY_KEY = 'gw_live_1122334455667788aabbccdd';

const OPAQUE_NOTE = '这条笔记故意写得很普通，好让 Key 只能是唯一可识别的东西。';

function config(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    ...DEFAULT_LLM_CONFIG,
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-4o-mini',
    ...overrides,
  };
}

/** Records every log record the app emits, so the whole run can be scanned. */
class LogRecorder {
  readonly records: SafeLogRecord[] = [];
  readonly lines: string[] = [];

  install(): void {
    setLogSink((record, line) => {
      this.records.push(record);
      this.lines.push(line);
    });
  }

  restore(): void {
    setLogSink(null);
  }

  /** Everything the sink saw, as one scannable blob. */
  dump(): string {
    return JSON.stringify({ records: this.records, lines: this.lines });
  }
}

/** A transport whose 401 body echoes the credential, the worst case for leaks. */
class EchoingTransport implements Transport {
  readonly requests: TransportRequest[] = [];
  calls = 0;

  async send(request: TransportRequest): Promise<TransportResponse> {
    this.calls += 1;
    this.requests.push(request);
    const echoed = (request.headers.Authorization ?? '').replace(/^Bearer\s+/u, '');
    return {
      status: 401,
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({
        error: { message: `Incorrect API key provided: ${echoed}`, type: 'invalid_request_error' },
      }),
    };
  }
}

let test: TestDatabase;
let db: DatabaseSync;
let logs: LogRecorder;

beforeEach(() => {
  clearRegisteredSecrets();
  test = createTestDatabase();
  db = openTestDatabase(test.databasePath);
  logs = new LogRecorder();
  logs.install();
});

afterEach(() => {
  logs.restore();
  test.cleanup();
  clearRegisteredSecrets();
});

/**
 * Drive every surface this file covers, returning all response bodies plus the log dump.
 *
 * `key` alternates so the same body of code exercises the `sk-`-shaped-independent
 * forms; the caller passes which one it wants to prove first.
 */
async function driveFullChain(key: string): Promise<{
  surfaces: Record<string, string>;
  logs: string;
  database: string;
  transport: EchoingTransport;
}> {
  const surfaces: Record<string, string> = {};
  const transport = new EchoingTransport();

  const item = createCapture(db, {
    captureRequestId: newId(),
    rawText: OPAQUE_NOTE,
    sourceType: 'other',
    sourceRef: null,
  }).item;

  // 1) PUT settings — the real HTTP entry point that writes the secret.
  const put = await callRoute((await import('@/app/api/settings/llm/route')).PUT, {
    method: 'PUT',
    path: '/api/settings/llm',
    body: { keyAction: 'replace', apiKey: key, expectedRevision: 0, config: config() },
  });
  surfaces['PUT /api/settings/llm'] = JSON.stringify(put.envelope);

  // 2) GET settings — the readback a user (or a sharing screenshot) sees.
  const get = await callRoute((await import('@/app/api/settings/llm/route')).GET, {
    method: 'GET',
    path: '/api/settings/llm',
  });
  surfaces['GET /api/settings/llm'] = JSON.stringify(get.envelope);

  // 3) A failing connection test, so a Run exists with a provider error message.
  const requestKey = newId();
  await runConnectionTest(db, {
    requestKey,
    config: config(),
    apiKey: key,
    configRevision: 0,
    adapter: new OpenAICompatibleAdapter(transport),
  }).catch(() => undefined);

  const runRow = db
    .prepare('SELECT id FROM ai_runs ORDER BY started_at DESC LIMIT 1')
    .get() as { id: string } | undefined;
  const runId = runRow?.id ?? '';

  const runGet = await callRoute(
    (await import('@/app/api/runs/[id]/route')).GET,
    { method: 'GET', path: `/api/runs/${runId}`, params: { id: runId } },
  );
  surfaces['GET /api/runs/{id}'] = JSON.stringify(runGet.envelope);

  const runDiag = await callRoute(
    (await import('@/app/api/runs/[id]/diagnostics/route')).GET,
    { method: 'GET', path: `/api/runs/${runId}/diagnostics`, params: { id: runId } },
  );
  surfaces['GET /api/runs/{id}/diagnostics'] = JSON.stringify(runDiag.envelope);

  // 4) Diagnostics — row counts, schema version, model host, journal.
  const diagnostics = await callRoute((await import('@/app/api/diagnostics/route')).GET, {
    method: 'GET',
    path: '/api/diagnostics',
  });
  surfaces['GET /api/diagnostics'] = JSON.stringify(diagnostics.envelope);

  // 5) Graph read over the captured note.
  const graph = await callRoute((await import('@/app/api/graph/route')).POST, {
    method: 'POST',
    path: '/api/graph',
    body: { filter: {}, itemIds: [item.id] },
  });
  surfaces['POST /api/graph'] = JSON.stringify(graph.envelope);

  // 6) Whole-library export (raw body, not the envelope).
  const exportRoute = await import('@/app/api/export/route');
  const exportResponse = await exportRoute.GET(
    new Request('http://127.0.0.1:3000/api/export', {
      method: 'GET',
      headers: {
        host: '127.0.0.1:3000',
        origin: 'http://127.0.0.1:3000',
        'sec-fetch-site': 'same-origin',
        'x-brain-token': (await import('@/server/security/localGuard')).getSessionToken(),
      },
    }),
  );
  surfaces['GET /api/export'] = await exportResponse.text();

  // 7) Single-view export: create a graph view, then export it in every format.
  const viewRoute = await import('@/app/api/views/route');
  const created = await callRoute(viewRoute.POST, {
    method: 'POST',
    path: '/api/views',
    body: {
      kind: 'graph',
      name: '秘密链视图',
      selection: { mode: 'explicit', itemIds: [item.id] },
    },
  });
  const viewId = (created.envelope as { data?: { id?: string } }).data?.id ?? '';

  const viewExportRoute = await import('@/app/api/views/[id]/export/route');
  for (const format of ['markdown', 'json', 'mermaid'] as const) {
    const response = await viewExportRoute.GET(
      new Request(
        `http://127.0.0.1:3000/api/views/${viewId}/export?format=${format}`,
        {
          method: 'GET',
          headers: {
            host: '127.0.0.1:3000',
            origin: 'http://127.0.0.1:3000',
            'sec-fetch-site': 'same-origin',
            'x-brain-token': (await import('@/server/security/localGuard')).getSessionToken(),
          },
        },
      ),
      { params: Promise.resolve({ id: viewId }) },
    );
    surfaces[`GET /api/views/{id}/export?format=${format}`] = await response.text();
  }

  return {
    surfaces,
    logs: logs.dump(),
    // Every table, so a secret landing in an unexpected column is still caught.
    database: JSON.stringify(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all()
        .flatMap((row) => {
          const name = (row as { name: string }).name;
          // `secrets` is storage, not an artifact: it is redacted by the read paths
          // this file asserts on, so including its raw bytes would prove nothing.
          if (name === 'secrets') return [];
          return db.prepare(`SELECT * FROM ${name}`).all();
        }),
    ),
    transport,
  };
}

describe('T075-C02 秘密全链（Google 形态 Key）', () => {
  it('T075-C02 全部主要路径的输出里都找不到这把 Key', async () => {
    const { surfaces, logs, database, transport } = await driveFullChain(GOOGLE_KEY);

    // 前置：链路真的跑到了，而且真的出站过一次（不是「因为没跑」才没有泄露）。
    expect(transport.calls).toBe(1);
    expect(transport.requests[0].headers.Authorization).toBe(`Bearer ${GOOGLE_KEY}`);

    // 主要判据：模式表 + 字面值层，能抓出被编码/截断的形态。
    const offenders: string[] = [];
    for (const [name, body] of Object.entries(surfaces)) {
      if (body.includes(GOOGLE_KEY) || containsSecret(body)) offenders.push(name);
    }
    expect(offenders, '这些产出面里出现了 Key').toEqual([]);

    // 日志与数据库是两处不同的产出面，分别断言。
    expect(logs.includes(GOOGLE_KEY), '日志里出现了明文 Key').toBe(false);
    expect(containsSecret(logs), '日志里有可识别的凭据形态').toBe(false);
    expect(database.includes(GOOGLE_KEY), '数据库中某列存了明文 Key').toBe(false);
  });

  it('T075-C02 GET settings 只回答「是否已配置」，不含 Key 本身也不含其长度', async () => {
    await driveFullChain(GOOGLE_KEY);

    const route = await import('@/app/api/settings/llm/route');
    const response = await callRoute(route.GET, { method: 'GET', path: '/api/settings/llm' });
    const data = (response.envelope as { data: Record<string, unknown> }).data;

    expect(data.apiKeyConfigured).toBe(true);
    // 公开投影里根本没有长度字段——比「有字段但为 null」更强，因为客户端
    // 连一个可以顺手渲染出来的数字都拿不到。
    expect(Object.keys(data)).not.toContain('keyLength');
    expect(Object.keys(data)).not.toContain('apiKey');
    // 也没有任何字段把末尾几位当作「提示」回显。
    expect(JSON.stringify(data)).not.toContain(GOOGLE_KEY.slice(-4));
  });

  it('T075-C02 安全摘要里的 keyLength 恒为 null，不泄露长度指纹', async () => {
    // 公开投影没有这个字段，但日志用的安全摘要保留了它并且**总是** null。
    // 长度是秘密的指纹：12 位的网关 Key 和 51 位的 Google Key 能区分开。
    const { safeSettingsSummary } = await import('@/server/observability/redaction');

    const summary = safeSettingsSummary({
      baseUrl: config().baseUrl,
      model: config().model,
      apiKeyConfigured: true,
    });

    expect(summary.keyLength).toBeNull();
    expect(summary.apiKeyConfigured).toBe(true);
    // 摘要里不该有任何能反推 Key 的字段。
    expect(JSON.stringify(summary)).not.toContain(GOOGLE_KEY);
    expect(JSON.stringify(summary)).not.toContain(String(GOOGLE_KEY.length));
  });

  it('T075-C02 整库导出不含 Key：备份可以安全地分享给他人', async () => {
    const { surfaces } = await driveFullChain(GOOGLE_KEY);
    const bundle = surfaces['GET /api/export'];

    expect(bundle.length).toBeGreaterThan(100);
    expect(bundle).not.toContain(GOOGLE_KEY);
    // 导出也不应把 settings/secrets 表带出来。
    expect(bundle).not.toContain('"secrets"');
    expect(bundle).not.toContain('llm.api_key');
  });
});

describe('T075-C02 秘密全链（其它形态 Key）', () => {
  it('T075-C02 Azure 十六进制形态同样不出现在任何产出面', async () => {
    const { surfaces, logs, database } = await driveFullChain(AZURE_KEY);

    for (const [name, body] of Object.entries(surfaces)) {
      expect(body.includes(AZURE_KEY), `${name} 里出现了 Key`).toBe(false);
    }
    expect(logs.includes(AZURE_KEY)).toBe(false);
    expect(database.includes(AZURE_KEY)).toBe(false);
  });

  it('T075-C02 自建网关形态同样不出现在任何产出面', async () => {
    const { surfaces, logs, database } = await driveFullChain(GATEWAY_KEY);

    for (const [name, body] of Object.entries(surfaces)) {
      expect(body.includes(GATEWAY_KEY), `${name} 里出现了 Key`).toBe(false);
    }
    expect(logs.includes(GATEWAY_KEY)).toBe(false);
    expect(database.includes(GATEWAY_KEY)).toBe(false);
  });

  it('T075-C02 删除 Key 之后，旧值的产物里也再读不到它', async () => {
    await driveFullChain(GATEWAY_KEY);

    const route = await import('@/app/api/settings/llm/route');
    const deleted = await callRoute(route.PUT, {
      method: 'PUT',
      path: '/api/settings/llm',
      body: { keyAction: 'delete', expectedRevision: 1, config: config() },
    });
    expect(deleted.status).toBe(200);

    const get = await callRoute(route.GET, { method: 'GET', path: '/api/settings/llm' });
    const data = (get.envelope as { data: { apiKeyConfigured: boolean } }).data;
    expect(data.apiKeyConfigured).toBe(false);
    expect(JSON.stringify(get.envelope)).not.toContain(GATEWAY_KEY);

    // 删除后旧值仍应继续被字面值层移除：历史错误消息可能还留着它。
    const diagnostics = await callRoute(
      (await import('@/app/api/diagnostics/route')).GET,
      { method: 'GET', path: '/api/diagnostics' },
    );
    expect(JSON.stringify(diagnostics.envelope)).not.toContain(GATEWAY_KEY);
    expect(containsSecret(JSON.stringify(diagnostics.envelope))).toBe(false);
  });
});
