// T012 契约一致性验收测试。
//
// 这些用例直接驱动 scripts/check-contracts.mjs，验证漂移检测真的会失败，
// 而不是只验证脚本本身能退出 0。T012-C01 与 T012-C03 的核心就是
// “改坏之后必须被拦下”，因此测试要在临时副本里注入缺陷再观察结果。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  routes: { implemented: number; pending: number; paths: number; endpointMethods: number };
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
    const removed = original.replace('/.data/\n', '');
    expect(removed, '.gitignore 中应有独立的 /.data/ 条目').not.toBe(original);
    writeFileSync(ignorePath, removed, 'utf8');

    // 除此之外 /tests/e2e/.data/ 还在，所以这条正是在断言“只忽略测试目录不够”。
    expect(removed).toContain('/tests/e2e/.data/');
    const { status, report } = runGuard(directory);
    const typed = report as GuardReport;
    expect(status).toBe(1);
    expect(typed.failures.join('\n')).toContain('.data');
  });

  it('T012-C02 嵌套路径的子串不能顶替真实数据目录', () => {
    const directory = scratchCopy();
    const ignorePath = path.join(directory, '.gitignore');
    const original = readFileSync(ignorePath, 'utf8');
    // `includes('.data')` 会被这一行满足，但用户的 ./.data 仍然可被提交。
    // 这是真实发生过的漏洞：e2e 隔离目录上线后，检查项被它的子串蒙过去了。
    writeFileSync(ignorePath, `${original.replace('/.data/\n', '')}\n/tests/e2e/.data/\n`, 'utf8');

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
    // 待办表里的端点必须真的还没实现；否则 guard 应报“登记过期”而不是放过它。
    // 过去这里把某个**具体**端点写死成未实现，该端点实现后用例就静默失效了
    // （G3 的 `/api/graph` 发生过一次，G6 的 `/api/export` 又发生一次）。所以这里
    // 从待办表里**动态**挑一条仍然未实现的端点，让用例随进度自然迁移。
    const guardPath = path.join(directory, 'scripts/check-contracts.mjs');
    const original = readFileSync(guardPath, 'utf8');
    const declared = [...original.matchAll(/^\s*'([^']+)':\s*'T\d+',\s*$/gmu)].map((match) => match[1]);
    expect(declared.length, '待办表应至少登记一个未实现端点').toBeGreaterThan(0);

    const pendingPath = declared.find((candidate) => {
      const routeFile = path.join(
        projectRoot,
        'src/app/api',
        ...candidate.replace(/^\/api\//u, '').split('/').filter((segment) => !segment.startsWith('{')),
        'route.ts',
      );
      return !existsSync(routeFile);
    });
    expect(pendingPath, `待办表 ${declared.join(', ')} 中的端点都已实现，登记应清理`).toBeDefined();

    writeFileSync(guardPath, original.replace(new RegExp(`^\\s*'${pendingPath}':[^\\n]*\\n`, 'mu'), ''), 'utf8');

    const { status, report } = runGuard(directory);
    const typed = report as GuardReport;
    expect(status).toBe(1);
    expect(typed.failures.join('\n')).toContain(pendingPath);
  });
});
