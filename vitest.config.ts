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
          name: 'contracts',
          include: ['tests/contracts/**/*.test.ts'],
          environment: 'node',
          // These spawn a child process and copy a file tree per case.
          testTimeout: 30_000,
        },
      },
    ],
  },
});
