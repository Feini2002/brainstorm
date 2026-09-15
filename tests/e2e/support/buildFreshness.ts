import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Guard against testing a stale production build.
 *
 * `playwright.config.ts` launches `next start`, which serves `.next` — the output
 * of whatever `npm run build` ran last, *not* of the sources on disk. Editing
 * `src/**` and then running only `npx playwright test` therefore exercises the
 * previous build. That failure mode is genuinely dangerous here: the e2e result
 * looks like a product regression (a fix appears not to work) when the real cause
 * is a build that predates the fix by seconds.
 *
 * This happened during G2: `CaptureBox.tsx` was hardened at 22:10:41 while
 * `.next/BUILD_ID` was written at 22:10:05, and `T024-C01` then reported a model
 * call that the current source no longer makes.
 *
 * The check is deliberately a *timestamp* comparison rather than a content hash.
 * A hash would need the build to emit a manifest of its inputs, which would only
 * prove what the build recorded about itself; the newest source mtime versus the
 * build's own completion time answers the actual question — "is this build older
 * than the code I am about to claim it tests?" — with no new mechanism to keep in
 * sync. A false alarm is possible when only a comment changed, and the remedy is
 * a one-line `npm run build`, which is the right thing to do anyway.
 */

/** Directories whose contents are compiled into the production build. */
const WATCHED_DIRS = ['src'] as const;

/** Files at the repository root or in `scripts/` that affect a production run. */
const WATCHED_FILES = ['next.config.ts', 'package.json'] as const;

const BUILD_ID = path.join('.next', 'BUILD_ID');

export interface BuildFreshnessReport {
  fresh: boolean;
  buildTime: number | null;
  newestSource: string | null;
  newestSourceTime: number | null;
}

/** Newest mtime across the watched source set, or null when nothing is found. */
function newestWatchedMtime(projectRoot: string): { file: string; time: number } | null {
  let bestFile: string | null = null;
  let bestTime = Number.NEGATIVE_INFINITY;

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.mtimeMs > bestTime) {
        bestTime = stat.mtimeMs;
        bestFile = path.relative(projectRoot, full);
      }
    }
  };

  for (const dir of WATCHED_DIRS) {
    const full = path.join(projectRoot, dir);
    if (existsSync(full)) walk(full);
  }
  for (const file of WATCHED_FILES) {
    const full = path.join(projectRoot, file);
    if (!existsSync(full)) continue;
    try {
      const stat = statSync(full);
      if (stat.mtimeMs > bestTime) {
        bestTime = stat.mtimeMs;
        bestFile = file;
      }
    } catch {
      // An unreadable file cannot be compared; ignoring it is safer than
      // failing the whole suite on a file that may not even exist yet.
    }
  }

  return bestFile === null ? null : { file: bestFile, time: bestTime };
}

/**
 * Whether `.next` is at least as new as every watched source file.
 *
 * A missing build is reported as *fresh* rather than stale: Playwright's
 * `webServer` will fail on its own with "no production build" (and the npm script
 * documents running `npm run build` first), so duplicating that failure here adds
 * noise without adding information.
 */
export function checkBuildFreshness(projectRoot = process.cwd()): BuildFreshnessReport {
  const buildId = path.join(projectRoot, BUILD_ID);
  if (!existsSync(buildId)) {
    return { fresh: true, buildTime: null, newestSource: null, newestSourceTime: null };
  }

  const buildTime = statSync(buildId).mtimeMs;
  const newest = newestWatchedMtime(projectRoot);
  if (newest === null) {
    return { fresh: true, buildTime, newestSource: null, newestSourceTime: null };
  }

  return {
    fresh: buildTime >= newest.time,
    buildTime,
    newestSource: newest.file,
    newestSourceTime: newest.time,
  };
}

/** Human-readable failure text; states the exact remedy, not just the problem. */
export function formatStaleBuildError(report: BuildFreshnessReport): string {
  const built = report.buildTime === null ? '未知' : new Date(report.buildTime).toLocaleString();
  const changed =
    report.newestSourceTime === null ? '未知' : new Date(report.newestSourceTime).toLocaleString();
  return [
    'E2E_STALE_BUILD: 生产构建比源码旧，e2e 会测到上一次构建的结果。',
    `  构建时间：${built}`,
    `  最新源码：${report.newestSource ?? '未知'}（${changed}）`,
    '  请先运行 npm run build，再运行 npm run test:e2e。',
  ].join('\n');
}
