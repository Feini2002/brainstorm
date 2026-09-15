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
  //
  // The `turbopackIgnore` annotation is the documented signal that this path is
  // resolved at runtime, not bundled: without it Turbopack cannot prove which
  // directory is touched and conservatively traces the whole project. The
  // excludes in `next.config.ts` bound the trace; this comment keeps the build
  // output free of a warning that would otherwise hide a real one.
  return path.resolve(/* turbopackIgnore: true */ process.cwd());
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
  if (isUserDataDir(dataDir)) {
    throw new DataDirError('测试不允许使用用户真实数据目录 .data');
  }
}

/**
 * True when `dataDir` is this repository's default user data directory.
 *
 * Mode-independent on purpose: the acceptance server is started from a build, so
 * `detectRunMode()` reports `USER` for it exactly as it would for the owner's own
 * run. The directory is what actually separates the two.
 */
export function isUserDataDir(dataDir: string): boolean {
  const userDir = path.join(findProjectRoot(), DEFAULT_DATA_DIR_NAME);
  return path.resolve(dataDir) === path.resolve(userDir);
}
