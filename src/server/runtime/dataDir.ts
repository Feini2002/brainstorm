/**
 * Data directory resolution.
 *
 * Default: <project root>/.data/brain.db. BRAIN_DATA_DIR may override it, but
 * only from the process environment — never from an ordinary API request
 * (T008-R01). The directory is created lazily on first database access, not at
 * import or build time (T008-R02).
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { AppError } from '@/domain/errors';

export const DEFAULT_DATA_DIR_NAME = '.data';
export const DATABASE_FILE_NAME = 'brain.db';

/** Where the repository root is, relative to this file (src/server/runtime). */
export function findProjectRoot(): string {
  // process.cwd() is the Next.js / Node server working directory in dev and
  // production start. The spec keeps the app rooted at the repo root.
  return path.resolve(process.cwd());
}

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BRAIN_DATA_DIR;
  if (override !== undefined && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  return path.join(findProjectRoot(), DEFAULT_DATA_DIR_NAME);
}

export function resolveDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDataDir(env), DATABASE_FILE_NAME);
}

export class DataDirError extends AppError {
  constructor(message: string) {
    super('INTERNAL', message);
    this.name = 'DataDirError';
  }
}

/**
 * Ensure the data directory exists and is writable. Throws a diagnosable error
 * instead of silently falling back to an unknown temporary directory.
 */
export function ensureDataDir(dataDir: string): void {
  try {
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
  } catch (error) {
    throw new DataDirError(
      `无法创建数据目录 ${dataDir}：${error instanceof Error ? error.message : '未知错误'}`,
    );
  }

  // Verify writability with a probe file rather than assuming mkdir implies it.
  const probe = path.join(dataDir, '.write-probe');
  try {
    writeFileSync(probe, 'ok', { encoding: 'utf8' });
    unlinkSync(probe);
  } catch (error) {
    throw new DataDirError(
      `数据目录不可写 ${dataDir}：${error instanceof Error ? error.message : '未知错误'}`,
    );
  }
}

export type RunMode = 'BUILD' | 'TEST' | 'DEV' | 'USER';

/**
 * Distinguish the four run modes used in diagnostics (blueprint §6). Never used
 * to change business rules — only for reporting and test isolation guards.
 */
export function detectRunMode(env: NodeJS.ProcessEnv = process.env): RunMode {
  if (env.NEXT_PHASE === 'phase-production-build') return 'BUILD';
  if (env.VITEST !== undefined || env.NODE_ENV === 'test') return 'TEST';
  if (env.NODE_ENV === 'production') return 'USER';
  return 'DEV';
}

/** Guard used by tests: refuse to operate on the user's real data directory. */
export function assertNotUserDataDir(dataDir: string, mode: RunMode): void {
  if (mode !== 'TEST') return;
  const userDir = path.join(findProjectRoot(), DEFAULT_DATA_DIR_NAME);
  if (path.resolve(dataDir) === path.resolve(userDir)) {
    throw new DataDirError('测试不允许使用用户真实数据目录 .data');
  }
}
