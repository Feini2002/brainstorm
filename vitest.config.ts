import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Vitest projects (T011-R01).
 *
 * `unit`      — pure domain code, no filesystem, no database.
 * `integration` — real SQLite files in an isolated temp directory.
 *
 * Tests never touch the user's `.data`: every integration suite passes an
 * explicit BRAIN_DATA_DIR pointing at a per-run temp folder.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      // `server-only` throws outside a Next server component; the alias keeps
      // server modules importable in tests. The real boundary is enforced by
      // ESLint's import rules (T003-R06).
      'server-only': path.resolve(import.meta.dirname, 'tests/helpers/server-only-stub.ts'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    passWithNoTests: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          /*
           * T076-C06: the unit project runs with a fail-closed network guard —
           * `fetch` and `net.Socket.connect` throw for non-loopback hosts, so a
           * deterministic case cannot quietly start depending on a real model or
           * a paid endpoint. Only `unit` gets this: `integration`, `security`,
           * `contracts` and `e2e` need real HTTP and have their own isolation.
           */
          setupFiles: ['tests/unit/support/networkGuard.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          // Real SQLite files and migrations are slower than pure functions.
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      {
        extends: true,
        test: {
          /*
           * Security regression (T075).
           *
           * A separate project rather than a folder inside `integration`: the
           * T007/T030 suites were *moved* here so a security rule has exactly
           * one home (duplicating them would let one copy drift), and a moved
           * file that no project collects fails silently — it would simply
           * stop running. `vitest.config.ts` is the only place that can state
           * "these files are collected"; its count is verified in the T075
           * evidence rather than assumed.
           *
           * The environment is the same real-SQLite setup the integration
           * project uses; nothing here is a stub suite.
           */
          name: 'security',
          include: ['tests/security/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'contracts',
          include: ['tests/contracts/**/*.test.ts'],
          environment: 'node',
          // These spawn a child process and copy a file tree per case.
          testTimeout: 30_000,
          // Cleanup is `rmSync` over copied trees: a full-suite run puts several
          // projects on the same disk at once, and the default 10s hook budget was
          // observed to expire there (guard.test.ts passes in ~1.7s when the
          // project runs alone).
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          // Real-browser cases for the flow renderer/sanitizer (T065-C01–C04,
          // T066-C01/C06). They run under Node like every other project, but the
          // assertions execute inside a real Chromium: `dompurify` never attaches
          // `sanitize` without a DOM and Mermaid is a browser library, so these
          // cannot be honest in-process. See tests/browser/support/flowSandbox.ts.
          name: 'browser',
          include: ['tests/browser/**/*.test.ts'],
          environment: 'node',
          // Launching Chromium and bundling Mermaid dominate the runtime.
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
