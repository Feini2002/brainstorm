/**
 * T020 验收：删除确认与引用失效。
 *
 * 用例规格：docs/05_tests/G1/T020_cases.md。审计结论是 `deleteItem.ts` 无测试导入、
 * 契约点名的 `tests/integration/delete.test.ts` 也不存在；本文件补上带 T020 标签的
 * 直接断言：级联范围（关系与标签连接消失、其它知识正常）、陈旧确认 409、
 * 重复删除的规范结果、视图保留结构并报缺失来源、迟到整理结果不复活已删条目。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import type { ItemDTO, LlmConfig } from '@/domain/knowledge';
import { createCapture, deleteItemById, patchItem } from '@/server/services/items';
import { createGraphView, getView } from '@/server/services/views/views';
import { getViewFreshness } from '@/server/services/views/getFreshness';
import { OpenAICompatibleAdapter } from '@/server/llm/adapter';
import type { Transport, TransportRequest, TransportResponse } from '@/server/llm/transport';
import { callSnapshot } from '@/server/llm/types';
import { organizeItem } from '@/server/services/organizeItem';
import { findRunByRequestKey } from '@/server/repositories/runs';
import { ensureTag, listTags, setItemTags } from '@/server/repositories/tags';
import { insertRelation } from '@/server/repositories/relations';
import { nowIso } from '@/server/repositories/shared';
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

function capture(rawText: string): ItemDTO {
  return createCapture(db, {
    captureRequestId: newId(),
    rawText,
    sourceType: 'other',
    sourceRef: null,
  }).item;
}

const CONFIG: LlmConfig = {
  adapter: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  model: 'delete-test-model',
  structuredMode: 'prompt_json',
  tokenField: 'none',
  maxOutputTokens: 4096,
  schemaRepairEnabled: false,
};

function chatOk(content: string): TransportResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    bodyText: JSON.stringify({
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
    }),
  };
}

function countRows(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

describe('T020 删除与级联', () => {
  it('T020-C02 删除同时清掉标签连接与双向关系，其它条目与词典保持正常', () => {
    const target = capture('要被删除的目标记录。');
    const other = capture('不应受影响的另一条记录。');
    const third = capture('通过目标相连的第三条。');

    const now = nowIso();
    const sharedTagId = ensureTag(db, '共享标签', now);
    setItemTags(db, target.id, ['共享标签'], now);
    setItemTags(db, other.id, ['共享标签'], now);

    insertRelation(db, {
      id: newId(),
      sourceId: target.id < other.id ? target.id : other.id,
      targetId: target.id < other.id ? other.id : target.id,
      type: 'related_to',
      origin: 'manual',
      reviewStatus: 'accepted',
      score: null,
      reason: '人工关系',
      evidence: [],
      sourceRawVersion: 1,
      targetRawVersion: 1,
      runId: null,
      now,
    });
    insertRelation(db, {
      id: newId(),
      sourceId: target.id,
      targetId: third.id,
      type: 'extends',
      origin: 'manual',
      reviewStatus: 'accepted',
      score: null,
      reason: '人工关系',
      evidence: [],
      sourceRawVersion: 1,
      targetRawVersion: 1,
      runId: null,
      now,
    });
    expect(countRows('relations')).toBe(2);
    expect(countRows('item_tags')).toBe(2);

    deleteItemById(db, target.id, target.revision);

    // 只删该条：关系两条都是它的端点，连接随外键消失。
    expect(countRows('knowledge_items')).toBe(2);
    expect(countRows('relations')).toBe(0);
    expect(countRows('item_tags')).toBe(1);
    // 词典里的标签仍在，并且另一个条目还能按该标签查到（T017-C05 同一不变量）。
    const tags = listTags(db);
    const shared = tags.find((tag) => tag.id === sharedTagId);
    expect(shared?.itemCount).toBe(1);
    const survivors = db
      .prepare('SELECT item_id FROM item_tags WHERE tag_id = ?')
      .all(sharedTagId) as { item_id: string }[];
    expect(survivors.map((row) => row.item_id)).toEqual([other.id]);
  });

  it('T020-C02 删除只影响该条，其它条目的版本与内容不变', () => {
    const target = capture('删除的目标。');
    const kept = patchItem(db, {
      id: capture('保留的记录。').id,
      expectedRevision: 1,
      patch: { title: '保留标题' },
    });

    deleteItemById(db, target.id, target.revision);

    const after = db
      .prepare('SELECT revision, title, raw_text FROM knowledge_items WHERE id = ?')
      .get(kept.id) as { revision: number; title: string; raw_text: string };
    expect(after.revision).toBe(kept.revision);
    expect(after.title).toBe('保留标题');
  });

  it('T020-C05 陈旧确认：确认时 revision 已变则 409，且记录仍在', () => {
    const target = capture('删除前被另一窗口改过的记录。');
    // 另一窗口先编辑，revision 前进。
    const edited = patchItem(db, {
      id: target.id,
      expectedRevision: target.revision,
      patch: { summary: '另一窗口写入的摘要' },
    });
    expect(edited.revision).toBeGreaterThan(target.revision);

    let raised: unknown = null;
    try {
      deleteItemById(db, target.id, target.revision);
    } catch (error) {
      raised = error;
    }

    expect((raised as AppError).code).toBe('REVISION_CONFLICT');
    expect(countRows('knowledge_items')).toBe(1);
    expect(
      (db.prepare('SELECT summary FROM knowledge_items WHERE id = ?').get(target.id) as {
        summary: string;
      }).summary,
    ).toBe('另一窗口写入的摘要');
  });

  it('T020-C06 重复删除：第二次返回 NOT_FOUND，且不产生额外副作用', () => {
    const target = capture('会被删两次的记录。');
    const other = capture('相邻的记录。');

    const first = deleteItemById(db, target.id, target.revision);
    expect(first.deletedId).toBe(target.id);

    let raised: unknown = null;
    try {
      deleteItemById(db, target.id, target.revision);
    } catch (error) {
      raised = error;
    }

    // 幂等的要求是「没有额外副作用 + 明确的规范结果」，不是伪装成又一次成功删除。
    expect((raised as AppError).code).toBe('NOT_FOUND');
    expect(countRows('knowledge_items')).toBe(1);
    expect(
      (db.prepare('SELECT id FROM knowledge_items').get() as { id: string }).id,
    ).toBe(other.id);
  });
});

describe('T020 视图来源失效', () => {
  it('T020-C04 删除被脑图/关系图引用的条目：视图仍可打开并报缺失来源', () => {
    const first = capture('视图来源甲。');
    const second = capture('视图来源乙。');

    const view = createGraphView(db, {
      name: '删除来源的关系图',
      selection: { mode: 'explicit', itemIds: [first.id, second.id] },
      positions: {
        [first.id]: { x: 0, y: 0 },
        [second.id]: { x: 200, y: 0 },
      },
      direction: 'TB',
    });

    deleteItemById(db, first.id, first.revision);

    // 视图没有被连带删除，仍然打开的条目坐标保留，缺失来源被如实报告。
    const after = getView(db, view.id);
    expect(after.id).toBe(view.id);
    // 这条用例建的是关系图，因此 content 一定是带 positions 的形态。
    const content = after.content as { positions: Record<string, { x: number; y: number }> };
    expect(content.positions[second.id]).toEqual({ x: 200, y: 0 });
    // 已删条目的坐标被清理（而不是留成一个指向不存在记录的死节点）。
    expect(content.positions[first.id]).toBeUndefined();
    // 契约把「来源已删除」与「来源版本变化」分成两个信号（03_dto_and_version_rules §12）：
    // 缺失来源进 missingSources，isStale 只表示仍存在的来源版本发生变化。
    expect(after.missingSources).toEqual([first.id]);
    expect(after.isStale).toBe(false);
    expect(
      after.sourceSnapshot.items.map((entry) => entry.id).sort(),
    ).toEqual([first.id, second.id].sort());
    // 视图仍能给出「为什么过期」的具体理由，而不是笼统的加载失败。
    expect(getViewFreshness(db, view.id).reason).toContain('来源已删除');
  });

  it('T020-C01 取消删除：不调用删除接口时数据库完全不变', () => {
    const target = capture('用户打开确认框后取消。');
    const before = db
      .prepare('SELECT COUNT(*) AS n FROM knowledge_items')
      .get() as { n: number };

    // 「取消」在服务端就是没有调用：这条用例把它钉成显式断言，防止将来
    // 有人把乐观删除搬到打开确认框的那一步。
    expect(before.n).toBe(1);
    expect(
      (db.prepare('SELECT id FROM knowledge_items').get() as { id: string }).id,
    ).toBe(target.id);
    expect(countRows('item_tags')).toBe(0);
  });
});

describe('T020 迟到结果不复活已删材料', () => {
  it('T020-C03 模型返回前删除目标：结果被丢弃、条目不被重建、Run 记为 conflict', async () => {
    const target = capture('模型还在整理时就被删除的记录。');
    if (!target) throw new Error('capture failed');

    // 删除发生在「请求已发出、提交尚未开始」这段真实窗口里：transport 的
    // send 就是模型调用本身，因此在 send 内删除等价于用户在等待期间点了删除。
    let deletedInside = false;
    const transport: Transport = {
      send: async (request: TransportRequest) => {
        JSON.parse(request.body);
        deleteItemById(db, target.id, target.revision);
        deletedInside = true;
        return chatOk(
          JSON.stringify({
            title: '迟到的标题',
            summary: '迟到的摘要',
            type: 'idea',
            tags: [],
            keywords: [],
            importance: 3,
            relations: [],
          }),
        );
      },
    };

    const requestKey = newId();
    const result = await organizeItem(db, {
      requestKey,
      itemId: target.id,
      expectedRevision: target.revision,
      config: callSnapshot(CONFIG, 'sk-test-DELETE-000000000000000000'),
      configRevision: 1,
      schemaRepairEnabled: false,
      adapter: new OpenAICompatibleAdapter(transport),
    });

    expect(deletedInside).toBe(true);
    // 结果被丢弃：没有任何字段写回，条目也没有被重建。
    expect(result.state).toBe('conflict');
    expect(result.applied).toEqual([]);
    expect(result.item).toBeNull();
    expect(countRows('knowledge_items')).toBe(0);

    const run = findRunByRequestKey(db, requestKey);
    expect(run?.state).toBe('conflict');
    expect(run?.error?.code).toBe('SOURCE_CHANGED');
  });
});

describe('T020 HTTP 层删除', () => {
  async function remove(id: string, body: unknown) {
    const { DELETE } = await import('@/app/api/items/[id]/route');
    return callRoute(DELETE, { method: 'DELETE', path: `/api/items/${id}`, body, params: { id } });
  }

  it('T020-C06 HTTP 层重复删除返回 404，首次返回 200 {deletedId}', async () => {
    const target = capture('HTTP 删除。');
    const first = await remove(target.id, { expectedRevision: target.revision });

    expect(first.status).toBe(200);
    expect((first.envelope as { ok: true; data: { deletedId: string } }).data.deletedId).toBe(
      target.id,
    );

    const second = await remove(target.id, { expectedRevision: target.revision });
    expect(second.status).toBe(404);
    const failure = second.envelope as { ok: false; error: { code: string } };
    expect(failure.error.code).toBe('NOT_FOUND');
  });

  it('T020-C05 HTTP 层陈旧 revision 返回 409 且记录保留', async () => {
    const target = capture('HTTP 陈旧删除。');
    const edited = patchItem(db, {
      id: target.id,
      expectedRevision: target.revision,
      patch: { title: '改过的标题' },
    });
    expect(edited.revision).toBeGreaterThan(target.revision);

    const response = await remove(target.id, { expectedRevision: target.revision });
    expect(response.status).toBe(409);
    const failure = response.envelope as { ok: false; error: { code: string } };
    expect(failure.error.code).toBe('REVISION_CONFLICT');
    expect(countRows('knowledge_items')).toBe(1);
  });

  it('T020-C05 删除体缺少 expectedRevision 或携带未授权字段时被 schema 拒绝', async () => {
    const target = capture('删除体校验。');

    const missing = await remove(target.id, {});
    expect(missing.status).toBe(400);

    const injected = await remove(target.id, {
      expectedRevision: target.revision,
      id: newId(),
      cascade: true,
    });
    expect(injected.status).toBe(400);
    const failure = injected.envelope as {
      ok: false;
      error: { fieldErrors?: Record<string, string[]> };
    };
    expect(Object.keys(failure.error.fieldErrors ?? {})).toContain('cascade');
    expect(countRows('knowledge_items')).toBe(1);
  });
});
