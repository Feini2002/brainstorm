import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

import { E2E_SCRIPTED_DIR } from './env';

/**
 * Reset the isolated e2e data directory (T026).
 *
 * Called from `playwright.config.ts` at module scope, which runs before the
 * `webServer` is spawned. Doing it there rather than in an npm pre-step means the
 * isolation holds no matter how the suite is invoked — `npm run test:e2e`,
 * `npx playwright test tests/e2e/gate1.spec.ts`, or an IDE runner. A pre-step in
 * `package.json` would silently be skipped by the last two.
 *
 * It only ever removes `tests/e2e/.data*`, and refuses outright if the resolved
 * path does not look like one of those. A test runner that can delete the user's
 * knowledge would be worse than no test runner.
 *
 * **Windows file locks.** A previous server that was just killed can still hold
 * the SQLite file and its `-wal`/`-shm` siblings for a moment after the process
 * exits, which makes the first `rmSync` fail with `EPERM`. This is not a
 * permission problem to be worked around by deleting more, so the retry is on
 * *time*: Node's own `maxRetries`/`retryDelay` re-attempt exactly the
 * `EBUSY`/`EPERM`/`ENOTEMPTY` family, and the reset either eventually succeeds or
 * reports the real reason. Without this the whole suite dies in config loading
 * before a single case runs.
 */
export function resetE2eDataDir(): void {
  const projectRoot = process.cwd();
  const e2eRoot = path.resolve(projectRoot, 'tests', 'e2e');
  const workerIndex = process.env.TEST_WORKER_INDEX;

  // Playwright loads this config in the worker process as well as in the runner,
  // and the worker starts *after* the webServer is already serving from `.data`.
  // Running the reset there deletes the database out from under the running
  // server, which surfaced as `EPERM` halfway through a run — after whichever case
  // happened to be first, so it looked like an unrelated test failure. Only the
  // runner (no worker index) resets, and it does so before spawning the server.
  if (workerIndex !== undefined) return;

  // Both directories belong to this suite: the shared server's and the one the
  // restart case starts for itself.
  for (const name of ['.data', '.data-restart']) {
    const dir = path.join(e2eRoot, name);
    if (path.dirname(dir) !== e2eRoot || !path.basename(dir).startsWith('.data')) {
      throw new Error(`E2E_RESET_REFUSED: 拒绝清理非预期目录 ${dir}`);
    }
    if (!existsSync(dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch (error) {
      // Report which directory and why, so a genuine lock (an editor or a
      // forgotten server holding the file) is diagnosable instead of surfacing
      // as an opaque EPERM inside Playwright's config load.
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `E2E_RESET_FAILED: 无法清理 ${dir}（${detail}）。` +
          '请确认没有其它 next start 实例或编辑器仍占用该目录后重试。',
      );
    }
  }
}

/**
 * Reset the per-run scripted-provider answers.
 *
 * Not a data directory, and the consequence of a stale file is different: a script
 * left behind by a previous run would answer this run's first paid call with an
 * old case's tree, which would look like a product bug. It is cleared for the same
 * reason the database is — one invocation, one clean slate.
 */
export function resetScriptedProviderDir(): void {
  if (process.env.TEST_WORKER_INDEX !== undefined) return;
  const dir = E2E_SCRIPTED_DIR;
  if (path.basename(dir) !== 'scripted-provider' || path.basename(path.dirname(dir)) !== 'test-results') {
    throw new Error(`E2E_RESET_REFUSED: 拒绝清理非预期目录 ${dir}`);
  }
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
