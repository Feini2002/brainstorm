/**
 * T041 验收用例｜诊断读取的服务与路由层
 *
 * 纯领域层的断言在 `tests/unit/run-diagnostics.test.ts`；这里只测真实 SQLite 行
 * 与真实路由：读取是否改变状态、是否按账本还原次数、是否把秘密或原文带出响应。
 *
 * 关键负向要求：这不是“写一段日志”，而是“读一次不产生任何副作用”。因此每个
 * 用例都同时断言目标结果与不该发生的改动。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { LIMITS } from '@/domain/limits';
import { readApiKey, writeSettings } from '@/server/repositories/settings';
import { registerRun } from '@/server/services/runs/registerRun';
import { getRunDiagnostics } from '@/server/services/getRunDiagnostics';
import { createTestDatabase, openTestDatabase, newId, type TestDatabase } from '../helpers/db';
import { callRoute } from './helpers/http';

/** An obvious non-credential marker; every produced artifact is scanned for it. */
const SECRET = 'sk-test-DIAGCANARY-0987654321fedcba';

/** Private note text; the response must never contain it. */
const PRIVATE_TEXT = '我的私人笔记：银行卡号 6222 0000 1111 2222。';

const SNAPSHOT = {
  adapter: 'openai-compatible' as const,
  baseUrlOrigin: 'https://api.example.com',
  model: 'test-model',
  structuredMode: 'prompt_json' as const,
  tokenField: 'none' as const,
  maxOutputTokens: 4096,
};

let test: TestDatabase;
let db: DatabaseSync;

beforeEach(() => {
  test = createTestDatabase();
  db = openTestDatabase(test.databasePath);
});

afterEach(() => {
  test.cleanup();
});

/**
 * Register a run through the production path, then force it into the terminal
 * state the case needs. Using the real registration keeps the row shape honest:
 * the diagnostics reader sees exactly what a real run leaves behind.
 */
function seedRun(
  input: {
    attemptCount?: number;
    usage?: string | null;
    candidateIds?: string[];
    finished?: boolean;
  } = {},
): string {
  const registered = registerRun(db, {
    requestKey: newId(),
    kind: 'organize',
    subjectId: null,
    inputRevision: null,
    inputHash: 'ih-diag',
    configRevision: 1,
    promptVersion: 'organize-v1',
    configSnapshot: SNAPSHOT,
    candidateIds: input.candidateIds ?? [],
  });
  if (input.finished !== false) {
    db.prepare(
      `UPDATE ai_runs SET state = 'succeeded', attempt_count = ?, usage_json = ?, finished_at = ?
        WHERE id = ?`,
    ).run(input.attemptCount ?? 1, input.usage ?? null, '2026-01-01T00:00:05.000Z', registered.run.id);
  } else if (input.attemptCount !== undefined) {
    // A run that is still in flight can already have issued a request; the
    // attempt ledger is what recovery must not erase.
    db.prepare('UPDATE ai_runs SET attempt_count = ? WHERE id = ?').run(
      input.attemptCount,
      registered.run.id,
    );
  }
  return registered.run.id;
}

/** Write a settings row carrying the marker secret, so scans are meaningful. */
function seedSecret(): void {
  writeSettings(db, {
    config: {
      adapter: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
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

describe('T041 服务层', () => {
  it('T041-C01 读取缺失用量时返回未知，且不写库', () => {
    const runId = seedRun({ usage: null });
    const before = db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };

    const diagnostics = getRunDiagnostics(db, runId);
    expect(diagnostics.usage.reported).toBe(false);

    const after = db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };
    expect(after.n).toBe(before.n);
    // 诊断读取不得改变运行状态，也不得替它写一个用量。
    const row = db.prepare('SELECT state, usage_json FROM ai_runs WHERE id = ?').get(runId) as {
      state: string;
      usage_json: string | null;
    };
    expect(row.state).toBe('succeeded');
    expect(row.usage_json).toBeNull();
  });

  it('T041-C02 按账本还原两次请求与一次修复', () => {
    const runId = seedRun({ attemptCount: 2 });
    const diagnostics = getRunDiagnostics(db, runId);
    expect(diagnostics.providerRequestCount).toBe(2);
    expect(diagnostics.repairAttempts).toBe(1);
  });

  it('T041-C03 把存储的 429 还原成限流分类，不推断余额', () => {
    const runId = seedRun();
    db.prepare(
      `UPDATE ai_runs SET state = 'failed', error_code = 'PROVIDER_RATE_LIMIT',
         error_message = '服务商返回 429：稍后再试' WHERE id = ?`,
    ).run(runId);

    const diagnostics = getRunDiagnostics(db, runId);
    expect(diagnostics.error?.category).toBe('rate_limit');
    expect(diagnostics.error?.categoryLabel).toBe('限流或配额');
    // retryable 来自错误码契约，而不是行里一个可能过期的布尔值。
    expect(diagnostics.error?.retryable).toBe(true);
  });

  it('T041-C05 中断的运行给出计费说明，且不因读取而复活', () => {
    // 「中断」是恢复写下的终态：走真实路径（租约过期 -> 读取时恢复），
    // 而不是直接 UPDATE 一个 state，这样断言的是生产行为。
    const runId = seedRun({ attemptCount: 1, finished: false });
    db.prepare('UPDATE ai_runs SET deadline_at = ? WHERE id = ?').run(
      '2026-01-01T00:00:00.000Z',
      runId,
    );

    const diagnostics = getRunDiagnostics(db, runId);
    expect(diagnostics.state).toBe('interrupted');
    expect(diagnostics.billingNote).toContain('可能');
    expect(diagnostics.error?.code).toBe('RUN_INTERRUPTED');
    // 恢复只改状态：终态不会因为再读一次而复活。
    expect(db.prepare('SELECT state FROM ai_runs WHERE id = ?').get(runId)).toEqual({
      state: 'interrupted',
    });
  });

  it('T041-C06 显示实际候选数，而不是契约上限', () => {
    const candidates = Array.from({ length: 30 }, () => newId());
    const runId = seedRun({ candidateIds: candidates });

    const diagnostics = getRunDiagnostics(db, runId);
    expect(diagnostics.candidateCount).toBe(30);
    expect(diagnostics.candidateCount).not.toBe(LIMITS.candidateCount);
    // 契约上限仍是 40：展示的是实际发送量，两者不相等才有意义。
    expect(LIMITS.candidateCount).toBe(40);
  });

  it('T041 读取会就地恢复过期租约，但不删除史册', () => {
    const runId = seedRun({ finished: false });
    db.prepare('UPDATE ai_runs SET deadline_at = ? WHERE id = ?').run(
      '2026-01-01T00:00:00.000Z',
      runId,
    );

    const diagnostics = getRunDiagnostics(db, runId);
    expect(diagnostics.state).toBe('interrupted');
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get()).toEqual({ n: 1 });
  });

  it('T041 诊断读取不触发任何新的模型运行，也不留下 running 槽位', () => {
    const runId = seedRun();
    const before = db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };
    getRunDiagnostics(db, runId);
    getRunDiagnostics(db, runId);
    const after = db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };
    expect(after.n).toBe(before.n);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE state = 'running'").get() as { n: number })
        .n,
    ).toBe(0);
  });

  it('T041 损坏的快照列降级为“未记录”，不让诊断读取整页失败', () => {
    const runId = seedRun();
    // 写一个语法合法但结构不是对象的 JSON：读取必须仍然可用，而不是抛错。
    db.prepare('UPDATE ai_runs SET config_snapshot_json = ? WHERE id = ?').run('[]', runId);

    const diagnostics = getRunDiagnostics(db, runId);
    expect(diagnostics.model).toBe('');
    expect(diagnostics.endpointOrigin).toBe('（未配置）');
    // 其余字段照常可读：一处脏数据不吞掉整份诊断。
    expect(diagnostics.runId).toBe(runId);
    expect(diagnostics.providerRequestCount).toBe(1);
  });

  it('T041 未记录的结束时间不会被当成 0 耗时', () => {
    const runId = seedRun({ finished: false });
    const diagnostics = getRunDiagnostics(db, runId);
    expect(diagnostics.finishedAt).toBeNull();
    expect(diagnostics.durationMs).toBeNull();
  });
});

describe('T041 路由层', () => {
  it('T041-C04 响应里不含秘密与原文，origin 只到主机', async () => {
    seedSecret();
    const runId = seedRun({ candidateIds: [newId()] });

    const route = await import('@/app/api/runs/[id]/diagnostics/route');
    const response = await callRoute(route.GET, {
      method: 'GET',
      path: `/api/runs/${runId}/diagnostics`,
      params: { id: runId },
    });

    expect(response.status).toBe(200);
    const serialized = JSON.stringify(response.envelope);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(PRIVATE_TEXT);
    expect(serialized).not.toContain('银行卡');
    expect(serialized).not.toContain('X-Brain-Token');
    // 快照里的 origin 是允许出现的；完整路径与 query 不行。
    expect(serialized).toContain('https://api.example.com');
    expect(serialized).not.toContain('/v1');
  });

  it('T041-C06 路由返回实际候选数', async () => {
    const runId = seedRun({ candidateIds: Array.from({ length: 30 }, () => newId()) });
    const route = await import('@/app/api/runs/[id]/diagnostics/route');
    const response = await callRoute(route.GET, {
      method: 'GET',
      path: `/api/runs/${runId}/diagnostics`,
      params: { id: runId },
    });

    const envelope = response.envelope as { ok: true; data: { candidateCount: number } };
    expect(envelope.data.candidateCount).toBe(30);
  });

  it('T041-C05 路由把中断状态与计费说明一起返回', async () => {
    const runId = seedRun({ attemptCount: 1, finished: false });
    db.prepare('UPDATE ai_runs SET deadline_at = ? WHERE id = ?').run(
      '2026-01-01T00:00:00.000Z',
      runId,
    );

    const route = await import('@/app/api/runs/[id]/diagnostics/route');
    const response = await callRoute(route.GET, {
      method: 'GET',
      path: `/api/runs/${runId}/diagnostics`,
      params: { id: runId },
    });

    const envelope = response.envelope as {
      ok: true;
      data: { state: string; billingNote: string | null };
    };
    expect(envelope.data.state).toBe('interrupted');
    expect(envelope.data.billingNote).toContain('可能');
  });

  it('T041 对不存在的运行返回 404，而不是空成功', async () => {
    const route = await import('@/app/api/runs/[id]/diagnostics/route');
    const response = await callRoute(route.GET, {
      method: 'GET',
      path: `/api/runs/${newId()}/diagnostics`,
      params: { id: newId() },
    });
    expect(response.status).toBe(404);
  });

  it('T041 缺少本地令牌时读取被拒，不泄漏运行信息', async () => {
    const runId = seedRun();
    const route = await import('@/app/api/runs/[id]/diagnostics/route');
    const response = await callRoute(route.GET, {
      method: 'GET',
      path: `/api/runs/${runId}/diagnostics`,
      params: { id: runId },
      token: null,
    });
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.envelope)).not.toContain(runId);
  });
});
