/**
 * Secret repository (T029).
 *
 * The API key is the only secret in the MVP, and the point of a dedicated
 * repository is that it exposes no generic read surface:
 *
 *   - There is deliberately **no** `listSecrets` / `dumpSecrets` / `allSecrets`.
 *     T029-R06 requires exports and diagnostics to work from an explicit field
 *     allow-list, and a general dump method is exactly what would let a future
 *     caller leak the key without anyone noticing. Anything that needs a secret
 *     must name it.
 *   - Reads are single-key and server-side only. `readSecret` never leaves the
 *     process: the HTTP layer returns `apiKeyConfigured`, never a value, a
 *     prefix, a length or a hash (T029-R01).
 *   - Writes take an existing transaction from the caller. Saving a key and
 *     saving config share one revision and one commit, so a failure half way
 *     cannot leave a new base URL pointed at an old credential (T029-R02).
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

/** The one secret the MVP stores. Namespaced so later secrets cannot collide. */
export const SECRET_NAMES = {
  llmApiKey: 'llm.api_key',
} as const;

export type SecretName = (typeof SECRET_NAMES)[keyof typeof SECRET_NAMES];

/** Read one secret by name. Returns null when absent; never called a "getAll". */
export function readSecret(db: DatabaseSync, name: SecretName): string | null {
  const row = db.prepare('SELECT value FROM secrets WHERE key = ?').get(name) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/** Existence check. This is what the public settings projection reports. */
export function hasSecret(db: DatabaseSync, name: SecretName): boolean {
  const row = db.prepare('SELECT 1 AS present FROM secrets WHERE key = ?').get(name) as
    | { present: number }
    | undefined;
  return row !== undefined;
}

/**
 * Insert or replace one secret. Must run inside the caller's transaction so it
 * commits with the settings revision that describes it.
 */
export function writeSecret(
  db: DatabaseSync,
  name: SecretName,
  value: string,
  now: string,
): void {
  db.prepare(
    `INSERT INTO secrets (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(name, value, now);
}

/**
 * Delete one secret.
 *
 * Returns whether a row was removed so the caller can tell "deleted" from
 * "there was nothing to delete". Deleting a secret never touches settings or
 * knowledge (T027-C03「必须排除：删除Key不能误删知识库」).
 */
export function deleteSecret(db: DatabaseSync, name: SecretName): boolean {
  const result = db.prepare('DELETE FROM secrets WHERE key = ?').run(name);
  return Number(result.changes) > 0;
}
