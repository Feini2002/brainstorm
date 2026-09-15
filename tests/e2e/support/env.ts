import path from 'node:path';

/**
 * Shared e2e environment (T024-R05, T026).
 *
 * The whole point of these constants is that the suite talks to a *separate*
 * local instance on a *separate* port with a *separate* database:
 *
 *  - port 3100 rather than 3000, so a developer running `npm run dev` in another
 *    terminal does not collide with, or get tested instead of, the app under test;
 *  - `tests/e2e/.data` rather than `./.data`, so no case can read or delete the
 *    user's real knowledge;
 *  - loopback only, because "offline" here means "the external network is
 *    unreachable while 127.0.0.1 stays reachable" (T024-R05). These are not the
 *    same condition and the tests must not conflate them.
 *
 * `process.cwd()` is the repository root: Playwright is always invoked through
 * the npm script, and both the config and the specs resolve paths from it. Using
 * it (rather than a module-relative trick) also keeps this file loadable whether
 * Playwright transforms it as ESM or CJS.
 */
const projectRoot = process.cwd();

export const E2E_HOST = '127.0.0.1';
export const E2E_PORT = 3100;
export const E2E_ORIGIN = `http://${E2E_HOST}:${E2E_PORT}`;

/** Absolute so the spawned server and the assertions agree on one directory. */
export const E2E_DATA_DIR = path.resolve(projectRoot, 'tests', 'e2e', '.data');

/**
 * The restart case's own data directory (T026-R03).
 *
 * Declared here rather than inside `restartServer.ts` because the Playwright
 * config needs it too: the suite's long-lived server is what T061-C02 seeds the
 * material and the view through, and it answers only for the database it was
 * started against. A case that seeded `E2E_DATA_DIR` and then opened the view on
 * the restart server would be looking for a row in a different file — the two
 * directories have to be the same one, and that is a config fact, not a helper
 * detail.
 */
export const E2E_RESTART_DATA_DIR = path.resolve(projectRoot, 'tests', 'e2e', '.data-restart');

/**
 * Where per-case scripted-provider answers are written.
 *
 * Under `test-results/`, which git already ignores: these files contain only the
 * case's own node labels and freshly created ids, but they are run artefacts and
 * do not belong in the repository.
 *
 * The server is told about this *directory*, not about one file, because the
 * suite's server is started by Playwright's `webServer` and `next start` passes
 * the environment through unchanged — a spec cannot change the variable between
 * cases. It can create a file, though, so each case writes its own uniquely named
 * script here and the server replays the newest one. One worker means only one
 * case is ever writing, so "newest" is unambiguous.
 */
export const E2E_SCRIPTED_DIR = path.resolve(projectRoot, 'test-results', 'scripted-provider');

/** Where this suite writes its evidence; ignored by git, kept for the report. */
export const E2E_ARTIFACTS_DIR = path.resolve(projectRoot, 'test-results');
