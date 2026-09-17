/**
 * Versioned migration runner.
 *
 * The migration SQL ships with the source (never generated at runtime) and each
 * version is applied together with its `user_version` bump inside one
 * transaction, so a failure leaves no half-built schema.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const LATEST_KNOWN_VERSION = 2;

const MIGRATION_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export function migrationsDirectory(): string {
  return path.join(process.cwd(), 'src', 'server', 'db', 'migrations');
}

export function loadMigrations(directory = migrationsDirectory()): Migration[] {
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && MIGRATION_PATTERN.test(entry.name))
    .map((entry) => {
      const match = MIGRATION_PATTERN.exec(entry.name) as RegExpExecArray;
      return {
        version: Number.parseInt(match[1], 10),
        name: entry.name,
        sql: readFileSync(path.join(directory, entry.name), 'utf8'),
      };
    })
    .sort((a, b) => a.version - b.version);

  const versions = new Set<number>();
  for (const migration of entries) {
    if (versions.has(migration.version)) {
      throw new MigrationError(`迁移版本重复：${migration.version}`);
    }
    versions.add(migration.version);
  }

  return entries;
}

export function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

export interface MigrationReport {
  from: number;
  to: number;
  applied: number[];
}

/**
 * Apply every migration newer than the database's user_version.
 *
 * A database whose version is HIGHER than this build understands is reported and
 * refused: the app never downgrades or rebuilds user data (T009-R02).
 */
export function runMigrations(db: DatabaseSync, directory = migrationsDirectory()): MigrationReport {
  const migrations = loadMigrations(directory);
  const current = readUserVersion(db);

  if (current > LATEST_KNOWN_VERSION) {
    throw new MigrationError(
      `数据库版本 ${current} 高于本程序支持的 ${LATEST_KNOWN_VERSION}，请升级程序而不是降级数据库`,
    );
  }

  const pending = migrations.filter((migration) => migration.version > current);
  if (pending.length === 0) {
    return { from: current, to: current, applied: [] };
  }

  const applied: number[] = [];
  for (const migration of pending) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
      applied.push(migration.version);
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The rollback failure must not mask the original migration error.
      }
      throw new MigrationError(
        `迁移 ${migration.name} 失败：${error instanceof Error ? error.message : '未知错误'}`,
      );
    }
  }

  return { from: current, to: readUserVersion(db), applied };
}
