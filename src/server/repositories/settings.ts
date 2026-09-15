/**
 * Settings repository (T029).
 *
 * Two invariants drive the design:
 *
 *  1. **The key never leaves this module as a value.** Every public projection
 *     goes through `publicSettings`, which returns `apiKeyConfigured: boolean`
 *     and nothing else about the secret — no prefix, no length, no fingerprint
 *     (T029-R01). The only reader that returns the value is `readApiKey`, which
 *     the model adapter calls in-process.
 *  2. **Config and key commit together.** `writeSettings` runs inside an explicit
 *     `BEGIN IMMEDIATE` transaction, so a failing secret write rolls back the new
 *     base URL as well. A half-applied update would send the *old* credential to
 *     a *new* destination, which is the specific failure T029-R02 forbids.
 *
 * The transaction is opened here rather than by the HTTP layer because the
 * atomicity is a property of "save settings", not of the route that exposes it.
 */
import 'server-only';

import type { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import { DEFAULT_LLM_CONFIG, type LlmConfig } from '@/domain/knowledge';
import { mapSqliteError } from '@/server/db/database';
import { nowIso } from './shared';
import {
  SECRET_NAMES,
  deleteSecret,
  hasSecret,
  readSecret,
  writeSecret,
} from './secrets';

export const API_KEY_SECRET_NAME = SECRET_NAMES.llmApiKey;

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
  return readSecret(db, SECRET_NAMES.llmApiKey);
}

export function isApiKeyConfigured(db: DatabaseSync): boolean {
  return hasSecret(db, SECRET_NAMES.llmApiKey);
}

export interface WriteSettingsInput {
  config: LlmConfig;
  keyAction: 'keep' | 'replace' | 'delete';
  apiKey?: string;
  expectedRevision: number;
  now?: string;
  /** Test hook: forces the secret write to fail so rollback can be proven. */
  failSecretWrite?: boolean;
}

export class SettingsRevisionConflict extends AppError {
  constructor() {
    super('REVISION_CONFLICT', '设置已被其他窗口修改，请重新读取');
    this.name = 'SettingsRevisionConflict';
  }
}

export class SettingsWriteFailed extends AppError {
  constructor(message = '设置没有保存，原有配置与 Key 都保持不变') {
    super('DATABASE_BUSY', message);
    this.name = 'SettingsWriteFailed';
  }
}

/**
 * Persist config and key atomically.
 *
 * `expectedRevision = 0` means "first configuration" and inserts revision 1;
 * afterwards the update is a CAS on the settings revision.
 */
export function writeSettings(db: DatabaseSync, input: WriteSettingsInput): StoredSettings {
  const timestamp = input.now ?? nowIso();

  db.exec('BEGIN IMMEDIATE');
  try {
    const current = readSettings(db);
    if (current.revision !== input.expectedRevision) {
      throw new SettingsRevisionConflict();
    }

    const nextRevision = current.revision + 1;

    if (current.revision === 0) {
      db.prepare(
        'INSERT INTO settings (id, config_json, revision, updated_at) VALUES (1, ?, ?, ?)',
      ).run(JSON.stringify(input.config), nextRevision, timestamp);
    } else {
      const result = db
        .prepare(
          'UPDATE settings SET config_json = ?, revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ?',
        )
        .run(JSON.stringify(input.config), timestamp, input.expectedRevision);
      if (Number(result.changes) === 0) throw new SettingsRevisionConflict();
    }

    // The key change happens in the same transaction. If it throws, the config
    // write above is rolled back with it, so the stored destination and the
    // stored credential can never disagree (T029-R02).
    if (input.failSecretWrite === true) {
      throw new SettingsWriteFailed('模拟的秘密写入失败');
    }

    if (input.keyAction === 'replace') {
      if (input.apiKey === undefined || input.apiKey.length === 0) {
        throw new AppError('VALIDATION', '替换 API Key 时必须提供新值', {
          apiKey: ['缺少新的 API Key'],
        });
      }
      writeSecret(db, SECRET_NAMES.llmApiKey, input.apiKey, timestamp);
    } else if (input.keyAction === 'delete') {
      // Deleting follows the same transaction: a failed delete must not report a
      // missing secret as removed (T029-C03).
      deleteSecret(db, SECRET_NAMES.llmApiKey);
    }

    const result = readSettings(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the original failure; a rollback error is secondary.
    }
    throw mapSqliteError(error);
  }
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
