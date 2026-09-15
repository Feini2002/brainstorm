/**
 * T047 验收：图位置保存与布局版本冲突。
 *
 * 驱动真实 SQLite 与真实路由函数（隔离目录），覆盖六个具名场景：
 * 刷新保持、每帧写入、双窗口冲突、删除节点丢弃坐标、恶意坐标拒绝、初始化竞态。
 *
 * 三条关键不变量在这里被钉住：
 *  1. 坐标只进 views.content_json，knowledge_items 的 revision/raw_version 不动；
 *  2. 写入是合并而不是整表替换，且以 expectedRevision 做 CAS；
 *  3. 已删条目的坐标被丢弃，但丢弃坐标不等于删除知识。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import { createCapture } from '@/server/services/items';
import { createGraphView, getView } from '@/server/services/views/views';
import { saveGraphLayout } from '@/server/services/saveGraphLayout';
import { existingItemIds } from '@/server/repositories/items';
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

function capture(rawText: string) {
  return createCapture(db, {
    captureRequestId: newId(),
    rawText,
    sourceType: 'other',
    sourceRef: null,
  }).item;
}

function makeView(itemIds: string[]) {
  return createGraphView(db, {
    name: `布局用例 ${Math.random().toString(36).slice(2, 8)}`,
    selection: { mode: 'explicit', itemIds },
    positions: Object.fromEntries(itemIds.map((id, index) => [id, { x: index * 120, y: index * 60 }])),
    direction: 'TB',
  });
}

/** Raw stored JSON, so an assertion can prove nothing extra got serialized. */
function storedContent(viewId: string): Record<string, unknown> {
  const row = db
    .prepare('SELECT content_json FROM views WHERE id = ?')
    .get(viewId) as { content_json: string };
  return JSON.parse(row.content_json) as Record<string, unknown>;
}

/**
 * Liveness lookup bound to the test database.
 *
 * Mirrors what the route passes in. Deliberately a callback rather than a
 * precomputed set: the service must ask about the union of stored and incoming
 * ids, and a test that handed over a fixed set would not exercise that.
 */
function liveLookup(database: DatabaseSync) {
  return (ids: readonly string[]) => existingItemIds(database, ids);
}

async function layoutRoute() {
  return import('@/app/api/views/[id]/layout/route');
}

describe('T047 布局持久化', () => {
  it('T047-C01 保存的坐标写入 views.content_json，条目与关系版本不变', () => {
    const a = capture('布局保持的甲');
    const b = capture('布局保持的乙');
    const view = makeView([a.id, b.id]);

    const itemBefore = db
      .prepare('SELECT revision, raw_version, updated_at FROM knowledge_items WHERE id = ?')
      .get(a.id) as { revision: number; raw_version: number; updated_at: string };

    const result = saveGraphLayout(
      db,
      {
        viewId: view.id,
        expectedRevision: view.revision,
        positions: { [a.id]: { x: 111, y: 222 } },
      },
      liveLookup(db),
    );

    expect(result.revision).toBe(view.revision + 1);
    expect(result.positions[a.id]).toEqual({ x: 111, y: 222 });
    // 未提交的节点保留原坐标：这是合并，不是整表替换。这一条同时是回归守卫 ——
    // 存活判定必须覆盖「已存但本次未提交」的 id，只查请求里的 id 会把 b 当已删除。
    expect(result.positions[b.id]).toEqual({ x: 120, y: 60 });

    const itemAfter = db
      .prepare('SELECT revision, raw_version, updated_at FROM knowledge_items WHERE id = ?')
      .get(a.id) as { revision: number; raw_version: number; updated_at: string };
    expect(itemAfter).toEqual(itemBefore);

    // 重新读取：坐标来自视图内容，且与写入值一致（刷新保持）。
    const reloaded = getView(db, view.id);
    expect(reloaded.kind).toBe('graph');
    if (reloaded.kind === 'graph') {
      expect(reloaded.content.positions[a.id]).toEqual({ x: 111, y: 222 });
    }
  });

  it('T047-R05 content_json 只含白名单字段，不序列化 ItemDTO 或组件对象', () => {
    const a = capture('白名单字段的甲');
    const view = makeView([a.id]);

    saveGraphLayout(
      db,
      {
        viewId: view.id,
        expectedRevision: view.revision,
        positions: { [a.id]: { x: 5, y: 6 } },
        direction: 'LR',
        viewport: { x: 10, y: 20, zoom: 1.5 },
      },
      liveLookup(db),
    );

    const content = storedContent(view.id);
    expect(Object.keys(content).sort()).toEqual(['direction', 'positions', 'viewport']);
    // 条目文本不会被写进视图：这里显式检查最容易被顺手带进来的字段。
    const serialized = JSON.stringify(content);
    expect(serialized).not.toContain('白名单字段的甲');
    expect(serialized).not.toContain('rawText');
    expect(serialized).not.toContain('raw_text');
    expect(serialized).not.toContain('summary');
  });

  it('T047-R03 用旧 revision 保存时冲突，不是静默覆盖', () => {
    const a = capture('冲突处理的甲');
    const view = makeView([a.id]);

    const first = saveGraphLayout(
      db,
      { viewId: view.id, expectedRevision: view.revision, positions: { [a.id]: { x: 1, y: 1 } } },
      liveLookup(db),
    );

    let raised: unknown = null;
    try {
      saveGraphLayout(
        db,
        { viewId: view.id, expectedRevision: view.revision, positions: { [a.id]: { x: 999, y: 999 } } },
        liveLookup(db),
      );
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(AppError);
    expect((raised as AppError).code).toBe('REVISION_CONFLICT');
    // 后者不能覆盖前者：库里仍是第一次写入的值。
    const reloaded = getView(db, view.id);
    if (reloaded.kind === 'graph') {
      expect(reloaded.content.positions[a.id]).toEqual({ x: 1, y: 1 });
    }
    expect(reloaded.revision).toBe(first.revision);
  });

  it('T047-C04 已删除条目的坐标被丢弃，但知识本身不会被重建', () => {
    const keep = capture('保留条目的甲');
    const doomed = capture('将被删除的乙');
    const view = makeView([keep.id, doomed.id]);

    db.prepare('DELETE FROM knowledge_items WHERE id = ?').run(doomed.id);

    const result = saveGraphLayout(
      db,
      { viewId: view.id, expectedRevision: view.revision, positions: { [keep.id]: { x: 7, y: 8 } } },
      liveLookup(db),
    );

    expect(result.discardedIds).toContain(doomed.id);
    expect(result.positions[doomed.id]).toBeUndefined();
    expect(result.positions[keep.id]).toEqual({ x: 7, y: 8 });

    // presentation 不能反向复活数据：库中仍然只有一条知识。
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM knowledge_items')
      .get() as { n: number };
    expect(Number(count.n)).toBe(1);
    expect(storedContent(view.id).positions).not.toHaveProperty(doomed.id);
  });

  it('T047-R04 大量既有条目时，仍在库中的坐标不会被误判为已删除', () => {
    // 真实回归：早先用 listItems({limit: graphNodes*4}) 做存活判定，条目数超过
    // 上限后，超出的合法坐标会被当成“条目已消失”而丢弃。
    const items = Array.from({ length: 30 }, (_, index) => capture(`存活判定 ${index}`));
    const view = makeView([items[0].id]);

    const live = liveLookup(db);
    const result = saveGraphLayout(
      db,
      {
        viewId: view.id,
        expectedRevision: view.revision,
        positions: { [items[0].id]: { x: 3, y: 4 }, [items[29].id]: { x: 5, y: 6 } },
      },
      live,
    );

    expect(result.discardedIds).toEqual([]);
    expect(result.positions[items[29].id]).toEqual({ x: 5, y: 6 });
  });

  it('T047-C05 路由拒绝 Infinity、越界坐标与非法视口', async () => {
    const a = capture('恶意坐标的甲');
    const view = makeView([a.id]);
    const route = await layoutRoute();

    const infinite = await callRoute(route.PUT, {
      method: 'PUT',
      path: `/api/views/${view.id}/layout`,
      params: { id: view.id },
      // 直接构造 JSON 文本：JSON.stringify 会把 Infinity 变成 null，绕过客户端。
      rawBody: `{"expectedRevision":${view.revision},"positions":{"${a.id}":{"x":1e999,"y":0}}}`,
    });
    expect(infinite.status).toBe(400);
    expect(infinite.envelope.ok).toBe(false);

    const extreme = await callRoute(route.PUT, {
      method: 'PUT',
      path: `/api/views/${view.id}/layout`,
      params: { id: view.id },
      body: { expectedRevision: view.revision, positions: { [a.id]: { x: 99_999_999, y: 0 } } },
    });
    expect(extreme.status).toBe(400);

    const badZoom = await callRoute(route.PUT, {
      method: 'PUT',
      path: `/api/views/${view.id}/layout`,
      params: { id: view.id },
      body: {
        expectedRevision: view.revision,
        positions: {},
        viewport: { x: 0, y: 0, zoom: 500 },
      },
    });
    expect(badZoom.status).toBe(400);

    // 三次非法请求之后，已存布局没有被破坏。
    const reloaded = getView(db, view.id);
    expect(reloaded.revision).toBe(view.revision);
    if (reloaded.kind === 'graph') {
      expect(reloaded.content.positions[a.id]).toEqual({ x: 0, y: 0 });
    }
  });

  it('T047-R01 对非关系图视图保存布局会被拒绝', () => {
    const a = capture('非关系图视图的甲');
    const now = new Date().toISOString();
    const mindmapId = newId();
    db.prepare(
      `INSERT INTO views (
         id, name, kind, selection_json, source_snapshot_json, content_json, content_hash,
         renderer_version, prompt_version, run_id, revision, generated_at, created_at, updated_at
       ) VALUES (?, ?, 'mindmap', ?, ?, ?, NULL, 'mindmap-markmap-v1', 'mindmap-v1', NULL, 1, ?, ?, ?)`,
    ).run(
      mindmapId,
      '误配视图',
      JSON.stringify({ mode: 'explicit', itemIds: [a.id] }),
      JSON.stringify({ items: [], relations: [] }),
      JSON.stringify({ title: '标题', nodes: [] }),
      now,
      now,
      now,
    );

    expect(() =>
      saveGraphLayout(
        db,
        { viewId: mindmapId, expectedRevision: 1, positions: { [a.id]: { x: 1, y: 2 } } },
        liveLookup(db),
      ),
    ).toThrowError(/只有关系图视图/);
  });

  it('T047-C06 首次读取已存布局本身不写库，不会覆盖保存位置', () => {
    const a = capture('初始化竞态的甲');
    const view = makeView([a.id]);
    const before = storedContent(view.id);

    // 读取路径只读：多次 getView 不应产生任何写入或 revision 变化。
    getView(db, view.id);
    getView(db, view.id);

    const reloaded = getView(db, view.id);
    expect(reloaded.revision).toBe(view.revision);
    expect(storedContent(view.id)).toEqual(before);
  });
});
