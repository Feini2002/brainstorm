/**
 * T030 验收用例｜字面值脱敏的接线（settings 写入、适配器调用帧、落库链路）
 *
 * 这里断言的是"秘密不出现在产物里"，而不是"模块里有 registerSecret 这个函数"。
 * 关键点是四种**非 `sk-` 形态**的 Key：它们没有任何可被 `SECRET_PATTERNS`
 * 匹配的前缀，因此只有真正接上字面值层才可能消失。用 `sk-` canary 写这组用例
 * 会永远绿，也就证明不了接线存在。
 *
 * 本文件原为 `tests/integration/secret-redaction-wiring.test.ts`（T030 的交付证据）。
 * T075-C02 要求"秘密全链"有单一归属目录，因此它与端点策略、隔离断言一起**移动**到
 * `tests/security/`；T030 的用例编号与断言一字未改。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import { DEFAULT_LLM_CONFIG, type LlmConfig } from '@/domain/knowledge';
import { OpenAICompatibleAdapter } from '@/server/llm/adapter';
import type { Transport, TransportRequest, TransportResponse } from '@/server/llm/transport';
import { writeSettings } from '@/server/repositories/settings';
import { runConnectionTest } from '@/server/services/testConnection';
import { redactSecrets, clearRegisteredSecrets } from '@/server/observability/redaction';
import { createTestDatabase, newId, openTestDatabase, type TestDatabase } from '../helpers/db';
import { callRoute } from '../integration/helpers/http';

/** Azure 风格 32 位 hex。 */
const AZURE_KEY = '0123456789abcdef0123456789abcdef';
/** 自建网关风格。 */
const GATEWAY_KEY = 'gw_live_1122334455667788aabbccdd';
/** Google Gemini 风格。 */
const GOOGLE_KEY = 'AIzaSyD4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ12';

function config(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    ...DEFAULT_LLM_CONFIG,
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-4o-mini',
    ...overrides,
  };
}

class EchoingTransport implements Transport {
  readonly requests: TransportRequest[] = [];
  calls = 0;

  constructor(private readonly respond: (request: TransportRequest) => TransportResponse) {}

  async send(request: TransportRequest): Promise<TransportResponse> {
    this.calls += 1;
    this.requests.push(request);
    return this.respond(request);
  }
}

/** A provider that echoes the credential it was sent inside a 401 body. */
function echoKeyResponse(status: number): (request: TransportRequest) => TransportResponse {
  return (request) => {
    const echoed = (request.headers.Authorization ?? '').replace(/^Bearer\s+/u, '');
    return {
      status,
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({
        error: { message: `Incorrect API key provided: ${echoed}`, type: 'invalid_request_error' },
      }),
    };
  };
}

describe('T030-C02 秘密字面值脱敏接线', () => {
  let test: TestDatabase;
  let db: DatabaseSync;

  beforeEach(() => {
    clearRegisteredSecrets();
    test = createTestDatabase();
    db = openTestDatabase(test.databasePath);
  });

  afterEach(() => {
    test.cleanup();
    clearRegisteredSecrets();
  });

  it('T030-C02 保存 Key 后，自由文本里的该值被字面值层移除', () => {
    writeSettings(db, {
      config: config(),
      keyAction: 'replace',
      apiKey: AZURE_KEY,
      expectedRevision: 0,
    });

    // 自由文本：不是 key=value 形态，模式表对它无能为力。
    const freeText = `连接失败：服务商说 ${AZURE_KEY} 已经被吊销，请重新申请。`;
    const safe = redactSecrets(freeText);

    expect(safe).not.toContain(AZURE_KEY);
    expect(safe).toContain('[redacted]');
    expect(safe).toContain('已经被吊销');
  });

  it('T030-C02 PUT 路由保存的 Key 也被登记（走真实 HTTP 入口）', async () => {
    const route = await import('@/app/api/settings/llm/route');
    const response = await callRoute(route.PUT, {
      method: 'PUT',
      path: '/api/settings/llm',
      body: { keyAction: 'replace', apiKey: GATEWAY_KEY, expectedRevision: 0, config: config() },
    });

    expect(response.status).toBe(200);
    // 响应本身只给布尔；这里断言的是副作用——路由路径确实完成了登记。
    expect(JSON.stringify(response.envelope)).not.toContain(GATEWAY_KEY);
    expect(redactSecrets(`provider echoed ${GATEWAY_KEY}`)).not.toContain(GATEWAY_KEY);
  });

  it('T030-C02 轮换 Key 后旧值仍被移除（旧错误消息可能还留着它）', () => {
    writeSettings(db, {
      config: config(),
      keyAction: 'replace',
      apiKey: AZURE_KEY,
      expectedRevision: 0,
    });
    writeSettings(db, {
      config: config({ model: 'next-model' }),
      keyAction: 'replace',
      apiKey: GATEWAY_KEY,
      expectedRevision: 1,
    });

    // 旧值必须继续被移除：只增不减是有意为之。
    expect(redactSecrets(`old: ${AZURE_KEY}`)).not.toContain(AZURE_KEY);
    expect(redactSecrets(`new: ${GATEWAY_KEY}`)).not.toContain(GATEWAY_KEY);
  });

  it('T030-C02 进程内未见过的已存 Key：适配器在调用帧里登记', async () => {
    // 直接写库，绕开 writeSettings：模拟"Key 由上一个进程存下"的情形。
    db.prepare('INSERT INTO secrets (key, value, updated_at) VALUES (?, ?, ?)').run(
      'llm.api_key',
      GOOGLE_KEY,
      '2026-01-01T00:00:00.000Z',
    );
    // 前置条件：此时还没有任何登记，字面值层不认识它。
    expect(redactSecrets(`key ${GOOGLE_KEY}`)).toContain(GOOGLE_KEY);

    const transport = new EchoingTransport(echoKeyResponse(401));
    const adapter = new OpenAICompatibleAdapter(transport);

    const caught = (await adapter
      .complete({
        config: {
          adapter: 'openai-compatible',
          baseUrl: config().baseUrl,
          model: config().model,
          structuredMode: 'prompt_json',
          tokenField: 'none',
          maxOutputTokens: 4096,
          apiKey: GOOGLE_KEY,
        },
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 15_000,
      })
      .catch((error: unknown) => error)) as AppError;

    expect(caught.code).toBe('PROVIDER_AUTH');
    expect(caught.message).not.toContain(GOOGLE_KEY);
    expect(caught.message).toContain('[redacted]');
    // 登记只影响脱敏，不改变请求本身。
    expect(transport.requests[0].headers.Authorization).toBe(`Bearer ${GOOGLE_KEY}`);
  });

  it('T030-C02 完整落库链路：ai_runs.error_message 里不留明文 Key', async () => {
    const transport = new EchoingTransport(echoKeyResponse(401));

    const thrown = (await runConnectionTest(db, {
      requestKey: newId(),
      config: config(),
      apiKey: AZURE_KEY,
      configRevision: 0,
      adapter: new OpenAICompatibleAdapter(transport),
    }).catch((error: unknown) => error)) as AppError;

    // ① 抛给路由的 AppError（→ JSON 信封 → 浏览器）不含明文。
    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown.code).toBe('PROVIDER_AUTH');
    expect(thrown.message).not.toContain(AZURE_KEY);

    // ② finishRun 落库的 error_message（→ GET /api/runs/{id}/diagnostics）不含明文。
    const row = db
      .prepare('SELECT error_code, error_message FROM ai_runs ORDER BY started_at DESC LIMIT 1')
      .get() as { error_code: string | null; error_message: string | null };

    expect(row.error_code).toBe('PROVIDER_AUTH');
    expect(row.error_message).not.toBeNull();
    expect(row.error_message).not.toContain(AZURE_KEY);
    expect(row.error_message).toContain('[redacted]');
  });

  it('T030-C02 落库链路对普通随机长串 Key 同样成立', async () => {
    const opaque = 'Pq7Wn2Xc5Vb8Nm3Kl6Jh9Gf4Ds1Az0Yt';
    const transport = new EchoingTransport(echoKeyResponse(403));

    const thrown = (await runConnectionTest(db, {
      requestKey: newId(),
      config: config(),
      apiKey: opaque,
      configRevision: 0,
      adapter: new OpenAICompatibleAdapter(transport),
    }).catch((error: unknown) => error)) as AppError;

    expect(thrown.message).not.toContain(opaque);
    const blob = JSON.stringify(db.prepare('SELECT * FROM ai_runs').all());
    expect(blob).not.toContain(opaque);
  });
});
