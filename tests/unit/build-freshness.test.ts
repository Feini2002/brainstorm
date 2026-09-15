import { mkdtempSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkBuildFreshness, formatStaleBuildError } from '../e2e/support/buildFreshness';

/**
 * T052-R06-adjacent infrastructure guard.
 *
 * The e2e suite serves `.next`, so a build older than the sources means every
 * case reports on code that is not in the working tree. That happened during G2
 * (a 36-second gap between the build and the last edit) and was initially read as
 * a product regression. These cases pin the guard that turns that silent
 * misreport into an explicit failure.
 *
 * The fixture is a throwaway directory shaped like a project root, so nothing
 * here depends on the real build state of this repository.
 */
function makeProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'feini-freshness-'));
  mkdirSync(path.join(root, 'src', 'features'), { recursive: true });
  mkdirSync(path.join(root, '.next'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'features', 'thing.ts'), 'export const x = 1;\n');
  writeFileSync(path.join(root, 'next.config.ts'), 'export default {};\n');
  writeFileSync(path.join(root, '.next', 'BUILD_ID'), 'build-1\n');
  return root;
}

/** Set mtimes so "newer" is unambiguous without waiting on the clock. */
function stamp(file: string, epochSeconds: number): void {
  utimesSync(file, epochSeconds, epochSeconds);
}

const BASE = 1_700_000_000;

describe('e2e 构建新鲜度守卫', () => {
  it('构建晚于源码时判定为新鲜，不报错', () => {
    const root = makeProject();
    try {
      stamp(path.join(root, 'src', 'features', 'thing.ts'), BASE);
      stamp(path.join(root, 'next.config.ts'), BASE);
      stamp(path.join(root, '.next', 'BUILD_ID'), BASE + 60);

      const report = checkBuildFreshness(root);
      expect(report.fresh).toBe(true);
      expect(report.buildTime).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('源码比构建新时判定为过期，并指出最新的那个文件', () => {
    const root = makeProject();
    try {
      stamp(path.join(root, 'next.config.ts'), BASE);
      stamp(path.join(root, '.next', 'BUILD_ID'), BASE + 10);
      // The edit that the previous build knows nothing about.
      stamp(path.join(root, 'src', 'features', 'thing.ts'), BASE + 3600);

      const report = checkBuildFreshness(root);
      expect(report.fresh).toBe(false);
      expect(report.newestSource).toBe(path.join('src', 'features', 'thing.ts'));

      const message = formatStaleBuildError(report);
      expect(message).toContain('E2E_STALE_BUILD');
      // The remedy must be stated, not just the diagnosis.
      expect(message).toContain('npm run build');
      expect(message).toContain('thing.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('没有构建产物时不误报为过期，交给启动步骤给出真实错误', () => {
    const root = makeProject();
    try {
      rmSync(path.join(root, '.next', 'BUILD_ID'), { force: true });
      // A source file far newer than the (absent) build must not fail here: the
      // webServer step is what reports "no production build", with a better
      // message than this guard could produce.
      stamp(path.join(root, 'src', 'features', 'thing.ts'), BASE + 3600);

      const report = checkBuildFreshness(root);
      expect(report.fresh).toBe(true);
      expect(report.buildTime).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('嵌套目录里的改动同样算数，不只比较顶层文件', () => {
    const root = makeProject();
    try {
      mkdirSync(path.join(root, 'src', 'deep', 'nest'), { recursive: true });
      const deep = path.join(root, 'src', 'deep', 'nest', 'inner.ts');
      writeFileSync(deep, 'export const y = 2;\n');
      stamp(path.join(root, 'src', 'features', 'thing.ts'), BASE);
      stamp(path.join(root, 'next.config.ts'), BASE);
      stamp(path.join(root, '.next', 'BUILD_ID'), BASE + 60);
      stamp(deep, BASE + 120);

      const report = checkBuildFreshness(root);
      expect(report.fresh).toBe(false);
      expect(report.newestSource).toBe(path.join('src', 'deep', 'nest', 'inner.ts'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
