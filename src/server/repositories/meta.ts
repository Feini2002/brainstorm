/**
 * app_meta key/value access.
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

export function readMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function deleteMeta(db: DatabaseSync, key: string): void {
  db.prepare('DELETE FROM app_meta WHERE key = ?').run(key);
}
