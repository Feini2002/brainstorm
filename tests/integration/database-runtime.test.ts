import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { closeDb, getDb } from '@/server/db/database';
import { readUserVersion } from '@/server/db/migrations';
import { createTestDatabase, type TestDatabase } from '../helpers/db';

/**
 * T008 / T009 — data directory, connection lifecycle and initial migration.
 */
describe('数据库运行时', () => {
  let harness: TestDatabase | null = null;

  afterEach(() => {
    harness?.cleanup();
    harness = null;
    closeDb();
  });

  it('首次访问时创建数据库与九张表（T008-R02, T009-R01）', () => {
    harness = createTestDatabase();
    expect(existsSync(harness.databasePath)).toBe(false);

    const db = getDb({ databasePath: harness.databasePath });

    expect(existsSync(harness.databasePath)).toBe(true);
    expect(readUserVersion(db)).toBe(2);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((row) => row.name).filter((name) => !name.startsWith('sqlite_'));

    for (const table of [
      'ai_runs',
      'app_meta',
      'item_tags',
      'knowledge_items',
      'relations',
      'secrets',
      'settings',
      'tags',
      'views',
    ]) {
      expect(names).toContain(table);
    }
    expect(names.filter((name) => !name.includes('_fts')).length).toBe(9);
  });

  it('启用外键、WAL 并真实生效（T008-R03）', () => {
    harness = createTestDatabase();
    const db = getDb({ databasePath: harness.databasePath });

    const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);

    const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(journal.journal_mode.toLowerCase()).toBe('wal');

    const busy = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    expect(busy.timeout).toBeGreaterThan(0);
  });

  it('同一路径复用同一连接，重开仍能读到数据（T008-R04）', () => {
    harness = createTestDatabase();
    const first = getDb({ databasePath: harness.databasePath });
    const second = getDb({ databasePath: harness.databasePath });
    expect(second).toBe(first);

    first
      .prepare(
        "INSERT INTO knowledge_items (id, capture_request_id, capture_request_hash, captured_text, raw_text, raw_version, revision, title, summary, type, keywords_json, importance, manual_fields_json, status, source_type, created_at, updated_at) VALUES ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','h','原文','原文',1,1,'','','idea','[]',3,'[]','raw','other','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
      )
      .run();

    closeDb(harness.databasePath);
    const reopened = getDb({ databasePath: harness.databasePath });
    const row = reopened
      .prepare('SELECT raw_text FROM knowledge_items WHERE id = ?')
      .get('11111111-1111-4111-8111-111111111111') as { raw_text: string };
    expect(row.raw_text).toBe('原文');
  });

  it('外键约束拒绝悬空引用（T008/T009 负向）', () => {
    harness = createTestDatabase();
    const db = getDb({ databasePath: harness.databasePath });

    expect(() =>
      db
        .prepare(
          "INSERT INTO item_tags (item_id, tag_id, position) VALUES ('99999999-9999-4999-8999-999999999999','88888888-8888-4888-8888-888888888888',0)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/iu);
  });

  it('CHECK 约束拒绝非法枚举（T009-R04）', () => {
    harness = createTestDatabase();
    const db = getDb({ databasePath: harness.databasePath });

    expect(() =>
      db
        .prepare(
          "INSERT INTO knowledge_items (id, capture_request_id, capture_request_hash, captured_text, raw_text, raw_version, revision, title, summary, type, keywords_json, importance, manual_fields_json, status, source_type, created_at, updated_at) VALUES ('33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','h','x','x',1,1,'','','not_a_type','[]',3,'[]','raw','other','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
        )
        .run(),
    ).toThrow(/CHECK/iu);
  });

  it('数据库版本高于程序已知版本时拒绝继续（T009-R02）', () => {
    const current = createTestDatabase();
    harness = current;
    const db = getDb({ databasePath: current.databasePath });
    db.exec('PRAGMA user_version = 99');
    closeDb(current.databasePath);

    expect(() => getDb({ databasePath: current.databasePath })).toThrow(/版本/iu);
  });

  it('data 目录为仓库内临时路径，不触碰真实 .data（T011-R01）', () => {
    const current = createTestDatabase();
    harness = current;
    const userDataDir = path.resolve(process.cwd(), '.data');
    expect(path.resolve(current.dataDir).startsWith(path.resolve(userDataDir))).toBe(false);
  });
});
