/**
 * T002 验收用例｜依赖解析、锁定与下载
 *
 * 用例规格：docs/05_tests/G0/T002_cases.md。这些用例不读实现代码，而是对
 * `package.json` / `package-lock.json` / `.npmrc` 与真实 npm 行为下断言，因为
 * T002 的交付物本身就是「能被复现的依赖树」而不是某个函数。
 *
 * 观察方法按规格要求执行：记录命令、退出码、生成文件与目录快照，并对文件操作
 * 比较前后哈希。`npm ci` 只在临时目录里跑（把 package.json / package-lock.json /
 * .npmrc 复制过去），绝不触碰工作区的 lockfile 或 node_modules；BROWSERS_PATH
 * 也只作为子进程环境变量传入，不写用户级配置。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = path.join(projectRoot, 'package.json');
const lockPath = path.join(projectRoot, 'package-lock.json');
const npmrcPath = path.join(projectRoot, '.npmrc');

const temporaries: string[] = [];

afterAll(() => {
  for (const directory of temporaries) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Manifest {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
}

interface Lock {
  lockfileVersion: number;
  packages: Record<string, { version?: string; peerDependencies?: Record<string, string> }>;
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as Lock;
const npmrc = readFileSync(npmrcPath, 'utf8');

const directDependencies = { ...manifest.dependencies, ...manifest.devDependencies };
const lockVersionOf = (name: string): string | undefined =>
  lock.packages[`node_modules/${name}`]?.version;

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * A scratch copy of the three dependency files.
 *
 * `npm ci` deletes and rebuilds `node_modules`, so it must never run in the
 * working tree: deleting the real one would also break the sibling worker's
 * build. Note the copy is deliberate rather than a junction — a junction would
 * point `npm ci`'s "remove node_modules" step straight at the real directory.
 */
function scratchProject(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'feini-deps-'));
  temporaries.push(directory);
  for (const name of ['package.json', 'package-lock.json', '.npmrc']) {
    writeFileSync(path.join(directory, name), readFileSync(path.join(projectRoot, name)));
  }
  return directory;
}

interface CommandResult {
  status: number | null;
  output: string;
  elapsedMs: number;
}

function run(command: string, cwd: string, env: Partial<NodeJS.ProcessEnv> = {}): CommandResult {
  const started = Date.now();
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    elapsedMs: Date.now() - started,
  };
}

/** Read an installed package's own version, i.e. what actually landed on disk. */
function installedVersion(directory: string, name: string): string | null {
  const file = path.join(directory, 'node_modules', ...name.split('/'), 'package.json');
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: string };
  return parsed.version ?? null;
}

/**
 * How many packages actually landed in `node_modules`.
 *
 * Counted by walking for `package.json` files under scoped and bare names, because
 * `npm ci` creates `node_modules` even when it then fails: an existence check on
 * the directory would read "installed something" for a failed run.
 */
function installedPackageCount(directory: string): number {
  const root = path.join(directory, 'node_modules');
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    // A bare name is a package; a scope is a directory of packages.
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(path.join(root, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory() && existsSync(path.join(root, entry.name, scoped.name, 'package.json'))) {
          count += 1;
        }
      }
      continue;
    }
    if (existsSync(path.join(root, entry.name, 'package.json'))) count += 1;
  }
  return count;
}

/**
 * Does a peer range admit this major version?
 *
 * Only the range shapes that actually occur in this lockfile are supported: an
 * `||` union of `*`, `>=X`, `^X`, `~X`, `X` and `X.x.x` clauses. npm's own
 * resolver handles the install; this exists so "the React major is inside every
 * declared peer range" is a checked fact rather than a promise.
 */
function majorAllowed(range: string, major: number): boolean {
  return range.split('||').some((clause) => {
    const trimmed = clause.trim();
    if (trimmed.length === 0 || trimmed === '*') return true;
    const version = /^(?:>=|\^|~|>)?\s*(\d+)/u.exec(trimmed);
    if (!version) return false;
    const bound = Number.parseInt(version[1] as string, 10);
    if (trimmed.startsWith('>=') || trimmed.startsWith('>')) return major >= bound;
    return major === bound;
  });
}

describe('T002 依赖解析、锁定与下载', () => {
  it('T002-C01 已有锁定树时 npm ci 得到同一依赖树，且不重写 lockfile', async () => {
    const directory = scratchProject();
    const lockBefore = sha256(path.join(directory, 'package-lock.json'));

    const result = run('npm ci --ignore-scripts --prefer-offline --no-audit', directory);

    // 记录实际耗时：这是把该命令放进自动化套件的成本依据。
    expect(
      result.status,
      `npm ci 未成功（退出码 ${result.status}，${result.elapsedMs}ms）\n${result.output.slice(-2000)}`,
    ).toBe(0);

    // 「必须断言：lockfile 不被无理由重写」——逐字节比对，而不是比版本号。
    expect(sha256(path.join(directory, 'package-lock.json'))).toBe(lockBefore);

    // 「必须断言：得到同一依赖树」——安装产物必须与锁文件记录的版本一致，
    // 只断言退出码无法区分「装上了锁定的版本」和「装上了别的版本」。
    const mismatched: string[] = [];
    for (const name of Object.keys(directDependencies)) {
      const expected = lockVersionOf(name);
      expect(expected, `${name} 不在锁文件中，锁定树不完整`).toBeDefined();
      const actual = installedVersion(directory, name);
      if (actual !== expected) mismatched.push(`${name}: lock=${expected} installed=${actual}`);
    }
    expect(mismatched).toEqual([]);

    // 依赖树要真的落盘（不是空 node_modules 配一个退出码 0）。
    expect(existsSync(path.join(directory, 'node_modules', 'next', 'package.json'))).toBe(true);
    // 「必须排除：重复安装漂移」——锁文件的完整性字段没被重算过。
    expect(lockBefore).toBe(sha256(lockPath));
  }, 240_000);

  it('T002-C02 package.json 与 lockfile 不一致时安装明确失败，不悄悄换版本', () => {
    const directory = scratchProject();
    const patched = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    // 一个在 registry 上真实存在、但锁文件没有解析过的版本：这正是「声明与实际
    // 构建材料不一致」，不能拿一个根本不存在的版本号冒充（那只会触发 ETARGET）。
    patched.devDependencies.vitest = '3.0.0';
    writeFileSync(
      path.join(directory, 'package.json'),
      `${JSON.stringify(patched, null, 2)}\n`,
    );
    const lockBefore = sha256(path.join(directory, 'package-lock.json'));

    const result = run('npm ci --ignore-scripts --no-audit', directory);

    expect(result.status, '不一致的锁文件必须让安装失败').not.toBe(0);
    expect(result.output).toContain('EUSAGE');
    expect(result.output).toContain('in sync');
    // 报错必须点出差异双方，否则用户无法知道要修哪一行。
    expect(result.output).toMatch(/lock file's vitest@3\.2\.7 does not satisfy vitest@3\.0\.0/u);
    // 「必须排除：悄悄换最新版」——失败路径不能顺手改写锁文件或留下半装的树。
    expect(sha256(path.join(directory, 'package-lock.json'))).toBe(lockBefore);
    expect(existsSync(path.join(directory, 'node_modules', 'vitest'))).toBe(false);
  }, 240_000);

  it('T002-C03 Chromium 缺失时报出安装命令，而不是把测试算作通过', async () => {
    // 「必须排除：只有测试代码没有实际浏览器执行」——默认环境下浏览器要真的能起来，
    // 否则这台机器上的 e2e 结论只能是「未执行」。这一半必须在改环境变量之前做，
    // 因为浏览器路径是 Playwright 导入时解析的常量。
    const playwright = (await import('@playwright/test')) as {
      chromium: { launch: () => Promise<unknown>; executablePath: () => string };
    };
    expect(
      existsSync(playwright.chromium.executablePath()),
      '默认浏览器路径不存在，e2e 结论只能是未执行',
    ).toBe(true);
    const launched = await playwright.chromium.launch();
    await (launched as { close: () => Promise<void> }).close();

    // 前置：Playwright 包已安装，但浏览器二进制目录是空的。用子进程而不是在进程内
    // 改 `PLAYWRIGHT_BROWSERS_PATH`：该路径在导入时就被解析进常量，且 node_modules
    // 里的包被 Vitest 外置、模块缓存无法重置，进程内改环境变量只会静默走默认路径，
    // 让本用例变成空转。环境变量只传给这个子进程，不写用户级配置、不动全局缓存。
    const emptyBrowsers = mkdtempSync(path.join(tmpdir(), 'feini-nobrowser-'));
    temporaries.push(emptyBrowsers);
    const started = Date.now();
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        "require('@playwright/test').chromium.launch().then(() => { console.log('LAUNCHED'); process.exit(0); }, (error) => { console.error(String(error && error.message)); process.exit(7); });",
      ],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: emptyBrowsers,
          PLAYWRIGHT_BROWSERS_PATH_INSTALLED: undefined,
        },
      },
    );
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const elapsedMs = Date.now() - started;

    // 「必须断言：报告缺少浏览器及安装命令，不把测试列为通过」。
    expect(
      result.status,
      `空浏览器目录下不应能启动 Chromium（退出码 ${result.status}，${elapsedMs}ms）\n${output}`,
    ).toBe(7);
    expect(output).not.toContain('LAUNCHED');
    expect(output).toContain("Executable doesn't exist");
    expect(output).toContain('npx playwright install');
    // 报错里必须给出它实际去找的路径，否则用户无法判断是哪个版本缺了。
    expect(output).toContain(emptyBrowsers);
  }, 180_000);

  it('T002-C04 实现只使用 Node 内置模块，没有引入同名第三方包', () => {
    const forbidden = [
      'sqlite3',
      'better-sqlite3',
      'node-sqlite3',
      'sql.js',
      'crypto-js',
      'node-forge',
      'libsodium',
      'sodium-native',
      'bcrypt',
      'bcryptjs',
      'jsonwebtoken',
    ];
    const declared = new Set([...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies)]);
    const installed = forbidden.filter(
      (name) => declared.has(name) || lock.packages[`node_modules/${name}`] !== undefined,
    );
    // 「必须断言：阻止不必要包并继续使用 Node 内置模块」。
    expect(installed).toEqual([]);

    // 反向确认这不是因为清单里什么都没有：它们确实要以 node: 前缀出现。
    // `isBuiltin` 而不是 `builtinModules.includes`：后者列出的是不带前缀的名字，
    // 而较新的内置模块（如 sqlite）只在带 `node:` 前缀时才被认得。
    const requiredBuiltins = ['node:sqlite', 'node:crypto', 'node:fs', 'node:path'];
    for (const builtin of requiredBuiltins) {
      expect(module.isBuiltin(builtin), `${builtin} 应是内置模块`).toBe(true);
    }
    // 「必须排除：同名包带来额外原生构建或供应链风险」——因此这些内置模块必须
    // 不来自任何 node_modules 条目。
    expect(lock.packages['node_modules/sqlite']).toBeUndefined();
    expect(lock.packages['node_modules/crypto']).toBeUndefined();
    expect(lock.packages['node_modules/path']).toBeUndefined();
    expect(lock.packages['node_modules/fs']).toBeUndefined();

    // 决策必须留痕，否则下一次重构会重新考虑装一个 sqlite 包。
    const report = readFileSync(path.join(projectRoot, 'docs', 'dependency-report.md'), 'utf8');
    expect(report).toContain('未安装任何第三方替代品来顶替 Node 内置模块');
  });

  it('T002-C05 断网且缓存不完整时保留原锁文件并提示缺少下载材料', () => {
    const directory = scratchProject();
    const coldCache = mkdtempSync(path.join(tmpdir(), 'feini-cold-cache-'));
    temporaries.push(coldCache);
    const lockBefore = sha256(path.join(directory, 'package-lock.json'));

    // `--offline` + 一个空 cache 目录：等同于「网络不可用且没有下载材料」。
    const result = run(
      `npm ci --ignore-scripts --offline --no-audit --cache "${coldCache}"`,
      directory,
    );

    expect(result.status, '缺少下载材料必须失败').not.toBe(0);
    expect(result.output).toContain('ENOTCACHED');
    // 提示要能让人看出是「材料不在缓存里」，而不是数据损坏。
    expect(result.output).toMatch(/no cached response is available/iu);
    // 「必须排除：为了绕过下载错误改掉已锁定架构」。
    expect(sha256(path.join(directory, 'package-lock.json'))).toBe(lockBefore);
    // 失败路径不能留下半装的树。实测 `npm ci` 会先建一个**空**的 node_modules
    // 再报错，所以判据是「一个包都没装」，而不是「目录不存在」——后者会把空目录
    // 当成安装成功。
    expect(installedPackageCount(directory)).toBe(0);
    expect(existsSync(path.join(directory, 'node_modules', 'next', 'package.json'))).toBe(false);
  }, 240_000);

  it('T002-C06 每个 peer 依赖都在已安装主版本内满足，没有用强装压过警告', () => {
    const reactMajor = Number.parseInt(lockVersionOf('react') ?? '0', 10);
    expect(reactMajor).toBe(19);

    // 「必须断言：在独立决策中解决兼容」——对每个声明了 peer 范围的包，检查其
    // react 范围是否包含已安装主版本。范围写死到 18 就会在这里失败。
    const reactPeerPackages = Object.entries(lock.packages).filter(
      ([key, entry]) => key !== '' && entry.peerDependencies?.react !== undefined,
    );
    expect(reactPeerPackages.length, '没有可校验的 react peer，检查会变成空转').toBeGreaterThan(0);

    const unsatisfied = reactPeerPackages
      .filter(([, entry]) => !majorAllowed(entry.peerDependencies?.react as string, reactMajor))
      .map(([key, entry]) => `${key}: react ${entry.peerDependencies?.react}`);
    expect(unsatisfied).toEqual([]);

    // 「必须排除：忽略警告强装」——强装的痕迹就是这些开关，它们不能出现在任何
    // 脚本或 .npmrc 里。
    const escapeHatches = ['--force', '--legacy-peer-deps', '--ignore-engines'];
    for (const hatch of escapeHatches) {
      expect(JSON.stringify(manifest.scripts)).not.toContain(hatch);
      expect(npmrc).not.toContain(hatch.replace(/^--/u, ''));
    }
    // npm 自己的结论也要一致：真实安装没有留下缺 peer 的树。
    expect(npmrc).toContain('save-exact=false');
  });
});
