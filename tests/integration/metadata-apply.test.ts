/**
 * T038 验收用例｜整理字段应用与人工保护
 *
 * 这组用例只验证一件事：**模型写不进用户已经决定的东西**。因此每个场景都先
 * 记下目标与依赖实体的版本，再触发应用，然后同时复核「应变」与「不应变」。
 *
 * 应用函数本身要求调用方在事务里，所以这里显式开事务，让断言看到的正是
 * 提交后的状态；冲突与失败场景则断言事务里没有留下半条更新。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import { LIMITS } from '@/domain/limits';
import { normalizeTag } from '@/domain/tags';
import { withTransaction } from '@/server/db/database';
import { applyOrganizeMetadata } from '@/server/services/applyOrganizeMetadata';
import { createCapture, patchItem } from '@/server/services/items';
import { syncItemStatus } from '@/server/services/status';
import { getItem } from '@/server/repositories/items';
import type { OrganizeOutput } from '@/domain/schemas/organize';
import { createTestDatabase, openTestDatabase, newId, type TestDatabase } from '../helpers/db';

let test: TestDatabase;
let db: DatabaseSync;

beforeEach(() => {
  test = createTestDatabase();
  db = openTestDatabase(test.databasePath);
});

afterEach(() => {
  test.cleanup();
});

function seed(rawText = '原始材料：关于番茄工作法的笔记。') {
  return createCapture(db, {
    captureRequestId: newId(),
    rawText,
    sourceType: 'myself',
    sourceRef: null,
  }).item;
}

function organized(overrides: Partial<OrganizeOutput> = {}): OrganizeOutput {
  return {
    title: '模型给的标题',
    summary: '模型给的摘要',
    type: 'concept',
    tags: ['时间管理', '专注'],
    keywords: ['番茄工作法', '专注度'],
    importance: 4,
    relations: [],
    ...overrides,
  };
}

/** Apply inside the transaction the production flow uses. */
function apply(itemId: string, expectedRevision: number, output: OrganizeOutput) {
  return withTransaction(db, () => {
    const current = getItem(db, itemId);
    return applyOrganizeMetadata({
      db,
      current,
      organized: output,
      expectedRevision,
      expectedRawVersion: current.rawVersion,
      now: new Date().toISOString(),
    });
  });
}

describe('T038 整理字段应用', () => {
  it('T038-C01 已锁定的摘要保持原值，未锁的标签照常应用', () => {
    const item = seed();
    // 用户手动改了摘要：该字段被锁定，标签仍未锁。
    const edited = patchItem(db, {
      id: item.id,
      expectedRevision: item.revision,
      patch: { summary: '我自己精修过的摘要' },
    });
    expect(edited.manualFields).toEqual(['summary']);

    const result = apply(edited.id, edited.revision, organized());

    const after = getItem(db, edited.id);
    // 手工精修成果不能被批量更新抹掉。
    expect(after.summary).toBe('我自己精修过的摘要');
    // 未锁字段正常写入。
    expect(after.title).toBe('模型给的标题');
    expect(after.tags).toEqual(['时间管理', '专注']);
    expect(result.skipped).toContain('summary');
    expect(result.applied).toContain('tags');
  });

  it('T038-C02 六个字段全锁时仍成功结束，并说明没有覆盖任何字段', () => {
    const item = seed();
    const locked = patchItem(db, {
      id: item.id,
      expectedRevision: item.revision,
      patch: {
        title: '我的标题',
        summary: '我的摘要',
        type: 'question',
        tags: ['我的标签'],
        keywords: ['我的关键词'],
        importance: 2,
      },
    });
    expect(locked.manualFields).toHaveLength(6);

    const result = apply(locked.id, locked.revision, organized());

    const after = getItem(db, locked.id);
    expect(after.title).toBe('我的标题');
    expect(after.summary).toBe('我的摘要');
    expect(after.type).toBe('question');
    expect(after.tags).toEqual(['我的标签']);
    expect(after.keywords).toEqual(['我的关键词']);
    expect(after.importance).toBe(2);

    // 空应用是成功而不是失败，也不能偷偷解锁。
    expect(result.nothingApplied).toBe(true);
    expect(result.changed).toBe(false);
    expect(after.manualFields).toHaveLength(6);
  });

  it('T038-C03 模型输出里的额外字段在上游就被拒绝，原文不受影响', async () => {
    const item = seed();
    const before = getItem(db, item.id);

    // schema 层是 strict 的：rawText/id/revision 这类字段一律拒绝。
    const { organizeOutputSchema } = await import('@/domain/schemas/organize');
    const parsed = organizeOutputSchema.safeParse({
      ...organized(),
      rawText: '我想改写你的原文',
    });
    expect(parsed.success).toBe(false);

    const parsedId = organizeOutputSchema.safeParse({ ...organized(), id: newId() });
    expect(parsedId.success).toBe(false);

    // 应用函数本身也没有接收这些字段的参数，原文因此必然不变。
    const after = getItem(db, item.id);
    expect(after.rawText).toBe(before.rawText);
    expect(after.rawVersion).toBe(before.rawVersion);
  });

  it('T038-C04 模型期间用户只改了标题，仍按 revision 整次冲突且一个字段都不写', () => {
    const item = seed();
    const staleRevision = item.revision;

    // 模型在飞的时候，用户改了标题——原文没变，但意图已经不同。
    const edited = patchItem(db, {
      id: item.id,
      expectedRevision: item.revision,
      patch: { title: '我在模型期间改的标题' },
    });

    const caught = (() => {
      try {
        return apply(item.id, staleRevision, organized());
      } catch (error) {
        return error;
      }
    })();

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('REVISION_CONFLICT');

    const after = getItem(db, item.id);
    // 即使原文没变，也不能用逐字段猜测的方式覆盖人工新意图。
    expect(after.title).toBe('我在模型期间改的标题');
    expect(after.summary).toBe('');
    expect(after.tags).toEqual([]);
    expect(after.revision).toBe(edited.revision);
  });

  it('T038-C05 模型返回 AI 与 ai 时复用同一个 tagId 并保序去重', () => {
    const item = seed();
    const result = apply(item.id, item.revision, organized({ tags: ['AI', 'ai', '专注'] }));

    const rows = db
      .prepare(
        `SELECT t.id AS id, t.label AS label FROM item_tags it JOIN tags t ON t.id = it.tag_id
          WHERE it.item_id = ? ORDER BY it.position`,
      )
      .all(item.id) as { id: string; label: string }[];

    // 模型路径与人工路径共用同一套规范化：大小写不同不是两个标签。
    expect(normalizeTag('AI')).toBe(normalizeTag('ai'));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(rows.map((row) => row.label)).toEqual(['AI', '专注']);
    expect(result.applied).toContain('tags');

    // 字典里也只多了一条，不是 AI 与 ai 两条。
    const dict = db.prepare('SELECT normalized FROM tags ORDER BY normalized').all() as {
      normalized: string;
    }[];
    expect(dict.map((row) => row.normalized)).toEqual(['ai', '专注']);
  });

  it('T038-C06 多字段加标签一起应用时 revision 只增加一次', () => {
    const item = seed();
    const before = getItem(db, item.id);

    apply(item.id, item.revision, organized());

    const after = getItem(db, item.id);
    // 每字段各加一次版本会让来源快照无法解释，所以必须整体一次。
    expect(after.revision).toBe(before.revision + 1);
    expect(after.rawVersion).toBe(before.rawVersion);
    expect(after.structuredBaseRawVersion).toBe(before.rawVersion);
  });
});

describe('T038 规则落点', () => {
  it('T038-R01 应用不会写 rawText、capturedText、sourceRef、id 或系统版本', () => {
    const item = seed('来源材料，含来源信息。');
    const withSource = patchItem(db, {
      id: item.id,
      expectedRevision: item.revision,
      patch: { sourceRef: 'https://example.com/article' },
    });

    apply(withSource.id, withSource.revision, organized());

    const after = getItem(db, withSource.id);
    expect(after.id).toBe(withSource.id);
    expect(after.capturedText).toBe(withSource.capturedText);
    expect(after.rawText).toBe(withSource.rawText);
    expect(after.rawVersion).toBe(withSource.rawVersion);
    expect(after.sourceRef).toBe('https://example.com/article');
    expect(after.createdAt).toBe(withSource.createdAt);
  });

  it('T038-R04 关键词走共享去重与限长规则', () => {
    const item = seed();
    const many = Array.from({ length: LIMITS.keywordsPerItem + 6 }, (_, index) => `关键词${index}`);
    apply(item.id, item.revision, organized({ keywords: [...many, '关键词0'] }));

    const after = getItem(db, item.id);
    expect(after.keywords.length).toBeLessThanOrEqual(LIMITS.keywordsPerItem);
    expect(new Set(after.keywords).size).toBe(after.keywords.length);
    // 超长的关键词不写入，而不是截断成另一个词。
    apply(item.id, after.revision, organized({ keywords: ['x'.repeat(200)] }));
    const afterLong = getItem(db, item.id);
    expect(afterLong.keywords).not.toContain('x'.repeat(200));
  });

  it('T038-R05 成功的应用把 structuredBaseRawVersion 对齐本次原文版本，状态由统一 helper 派生', () => {
    const item = seed();
    // 先改一次原文，制造 rawVersion 2，确认对齐的是当前值。
    const edited = patchItem(db, {
      id: item.id,
      expectedRevision: item.revision,
      patch: { rawText: '第二版原文，关于专注方法。' },
    });
    expect(edited.rawVersion).toBe(2);
    expect(edited.structuredBaseRawVersion).toBeNull();

    // 状态由编排层调用 syncItemStatus 统一派生，这里一并验证，避免每个页面
    // 自己推一套规则。
    const status = withTransaction(db, () => {
      applyOrganizeMetadata({
        db,
        current: edited,
        organized: organized(),
        expectedRevision: edited.revision,
        expectedRawVersion: edited.rawVersion,
        now: new Date().toISOString(),
      });
      return syncItemStatus(db, edited.id);
    });

    const after = getItem(db, edited.id);
    expect(after.structuredBaseRawVersion).toBe(2);
    expect(after.isStructuredStale).toBe(false);
    expect(status).toBe('done');
    expect(after.status).toBe('done');
  });

  it('T038-R03 rawVersion 在应用期间变化时整次拒绝', () => {
    const item = seed();
    // rawVersion 已推进，但调用方拿的是模型读取时的旧快照。
    const advanced = patchItem(db, {
      id: item.id,
      expectedRevision: item.revision,
      patch: { rawText: '用户改过的新原文。' },
    });
    expect(advanced.rawVersion).toBe(2);

    const caught = (() => {
      try {
        return withTransaction(db, () =>
          applyOrganizeMetadata({
            db,
            current: advanced,
            organized: organized(),
            expectedRevision: advanced.revision,
            // 模型读的是 rawVersion 1。
            expectedRawVersion: 1,
            now: new Date().toISOString(),
          }),
        );
      } catch (error) {
        return error;
      }
    })();

    // revision 相同但原文版本已变：同样不能提交，否则会给旧文字配新摘要。
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('REVISION_CONFLICT');

    const after = getItem(db, item.id);
    expect(after.title).toBe('');
    expect(after.summary).toBe('');
    expect(after.revision).toBe(advanced.revision);
    expect(after.structuredBaseRawVersion).toBeNull();
  });

  it('T038-R06 importance 按模型给出的值写入，不被内容敏感度抬高', () => {
    const item = seed('一段很敏感的个人记录，但我认为不重要。');
    apply(item.id, item.revision, organized({ importance: 1 }));

    const after = getItem(db, item.id);
    // 1 就是 1：应用层不因为内容敏感或偏好而强行提高排序权重。
    expect(after.importance).toBe(1);
  });

  it('T038-C04 应用失败后没有任何字段被写进去', () => {
    const item = seed();
    const before = getItem(db, item.id);

    try {
      apply(item.id, before.revision + 1, organized());
    } catch {
      // 预期路径。
    }

    const after = getItem(db, item.id);
    expect(after.revision).toBe(before.revision);
    expect(after.title).toBe(before.title);
    expect(after.tags).toEqual([]);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM tags').get() as { n: number }).n,
    ).toBe(0);
  });
});
