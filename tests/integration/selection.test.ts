/**
 * T021 验收：跨视图材料选择与数量预算（服务端规则）。
 *
 * 用例规格：docs/05_tests/G1/T021_cases.md。审计结论是「选择/预算规则无服务端断言，
 * 证据仅 e2e 托盘文案」。服务端有两条真实入口承担这些规则：
 *   - `POST /api/views/mindmap/generate` 只会拿到 `{mode:'explicit',itemIds}`，由
 *     `captureSources` 重新读库并以点击时的解析结果建快照；
 *   - `GET /api/selection` 是「将要发送什么」的只读预览，负责快照解析、去重、
 *     上限拒绝和已删来源的拒绝。
 * 浏览器侧的托盘数量、隐藏计数与草稿状态与真实渲染耦合，node 环境无法断言，
 * 这一部分仍只由 e2e 覆盖（见报告「仍无法补上证据」）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import { LIMITS } from '@/domain/limits';
import { checkSelection, remainingSelectionBudget } from '@/domain/selection';
import type { LlmConfig, UUID } from '@/domain/knowledge';
import { OpenAICompatibleAdapter } from '@/server/llm/adapter';
import type { Transport, TransportRequest, TransportResponse } from '@/server/llm/transport';
import { callSnapshot } from '@/server/llm/types';
import { createCapture } from '@/server/services/items';
import { generateMindmap } from '@/server/services/generateMindmap';
import { resolveSelection } from '@/server/services/selection';
import { captureSources } from '@/server/services/views/captureSources';
import { ensureTag, setItemTags } from '@/server/repositories/tags';
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

function capture(rawText: string): UUID {
  return createCapture(db, {
    captureRequestId: newId(),
    rawText,
    sourceType: 'other',
    sourceRef: null,
  }).item.id;
}

function tagId(label: string): UUID {
  return ensureTag(db, label, nowIso());
}

function countRows(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

const CONFIG: LlmConfig = {
  adapter: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  model: 'selection-test-model',
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

class CountingTransport implements Transport {
  calls = 0;
  readonly bodies: string[] = [];

  constructor(private readonly reply: () => TransportResponse) {}

  async send(request: TransportRequest): Promise<TransportResponse> {
    this.calls += 1;
    this.bodies.push(request.body);
    return this.reply();
  }
}

describe('T021-C01 选择以 ID 为权威且去重', () => {
  it('T021-C01/R01 同一 ID 从多个入口进入时只算一次，且预览不含原文副本', () => {
    const first = capture('第一条被重复选中的原文。');
    const second = capture('第二条。');
    const tag = tagId('重复入口标签');
    setItemTags(db, first, ['重复入口标签'], nowIso());

    // 同一条同时以「显式勾选」和「标签入口」到达：这正是托盘上重复勾选的形态。
    const resolved = resolveSelection(db, {
      itemIds: [first, second, first],
      fromTagId: tag,
    });

    expect(resolved.count).toBe(2);
    expect(resolved.itemIds).toEqual([first, second]);
    expect(new Set(resolved.itemIds).size).toBe(2);
    // R01：只回 id/版本/标题/摘要片段，界面不能靠这份响应拿到原文副本。
    for (const source of resolved.sources) {
      expect(Object.keys(source).sort()).toEqual(['excerpt', 'id', 'rawVersion', 'revision', 'title']);
    }
  });

  it('T021-C01 显式列表里的重复 ID 被显式拒绝，不静默去重', () => {
    const check = checkSelection(['a', 'b', 'a']);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('duplicate');
    expect(check.itemIds).toEqual([]);

    const ok = checkSelection(['a', 'b']);
    expect(ok.ok).toBe(true);
    expect(ok.itemIds).toEqual(['a', 'b']);
    expect(remainingSelectionBudget(LIMITS.selectedItemsPerProjection - 2)).toBe(2);
  });
});

describe('T021-C02 数量预算', () => {
  it('T021-C02 四十一条被拒绝并说明要减少多少，而不是截断成四十条', () => {
    const ids = Array.from({ length: LIMITS.selectedItemsPerProjection + 1 }, (_, index) =>
      capture(`预算测试第 ${index} 条`),
    );

    let raised: unknown = null;
    try {
      resolveSelection(db, { itemIds: ids });
    } catch (error) {
      raised = error;
    }

    const error = raised as AppError;
    expect(error.code).toBe('VALIDATION');
    // 提示里带具体数字，用户才知道要缩小多少。
    expect(error.message).toContain(String(LIMITS.selectedItemsPerProjection));
    expect(error.message).toContain(String(ids.length));
    expect(error.fieldErrors?.itemIds?.join(' ')).toContain(
      String(LIMITS.selectedItemsPerProjection),
    );
  });

  it('T021-C02 恰好四十条通过：上限本身不是越界', () => {
    const ids = Array.from({ length: LIMITS.selectedItemsPerProjection }, (_, index) =>
      capture(`满额第 ${index} 条`),
    );

    const resolved = resolveSelection(db, { itemIds: ids });
    expect(resolved.count).toBe(LIMITS.selectedItemsPerProjection);
    expect(resolved.limit).toBe(LIMITS.selectedItemsPerProjection);
  });

  it('T021-C02/R02 按标签选中超过上限时同样拒绝，不静默取前四十条', () => {
    const tag = tagId('超额标签');
    for (let index = 0; index < LIMITS.selectedItemsPerProjection + 1; index += 1) {
      const id = capture(`标签超额第 ${index} 条`);
      setItemTags(db, id, ['超额标签'], nowIso());
    }

    let raised: unknown = null;
    try {
      resolveSelection(db, { fromTagId: tag });
    } catch (error) {
      raised = error;
    }
    expect((raised as AppError).code).toBe('VALIDATION');
    expect((raised as AppError).message).toContain(String(LIMITS.selectedItemsPerProjection));
  });
});

describe('T021-C03 隐藏选中', () => {
  it('T021-C03 切换筛选后仍选中的隐藏条目被计数，而不是消失', () => {
    const visible = capture('在筛选里的记录。');
    const hiddenA = capture('被筛选隐藏的第一条。');
    const hiddenB = capture('被筛选隐藏的第二条。');
    const filterTag = tagId('托盘筛选标签');
    setItemTags(db, visible, ['托盘筛选标签'], nowIso());
    // 隐藏的两条先选上再切筛选，才符合用例的前置。
    for (const id of [visible, hiddenA, hiddenB]) {
      expect(resolveSelection(db, { itemIds: [id] }).count).toBe(1);
    }

    const resolved = resolveSelection(db, {
      itemIds: [visible, hiddenA, hiddenB],
      filterTagId: filterTag,
    });

    expect(resolved.count).toBe(3);
    expect(resolved.hiddenByFilter).toBe(2);
    expect(resolved.itemIds).toEqual([visible, hiddenA, hiddenB]);
  });

  it('T021-C03 没有筛选时隐藏计数为 null，界面不能把它当成 0 条被隐藏', () => {
    const only = capture('唯一一条。');
    const resolved = resolveSelection(db, { itemIds: [only] });
    expect(resolved.hiddenByFilter).toBeNull();
  });
});

describe('T021-C04 已删来源', () => {
  it('T021-C04 预览阶段已删条目被拒绝并要求重新选择，不静默跳过', () => {
    const alive = capture('仍然存在的来源。');
    const gone = capture('稍后被删掉的来源。');
    db.prepare('DELETE FROM knowledge_items WHERE id = ?').run(gone);

    let raised: unknown = null;
    try {
      resolveSelection(db, { itemIds: [alive, gone] });
    } catch (error) {
      raised = error;
    }

    const error = raised as AppError;
    expect(error.code).toBe('VALIDATION');
    expect(error.message).toContain('已经不存在');
    // 缺失的 id 被指名，用户知道是哪一条。
    expect(error.fieldErrors?.itemIds?.join(' ')).toContain(gone);
  });

  it('T021-C04 生成路径同样报出缺失来源，而不是假装来源完整', async () => {
    const alive = capture('仍然存在的来源。');
    const gone = capture('生成前被删掉的来源。');
    db.prepare('DELETE FROM knowledge_items WHERE id = ?').run(gone);

    const captured = captureSources(db, {
      selection: { mode: 'explicit', itemIds: [alive, gone] },
    });
    expect(captured.missingItemIds).toEqual([gone]);
    expect(captured.items.map((item) => item.id)).toEqual([alive]);

    const transport = new CountingTransport(() =>
      chatOk(
        JSON.stringify({
          title: '缺来源的脑图',
          nodes: [
            { id: 'n1', parentId: null, label: '根', itemIds: [alive], kind: 'note' },
          ],
        }),
      ),
    );
    const result = await generateMindmap(db, {
      requestKey: newId(),
      selection: { mode: 'explicit', itemIds: [alive, gone] },
      config: callSnapshot(CONFIG, 'sk-test-SELECTION-000000000000'),
      configRevision: 1,
      schemaRepairEnabled: false,
      adapter: new OpenAICompatibleAdapter(transport),
    });

    // 缺失来源进入警告与视图的 missingSourceIds，用户能看见少了一条。
    expect(result.warnings.join(' ')).toContain('不存在');
    const view = db
      .prepare('SELECT source_snapshot_json FROM views WHERE id = ?')
      .get(result.viewId) as { source_snapshot_json: string };
    const snapshot = JSON.parse(view.source_snapshot_json) as { items: { id: string }[] };
    expect(snapshot.items.map((entry) => entry.id)).toEqual([alive]);
  });
});

describe('T021-C05 标签快照', () => {
  it('T021-C05 按标签解析后新增同标签记录，不改写已解析的 ID 列表', () => {
    const tag = tagId('快照标签');
    const first = capture('快照时的第一条。');
    setItemTags(db, first, ['快照标签'], nowIso());

    const before = resolveSelection(db, { fromTagId: tag });
    expect(before.itemIds).toEqual([first]);

    // 用户点生成之后（或之前），同标签又加了一条：已经解析出的列表是权威。
    const later = capture('解析之后才加上的同标签记录。');
    setItemTags(db, later, ['快照标签'], nowIso());

    const again = resolveSelection(db, { fromTagId: tag });
    expect(again.itemIds).toHaveLength(2);
    // 关键是「已发出的那一次」不会被后来的解析悄悄改写。
    expect(before.itemIds).toEqual([first]);
    expect(before.itemIds).not.toContain(later);
  });

  it('T021-C05 生成时的快照记下解析结果与版本，后续新增不改变已保存视图', async () => {
    // 标签本身只用于建立同标签材料；这条断言的是「生成时的解析结果被固化」。
    tagId('版本快照标签');
    const first = capture('版本快照的第一条。');
    setItemTags(db, first, ['版本快照标签'], nowIso());

    const transport = new CountingTransport(() =>
      chatOk(
        JSON.stringify({
          title: '快照脑图',
          nodes: [
            { id: 'n1', parentId: null, label: '根', itemIds: [first], kind: 'note' },
          ],
        }),
      ),
    );
    const result = await generateMindmap(db, {
      requestKey: newId(),
      selection: { mode: 'explicit', itemIds: [first] },
      config: callSnapshot(CONFIG, 'sk-test-SELECTION-000000000000'),
      configRevision: 1,
      schemaRepairEnabled: false,
      adapter: new OpenAICompatibleAdapter(transport),
    });
    expect(transport.calls).toBe(1);

    const laterTagged = capture('生成之后加入同标签的记录。');
    setItemTags(db, laterTagged, ['版本快照标签'], nowIso());

    const row = db
      .prepare('SELECT source_snapshot_json FROM views WHERE id = ?')
      .get(result.viewId) as { source_snapshot_json: string };
    const snapshot = JSON.parse(row.source_snapshot_json) as {
      items: { id: string; rawVersion: number; revision: number }[];
    };
    expect(snapshot.items.map((entry) => entry.id)).toEqual([first]);
    expect(snapshot.items[0]?.rawVersion).toBe(1);
    expect(snapshot.items[0]?.revision).toBe(1);
  });
});

describe('T021-C06 无模型副作用', () => {
  it('T021-C06 预览与捕获来源都只读：不产生 Run，也不发外部请求', async () => {
    const first = capture('预览用第一条。');
    capture('预览用第二条。');
    const tag = tagId('只读标签');
    setItemTags(db, first, ['只读标签'], nowIso());
    const runsBefore = countRows('ai_runs');

    resolveSelection(db, { itemIds: [first], filterTagId: tag });
    captureSources(db, { selection: { mode: 'filter', filter: { tagId: tag } } });

    const { GET } = await import('@/app/api/selection/route');
    const response = await callRoute(GET, {
      method: 'GET',
      url: `http://127.0.0.1:3000/api/selection?itemId=${first}&filterTagId=${tag}`,
    });

    expect(response.status).toBe(200);
    expect(countRows('ai_runs')).toBe(runsBefore);
    // 预览响应只有 id/版本/标题/片段，没有原文，也没有任何 run 或密钥字段。
    const data = (response.envelope as { ok: true; data: { sources: Record<string, unknown>[] } })
      .data;
    for (const source of data.sources) {
      expect(JSON.stringify(source)).not.toContain('sk-');
      expect(source).not.toHaveProperty('rawText');
      expect(source).not.toHaveProperty('apiKey');
    }
  });
});

describe('T021 HTTP 层预览', () => {
  it('T021-C01/C03 重复的 itemId 参数被收集而不是相互覆盖', async () => {
    const first = capture('重复参数第一条。');
    const second = capture('重复参数第二条。');
    const hidden = capture('被筛选隐藏的一条。');
    const tag = tagId('HTTP 筛选标签');
    setItemTags(db, first, ['HTTP 筛选标签'], nowIso());

    const { GET } = await import('@/app/api/selection/route');
    const response = await callRoute(GET, {
      method: 'GET',
      url: `http://127.0.0.1:3000/api/selection?itemId=${first}&itemId=${second}&itemId=${hidden}&filterTagId=${tag}`,
    });

    expect(response.status).toBe(200);
    const data = (
      response.envelope as { ok: true; data: { itemIds: string[]; hiddenByFilter: number | null } }
    ).data;
    // 只保留最后一个是旧 bug 的形态：这里必须三条都在，且隐藏计数为 2。
    expect(data.itemIds).toEqual([first, second, hidden]);
    expect(data.hiddenByFilter).toBe(2);
  });

  it('T021-C04 HTTP 层已删来源返回 400 并指名缺失 ID', async () => {
    const alive = capture('HTTP 预览里仍然存在的来源。');
    const gone = capture('HTTP 预览前被删的来源。');
    db.prepare('DELETE FROM knowledge_items WHERE id = ?').run(gone);

    const { GET } = await import('@/app/api/selection/route');
    const response = await callRoute(GET, {
      method: 'GET',
      url: `http://127.0.0.1:3000/api/selection?itemId=${alive}&itemId=${gone}`,
    });

    expect(response.status).toBe(400);
    const failure = response.envelope as {
      ok: false;
      error: { code: string; fieldErrors?: Record<string, string[]> };
    };
    expect(failure.error.code).toBe('VALIDATION');
    expect(failure.error.fieldErrors?.itemIds?.join(' ')).toContain(gone);
  });

  it('T021 HTTP 层缺参数与未知参数都按查询 schema 拒绝', async () => {
    const { GET } = await import('@/app/api/selection/route');

    const empty = await callRoute(GET, {
      method: 'GET',
      url: 'http://127.0.0.1:3000/api/selection',
    });
    expect(empty.status).toBe(400);

    const unknown = await callRoute(GET, {
      method: 'GET',
      url: 'http://127.0.0.1:3000/api/selection?itemId=not-a-uuid',
    });
    expect(unknown.status).toBe(400);
  });
});
