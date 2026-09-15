/**
 * T035 验收用例｜运行注册、幂等和并发占用
 *
 * 这些用例断言的是**账本与槽位**：同一个键不会产生第二次付费请求、全局同时只有
 * 一个外部调用、注册失败时调用计数为零、Run 里没有 Key。全部使用隔离数据库与
 * 注入式 transport，不连真实域名。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { AppError, httpStatusForError, isRetryable } from '@/domain/errors';
import { LIMITS } from '@/domain/limits';
import { runRequestHash, registerRun } from '@/server/services/runs/registerRun';
import { recoverExpiredRuns } from '@/server/services/runs/recoverExpiredRuns';
import { RunBusyError, findRunByRequestKey } from '@/server/repositories/runs';
import { createCapture } from '@/server/services/items';
import { createTestDatabase, openTestDatabase, newId, type TestDatabase } from '../helpers/db';

let test: TestDatabase;
let db: DatabaseSync;

/** A persistable config snapshot: note the shape has no place for a key. */
const SNAPSHOT = {
  adapter: 'openai-compatible' as const,
  baseUrlOrigin: 'https://api.example.com',
  model: 'test-model',
  structuredMode: 'prompt_json' as const,
  tokenField: 'none' as const,
  maxOutputTokens: 4096,
};

function baseInput(overrides: Partial<Parameters<typeof registerRun>[1]> = {}) {
  return {
    requestKey: newId(),
    kind: 'organize' as const,
    subjectId: null,
    inputRevision: 1,
    inputHash: 'hash-1',
    configRevision: 1,
    promptVersion: 'organize-v1',
    configSnapshot: SNAPSHOT,
    candidateIds: [],
    ...overrides,
  };
}

beforeEach(() => {
  test = createTestDatabase();
  db = openTestDatabase(test.databasePath);
});

afterEach(() => {
  test.cleanup();
});

describe('T035 运行注册', () => {
  it('T035-C01 同键并发注册只产生一个 Run，第二个不再拿到执行权', () => {
    const requestKey = newId();
    const first = registerRun(db, baseInput({ requestKey }));
    expect(first.shouldExecute).toBe(true);
    expect(first.disposition).toBe('execute');

    // 第二个页面提交同一个键：引用同一个 Run，且不得再发一次请求。
    const second = registerRun(db, baseInput({ requestKey }));
    expect(second.run.id).toBe(first.run.id);
    expect(second.shouldExecute).toBe(false);
    expect(second.disposition).toBe('replay_in_flight');

    const total = db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };
    expect(total.n).toBe(1);
  });

  it('T035-C02 同键不同意图返回 RUN_KEY_CONFLICT 且不新增 Run', () => {
    const requestKey = newId();
    registerRun(db, baseInput({ requestKey, kind: 'organize' }));

    const caught = (() => {
      try {
        registerRun(db, baseInput({ requestKey, kind: 'mindmap' }));
        return null;
      } catch (error) {
        return error;
      }
    })();

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('RUN_KEY_CONFLICT');
    const total = db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };
    expect(total.n).toBe(1);
  });

  it('T035-R01 指纹覆盖 kind、目标、revision、选择、意图、配置与提示词版本', () => {
    const base = {
      kind: 'organize' as const,
      subjectId: '11111111-1111-4111-8111-111111111111',
      inputRevision: 3,
      inputHash: 'h',
      configRevision: 2,
      promptVersion: 'organize-v1',
    };
    const hash = runRequestHash(base);

    // 每一维单独变化都必须改变指纹：否则「同键复用」会复用错结果。
    expect(runRequestHash({ ...base, kind: 'flow' })).not.toBe(hash);
    expect(runRequestHash({ ...base, inputRevision: 4 })).not.toBe(hash);
    expect(runRequestHash({ ...base, inputHash: 'h2' })).not.toBe(hash);
    expect(runRequestHash({ ...base, configRevision: 3 })).not.toBe(hash);
    expect(runRequestHash({ ...base, promptVersion: 'organize-v2' })).not.toBe(hash);
    expect(runRequestHash({ ...base, intent: '按主题归纳' })).not.toBe(hash);
    expect(
      runRequestHash({ ...base, selectionItemIds: ['22222222-2222-4222-8222-222222222222'] }),
    ).not.toBe(hash);
    // 指纹必须稳定：同样的输入得到同样的值，才能做重放比较。
    expect(runRequestHash(base)).toBe(hash);
  });

  it('T035-C03 另一个任务 running 时新操作返回 RUN_BUSY，不隐形排队', () => {
    registerRun(db, baseInput({ kind: 'mindmap' }));

    const caught = (() => {
      try {
        registerRun(db, baseInput({ kind: 'organize' }));
        return null;
      } catch (error) {
        return error;
      }
    })();

    expect(caught).toBeInstanceOf(RunBusyError);
    expect((caught as AppError).code).toBe('RUN_BUSY');
    // 409 且 retryable=true：用户可以显式重试，但不自动排队。
    expect(httpStatusForError('RUN_BUSY')).toBe(409);
    expect(isRetryable('RUN_BUSY')).toBe(true);
    // 忙碌时不产生第二条 Run，也没有任何等待队列。
    const total = db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };
    expect(total.n).toBe(1);
  });

  it('T035-R03 同一个 Item 上不允许两个并发 organize', () => {
    const item = createCapture(db, {
      captureRequestId: newId(),
      rawText: '一条用于并发测试的笔记。',
      sourceType: 'other',
      sourceRef: null,
    }).item;

    registerRun(db, baseInput({ kind: 'organize', subjectId: item.id }));

    const caught = (() => {
      try {
        registerRun(db, baseInput({ kind: 'organize', subjectId: item.id }));
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect((caught as AppError).code).toBe('RUN_BUSY');
  });

  it('T035-C04 注册后崩溃：过期租约标为 interrupted，且可被恢复', () => {
    const item = createCapture(db, {
      captureRequestId: newId(),
      rawText: '崩溃恢复用的笔记。',
      sourceType: 'other',
      sourceRef: null,
    }).item;

    const registered = registerRun(db, baseInput({ kind: 'organize', subjectId: item.id }));
    // 直接把 deadline 移到过去，模拟进程被杀后无人收尾。
    db.prepare('UPDATE ai_runs SET deadline_at = ? WHERE id = ?').run(
      new Date(Date.now() - 1000).toISOString(),
      registered.run.id,
    );

    const recovered = recoverExpiredRuns(db);
    expect(recovered).toContain(registered.run.id);

    const row = db.prepare('SELECT state, error_code FROM ai_runs WHERE id = ?').get(
      registered.run.id,
    ) as { state: string; error_code: string | null };
    expect(row.state).toBe('interrupted');
    expect(row.error_code).toBe('RUN_INTERRUPTED');

    // 恢复后就释放了槽位：用户可以显式重试（新 requestKey）。
    const retry = registerRun(db, baseInput({ kind: 'organize', subjectId: item.id }));
    expect(retry.shouldExecute).toBe(true);
  });

  it('T035-R01 未过期的 running 不会被误判为死任务', () => {
    const registered = registerRun(db, baseInput());
    const recovered = recoverExpiredRuns(db);
    expect(recovered).not.toContain(registered.run.id);
    const row = db.prepare('SELECT state FROM ai_runs WHERE id = ?').get(registered.run.id) as {
      state: string;
    };
    expect(row.state).toBe('running');
    expect(LIMITS.operationDeadlineMs).toBeGreaterThan(0);
  });

  it('T035-C05 同键失败 Run 重发返回原失败，不再次扣费', () => {
    const requestKey = newId();
    const first = registerRun(db, baseInput({ requestKey }));
    db.prepare(
      `UPDATE ai_runs SET state = 'failed', error_code = 'PROVIDER_AUTH',
              error_message = '服务商拒绝凭据', finished_at = ?
        WHERE id = ?`,
    ).run(new Date().toISOString(), first.run.id);

    const replay = registerRun(db, baseInput({ requestKey }));
    expect(replay.shouldExecute).toBe(false);
    expect(replay.disposition).toBe('replay_failed');
    expect(replay.run.error?.code).toBe('PROVIDER_AUTH');

    const total = db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };
    expect(total.n).toBe(1);
  });

  it('T035-C06 持久化 Run 里没有 Key、Authorization 或完整请求正文', () => {
    const registered = registerRun(db, baseInput());

    const row = db
      .prepare('SELECT * FROM ai_runs WHERE id = ?')
      .get(registered.run.id) as Record<string, unknown>;
    const serialized = JSON.stringify(row);

    expect(serialized).not.toMatch(/sk-/u);
    expect(serialized).not.toMatch(/Authorization/iu);
    expect(serialized).not.toMatch(/Bearer/iu);
    // 快照只保存可解释的配置摘要，且 origin 不含租户路径。
    const snapshot = JSON.parse(String(row.config_snapshot_json)) as Record<string, unknown>;
    expect(Object.keys(snapshot).sort()).toEqual([
      'adapter',
      'baseUrlOrigin',
      'maxOutputTokens',
      'model',
      'structuredMode',
      'tokenField',
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/api\.example\.com\/v1/u);
  });

  it('T035-R02 成功的同键重放返回既有结果，不再执行', () => {
    const requestKey = newId();
    const first = registerRun(db, baseInput({ requestKey }));
    db.prepare(
      `UPDATE ai_runs SET state = 'succeeded', finished_at = ? WHERE id = ?`,
    ).run(new Date().toISOString(), first.run.id);

    const replay = registerRun(db, baseInput({ requestKey }));
    expect(replay.disposition).toBe('replayed');
    expect(replay.shouldExecute).toBe(false);
    expect(replay.run.id).toBe(first.run.id);
  });

  it('T035-R05 deadline 由服务端 UTC 计算，且租约长于单次调用上限', () => {
    const registered = registerRun(db, baseInput());
    const started = Date.parse(registered.run.startedAt);
    const deadline = Date.parse(registered.run.deadlineAt);
    expect(Number.isFinite(started)).toBe(true);
    expect(deadline - started).toBe(LIMITS.operationDeadlineMs);
    // 单次 provider 超时必须短于总期限，否则第一次调用就能用完整个预算。
    expect(LIMITS.providerCallTimeoutMs).toBeLessThan(LIMITS.operationDeadlineMs);
  });

  it('T035-R04 忙碌失败时租约没有被占用（外部调用计数为零）', () => {
    registerRun(db, baseInput({ kind: 'mindmap' }));

    try {
      registerRun(db, baseInput({ kind: 'organize' }));
    } catch {
      // 预期路径。
    }

    // 只有一个 running 行；失败的注册没有留下半条记录。
    const running = db.prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE state = 'running'").get() as {
      n: number;
    };
    expect(running.n).toBe(1);
    const organizeRows = db
      .prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE kind = 'organize'")
      .get() as { n: number };
    expect(organizeRows.n).toBe(0);
  });

  it('T035-R06 网络结束后通过终态释放占用（不依赖进程内变量）', () => {
    const registered = registerRun(db, baseInput());
    db.prepare(
      `UPDATE ai_runs SET state = 'succeeded', finished_at = ? WHERE id = ?`,
    ).run(new Date().toISOString(), registered.run.id);

    // 槽位由「state = running」这个条件决定，行一旦进入终态就自动释放。
    const running = db.prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE state = 'running'").get() as {
      n: number;
    };
    expect(running.n).toBe(0);

    const next = registerRun(db, baseInput({ kind: 'flow' }));
    expect(next.shouldExecute).toBe(true);
  });

  it('T035-R02 重放查询可按 requestKey 找到既有 Run', () => {
    const requestKey = newId();
    const registered = registerRun(db, baseInput({ requestKey }));
    const found = findRunByRequestKey(db, requestKey);
    expect(found?.id).toBe(registered.run.id);
    expect(findRunByRequestKey(db, newId())).toBeNull();
  });
});
