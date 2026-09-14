import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { closeDb, getDb } from '@/server/db/database';

/**
 * Isolated test database helpers (T011-R01).
 *
 * Every suite gets its own temp directory; the user's `.data` is never opened,
 * and `closeDb` runs before the directory is removed so WAL files are released.
 */
export interface TestDatabase {
  /** Absolute path of the temporary database file. */
  databasePath: string;
  /** Root of the throwaway data directory. */
  dataDir: string;
  /** Remove the directory after closing the connection. */
  cleanup: () => void;
}

/**
 * Isolate the process from the user's data directory for the duration of a test.
 *
 * Route handlers call `getDb()` with no argument, so they resolve the data
 * directory from the environment. Pointing BRAIN_DATA_DIR at the throwaway
 * directory is what actually keeps tests off `.data` — and `assertNotUserDataDir`
 * then confirms it rather than trusting the caller.
 */
function pointDataDirAt(dataDir: string): void {
  process.env.BRAIN_DATA_DIR = dataDir;
}

function clearDataDirOverride(): void {
  delete process.env.BRAIN_DATA_DIR;
}

export function createTestDatabase(): TestDatabase {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'feini-test-'));
  const databasePath = path.join(dataDir, 'brain.db');
  pointDataDirAt(dataDir);

  return {
    dataDir,
    databasePath,
    cleanup: () => {
      closeDb(databasePath);
      rmSync(dataDir, { recursive: true, force: true });
      clearDataDirOverride();
    },
  };
}

/** Open the isolated database; migrations run automatically on first access. */
export function openTestDatabase(databasePath: string) {
  return getDb({ databasePath });
}

export function newId(): string {
  return randomUUID();
}

/** Fixed clock helper so lease/deadline logic needs no real waiting (T011-R03). */
export function frozenClock(iso: string) {
  const fixed = Date.parse(iso);
  return {
    now: () => fixed,
    iso: () => new Date(fixed).toISOString(),
  };
}
