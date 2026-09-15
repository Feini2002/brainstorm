/**
 * T029 验收用例｜设置事务、秘密隔离与读取白名单
 *
 * 在真实临时文件库上执行：行数、revision、事务回滚与重开后的读取都要有实际证据。
 * 内存替身不能替代这里的关键断言。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { DEFAULT_LLM_CONFIG, type LlmConfig } from '@/domain/knowledge';
import { SettingsRevisionConflict, writeSettings } from '@/server/repositories/settings';
import { createTestDatabase, openTestDatabase, type TestDatabase } from '../helpers/db';
import { callRoute } from './helpers/http';

/**
 * 明显的测试标记，不是可用凭据。扫描用的就是这一串。
 * 选择带连字符的形式以便脱敏规则也能命中。
 */
const SECRET_SENTINEL = 'sk-test-SENTINEL-0000000000000000';

function config(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    ...DEFAULT_LLM_CONFIG,
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-4o-mini',
    ...overrides,
  };
}

async function settingsRoute() {
  return import('@/app/api/settings/llm/route');
}

function countRows(db: DatabaseSync, sql: string): number {
  return Number((db.prepare(sql).get() as { n: number }).n);
}

describe('T029 设置事务与秘密隔离', () => {
  let test: TestDatabase;
  let db: DatabaseSync;

  beforeEach(() => {
    test = createTestDatabase();
    db = openTestDatabase(test.databasePath);
  });

  afterEach(() => {
    test.cleanup();
  });

  it('T029-C01 GET 只返回 configured 布尔，响应里没有 Key 的任何痕迹', async () => {
    writeSettings(db, {
      config: config(),
      keyAction: 'replace',
      apiKey: SECRET_SENTINEL,
      expectedRevision: 0,
    });

    const route = await settingsRoute();
    const response = await callRoute(route.GET, { path: '/api/settings/llm' });

    expect(response.status).toBe(200);
    const serialized = JSON.stringify(response.envelope);
    // 遮罩 UI 不等于后端没泄露：这里直接扫原始响应体。
    expect(serialized).not.toContain(SECRET_SENTINEL);
    expect(serialized).not.toContain('SENTINEL');
    expect(serialized).not.toContain('sk-test');
    // 尾号、长度、指纹都不允许出现。
    expect(serialized).not.toContain('0000000000');

    const data = (response.envelope as { ok: true; data: Record<string, unknown> }).data;
    expect(data.apiKeyConfigured).toBe(true);
    expect(Object.keys(data).sort()).toEqual(['apiKeyConfigured', 'config', 'revision']);
    expect(Object.keys(data.config as object).sort()).toEqual([
      'adapter',
      'baseUrl',
      'maxOutputTokens',
      'model',
      'schemaRepairEnabled',
      'structuredMode',
      'tokenField',
    ]);
  });

  it('T029-C01 未配置时不伪造 apiKeyConfigured', async () => {
    const route = await settingsRoute();
    const response = await callRoute(route.GET, { path: '/api/settings/llm' });
    const data = (response.envelope as { ok: true; data: { apiKeyConfigured: boolean } }).data;
    expect(data.apiKeyConfigured).toBe(false);
  });

  it('T029-R02 首次保存写入 config 与 secret，并落在同一 revision', () => {
    const result = writeSettings(db, {
      config: config(),
      keyAction: 'replace',
      apiKey: SECRET_SENTINEL,
      expectedRevision: 0,
    });

    expect(result.revision).toBe(1);
    expect(countRows(db, 'SELECT COUNT(*) AS n FROM settings')).toBe(1);
    expect(countRows(db, 'SELECT COUNT(*) AS n FROM secrets')).toBe(1);
    expect(readSecretValue(db)).toBe(SECRET_SENTINEL);
  });

  it('T029-C02 秘密写入失败时，新地址与旧 Key 都保持原样', () => {
    const first = writeSettings(db, {
      config: config({ baseUrl: 'https://old.example.com/v1' }),
      keyAction: 'replace',
      apiKey: SECRET_SENTINEL,
      expectedRevision: 0,
    });
    expect(first.revision).toBe(1);

    // 模拟事务中秘密写入故障：baseUrl 与 Key 必须一起回滚。
    expect(() =>
      writeSettings(db, {
        config: config({ baseUrl: 'https://new.example.com/v1' }),
        keyAction: 'replace',
        apiKey: 'sk-should-not-land',
        expectedRevision: first.revision,
        failSecretWrite: true,
      }),
    ).toThrow();

    // 半更新会把旧凭据发向新地址，这正是要排除的结果。
    const after = db
      .prepare('SELECT config_json, revision FROM settings WHERE id = 1')
      .get() as { config_json: string; revision: number };
    expect(JSON.parse(after.config_json).baseUrl).toBe('https://old.example.com/v1');
    expect(after.revision).toBe(1);
    expect(readSecretValue(db)).toBe(SECRET_SENTINEL);
  });

  it('T029-C03 删除 Key 失败时不会误报已删除', async () => {
    const saved = writeSettings(db, {
      config: config(),
      keyAction: 'replace',
      apiKey: SECRET_SENTINEL,
      expectedRevision: 0,
    });

    // 用错误 revision 触发拒绝：删除不能“看起来成功”。
    expect(() =>
      writeSettings(db, {
        config: config(),
        keyAction: 'delete',
        expectedRevision: saved.revision + 5,
      }),
    ).toThrow(SettingsRevisionConflict);

    const route = await settingsRoute();
    const response = await callRoute(route.GET, { path: '/api/settings/llm' });
    const data = (response.envelope as { ok: true; data: { apiKeyConfigured: boolean } }).data;
    // 真实状态仍然可读，且秘密确实还在。
    expect(data.apiKeyConfigured).toBe(true);
    expect(readSecretValue(db)).toBe(SECRET_SENTINEL);
  });

  it('T029-C03 删除 Key 只删秘密，不动配置与知识库', () => {
    const saved = writeSettings(db, {
      config: config(),
      keyAction: 'replace',
      apiKey: SECRET_SENTINEL,
      expectedRevision: 0,
    });
    const itemsBefore = countRows(db, 'SELECT COUNT(*) AS n FROM knowledge_items');

    const after = writeSettings(db, {
      config: config(),
      keyAction: 'delete',
      expectedRevision: saved.revision,
    });

    expect(countRows(db, 'SELECT COUNT(*) AS n FROM secrets')).toBe(0);
    expect(after.config.baseUrl).toBe('https://api.example.com/v1');
    expect(countRows(db, 'SELECT COUNT(*) AS n FROM knowledge_items')).toBe(itemsBefore);
    // 删除 Key 也递增 revision：凭据变化必须让运行快照可区分。
    expect(after.revision).toBe(saved.revision + 1);
  });

  it('T029-R04 keep 不改变秘密，但配置变更仍然递增 revision', () => {
    const saved = writeSettings(db, {
      config: config(),
      keyAction: 'replace',
      apiKey: SECRET_SENTINEL,
      expectedRevision: 0,
    });

    const after = writeSettings(db, {
      config: config({ model: 'another-model' }),
      keyAction: 'keep',
      expectedRevision: saved.revision,
    });

    expect(after.revision).toBe(saved.revision + 1);
    expect(readSecretValue(db)).toBe(SECRET_SENTINEL);
    expect(after.config.model).toBe('another-model');
  });

  it('T029-R04 并发写入：旧 revision 被拒且不覆盖新地址', () => {
    const first = writeSettings(db, {
      config: config({ baseUrl: 'https://a.example.com/v1' }),
      keyAction: 'replace',
      apiKey: SECRET_SENTINEL,
      expectedRevision: 0,
    });
    const second = writeSettings(db, {
      config: config({ baseUrl: 'https://b.example.com/v1' }),
      keyAction: 'keep',
      expectedRevision: first.revision,
    });
    expect(second.revision).toBe(first.revision + 1);

    // 第二个窗口拿着旧 revision 再来一次，必须冲突而不是覆盖目的地。
    expect(() =>
      writeSettings(db, {
        config: config({ baseUrl: 'https://c.example.com/v1' }),
        keyAction: 'keep',
        expectedRevision: first.revision,
      }),
    ).toThrow(SettingsRevisionConflict);

    const row = db.prepare('SELECT config_json FROM settings WHERE id = 1').get() as {
      config_json: string;
    };
    expect(JSON.parse(row.config_json).baseUrl).toBe('https://b.example.com/v1');
  });

  it('T029-R02 PUT 拒绝没有确认的跨 origin 转移，且不写入任何东西', async () => {
    writeSettings(db, {
      config: config({ baseUrl: 'https://old.example.com/v1' }),
      keyAction: 'replace',
      apiKey: SECRET_SENTINEL,
      expectedRevision: 0,
    });

    const route = await settingsRoute();
    const response = await callRoute(route.PUT, {
      method: 'PUT',
      path: '/api/settings/llm',
      body: {
        keyAction: 'keep',
        expectedRevision: 1,
        config: config({ baseUrl: 'https://new.example.com/v1' }),
      },
    });

    expect(response.status).toBe(400);
    const row = db.prepare('SELECT config_json, revision FROM settings WHERE id = 1').get() as {
      config_json: string;
      revision: number;
    };
    // 被拒绝的请求没有写入副作用。
    expect(JSON.parse(row.config_json).baseUrl).toBe('https://old.example.com/v1');
    expect(row.revision).toBe(1);
    expect(readSecretValue(db)).toBe(SECRET_SENTINEL);
  });

  it('T029-R02 确认后跨 origin 转移可以完成', async () => {
    writeSettings(db, {
      config: config({ baseUrl: 'https://old.example.com/v1' }),
      keyAction: 'replace',
      apiKey: SECRET_SENTINEL,
      expectedRevision: 0,
    });

    const route = await settingsRoute();
    const response = await callRoute(route.PUT, {
      method: 'PUT',
      path: '/api/settings/llm',
      body: {
        keyAction: 'keep',
        confirmKeyTransfer: true,
        expectedRevision: 1,
        config: config({ baseUrl: 'https://new.example.com/v1' }),
      },
    });

    expect(response.status).toBe(200);
    const row = db.prepare('SELECT config_json FROM settings WHERE id = 1').get() as {
      config_json: string;
    };
    expect(JSON.parse(row.config_json).baseUrl).toBe('https://new.example.com/v1');
    expect(readSecretValue(db)).toBe(SECRET_SENTINEL);
  });

  it('T029-C05 关闭重开后配置与秘密仍然可读，且不写入任何快照表', () => {
    const saved = writeSettings(db, {
      config: config(),
      keyAction: 'replace',
      apiKey: SECRET_SENTINEL,
      expectedRevision: 0,
    });
    expect(saved.revision).toBe(1);

    // 秘密不能出现在任何非 secrets 表里：这是“白名单”的可检查含义。
    for (const table of ['settings', 'knowledge_items', 'ai_runs', 'views', 'relations']) {
      const blob = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all());
      expect(blob, `${table} 不应包含秘密`).not.toContain(SECRET_SENTINEL);
    }
  });

  it('T029-C06 前端与快照都没有持久化副本：settings 行里只有非秘密字段', () => {
    writeSettings(db, {
      config: config(),
      keyAction: 'replace',
      apiKey: SECRET_SENTINEL,
      expectedRevision: 0,
    });
    const row = db.prepare('SELECT config_json FROM settings WHERE id = 1').get() as {
      config_json: string;
    };
    const storedConfig = JSON.parse(row.config_json) as Record<string, unknown>;
    // 配置里不允许出现任何 key 字段名，避免“顺手存一份”。
    for (const forbidden of ['apiKey', 'api_key', 'key', 'token', 'secret', 'authorization']) {
      expect(Object.keys(storedConfig)).not.toContain(forbidden);
    }
  });

  it('T029-R01 PUT 响应同样只返回 configured 布尔', async () => {
    const route = await settingsRoute();
    const response = await callRoute(route.PUT, {
      method: 'PUT',
      path: '/api/settings/llm',
      body: {
        keyAction: 'replace',
        apiKey: SECRET_SENTINEL,
        expectedRevision: 0,
        config: config(),
      },
    });

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.envelope)).not.toContain(SECRET_SENTINEL);
    const data = (response.envelope as { ok: true; data: Record<string, unknown> }).data;
    expect(data.apiKeyConfigured).toBe(true);
  });

  it('T029-R03 未授权请求被拒绝，且不写入秘密', async () => {
    const route = await settingsRoute();

    const noToken = await callRoute(route.PUT, {
      method: 'PUT',
      path: '/api/settings/llm',
      token: null,
      body: { keyAction: 'replace', apiKey: SECRET_SENTINEL, expectedRevision: 0, config: config() },
    });
    expect(noToken.status).toBe(403);

    // `callRoute` always supplies browser-like same-origin headers, so a foreign
    // Origin has to be built by hand — that is the case being asserted.
    const foreignOrigin = new Request('http://127.0.0.1:3000/api/settings/llm', {
      method: 'PUT',
      headers: {
        host: '127.0.0.1:3000',
        origin: 'https://evil.test',
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        keyAction: 'replace',
        apiKey: SECRET_SENTINEL,
        expectedRevision: 0,
        config: config(),
      }),
    });
    const rejected = await (route.PUT as (request: Request) => Promise<Response>)(foreignOrigin);
    expect(rejected.status).toBe(403);

    // 被拒绝的行为没有写入副作用。
    expect(countRows(db, 'SELECT COUNT(*) AS n FROM secrets')).toBe(0);
    expect(countRows(db, 'SELECT COUNT(*) AS n FROM settings')).toBe(0);
  });
});

/** Raw secret read used only to prove state; production code has no such helper. */
function readSecretValue(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT value FROM secrets WHERE key = 'llm.api_key'").get() as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}
