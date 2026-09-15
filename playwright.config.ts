import { defineConfig, devices, type Project } from '@playwright/test';

import { E2E_DATA_DIR, E2E_HOST, E2E_ORIGIN, E2E_PORT, E2E_SCRIPTED_DIR } from './tests/e2e/support/env';
import { resetE2eDataDir, resetScriptedProviderDir } from './tests/e2e/support/resetData';
import { checkBuildFreshness, formatStaleBuildError } from './tests/e2e/support/buildFreshness';

/**
 * Playwright configuration (T011-R03, T024-R05, T026).
 *
 * Three decisions worth stating, because each one is a test-integrity rule and
 * not a preference:
 *
 * 1. **An isolated data directory per run.** `tests/e2e/support/resetData.ts`
 *    resets `tests/e2e/.data` and the web server starts with `BRAIN_DATA_DIR`
 *    pointing at it. The suite therefore never opens the user's real
 *    `./.data/brain.db` (T026 「测试不触碰用户数据库」).
 *
 * 2. **Only one worker.** Every server-side invariant being checked here is
 *    about a single local process and its single SQLite file — run leases,
 *    idempotent replay, "no external request happened". Running cases in
 *    parallel against one database would make those facts unobservable, and
 *    running N servers on N ports would multiply the process each test is
 *    asserting about.
 *
 * 3. **`uses` is production `next start`, not `next dev`.** The offline claims
 *    (T024-R01/R05, T026-R05) are about what the built app requests. Dev mode
 *    adds HMR websockets and dev-only asset requests that would make a network
 *    audit meaningless.
 *
 * 4. **The build is checked for freshness before anything runs.** Because (3)
 *    means `.next` is served, editing `src/**` and running only
 *    `npx playwright test` would test the previous build and report the diff as a
 *    product failure. See `tests/e2e/support/buildFreshness.ts`.
 */

// Runs before Playwright spawns the web server, so every invocation of this
// config — npm script, direct `npx playwright test`, IDE runner — starts from an
// empty, isolated library. Cases that assert on "empty state" or count rows would
// otherwise depend on how many times the suite had already run.
resetE2eDataDir();

// Scripted-provider answers are per-run artefacts too: a stale script left from a
// previous run would answer this run's first paid call with an old case's tree.
resetScriptedProviderDir();

// Fail loudly rather than silently testing the previous build. Only a real
// `npm run build` after the last source edit can satisfy this.
const freshness = checkBuildFreshness();
if (!freshness.fresh) {
  throw new Error(formatStaleBuildError(freshness));
}

export default defineConfig({
  testDir: './tests/e2e',
  // Specs and their seed fixtures live together; nothing else is collected.
  testMatch: /.*\.spec\.ts$/u,
  // Evidence capture writes screenshots and is run on demand
  // (`E2E_EVIDENCE=1 npx playwright test tests/e2e/evidence`), not as part of
  // acceptance: an acceptance run must not depend on artifacts existing.
  testIgnore: process.env.E2E_EVIDENCE ? [] : '**/evidence/**',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [['list'], ['json', { outputFile: 'test-results/e2e-results.json' }]]
    : [['list']],
  use: {
    baseURL: E2E_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // The app is same-origin only; no external host should ever be contacted.
    ignoreHTTPSErrors: false,
    ...devices['Desktop Chrome'],
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ] satisfies Project[],
  webServer: {
    // `next start` serves the production build. `npm run build` is a separate
    // step so a failing build is reported as a build failure, not a timeout.
    command: `node scripts/start-local.mjs start`,
    url: `${E2E_ORIGIN}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      APP_HOST: E2E_HOST,
      APP_PORT: String(E2E_PORT),
      APP_ORIGIN: E2E_ORIGIN,
      BRAIN_DATA_DIR: E2E_DATA_DIR,
      // T061's closed-loop cases drive the *real* generation route, adapter and
      // transaction while the model answer is a fixed sample. The route reads this
      // variable from the process environment, and Playwright's `webServer` is the
      // only place it can be set — `next start` passes it through to the server.
      // A directory (not a file) because the spec cannot change the variable
      // between cases: each case writes a new script there and the server replays
      // the newest one. With no variable set the transport is native fetch.
      BRAIN_SCRIPTED_PROVIDER: E2E_SCRIPTED_DIR,
      NODE_ENV: 'production',
    },
  },
});
