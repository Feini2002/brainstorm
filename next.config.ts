import type { NextConfig } from "next";

/**
 * Next.js build configuration.
 *
 * `outputFileTracingExcludes` is the documented way to bound the build-time file
 * trace for a genuinely dynamic filesystem path. T008 requires the SQLite file to
 * be resolved at runtime from `BRAIN_DATA_DIR` / the project root, so the tracer
 * cannot prove statically which directory is touched and conservatively emits
 * "Dynamic filesystem access causes tracing of the whole project".
 *
 * Excluding the non-runtime trees keeps the trace honest without narrowing the
 * runtime behaviour: none of these directories are read by the server, and the
 * data directory is created lazily by `ensureDataDir` rather than shipped.
 */
const nextConfig: NextConfig = {
  outputFileTracingExcludes: {
    "*": [
      "./.data/**/*",
      "./.next/**/*",
      "./docs/**/*",
      "./implementation/**/*",
      "./reference/**/*",
      "./tests/**/*",
      "./coverage/**/*",
      "./test-results/**/*",
      "./playwright-report/**/*",
    ],
  },
};

export default nextConfig;
