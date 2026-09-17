/**
 * SQLite connection lifecycle and transaction helper.
 *
 * One DatabaseSync per absolute database path, cached for the process so that
 * HMR and repeated requests do not reopen (or, worse, mix test and user
 * databases). The connection is created lazily — importing this module never
 * touches the disk.
 */
import 'server-only';

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AppError } from '@/domain/errors';
import {
  assertNotUserDataDir,
  detectRunMode,
  ensureDataDir,
  resolveDatabasePath,
} from '@/server/runtime/dataDir';
import { readUserVersion, runMigrations } from './migrations';

const BUSY_TIMEOUT_MS = 5000;

interface CachedConnection {
  db: DatabaseSync;
  path: string;
  migrated: boolean;
}

const connections = new Map<string, CachedConnection>();

export interface GetDbOptions {
  /** Explicit database path; tests pass a temp file to stay isolated. */
  databasePath?: string;
  /** Skip the automatic data-directory guard (used by migrations tooling). */
  skipGuard?: boolean;
}

export class DatabaseError extends AppError {
  constructor(message: string) {
    super('INTERNAL', message);
    this.name = 'DatabaseError';
  }
}

/** Not a user-facing error: busy/timeout maps to DATABASE_BUSY in the HTTP layer. */
export class DatabaseBusyError extends AppError {
  constructor(message = '数据库暂时繁忙，请稍后重试') {
    super('DATABASE_BUSY', message);
    this.name = 'DatabaseBusyError';
  }
}

export function getDb(options: GetDbOptions = {}): DatabaseSync {
  const databasePath = options.databasePath ?? resolveDatabasePath();
  const existing = connections.get(databasePath);
  if (existing) {
    if (!existing.migrated) {
      ensureSchema(existing.db);
      existing.migrated = true;
    }
    return existing.db;
  }

  if (!options.skipGuard) {
    assertNotUserDataDir(path.dirname(databasePath), detectRunMode());
  }

  ensureDataDir(path.dirname(databasePath));

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(databasePath);
  } catch (error) {
    throw new DatabaseError(
      `无法打开数据库 ${databasePath}：${error instanceof Error ? error.message : '未知错误'}`,
    );
  }

  configureConnection(db);
  const cached: CachedConnection = { db, path: databasePath, migrated: false };
  connections.set(databasePath, cached);
  ensureSchema(db);
  cached.migrated = true;
  return db;
}

/**
 * Apply the verified PRAGMAs. Return values are asserted rather than assumed
 * (T008-R03): `foreign_keys` must read back as 1 and WAL must be active.
 */
export function configureConnection(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON');
  const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number } | undefined;
  if (fk?.foreign_keys !== 1) {
    throw new DatabaseError('无法启用外键约束，数据库配置未生效');
  }

  // journal_mode must be set outside a transaction and returns the resulting mode.
  const journal = db.prepare('PRAGMA journal_mode = WAL').get() as
    | { journal_mode: string }
    | undefined;
  if (journal && journal.journal_mode.toLowerCase() !== 'wal') {
    throw new DatabaseError(
      `无法启用 WAL 模式（当前为 ${journal.journal_mode}），该目录可能不支持 WAL`,
    );
  }

  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA synchronous = NORMAL');
}

function ensureSchema(db: DatabaseSync): void {
  const version = readUserVersion(db);
  // Version 0 runs the initial migration; a higher-than-known version is
  // reported by the runner and refuses to continue.
  runMigrations(db);
  if (version === 0 && readUserVersion(db) < 1) {
    throw new DatabaseError('初始迁移未完成');
  }
}

/**
 * Run a synchronous transaction.
 *
 * The callback must not return a promise: awaiting a provider request inside a
 * transaction is forbidden (blueprint §2), so a thenable is treated as a bug and
 * rolled back.
 */
export function withTransaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const value = action();
    if (value !== null && typeof (value as { then?: unknown })?.then === 'function') {
      throw new DatabaseError('事务回调不允许返回 Promise');
    }
    db.exec('COMMIT');
    committed = true;
    return value;
  } catch (error) {
    if (!committed) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the original error; the rollback failure is secondary.
      }
    }
    throw mapSqliteError(error);
  }
}

/** Map SQLite constraint/busy failures onto contract error codes. */
export function mapSqliteError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    const message = error.message;
    if (/SQLITE_BUSY|database is locked|SQLITE_LOCKED/u.test(message)) {
      return new DatabaseBusyError();
    }
    if (/UNIQUE constraint failed/u.test(message)) {
      return new DatabaseError('数据唯一性冲突');
    }
    if (/FOREIGN KEY constraint failed/u.test(message)) {
      return new DatabaseError('外键引用无效');
    }
    if (/CHECK constraint failed/u.test(message)) {
      return new DatabaseError('数据未满足约束');
    }
  }
  return error;
}

/** Close and forget a cached connection. Tests call this before deleting temp dirs. */
export function closeDb(databasePath?: string): void {
  if (databasePath === undefined) {
    for (const [key, connection] of connections) {
      try {
        connection.db.close();
      } catch {
        // A close failure on shutdown must not throw to callers.
      }
      connections.delete(key);
    }
    return;
  }
  const connection = connections.get(databasePath);
  if (!connection) return;
  try {
    connection.db.close();
  } finally {
    connections.delete(databasePath);
  }
}

/** Read the dataset revision used to invalidate derived projections. */
export function getDatasetRevision(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM app_meta WHERE key = 'dataset_revision'").get() as
    | { value: string }
    | undefined;
  return row ? Number.parseInt(row.value, 10) : 0;
}

/** Increment dataset_revision inside the caller's transaction. */
export function bumpDatasetRevision(db: DatabaseSync): number {
  db.prepare(
    "UPDATE app_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'dataset_revision'",
  ).run();
  return getDatasetRevision(db);
}
