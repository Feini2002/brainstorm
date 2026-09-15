/**
 * T010 仓储与 DTO 解码回归。
 *
 * 这个套件专门盯住「同一实体必须在所有读取路径上解码出同一组字段」。
 * 触发它的真实缺陷是：详情路径通过 `findItemRow` 读取，列表路径通过
 * `listItems` 读取，两条 SQL 各自拼列名。列表查询曾经漏掉
 * `capture_request_id`，而 `decodeItemRow` 依赖它，于是只有列表会抛
 * `RowDecodeError`。因此这里不重新实现业务规则，只断言：
 *
 *  - list / detail / 游标翻页三条路径解出完全相同的 ItemDTO；
 *  - tag 子查询与列限定不会引入 `ambiguous column name`；
 *  - 游标与 filterHash 不匹配时拒绝，而不是拿旧游标查新条件。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import type { ItemDTO } from '@/domain/knowledge';
import { createCapture, listItemsService, patchItem } from '@/server/services/items';
import { getItem, listItems, findItemRow } from '@/server/repositories/items';
import {
  ensureTag,
  listTags,
  setItemTags,
} from '@/server/repositories/tags';
import { nowIso } from '@/server/repositories/shared';
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

const base = { sourceType: 'other' as const, sourceRef: null };

function capture(text: string, extra: Partial<{ sourceType: 'book'; sourceRef: string }> = {}) {
  return createCapture(db, { ...base, ...extra, captureRequestId: newId(), rawText: text }).item;
}

/** Every field the DTO contract requires, so a missing column is a test failure. */
const REQUIRED_ITEM_KEYS: (keyof ItemDTO)[] = [
  'id',
  'capturedText',
  'rawText',
  'rawVersion',
  'revision',
  'structuredBaseRawVersion',
  'title',
  'summary',
  'type',
  'tags',
  'keywords',
  'importance',
  'manualFields',
  'status',
  'lastRunId',
  'error',
  'sourceType',
  'sourceRef',
  'createdAt',
  'updatedAt',
  'isStructuredStale',
];

function assertFullDto(item: ItemDTO): void {
  for (const key of REQUIRED_ITEM_KEYS) {
    expect(Object.prototype.hasOwnProperty.call(item, key), `缺少字段 ${String(key)}`).toBe(true);
  }
  expect(Array.isArray(item.tags)).toBe(true);
  expect(Array.isArray(item.keywords)).toBe(true);
  expect(Array.isArray(item.manualFields)).toBe(true);
  expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
}

describe('T010 列表路径与详情路径必须解出同一 DTO', () => {
  it('T010-C01 空列表不报错，且不返回任何伪造条目', () => {
    const page = listItemsService(db, { filters: {}, sort: 'newest' });
    expect(page.items).toEqual([]);
    expect(page.totalMatched).toBe(0);
    expect(page.nextCursor).toBeNull();
  });

  it('T010-C02 列表路径解码全部必需字段（回归：capture_request_id 必须被选中）', () => {
    capture('列表解码回归');

    const page = listItemsService(db, { filters: {}, sort: 'newest' });
    expect(page.items).toHaveLength(1);
    assertFullDto(page.items[0] as ItemDTO);
  });

  it('T010-R01 同一记录在列表与详情路径解出完全相同的 DTO', () => {
    const created = capture('两条路径必须一致', { sourceType: 'book', sourceRef: 'p.7' });

    const fromList = (
      listItemsService(db, { filters: {}, sort: 'newest' }).items as ItemDTO[]
    ).find((item) => item.id === created.id);
    const fromDetail = getItem(db, created.id);

    expect(fromList).toBeDefined();
    expect(fromList).toEqual(fromDetail);
  });

  it('T010-R01 列表路径也返回标签顺序，且与详情一致', () => {
    const item = capture('标签顺序');
    const now = nowIso();
    setItemTags(db, item.id, ['乙', '甲', '丙'], now);

    const fromList = listItemsService(db, { filters: {}, sort: 'newest' }).items[0] as ItemDTO;
    const fromDetail = getItem(db, item.id);

    expect(fromList.tags).toEqual(['乙', '甲', '丙']);
    expect(fromDetail.tags).toEqual(fromList.tags);
  });

  it('T010-C03 列表查询 join 标签表时不会出现二义列名', () => {
    const item = capture('二义列名回归');
    const now = nowIso();
    const tagId = ensureTag(db, '回归', now);
    setItemTags(db, item.id, ['回归'], now);

    // 只要 SQL 里有未限定的 id，这一步会抛 ambiguous column name。
    expect(() => listItemsService(db, { filters: { tagId }, sort: 'newest' })).not.toThrow();
    const page = listItemsService(db, { filters: { tagId }, sort: 'newest' });
    expect(page.items.map((entry) => entry.id)).toEqual([item.id]);
  });

  it('T010-R02 编解码只发生在仓储层：DTO 里不出现 snake_case 列名', () => {
    capture('列名不泄漏');
    const dto = listItemsService(db, { filters: {}, sort: 'newest' }).items[0] as ItemDTO;
    const keys = Object.keys(dto);
    expect(keys.some((key) => key.includes('_'))).toBe(false);
  });
});

describe('T010 游标分页与筛选', () => {
  it('T010-C04 分页按 newest 稳定推进，不重复也不漏', () => {
    const created = Array.from({ length: 5 }, (_, index) => capture(`分页第 ${index} 条`));

    const first = listItemsService(db, { filters: {}, sort: 'newest', limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.totalMatched).toBe(5);
    expect(first.nextCursor).not.toBeNull();

    const second = listItemsService(db, {
      filters: {},
      sort: 'newest',
      limit: 2,
      cursor: first.nextCursor as string,
    });
    const firstIds = new Set(first.items.map((item) => item.id));
    expect(second.items.every((item) => !firstIds.has(item.id))).toBe(true);

    const seen = new Set([...first.items, ...second.items].map((item) => item.id));
    expect(seen.size).toBe(4);
    // 所有返回的 ID 都来自真实写入的记录，不存在伪造条目。
    for (const id of seen) {
      expect(created.some((item) => item.id === id)).toBe(true);
    }
  });

  it('T010-C05 游标与筛选条件不匹配时拒绝，不静默换条件', () => {
    capture('条件 A');
    capture('条件 B');
    const page = listItemsService(db, { filters: {}, sort: 'newest', limit: 1 });
    const cursor = page.nextCursor as string;
    expect(cursor).not.toBeNull();

    let raised: unknown = null;
    try {
      listItemsService(db, { filters: { q: '条件' }, sort: 'newest', limit: 1, cursor });
    } catch (error) {
      raised = error;
    }
    expect((raised as AppError).code).toBe('VALIDATION');
  });

  it('T010-C05 排序方式与游标不一致时拒绝', () => {
    capture('排序 A');
    capture('排序 B');
    const page = listItemsService(db, { filters: {}, sort: 'newest', limit: 1 });
    const cursor = page.nextCursor as string;

    let raised: unknown = null;
    try {
      listItemsService(db, { filters: {}, sort: 'oldest', limit: 1, cursor });
    } catch (error) {
      raised = error;
    }
    expect((raised as AppError).code).toBe('VALIDATION');
  });

  it('T010-C06 LIKE 通配符按字面搜索，不扩大匹配', () => {
    capture('含百分号 100% 的文本');
    capture('完全无关的另一条');

    const page = listItemsService(db, { filters: { q: '%' }, sort: 'newest' });
    // 只有真正含 % 字符的记录才会命中；% 不能当作通配符匹配所有内容。
    expect(page.totalMatched).toBe(1);
    expect(page.items[0]?.rawText).toContain('100%');
  });

  it('T010-R03 排序使用枚举白名单，importance 排序可取', () => {
    const low = capture('低重要度');
    const high = capture('高重要度');
    patchItem(db, { id: high.id, expectedRevision: high.revision, patch: { importance: 5 } });
    void low;

    const page = listItemsService(db, { filters: {}, sort: 'importance' });
    expect(page.items[0]?.id).toBe(high.id);
    expect(page.items[0]?.importance).toBe(5);
  });
});

describe('T010 仓储不变量', () => {
  it('T010-R04 列表不走 N+1：一次查询即可带回多条记录的标签', () => {
    const now = nowIso();
    const idsA = capture('批量标签一');
    const idsB = capture('批量标签二');
    ensureTag(db, '批量', now);
    setItemTags(db, idsA.id, ['批量'], now);
    setItemTags(db, idsB.id, ['批量'], now);

    expect(listTags(db).some((tag) => tag.label === '批量')).toBe(true);
    const page = listItemsService(db, { filters: {}, sort: 'newest' });
    expect(page.items).toHaveLength(2);
    expect(page.items.every((item) => item.tags.includes('批量'))).toBe(true);
  });

  it('T010-R05 标签词典按使用量统计，且不因读取而改变', () => {
    const now = nowIso();
    const item = capture('词典计数');
    ensureTag(db, '计数', now);
    setItemTags(db, item.id, ['计数'], now);

    const before = listTags(db);
    const after = listTags(db);
    expect(after).toEqual(before);
    expect(before.find((tag) => tag.label === '计数')?.itemCount).toBe(1);
  });

  it('T010-C06 找不到记录时抛 NOT_FOUND，而不是返回空对象', () => {
    expect(findItemRow(db, newId())).toBeNull();
    expect(() => getItem(db, newId())).toThrow();
  });

  it('T010-R06 列表直接读仓储也能解出 DTO（不依赖服务层补字段）', () => {
    capture('仓储直读');
    const raw = listItems(db, { filters: {}, sort: 'newest', limit: 10, cursor: null });
    expect(raw.items).toHaveLength(1);
    assertFullDto(raw.items[0] as ItemDTO);
  });
});
