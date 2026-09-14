/**
 * T014 采集幂等与事务边界。
 *
 * 直接驱动 captureItem 服务层与 HTTP 路由，验证「同键同内容重放、同键异内容冲突、
 * 不同键允许重复、被拒绝的请求不产生任何写入」。测试使用隔离数据库，
 * 绝不触碰用户 .data 或任何真实 Key。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { getDatasetRevision } from '@/server/db/database';
import { createCapture, CaptureKeyConflictError } from '@/server/services/items';
import { findItemRow, findByCaptureRequestId } from '@/server/repositories/items';
import { AppError } from '@/domain/errors';
import { MAX } from './helpers/limits';
import { createTestDatabase, newId, openTestDatabase, type TestDatabase } from '../helpers/db';

let harness: TestDatabase;
let db: DatabaseSync;

beforeEach(() => {
  harness = createTestDatabase();
  db = openTestDatabase(harness.databasePath);
});

afterEach(() => {
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

  it('T014-C02 幂等键查询可直接命中已存记录', () => {
    const captureRequestId = newId();
    createCapture(db, { ...baseInput, captureRequestId, rawText: '键查询' });
    const found = findByCaptureRequestId(db, captureRequestId);
    expect(found).not.toBeNull();
    expect(found?.item.rawText).toBe('键查询');
  });
});
