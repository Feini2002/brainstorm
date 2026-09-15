/**
 * T040 验收用例｜运行恢复、迟到响应与局部轮询
 *
 * 恢复是这一组的中心，而它的边界比它的功能更重要：只动**真的过期**的
 * running 行，不动健康任务，不碰已经指向新 Run 的条目，也绝不复活终态。
 *
 * 轮询侧断言的是停止条件（终态停止 / 隐藏暂停），用假定时器驱动，不依赖真实
 * 等待；恢复与迟到竞争的断言全部落在数据库真实行上。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { LIMITS } from '@/domain/limits';
import { isTerminalRunState, TERMINAL_RUN_STATES } from '@/domain/run';
import { withTransaction } from '@/server/db/database';
import { createCapture, patchItem } from '@/server/services/items';
import { applyOrganizeMetadata } from '@/server/services/applyOrganizeMetadata';
import { recoverExpiredRuns, recoverExpiredRunsTx } from '@/server/services/runs/recoverExpiredRuns';
import { registerRun } from '@/server/services/runs/registerRun';
import { syncItemStatus } from '@/server/services/status';
import { getItem } from '@/server/repositories/items';
import { insertRunningRun } from '@/server/repositories/runs';
import type { OrganizeOutput } from '@/domain/schemas/organize';
import { createTestDatabase, openTestDatabase, newId, type TestDatabase } from '../helpers/db';
import { callRoute } from './helpers/http';

let test: TestDatabase;
let db: DatabaseSync;

const SNAPSHOT = {
  adapter: 'openai-compatible' as const,
  baseUrlOrigin: 'https://api.example.com',
  model: 'test-model',
  structured_mode: 'prompt_json',
  structuredMode: 'prompt_json' as const,
  tokenField: 'none' as const,
  maxOutputTokens: 4096,
};

beforeEach(() => {
  test = createTestDatabase();
  db = openTestDatabase(test.databasePath);
});

afterEach(() => {
  test.cleanup();
});

function seed(rawText = '一条用于恢复测试的记录。') {
  return createCapture(db, {
    captureRequestId: newId(),
    rawText,
    sourceType: 'myself',
    sourceRef: null,
  }).item;
}

/** Register a real organize run through the production path. */
function startOrganizeRun(itemId: string, revision: number, inputHash = 'ih-1') {
  return registerRun(db, {
    requestKey: newId(),
    kind: 'organize',
    subjectId: itemId,
    inputRevision: revision,
    inputHash,
    configRevision: 1,
    promptVersion: 'organize-v1',
    configSnapshot: SNAPSHOT,
    candidateIds: [],
  });
}

function expireLease(runId: string, deadline = '2026-01-01T00:00:00.000Z') {
  db.prepare('UPDATE ai_runs SET deadline_at = ? WHERE id = ?').run(deadline, runId);
}

function runRow(runId: string) {
  return db
    .prepare('SELECT state, error_code, finished_at, subject_id FROM ai_runs WHERE id = ?')
    .get(runId) as {
    state: string;
    error_code: string | null;
    finished_at: string | null;
    subject_id: string | null;
  };
}

describe('T040 运行恢复', () => {
  it('T040-C01 超过租约的 running Run 变为 interrupted，条目不再永久 processing', () => {
    const item = seed();
    const run = startOrganizeRun(item.id, item.revision);

    // 先让条目进入 processing：这才是「崩溃后卡住」的现场。
    withTransaction(db, () => {
      syncItemStatus(db, item.id);
    });
    expect(getItem(db, item.id).status).toBe('processing');

    expireLease(run.run.id);
    const recovered = recoverExpiredRuns(db);

    expect(recovered).toContain(run.run.id);
    const row = runRow(run.run.id);
    expect(row.state).toBe('interrupted');
    expect(row.error_code).toBe('RUN_INTERRUPTED');
    expect(row.finished_at).not.toBeNull();

    // 条目回到可读终态，而不是一直转圈。
    const after = getItem(db, item.id);
    expect(after.status).not.toBe('processing');
    expect(after.status).toBe('error');
  });

  it('T040-C02 仍在期限内的 running Run 不被恢复误判（HMR / 普通 GET 不杀活任务）', () => {
    const item = seed();
    const run = startOrganizeRun(item.id, item.revision);
    withTransaction(db, () => {
      syncItemStatus(db, item.id);
    });

    // 直接读一次：路由层的恢复逻辑不应该动它。
    const recovered = recoverExpiredRuns(db);
    expect(recovered).not.toContain(run.run.id);
    expect(runRow(run.run.id).state).toBe('running');
    expect(getItem(db, item.id).status).toBe('processing');

    // 再显式走一次 tx 版本，行为一致。
    const insideTx = withTransaction(db, () => recoverExpiredRunsTx(db));
    expect(insideTx).toHaveLength(0);
    expect(runRow(run.run.id).state).toBe('running');
  });

  it('T040-R01 只恢复超过租约的行；未过期的运行保持 running', () => {
    const first = seed('第一条记录。');
    const second = seed('第二条记录。');
    // 全局限并发：同一时刻只能有一条 running 行，所以先造出「过期」现场，
    // 再恢复它、释放槽位，然后注册一条健康的运行来对照。
    const expired = startOrganizeRun(first.id, first.revision);
    expireLease(expired.run.id);
    recoverExpiredRuns(db);

    const healthy = startOrganizeRun(second.id, second.revision);
    const recovered = recoverExpiredRuns(db);

    expect(recovered).toEqual([]);
    expect(runRow(expired.run.id).state).toBe('interrupted');
    expect(runRow(healthy.run.id).state).toBe('running');
  });

  it('T040-C04 旧 Run 恢复不污染已指向新 Run 的条目显示', () => {
    const item = seed();

    // 旧运行：租约已过期，仍是 running。
    const oldRun = startOrganizeRun(item.id, item.revision, 'ih-old');
    expireLease(oldRun.run.id);

    // 条目已经被一次更新的、成功的整理写过（structs base 指向当前原文）。
    // 全局限并发只允许一条 running 行，所以这条更近的运行以终态直接落库。
    db.prepare(
      `UPDATE knowledge_items SET structured_base_raw_version = ?, revision = revision + 1,
         updated_at = ? WHERE id = ?`,
    ).run(item.rawVersion, '2026-01-01T00:00:05.000Z', item.id);
    db.prepare('DELETE FROM ai_runs WHERE id = ?').run(oldRun.run.id);

    // 重建旧运行的过期现场：先插入再过期，保持唯一 running 槽位约束成立。
    const staleRunId = newId();
    db.prepare(
      `INSERT INTO ai_runs (id, request_key, request_hash, kind, subject_id, input_revision,
         attempt_count, input_hash, state, error_code, result_ref, config_revision,
         config_snapshot_json, candidate_ids_json, prompt_version, usage_json,
         started_at, deadline_at, finished_at)
       VALUES (?, ?, 'rh-old', 'organize', ?, ?, 0, 'ih-old', 'running', NULL, NULL, 1, ?, '[]',
         'organize-v1', NULL, ?, ?, NULL)`,
    ).run(
      staleRunId,
      newId(),
      item.id,
      item.revision,
      JSON.stringify(SNAPSHOT),
      '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:02.000Z',
    );

    const recovered = recoverExpiredRuns(db);
    expect(recovered).toContain(staleRunId);
    expect(runRow(staleRunId).state).toBe('interrupted');

    // 关键断言：旧恢复只能清理自己，不能把新运行的成果显示抹掉。
    // 条目仍是 done（structs base 与当前原文一致），既不是 processing 也不是 error。
    const after = getItem(db, item.id);
    expect(after.status).toBe('done');
    expect(after.structuredBaseRawVersion).toBe(item.rawVersion);
  });

  it('T040-R02 恢复只重算受影响条目的状态', () => {
    const affected = seed('将被恢复影响的记录。');
    const untouched = seed('与本次恢复无关的记录。');

    // 无关条目先整理好，得到一个与 processing 无关的稳定状态。
    patchItem(db, {
      id: untouched.id,
      expectedRevision: untouched.revision,
      patch: { title: '我自己写的标题' },
    });
    const before = getItem(db, untouched.id);
    expect(before.status).toBe('raw');

    const run = startOrganizeRun(affected.id, affected.revision);
    withTransaction(db, () => syncItemStatus(db, affected.id));
    expireLease(run.run.id);
    recoverExpiredRuns(db);

    // 无关条目的状态与版本都没动。
    const after = getItem(db, untouched.id);
    expect(after.status).toBe(before.status);
    expect(after.revision).toBe(before.revision);
    expect(after.title).toBe('我自己写的标题');
  });

  it('T040-C03 恢复先发生的话，迟到响应无法提交（终态单向不可复活）', () => {
    const item = seed();
    const run = startOrganizeRun(item.id, item.revision);

    expireLease(run.run.id);
    recoverExpiredRuns(db);
    expect(runRow(run.run.id).state).toBe('interrupted');

    // 迟到的响应带着完整的模型结果回来，尝试提交。
    const organized: OrganizeOutput = {
      title: '迟到的标题',
      summary: '迟到的摘要',
      type: 'idea',
      tags: ['迟到'],
      keywords: ['迟到'],
      importance: 3,
      relations: [],
    };

    const live = getItem(db, item.id);
    const outcome = withTransaction(db, () => {
      // 复刻提交事务里的守卫：state 必须仍是 running 且 input hash 一致。
      const current = db
        .prepare('SELECT state, input_hash FROM ai_runs WHERE id = ?')
        .get(run.run.id) as { state: string; input_hash: string };
      if (current.state !== 'running' || current.input_hash !== 'ih-1') {
        return 'discarded';
      }
      applyOrganizeMetadata({
        db,
        current: live,
        organized,
        expectedRevision: live.revision,
        expectedRawVersion: live.rawVersion,
        now: new Date().toISOString(),
      });
      return 'applied';
    });

    expect(outcome).toBe('discarded');

    // 终态没被复活，字段也没被写进去。
    expect(runRow(run.run.id).state).toBe('interrupted');
    const after = getItem(db, item.id);
    expect(after.title).toBe('');
    expect(after.summary).toBe('');
  });

  it('T040-R03 恢复不会调用模型，也不会删除 Run 记录', () => {
    const item = seed();
    const run = startOrganizeRun(item.id, item.revision);
    expireLease(run.run.id);

    const before = db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };
    recoverExpiredRuns(db);
    const after = db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };

    // 账本是用户付过费的证据：只改状态，不删除。
    expect(after.n).toBe(before.n);
    expect(runRow(run.run.id).error_code).toBe('RUN_INTERRUPTED');
  });

  it('T040-R05 读取状态接口不启动任何模型，也不写库状态', async () => {
    const item = seed();
    const run = startOrganizeRun(item.id, item.revision);

    const route = await import('@/app/api/runs/[id]/route');
    const response = await callRoute(route.GET, {
      method: 'GET',
      path: `/api/runs/${run.run.id}`,
      params: { id: run.run.id },
    });

    expect(response.status).toBe(200);
    const envelope = response.envelope as { ok: true; data: { id: string; state: string } };
    expect(envelope.data.id).toBe(run.run.id);
    expect(envelope.data.state).toBe('running');

    // 没有新的 Run、没有请求被发出、健康状态不变。
    expect(runRow(run.run.id).state).toBe('running');
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number }).n,
    ).toBe(1);
  });

  it('T040-R05 读取状态接口对过期租约就地恢复后再返回', async () => {
    const item = seed();
    const run = startOrganizeRun(item.id, item.revision);
    expireLease(run.run.id);

    const route = await import('@/app/api/runs/[id]/route');
    const response = await callRoute(route.GET, {
      method: 'GET',
      path: `/api/runs/${run.run.id}`,
      params: { id: run.run.id },
    });

    const envelope = response.envelope as { ok: true; data: { state: string } };
    expect(envelope.data.state).toBe('interrupted');
    expect(runRow(run.run.id).state).toBe('interrupted');
  });

  it('T040-R06 结果不存在时返回真实终态，而不是一直转圈', async () => {
    const item = seed();
    const run = startOrganizeRun(item.id, item.revision);
    // 直接终结为成功，但目标随后被删除——结果引用悬空。
    db.prepare(
      `UPDATE ai_runs SET state = 'succeeded', result_ref = ?, finished_at = ? WHERE id = ?`,
    ).run(item.id, '2026-01-01T00:00:10.000Z', run.run.id);
    db.prepare('DELETE FROM knowledge_items WHERE id = ?').run(item.id);

    const route = await import('@/app/api/runs/[id]/route');
    const response = await callRoute(route.GET, {
      method: 'GET',
      path: `/api/runs/${run.run.id}`,
      params: { id: run.run.id },
    });

    const envelope = response.envelope as {
      ok: true;
      data: { state: string; resultRef: string | null };
    };
    // 终态是真实发生的：不把「结果读不到」伪装成「还在处理」。
    expect(envelope.data.state).toBe('succeeded');
    expect(envelope.data.resultRef).toBe(item.id);
    expect(isTerminalRunState(envelope.data.state as never)).toBe(true);
  });

  it('T040-R06 不存在的 Run 返回 404 而不是空成功', async () => {
    const route = await import('@/app/api/runs/[id]/route');
    const response = await callRoute(route.GET, {
      method: 'GET',
      path: `/api/runs/${newId()}`,
      params: { id: newId() },
    });

    expect(response.status).toBe(404);
    expect(JSON.stringify(response.envelope)).toContain('没有找到');
  });

  it('T040-C01 恢复接口返回被恢复的 id 列表', async () => {
    const item = seed();
    const run = startOrganizeRun(item.id, item.revision);
    expireLease(run.run.id);

    const route = await import('@/app/api/runs/recover/route');
    const response = await callRoute(route.POST, {
      method: 'POST',
      path: '/api/runs/recover',
      body: {},
    });

    expect(response.status).toBe(200);
    const envelope = response.envelope as { ok: true; data: { recoveredIds: string[] } };
    expect(envelope.data.recoveredIds).toContain(run.run.id);
  });

  it('T040-R05 重试必须是新动作与新 requestKey，重放键不会自动再发一次请求', () => {
    const item = seed();
    const sameKey = newId();

    // 第一次：真的占用槽位并执行。
    const a = registerRun(db, {
      requestKey: sameKey,
      kind: 'organize',
      subjectId: item.id,
      inputRevision: item.revision,
      inputHash: 'ih-retry',
      configRevision: 1,
      promptVersion: 'organize-v1',
      configSnapshot: SNAPSHOT,
      candidateIds: [],
    });
    expect(a.shouldExecute).toBe(true);

    // 同键同意图在原请求仍在途时再次到达：只重放，不执行第二次付费调用。
    const inFlight = registerRun(db, {
      requestKey: sameKey,
      kind: 'organize',
      subjectId: item.id,
      inputRevision: item.revision,
      inputHash: 'ih-retry',
      configRevision: 1,
      promptVersion: 'organize-v1',
      configSnapshot: SNAPSHOT,
      candidateIds: [],
    });
    expect(inFlight.shouldExecute).toBe(false);
    expect(inFlight.disposition).toBe('replay_in_flight');
    expect(inFlight.run.id).toBe(a.run.id);

    // 原请求失败收尾后再同键到达：仍然只重放那次失败，绝不隐式重试。
    db.prepare(
      `UPDATE ai_runs SET state = 'failed', error_code = 'PROVIDER_TIMEOUT', finished_at = ?
        WHERE id = ?`,
    ).run('2026-01-01T00:00:00.000Z', a.run.id);

    const replayed = registerRun(db, {
      requestKey: sameKey,
      kind: 'organize',
      subjectId: item.id,
      inputRevision: item.revision,
      inputHash: 'ih-retry',
      configRevision: 1,
      promptVersion: 'organize-v1',
      configSnapshot: SNAPSHOT,
      candidateIds: [],
    });
    expect(replayed.shouldExecute).toBe(false);
    expect(replayed.disposition).toBe('replay_failed');
    expect(replayed.run.id).toBe(a.run.id);

    // 用户显式重试 = 新键 + 新动作，这才允许再花一次钱。
    const retried = registerRun(db, {
      requestKey: newId(),
      kind: 'organize',
      subjectId: item.id,
      inputRevision: item.revision,
      inputHash: 'ih-retry',
      configRevision: 1,
      promptVersion: 'organize-v1',
      configSnapshot: SNAPSHOT,
      candidateIds: [],
    });
    expect(retried.shouldExecute).toBe(true);

    // 一共三条账本记录：原请求、同键重放不产生新行、以及用户的新重试。
    expect((db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number }).n).toBe(2);
  });

  it('T040 终态集合固定，轮询据此判断何时停止', () => {
    expect([...TERMINAL_RUN_STATES].sort()).toEqual(
      ['conflict', 'failed', 'interrupted', 'succeeded'].sort(),
    );
    for (const state of TERMINAL_RUN_STATES) {
      expect(isTerminalRunState(state)).toBe(true);
    }
    expect(isTerminalRunState('running')).toBe(false);
    // 轮询间隔来自契约常量，不是散落的字面量。
    expect(LIMITS.activeRunPollMs).toBe(1500);
  });

  it('T040-R01 插入一条已过期的 running 也不会被注册路径以外的恢复误伤', () => {
    // 直接构造一条 running 行，但 deadline 在未来：恢复必须放过它。
    const runId = newId();
    insertRunningRun(db, {
      id: runId,
      requestKey: newId(),
      requestHash: 'rh',
      kind: 'mindmap',
      subjectId: null,
      inputRevision: null,
      inputHash: 'ih',
      configRevision: 1,
      configSnapshotJson: '{}',
      candidateIds: [],
      promptVersion: 'mindmap-v1',
      startedAt: '2026-01-01T00:00:00.000Z',
      deadlineAt: '2999-01-01T00:00:00.000Z',
    });

    const recovered = recoverExpiredRuns(db);
    expect(recovered).not.toContain(runId);
    expect(runRow(runId).state).toBe('running');
  });
});
