/**
 * Forward migration from a v1 database, plus V1 backup round-trip.
 *
 * The fixture is a temporary file. It never opens the user's `.data`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

import { BACKUP_SCHEMA_VERSION, bundleHash } from '@/domain/exportBundle';
import { closeDb, configureConnection, getDb } from '@/server/db/database';
import { LATEST_KNOWN_VERSION, readUserVersion } from '@/server/db/migrations';
import { exportKnowledge } from '@/server/services/exportKnowledge';
import { importKnowledge } from '@/server/services/importKnowledge';
import { createTestDatabase, type TestDatabase } from '../helpers/db';

const NOW = '2026-01-01T00:00:00.000Z';
const CAPTURE_HASH = 'a'.repeat(64);
const ITEM_A = '11111111-1111-4111-8111-111111111111';
const ITEM_B = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const REL_ID = '44444444-4444-4444-8444-444444444444';
const VIEW_ID = '55555555-5555-4555-8555-555555555555';

let harness: TestDatabase | null = null;

afterEach(() => {
  harness?.cleanup();
  harness = null;
  closeDb();
});

describe('旧 schema 升级与 V1 备份', () => {
  it('v1 库升级后保留原文、人工字段、拒绝关系和历史视图', () => {
    harness = createTestDatabase();
    const initial = new DatabaseSync(harness.databasePath);
    configureConnection(initial);
    initial.exec(
      readFileSync(path.join(process.cwd(), 'src/server/db/migrations/001_initial.sql'), 'utf8'),
    );
    initial.exec('PRAGMA user_version = 1');

    const insertItem = initial.prepare(
      `INSERT INTO knowledge_items (
         id, capture_request_id, capture_request_hash, captured_text, raw_text,
         raw_version, revision, title, summary, type, keywords_json, importance,
         manual_fields_json, status, source_type, created_at, updated_at
       ) VALUES (?, ?, 'h', ?, ?, 1, 1, ?, '', 'idea', '[]', 3, ?, 'raw', 'other', ?, ?)`,
    );
    insertItem.run(ITEM_A, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '原因笔记', '原因笔记', '原因', '["title"]', NOW, NOW);
    insertItem.run(ITEM_B, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '结果笔记', '结果笔记', '结果', '[]', NOW, NOW);

    initial
      .prepare(
        `INSERT INTO ai_runs (
           id, request_key, request_hash, kind, subject_id, input_revision, input_hash,
           state, config_revision, config_snapshot_json, candidate_ids_json, prompt_version,
           attempt_count, started_at, deadline_at, finished_at
         ) VALUES (?, ?, 'hash', 'organize', ?, 1, 'input', 'succeeded', 1, '{}', '[]', 'organize-v1',
           1, ?, ?, ?)`,
      )
      .run(RUN_ID, '66666666-6666-4666-8666-666666666666', ITEM_A, NOW, NOW, NOW);

    initial
      .prepare(
        `INSERT INTO relations (
           id, source_id, target_id, relation_type, origin, review_status, score, reason,
           evidence_json, source_raw_version, target_raw_version, revision, created_at, updated_at
         ) VALUES (?, ?, ?, 'causes', 'ai', 'rejected', 0.2, '不要这条', '[]', 1, 1, 1, ?, ?)`,
      )
      .run(REL_ID, ITEM_A, ITEM_B, NOW, NOW);

    initial
      .prepare(
        `INSERT INTO views (
           id, name, kind, selection_json, source_snapshot_json, content_json,
           renderer_version, revision, created_at, updated_at
         ) VALUES (?, '旧脑图', 'mindmap', '{"mode":"explicit","itemIds":[]}', '{}', '{}',
           'markmap-v1', 1, ?, ?)`,
      )
      .run(VIEW_ID, NOW, NOW);
    initial.close();

    const db = getDb({ databasePath: harness.databasePath });
    expect(readUserVersion(db)).toBe(LATEST_KNOWN_VERSION);

    const item = db
      .prepare('SELECT raw_text, manual_fields_json FROM knowledge_items WHERE id = ?')
      .get(ITEM_A) as { raw_text: string; manual_fields_json: string };
    expect(item.raw_text).toBe('原因笔记');
    expect(item.manual_fields_json).toContain('title');

    const relation = db
      .prepare('SELECT review_status FROM relations WHERE id = ?')
      .get(REL_ID) as { review_status: string };
    expect(relation.review_status).toBe('rejected');

    const view = db.prepare('SELECT name FROM views WHERE id = ?').get(VIEW_ID) as { name: string };
    expect(view.name).toBe('旧脑图');

    const columns = db.prepare('PRAGMA table_info(ai_runs)').all() as { name: string }[];
    expect(columns.map((column) => column.name)).toContain('request_intent_hash');

    const run = db
      .prepare('SELECT request_intent_hash FROM ai_runs WHERE id = ?')
      .get(RUN_ID) as { request_intent_hash: string | null };
    expect(run.request_intent_hash).toBeNull();
  });

  it('升级后的库仍按 V1 备份导出，恢复不含 Key', () => {
    harness = createTestDatabase();
    const db = getDb({ databasePath: harness.databasePath });
    db.prepare(
      `INSERT INTO knowledge_items (
         id, capture_request_id, capture_request_hash, captured_text, raw_text,
         raw_version, revision, title, summary, type, keywords_json, importance,
         manual_fields_json, status, source_type, created_at, updated_at
       ) VALUES (?, ?, ?, '原文', '原文', 1, 1, '一条笔记', '', 'idea', '[]', 3, '[]', 'raw', 'other', ?, ?)`,
    ).run(ITEM_A, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', CAPTURE_HASH, NOW, NOW);
    db.prepare(
      `INSERT INTO secrets (key, value, updated_at) VALUES ('llm.api_key', 'must-not-export', ?)`,
    ).run(NOW);

    const { bundle } = exportKnowledge(db, new Date(NOW));
    expect(bundle.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(BACKUP_SCHEMA_VERSION).toBe(1);
    expect(JSON.stringify(bundle)).not.toContain('must-not-export');

    const target = createTestDatabase();
    try {
      const targetDb = getDb({ databasePath: target.databasePath });
      const restored = importKnowledge(targetDb, {
        bundle,
        expectedBundleHash: bundleHash(bundle),
      });
      expect(restored.imported.items).toBe(1);
      const secret = targetDb.prepare('SELECT COUNT(*) AS n FROM secrets').get() as { n: number };
      expect(secret.n).toBe(0);
    } finally {
      target.cleanup();
    }
  });
});
