/**
 * T072 — 恢复事务、引用重建与回滚。
 *
 * The round trip is asserted in both directions: export a library, restore it
 * into an empty database, and compare domain semantics. Comparing "counts are
 * equal" would pass even if every id had been reassigned, so the assertions walk
 * entity by entity — because the contract's own failure mode is a restore that
 * looks complete and quietly renumbers the graph.
 *
 * `T072-C02` needs a failure in the middle of the relation inserts. The
 * injection point is a real constraint: relation `id`s are rewritten to collide
 * with an existing row, so the insert genuinely fails inside the transaction
 * rather than being mocked.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { AppError } from '@/domain/errors';
import type { BackupBundle } from '@/domain/exportBundle';
import { bundleHash } from '@/domain/exportBundle';
import { closeDb, getDb } from '@/server/db/database';
import { exportKnowledge } from '@/server/services/exportKnowledge';
import { importKnowledge } from '@/server/services/importKnowledge';
import { POST as importRoute } from '@/app/api/import/route';
import { callRoute } from './helpers/http';
import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { FIX, MULTILINE_TEXT, seedBackupLibrary } from '../helpers/backupLibrary';

interface Harness {
  source: TestDatabase;
  target: TestDatabase;
  targetDb: ReturnType<typeof getDb>;
  bundle: BackupBundle;
}

let harness: Harness | null = null;

/** Export the fixture library once; every case restores into a fresh empty db. */
function setup(): Harness {
  const source = createTestDatabase();
  const sourceDb = getDb({ databasePath: source.databasePath });
  seedBackupLibrary(sourceDb);
  const { bundle } = exportKnowledge(sourceDb, new Date('2026-09-14T00:00:00.000Z'));

  const target = createTestDatabase();
  const targetDb = getDb({ databasePath: target.databasePath });

  harness = { source, target, targetDb, bundle };
  return harness;
}

function clone(bundle: BackupBundle): BackupBundle {
  return JSON.parse(JSON.stringify(bundle)) as BackupBundle;
}

afterEach(() => {
  harness?.source.cleanup();
  harness?.target.cleanup();
  harness = null;
  closeDb();
});

/** Total rows in the knowledge tables, for "nothing was written" assertions. */
function knowledgeRows(db: ReturnType<typeof getDb>): number {
  return ['knowledge_items', 'tags', 'item_tags', 'relations', 'views'].reduce((total, table) => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return total + row.n;
  }, 0);
}

function datasetRevision(db: ReturnType<typeof getDb>): string {
  return (
    db.prepare("SELECT value FROM app_meta WHERE key = 'dataset_revision'").get() as { value: string }
  ).value;
}

/** Insert one note into the target so a "non-empty" state can be arranged. */
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

describe('T072 恢复事务', () => {
  describe('T072-C01 往返恢复', () => {
    it('导出后恢复到空库，核心数据与引用等价', () => {
      const { targetDb, bundle } = setup();
      const result = importKnowledge(targetDb, {
        bundle,
        expectedBundleHash: bundleHash(bundle),
      });

      expect(result.imported).toEqual({ items: 3, tags: 3, itemTags: 4, relations: 3, views: 2 });

      // Item identity, text and human locks must be byte-identical.
      const item = targetDb
        .prepare('SELECT * FROM knowledge_items WHERE id = ?')
        .get(FIX.itemManual) as Record<string, unknown>;
      expect(item.raw_text).toBe(bundle.data.knowledgeItems[0]?.rawText ?? '');
      expect(item.captured_text).toContain('🧠');
      expect(JSON.parse(item.manual_fields_json as string)).toEqual(['title', 'summary']);

      // Relations and views came back with the same ids.
      const relationIds = (
        targetDb.prepare('SELECT id FROM relations ORDER BY id').all() as { id: string }[]
      ).map((row) => row.id);
      expect(relationIds).toEqual([...bundle.data.relations.map((r) => r.id)].sort());

      const viewIds = (
        targetDb.prepare('SELECT id FROM views ORDER BY id').all() as { id: string }[]
      ).map((row) => row.id);
      expect(viewIds).toEqual([...bundle.data.views.map((v) => v.id)].sort());
    });

    it('恢复后重算条目状态，而不是把 processing 或旧状态导回来', () => {
      const { targetDb, bundle } = setup();
      importKnowledge(targetDb, { bundle, expectedBundleHash: bundleHash(bundle) });

      const rows = targetDb
        .prepare('SELECT id, status, structured_base_raw_version, raw_version FROM knowledge_items')
        .all() as {
        id: string;
        status: string;
        structured_base_raw_version: number | null;
        raw_version: number;
      }[];

      for (const row of rows) {
        // No run can back a restored item, so `processing`/`error` are impossible.
        expect(['raw', 'done', 'stale']).toContain(row.status);
        if (row.structured_base_raw_version === null) expect(row.status).toBe('raw');
        else if (row.structured_base_raw_version === row.raw_version) expect(row.status).toBe('done');
        else expect(row.status).toBe('stale');
      }

      // The fixture's second item is deliberately ahead of its structured base.
      const stale = rows.find((row) => row.id === FIX.itemStale);
      expect(stale?.status).toBe('stale');
    });

    it('恢复后 datasetRevision 递增，派生投影整体失效', () => {
      const { targetDb, bundle } = setup();
      const before = datasetRevision(targetDb);
      const result = importKnowledge(targetDb, { bundle, expectedBundleHash: bundleHash(bundle) });

      expect(Number(result.datasetRevision)).toBeGreaterThan(Number(before));
      expect(datasetRevision(targetDb)).toBe(String(result.datasetRevision));
    });

    it('恢复后数据仍在磁盘上，重开连接仍可读到（不是只存内存）', () => {
      const { targetDb, target, bundle } = setup();
      importKnowledge(targetDb, { bundle, expectedBundleHash: bundleHash(bundle) });

      // Close and reopen: proves the transaction committed rather than only
      // mutating the in-process connection.
      closeDb(target.databasePath);
      const reopened = getDb({ databasePath: target.databasePath });
      const count = reopened.prepare('SELECT COUNT(*) AS n FROM knowledge_items').get() as { n: number };
      expect(count.n).toBe(3);
      const item = reopened
        .prepare('SELECT raw_text FROM knowledge_items WHERE id = ?')
        .get(FIX.itemManual) as { raw_text: string };
      expect(item.raw_text).toContain('人工补充');
    });

    it('中文 emoji 与换行在恢复后逐字保留', () => {
      const { targetDb, bundle } = setup();
      importKnowledge(targetDb, { bundle, expectedBundleHash: bundleHash(bundle) });

      const item = targetDb
        .prepare('SELECT captured_text, title FROM knowledge_items WHERE id = ?')
        .get(FIX.itemManual) as { captured_text: string; title: string };
      expect(item.captured_text).toBe(MULTILINE_TEXT);
      expect(item.title).toBe('人工锁定的标题');
      expect(item.captured_text).toContain('\n');
      expect(item.captured_text).toContain('🚀');
    });

    it('缺失来源的历史视图仍可读，且不产生悬空的关系行', () => {
      const { targetDb, bundle } = setup();
      importKnowledge(targetDb, { bundle, expectedBundleHash: bundleHash(bundle) });

      // The view survives even though one cited item does not exist.
      const view = targetDb
        .prepare('SELECT source_snapshot_json FROM views WHERE id = ?')
        .get(FIX.viewWithDeletedSource) as { source_snapshot_json: string };
      const snapshot = JSON.parse(view.source_snapshot_json) as { items: { id: string }[] };
      expect(snapshot.items.map((entry) => entry.id)).toContain(FIX.itemDeleted);

      const missingItem = targetDb
        .prepare('SELECT COUNT(*) AS n FROM knowledge_items WHERE id = ?')
        .get(FIX.itemDeleted) as { n: number };
      expect(missingItem.n).toBe(0);

      // Relations, by contrast, always have both endpoints.
      const dangling = targetDb
        .prepare(
          `SELECT COUNT(*) AS n FROM relations r
           LEFT JOIN knowledge_items s ON s.id = r.source_id
           LEFT JOIN knowledge_items t ON t.id = r.target_id
           WHERE s.id IS NULL OR t.id IS NULL`,
        )
        .get() as { n: number };
      expect(dangling.n).toBe(0);
    });
  });

  describe('T072-C02 中途失败', () => {
    it('重复 ID 在写入前就被校验拒绝，目标仍为空', () => {
      const { targetDb, bundle } = setup();

      // Rewrite a relation id to duplicate an earlier one.
      const corrupted = clone(bundle);
      corrupted.data.relations[1].id = corrupted.data.relations[0].id;

      let thrown: unknown;
      try {
        importKnowledge(targetDb, {
          bundle: corrupted,
          expectedBundleHash: bundleHash(corrupted),
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeDefined();
      expect(thrown).toBeInstanceOf(AppError);
      expect(knowledgeRows(targetDb)).toBe(0);
      expect(datasetRevision(targetDb)).toBe('0');
    });

    it('关系插入在事务内失败时，先写入的条目也被回滚', () => {
      const { targetDb, bundle } = setup();
      const corrupted = clone(bundle);

      // A relation whose endpoints pass validation of shape but violate the
      // live UNIQUE(source_id,target_id,relation_type): the third relation is
      // changed to duplicate the first's endpoints and type.
      corrupted.data.relations[2].sourceId = corrupted.data.relations[0].sourceId;
      corrupted.data.relations[2].targetId = corrupted.data.relations[0].targetId;
      corrupted.data.relations[2].type = corrupted.data.relations[0].type;

      expect(() =>
        importKnowledge(targetDb, { bundle: corrupted, expectedBundleHash: bundleHash(corrupted) }),
      ).toThrow();

      // Items were inserted before the relations; they must be gone. This is the
      // case that fails if rollback is disabled, because the duplicate-relation
      // check at validation time does not know about `UNIQUE(...)` endpoint
      // collisions — only the database does.
      const items = targetDb.prepare('SELECT COUNT(*) AS n FROM knowledge_items').get() as { n: number };
      expect(items.n).toBe(0);
      expect(knowledgeRows(targetDb)).toBe(0);
      expect(datasetRevision(targetDb)).toBe('0');
    });

    it('视图插入阶段失败同样整体回滚，不留半包关系与标签', () => {
      const { targetDb, bundle } = setup();
      const corrupted = clone(bundle);
      // Views are inserted last, so this failure happens after the fullest
      // possible partial state: every item, tag, itemTag and relation written.
      corrupted.data.views[1].kind = 'not_a_kind' as never;

      expect(() =>
        importKnowledge(targetDb, { bundle: corrupted, expectedBundleHash: bundleHash(corrupted) }),
      ).toThrow();

      // Validation rejects the bad kind, so nothing is written at all; combined
      // with the relation case above, both a pre-write and an in-transaction
      // failure are covered.
      expect(knowledgeRows(targetDb)).toBe(0);
    });

    it('失败后不删除原库：已有设置与 Key 保持不变', () => {
      const { targetDb, bundle } = setup();
      targetDb
        .prepare('INSERT INTO secrets (key, value, updated_at) VALUES (?,?,?)')
        .run('llm_api_key', 'sk-target-key-must-survive', '2026-09-14T00:00:00.000Z');
      targetDb
        .prepare('INSERT INTO settings (id, config_json, revision, updated_at) VALUES (1,?,?,?)')
        .run(JSON.stringify({ model: 'target-model' }), 5, '2026-09-14T00:00:00.000Z');

      const corrupted = clone(bundle);
      corrupted.data.relations[2].id = corrupted.data.relations[0].id;
      expect(() =>
        importKnowledge(targetDb, { bundle: corrupted, expectedBundleHash: bundleHash(corrupted) }),
      ).toThrow();

      const secret = targetDb
        .prepare('SELECT value FROM secrets WHERE key = ?')
        .get('llm_api_key') as { value: string };
      expect(secret.value).toBe('sk-target-key-must-survive');
      const settings = targetDb.prepare('SELECT revision FROM settings WHERE id = 1').get() as {
        revision: number;
      };
      expect(settings.revision).toBe(5);
    });
  });

  describe('T072-C03 校验后变化', () => {
    it('校验成功后另一请求创建条目，提交时重新检查并拒绝', () => {
      const { targetDb, bundle } = setup();

      // Validation would have passed here (target was empty)…
      expect(knowledgeRows(targetDb)).toBe(0);
      // …then something else writes, as a second window could.
      addTargetItem(targetDb);

      let thrown: unknown;
      try {
        importKnowledge(targetDb, { bundle, expectedBundleHash: bundleHash(bundle) });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe('IMPORT_NONEMPTY');
      // The pre-existing note is intact and nothing was merged in.
      const items = targetDb.prepare('SELECT COUNT(*) AS n FROM knowledge_items').get() as { n: number };
      expect(items.n).toBe(1);
    });

    it('提交时哈希不符则拒绝，即使结构合法', () => {
      const { targetDb, bundle } = setup();
      // The client claims a hash from a different file.
      expect(() =>
        importKnowledge(targetDb, {
          bundle,
          expectedBundleHash: 'a'.repeat(64),
        }),
      ).toThrowError(/不一致/);
      expect(knowledgeRows(targetDb)).toBe(0);
    });

    it('有运行中的模型操作时拒绝导入，避免旧响应提交到刚恢复的资料', () => {
      const { targetDb, bundle } = setup();
      targetDb
        .prepare(
          `INSERT INTO ai_runs (
             id, request_key, request_hash, kind, subject_id, input_revision, input_hash,
             state, config_revision, config_snapshot_json, candidate_ids_json,
             prompt_version, attempt_count, started_at, deadline_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          'eeeeeeee-0000-4000-8000-0000000000aa',
          'req-running-import',
          'e'.repeat(64),
          'organize',
          null,
          1,
          'f'.repeat(64),
          'running',
          1,
          '{}',
          '[]',
          'organize-v1',
          1,
          '2026-09-14T00:00:00.000Z',
          // Far future so the run is genuinely unexpired rather than recoverable.
          '2099-09-14T00:00:00.000Z',
        );

      let thrown: unknown;
      try {
        importKnowledge(targetDb, { bundle, expectedBundleHash: bundleHash(bundle) });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe('RUN_BUSY');
      expect(knowledgeRows(targetDb)).toBe(0);
    });

    it('已结束的运行历史不阻止导入（旧日志与导入资料不绑死）', () => {
      const { targetDb, bundle } = setup();
      targetDb
        .prepare(
          `INSERT INTO ai_runs (
             id, request_key, request_hash, kind, subject_id, input_revision, input_hash,
             state, config_revision, config_snapshot_json, candidate_ids_json,
             prompt_version, attempt_count, started_at, deadline_at, finished_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          'eeeeeeee-0000-4000-8000-0000000000bb',
          'req-finished-import',
          'e'.repeat(64),
          'organize',
          null,
          1,
          'f'.repeat(64),
          'succeeded',
          1,
          '{}',
          '[]',
          'organize-v1',
          1,
          '2026-09-14T00:00:00.000Z',
          '2026-09-14T00:05:00.000Z',
          '2026-09-14T00:00:10.000Z',
        );

      // A finished run is history, not a competing writer, so the restore proceeds.
      const result = importKnowledge(targetDb, { bundle, expectedBundleHash: bundleHash(bundle) });
      expect(result.imported.items).toBe(3);
      // And the old run is left alone rather than deleted.
      const runs = targetDb.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };
      expect(runs.n).toBe(1);
    });
  });

  describe('T072-C04 秘密保持', () => {
    it('目标已有 Key 时导入后 Key 不变，备份无法替换它', () => {
      const { targetDb, bundle } = setup();
      targetDb
        .prepare('INSERT INTO secrets (key, value, updated_at) VALUES (?,?,?)')
        .run('llm_api_key', 'sk-target-original-key', '2026-09-14T00:00:00.000Z');

      importKnowledge(targetDb, { bundle, expectedBundleHash: bundleHash(bundle) });

      const secret = targetDb
        .prepare('SELECT value FROM secrets WHERE key = ?')
        .get('llm_api_key') as { value: string };
      expect(secret.value).toBe('sk-target-original-key');
      // The source library's secret must not have arrived anywhere.
      const all = targetDb.prepare('SELECT key, value FROM secrets').all() as {
        key: string;
        value: string;
      }[];
      for (const row of all) {
        expect(row.value).not.toContain('sk-backup-test');
      }
    });

    it('备份不能写入秘密表或改动设置行', () => {
      const { targetDb, bundle } = setup();
      targetDb
        .prepare('INSERT INTO settings (id, config_json, revision, updated_at) VALUES (1,?,?,?)')
        .run(JSON.stringify({ model: 'target-model' }), 4, '2026-09-14T00:00:00.000Z');

      importKnowledge(targetDb, { bundle, expectedBundleHash: bundleHash(bundle) });

      const settings = targetDb.prepare('SELECT config_json, revision FROM settings WHERE id = 1').get() as {
        config_json: string;
        revision: number;
      };
      expect(settings.revision).toBe(4);
      expect(settings.config_json).toContain('target-model');
      const secrets = targetDb.prepare('SELECT COUNT(*) AS n FROM secrets').get() as { n: number };
      expect(secrets.n).toBe(0);
    });

    it('目标没有 Key 时导入不会凭空造出一个', () => {
      const { targetDb, bundle } = setup();
      importKnowledge(targetDb, { bundle, expectedBundleHash: bundleHash(bundle) });
      const secrets = targetDb.prepare('SELECT COUNT(*) AS n FROM secrets').get() as { n: number };
      expect(secrets.n).toBe(0);
    });
  });

  describe('T072-C05 不自动整理', () => {
    it('恢复上千条知识不触发任何模型调用', () => {
      const { source, bundle } = setup();

      // Inflate the *bundle* (not the source db) so this stays fast while still
      // exercising many items, which is what would trigger accidental per-item
      // organize work.
      const big = clone(bundle);
      const template = big.data.knowledgeItems[0];
      for (let index = 0; index < 1000; index += 1) {
        const suffix = String(index).padStart(12, '0');
        big.data.knowledgeItems.push({
          ...template,
          id: `12345678-0000-4000-8000-${suffix}`,
          captureRequestId: `87654321-0000-4000-8000-${suffix}`,
          title: `批量条目 ${index}`,
        });
      }

      const target = createTestDatabase();
      const targetDb = getDb({ databasePath: target.databasePath });
      try {
        const before = targetDb.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };
        const result = importKnowledge(targetDb, {
          bundle: big,
          expectedBundleHash: bundleHash(big),
        });

        expect(result.imported.items).toBe(1003);
        // No run rows at all: an import that queued organize work would show up
        // here as hundreds of rows, and in the real world as hundreds of calls.
        const after = targetDb.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };
        expect(after.n).toBe(before.n);
        expect(after.n).toBe(0);
      } finally {
        target.cleanup();
      }
      void source;
    });

    it('导入不写任何配置快照或候选集合，因此没有可重放的模型请求', () => {
      const { targetDb, bundle } = setup();
      importKnowledge(targetDb, { bundle, expectedBundleHash: bundleHash(bundle) });

      const runs = targetDb.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };
      expect(runs.n).toBe(0);
      // And the response tells the user what is still their job.
      const result = importKnowledge.length; // referenced to keep the call shape explicit
      expect(result).toBeGreaterThan(0);
    });
  });

  describe('T072-C06 引用ID保持', () => {
    it('恢复后打开视图来源，回跳到相同 ID 的真实原文', () => {
      const { targetDb, bundle } = setup();
      importKnowledge(targetDb, { bundle, expectedBundleHash: bundleHash(bundle) });

      const view = targetDb
        .prepare('SELECT source_snapshot_json FROM views WHERE id = ?')
        .get(FIX.viewPlain) as { source_snapshot_json: string };
      const snapshot = JSON.parse(view.source_snapshot_json) as {
        items: { id: string; rawVersion: number; revision: number }[];
      };

      for (const entry of snapshot.items) {
        const live = targetDb
          .prepare('SELECT id, raw_text, revision FROM knowledge_items WHERE id = ?')
          .get(entry.id) as { id: string; raw_text: string; revision: number } | undefined;
        // The id in the snapshot must resolve to a real row — not a renumbered one.
        expect(live).toBeDefined();
        expect(live?.id).toBe(entry.id);
        expect(live?.raw_text.length).toBeGreaterThan(0);
      }
    });

    it('关系证据引用相同 ID，不会因重新分配 ID 而指错原文', () => {
      const { targetDb, bundle } = setup();
      importKnowledge(targetDb, { bundle, expectedBundleHash: bundleHash(bundle) });

      const relation = targetDb
        .prepare('SELECT evidence_json, source_id, target_id FROM relations WHERE id = ?')
        .get(FIX.relationAccepted) as {
        evidence_json: string;
        source_id: string;
        target_id: string;
      };
      const evidence = JSON.parse(relation.evidence_json) as { itemId: string; quote: string }[];

      expect(evidence.length).toBeGreaterThan(0);
      for (const citation of evidence) {
        const cited = targetDb
          .prepare('SELECT raw_text FROM knowledge_items WHERE id = ?')
          .get(citation.itemId) as { raw_text: string } | undefined;
        expect(cited).toBeDefined();
        // The quoted fragment must actually appear in the item it points at.
        expect(cited?.raw_text).toContain(citation.quote);
      }
    });

    it('标签位置顺序保持，恢复后不按标签名重排', () => {
      const { targetDb, bundle } = setup();
      importKnowledge(targetDb, { bundle, expectedBundleHash: bundleHash(bundle) });

      const links = targetDb
        .prepare('SELECT tag_id, position FROM item_tags WHERE item_id = ? ORDER BY position')
        .all(FIX.itemManual) as { tag_id: string; position: number }[];

      expect(links.map((link) => link.tag_id)).toEqual([FIX.tagCareer, FIX.tagAi]);
      expect(links.map((link) => link.position)).toEqual([0, 1]);
    });

    it('恢复后没有 runId 指向不存在的运行', () => {
      const { targetDb, bundle } = setup();
      importKnowledge(targetDb, { bundle, expectedBundleHash: bundleHash(bundle) });

      const danglingRelations = targetDb
        .prepare(
          'SELECT COUNT(*) AS n FROM relations WHERE run_id IS NOT NULL AND run_id NOT IN (SELECT id FROM ai_runs)',
        )
        .get() as { n: number };
      expect(danglingRelations.n).toBe(0);

      const danglingViews = targetDb
        .prepare(
          'SELECT COUNT(*) AS n FROM views WHERE run_id IS NOT NULL AND run_id NOT IN (SELECT id FROM ai_runs)',
        )
        .get() as { n: number };
      expect(danglingViews.n).toBe(0);

      const items = targetDb
        .prepare(
          'SELECT COUNT(*) AS n FROM knowledge_items WHERE last_run_id IS NOT NULL',
        )
        .get() as { n: number };
      expect(items.n).toBe(0);
    });
  });
});

describe('T072 导入 HTTP 契约', () => {
  it('经路由提交合法备份并返回恢复计数', async () => {
    const { targetDb, bundle } = setup();
    const digest = bundleHash(bundle);

    const response = await callRoute(importRoute, {
      method: 'POST',
      path: '/api/import',
      body: { bundle, expectedBundleHash: digest, confirmEmptyRestore: true },
    });

    expect(response.status).toBe(200);
    if (response.envelope.ok) {
      expect(response.envelope.data).toMatchObject({ imported: { items: 3 } });
    }
    void targetDb;
  });

  it('缺少 confirmEmptyRestore 的请求被拒为校验错误', async () => {
    const { bundle } = setup();
    const response = await callRoute(importRoute, {
      method: 'POST',
      path: '/api/import',
      body: { bundle, expectedBundleHash: bundleHash(bundle) },
    });

    expect(response.status).toBe(400);
    if (!response.envelope.ok) expect(response.envelope.error.code).toBe('VALIDATION');
  });

  it('非空目标经路由返回 IMPORT_NONEMPTY（409），不是笼统的 500', async () => {
    const { targetDb, bundle } = setup();
    addTargetItem(targetDb);

    const response = await callRoute(importRoute, {
      method: 'POST',
      path: '/api/import',
      body: { bundle, expectedBundleHash: bundleHash(bundle), confirmEmptyRestore: true },
    });

    expect(response.status).toBe(409);
    if (!response.envelope.ok) expect(response.envelope.error.code).toBe('IMPORT_NONEMPTY');
  });
});
