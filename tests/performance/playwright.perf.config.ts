import { defineConfig, devices } from '@playwright/test';

import { checkBuildFreshness, formatStaleBuildError } from '../e2e/support/buildFreshness';

/**
 * Performance-run configuration (T079).
 *
 * Deliberately separate from `playwright.config.ts`, and deliberately with **no
 * `webServer`**: R03 measures the same queries at three library sizes, and each
 * size lives in its own throwaway database, so the server is a resource a case
 * starts against a scale (`tests/performance/support/perfEnv.ts`) rather than one
 * fixed process for the whole run.
 *
 * The same two rules as the acceptance suite apply for the same reasons:
 *
 *  - **Only one worker.** These are timings, and a second Chromium competing for
 *    the same CPU would make every number describe contention instead of the app.
 *  - **The build must be fresh.** `next start` serves `.next`, so a stale build
 *    would be measured and reported as the current one. This throws at config
 *    load exactly like the e2e suite does.
 *
 * What is *not* here: no `resetE2eDataDir`. A perf run must not touch the
 * acceptance suite's database, and its own directories are seeded explicitly.
 */
const freshness = checkBuildFreshness();
if (!freshness.fresh) {
  throw new Error(`${formatStaleBuildError(freshness)}\n（性能数字必须来自当前构建）`);
}

export default defineConfig({
  // Relative to this file, which lives in `tests/performance`.
  testDir: '.',
  testMatch: /.*\.perf\.ts$/u,
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // A 10 000-row seed plus a cold server start per scale does not fit in 60s.
  timeout: 600_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [['list'], ['json', { outputFile: 'test-results/perf-results.json' }]] : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3210',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    ...devices['Desktop Chrome'],
  },
  projects: [{ name: 'perf', use: { ...devices['Desktop Chrome'] } }],
});
