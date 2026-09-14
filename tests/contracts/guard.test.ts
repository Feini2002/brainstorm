// T012 契约一致性验收测试。
//
// 这些用例直接驱动 scripts/check-contracts.mjs，验证漂移检测真的会失败，
// 而不是只验证脚本本身能退出 0。T012-C01 与 T012-C03 的核心就是
// “改坏之后必须被拦下”，因此测试要在临时副本里注入缺陷再观察结果。
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const projectRoot = path.resolve(import.meta.dirname, '../..');

const temporaries: string[] = [];

afterAll(() => {
  for (const directory of temporaries) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Run the guard against the real project. */
function runGuard(cwd = projectRoot) {
  const result = spawnSync(process.execPath, [path.join(cwd, 'scripts/check-contracts.mjs')], {
    cwd,
    encoding: 'utf8',
  });
  let report: unknown = null;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    report = null;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, report };
}

/**
 * Mirror the files the guard reads into a scratch directory so a defect can be
 * injected without touching the working tree.
 */
function scratchCopy(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'feini-contracts-'));
  temporaries.push(directory);
  for (const relative of [
    'scripts/check-contracts.mjs',
    'reference/contracts/limits.json',
    'reference/contracts/error_codes.json',
    'reference/contracts/api_registry.json',
    'src/domain/limits.ts',
    'src/domain/errors.ts',
    'src/domain/knowledge.ts',
    'src/server/db/migrations/001_initial.sql',
    'src/app',
    '.gitignore',
  ]) {
    const source = path.join(projectRoot, relative);
    const target = path.join(directory, relative);
    cpSync(source, target, { recursive: true });
  }
  return directory;
}

interface GuardReport {
  ok: boolean;
  failures: string[];
  routes: { implemented: number; pending: number; total: number };
}

describe('T012 契约一致性', () => {
  it('当前仓库通过契约检查', () => {
    const { status, report } = runGuard();
    expect(report, `guard 输出不是 JSON：\n${JSON.stringify(report)}`).not.toBeNull();
    const typed = report as GuardReport;
    expect(typed.failures).toEqual([]);
    expect(status).toBe(0);
  });

  it('T012-C01 限制漂移会被指出字段与来源', () => {
    const directory = scratchCopy();
    // 模拟“前端把标题上限改成 200”这一类漂移。
    const limitsTs = path.join(directory, 'src/domain/limits.ts');
    const original = readFileSync(limitsTs, 'utf8');
    writeFileSync(
      limitsTs,
      original.replace(/\btitleCodePoints:\s*\d+/u, 'titleCodePoints: 999999'),
      'utf8',
    );

    const { status, report } = runGuard(directory);
    const typed = report as GuardReport;
    expect(status).toBe(1);
    expect(typed.ok).toBe(false);
    expect(typed.failures.join('\n')).toContain('titleCodePoints');
  });

  it('T012-C01 数据库枚举与领域枚举不一致会被拦下', () => {
    const directory = scratchCopy();
    const sqlPath = path.join(directory, 'src/server/db/migrations/001_initial.sql');
    const original = readFileSync(sqlPath, 'utf8');
    // 数据库允许了一个领域层没有的类型。
    const injected = original.replace(
      /type IN \('idea','concept'/u,
      "type IN ('idea','ghost_type','concept'",
    );
    expect(injected, '测试注入点未命中，说明 SQL 结构已变化').not.toBe(original);
    writeFileSync(sqlPath, injected, 'utf8');

    const { status, report } = runGuard(directory);
    const typed = report as GuardReport;
    expect(status).toBe(1);
    expect(typed.failures.join('\n')).toContain('ITEM_TYPES');
  });

  it('T012-C02 .gitignore 必须覆盖数据目录与密钥文件', () => {
    const directory = scratchCopy();
    const ignorePath = path.join(directory, '.gitignore');
    const original = readFileSync(ignorePath, 'utf8');
    writeFileSync(ignorePath, original.replace('/.data/', ''), 'utf8');

    const { status, report } = runGuard(directory);
    const typed = report as GuardReport;
    expect(status).toBe(1);
    expect(typed.failures.join('\n')).toContain('.data');
  });

  it('T012-C05 契约检查不依赖构建产物，可在干净目录运行', () => {
    const directory = scratchCopy();
    // 只保留源码与契约，不复制 node_modules 与 .next。
    const { status, report } = runGuard(directory);
    const typed = report as GuardReport;
    expect(typed, '干净目录下 guard 应仍能产出报告').not.toBeNull();
    expect(status).toBe(0);
  });

  it('T012-C06 未实现路由必须登记待办，不能伪装成已完成', () => {
    const directory = scratchCopy();
    // 移除一个已登记的路由映射，guard 应报“缺少路由实现且未登记待办”。
    const guardPath = path.join(directory, 'scripts/check-contracts.mjs');
    const original = readFileSync(guardPath, 'utf8');
    writeFileSync(guardPath, original.replace(/^\s*'\/api\/graph':\s*'T043',\s*$/mu, ''), 'utf8');

    const { status, report } = runGuard(directory);
    const typed = report as GuardReport;
    expect(status).toBe(1);
    expect(typed.failures.join('\n')).toContain('/api/graph');
  });
});
