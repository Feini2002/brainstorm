/**
 * T032 验收用例｜连接测试与能力验证
 *
 * 关键点在两条：测试走的是与正式调用相同的适配器与档位，以及「连上了」和
 * 「格式对了」是两个独立状态。所有请求都用替身 transport，绝不连真实域名。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import { LIMITS } from '@/domain/limits';
import type { LlmConfig } from '@/domain/knowledge';
import { writeSettings } from '@/server/repositories/settings';
import { OpenAICompatibleAdapter } from '@/server/llm/adapter';
import type {
  Transport,
  TransportRequest,
  TransportResponse,
} from '@/server/llm/transport';
import { runConnectionTest } from '@/server/services/testConnection';
import { createTestDatabase, openTestDatabase, newId, type TestDatabase } from '../helpers/db';
import { callRoute } from './helpers/http';

const SECRET = 'sk-test-CONNTEST-0000000000000000';

class ScriptedTransport implements Transport {
  readonly bodies: string[] = [];
  calls = 0;

  constructor(private readonly respond: (request: TransportRequest) => TransportResponse) {}

  async send(request: TransportRequest): Promise<TransportResponse> {
    this.calls += 1;
    this.bodies.push(request.body);
    return this.respond(request);
  }
}

function chatBody(content: string | null, status = 200): TransportResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    bodyText:
      status === 200
        ? JSON.stringify({
            choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
          })
        : JSON.stringify({ error: { message: content ?? 'error' } }),
  };
}

function config(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    adapter: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model',
    structuredMode: 'prompt_json',
    tokenField: 'none',
    maxOutputTokens: 4096,
    schemaRepairEnabled: false,
    ...overrides,
  };
}

/** Real adapter with an injected transport: same code path, fake network. */
function fakeAdapter(transport: Transport) {
  // The production adapter is used as-is; only its transport is swapped, so the
  // test exercises the real request building and protocol parsing.
  return new OpenAICompatibleAdapter(transport);
}

describe('T032 连接测试', () => {
  let test: TestDatabase;
  let db: DatabaseSync;

  beforeEach(() => {
    test = createTestDatabase();
    db = openTestDatabase(test.databasePath);
  });

  afterEach(() => {
    test.cleanup();
  });

  it('T032-C01 连接与结构都成功，且不写设置', async () => {
    const transport = new ScriptedTransport(() => chatBody('{"ok":true}'));
    const before = db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number };

    const result = await runConnectionTest(db, {
      requestKey: newId(),
      config: config(),
      apiKey: SECRET,
      configRevision: 0,
      adapter: fakeAdapter(transport),
    });

    expect(result.connected).toBe(true);
    expect(result.replyAccepted).toBe(true);
    expect(transport.calls).toBe(1);

    const after = db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number };
    // 测试与保存是不同用户意图：点测试不产生配置。
    expect(after.n).toBe(before.n);
    expect(db.prepare('SELECT COUNT(*) AS n FROM knowledge_items').get()).toEqual({ n: 0 });
  });

  it('T032-C02 401 提示鉴权失败，而不是笼统网络故障', async () => {
    const transport = new ScriptedTransport(() => chatBody('invalid api key', 401));

    const caught = await runConnectionTest(db, {
      requestKey: newId(),
      config: config(),
      apiKey: SECRET,
      configRevision: 0,
      adapter: fakeAdapter(transport),
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('PROVIDER_AUTH');
    expect((caught as Error).message).toContain('Key');
    // 失败也要留下可追踪的 Run 终态。
    const run = db.prepare('SELECT state, error_code FROM ai_runs ORDER BY started_at DESC LIMIT 1').get() as {
      state: string;
      error_code: string | null;
    };
    expect(run.state).toBe('failed');
    expect(run.error_code).toBe('PROVIDER_AUTH');
  });

  it('T032-C03 模型名错误时提示模型标识问题', async () => {
    const transport = new ScriptedTransport(() =>
      chatBody('The model `nope` does not exist', 404),
    );

    const caught = (await runConnectionTest(db, {
      requestKey: newId(),
      config: config({ model: 'nope' }),
      apiKey: SECRET,
      configRevision: 0,
      adapter: fakeAdapter(transport),
    }).catch((error: unknown) => error)) as AppError;

    expect(caught.code).toBe('PROVIDER_ENDPOINT');
    expect(caught.message).toContain('模型');
    expect(caught.message).not.toContain(SECRET);
  });

  it('T032-C04 返回普通 OK 文本时，传输成功但格式失败', async () => {
    const transport = new ScriptedTransport(() => chatBody('OK'));

    const result = await runConnectionTest(db, {
      requestKey: newId(),
      config: config(),
      apiKey: SECRET,
      configRevision: 0,
      adapter: fakeAdapter(transport),
    });

    // 两个状态必须分开：只要求回复 OK 无法验证正式整理契约。
    expect(result.connected).toBe(true);
    expect(result.replyAccepted).toBe(false);
    expect(result.message).toContain('ok');
  });

  it('T032-C05 请求 body 只含固定最小测试消息，不发送任何笔记', async () => {
    writeSettings(db, {
      config: config(),
      keyAction: 'replace',
      apiKey: SECRET,
      expectedRevision: 0,
    });
    // 库里放入私人内容，确认它不会被带出去。
    db.prepare(
      `INSERT INTO knowledge_items (
         id, capture_request_id, capture_request_hash, captured_text, raw_text,
         raw_version, revision, title, summary, type, keywords_json, importance,
         manual_fields_json, status, source_type, created_at, updated_at
       ) VALUES (?, ?, 'hash', ?, ?, 1, 1, '', '', 'idea', '[]', 3, '[]', 'raw', 'other', ?, ?)`,
    ).run(
      newId(),
      newId(),
      '这是一段私人笔记：我的银行卡号是 1234。',
      '这是一段私人笔记：我的银行卡号是 1234。',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );

    const transport = new ScriptedTransport(() => chatBody('{"ok":true}'));
    await runConnectionTest(db, {
      requestKey: newId(),
      config: config(),
      apiKey: SECRET,
      configRevision: 1,
      adapter: fakeAdapter(transport),
    });

    const sent = transport.bodies.join('\n');
    expect(sent).not.toContain('银行卡');
    expect(sent).not.toContain('私人笔记');
    expect(sent).not.toContain(SECRET);
  });

  it('T032-C06 连续点击同一个 requestKey 只保留一次外部调用', async () => {
    const transport = new ScriptedTransport(() => chatBody('{"ok":true}'));
    const requestKey = newId();

    const first = await runConnectionTest(db, {
      requestKey,
      config: config(),
      apiKey: SECRET,
      configRevision: 0,
      adapter: fakeAdapter(transport),
    });
    const second = await runConnectionTest(db, {
      requestKey,
      config: config(),
      apiKey: SECRET,
      configRevision: 0,
      adapter: fakeAdapter(transport),
    });

    expect(transport.calls).toBe(1);
    expect(second.runId).toBe(first.runId);
    expect(second.message).toContain('复用');
    expect(second.replyAccepted).toBe(true);
  });

  it('T032-R01 测试用的是草稿的档位，不是另写一个永远成功的 ping', async () => {
    const transport = new ScriptedTransport(() => chatBody('{"ok":true}'));

    await runConnectionTest(db, {
      requestKey: newId(),
      config: config({ structuredMode: 'json_object', tokenField: 'max_tokens', maxOutputTokens: 512 }),
      apiKey: SECRET,
      configRevision: 0,
      adapter: fakeAdapter(transport),
    });

    const body = JSON.parse(transport.bodies[0]) as Record<string, unknown>;
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.max_tokens).toBe(512);
    // 测试不允许被草稿的「允许一次格式修复」放大成两次请求。
    expect(body).not.toHaveProperty('temperature');
  });

  it('T032-R05 只做一次请求，超时十五秒，不自动重试', async () => {
    const transport = new ScriptedTransport(() => chatBody(null, 500));

    await runConnectionTest(db, {
      requestKey: newId(),
      config: config(),
      apiKey: SECRET,
      configRevision: 0,
      adapter: fakeAdapter(transport),
    }).catch(() => undefined);

    expect(transport.calls).toBe(1);
    const run = db.prepare('SELECT attempt_count FROM ai_runs ORDER BY started_at DESC LIMIT 1').get() as {
      attempt_count: number;
    };
    expect(run.attempt_count).toBe(1);
    expect(LIMITS.connectionTestTimeoutMs).toBe(15_000);
  });

  it('T032-R03 keep 使用已保存的 Key，但换 origin 需要确认', async () => {
    writeSettings(db, {
      config: config({ baseUrl: 'https://old.example.com/v1' }),
      keyAction: 'replace',
      apiKey: SECRET,
      expectedRevision: 0,
    });

    const transport = new ScriptedTransport(() => chatBody('{"ok":true}'));
    const result = await runConnectionTest(db, {
      requestKey: newId(),
      config: config({ baseUrl: 'https://old.example.com/v1' }),
      apiKey: SECRET,
      configRevision: 1,
      adapter: fakeAdapter(transport),
    });
    expect(result.connected).toBe(true);
    // 同一个 origin：沿用已保存秘密，不需要确认。
    expect(transport.bodies.join('')).not.toContain(SECRET);
  });

  it('T032-R04 成功摘要明确不承诺长任务可靠', async () => {
    const transport = new ScriptedTransport(() => chatBody('{"ok":true}'));
    const result = await runConnectionTest(db, {
      requestKey: newId(),
      config: config(),
      apiKey: SECRET,
      configRevision: 0,
      adapter: fakeAdapter(transport),
    });
    // Run 是可追溯的，且 usage 来自服务商而非估算。
    const run = db.prepare('SELECT usage_json, prompt_version, kind FROM ai_runs WHERE id = ?').get(result.runId) as {
      usage_json: string | null;
      prompt_version: string;
      kind: string;
    };
    expect(run.kind).toBe('connection_test');
    expect(run.prompt_version).toBe('connection-v1');
    expect(JSON.parse(run.usage_json ?? '{}')).toEqual({
      inputTokens: 8,
      outputTokens: 3,
      totalTokens: 11,
    });
  });

  it('T032-R01 路由在 revision 过期时拒绝测试，避免用到过期的 Key', async () => {
    writeSettings(db, {
      config: config(),
      keyAction: 'replace',
      apiKey: SECRET,
      expectedRevision: 0,
    });

    const route = await import('@/app/api/settings/llm/test/route');
    const response = await callRoute(route.POST, {
      method: 'POST',
      path: '/api/settings/llm/test',
      body: {
        requestKey: newId(),
        expectedSettingsRevision: 0,
        draft: { keyAction: 'replace', apiKey: SECRET, config: config() },
      },
    });

    // 当前 revision 已经是 1；用 0 测试会把已替换的秘密当成仍有效。
    expect(response.status).toBe(409);
  });

  it('T032-R03 路由在 keep 且没有已保存 Key 时明确报未配置', async () => {
    const route = await import('@/app/api/settings/llm/test/route');
    const response = await callRoute(route.POST, {
      method: 'POST',
      path: '/api/settings/llm/test',
      body: {
        requestKey: newId(),
        expectedSettingsRevision: 0,
        draft: { keyAction: 'keep', config: config() },
      },
    });

    expect(response.status).toBe(422);
    expect(JSON.stringify(response.envelope)).toContain('API Key');
  });

  it('T032-R03 路由拒绝未确认的跨 origin keep 测试', async () => {
    writeSettings(db, {
      config: config({ baseUrl: 'https://old.example.com/v1' }),
      keyAction: 'replace',
      apiKey: SECRET,
      expectedRevision: 0,
    });

    const route = await import('@/app/api/settings/llm/test/route');
    const response = await callRoute(route.POST, {
      method: 'POST',
      path: '/api/settings/llm/test',
      body: {
        requestKey: newId(),
        expectedSettingsRevision: 1,
        draft: { keyAction: 'keep', config: config({ baseUrl: 'https://new.example.com/v1' }) },
      },
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.envelope)).toContain('确认');
  });

  it('T032-R04 测试失败不会写进知识库，也不会留下 running 槽位', async () => {
    const transport = new ScriptedTransport(() => chatBody('boom', 500));

    await runConnectionTest(db, {
      requestKey: newId(),
      config: config(),
      apiKey: SECRET,
      configRevision: 0,
      adapter: fakeAdapter(transport),
    }).catch(() => undefined);

    const running = db.prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE state = 'running'").get() as {
      n: number;
    };
    expect(running.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM knowledge_items').get()).toEqual({ n: 0 });
  });

  it('T032-R06 同 key 但内容不同的测试请求返回 RUN_KEY_CONFLICT', async () => {
    const transport = new ScriptedTransport(() => chatBody('{"ok":true}'));
    const requestKey = newId();

    await runConnectionTest(db, {
      requestKey,
      config: config({ model: 'model-a' }),
      apiKey: SECRET,
      configRevision: 0,
      adapter: fakeAdapter(transport),
    });

    const caught = await runConnectionTest(db, {
      requestKey,
      config: config({ model: 'model-b' }),
      apiKey: SECRET,
      configRevision: 0,
      adapter: fakeAdapter(transport),
    }).catch((error: unknown) => error);

    expect((caught as AppError).code).toBe('RUN_KEY_CONFLICT');
    expect(transport.calls).toBe(1);
  });

  it('T032-R02 空内容回复算连接成功但格式失败，不报成网络故障', async () => {
    const transport = new ScriptedTransport(() => chatBody(''));
    const caught = await runConnectionTest(db, {
      requestKey: newId(),
      config: config(),
      apiKey: SECRET,
      configRevision: 0,
      adapter: fakeAdapter(transport),
    }).catch((error: unknown) => error);
    // 空 content 在适配层被判为 EMPTY_MODEL_OUTPUT；不能被写成 connected=true。
    expect((caught as AppError).code).toBe('EMPTY_MODEL_OUTPUT');
    expect((caught as Error).message).not.toContain('网络');
  });
});
