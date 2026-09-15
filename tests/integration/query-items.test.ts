/**
 * T016 验收：资料库搜索、过滤与分页（服务层 + HTTP 层）。
 *
 * 用例规格：docs/05_tests/G1/T016_cases.md。仓储层的通用分页回归在
 * `repositories.test.ts`（自带 T010 标签）；本文件补齐审计点名的缺口：
 * 带 T016 标签、直接驱动 `queryItems`（服务层）与 `GET /api/items`（HTTP 层）的用例。
 *
 * 断言的是「中文子串能命中」「LIKE 通配符按字面」「筛选是 AND」「同时间戳翻页不抖」
 * 「零结果不是失败」这几条会在实现退化时真正失败的行为，而不是函数存在性。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import { LIMITS } from '@/domain/limits';
import { EMPTY_LIBRARY_QUERY, libraryQueryIdentity } from '@/domain/query';
import type { ItemDTO } from '@/domain/knowledge';
import { createCapture, listItemsService, patchItem } from '@/server/services/items';
import { queryItems, validateQueryItemsInput } from '@/server/services/queryItems';
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

function capture(rawText: string): ItemDTO {
  return createCapture(db, {
    captureRequestId: newId(),
    rawText,
    sourceType: 'other',
    sourceRef: null,
  }).item;
}

function tagItem(item: ItemDTO, labels: string[]): string {
  const now = nowIso();
  const tagId = ensureTag(db, labels[0] as string, now);
  setItemTags(db, item.id, labels, now);
  return tagId;
}

describe('T016 服务层搜索与筛选', () => {
  it('T016-C01 中文子串命中：不要求空格分词', () => {
    const hit = capture('这条记录讨论问题定义为什么重要。');
    capture('完全无关的一条：今晚吃什么。');

    const page = queryItems(db, { q: '问题定义' });

    expect(page.totalMatched).toBe(1);
    expect(page.items.map((item) => item.id)).toEqual([hit.id]);
  });

  it('T016-C01 搜索同时覆盖标题、摘要与标签名', () => {
    const item = capture('原文里没有那个词。');
    const now = nowIso();
    patchItem(db, {
      id: item.id,
      expectedRevision: item.revision,
      patch: { title: '关于检索的实现笔记', summary: '摘要里有 检索 两个字' },
    });
    const tagged = capture('标签命中的另一条。');
    ensureTag(db, '检索标签', now);
    setItemTags(db, tagged.id, ['检索标签'], now);

    const byTitle = queryItems(db, { q: '检索的实现' });
    expect(byTitle.items.map((entry) => entry.id)).toEqual([item.id]);

    const byTag = queryItems(db, { q: '检索标签' });
    expect(byTag.items.map((entry) => entry.id)).toEqual([tagged.id]);
  });

  it('T016-C02 百分号按字面搜索，不扩大成全库', () => {
    const literal = capture('折扣是 100% 的确定性。');
    capture('完全无关的另一条');
    capture('第三条也没有那个符号');

    const page = queryItems(db, { q: '%' });

    expect(page.totalMatched).toBe(1);
    expect(page.items.map((item) => item.id)).toEqual([literal.id]);
    expect(page.items[0]?.rawText).toContain('100%');
  });

  it('T016-C02 下划线与反斜杠同样按字面匹配', () => {
    const underscore = capture('字段名里有 item_tags 这样的下划线。');
    const backslash = capture('路径写作 C:\\temp\\brain 的反斜杠。');
    capture('既没有下划线也没有反斜杠的一条。');

    expect(queryItems(db, { q: 'item_tags' }).items.map((item) => item.id)).toEqual([
      underscore.id,
    ]);
    expect(queryItems(db, { q: '\\' }).items.map((item) => item.id)).toEqual([backslash.id]);
  });

  it('T016-C03 类型与标签同时生效，是 AND 而不是 OR', () => {
    const both = capture('既是指定类型也带指定标签。');
    const typeOnly = capture('只有类型匹配。');
    const tagOnly = capture('只有标签匹配。');

    const tagId = tagItem(both, ['筛选组合']);
    tagItem(tagOnly, ['筛选组合']);
    patchItem(db, {
      id: both.id,
      expectedRevision: both.revision,
      patch: { type: 'concept' },
    });
    patchItem(db, {
      id: typeOnly.id,
      expectedRevision: typeOnly.revision,
      patch: { type: 'concept' },
    });

    const page = queryItems(db, { type: 'concept', tagId });

    // OR 会让三条都出现；只有 AND 才得到这一条。
    expect(page.items.map((item) => item.id)).toEqual([both.id]);
    expect(page.totalMatched).toBe(1);
  });

  it('T016-C03 关键字与状态筛选也参与同一组 AND 条件', () => {
    const target = capture('关键字与状态同时命中的记录。');
    patchItem(db, {
      id: target.id,
      expectedRevision: target.revision,
      patch: { title: '状态目标' },
    });
    // 直接改写 status，避免依赖整理流程：状态筛选读的是同一列。
    db.prepare('UPDATE knowledge_items SET status = ? WHERE id = ?').run('done', target.id);
    const other = capture('关键字命中但状态不同的记录。');
    patchItem(db, {
      id: other.id,
      expectedRevision: other.revision,
      patch: { title: '状态目标二' },
    });

    const page = queryItems(db, { q: '状态目标', status: 'done' });
    expect(page.items.map((item) => item.id)).toEqual([target.id]);
  });

  it('T016-C06 零结果返回空页而不是抛错', () => {
    capture('确实存在的一条记录');

    const page = queryItems(db, { q: '绝对不存在的关键字' });

    expect(page.items).toEqual([]);
    expect(page.totalMatched).toBe(0);
    expect(page.nextCursor).toBeNull();
  });

  it('T016-R04 非法枚举与越界 limit 被显式拒绝，不静默取默认值', () => {
    const cases = [
      { type: '不是类型' },
      { status: '不是状态' },
      { sort: '不是排序' },
      { limit: '0' },
      { limit: String(LIMITS.listPageSizeMax + 1) },
      { limit: 'abc' },
    ];
    for (const input of cases) {
      let raised: unknown = null;
      try {
        validateQueryItemsInput(input);
      } catch (error) {
        raised = error;
      }
      expect((raised as AppError)?.code, `应拒绝 ${JSON.stringify(input)}`).toBe('VALIDATION');
    }

    const ok = validateQueryItemsInput({});
    expect(ok.limit).toBe(LIMITS.listPageSizeDefault);
    expect(ok.query).toEqual(EMPTY_LIBRARY_QUERY);
  });

  it('T016-R05 查询身份只由条件决定，条件不同则身份不同', () => {
    const base = { ...EMPTY_LIBRARY_QUERY, q: 'AI' };
    expect(libraryQueryIdentity(base)).toBe(libraryQueryIdentity({ ...base }));
    // 「搜 AI」与「搜 需求」必须能区分，否则迟到响应会被当成当前结果。
    expect(libraryQueryIdentity(base)).not.toBe(
      libraryQueryIdentity({ ...base, q: '需求' }),
    );
    expect(libraryQueryIdentity(base)).not.toBe(
      libraryQueryIdentity({ ...base, sort: 'oldest' }),
    );
    expect(libraryQueryIdentity(base)).not.toBe(
      libraryQueryIdentity({ ...base, type: 'concept' }),
    );
  });
});

describe('T016 同时间戳分页稳定', () => {
  /** Force identical created_at so the ORDER BY tie-breaker is the only ordering. */
  function captureWithSameTime(text: string, at: string): ItemDTO {
    const item = capture(text);
    db.prepare('UPDATE knowledge_items SET created_at = ?, updated_at = ? WHERE id = ?').run(
      at,
      at,
      item.id,
    );
    return item;
  }

  it('T016-C05 翻页不重复不遗漏，且同一页重复读取顺序一致', () => {
    const at = '2026-03-04T15:20:00.000Z';
    const created = Array.from({ length: 7 }, (_, index) => captureWithSameTime(`同刻第 ${index} 条`, at));
    const allIds = created.map((item) => item.id);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page: ReturnType<typeof listItemsService> = queryItems(db, {
        limit: '3',
        ...(cursor !== undefined ? { cursor } : {}),
      });
      pages += 1;
      expect(page.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.items.map((item) => item.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
      expect(pages).toBeLessThan(10);
    }

    // 没有重复，也没有漏掉任何一条 —— 缺少 ID 补充排序时这里会抖动。
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...allIds].sort());
    expect(pages).toBe(3);

    // 同一条件的第二遍翻页得到完全相同的顺序。
    const first = queryItems(db, { limit: '3' });
    const again = queryItems(db, { limit: '3' });
    expect(again.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
    // 时间相同时顺序由 id 决定（升序或降序都行），而不是碰巧沿用插入顺序。
    const asc = [...allIds].sort();
    const desc = [...asc].reverse();
    const firstIds = first.items.map((item) => item.id);
    expect(
      JSON.stringify(firstIds) === JSON.stringify(asc.slice(0, 3)) ||
        JSON.stringify(firstIds) === JSON.stringify(desc.slice(0, 3)),
      `同刻排序应由 id 决定，实际 ${JSON.stringify(firstIds)}`,
    ).toBe(true);
  });
});

describe('T016 HTTP 层读取', () => {
  async function getItems(query: Record<string, string>): Promise<{
    status: number;
    data: { items: ItemDTO[]; totalMatched: number; nextCursor: string | null };
  }> {
    const { GET } = await import('@/app/api/items/route');
    const search = new URLSearchParams(query).toString();
    const response = await callRoute(GET, {
      method: 'GET',
      url: `http://127.0.0.1:3000/api/items${search.length > 0 ? `?${search}` : ''}`,
    });
    const envelope = response.envelope as {
      ok: true;
      data: { items: ItemDTO[]; totalMatched: number; nextCursor: string | null };
    };
    return { status: response.status, data: envelope.ok ? envelope.data : ({} as never) };
  }

  it('T016-C01/C03 中文查询与筛选经由 HTTP 层得到同一结果', async () => {
    const hit = capture('HTTP 层中文检索目标。');
    capture('无关记录');
    const tagId = tagItem(hit, ['HTTP标签']);

    const byQuery = await getItems({ q: '中文检索' });
    expect(byQuery.status).toBe(200);
    expect(byQuery.data.items.map((item) => item.id)).toEqual([hit.id]);

    const byFilter = await getItems({ type: 'idea', tagId, limit: '5' });
    expect(byFilter.status).toBe(200);
    expect(byFilter.data.items.map((item) => item.id)).toEqual([hit.id]);
    expect(byFilter.data.totalMatched).toBe(1);
  });

  it('T016-C06 零结果的 HTTP 响应是 200 空页，不是错误信封', async () => {
    capture('存在的一条');
    const response = await getItems({ q: '不存在的关键字' });

    expect(response.status).toBe(200);
    expect(response.data.items).toEqual([]);
    expect(response.data.totalMatched).toBe(0);
    expect(response.data.nextCursor).toBeNull();
  });

  it('T016-R04 越界 limit 与非法排序被查询 schema 拒绝', async () => {
    const tooBig = await getItems({ limit: String(LIMITS.listPageSizeMax + 1) });
    expect(tooBig.status).toBe(400);

    const badSort = await getItems({ sort: 'random' });
    expect(badSort.status).toBe(400);
  });

  it('T016-C05 HTTP 分页游标可继续翻页并保持稳定', async () => {
    const at = '2026-03-04T15:20:00.000Z';
    for (let index = 0; index < 4; index += 1) {
      const item = capture(`HTTP 分页第 ${index} 条`);
      db.prepare('UPDATE knowledge_items SET created_at = ? WHERE id = ?').run(at, item.id);
    }

    const first = await getItems({ limit: '2' });
    expect(first.data.items).toHaveLength(2);
    expect(first.data.nextCursor).not.toBeNull();

    const second = await getItems({ limit: '2', cursor: first.data.nextCursor as string });
    expect(second.status).toBe(200);
    const firstIds = new Set(first.data.items.map((item) => item.id));
    expect(second.data.items.every((item) => !firstIds.has(item.id))).toBe(true);
    expect(second.data.nextCursor).toBeNull();
  });
});
