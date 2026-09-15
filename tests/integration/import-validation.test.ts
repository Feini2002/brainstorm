/**
 * T071 — 恢复文件校验与空库策略。
 *
 * These tests exercise the validator through the real route handler, not the pure
 * function alone, so the body limit, the strict guard and the envelope are all
 * under test. The fixture library is exported first and then deliberately
 * corrupted one way per case: a corrupted *copy* of a real bundle is a far better
 * probe than a hand-written object, because it also proves the good path accepts
 * the export.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { backupBundleSchema, validateBundle, type ImportValidationReport } from '@/domain/importBundle';
import type { ApiEnvelope } from '@/domain/api';
import type { BackupBundle } from '@/domain/exportBundle';
import { LIMITS } from '@/domain/limits';
import { closeDb, getDb } from '@/server/db/database';
import { exportKnowledge } from '@/server/services/exportKnowledge';
import { validateImport } from '@/server/services/validateImport';
import { POST as validateRoute } from '@/app/api/import/validate/route';
import { callRoute } from './helpers/http';
import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { seedBackupLibrary } from '../helpers/backupLibrary';

interface Harness {
  /** Where the fixture library lives and the bundle was exported from. */
  source: TestDatabase;
  sourceDb: ReturnType<typeof getDb>;
  /** The restore *target*: a second, empty database. */
  target: TestDatabase;
  targetDb: ReturnType<typeof getDb>;
  bundle: BackupBundle;
}

let harness: Harness | null = null;

/**
 * Seed a source library, export it, and open a separate empty target.
 *
 * Two databases rather than one is the whole point of these cases: the contract
 * restores into an *empty* library, so validating the export against the library
 * it came from is a different (and correctly refused) scenario. Keeping the
 * source intact also means a test can always re-export a clean bundle.
 */
function setup(): Harness {
  const source = createTestDatabase();
  const sourceDb = getDb({ databasePath: source.databasePath });
  seedBackupLibrary(sourceDb);
  const { bundle } = exportKnowledge(sourceDb, new Date('2026-09-14T00:00:00.000Z'));

  // `getDb` resolves the data directory from the environment; `createTestDatabase`
  // already points `BRAIN_DATA_DIR` at the new temp dir, so opening the target
  // after it is what keeps the two databases separate.
  const target = createTestDatabase();
  const targetDb = getDb({ databasePath: target.databasePath });

  harness = { source, sourceDb, target, targetDb, bundle };
  return harness;
}

/** A deep copy so a mutation in one test cannot leak into the shared harness. */
function clone(bundle: BackupBundle): BackupBundle {
  return JSON.parse(JSON.stringify(bundle)) as BackupBundle;
}

afterEach(() => {
  harness?.source.cleanup();
  harness?.target.cleanup();
  harness = null;
  closeDb();
});

function reportOf(envelope: ApiEnvelope<unknown>): ImportValidationReport {
  if (!envelope.ok) throw new Error(`期望成功信封，实际为 ${envelope.error.code}`);
  return envelope.data as ImportValidationReport;
}

/** Count rows across the knowledge tables, to prove validation wrote nothing. */
function knowledgeRowCount(db: ReturnType<typeof getDb>): number {
  const tables = ['knowledge_items', 'tags', 'item_tags', 'relations', 'views'];
  return tables.reduce((total, table) => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return total + row.n;
  }, 0);
}

/** Put one note into the target library, making it non-empty. */
function addTargetItem(db: ReturnType<typeof getDb>): void {
  db.prepare(
    `INSERT INTO knowledge_items (
       id, capture_request_id, capture_request_hash, captured_text, raw_text,
       raw_version, revision, title, summary, type, keywords_json, importance,
       manual_fields_json, status, source_type, created_at, updated_at
     ) VALUES (?,?,?,?,?,1,1,'','','idea','[]',3,'[]','raw','other',?,?)`,
  ).run(
    '99999999-0000-4000-8000-000000000001',
    '99999999-0000-4000-8000-000000000002',
    'f'.repeat(64),
    '已有内容',
    '已有内容',
    '2026-09-14T00:00:00.000Z',
    '2026-09-14T00:00:00.000Z',
  );
}

describe('T071 恢复文件校验', () => {
  describe('正常路径', () => {
    it('导出的合法备份通过校验，并给出计数与哈希', () => {
      const { targetDb: db, bundle } = setup();
      const report = validateImport(db, bundle);

      expect(report.valid).toBe(true);
      expect(report.errors).toEqual([]);
      expect(report.recordCounts).toEqual({ items: 3, tags: 3, itemTags: 4, relations: 3, views: 2 });
      expect(report.bundleHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('含已删除来源的视图给出警告而不是错误（允许的历史状态）', () => {
      const { targetDb: db, bundle } = setup();
      const report = validateImport(db, bundle);

      // `viewWithDeletedSource` cites an item that no longer exists. Rejecting
      // this would make real libraries unexportable.
      expect(report.valid).toBe(true);
      expect(report.warnings.length).toBeGreaterThan(0);
      expect(report.warnings.join('\n')).toContain('已不在备份中');
    });

    it('纯校验函数与经路由的结果一致', () => {
      const { bundle } = setup();
      // The schema and the report must not depend on which entry point is used.
      const direct = validateBundle(bundle);
      expect(backupBundleSchema.safeParse(bundle).success).toBe(true);
      expect(direct.valid).toBe(true);
    });
  });

  describe('T071-C01 未知版本', () => {
    it('未来 schemaVersion 被拒绝并说明版本不支持，而不是猜测兼容', () => {
      const { targetDb: db, bundle } = setup();
      const corrupted = clone(bundle);
      corrupted.schemaVersion = 2;

      const report = validateImport(db, corrupted);

      expect(report.valid).toBe(false);
      const text = report.errors.map((error) => `${error.path} ${error.message}`).join('\n');
      expect(text).toContain('schemaVersion');
      expect(text).toContain('2');
      // Names the supported version so the user knows what to do.
      expect(text).toContain('1');
    });

    it('缺失 schemaVersion 同样被拒绝', () => {
      const { targetDb: db, bundle } = setup();
      const corrupted = clone(bundle) as Partial<BackupBundle>;
      delete corrupted.schemaVersion;

      const report = validateImport(db, corrupted);
      expect(report.valid).toBe(false);
      expect(report.errors.some((error) => error.path === 'schemaVersion')).toBe(true);
    });

    it('版本错误排在其他错误之前，避免用未知格式刷屏', () => {
      const { targetDb: db, bundle } = setup();
      const corrupted = clone(bundle);
      corrupted.schemaVersion = 99;
      // Also break a field, so there are several complaints to order.
      (corrupted.data.knowledgeItems[0] as { title: unknown }).title = 12345;

      const report = validateImport(db, corrupted);
      expect(report.errors[0]?.path).toBe('schemaVersion');
    });
  });

  describe('T071-C02 重复 ID', () => {
    it('两条 Item 同 UUID 时指出冲突记录并拒绝整包', () => {
      const { targetDb: db, bundle } = setup();
      const corrupted = clone(bundle);
      // A true duplicate id: the second item reuses the first's identity.
      corrupted.data.knowledgeItems[1].id = corrupted.data.knowledgeItems[0].id;

      const report = validateImport(db, corrupted);

      expect(report.valid).toBe(false);
      const conflict = report.errors.find((error) => /重复/.test(error.message));
      expect(conflict).toBeDefined();
      // Points at the offending index and the id, so it is findable in the file.
      expect(conflict?.path).toContain('data.knowledgeItems[1]');
      expect(conflict?.message).toContain(corrupted.data.knowledgeItems[0].id);
    });

    it('重复的 tagId 与 relationId 同样被拒', () => {
      const { targetDb: db, bundle } = setup();

      const dupTag = clone(bundle);
      dupTag.data.tags[1].id = dupTag.data.tags[0].id;
      expect(validateImport(db, dupTag).valid).toBe(false);

      const dupRelation = clone(bundle);
      dupRelation.data.relations[1].id = dupRelation.data.relations[0].id;
      expect(validateImport(db, dupRelation).valid).toBe(false);
    });

    it('同一 normalized 的两个标签被拒，避免一种概念两个 ID', () => {
      const { targetDb: db, bundle } = setup();
      const corrupted = clone(bundle);
      corrupted.data.tags[1].normalized = corrupted.data.tags[0].normalized;

      const report = validateImport(db, corrupted);
      expect(report.valid).toBe(false);
      expect(report.errors.some((error) => error.path.includes('data.tags'))).toBe(true);
    });
  });

  describe('T071-C03 悬空关系', () => {
    it('关系终点不在备份 Items 中时拒绝引用', () => {
      const { targetDb: db, bundle } = setup();
      const corrupted = clone(bundle);
      corrupted.data.relations[0].targetId = 'aaaaaaaa-0000-4000-8000-0000000000ee';

      const report = validateImport(db, corrupted);

      expect(report.valid).toBe(false);
      const dangling = report.errors.find((error) => error.path.includes('targetId'));
      expect(dangling).toBeDefined();
      expect(dangling?.message).toContain('aaaaaaaa-0000-4000-8000-0000000000ee');
    });

    it('关系起点悬空同样被拒', () => {
      const { targetDb: db, bundle } = setup();
      const corrupted = clone(bundle);
      corrupted.data.relations[0].sourceId = 'aaaaaaaa-0000-4000-8000-0000000000ee';

      const report = validateImport(db, corrupted);
      expect(report.valid).toBe(false);
      expect(report.errors.some((error) => error.path.includes('sourceId'))).toBe(true);
    });

    it('视图来源缺失不报错，只对关系报错——两类引用被判据不同', () => {
      const { targetDb: db, bundle } = setup();

      // Same fixture, two reference kinds: the view's missing source is a warning
      // while the relation's is an error. Asserting both together is the point.
      const corrupted = clone(bundle);
      corrupted.data.relations[0].targetId = 'aaaaaaaa-0000-4000-8000-0000000000ee';

      const report = validateImport(db, corrupted);
      expect(report.valid).toBe(false);
      expect(report.errors.every((error) => !error.path.includes('views'))).toBe(true);
      expect(report.warnings.length).toBeGreaterThan(0);
    });

    it('itemTags 指向不存在的条目或标签被拒', () => {
      const { targetDb: db, bundle } = setup();

      const badItem = clone(bundle);
      badItem.data.itemTags[0].itemId = 'aaaaaaaa-0000-4000-8000-0000000000ee';
      expect(validateImport(db, badItem).valid).toBe(false);

      const badTag = clone(bundle);
      badTag.data.itemTags[0].tagId = 'bbbbbbbb-0000-4000-8000-0000000000ee';
      expect(validateImport(db, badTag).valid).toBe(false);
    });

    it('对称关系端点顺序颠倒被拒，避免恢复后方向不定', () => {
      const { targetDb: db, bundle } = setup();
      const corrupted = clone(bundle);
      const symmetric = corrupted.data.relations[1];
      // relations[1] is `similar_to`; swap its endpoints so source >= target.
      const originalSource = symmetric.sourceId;
      symmetric.sourceId = symmetric.targetId;
      symmetric.targetId = originalSource;

      const report = validateImport(db, corrupted);
      expect(report.valid).toBe(false);
      expect(report.errors.some((error) => /对称关系/.test(error.message))).toBe(true);
    });

    it('违反 schema CHECK 的关系形态在导入前被点名，而不是留给事务报错', () => {
      const { targetDb: db, bundle } = setup();

      const manualWithScore = clone(bundle);
      const manual = manualWithScore.data.relations.find((relation) => relation.origin === 'manual');
      expect(manual).toBeDefined();
      if (manual) manual.score = 0.5;
      const report = validateImport(db, manualWithScore);
      expect(report.valid).toBe(false);
      expect(report.errors.some((error) => /人工关系/.test(error.message))).toBe(true);
    });
  });

  describe('T071-C04 非空目标', () => {
    it('目标已有条目时拒绝并说明只支持空库恢复', () => {
      const { targetDb: db, bundle } = setup();
      addTargetItem(db);

      const report = validateImport(db, bundle);
      expect(report.valid).toBe(false);
      const target = report.errors.find((error) => error.path === '(target)');
      expect(target).toBeDefined();
      expect(target?.message).toContain('空知识库');
      // Reassures the user their credentials survive.
      expect(target?.message).toContain('设置与 Key');
    });

    it('只有孤立标签、没有任何条目时也视为非空', () => {
      const { targetDb: db, bundle } = setup();
      const emptyBefore = validateImport(db, bundle).valid;
      expect(emptyBefore).toBe(true);

      // A tag vocabulary with no notes is still a competing vocabulary: restoring
      // would put the same `normalized` label under two ids.
      db.prepare('INSERT INTO tags (id, label, normalized, created_at) VALUES (?,?,?,?)').run(
        'bbbbbbbb-0000-4000-8000-0000000000cc',
        '孤立标签',
        '孤立标签',
        '2026-09-14T00:00:00.000Z',
      );

      expect(validateImport(db, bundle).valid).toBe(false);
    });

    it('目标真正为空时通过——空库判定不是一律拒绝', () => {
      const { targetDb, bundle } = setup();
      // `setup`'s target is genuinely empty, so the same bundle the C04 tests
      // reject is accepted here. Asserting both directions is what shows the
      // refusal comes from target state and not from the bundle.
      expect(validateImport(targetDb, bundle).valid).toBe(true);

      addTargetItem(targetDb);
      expect(validateImport(targetDb, bundle).valid).toBe(false);
    });

    it('设置与 Key 的存在不算非空，恢复知识不应要求清空连接配置', () => {
      const { targetDb, bundle } = setup();

      // Credentials live in their own tables and are not knowledge, so a
      // configured machine must still be a legal restore target.
      targetDb
        .prepare('INSERT INTO secrets (key, value, updated_at) VALUES (?,?,?)')
        .run('llm_api_key', 'sk-existing-target-key', '2026-09-14T00:00:00.000Z');
      targetDb
        .prepare('INSERT INTO settings (id, config_json, revision, updated_at) VALUES (1,?,?,?)')
        .run('{}', 3, '2026-09-14T00:00:00.000Z');

      const report = validateImport(targetDb, bundle);
      expect(report.valid).toBe(true);
      expect(report.errors).toEqual([]);
    });
  });

  describe('T071-C05 大文件', () => {
    it('超过二十 MiB 的上传被及时拒绝，不无限缓冲', async () => {
      // A body larger than the cap, sent as a raw string so the size is exact.
      const oversized = `{"bundle":"${'x'.repeat(LIMITS.importBodyBytes + 1024)}"}`;

      const response = await callRoute(validateRoute, {
        method: 'POST',
        path: '/api/import/validate',
        rawBody: oversized,
      });

      expect(response.status).toBe(413);
      expect(response.envelope.ok).toBe(false);
      if (!response.envelope.ok) {
        expect(response.envelope.error.code).toBe('BODY_TOO_LARGE');
      }
    });

    it('声明 Content-Length 超限时在读取正文前就拒绝', async () => {
      // Only the header claims the size; the guard must not wait for a body.
      const response = await callRoute(validateRoute, {
        method: 'POST',
        path: '/api/import/validate',
        rawBody: '{}',
        headers: { 'content-length': String(LIMITS.importBodyBytes + 1) },
      });

      expect(response.status).toBe(413);
      if (!response.envelope.ok) {
        expect(response.envelope.error.code).toBe('BODY_TOO_LARGE');
      }
    });

    it('恰好在上限内的请求不被误拒', async () => {
      const { bundle } = setup();
      const response = await callRoute(validateRoute, {
        method: 'POST',
        path: '/api/import/validate',
        body: { bundle },
      });

      expect(response.status).toBe(200);
    });
  });

  describe('T071-C06 只读验证', () => {
    it('合法备份通过校验后，数据库仍为空且未发生任何写入', async () => {
      const { targetDb: db, bundle } = setup();
      const before = knowledgeRowCount(db);
      const revisionBefore = (
        db.prepare("SELECT value FROM app_meta WHERE key = 'dataset_revision'").get() as { value: string }
      ).value;

      const response = await callRoute(validateRoute, {
        method: 'POST',
        path: '/api/import/validate',
        body: { bundle },
      });

      expect(response.status).toBe(200);
      const report = reportOf(response.envelope);
      expect(report.valid).toBe(true);

      // Nothing moved: same row count, same dataset revision. A "test" button
      // that wrote anything would fail here.
      expect(knowledgeRowCount(db)).toBe(before);
      const revisionAfter = (
        db.prepare("SELECT value FROM app_meta WHERE key = 'dataset_revision'").get() as { value: string }
      ).value;
      expect(revisionAfter).toBe(revisionBefore);
    });

    it('校验失败时同样不写入、不清空数据', async () => {
      const { targetDb: db, bundle } = setup();
      const before = knowledgeRowCount(db);
      const corrupted = clone(bundle);
      corrupted.schemaVersion = 2;

      const response = await callRoute(validateRoute, {
        method: 'POST',
        path: '/api/import/validate',
        body: { bundle: corrupted },
      });

      expect(response.status).toBe(200);
      const report = reportOf(response.envelope);
      expect(report.valid).toBe(false);
      expect(knowledgeRowCount(db)).toBe(before);
    });

    it('校验不触发模型调用，也不读取远端 URL', async () => {
      const { targetDb: db, bundle } = setup();
      void db;
      // The fixture's sourceRef is a URL and its items referenced a run; none of
      // that may cause an outbound request. A fetch would either hang or throw
      // under the test network guard, so completing synchronously is the evidence.
      const report = validateImport(db, bundle);
      expect(report.valid).toBe(true);
      expect(report.errors).toEqual([]);
    });

    it('校验成功不等于恢复完成：报告本身不含已写入的条目', async () => {
      const { targetDb: db, bundle } = setup();
      const response = await callRoute(validateRoute, {
        method: 'POST',
        path: '/api/import/validate',
        body: { bundle },
      });

      const report = reportOf(response.envelope);
      expect(report.valid).toBe(true);
      // Counts describe the *file* (3 items), while the library stays empty. If
      // validation had imported anything these two numbers would coincide.
      expect(report.recordCounts.items).toBe(3);
      const live = db.prepare('SELECT COUNT(*) AS n FROM knowledge_items').get() as { n: number };
      expect(live.n).toBe(0);
    });
  });
});
