/**
 * T014 采集幂等与事务边界。
 *
 * 直接驱动 captureItem 服务层与 HTTP 路由，验证「同键同内容重放、同键异内容冲突、
 * 不同键允许重复、被拒绝的请求不产生任何写入」。测试使用隔离数据库，
 * 绝不触碰用户 .data 或任何真实 Key。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

import { configureConnection, getDatasetRevision } from '@/server/db/database';
import { createCapture, CaptureKeyConflictError } from '@/server/services/items';
import { findItemRow, findByCaptureRequestId } from '@/server/repositories/items';
import { AppError } from '@/domain/errors';
import { MAX } from './helpers/limits';
import { createTestDatabase, newId, openTestDatabase, type TestDatabase } from '../helpers/db';

let harness: TestDatabase;
let db: DatabaseSync;
/** Extra connections opened by concurrency cases; closed before the temp dir goes away. */
const extraConnections: DatabaseSync[] = [];

beforeEach(() => {
  harness = createTestDatabase();
  db = openTestDatabase(harness.databasePath);
});

afterEach(() => {
  // Windows keeps an exclusive handle on an open database file; leaving one
  // behind turns cleanup into an EPERM that hides the real assertion failure.
  while (extraConnections.length > 0) {
    try {
      extraConnections.pop()?.close();
    } catch {
      // A connection already closed by the case itself is fine.
    }
  }
  harness.cleanup();
});

function countItems(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM knowledge_items').get() as { n: number };
  return row.n;
}

const baseInput = {
  sourceType: 'other' as const,
  sourceRef: null,
};

describe('T014 采集幂等', () => {
  it('T014-C01 双击提交：同键同内容只产生一条记录，两次响应指向同一 ID', () => {
    const captureRequestId = newId();
    const input = { ...baseInput, captureRequestId, rawText: '双击测试内容' };

    const first = createCapture(db, input);
    const second = createCapture(db, input);

    expect(countItems()).toBe(1);
    expect(second.item.id).toBe(first.item.id);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
  });

  it('T014-C02 响应丢失：重放不再次增加 datasetRevision', () => {
    const captureRequestId = newId();
    const input = { ...baseInput, captureRequestId, rawText: '响应丢失场景' };

    const first = createCapture(db, input);
    const revisionAfterFirst = getDatasetRevision(db);

    const replay = createCapture(db, input);

    expect(replay.item.id).toBe(first.item.id);
    expect(getDatasetRevision(db)).toBe(revisionAfterFirst);
    expect(countItems()).toBe(1);
  });

  it('T014-C03 键冲突：同键异内容返回 409 且原记录不被覆盖', () => {
    const captureRequestId = newId();
    const original = createCapture(db, {
      ...baseInput,
      captureRequestId,
      rawText: '第一版内容',
    });

    let raised: unknown = null;
    try {
      createCapture(db, { ...baseInput, captureRequestId, rawText: '第二版内容' });
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(CaptureKeyConflictError);
    expect((raised as AppError).code).toBe('CAPTURE_KEY_CONFLICT');
    expect(countItems()).toBe(1);
    const stored = findItemRow(db, original.item.id) as Record<string, unknown>;
    expect(stored.raw_text).toBe('第一版内容');
  });

  it('T014-C04 故意重复：两个新键保存同一句话得到两个 ID', () => {
    const text = '这是一句被有意记录两次的话';
    const first = createCapture(db, { ...baseInput, captureRequestId: newId(), rawText: text });
    const second = createCapture(db, {
      ...baseInput,
      captureRequestId: newId(),
      rawText: text,
      sourceType: 'book',
      sourceRef: 'p.12',
    });

    expect(first.item.id).not.toBe(second.item.id);
    expect(countItems()).toBe(2);
    expect(second.item.sourceType).toBe('book');
    expect(second.item.sourceRef).toBe('p.12');
  });

  it('T014-C05 事务失败：原文过长时整次回滚，不留半成功记录', () => {
    // 超出契约长度上限的内容必须在写事务之前被拒绝。
    const tooLong = '字'.repeat(MAX.rawTextCodePoints + 1);
    const before = getDatasetRevision(db);

    let raised: unknown = null;
    try {
      createCapture(db, { ...baseInput, captureRequestId: newId(), rawText: tooLong });
    } catch (error) {
      raised = error;
    }

    expect((raised as AppError).code).toBe('VALIDATION');
    expect(countItems()).toBe(0);
    expect(getDatasetRevision(db)).toBe(before);
  });

  it('T014-R04 初始字段：capturedText 与 rawText 相同，版本为 1，状态为 raw', () => {
    const result = createCapture(db, {
      ...baseInput,
      captureRequestId: newId(),
      rawText: '初始字段检查',
    });

    expect(result.item.capturedText).toBe('初始字段检查');
    expect(result.item.rawText).toBe('初始字段检查');
    expect(result.item.rawVersion).toBe(1);
    expect(result.item.revision).toBe(1);
    expect(result.item.status).toBe('raw');
    // 标题与摘要允许是空字符串，不要求模型先跑过。
    expect(result.item.title).toBe('');
    expect(result.item.summary).toBe('');
    expect(result.item.manualFields).toEqual([]);
  });

  it('T014-R05 写入后 datasetRevision 递增，响应在提交之后才可见', () => {
    const before = getDatasetRevision(db);
    createCapture(db, { ...baseInput, captureRequestId: newId(), rawText: '提交顺序检查' });
    // 提交之后数据库里已经能看到记录且版本已增加。
    expect(getDatasetRevision(db)).toBe(before + 1);
    expect(countItems()).toBe(1);
  });

  it('T014-C06 空白原文被拒绝，且不产生记录', () => {
    let raised: unknown = null;
    try {
      createCapture(db, { ...baseInput, captureRequestId: newId(), rawText: '   \n\t ' });
    } catch (error) {
      raised = error;
    }
    expect((raised as AppError).code).toBe('VALIDATION');
    expect(countItems()).toBe(0);
  });

  it('T014-R02 请求指纹不含服务端生成的时间：同一输入指纹稳定', async () => {
    const { captureRequestHash } = await import('@/server/services/items');
    const input = { ...baseInput, captureRequestId: newId(), rawText: '指纹稳定性' };
    const first = captureRequestHash(input);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = captureRequestHash(input);
    expect(second).toBe(first);
  });

  it('T077-C02 同键同时创建：第二个连接看不到第一次提交时，唯一约束拦住第二条并重放赢家', () => {
    // 这一组补的是 T077-C02「数据库唯一约束应真正参与」。
    // 既有同键用例全是**顺序**调用：第二次在 `findByCaptureRequestId` 就命中了，
    // 永远走不到 `INSERT` 撞唯一约束那一步，`createCapture` 的 catch 分支零驱动。
    //
    // `node:sqlite` 是同步 API，`Promise.all` 包两个同步调用仍然是顺序执行，
    // 所以这里用**两条真实连接**造出确定的交错：连接 B 的第一次查找返回空
    // （它读到的是 A 提交之前的库状态），随后两次 `INSERT` 落在同一条唯一索引上。
    const captureRequestId = newId();
    const input = { ...baseInput, captureRequestId, rawText: '两个标签页同时按下保存' };
    const revisionBefore = getDatasetRevision(db);

    const second = new DatabaseSync(harness.databasePath);
    extraConnections.push(second);
    configureConnection(second);

    const originalPrepare = second.prepare.bind(second);
    let fakedMiss = true;
    second.prepare = ((sql: string) => {
      if (fakedMiss && typeof sql === 'string' && sql.includes('capture_request_id = ?')) {
        fakedMiss = false;
        return { get: () => undefined } as unknown as ReturnType<typeof originalPrepare>;
      }
      return originalPrepare(sql);
    }) as typeof second.prepare;

    // A 先提交；B 手里还留着「这个键还没人用」的过期读。
    const winner = createCapture(db, input);
    const loser = createCapture(second, input);

    // 输家不是新插入，而是重放赢家：一个键只产生一条记录、一次 datasetRevision。
    expect(loser.replayed).toBe(true);
    expect(loser.item.id).toBe(winner.item.id);
    expect(countItems()).toBe(1);
    expect(getDatasetRevision(db)).toBe(revisionBefore + 1);
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS n FROM knowledge_items WHERE capture_request_id = ?')
          .get(captureRequestId) as { n: number }
      ).n,
    ).toBe(1);
  });

  it('T077-C02 唯一约束的输家如果内容不同，仍然是键冲突而不是重放', () => {
    const captureRequestId = newId();
    const winner = createCapture(db, {
      ...baseInput,
      captureRequestId,
      rawText: 'A 版本的内容',
    });

    const second = new DatabaseSync(harness.databasePath);
    extraConnections.push(second);
    configureConnection(second);

    const originalPrepare = second.prepare.bind(second);
    let fakedMiss = true;
    second.prepare = ((sql: string) => {
      if (fakedMiss && typeof sql === 'string' && sql.includes('capture_request_id = ?')) {
        fakedMiss = false;
        return { get: () => undefined } as unknown as ReturnType<typeof originalPrepare>;
      }
      return originalPrepare(sql);
    }) as typeof second.prepare;

    // 同键异内容撞唯一约束后，必须报「同一次保存动作的内容已改变」，不能冒充重放。
    let raised: unknown = null;
    try {
      createCapture(second, { ...baseInput, captureRequestId, rawText: 'B 版本的内容' });
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(CaptureKeyConflictError);
    expect((raised as AppError).code).toBe('CAPTURE_KEY_CONFLICT');
    expect(countItems()).toBe(1);
    expect((findItemRow(db, winner.item.id) as { raw_text: string }).raw_text).toBe('A 版本的内容');
  });

  it('T014-C02 幂等键查询可直接命中已存记录', () => {
    const captureRequestId = newId();
    createCapture(db, { ...baseInput, captureRequestId, rawText: '键查询' });
    const found = findByCaptureRequestId(db, captureRequestId);
    expect(found).not.toBeNull();
    expect(found?.item.rawText).toBe('键查询');
  });
});
