/**
 * Test stub for the `server-only` marker package.
 *
 * The real package throws unless loaded through the Next.js server condition.
 * Vitest runs server modules directly, so the marker is aliased to this no-op;
 * the actual client/server boundary is still enforced by ESLint (T003-R06).
 */
export {};
