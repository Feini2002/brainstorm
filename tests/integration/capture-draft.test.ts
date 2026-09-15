/**
 * T013 验收：极简输入框与中文输入体验（服务端与 HTTP 层部分）。
 *
 * 用例规格：docs/05_tests/G1/T013_cases.md。纯规则断言在
 * `tests/unit/capture-draft.test.ts`；这里补的是「绕过界面直接发请求」的那一半，
 * 需要真实 SQLite 与真实路由模块，因此按 T011-R01 的划分放在 integration 项目。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { LIMITS } from '@/domain/limits';
import { codePointLength } from '@/domain/text';
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

async function capture(rawText: string) {
  const { POST } = await import('@/app/api/items/route');
  return callRoute(POST, {
    method: 'POST',
    path: '/api/items',
    body: {
      captureRequestId: newId(),
      rawText,
      sourceType: 'other',
      sourceRef: null,
    },
  });
}

describe('T013-C04 纯空白不落库', () => {
  it('T013-C04 绕开界面直接 POST 纯空白也被 400 拒绝，且不产生任何记录', async () => {
    // 界面侧的 `canSubmitDraft` 只是第一道（其断言在 unit 项目里），
    // 这里证明服务端是最后一道：直接发请求同样不能落一条空记录。
    for (const text of ['   ', '\n\n', '\t', ' \n\t ']) {
      const response = await capture(text);
      expect(response.status, `不应接受 ${JSON.stringify(text)}`).toBe(400);
      const failure = response.envelope as { ok: false; error: { code: string } };
      expect(failure.error.code).toBe('VALIDATION');
    }

    const count = db.prepare('SELECT COUNT(*) AS n FROM knowledge_items').get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe('T013-C05 码点边界在服务端同样成立', () => {
  it('T013-C05 恰好到上限返回 201，多一个码点返回 400', async () => {
    const atLimit = 'あ'.repeat(LIMITS.rawTextCodePoints);

    const ok = await capture(atLimit);
    expect(ok.status).toBe(201);
    const item = (ok.envelope as { ok: true; data: { item: { rawText: string } } }).data.item;
    expect(codePointLength(item.rawText)).toBe(LIMITS.rawTextCodePoints);

    const tooLong = await capture(`${atLimit}あ`);
    expect(tooLong.status).toBe(400);

    // 被拒绝的那一次没有留下半条记录。
    const count = db.prepare('SELECT COUNT(*) AS n FROM knowledge_items').get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('T013-C01/C06 无模型也能采集', () => {
  it('T013-C01 只有四个字的记录可以保存，不需要标题或分类', async () => {
    const response = await capture('系统架构');

    expect(response.status).toBe(201);
    const item = (response.envelope as { ok: true; data: { item: Record<string, unknown> } }).data
      .item;
    // 表单里没有标题这一格，保存结果自然也不该凭空有标题。
    expect(item.rawText).toBe('系统架构');
    expect(item.title).toBe('');
    expect(item.tags).toEqual([]);
    expect(item.status).toBe('raw');
  });

  it('T013-C06 从未配置模型时保存成功，并且能立刻从资料库读到', async () => {
    const created = await capture('没有 Key 也要能保存。');
    expect(created.status).toBe(201);
    const id = (created.envelope as { ok: true; data: { item: { id: string } } }).data.item.id;

    const { GET } = await import('@/app/api/items/[id]/route');
    const read = await callRoute(GET, {
      method: 'GET',
      path: `/api/items/${id}`,
      params: { id },
    });
    expect(read.status).toBe(200);
    const item = (read.envelope as { ok: true; data: { rawText: string; status: string } }).data;
    expect(item.rawText).toBe('没有 Key 也要能保存。');
    // 没有任何 AI 步骤参与过，状态不能假装整理过了。
    expect(item.status).toBe('raw');
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get()).toEqual({ n: 0 });
  });
});
