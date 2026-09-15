/**
 * T017 验收：标签规范化与关联维护。
 *
 * 用例规格：docs/05_tests/G1/T017_cases.md。审计结论是「`normalizeTag` 只被其它测试
 * 当 helper 使用，没有任何针对 T017 规则的断言」。本文件按六条用例直接断言规范化、
 * 去重顺序、上限、事务替换、共享词典与人工保护，其中 C03（九个不同标签）在修复前
 * 会真实失败：服务端静默把第九个丢掉并返回 200，而契约与用例都要求验证失败并提示。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import { LIMITS } from '@/domain/limits';
import { normalizeTag, normalizeTagList } from '@/domain/tags';
import type { ItemDTO } from '@/domain/knowledge';
import { createCapture, deleteItemById, patchItem } from '@/server/services/items';
import { applyOrganizeMetadata } from '@/server/services/applyOrganizeMetadata';
import { findTagByNormalized, listTags, setItemTags } from '@/server/repositories/tags';
import { listItems } from '@/server/repositories/items';
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

/** Tag rows of one item, in stored position order. */
function tagRowsOf(itemId: string): { id: string; label: string; normalized: string }[] {
  return db
    .prepare(
      `SELECT t.id AS id, t.label AS label, t.normalized AS normalized
         FROM item_tags it JOIN tags t ON t.id = it.tag_id
        WHERE it.item_id = ? ORDER BY it.position`,
    )
    .all(itemId) as { id: string; label: string; normalized: string }[];
}

function dictionary(): { label: string; normalized: string }[] {
  return db.prepare('SELECT label, normalized FROM tags ORDER BY normalized').all() as {
    label: string;
    normalized: string;
  }[];
}

function itemCountOfTag(tagId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM item_tags WHERE tag_id = ?')
    .get(tagId) as { n: number };
  return row.n;
}

describe('T017-C01 大小写与空白重复', () => {
  it('T017-C01/R01 保存 AI、ai 与带首尾空格的 AI 只产生一个规范标签', () => {
    const item = capture('标签大小写重复的原文。');

    const edited = patchItem(db, {
      id: item.id,
      expectedRevision: item.revision,
      patch: { tags: ['AI', 'ai', '  AI  '] },
    });

    // 展示形式保留用户第一次选择的可读写法，规范键折叠大小写与空白。
    expect(edited.tags).toEqual(['AI']);
    const rows = tagRowsOf(item.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.normalized).toBe('ai');
    expect(dictionary()).toEqual([{ label: 'AI', normalized: 'ai' }]);
    // 关联位置从 0 开始连续，没有因为去重留下空洞。
    expect(
      db.prepare('SELECT position FROM item_tags WHERE item_id = ?').all(item.id),
    ).toEqual([{ position: 0 }]);
  });

  it('T017-C01/R01 规范化不改写原文，只作用于标签匹配键', () => {
    // NFKC 会把全角字符折成半角：这必须发生在匹配键上，并且不改动用户看到的写法。
    expect(normalizeTag('  ＡＩ  ')).toBe('ai');
    expect(normalizeTagList(['  ＡＩ  ']).labels).toEqual(['ＡＩ']);

    const item = capture('原文里的全角 ＡＩ 不应被 NFKC。');
    expect(item.rawText).toBe('原文里的全角 ＡＩ 不应被 NFKC。');
  });

  it('T017-C01/R02 顺序稳定：同一次输入的首次出现顺序就是存储顺序', () => {
    const item = capture('顺序稳定性。');
    const edited = patchItem(db, {
      id: item.id,
      expectedRevision: item.revision,
      patch: { tags: ['丙', '甲', '丙', '乙'] },
    });
    expect(edited.tags).toEqual(['丙', '甲', '乙']);
    expect(tagRowsOf(item.id).map((row) => row.label)).toEqual(['丙', '甲', '乙']);
  });
});

describe('T017-C02 语义不同不合并', () => {
  it('T017-C02/R03 AI 与人工智能各自成为独立标签，词典里是两条', () => {
    const item = capture('语义不同不应硬合并。');

    const edited = patchItem(db, {
      id: item.id,
      expectedRevision: item.revision,
      patch: { tags: ['AI', '人工智能'] },
    });

    expect(edited.tags).toEqual(['AI', '人工智能']);
    expect(dictionary()).toEqual([
      { label: 'AI', normalized: 'ai' },
      { label: '人工智能', normalized: '人工智能' },
    ]);
    // 没有做任何语义归并：两条规范键不同，也就不会复用同一个 tagId。
    expect(tagRowsOf(item.id)).toHaveLength(2);
  });

  it('T017-C02/R03 已有词典中的规范键被复用，不新建同义条目', () => {
    const first = capture('先建立词典的一条。');
    const second = capture('随后复用词典的一条。');
    const now = nowIso();
    const existingId = patchItem(db, {
      id: first.id,
      expectedRevision: first.revision,
      patch: { tags: ['时间管理'] },
    }).tags.length > 0
      ? (findTagByNormalized(db, '时间管理') as string)
      : '';
    expect(existingId).not.toBe('');

    patchItem(db, {
      id: second.id,
      expectedRevision: second.revision,
      patch: { tags: [' 时间管理 '] },
    });

    // 两次输入只对应一个词典条目与一个 tagId。
    expect(dictionary()).toHaveLength(1);
    expect(tagRowsOf(second.id)[0]?.id).toBe(existingId);
    expect(itemCountOfTag(existingId)).toBe(2);
    expect(now.length).toBeGreaterThan(0);
  });
});

describe('T017-C03 超出上限', () => {
  it('T017-C03 一次提供九个不同标签时验证失败并提示上限，不静默丢最后一个', () => {
    const item = capture('九个标签的原文。');
    const nine = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
    expect(nine).toHaveLength(LIMITS.tagsPerItem + 1);

    let raised: unknown = null;
    try {
      patchItem(db, {
        id: item.id,
        expectedRevision: item.revision,
        patch: { tags: nine },
      });
    } catch (error) {
      raised = error;
    }

    const error = raised as AppError;
    expect(error?.code).toBe('VALIDATION');
    // 提示必须点名上限，用户才知道被拒的原因不是网络或权限。
    expect(error.fieldErrors?.tags?.join(' ')).toContain(String(LIMITS.tagsPerItem));
    // 拒绝就是完全没有写入：一个标签都不该落库，词典也不该被创建。
    expect(tagRowsOf(item.id)).toEqual([]);
    expect(dictionary()).toEqual([]);
  });

  it('T017-C03/R02 去重后恰好八个仍然通过，上限按有效项而不是原始数组算', () => {
    const item = capture('去重后正好八个。');
    const edited = patchItem(db, {
      id: item.id,
      expectedRevision: item.revision,
      patch: { tags: ['一', '一', '二', '三', '四', '五', '六', '七', '八'] },
    });
    expect(edited.tags).toEqual(['一', '二', '三', '四', '五', '六', '七', '八']);
    expect(tagRowsOf(item.id)).toHaveLength(LIMITS.tagsPerItem);
  });

  it('T017-C03 原始数组超过四倍上限时先被 wire schema 拒绝，不做无界处理', async () => {
    const item = capture('原始数组过长。');
    const { PATCH } = await import('@/app/api/items/[id]/route');
    const response = await callRoute(PATCH, {
      method: 'PATCH',
      path: `/api/items/${item.id}`,
      body: {
        expectedRevision: item.revision,
        patch: {
          tags: Array.from({ length: LIMITS.tagsPerItem * 4 + 1 }, (_, index) => `标签${index}`),
        },
      },
      params: { id: item.id },
    });
    expect(response.status).toBe(400);
    expect((response.envelope as { ok: false; error: { code: string } }).error.code).toBe(
      'VALIDATION',
    );
    expect(tagRowsOf(item.id)).toEqual([]);
  });

  it('T017-C03 九个标签经 HTTP 层同样返回 400 而不是静默截断', async () => {
    const item = capture('HTTP 九个标签。');
    const { PATCH } = await import('@/app/api/items/[id]/route');
    const response = await callRoute(PATCH, {
      method: 'PATCH',
      path: `/api/items/${item.id}`,
      body: {
        expectedRevision: item.revision,
        patch: { tags: ['一', '二', '三', '四', '五', '六', '七', '八', '九'] },
      },
      params: { id: item.id },
    });

    expect(response.status).toBe(400);
    const failure = response.envelope as {
      ok: false;
      error: { code: string; fieldErrors?: Record<string, string[]> };
    };
    expect(failure.error.code).toBe('VALIDATION');
    expect(failure.error.fieldErrors?.tags?.join(' ')).toContain(String(LIMITS.tagsPerItem));
    expect(tagRowsOf(item.id)).toEqual([]);
  });
});

describe('T017-C04 事务替换', () => {
  it('T017-C04/R04 替换中途写入失败时原标签集合完整保留', () => {
    const item = capture('先有三个标签。');
    const withTags = patchItem(db, {
      id: item.id,
      expectedRevision: item.revision,
      patch: { tags: ['甲', '乙', '丙'] },
    });
    expect(withTags.tags).toEqual(['甲', '乙', '丙']);

    // 在标签写入的真实路径上注入故障：DELETE 已经执行、INSERT 抛错。
    // 这比 mock 掉整个函数更接近「替换中途失败」的形态（同 T036 的做法）。
    const original = db.prepare.bind(db);
    let armed = true;
    db.prepare = ((sql: string) => {
      if (armed && typeof sql === 'string' && /INSERT INTO item_tags/u.test(sql)) {
        armed = false;
        throw new Error('CHECK constraint failed: simulated tag write failure');
      }
      return original(sql);
    }) as typeof db.prepare;

    let raised: unknown = null;
    try {
      patchItem(db, {
        id: item.id,
        expectedRevision: withTags.revision,
        patch: { tags: ['新一', '新二'] },
      });
    } catch (error) {
      raised = error;
    } finally {
      db.prepare = original as typeof db.prepare;
    }

    expect(raised).toBeInstanceOf(AppError);
    // 先删后插如果没有事务，这里会看到空集合 —— 也就是永久丢标签。
    expect(tagRowsOf(item.id).map((row) => row.label)).toEqual(['甲', '乙', '丙']);
    expect(
      (db.prepare('SELECT revision FROM knowledge_items WHERE id = ?').get(item.id) as {
        revision: number;
      }).revision,
    ).toBe(withTags.revision);
  });

  it('T017-C04/R04 替换成功时旧关联全部消失，没有残留的死连接', () => {
    const item = capture('替换三个标签。');
    const first = patchItem(db, {
      id: item.id,
      expectedRevision: item.revision,
      patch: { tags: ['甲', '乙', '丙'] },
    });
    const replaced = patchItem(db, {
      id: item.id,
      expectedRevision: first.revision,
      patch: { tags: ['丙', '丁'] },
    });

    expect(replaced.tags).toEqual(['丙', '丁']);
    expect(tagRowsOf(item.id).map((row) => row.label)).toEqual(['丙', '丁']);
    // 词典保留不再被引用的条目（R06：清理孤儿是可选维护，不在主流程里顺手删）。
    expect(dictionary().map((row) => row.normalized).sort()).toEqual(['丁', '丙', '甲', '乙'].sort());
    expect(itemCountOfTag(findTagByNormalized(db, '甲') as string)).toBe(0);
  });
});

describe('T017-C05 共享词典', () => {
  it('T017-C05/R06 删除一个条目只断开连接，另一个仍可按该标签查到', () => {
    const target = capture('会被删除的条目。');
    const survivor = capture('继续使用该标签的条目。');
    const now = nowIso();
    setItemTags(db, target.id, ['共享词典标签'], now);
    setItemTags(db, survivor.id, ['共享词典标签'], now);
    const sharedId = findTagByNormalized(db, '共享词典标签') as string;
    expect(itemCountOfTag(sharedId)).toBe(2);

    deleteItemById(db, target.id, target.revision);

    // 词典条目没有被连带删除，计数减到 1。
    expect(findTagByNormalized(db, '共享词典标签')).toBe(sharedId);
    expect(itemCountOfTag(sharedId)).toBe(1);
    expect(listTags(db).map((tag) => tag.label)).toEqual(['共享词典标签']);
    // 存活条目仍然能按该标签被检索到（删除没有影响不相关记录）。
    const page = listItems(db, {
      filters: { tagId: sharedId },
      sort: 'newest',
      limit: 10,
      cursor: null,
    });
    expect(page.items.map((item) => item.id)).toEqual([survivor.id]);
  });

  it('T017-C05/R06 最后一个引用消失后词典条目仍在，孤儿清理是独立动作', () => {
    const item = capture('唯一引用者。');
    const now = nowIso();
    setItemTags(db, item.id, ['孤儿候选项'], now);

    deleteItemById(db, item.id, item.revision);

    expect(findTagByNormalized(db, '孤儿候选项')).not.toBeNull();
    expect(itemCountOfTag(findTagByNormalized(db, '孤儿候选项') as string)).toBe(0);
  });
});

describe('T017-C06 人工保护', () => {
  it('T017-C06/R05 人工锁定 tags 后模型返回另一组标签：保留人工标签并记录未应用原因', () => {
    const item = capture('人工整理过标签的原文。');
    const edited = patchItem(db, {
      id: item.id,
      expectedRevision: item.revision,
      patch: { tags: ['我的人工标签'], title: '用户标题' },
    });
    expect(edited.manualFields).toContain('tags');

    const result = applyOrganizeMetadata({
      db,
      current: edited,
      organized: {
        title: '模型标题',
        summary: '模型摘要',
        type: 'idea',
        tags: ['模型标签一', '模型标签二'],
        keywords: ['模型关键词'],
        importance: 3,
        relations: [],
      },
      expectedRevision: edited.revision,
      expectedRawVersion: edited.rawVersion,
      now: nowIso(),
    });

    expect(result.skipped).toContain('tags');
    expect(result.applied).toContain('keywords');
    // 人工标签原样保留，模型标签没有被写进连接，也没有被创建进词典。
    expect(tagRowsOf(item.id).map((row) => row.label)).toEqual(['我的人工标签']);
    expect(findTagByNormalized(db, '模型标签一')).toBeNull();
    expect(findTagByNormalized(db, '模型标签二')).toBeNull();
    expect(dictionary().map((row) => row.normalized)).toEqual(['我的人工标签']);
  });

  it('T017-C06/R05 未锁定时模型标签走同一规范化函数：大小写不同复用同一 tagId', () => {
    const seed = capture('词典里先有人工建立的 AI 标签。');
    patchItem(db, {
      id: seed.id,
      expectedRevision: seed.revision,
      patch: { tags: ['AI'] },
    });
    const existingId = findTagByNormalized(db, 'ai') as string;

    const target = capture('模型会返回 ai 的原文。');
    applyOrganizeMetadata({
      db,
      current: target,
      organized: {
        title: '模型标题',
        summary: '模型摘要',
        type: 'idea',
        tags: ['ai'],
        keywords: [],
        importance: 3,
        relations: [],
      },
      expectedRevision: target.revision,
      expectedRawVersion: target.rawVersion,
      now: nowIso(),
    });

    // 模型路径与人工路径共用同一套规范化：不是第二条词典记录。
    expect(tagRowsOf(target.id)[0]?.id).toBe(existingId);
    expect(dictionary()).toHaveLength(1);
  });
});
