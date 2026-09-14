/**
 * Settings and secret storage.
 *
 * The API key lives only in the `secrets` table under `llm.api_key`; the
 * ordinary settings row never contains it. Saving config and key happen in one
 * transaction and bump one shared settings revision, so a run's credential
 * snapshot can never mistake a changed key for an unchanged one.
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import { DEFAULT_LLM_CONFIG, type LlmConfig } from '@/domain/knowledge';

export const API_KEY_SECRET_NAME = 'llm.api_key';

export interface StoredSettings {
  revision: number;
  config: LlmConfig;
}

/** Read config + revision. A missing row is the documented "unconfigured" state. */
export function readSettings(db: DatabaseSync): StoredSettings {
  const row = db
    .prepare('SELECT config_json, revision FROM settings WHERE id = 1')
    .get() as { config_json: string; revision: number } | undefined;
  if (!row) {
    return { revision: 0, config: { ...DEFAULT_LLM_CONFIG } };
  }
  let parsed: Partial<LlmConfig>;
  try {
    parsed = JSON.parse(row.config_json) as Partial<LlmConfig>;
  } catch {
    throw new AppError('INTERNAL', '设置内容已损坏，请重新填写模型配置');
  }
  return {
    revision: Number(row.revision),
    config: { ...DEFAULT_LLM_CONFIG, ...parsed },
  };
}

/** Read the API key. Server-side only; never returned to the browser. */
export function readApiKey(db: DatabaseSync): string | null {
  const row = db
    .prepare('SELECT value FROM secrets WHERE key = ?')
    .get(API_KEY_SECRET_NAME) as { value: string } | undefined;
  return row?.value ?? null;
}

export function isApiKeyConfigured(db: DatabaseSync): boolean {
  return readApiKey(db) !== null;
}

export interface WriteSettingsInput {
  config: LlmConfig;
  keyAction: 'keep' | 'replace' | 'delete';
  apiKey?: string;
  expectedRevision: number;
  now: string;
}

export class SettingsRevisionConflict extends AppError {
  constructor() {
    super('REVISION_CONFLICT', '设置已被其他窗口修改，请重新读取');
    this.name = 'SettingsRevisionConflict';
  }
}

/**
 * Persist config and key atomically.
 *
 * `expectedRevision = 0` means "first configuration" and inserts revision 1;
 * afterwards the update is a CAS on the settings revision.
 */
export function writeSettings(db: DatabaseSync, input: WriteSettingsInput): StoredSettings {
  const current = readSettings(db);

  if (current.revision !== input.expectedRevision) {
    throw new SettingsRevisionConflict();
  }

  const nextRevision = current.revision + 1;

  if (current.revision === 0) {
    db.prepare(
      'INSERT INTO settings (id, config_json, revision, updated_at) VALUES (1, ?, ?, ?)',
    ).run(JSON.stringify(input.config), nextRevision, input.now);
  } else {
    const result = db
      .prepare(
        'UPDATE settings SET config_json = ?, revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ?',
      )
      .run(JSON.stringify(input.config), input.now, input.expectedRevision);
    if (Number(result.changes) === 0) throw new SettingsRevisionConflict();
  }

  if (input.keyAction === 'replace') {
    if (input.apiKey === undefined || input.apiKey.length === 0) {
      throw new AppError('VALIDATION', '替换 API Key 时必须提供新值', {
        apiKey: ['缺少新的 API Key'],
      });
    }
    db.prepare(
      `INSERT INTO secrets (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(API_KEY_SECRET_NAME, input.apiKey, input.now);
  } else if (input.keyAction === 'delete') {
    db.prepare('DELETE FROM secrets WHERE key = ?').run(API_KEY_SECRET_NAME);
  }

  return readSettings(db);
}

/** Public projection: configuration plus a boolean, never the key itself. */
export function publicSettings(db: DatabaseSync): {
  revision: number;
  config: LlmConfig;
  apiKeyConfigured: boolean;
} {
  const settings = readSettings(db);
  return {
    revision: settings.revision,
    config: settings.config,
    apiKeyConfigured: isApiKeyConfigured(db),
  };
}

export function readSettingsRevision(db: DatabaseSync): number {
  return readSettings(db).revision;
}
