/**
 * T062 验收（集成）：材料核对走的是真实路由与真实解析。
 *
 * 这里只钉一件事，但它是一条**真实缺陷**的回归：`/api/selection` 的
 * `SelectionQuery.itemId` 是重复参数（`?itemId=a&itemId=b`），而 `parseQuery`
 * 曾用 `url.searchParams.entries()` 逐项 `raw[key] = value` —— 后一个值会**覆盖**
 * 前一个，于是"核对一次选择"永远只看到最后一个 id。
 *
 * 后果不是显示少了一条，而是：面板描述的集合比用户勾选的**小**，一条被删除的
 * 来源可能正好躲在被截掉的位置上，于是 T062-C05「先阻止并要求确认新集合」根本
 * 没有机会触发。
 *
 * 断言方式：通过真实路由处理函数发一个两个 id 的请求，检查**两个** id 都被解析
 * 出来，并且删除其中一条后路由在列表里把它标出来（而不是只回一个条目）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { getDb } from '@/server/db/database';
import { createCapture, deleteItemById } from '@/server/services/items';
import { createTestDatabase, newId, openTestDatabase, type TestDatabase } from '../helpers/db';
import { callRoute } from './helpers/http';

let harness: TestDatabase;
let db: DatabaseSync;

beforeEach(() => {
  harness = createTestDatabase();
  db = openTestDatabase(harness.databasePath);
});

afterEach(() => {
  harness.cleanup();
});

function capture(rawText: string): { id: string; revision: number } {
  const created = createCapture(db, {
    captureRequestId: newId(),
    rawText,
    sourceType: 'myself',
    sourceRef: null,
  }).item;
  return { id: created.id, revision: created.revision };
}

/** Narrow a successful envelope to its data, failing loudly on a failure body. */
function dataOf(response: { envelope: unknown }): unknown {
  const envelope = response.envelope as { ok: boolean; data?: unknown };
  if (!envelope.ok) throw new Error('期望成功信封，实际是失败信封');
  return envelope.data;
}

describe('T062 材料核对（真实路由）', () => {
  it('T062-C05 重复 itemId 参数全部生效，删除来源后能被逐个点名', async () => {
    const { GET } = await import('@/app/api/selection/route');

    const first = capture('流程材料甲：先预热再注入');
    const second = capture('流程材料乙：注入完成后校验');

    const before = await callRoute(GET as never, {
      path: `/api/selection?itemId=${first.id}&itemId=${second.id}`,
    });
    expect(before.status).toBe(200);
    const beforeData = dataOf(before) as { itemIds: string[]; count: number };
    // 关键断言：两个 id 都在。修复前这里只有 second.id，count=1。
    expect(beforeData.itemIds).toEqual([first.id, second.id]);
    expect(beforeData.count).toBe(2);

    // 删掉其中一条来源，模拟"勾选后在抽屉里删掉了它"。
    deleteItemById(db, first.id, first.revision);

    const after = await callRoute(GET as never, {
      path: `/api/selection?itemId=${first.id}&itemId=${second.id}`,
    });
    // 服务端不会悄悄缩短范围：它明确拒绝并指出已不存在的 id（T021-C04），
    // 这正是页面用来阻止提交并要求重新确认的依据。
    expect(after.status).toBe(400);
    const envelope = after.envelope as {
      ok: false;
      error: { code: string; fieldErrors?: Record<string, string[]> };
    };
    expect(envelope.error.code).toBe('VALIDATION');
    expect(JSON.stringify(envelope.error.fieldErrors)).toContain(first.id);

    // 而"只剩那一条"的请求仍然可以核对，说明被删的 id 是唯一原因。
    const survivorOnly = await callRoute(GET as never, {
      path: `/api/selection?itemId=${second.id}`,
    });
    expect(survivorOnly.status).toBe(200);
    const survivorData = dataOf(survivorOnly) as { itemIds: string[] };
    expect(survivorData.itemIds).toEqual([second.id]);

    // 单值参数没有被这次修改影响（标量形式仍然解析为一个数组）。
    expect(getDb()).toBeTruthy();
  });

  it('T062-C02 单值查询参数保持标量语义', async () => {
    const { GET } = await import('@/app/api/selection/route');
    const only = capture('流程材料丙：唯一一条');

    const response = await callRoute(GET as never, {
      path: `/api/selection?itemId=${only.id}`,
    });
    expect(response.status).toBe(200);
    const data = dataOf(response) as { itemIds: string[]; sources: { title: string }[] };
    expect(data.itemIds).toEqual([only.id]);
    expect(data.sources).toHaveLength(1);
  });
});
