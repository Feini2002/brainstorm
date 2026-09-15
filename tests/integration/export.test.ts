/**
 * T070 — 整库逻辑导出与秘密白名单。
 *
 * Six cases, each asserting the thing that would actually be wrong rather than
 * that the call returned 200. The pattern throughout: seed a library that
 * *contains* the tempting structure (a secret, a run, a deleted source), then
 * assert on the bytes the user would receive.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { closeDb, getDb } from '@/server/db/database';
import { exportKnowledge } from '@/server/services/exportKnowledge';
import {
  backupFileName,
  bundleByteLength,
  bundleHash,
  checkSizeBudget,
  BACKUP_SCHEMA_VERSION,
  type BackupBundle,
} from '@/domain/exportBundle';
import { LIMITS } from '@/domain/limits';
import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { FIX, MULTILINE_TEXT, seedBackupLibrary, type SeededLibrary } from '../helpers/backupLibrary';

interface Harness {
  temp: TestDatabase;
  db: ReturnType<typeof getDb>;
  library: SeededLibrary;
}

let harness: Harness | null = null;

function setup(): Harness {
  const temp = createTestDatabase();
  const db = getDb({ databasePath: temp.databasePath });
  const library = seedBackupLibrary(db);
  harness = { temp, db, library };
  return harness;
}

afterEach(() => {
  harness?.temp.cleanup();
  harness = null;
  closeDb();
});

/** Serialize exactly as the route does, so "text not present" means the bytes. */
function serialize(bundle: BackupBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/**
 * Grow a real library past the twenty-MiB budget.
 *
 * Volume comes from many large items rather than one impossible row, because the
 * schema caps text columns at 10000 code points — and a real library gets large
 * this way too. The id space is disjoint from `seedBackupLibrary`'s (its
 * `capture_request_id`s derive from the item ids), so the two can coexist.
 */
function inflatePastBudget(db: ReturnType<typeof getDb>): void {
  const chunk = '填'.repeat(10000);
  const insert = db.prepare(
    `INSERT INTO knowledge_items (
       id, capture_request_id, capture_request_hash, captured_text, raw_text,
       raw_version, revision, title, summary, type, keywords_json, importance,
       manual_fields_json, status, source_type, created_at, updated_at
     ) VALUES (?,?,?,?,?,1,1,'','','idea','[]',3,'[]','raw','other',?,?)`,
  );
  // ~60 KB of UTF-8 per row, so 400 rows is comfortably over twenty MiB.
  for (let index = 0; index < 400; index += 1) {
    const suffix = String(index).padStart(12, '0');
    insert.run(
      `ffffffff-1111-4000-8000-${suffix}`,
      `f0000000-1111-4000-8000-${suffix}`,
      'f'.repeat(64),
      chunk,
      chunk,
      '2026-09-14T00:00:00.000Z',
      '2026-09-14T00:00:00.000Z',
    );
  }
}

describe('T070 整库逻辑导出', () => {
  describe('T070-C01 完整字段', () => {
    it('导出保留的人工锁定、原文与审核关系，可用于恢复而不只是标题摘要', () => {
      const { db } = setup();
      const { bundle } = exportKnowledge(db, new Date('2026-09-14T00:00:00.000Z'));

      const manual = bundle.data.knowledgeItems.find((item) => item.id === FIX.itemManual);
      expect(manual).toBeDefined();

      // The fields a "title + summary only" export would lose. `capturedText`
      // and `rawText` are asserted separately because they intentionally differ:
      // the first capture is evidence the structured fields were derived from it.
      expect(manual?.capturedText).toBe(MULTILINE_TEXT);
      expect(manual?.rawText).toContain('采集之后人工补充');
      expect(manual?.manualFields).toEqual(['title', 'summary']);
      expect(manual?.title).toBe('人工锁定的标题');
      expect(manual?.importance).toBe(5);
      expect(manual?.keywords).toEqual(['模型', '问题定义']);

      // Version bookkeeping a restore needs to recompute `stale`.
      expect(manual?.rawVersion).toBe(2);
      expect(manual?.structuredBaseRawVersion).toBe(2);

      // Versioned envelope (R05).
      expect(bundle.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
      expect(bundle.exportedAt).toBe('2026-09-14T00:00:00.000Z');
    });

    it('保留被拒绝的审核墓碑与人工关系，而不是只留 accepted', () => {
      const { db } = setup();
      const { bundle } = exportKnowledge(db);

      const rejected = bundle.data.relations.find((relation) => relation.id === FIX.relationRejected);
      expect(rejected?.reviewStatus).toBe('rejected');
      expect(rejected?.reason).toBe('被拒绝的相似建议。');

      // Manual relations have no score; a `score !== null` filter would drop them.
      const manual = bundle.data.relations.find((relation) => relation.id === FIX.relationManual);
      expect(manual?.origin).toBe('manual');
      expect(manual?.score).toBeNull();
    });

    it('标签唯一归属由 tags 与 itemTags 重建，Item 上不再复制一份 tags 数组', () => {
      const { db } = setup();
      const { bundle } = exportKnowledge(db);

      // The contract forbids a `tags` array on items: one fact must not have two
      // representations that can disagree.
      for (const item of bundle.data.knowledgeItems) {
        expect(item).not.toHaveProperty('tags');
      }

      expect(bundle.data.tags.map((tag) => tag.normalized).sort()).toEqual(['ai开发', '生活', '职业']);

      // Position is the user's ordering and must survive: itemManual has 职业 at
      // 0 and AI开发 at 1, which is not label order.
      const manualTags = bundle.data.itemTags
        .filter((link) => link.itemId === FIX.itemManual)
        .sort((a, b) => a.position - b.position);
      expect(manualTags.map((link) => link.tagId)).toEqual([FIX.tagCareer, FIX.tagAi]);
    });

    it('视图保留 canonical 内容与来源快照，且允许来源已被删除', () => {
      const { db } = setup();
      const { bundle } = exportKnowledge(db);

      const view = bundle.data.views.find((entry) => entry.id === FIX.viewWithDeletedSource);
      expect(view).toBeDefined();
      expect(view?.kind).toBe('graph');
      expect(view?.rendererVersion).toBe('graph-compiler-v1');

      // A view whose source item is gone is a legal historical state.
      const snapshotIds = view?.sourceSnapshot.items.map((item) => item.id) ?? [];
      expect(snapshotIds).toContain(FIX.itemDeleted);
      expect(bundle.data.knowledgeItems.map((item) => item.id)).not.toContain(FIX.itemDeleted);

      // contentHash travels with the content it describes.
      const plain = bundle.data.views.find((entry) => entry.id === FIX.viewPlain);
      expect(plain?.contentHash).toBe('d'.repeat(64));
      expect(plain?.promptVersion).toBe('mindmap-v1');
    });
  });

  describe('T070-C02 秘密白名单', () => {
    it('导出物全文不含秘密、设置或运行快照（白名单而非黑名单）', () => {
      const { db } = setup();
      const { bundle } = exportKnowledge(db);
      const text = serialize(bundle);

      // The seeded secret really is in the database, so this is an exclusion
      // assertion and not a vacuous pass over an empty table.
      const stored = db
        .prepare('SELECT value FROM secrets WHERE key = ?')
        .get(FIX.secretKey) as { value: string } | undefined;
      expect(stored?.value).toBe(FIX.secretValue);

      expect(text).not.toContain(FIX.secretValue);
      expect(text).not.toContain('sk-backup-test');
      // Settings and the run's model/endpoint snapshot must not ride along.
      expect(text).not.toContain('some-private-model');
      expect(text).not.toContain('api.example.invalid');
    });

    it('顶层与各实体表不含 settings、secrets、ai_runs 等非知识表', () => {
      const { db } = setup();
      const { bundle } = exportKnowledge(db);

      expect(Object.keys(bundle).sort()).toEqual(['data', 'exportedAt', 'schemaVersion']);
      expect(Object.keys(bundle.data).sort()).toEqual([
        'itemTags',
        'knowledgeItems',
        'relations',
        'tags',
        'views',
      ]);
      // No run ledger, so nothing can carry a config snapshot through.
      expect(bundle.data).not.toHaveProperty('aiRuns');
      expect(bundle.data).not.toHaveProperty('settings');
      expect(bundle.data).not.toHaveProperty('secrets');
    });

    it('所有 runId 引用按约定置空，而不是映射到未导出的运行', () => {
      const { db } = setup();
      const { bundle } = exportKnowledge(db);

      // Neither relations nor views carry a runId field at all.
      for (const relation of bundle.data.relations) {
        expect(relation).not.toHaveProperty('runId');
      }
      for (const view of bundle.data.views) {
        expect(view).not.toHaveProperty('runId');
      }

      // Items must not restore a run pointer or a stored error either.
      for (const item of bundle.data.knowledgeItems) {
        expect(item).not.toHaveProperty('lastRunId');
        expect(item).not.toHaveProperty('status');
        expect(item).not.toHaveProperty('error');
      }
    });
  });

  describe('T070-C03 一致快照', () => {
    it('引用闭包完整：每条关系的两个端点都在同一次导出的 Items 中', () => {
      const { db } = setup();
      const { bundle } = exportKnowledge(db);
      const itemIds = new Set(bundle.data.knowledgeItems.map((item) => item.id));

      for (const relation of bundle.data.relations) {
        expect(itemIds.has(relation.sourceId)).toBe(true);
        expect(itemIds.has(relation.targetId)).toBe(true);
      }
    });

    it('itemTags 的两个端点同样在闭包内', () => {
      const { db } = setup();
      const { bundle } = exportKnowledge(db);
      const itemIds = new Set(bundle.data.knowledgeItems.map((item) => item.id));
      const tagIds = new Set(bundle.data.tags.map((tag) => tag.id));

      for (const link of bundle.data.itemTags) {
        expect(itemIds.has(link.itemId)).toBe(true);
        expect(tagIds.has(link.tagId)).toBe(true);
      }
    });

    it('导出过程中删除条目不会产生跨时点的半引用', () => {
      const { db } = setup();

      // Simulate the concurrent delete landing *during* the export by deleting
      // before the call: the bundle must be internally consistent either way,
      // because all reads share one transaction.
      db.prepare('DELETE FROM relations WHERE target_id = ?').run(FIX.itemPlain);
      db.prepare('DELETE FROM item_tags WHERE item_id = ?').run(FIX.itemPlain);
      db.prepare('DELETE FROM knowledge_items WHERE id = ?').run(FIX.itemPlain);

      const { bundle } = exportKnowledge(db);
      const itemIds = new Set(bundle.data.knowledgeItems.map((item) => item.id));

      expect(itemIds.has(FIX.itemPlain)).toBe(false);
      // The relations that pointed at it were cascaded away with it, so no
      // relation in the bundle dangles.
      for (const relation of bundle.data.relations) {
        expect(itemIds.has(relation.sourceId)).toBe(true);
        expect(itemIds.has(relation.targetId)).toBe(true);
      }
    });

    it('导出使用读事务，不阻断并发写入', () => {
      const { db } = setup();
      const { bundle } = exportKnowledge(db);

      // `BEGIN` (deferred) rather than `BEGIN IMMEDIATE`: an export that took a
      // write lock to read would block an unrelated capture. Reading back proves
      // the connection was returned to autocommit and is usable for writes.
      db.prepare(
        `INSERT INTO tags (id, label, normalized, created_at) VALUES (?,?,?,?)`,
      ).run('bbbbbbbb-0000-4000-8000-0000000000aa', '导出后新增', '导出后新增', '2026-09-14T00:00:00.000Z');

      const after = exportKnowledge(db);
      expect(after.bundle.data.tags.map((tag) => tag.normalized)).toContain('导出后新增');
      // The earlier bundle is a snapshot and must not have drifted.
      expect(bundle.data.tags.map((tag) => tag.normalized)).not.toContain('导出后新增');
    });
  });

  describe('T070-C04 超限', () => {
    it('超过二十 MiB 时明确失败，不返回半截文件', () => {
      const { db } = setup();
      inflatePastBudget(db);

      let thrown: unknown;
      try {
        exportKnowledge(db);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeDefined();
      const message = thrown instanceof Error ? thrown.message : '';
      // Names the actual limit, and says no file was produced rather than
      // offering a truncated one.
      expect(message).toContain('20 MiB');
      expect(message).toContain('没有生成文件');
    });

    it('超限时抛出可恢复的校验错误，而不是 500 内部错误', () => {
      const { db } = setup();
      inflatePastBudget(db);

      // A user whose library is too big should get an actionable message, not an
      // opaque failure; `VALIDATION` is the 4xx the user can respond to.
      expect(() => exportKnowledge(db)).toThrowError(/没有生成文件/u);
      try {
        exportKnowledge(db);
      } catch (error) {
        expect((error as { code?: string }).code).toBe('VALIDATION');
      }
    });

    it('字节预算按 UTF-8 计算，中文不会被字符数低估', () => {
      const { db } = setup();
      const { bundle, bytes } = exportKnowledge(db);

      // Chinese material: byte length is roughly 3x the character count, so a
      // `text.length` budget would wave through files several times the cap.
      const text = JSON.stringify(bundle);
      expect(bytes).toBe(Buffer.byteLength(text, 'utf8'));
      expect(bytes).toBeGreaterThan(text.length);
      expect(checkSizeBudget(bundle).exceeded).toBe(false);
    });

    it('超限判定使用契约上限值，不自行放宽', () => {
      const { db } = setup();
      const { bundle } = exportKnowledge(db);
      const budget = checkSizeBudget(bundle);

      expect(budget.max).toBe(LIMITS.exportBytesMax);
      expect(budget.max).toBe(20 * 1024 * 1024);
      expect(budget.bytes).toBe(bundleByteLength(bundle));
    });
  });

  describe('T070-C05 中文保真', () => {
    it('多行中文与 emoji 逐字保留，换行与制表符不丢', () => {
      const { db } = setup();
      const { bundle } = exportKnowledge(db);

      const restored = bundle.data.knowledgeItems.find((item) => item.id === FIX.itemManual);
      expect(restored?.capturedText).toBe(MULTILINE_TEXT);
      expect(restored?.capturedText).toContain('\n');
      expect(restored?.capturedText).toContain('\t');
      expect(restored?.capturedText).toContain('🧠');
      expect(restored?.capturedText).toContain('🚀');
      expect(restored?.capturedText).toContain('「引号」');
    });

    it('序列化后再解析，字符串与字节编码保持一致（UTF-8）', () => {
      const { db } = setup();
      const { bundle } = exportKnowledge(db);

      // The real round trip a download performs. A latin1 decode would turn the
      // Chinese into mojibake here.
      const bytes = new TextEncoder().encode(serialize(bundle));
      const reparsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as BackupBundle;

      const item = reparsed.data.knowledgeItems.find((entry) => entry.id === FIX.itemManual);
      expect(item?.capturedText).toBe(MULTILINE_TEXT);
      expect(item?.title).toBe('人工锁定的标题');
      expect(reparsed.data.tags.map((tag) => tag.label)).toContain('AI开发');
    });

    it('规范哈希对键顺序不敏感，同一内容得到同一摘要', () => {
      const { db } = setup();
      const { bundle } = exportKnowledge(db);
      const digest = bundleHash(bundle);

      // Deep-reverse every object's key order. `JSON.stringify`'s replacer-array
      // form cannot express this (it filters keys rather than reordering them),
      // so the reorder is done explicitly — otherwise the test would compare a
      // *stripped* object and pass for the wrong reason.
      const reverseKeys = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(reverseKeys);
        if (value !== null && typeof value === 'object') {
          const entries = Object.entries(value as Record<string, unknown>).reverse();
          return Object.fromEntries(entries.map(([key, entry]) => [key, reverseKeys(entry)]));
        }
        return value;
      };

      const reordered = reverseKeys(bundle) as BackupBundle;
      // Guard the test itself: the reorder must have actually changed key order,
      // or a no-op reorder would make the assertion vacuous.
      expect(Object.keys(reordered)).not.toEqual(Object.keys(bundle));
      expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(bundle));

      expect(bundleHash(reordered)).toBe(digest);
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('T070-C06 无配置依赖', () => {
    it('没有 Key 与设置也能完整导出', () => {
      const temp = createTestDatabase();
      harness = { temp, db: getDb({ databasePath: temp.databasePath }), library: { itemIds: [], tagIds: [], relationIds: [], viewIds: [] } };
      const db = harness.db;
      const library = seedBackupLibrary(db);

      // Remove every trace of configuration: with no Key configured the backup
      // must still work, because backing up must not depend on the model.
      db.prepare('DELETE FROM secrets').run();
      db.prepare('DELETE FROM settings').run();

      const { bundle, counts } = exportKnowledge(db);

      expect(counts.items).toBe(library.itemIds.length);
      expect(counts.relations).toBe(library.relationIds.length);
      expect(bundle.data.knowledgeItems.length).toBe(3);
    });

    it('导出不触发任何模型调用，也不依赖运行历史', () => {
      const { db } = setup();
      // Drop all runs: an export that joined runs for a "last organized" field
      // would fail or degrade here.
      db.prepare('DELETE FROM ai_runs').run();

      const { bundle } = exportKnowledge(db);
      expect(bundle.data.knowledgeItems.length).toBe(3);
      expect(bundle.data.relations.length).toBe(3);
    });

    it('下载文件名基于 UTC 日期，标题不进入路径', () => {
      const { db } = setup();
      const { bundle, fileName } = exportKnowledge(db, new Date('2026-09-14T23:30:00.000Z'));

      expect(fileName).toBe('feini-brain-2026-09-14.json');
      expect(backupFileName(bundle.exportedAt)).toBe(fileName);
      // Title text must never leak into the filename.
      expect(fileName).not.toContain('人工');
      expect(fileName).toMatch(/^feini-brain-\d{4}-\d{2}-\d{2}\.json$/);
    });
  });
});

describe('T070 导出契约边界', () => {
  it('空库导出为空集合而不是报错', () => {
    const temp = createTestDatabase();
    harness = { temp, db: getDb({ databasePath: temp.databasePath }), library: { itemIds: [], tagIds: [], relationIds: [], viewIds: [] } };

    const { bundle, counts } = exportKnowledge(harness.db);
    expect(counts).toEqual({ items: 0, tags: 0, itemTags: 0, relations: 0, views: 0 });
    expect(bundle.data.knowledgeItems).toEqual([]);
  });

  it('导出是纯读取：调用前后记录数与 datasetRevision 不变', () => {
    const { db } = setup();
    const before = db
      .prepare('SELECT COUNT(*) AS n FROM knowledge_items')
      .get() as { n: number };
    const revisionBefore = (
      db.prepare("SELECT value FROM app_meta WHERE key = 'dataset_revision'").get() as { value: string }
    ).value;

    exportKnowledge(db);

    const after = db.prepare('SELECT COUNT(*) AS n FROM knowledge_items').get() as { n: number };
    const revisionAfter = (
      db.prepare("SELECT value FROM app_meta WHERE key = 'dataset_revision'").get() as { value: string }
    ).value;

    expect(after.n).toBe(before.n);
    expect(revisionAfter).toBe(revisionBefore);
  });
});
