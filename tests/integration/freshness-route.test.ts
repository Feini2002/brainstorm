/**
 * T077-C04 一致性验收：畸形路径 id 与不存在 id 得到**同一个** 404。
 *
 * 这条路由此前全部路由里唯一零直接引用的一条（见 `docs/api-test-map.md` 第 4 节）：
 * `getViewFreshness` 的服务层被 `view-regeneration` / `flow-history` 测得很透，
 * UI 也有 e2e，但 **handler 本身**没有任何测试经过。
 *
 * 关于断言为什么是 404 而不是 400 —— 这一点是**实测出来的，不是猜的**：
 * 先探测了全部动态路由对 `not-a-uuid` 的响应，结果是 `items/[id]`、`views/[id]`、
 * `views/[id]/freshness`、`views/[id]/export`、`runs/[id]` 一律
 * `404 NOT_FOUND`。也就是说动态段故意**不**做形状校验：不区分"形状不对"与
 * "这个 id 不存在"，避免成为一个 id 存在性探测器（T077-C04 的"状态码与 error.code
 * 对应"因此有一条统一答案）。本文件把这条一致性钉住——下面那条跨路由断言
 * 是它的守卫：若将来有人给某一条路由单独加了形状校验，这里会红。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

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

async function freshnessRoute() {
  return import('@/app/api/views/[id]/freshness/route');
}

const BAD_ID = 'not-a-uuid';

describe('T077-C04 /api/views/{id}/freshness 的 HTTP 契约', () => {
  it('T077-C04 不存在的视图返回 404 与统一错误码，而不是空报告', async () => {
    const { GET } = await freshnessRoute();
    const missing = newId();
    const response = await callRoute(GET, {
      method: 'GET',
      path: `/api/views/${missing}/freshness`,
      params: { id: missing },
    });

    // 关键：不能返回 200 + 一份"没有变化"的报告。那会让调用方以为视图是新鲜的。
    expect(response.status).toBe(404);
    expect(response.envelope.ok).toBe(false);
    if (response.envelope.ok) return;
    expect(response.envelope.error.code).toBe('NOT_FOUND');
  });

  it('T077-C04 畸形 id 与不存在 id 得到同样的 404，不成为存在性探测器', async () => {
    const { GET } = await freshnessRoute();

    const malformed = await callRoute(GET, {
      method: 'GET',
      path: `/api/views/${BAD_ID}/freshness`,
      params: { id: BAD_ID },
    });
    const missing = await callRoute(GET, {
      method: 'GET',
      path: `/api/views/${newId()}/freshness`,
      params: { id: newId() },
    });

    expect(malformed.status).toBe(missing.status);
    expect(malformed.status).toBe(404);
    if (malformed.envelope.ok || missing.envelope.ok) throw new Error('两者都应是失败信封');
    // 连错误码都一样：否则 400/404 的差别本身泄露了"这个 id 形状对不对"。
    expect(malformed.envelope.error.code).toBe(missing.envelope.error.code);
  });

  it('T077-C04 全部动态路由对畸形 id 的回答一致（不只是本路由）', async () => {
    // 这是上一条的守卫：单独给某条路由加形状校验会让它变红。
    const probes: [string, () => Promise<Record<string, unknown>>, string][] = [
      ['items/[id]', () => import('@/app/api/items/[id]/route'), `/api/items/${BAD_ID}`],
      ['views/[id]', () => import('@/app/api/views/[id]/route'), `/api/views/${BAD_ID}`],
      [
        'views/[id]/freshness',
        () => import('@/app/api/views/[id]/freshness/route'),
        `/api/views/${BAD_ID}/freshness`,
      ],
      [
        'views/[id]/export',
        () => import('@/app/api/views/[id]/export/route'),
        `/api/views/${BAD_ID}/export`,
      ],
      ['runs/[id]', () => import('@/app/api/runs/[id]/route'), `/api/runs/${BAD_ID}`],
    ];

    for (const [name, load, path] of probes) {
      const mod = (await load()) as { GET?: unknown };
      expect(typeof mod.GET, `${name} 应导出 GET`).toBe('function');

      const response = await callRoute(mod.GET as never, {
        method: 'GET',
        path,
        params: { id: BAD_ID },
      });

      expect(response.status, `${name} 对畸形 id 的状态码`).toBe(404);
      expect(response.envelope.ok, `${name} 的信封`).toBe(false);
      if (response.envelope.ok) continue;
      expect(response.envelope.error.code, `${name} 的错误码`).toBe('NOT_FOUND');
    }
  });

  it('T077-C04 合法视图返回 200，且响应是读操作：不写库、不动 generatedAt', async () => {
    const { createGraphView } = await import('@/server/services/views/views');
    const { getViewFreshness } = await import('@/server/services/views/getFreshness');
    const { createCapture } = await import('@/server/services/items');

    const item = createCapture(db, {
      captureRequestId: newId(),
      rawText: '用于新鲜度报告的一条笔记。',
      sourceType: 'other',
      sourceRef: null,
    }).item;

    const created = createGraphView(db, {
      name: '新鲜度路由用例',
      selection: { mode: 'explicit', itemIds: [item.id] },
      positions: {},
      direction: 'LR',
    });

    // 基线：直接服务层拿一次，记录它报告的字段。
    const before = getViewFreshness(db, created.id);
    const rowBefore = db
      .prepare('SELECT generated_at FROM views WHERE id = ?')
      .get(created.id) as { generated_at: string | null };

    const { GET } = await freshnessRoute();
    const response = await callRoute(GET, {
      method: 'GET',
      path: `/api/views/${created.id}/freshness`,
      params: { id: created.id },
    });

    expect(response.status).toBe(200);
    expect(response.envelope.ok).toBe(true);
    if (!response.envelope.ok) return;

    // 信封里的数据与服务层一致（handler 没有自己另算一遍）。
    const data = response.envelope.data as { isStale: boolean };
    expect(data.isStale).toBe(before.isStale);

    // 严格读语义（T059-R05）：generatedAt 不得因为读新鲜度而被推进。
    const rowAfter = db
      .prepare('SELECT generated_at FROM views WHERE id = ?')
      .get(created.id) as { generated_at: string | null };
    expect(rowAfter.generated_at).toBe(rowBefore.generated_at);
  });

  it('T077-C04 只读路由不导出写入方法', async () => {
    const route = (await freshnessRoute()) as Record<string, unknown>;
    // 一条只读路由若顺手导出了 POST，它会成为另一个写入面而不经过本文件的检查。
    expect(typeof route.GET).toBe('function');
    expect(route.POST).toBeUndefined();
    expect(route.PATCH).toBeUndefined();
    expect(route.DELETE).toBeUndefined();
  });

  it('T077-C04 未授权请求被本地守卫拒绝，且用统一错误信封', async () => {
    const { GET } = await freshnessRoute();
    const response = await callRoute(GET, {
      method: 'GET',
      path: `/api/views/${newId()}/freshness`,
      params: { id: newId() },
      token: null,
    });

    expect(response.status).toBe(403);
    expect(response.envelope.ok).toBe(false);
    if (response.envelope.ok) return;
    // 守卫用的是统一错误协议，不是自定义形状。
    expect(typeof response.envelope.error.code).toBe('string');
    expect(response.envelope.error.code.length).toBeGreaterThan(0);
  });
});
